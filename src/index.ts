/**
 * dhee-runner-boogu — `comfy.boogu` reference-edit image runner.
 *
 * Drives the Boogu edit workflow (boogu.json): a single TextEncodeBooguEdit
 * node takes a prompt plus up to N reference images (images.image_1..N), each
 * fed from its own LoadImage node, and the sampler denoises an empty latent
 * into the edited result. Boogu accepts a VARIABLE number of reference images,
 * so absent optional references are pruned simply — delete the LoadImage node
 * and drop its `images.image_K` connection (no chain-rewiring like Klein).
 *
 * Reference resolution mirrors comfy.klein: the upstream shot_image_prompt JSON
 * carries `references[]` ({id,type}); references[0] → image_1 (base), the rest
 * → image_2..N. Each ref resolves by `type` against the matching scope='all'
 * collection map (character→character_image, setting→setting_image,
 * plate→plate_image), with a direct ctx.inputs[id] path fallback for
 * single-image (non-collection) callers.
 *
 * SDK-firewall clean: depends only on @dheeai/runner-sdk + the bundled,
 * dependency-free ComfyClient.
 */
import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { defineRunner, resolveEndpointUrl, retryTransient } from '@dheeai/runner-sdk';
import type {
  RunnerContext,
  RunnerDescription,
  RunnerManifest,
  RunnerResult,
} from '@dheeai/runner-sdk';

import { ComfyClient } from './comfyClient.js';

export const manifest = {
  tool: 'comfy.boogu',
  version: '0.1.0',
  engineCompat: '>=0.1.0',
  credentials: [],
  displayName: 'Comfy Boogu (reference edit)',
  description:
    'Drives the Boogu image-edit workflow: a prompt plus up to 4 reference images (variable count) into TextEncodeBooguEdit, denoising an empty latent into the edited shot. Resolves shot_image_prompt references[] like comfy.klein.',
  entry: 'dist/index.js',
  permissions: {
    network: ['<comfy-endpoint-host>'],
    filesystem: 'project',
    subprocess: false,
    env: ['COMFY_MODE', 'COMFYUI_BASE_URL', 'ENDPOINT_self_local'],
  },
} satisfies RunnerManifest;

const REFERENCE_TYPE_TO_INPUT: Record<string, string> = {
  character: 'character_image',
  setting: 'setting_image',
  plate: 'plate_image',
};
const TYPE_TO_NODE: Record<string, string> = {
  character: 'character_image',
  setting: 'setting_image',
};

const DESCRIPTION: RunnerDescription = {
  id: manifest.tool,
  displayName: 'Comfy Boogu (reference edit)',
  description:
    'Boogu reference-edit image runner. Prompt + up to 4 references → TextEncodeBooguEdit; empty-latent denoise.',
  capabilities: ['comfyui', 'image-generation', 'image-edit', 'reference-image-conditioning'],
  modalities: { input: ['text', 'image'], output: ['image'] },
  costHint: 'local_gpu',
  configSchema: {
    type: 'object',
    required: ['workflowPath', 'outputPath'],
    properties: {
      workflowPath: { type: 'string' },
      outputPath: { type: 'string' },
      endpoint: { type: 'string' },
      prompt: { type: 'string' },
      promptNodeId: { type: 'string' },
      promptField: { type: 'string' },
      imageNodeIds: { type: 'array', items: { type: 'string' } },
      encNodeId: { type: 'string' },
      latentNodeId: { type: 'string' },
      seedNodeId: { type: 'string' },
      filenamePrefixNodeId: { type: 'string' },
      seed: { type: 'integer' },
      width: { type: 'integer' },
      height: { type: 'integer' },
    },
    additionalProperties: true,
  },
};

export const runner = defineRunner({ describe: () => DESCRIPTION, run });

interface ShotPrompt {
  imagePrompt?: string;
  references?: Array<{ id?: string; type?: string }>;
  aspectRatio?: string;
}

type ComfyWorkflow = Record<string, { inputs?: Record<string, unknown>; class_type?: string }>;

async function run(ctx: RunnerContext): Promise<RunnerResult> {
  const cfg = ctx.node.runner.config;
  const tag = (m: string) => `comfy.boogu: ${m}`;

  const workflowPath = readString(cfg, 'workflowPath');
  if (!workflowPath) return { ok: false, error: tag('missing workflowPath') };
  const bundleDir = ctx.bundleDir;
  if (!bundleDir) return { ok: false, error: tag('ctx.bundleDir is required to resolve workflowPath') };

  const outputPath = readString(cfg, 'outputPath');
  if (!outputPath) return { ok: false, error: tag('missing outputPath') };
  const outAbs = resolveProjectPath(ctx.projectDir, outputPath);
  if (!outAbs) return { ok: false, error: tag(`outputPath escapes project: ${outputPath}`) };

  const promptNodeId = readString(cfg, 'promptNodeId') ?? 'enc';
  const promptField = readString(cfg, 'promptField') ?? 'prompt';
  const encNodeId = readString(cfg, 'encNodeId') ?? 'enc';
  const latentNodeId = readString(cfg, 'latentNodeId') ?? 'lat';
  const seedNodeId = readString(cfg, 'seedNodeId') ?? 'ks';
  const prefixNodeId = readString(cfg, 'filenamePrefixNodeId') ?? 'save';
  const imageNodeIds = Array.isArray(cfg['imageNodeIds']) && (cfg['imageNodeIds'] as unknown[]).length > 0
    ? (cfg['imageNodeIds'] as string[])
    : ['img1', 'img2', 'img3', 'img4'];

  // ── Resolve prompt + ordered reference image paths ──
  const { prompt, shotPrompt, refPaths, promptSourceNode } = resolveReferences(ctx);
  if (!prompt) return { ok: false, error: tag('no prompt (set config.prompt or feed a shot_image_prompt input)') };
  if (refPaths.length === 0) return { ok: false, error: tag('no reference images resolved from references[]') };
  if (refPaths.length > imageNodeIds.length) {
    return { ok: false, error: tag(`${refPaths.length} references but only ${imageNodeIds.length} image slots in the workflow`) };
  }

  const endpointLabel = readString(cfg, 'endpoint') ?? 'self.local';
  const baseUrl = resolveEndpointUrl(endpointLabel);
  if (!baseUrl) return { ok: false, error: tag(`no Comfy endpoint resolved for "${endpointLabel}" (set COMFYUI_BASE_URL or ENDPOINT_self_local)`) };

  let workflow: ComfyWorkflow;
  try {
    workflow = JSON.parse(readFileSync(join(bundleDir, workflowPath), 'utf-8')) as ComfyWorkflow;
  } catch (err) {
    return { ok: false, error: tag(`failed to read workflow ${workflowPath}: ${msg(err)}`) };
  }

  // ── Inject prompt ──
  if (!setNodeField(workflow, promptNodeId, promptField, prompt)) {
    return { ok: false, error: tag(`promptNodeId "${promptNodeId}" not found in ${workflowPath}`) };
  }

  // ── Scalars: dims (snapped to /16) + seed + filename prefix ──
  const width = snap16(readNumber(cfg, 'width') ?? 1024);
  const height = snap16(readNumber(cfg, 'height') ?? 1024);
  setNodeField(workflow, latentNodeId, 'width', width);
  setNodeField(workflow, latentNodeId, 'height', height);
  const seed = readNumber(cfg, 'seed');
  if (typeof seed === 'number') setNodeField(workflow, seedNodeId, 'seed', seed);
  const prefix = `boogu_${(ctx.itemId ?? 'shot').replace(/[^a-zA-Z0-9_]/g, '_')}`;
  setNodeField(workflow, prefixNodeId, 'filename_prefix', prefix);

  const client = new ComfyClient(baseUrl);

  // ── Upload references + wire present slots; prune absent ones ──
  const encNode = workflow[encNodeId];
  if (!encNode || !encNode.inputs) return { ok: false, error: tag(`encNodeId "${encNodeId}" not found in ${workflowPath}`) };
  for (let i = 0; i < imageNodeIds.length; i++) {
    const nodeId = imageNodeIds[i]!;
    const imageKey = `images.image_${i + 1}`;
    if (i < refPaths.length) {
      let uploaded;
      try {
        uploaded = await retryTransient(() => client.uploadFile(refPaths[i]!), { signal: ctx.signal, log: ctx.log, label: `comfy.boogu upload ref ${i + 1}` });
      } catch (err) {
        return { ok: false, error: tag(`reference upload failed (${refPaths[i]}): ${msg(err)}`) };
      }
      if (!setNodeField(workflow, nodeId, 'image', uploaded.name)) {
        return { ok: false, error: tag(`image slot node "${nodeId}" not found in ${workflowPath}`) };
      }
    } else {
      // Prune: drop the LoadImage node and its enc connection.
      delete workflow[nodeId];
      delete encNode.inputs[imageKey];
    }
  }

  ctx.log(tag(`editing ${outputPath} on ${baseUrl} — ${refPaths.length} ref(s), ${width}x${height}`));

  let outputs;
  try {
    outputs = await retryTransient(() => client.run(workflow as unknown as Record<string, unknown>, { signal: ctx.signal, timeoutMs: 20 * 60_000 }), {
      signal: ctx.signal, log: ctx.log, label: 'comfy.boogu queue',
    });
  } catch (err) {
    return { ok: false, error: tag(`comfy run failed: ${msg(err)}`) };
  }
  const picked = outputs.find((o) => /\.(png|jpg|jpeg|webp)$/i.test(o.filename)) ?? outputs[0];
  if (!picked) return { ok: false, error: tag('Comfy returned no outputs') };

  try {
    await mkdir(dirname(outAbs), { recursive: true });
    await retryTransient(() => client.download(picked, outAbs), { signal: ctx.signal, log: ctx.log, label: 'comfy.boogu download' });
  } catch (err) {
    return { ok: false, error: tag(`download failed: ${msg(err)}`) };
  }
  ctx.log(tag(`wrote ${outputPath}`));

  const dependencies = shotPrompt ? extractDeps(ctx.itemId ?? '', promptSourceNode, shotPrompt) : undefined;

  return {
    ok: true,
    outputPath,
    outputs: [{ path: outputPath, kind: 'image', metadata: { comfyOutput: picked.filename } }],
    metadata: {
      tool: 'comfy.boogu',
      endpoint: endpointLabel,
      comfyOutput: picked.filename,
      referenceCount: refPaths.length,
      ...(dependencies ? { dependencies } : {}),
    },
  };
}

/** references[0] → base (image_1); rest → image_2..N. Resolve by type/id. */
function resolveReferences(ctx: RunnerContext): {
  prompt?: string;
  shotPrompt: ShotPrompt | null;
  refPaths: string[];
  promptSourceNode?: string;
} {
  const cfg = ctx.node.runner.config;
  let prompt = readString(cfg, 'prompt');
  let shotPrompt: ShotPrompt | null = null;
  let promptSourceNode: string | undefined;
  const refPaths: string[] = [];

  for (const [inputKey, v] of Object.entries(ctx.inputs)) {
    if (v && typeof v === 'object' && 'imagePrompt' in (v as Record<string, unknown>)) {
      const p = v as ShotPrompt;
      if (typeof p.imagePrompt !== 'string') continue;
      shotPrompt = p;
      promptSourceNode = inputKey;
      if (!prompt) prompt = p.imagePrompt;
      if (Array.isArray(p.references) && p.references.length > 0) {
        const maps: Record<string, Record<string, string>> = {};
        for (const [type, key] of Object.entries(REFERENCE_TYPE_TO_INPUT)) {
          maps[type] = lowerKeyed(ctx.inputs[key] as Record<string, string> | undefined);
        }
        for (const ref of p.references) {
          const id = typeof ref.id === 'string' ? ref.id : '';
          const type = typeof ref.type === 'string' ? ref.type : '';
          if (!id || !type) continue;
          let path = maps[type]?.[id.toLowerCase()];
          if (!path) {
            const direct = ctx.inputs[id];
            if (typeof direct === 'string' && direct.length > 0) path = direct;
          }
          if (path) refPaths.push(path);
        }
      }
      break;
    }
  }
  return { ...(prompt ? { prompt } : {}), shotPrompt, refPaths, ...(promptSourceNode ? { promptSourceNode } : {}) };
}

interface NodeDependency { nodeId: string; itemId?: string; role?: 'input' | 'context' | 'reference' | 'aggregate' }
function extractDeps(itemId: string, promptNodeId: string | undefined, prompt: ShotPrompt): NodeDependency[] {
  const pn = promptNodeId && promptNodeId.trim() ? promptNodeId.trim() : 'shot_image_prompt';
  const out: NodeDependency[] = [{ nodeId: pn, itemId, role: 'input' }];
  const seen = new Set<string>();
  for (const ref of prompt.references ?? []) {
    const id = typeof ref?.id === 'string' ? ref.id.trim() : '';
    const type = typeof ref?.type === 'string' ? ref.type.trim() : '';
    if (!id || !type) continue;
    const node = TYPE_TO_NODE[type];
    if (!node) continue;
    const key = `${node}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ nodeId: node, itemId: id, role: 'reference' });
  }
  return out;
}

function snap16(n: number): number { return Math.max(16, Math.round(n / 16) * 16); }
function setNodeField(wf: ComfyWorkflow, nodeId: string, field: string, value: unknown): boolean {
  const node = wf[nodeId];
  if (!node) return false;
  if (!node.inputs) node.inputs = {};
  node.inputs[field] = value;
  return true;
}
function lowerKeyed(m: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m ?? {})) out[k.toLowerCase()] = v;
  return out;
}
function resolveProjectPath(projectDir: string, p: string): string | null {
  if (isAbsolute(p)) return null;
  const root = resolve(projectDir);
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  return rel.startsWith('..') || isAbsolute(rel) ? null : abs;
}
function readString(o: Record<string, unknown>, k: string): string | undefined {
  const val = o[k];
  return typeof val === 'string' && val.trim().length > 0 ? val.trim() : undefined;
}
function readNumber(o: Record<string, unknown>, k: string): number | undefined {
  const val = o[k];
  return typeof val === 'number' && Number.isFinite(val) ? val : undefined;
}
function msg(err: unknown): string { return err instanceof Error ? err.message : String(err); }

// npm-ecosystem discovery entry (dhee.runners).
export const runners = [{ manifest, runner }];
