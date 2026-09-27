# Comfy workflow hub (milestone 1)

A small Bun/TypeScript service for sharing immutable ComfyUI API-format workflows
and read-only ComfyUI discovery across agents. It stores records locally in
SQLite and content-addressed files under `DATA_DIR` (default: `./data`). This
milestone does not submit workflows to ComfyUI.

## Run and test

```sh
bun install
bun run typecheck
bun test
bun run hub
```

The hub listens on `127.0.0.1:3000` by default. Persistent state is kept in
`./data/` and is ignored by git. SQLite uses WAL mode; workflow bytes live in
`data/workflows/<sha256>.json`, and temporary multipart uploads live in
`data/staging/` until consumed or expired. Run only one hub process per
`DATA_DIR` (the hub does not provide distributed process coordination).
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
| `HUB_ALLOW_LAN` | `false` | Required to bind the hub on a trusted private LAN (`0.0.0.0` or a private IP) |
| `COMFY_BASE_URL` | `http://127.0.0.1:8188` | Read-only ComfyUI upstream origin |
| `COMFY_ALLOW_LAN` | `false` | Required for a private-LAN ComfyUI upstream |
| `MAX_UPLOAD_BYTES` | `52428800` | Maximum staged multipart file size (50 MiB) |
| `MAX_WORKFLOW_BYTES` | `10485760` | Maximum workflow JSON size (10 MiB; cannot exceed upload limit) |
| `UPLOAD_TTL_SECONDS` | `900` | One-time staged upload lifetime |
| `COMFY_TIMEOUT_MS` | `30000` | Read-only upstream request timeout |

For a trusted LAN ComfyUI at `192.168.0.2:8188`, explicitly set
`COMFY_BASE_URL=http://192.168.0.2:8188` and `COMFY_ALLOW_LAN=true`. For other
agents on the LAN to reach this hub, also bind it explicitly, e.g.
`HUB_HOST=0.0.0.0` and `HUB_ALLOW_LAN=true`. **The hub has no authentication**:
any client that can reach a LAN-exposed instance can upload, list, and read
workflows. Use only on a trusted network and apply network-level restrictions.
No CORS is enabled; browser state-changing requests are same-origin checked.
Public upstream hosts and public hub bind addresses are rejected.

## HTTP API

All routes are under `/api/v1`. The upload flow is intentionally two-step:
multipart bytes are streamed to disk under a short-lived one-time `upload_id`,
then `POST /workflows` atomically claims that ID, validates the staged bytes as
ComfyUI API-format JSON, and commits the immutable workflow. It does not upload
the workflow to ComfyUI.

```sh
# Stage a workflow file on this hub. Only the `file` multipart field is accepted.
curl -F 'file=@workflow-api.json;type=application/json' http://127.0.0.1:3000/api/v1/uploads

# Use the returned upload_id exactly once.
curl -X POST http://127.0.0.1:3000/api/v1/workflows \
  -H 'content-type: application/json' \
  -d '{"upload_id":"<returned-upload-id>","name":"My workflow","description":"Optional notes"}'

curl http://127.0.0.1:3000/api/v1/workflows
curl http://127.0.0.1:3000/api/v1/workflows/<sha256-id>
curl http://127.0.0.1:3000/api/v1/workflows/<sha256-id>/content
```

| Method and route | Result |
| --- | --- |
| `GET /health` | Hub liveness |
| `GET /api/v1/status` | Hub status and stored workflow count |
| `POST /api/v1/uploads` | Stream one multipart `file` field to staging; returns UUID, digest, size, expiry |
| `POST /api/v1/workflows` | Claim `{"upload_id":"...","name?":"...","description?":"..."}`; validate and commit/deduplicate |
| `GET /api/v1/workflows?limit=50&offset=0` | Workflow metadata page |
| `GET /api/v1/workflows/:sha256` | Metadata plus parsed workflow object |
| `GET /api/v1/workflows/:sha256/content` | Original workflow JSON bytes unchanged, with SHA-256 ETag |
| `GET /api/v1/comfy/nodes` | ComfyUI `GET /object_info` |
| `GET /api/v1/comfy/models` | ComfyUI `GET /models` |
| `GET /api/v1/comfy/models/:folder` | ComfyUI `GET /models/:folder` |
| `GET /api/v1/comfy/status` and `/system` | ComfyUI `GET /system_stats` |
| `GET /api/v1/comfy/jobs` | ComfyUI `GET /api/jobs` (jobs and pagination) |
| `GET /api/v1/comfy/jobs/:id` | ComfyUI `GET /api/jobs/:id` |
| `GET /api/v1/comfy/queue` | ComfyUI `GET /queue` |
| `GET /api/v1/comfy/history/:id` | ComfyUI `GET /history/:id` |

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
never used as paths. The service supports staging arbitrary file bytes so a
later milestone can add image/mask assets, but this milestone only promotes
validated workflow JSON into the immutable workflow library.

The ComfyUI client only issues the documented GET requests above. There are no
job submission, cancellation, workflow-upload-to-Comfy, or other write routes
in this milestone. Tests use mocked Comfy HTTP; they do not make network calls.
MCP integration, React UI, and asset promotion are later milestones.

## Existing smoke runner

The original `index.ts` and `workflows/t2i.json` are preserved unchanged. The
existing `bun run start` command still runs that SDK smoke script, which
submits a workflow to its configured Comfy host and downloads outputs into
`outputs/`. **Use `bun run hub` for the new read-only hub service.** The smoke
runner's `COMFY_BASE_URL` behavior remains separate from the hub's safe
loopback default; it defaults to `https://comfy.iwanhae.kr` when the variable
is unset.
