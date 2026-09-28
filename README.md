# Comfy workflow hub

A Bun/TypeScript service for sharing immutable ComfyUI API-format workflows,
promoting input images/masks, archiving job outputs, proxying discovery, and
durably submitting/tracking ComfyUI jobs. SQLite records live under `DATA_DIR`
(default: `./data`) and workflow bytes are content-addressed.

## Run and test

```sh
bun install
bun run typecheck
bun test
bun run build
bun run hub
```

For frontend development, run the Hub and Vite in separate terminals:

```sh
# Terminal 1: Hub API at 127.0.0.1:3000
bun run hub

# Terminal 2: React/Vite UI at 127.0.0.1:5173, proxying /api, /mcp, and /health
bun run dev
```

`bun run build` writes the production UI to the ignored `web/dist/` directory;
`bun run hub` then serves it at `/` and provides SPA fallback only for known UI
routes. The static handler never handles `/api`, `/mcp`, or `/health`, rejects
traversal and outside-directory symlinks, and does not turn missing asset URLs
into HTML. `bun run test:ui` runs the jsdom browser-flow tests; `bun run
typecheck` checks both the Hub and browser TypeScript projects.

The WebUI is a shared, unauthenticated workspace surface (use only on a trusted
network; see the security note below). It has no canvas editor or sign-in flow.
The board shows Hub and external ComfyUI jobs, live SSE progress with fresh
snapshots after reconnect, and periodic REST refresh as a fallback. Job details
include the saved workflow association, errors, output archive status, and
same-origin image/audio/video previews with original downloads. Cancellation is
offered only for `pending` jobs; running jobs are never interrupted.

Workflow files are selected in the browser, staged as multipart bytes, then
committed to the immutable workflow library. The UI submits only a stored
`workflow_id` and includes a retry-safe `client_request_id`. For input assets,
select an image or mask file locally; masks are tied to a ready original image.
The returned `workflow_value` is displayed for copying into a locally edited
API-format workflow—the Hub never modifies stored workflow JSON. Node/model
search and full detail plus the Qwen Image 2.1 guide are read-only.

The hub listens on `127.0.0.1:3000` by default. Persistent state is kept in
`./data/` and is ignored by git. SQLite uses WAL mode; workflow bytes live in
`data/workflows/<sha256>.json`, and temporary multipart uploads live in
`data/staging/` until consumed or expired. Original input assets live under
`data/assets/inputs/`; archived job outputs live under `data/outputs/`. Run
only one hub process per `DATA_DIR` (the hub does not provide distributed
process coordination).
In-process uploads/claims are protected from cleanup; after a restart, orphan
staging files and interrupted claims are recovered after a conservative
24-hour grace period. That grace makes an accidental overlapping process
unlikely to have an active claim reclaimed; do not run a request longer than
the grace period. Stale claims become retryable if their upload has not expired.

Environment settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATA_DIR` | `<cwd>/data` | SQLite and upload storage root |
| `HUB_HOST` | `127.0.0.1` | Hub bind address |
| `HUB_PORT` | `3000` | Hub HTTP port |
| `COMFY_BASE_URL` | `http://127.0.0.1:8188` | ComfyUI upstream origin for discovery and jobs |
| `MAX_UPLOAD_BYTES` | `52428800` | Maximum staged multipart file size (50 MiB) |
| `MAX_ASSET_BYTES` | `MAX_UPLOAD_BYTES` | Maximum image/mask bytes promoted to ComfyUI |
| `MAX_OUTPUT_BYTES` | `2147483648` | Maximum bytes archived for one job output (2 GiB) |
| `MAX_CONCURRENT_ARCHIVES` | `2` | Global in-process limit on concurrent output transfers (max 16) |
| `COMFY_TRANSFER_IDLE_TIMEOUT_MS` | `120000` | Maximum idle gap between streamed output chunks; not a total download deadline |
| `MAX_WORKFLOW_BYTES` | `10485760` | Maximum workflow JSON size (10 MiB; cannot exceed upload limit) |
| `UPLOAD_TTL_SECONDS` | `900` | One-time staged upload lifetime |
| `COMFY_TIMEOUT_MS` | `30000` | Per-request ComfyUI upstream timeout (including submit/cancel) |

For a ComfyUI at `192.168.0.2:8188`, set
`COMFY_BASE_URL=http://192.168.0.2:8188`. To listen beyond the local machine,
set `HUB_HOST=0.0.0.0`. **The hub has no authentication or Host/Origin checks**:
any client that can reach it can upload/read workflows, submit jobs, and
dequeue pending jobs. Keep it behind a trusted network or an authenticating
reverse proxy. No CORS headers are sent, but that is not an access control for
non-browser clients or all browser requests.

## HTTP API

Versioned hub routes are under `/api/v1` (`/health` is the liveness exception).
The upload flow is intentionally two-step:
multipart bytes are streamed to disk under a short-lived one-time `upload_id`,
then `POST /workflows` atomically claims that ID, validates the staged bytes as
ComfyUI API-format JSON, and commits the immutable workflow. Job submission
references that stored `workflow_id`; clients cannot submit arbitrary inline
workflow JSON through the hub. Image and mask bytes use the same staging route,
then `POST /assets` promotes them through ComfyUI's v1 upload endpoints and
stores the original bytes locally. The returned `workflow_value` is intended for
the caller to put into a locally edited API workflow before uploading that
workflow; the hub never edits a workflow graph.

```sh
# Stage a workflow file on this hub. Only the `file` multipart field is accepted.
curl -F 'file=@workflow-api.json;type=application/json' http://127.0.0.1:3000/api/v1/uploads

# Use the returned upload_id exactly once.
curl -X POST http://127.0.0.1:3000/api/v1/workflows \
  -H 'content-type: application/json' \
  -d '{"upload_id":"<returned-upload-id>","name":"My workflow","description":"Optional notes"}'

# Stage an input image, then promote the staged id as a ComfyUI input asset.
curl -F 'file=@portrait.png;type=image/png' http://127.0.0.1:3000/api/v1/uploads
curl -X POST http://127.0.0.1:3000/api/v1/assets \
  -H 'content-type: application/json' \
  -d '{"upload_id":"<returned-upload-id>","kind":"image"}'
# The response includes asset_id, filename, subfolder, type, and workflow_value.
# Set that value in the relevant workflow input locally, then stage/upload the
# resulting API-format workflow as above. Masks require original_asset_id:
# {"upload_id":"...","kind":"mask","original_asset_id":"<image-asset-id>"}

curl http://127.0.0.1:3000/api/v1/workflows
curl http://127.0.0.1:3000/api/v1/workflows/<sha256-id>
curl http://127.0.0.1:3000/api/v1/workflows/<sha256-id>/content
curl 'http://127.0.0.1:3000/api/v1/assets?limit=50&offset=0'
curl 'http://127.0.0.1:3000/api/v1/assets?job_id=<job-uuid>'
curl http://127.0.0.1:3000/api/v1/assets/<asset-id>
curl -H 'Range: bytes=0-1023' http://127.0.0.1:3000/api/v1/assets/<asset-id>/content

# Submit the immutable workflow, optionally with metadata and a retry-safe request key.
curl -X POST http://127.0.0.1:3000/api/v1/jobs \
  -H 'content-type: application/json' \
  -d '{"workflow_id":"<sha256-id>","metadata":{"source":"agent"},"client_request_id":"run-42"}'

curl 'http://127.0.0.1:3000/api/v1/jobs?limit=50&offset=0'
curl http://127.0.0.1:3000/api/v1/jobs/<job-uuid>
curl 'http://127.0.0.1:3000/api/v1/jobs/<job-uuid>/wait?timeout=300'
curl -X POST http://127.0.0.1:3000/api/v1/jobs/<job-uuid>/cancel

# Stream an initial safe job snapshot and live job/state deltas (same origin).
curl -N http://127.0.0.1:3000/api/v1/events
```

| Method and route | Result |
| --- | --- |
| `GET /health` | Hub liveness |
| `GET /api/v1/status` | Hub status and stored workflow count |
| `POST /api/v1/uploads` | Stream one multipart `file` field to staging; returns UUID, digest, size, expiry |
| `POST /api/v1/assets` | Promote `{"upload_id":"...","kind":"image"}` or a mask with required `original_asset_id`; returns the exact ComfyUI reference and `workflow_value` |
| `GET /api/v1/assets?limit=50&offset=0&job_id=<uuid>` | Paginated input/output asset metadata; optional job filter |
| `GET /api/v1/assets/:id` | Asset metadata and a fresh same-origin `download_url` when local bytes are available |
| `GET /api/v1/assets/:id/content` | Stream archived/original bytes; supports one byte range and `206`/`416` responses |
| `POST /api/v1/workflows` | Claim `{"upload_id":"...","name?":"...","description?":"..."}`; validate and commit/deduplicate |
| `GET /api/v1/workflows?limit=50&offset=0` | Workflow metadata page |
| `GET /api/v1/workflows/:sha256` | Metadata plus parsed workflow object |
| `GET /api/v1/workflows/:sha256/content` | Original workflow JSON bytes unchanged, with SHA-256 ETag |
| `POST /api/v1/jobs` | Submit `{"workflow_id":"<sha256>","metadata?":{},"client_request_id?":"..."}`; metadata stays local |
| `GET /api/v1/jobs?limit=50&offset=0` | Merge every paginated ComfyUI job with hub workflow mappings |
| `GET /api/v1/jobs/:uuid` | Current ComfyUI job, including execution errors and outputs |
| `GET /api/v1/jobs/:uuid/wait?timeout=300` | Poll up to 300 seconds (the default); returns the latest job plus `wait_timed_out` |
| `POST /api/v1/jobs/:uuid/cancel` | Remove only a pending job; running jobs are never interrupted; uncertain results return `202` |
| `GET /api/v1/events` | Same-origin Server-Sent Events: initial job snapshot, job/state deltas, and heartbeat |
| `GET /api/v1/comfy/nodes` | ComfyUI `GET /object_info` |
| `GET /api/v1/comfy/models` | ComfyUI `GET /models` |
| `GET /api/v1/comfy/models/:folder` | ComfyUI `GET /models/:folder` |
| `GET /api/v1/comfy/status` and `/system` | ComfyUI `GET /system_stats` |
| `GET /api/v1/comfy/jobs` | ComfyUI `GET /api/jobs` (jobs and pagination) |
| `GET /api/v1/comfy/jobs/:id` | ComfyUI `GET /api/jobs/:id` |
| `GET /api/v1/comfy/queue` | ComfyUI `GET /queue` |
| `GET /api/v1/comfy/history/:id` | ComfyUI `GET /history/:id` |

## Remote MCP

The hub also exposes an MCP Streamable HTTP endpoint at `POST /mcp` using
`@modelcontextprotocol/server` 2.1.0. It has no authentication, just like the
REST API: it is loopback-only by default, and a non-loopback `HUB_HOST` bind
exposes it to other clients. The Hub does not check Host or Origin headers and
does not send CORS headers. Do not expose this unauthenticated service to an
untrusted network.

The MCP server advertises exactly these tools:

```text
node_list, node_get, model_list, model_get, model_guide,
workflow_upload, workflow_list, workflow_get,
job_submit, job_list, job_get, job_wait, job_cancel,
asset_upload, asset_list, asset_get, server_get
```

Node/model discovery reads the connected ComfyUI's live `/object_info` and
`/models/{folder}` catalogs. Lists are searched and paginated; full node schemas
and installed-model loader choices are available through detail tools. Catalog
responses are shared with REST and cached briefly (15 seconds). `model_guide`
is a versioned curated record (`src/model-guides.ts`, version `1.0.0`) sourced
only from `workflows/t2i.json`: it reports the declared Qwen Image 2.1
diffusion-model, encoder, VAE, wiring, and workflow parameters, then checks each
file against its expected model folder and live loader choice. A same-named file
in another folder is reported but is not marked installed. Unknown models return
`status: "not_available"`; no recommendations are inferred.

MCP tools do not have access to a remote client's local filesystem. To upload a
workflow or image, first send its bytes out-of-band to `POST /api/v1/uploads`
as multipart field `file`, then pass the returned `upload_id` to
`workflow_upload` or `asset_upload`. `workflow_upload` commits validated
API-format workflows; `job_submit` accepts only a stored `workflow_id`, never
inline graph JSON. `asset_get` and `asset_list` return the same stable,
same-origin `/api/v1/assets/:id/content` URL as REST when local bytes are ready.
`job_wait` accepts 0–300 seconds (default 300), returns the latest job status on
timeout, and a disconnected MCP client only aborts that tool's polling; it does
not interrupt the ComfyUI job.

For UI clients, matching REST discovery endpoints share the MCP implementation:

```sh
curl 'http://127.0.0.1:3000/api/v1/comfy/nodes/search?q=sampler&limit=20'
curl http://127.0.0.1:3000/api/v1/comfy/nodes/KSampler
curl 'http://127.0.0.1:3000/api/v1/comfy/models/search?q=qwen&limit=20'
curl http://127.0.0.1:3000/api/v1/comfy/models/diffusion_models/qwen_image_2.1_int8_convrot.safetensors
curl http://127.0.0.1:3000/api/v1/comfy/model-guide/qwen-image-2.1
```

Job submission creates a canonical UUID and persists the attempt in SQLite
*before* the single upstream `POST /prompt`. The same durable hub `client_id` is
used for every submission (and is reserved for the future hub WebSocket). The
stored workflow is integrity-checked, validated, and embedded verbatim as the
`prompt` JSON value (not parsed and re-serialized), without graph edits.
Optional request metadata is retained in the local SQLite attempt record and is
not forwarded to ComfyUI. The only hub attribution in ComfyUI `extra_data` is
the scalar `comfy_hub_workflow_id`; the hub does not write or alter
`extra_pnginfo.workflow`, which ComfyUI uses for authoring-workflow metadata.

Pass `client_request_id` to make concurrent/retried calls idempotent. Reusing a
key with a different workflow or metadata is `409 idempotency_key_reused`. A
ComfyUI `400` prompt validation response is recorded and returned as
`422 prompt_rejected`; a timeout, network error, unexpected response, or server
error is **ambiguous**, recorded against its known UUID, and returned as `202`
with `status: "submission_unknown"`. The hub never retries `POST /prompt`
automatically. Repeating a call with the same request key returns the recorded
attempt rather than submitting again. Reconcile an ambiguous attempt with
`GET /api/v1/jobs/:uuid` or the list; if ComfyUI has not accepted it, the hub
still will not resubmit it behind your back.

### ComfyUI job response shapes

The hub targets ComfyUI 0.37.0's v1 job REST surface and preserves its job
records and status names, adding the hub's workflow mapping and wait metadata.
A live `GET /api/jobs` page has this shape:

```json
{
  "jobs": [{ "id": "<uuid>", "status": "pending", "create_time": 1720000000000 }],
  "pagination": { "offset": 0, "limit": 100, "total": 1, "has_more": false }
}
```

ComfyUI job statuses are `pending`, `in_progress`, `completed`, `failed`, and
`cancelled`. Pending/running records include the id, priority, create time, and
output counts; completed records additionally carry output summaries. The
single-job endpoint includes full `outputs`, `execution_status`, and (on
failure) `execution_error`. The hub follows `has_more` across all pages, then
adds its local `workflow_id` mapping; externally submitted ComfyUI jobs remain
visible. If `/api/jobs/:id` misses a job, the hub checks the corresponding
`/history/:id` and `/queue` records before returning not found.

### Live job events

The first `GET /api/v1/events` starts one Hub-owned ComfyUI WebSocket connection
to `/ws?clientId=<durable-hub-client-id>`. The Hub converts only the configured
`COMFY_BASE_URL` scheme (`http` → `ws`, `https` → `wss`); it does not accept a
client-supplied upstream URL. All connected browser/agent clients share the same
Hub progress state. The upstream `status`, `executing`, `progress`,
`progress_state`, `executed`, and terminal execution messages are reduced to
small job/state records. Binary preview frames, full prompts, node outputs,
tracebacks, and arbitrary upstream fields are not forwarded.

An SSE connection first receives a `snapshot` event:

```json
{
  "type": "snapshot",
  "sequence": 12,
  "state": { "upstream": "connected", "queue_remaining": 2, "last_reconciled_at": "..." },
  "jobs": [
    {
      "job_id": "<comfy-prompt-id>",
      "status": "in_progress",
      "workflow_id": "<sha256-or-omitted-for-external-jobs>",
      "current_node": { "node_id": "17" },
      "progress": { "value": 4, "max": 20 },
      "updated_at": "..."
    }
  ],
  "truncated": false
}
```

After the snapshot, `job` events contain `{type, sequence, job}` when a job
changes; `state` events contain `{type, sequence, state}` for upstream
connection/queue changes; `heartbeat` events keep idle streams alive. A job
record is keyed by `job_id`, and includes status, the Hub workflow mapping when
known, current/completed node IDs, bounded node progress, and timestamps. Status
is monotonic (`pending` → `in_progress` → terminal), so delayed queue snapshots
or WebSocket messages cannot revive a completed/failed/cancelled job. The feed
does not replay deltas: EventSource reconnects receive a new snapshot.

The Hub also reconciles paginated `GET /api/jobs` and `GET /queue` every five
seconds, and immediately after each WebSocket connect/reconnect. This surfaces
jobs submitted by other clients and repairs missed completions/server restarts
without making a `/history/:id` request for every job. The feed retains at most
1,000 job projections and accepts at most 50 SSE subscribers. A slow subscriber
is closed and can reconnect for a fresh snapshot. Host and any supplied Origin
are checked for this GET route; no CORS access is enabled. Progress and
subscriber state are process-local, consistent with the Hub's single-process
per-`DATA_DIR` requirement.

An attempt that was persisted but cannot yet be found upstream is returned with
hub-only `status: "submission_unknown"` and `local_submission_state`; a stored
validation rejection uses `submission_rejected`. A wait timeout is not an error:
the response is the most recent snapshot with `wait_timed_out: true`. The wait
query accepts 0–300 seconds (default 300). It does not cancel the upstream job.
Bun's normal idle timeout would close a quiet long-poll, so the hub disables the
idle timeout for only that wait request; disconnecting the caller aborts its
polling without cancelling the job.

Cancellation first reads the job and only asks ComfyUI to run
`POST /queue` with `{"delete":["<uuid>"]}` when its status is `pending`. The
queue deletion is safe if the job races into execution: it then removes nothing,
and the hub never calls the state-agnostic `/api/jobs/:id/cancel` or global
`/interrupt` endpoints. A race that starts the job is reported as
`cancelled: false` with its observed status. If the `/queue` POST fails and
subsequent reads cannot determine whether the pending job remains, the route
returns HTTP `202` with `outcome: "unknown"`, `cancelled: null`, and
`error.code: "cancel_outcome_unknown"`. It does not mark the local attempt
cancelled or claim success. A follow-up read error instead returns the normal
upstream diagnostic error.

API-format validation checks the graph envelope and each node's `class_type`
and `inputs`; it does not perform server-side semantic validation or execute
the workflow. UI-format exports (`nodes`/`links`) and malformed JSON are
rejected. Workflow identity is the SHA-256 of the exact uploaded bytes, so
re-uploading identical bytes returns the existing record. The first upload's
original `filename`, optional display `name`, and `description` are retained;
later byte-identical uploads do not replace them. The content route is the
byte-exact retrieval path; the ordinary GET route returns a JSON metadata
wrapper for convenience. Records migrated from the initial schema have a null
filename because it was not retained previously.

Multipart file data is written incrementally to a generated path in `staging/`
with a size limit and streaming digest. Filenames are metadata only; they are
never used as paths. The service supports staging arbitrary bytes, but asset
promotion accepts only sniffed raster images (PNG, JPEG, WebP, GIF, BMP, TIFF)
whose declared MIME type matches when one is supplied. The hub assigns unique
generated ComfyUI names and subfolders rather than using client filenames as
paths. Mask promotion requires a ready image `original_asset_id` and sends its
exact ComfyUI reference as the `original_ref` multipart JSON field; source bytes
(including any alpha channel) are preserved unchanged.

An upstream upload with a lost/invalid response is recorded as `ambiguous` and
returns `202`; retrying the same `upload_id` reports that record and never sends
a second ComfyUI upload. Only a confirmed, validated ComfyUI response supplies a
`workflow_value`. Input originals are durably stored under `assets/inputs/`.

For completed jobs, the hub examines `/history/:job_id`, recognizes image,
video, audio, and generic file references, and persists pending asset intents.
Job get/list/wait only await this lightweight discovery; terminal job status is
not delayed by large output downloads. A bounded background queue streams each
`/view` response to a temporary file under `outputs/`, enforces the output size
limit, syncs and renames the complete file, then marks the SQLite asset row
`ready`. Until then, asset get/list reports `pending` with no download URL. A
failed or interrupted archive stays pending and is retried on later history
discovery or at startup from those durable intents; partial files are never
exposed as ready assets. Output asset ids are deterministic for a
job/node/file reference, so retries do not create duplicates. The metadata
records `job_id` and `node_id` for filtering. The `/view` header timeout is
separate from transfer idle timeout: long downloads may run beyond
`COMFY_TIMEOUT_MS` as long as chunks continue arriving within
`COMFY_TRANSFER_IDLE_TIMEOUT_MS`.

The ComfyUI client has typed, bounded-timeout v1 job methods and makes no
automatic POST retries. Input asset uploads are streamed to `/upload/image` or
`/upload/mask`; ambiguous outcomes are never automatically retried. Tests use
mocked Comfy HTTP and do not make live uploads or generate media.

## Existing smoke runner

The original `index.ts` and `workflows/t2i.json` are preserved unchanged. The
existing `bun run start` command still runs that SDK smoke script, which
submits a workflow to its configured Comfy host and downloads outputs into
`outputs/`. **Use `bun run hub` for the hub service.** The smoke
runner's `COMFY_BASE_URL` behavior remains separate from the hub's safe
loopback default; it defaults to `https://comfy.iwanhae.kr` when the variable
is unset.
