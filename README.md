# Comfy API v2 SDK smoke test

Small Bun project that submits `workflows/t2i.json` to `https://comfy.iwanhae.kr`
using [`@comfyorg/sdk`](https://github.com/Comfy-Org/comfy-typescript-sdk).

```sh
bun install
bun run typecheck
bun run start
```

The host can be overridden with `COMFY_BASE_URL`. The workflow is copied from
`/Users/wan/Downloads/t2i.json`; it uses the Qwen Image 2.1 custom nodes and
model files named in the graph, so the target ComfyUI must have those installed.
Successful `SaveImageAdvanced` outputs are downloaded into `outputs/`.
This host reported `size_bytes: 0` for the job output even though the SDK
downloaded a valid 1.2 MB PNG; the script logs the on-disk byte count and warns
when server metadata disagrees.
