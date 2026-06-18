# dhee-runner-boogu

Boogu image-edit runner for [Dhee](https://github.com/dheeai/dhee-core) —
exposes the **`comfy.boogu`** tool. It drives a ComfyUI **Boogu** edit
workflow: a text prompt plus up to **four reference images** are fed into a
single `TextEncodeBooguEdit` node, and the sampler denoises an empty latent
into the edited result.

Boogu is strong at **multi-reference compositing, complex instruct-edits, and
view synthesis from a single image**. This runner is a drop-in alternative to
`comfy.klein` / `comfy.qwen_edit_chain` for the `shot_image` (or any
reference-edit) stage of a bundle.

## Install

```bash
npm i dhee-runner-boogu        # into ~/.kshana/runners/<name>/ or your node_modules
```

Dhee discovers it automatically (name matches `dhee-runner-*` and the
`dhee-runner` keyword is present).

## How it resolves references

Mirrors `comfy.klein`: the upstream `shot_image_prompt` JSON carries
`references[]` (`{ id, type }`). `references[0]` becomes `image_1` (the base),
the rest become `image_2..N`. Each entry resolves by `type` against the
matching `scope:'all'` collection map:

| `type`      | resolves against |
|-------------|------------------|
| `character` | `character_image` |
| `setting`   | `setting_image`   |
| `plate`     | `plate_image`     |

A direct `ctx.inputs[id]` path is used as a fallback for single-image
(non-collection) callers. Boogu accepts a **variable** number of references —
absent optional slots are pruned (the `LoadImage` node is deleted and its
`images.image_N` connection dropped), so no chain-rewiring is needed.

## Node config

```jsonc
{
  "tool": "comfy.boogu",
  "config": {
    "workflowPath": "workflows/boogu.json",  // bundle-relative ComfyUI (API-format) workflow
    "endpoint": "self.local",                // resolved via ENDPOINT_self_local / COMFYUI_BASE_URL
    "width": 1280,                            // snapped to /16
    "height": 720,
    "seed": 42                               // optional; deterministic when fixed
  }
}
```

Optional overrides (defaults match the bundled `workflows/boogu.json` node ids):
`promptNodeId` (`enc`), `promptField` (`prompt`), `encNodeId` (`enc`),
`imageNodeIds` (`["img1","img2","img3","img4"]`), `latentNodeId` (`lat`),
`seedNodeId` (`ks`), `filenamePrefixNodeId` (`save`).

## Workflow

`workflows/boogu.json` is the canonical API-format graph: `UNETLoader`
(`boogu_image_edit_fp8_scaled`) + `CLIPLoader` (`qwen3vl_8b_fp8_scaled`,
type `boogu`) + `VAELoader` (`ae.safetensors`) → `TextEncodeBooguEdit` with
four `LoadImage` slots → `KSampler` (euler/simple, 20 steps, cfg 4.0) →
`EmptySD3LatentImage` → decode → save. Point `config.workflowPath` at your own
copy to swap models/params.

## SDK firewall

Depends only on [`@dheeai/runner-sdk`](https://github.com/dheeai/dhee-runner-sdk)
and a bundled, dependency-free `ComfyClient` — never on `dhee-core` internals.

## License

Apache-2.0
