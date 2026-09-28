import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHubApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { ComfyApiClient, type FetchLike } from "../src/comfy-client.ts";
import { JobService } from "../src/jobs.ts";
import { HubStore } from "../src/storage.ts";

const baseUrl = "http://192.168.0.2:8188";
const workflowBytes = new TextEncoder().encode('{"1":{"class_type":"ExampleNode","inputs":{"text":"unchanged","large":9007199254740993}}}\n');

let root: string;
let config: ReturnType<typeof loadConfig>;
let store: HubStore;

function client(fetchImpl: FetchLike): ComfyApiClient {
	return new ComfyApiClient({ baseUrl: new URL(baseUrl), timeoutMs: 500, fetchImpl });
}

class RecordingJobService extends JobService {
	waitTimeouts: number[] = [];

	override wait(...args: Parameters<JobService["wait"]>): ReturnType<JobService["wait"]> {
		this.waitTimeouts.push(args[1]);
		return super.wait(...args);
	}
}

function response(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

async function createWorkflow(): Promise<string> {
	const sha256 = createHash("sha256").update(workflowBytes).digest("hex");
	await writeFile(join(store.workflowsDir, `${sha256}.json`), workflowBytes, { mode: 0o444 });
	store.db.prepare(`
		INSERT INTO workflows(id, sha256, original_filename, name, description, bytes, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run(sha256, sha256, "durable.json", "Durable workflow", null, workflowBytes.byteLength, Date.now());
	return sha256;
}

function submitRequest(workflowId: string, extras: Record<string, unknown> = {}): Request {
	return new Request("http://127.0.0.1:3000/api/v1/jobs", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ workflow_id: workflowId, ...extras }),
	});
}

function getRequest(path: string): Request {
	return new Request(`http://127.0.0.1:3000${path}`);
}

async function readError(responseValue: Response): Promise<{ error: { code: string; details?: Record<string, unknown> } }> {
	return await responseValue.json() as { error: { code: string; details?: Record<string, unknown> } };
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "comfy-jobs-test-"));
	config = loadConfig({
		DATA_DIR: join(root, "state"),
		COMFY_BASE_URL: baseUrl,
		COMFY_ALLOW_LAN: "true",
		MAX_UPLOAD_BYTES: "1048576",
		MAX_WORKFLOW_BYTES: "524288",
	}, root);
	store = new HubStore({ dataDir: config.dataDir, uploadTtlMs: config.uploadTtlMs });
	await store.initialize();
});

afterEach(async () => {
	store.close();
	await rm(root, { recursive: true, force: true });
});

describe("durable ComfyUI job execution", () => {
	test("records only unambiguous input assets matching a supported loader and asset kind", () => {
		const imageId = randomUUID();
		const maskId = randomUUID();
		const otherId = randomUUID();
		const addInput = (id: string, kind: "image" | "mask", subfolder: string) => store.db.prepare(`
			INSERT INTO assets(id,kind,origin,status,upload_id,comfy_filename,comfy_subfolder,comfy_type,created_at,updated_at)
			VALUES (?,?,'input','ready',?,?,?,'input',1,1)
		`).run(id, kind, randomUUID(), "same.png", subfolder);
		addInput(imageId, "image", "comfy-hub/image");
		addInput(maskId, "mask", "comfy-hub/mask");
		addInput(otherId, "image", "other/source");
		store.associateJobInputAssets(randomUUID(), {});
		const jobId = randomUUID();
		store.associateJobInputAssets(jobId, {
			"1": { class_type: "LoadImage", inputs: { image: "comfy-hub/image/same.png" } },
			"2": { class_type: "LoadImageMask", inputs: { image: "comfy-hub/mask/same.png" } },
			"3": { class_type: "LoadImage", inputs: { image: "same.png" } },
			"4": { class_type: "SomeCustomNode", inputs: { image: "other/source/same.png" } },
		});
		expect(store.listJobAssets(jobId).map((asset) => asset.id).sort()).toEqual([imageId, maskId].sort());
	});

	test("submits the stored graph unchanged with a durable client id and idempotent request key", async () => {
		const workflowId = await createWorkflow();
		const posts: Array<Record<string, unknown>> = [];
		const postBodies: string[] = [];
		let persistedBeforePost = false;
		const comfy = client(async (input, init) => {
			const url = new URL(String(input));
			if (url.pathname === "/prompt" && init?.method === "POST") {
				const serializedBody = String(init.body);
				postBodies.push(serializedBody);
				const body = JSON.parse(serializedBody) as Record<string, unknown>;
				posts.push(body);
				persistedBeforePost = store.getJobSubmission(String(body.prompt_id))?.state === "submitting";
				return response({ prompt_id: body.prompt_id, number: 1, node_errors: {} });
			}
			throw new Error(`Unexpected upstream call: ${init?.method} ${url.pathname}`);
		});
		const app = createHubApp({ config, store, comfy });
		const requestKey = "agent-session-42";
		const submitted = await app.fetch(submitRequest(workflowId, {
			client_request_id: requestKey,
			metadata: { user_note: "hello" },
		}));
		expect(submitted.status).toBe(201);
		const first = await submitted.json() as { job_id: string; workflow_id: string; submission_state: string };
		expect(first.workflow_id).toBe(workflowId);
		expect(first.submission_state).toBe("accepted");
		expect(first.job_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(posts).toHaveLength(1);
		expect(persistedBeforePost).toBe(true);
		expect(posts[0]?.prompt).toEqual(JSON.parse(new TextDecoder().decode(workflowBytes)));
		expect(postBodies[0]).toContain(`"prompt":${new TextDecoder().decode(workflowBytes)},"client_id"`);
		expect(posts[0]?.prompt_id).toBe(first.job_id);
		expect(posts[0]?.client_id).toBe(store.clientId);
		expect(posts[0]?.extra_data).toEqual({ comfy_hub_workflow_id: workflowId });
		expect(store.getJobSubmission(first.job_id)?.metadata).toEqual({ user_note: "hello" });

		const duplicate = await app.fetch(submitRequest(workflowId, {
			client_request_id: requestKey,
			metadata: { user_note: "hello" },
		}));
		expect(duplicate.status).toBe(200);
		const replay = await duplicate.json() as { job_id: string; reused: boolean };
		expect(replay.job_id).toBe(first.job_id);
		expect(replay.reused).toBe(true);
		const conflictingReuse = await app.fetch(submitRequest(workflowId, {
			client_request_id: requestKey,
			metadata: { user_note: "different" },
		}));
		expect(conflictingReuse.status).toBe(409);
		expect(posts).toHaveLength(1);

		const restarted = new HubStore({ dataDir: config.dataDir, uploadTtlMs: config.uploadTtlMs });
		expect(restarted.clientId).toBe(store.clientId);
		restarted.close();
	});

	test("concurrent submissions with the same request key create one durable attempt and one POST", async () => {
		const workflowId = await createWorkflow();
		let postCount = 0;
		let releasePost!: () => void;
		let markPostStarted!: () => void;
		const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
		const postStarted = new Promise<void>((resolve) => { markPostStarted = resolve; });
		const app = createHubApp({
			config,
			store,
			comfy: client(async (input, init) => {
				if (new URL(String(input)).pathname === "/prompt" && init?.method === "POST") {
					postCount++;
					const body = JSON.parse(String(init.body)) as { prompt_id: string };
					markPostStarted();
					await postGate;
					return response({ prompt_id: body.prompt_id, number: 1, node_errors: {} });
				}
				throw new Error("Unexpected upstream request");
			}),
		});
		const input = { client_request_id: "concurrent-run", metadata: { a: 1, b: 2 } };
		const firstPromise = app.fetch(submitRequest(workflowId, input));
		await postStarted;
		const secondResponse = await app.fetch(submitRequest(workflowId, input));
		expect(secondResponse.status).toBe(200);
		const second = await secondResponse.json() as { job_id: string; reused: boolean; status: string };
		expect(second).toMatchObject({ reused: true, status: "submission_unknown" });
		releasePost();
		const firstResponse = await firstPromise;
		expect(firstResponse.status).toBe(201);
		const first = await firstResponse.json() as { job_id: string };
		expect(second.job_id).toBe(first.job_id);
		expect(postCount).toBe(1);
	});

	test("persists a validation rejection and does not resubmit an idempotent request", async () => {
		const workflowId = await createWorkflow();
		let postCount = 0;
		const app = createHubApp({
			config,
			store,
			comfy: client(async (input, init) => {
				if (new URL(String(input)).pathname === "/prompt" && init?.method === "POST") {
					postCount++;
					return response({ error: { type: "prompt_no_outputs", message: "No output node" }, node_errors: { "1": { errors: ["invalid"] } } }, 400);
				}
				throw new Error("Unexpected upstream request");
			}),
		});

		const first = await app.fetch(submitRequest(workflowId, { client_request_id: "reject-me" }));
		expect(first.status).toBe(422);
		const firstError = await readError(first);
		expect(firstError.error.code).toBe("prompt_rejected");
		const jobId = firstError.error.details?.job_id as string;
		expect(store.getJobSubmission(jobId)?.state).toBe("rejected");

		const replay = await app.fetch(submitRequest(workflowId, { client_request_id: "reject-me" }));
		expect(replay.status).toBe(422);
		expect((await readError(replay)).error.details?.job_id).toBe(jobId);
		expect(postCount).toBe(1);
	});

	test("records ambiguous outcomes and recovers the known job id after restart without resubmitting", async () => {
		const workflowId = await createWorkflow();
		let postCount = 0;
		let submittedId = "";
		let upstreamVisible = false;
		const comfy = client(async (input, init) => {
			const url = new URL(String(input));
			if (url.pathname === "/prompt" && init?.method === "POST") {
				postCount++;
				submittedId = (JSON.parse(String(init.body)) as { prompt_id: string }).prompt_id;
				throw new TypeError("connection dropped after request write");
			}
			if (url.pathname === `/api/jobs/${submittedId}` && upstreamVisible) return response({ id: submittedId, status: "completed", outputs: {} });
			if (url.pathname.startsWith("/api/jobs/")) return response({ error: "Job not found" }, 404);
			if (url.pathname.startsWith("/history/")) return response({});
			if (url.pathname === "/queue") return response({ queue_running: [], queue_pending: [] });
			if (url.pathname === "/api/jobs") return response({ jobs: [], pagination: { offset: 0, limit: 100, total: 0, has_more: false } });
			throw new Error(`Unexpected upstream call: ${url.pathname}`);
		});
		let app = createHubApp({ config, store, comfy });
		const responseValue = await app.fetch(submitRequest(workflowId, { client_request_id: "maybe-submitted" }));
		expect(responseValue.status).toBe(202);
		const result = await responseValue.json() as { job_id: string; workflow_id: string; status: string };
		expect(result.status).toBe("submission_unknown");
		expect(store.getJobSubmission(result.job_id)?.state).toBe("ambiguous");
		expect((await app.fetch(submitRequest(workflowId, { client_request_id: "maybe-submitted" }))).status).toBe(200);
		expect(postCount).toBe(1);

		const clientId = store.clientId;
		store.close();
		store = new HubStore({ dataDir: config.dataDir, uploadTtlMs: config.uploadTtlMs });
		await store.initialize();
		expect(store.clientId).toBe(clientId);
		app = createHubApp({ config, store, comfy });
		const recovered = await app.fetch(getRequest(`/api/v1/jobs/${result.job_id}`));
		expect(recovered.status).toBe(200);
		expect((await recovered.json() as { status: string; workflow_id: string }).status).toBe("submission_unknown");
		expect((await app.fetch(getRequest("/api/v1/jobs"))).status).toBe(200);
		upstreamVisible = true;
		const reconciled = await app.fetch(getRequest(`/api/v1/jobs/${result.job_id}`));
		expect((await reconciled.json() as { status: string; local_submission_state: string }).status).toBe("completed");
		expect(store.getJobSubmission(result.job_id)?.state).toBe("accepted");
		expect(postCount).toBe(1);
	});

	test("merges every upstream page, preserves external jobs, and overlays local workflow mappings", async () => {
		const workflowId = await createWorkflow();
		const localId = randomUUID();
		store.beginJobSubmission({
			promptId: localId,
			workflowId,
			clientRequestId: null,
			requestFingerprint: "test-fingerprint",
			metadata: {},
		});
		store.updateJobSubmission(localId, "accepted");
		const externalId = randomUUID();
		const requestedOffsets: string[] = [];
		const app = createHubApp({
			config,
			store,
			comfy: client(async (input) => {
				const url = new URL(String(input));
				if (url.pathname === "/api/jobs") {
					const offset = url.searchParams.get("offset") ?? "0";
					requestedOffsets.push(offset);
					if (offset === "0") return response({
						jobs: [{ id: localId, status: "pending", workflow_id: "upstream-wrong" }],
						pagination: { offset: 0, limit: 100, total: 2, has_more: true },
					});
					return response({
						jobs: [{ id: externalId, status: "completed", outputs_count: 1 }],
						pagination: { offset: 1, limit: 100, total: 2, has_more: false },
					});
				}
				throw new Error(`Unexpected upstream request: ${url.pathname}`);
			}),
		});
		const result = await app.fetch(getRequest("/api/v1/jobs"));
		expect(result.status).toBe(200);
		const payload = await result.json() as { jobs: Array<Record<string, unknown>>; pagination: { total: number } };
		expect(requestedOffsets).toEqual(["0", "1"]);
		expect(payload.pagination.total).toBe(2);
		expect(payload.jobs.find((job) => job.id === localId)?.workflow_id).toBe(workflowId);
		expect(payload.jobs.find((job) => job.id === externalId)?.status).toBe("completed");
	});

	test("job detail falls back to ComfyUI history for execution errors and outputs", async () => {
		const workflowId = await createWorkflow();
		const promptId = randomUUID();
		const calls: string[] = [];
		const historyItem = {
			prompt: [1, promptId, {}, { comfy_hub_workflow_id: workflowId }, []],
			outputs: { "7": { images: [{ filename: "partial.png", type: "output" }] } },
			status: { status_str: "error", messages: [["execution_error", { exception_message: "node failed" }]] },
		};
		const app = createHubApp({
			config,
			store,
			comfy: client(async (input) => {
				const url = new URL(String(input));
				calls.push(url.pathname);
				if (url.pathname === `/api/jobs/${promptId}`) return response({ error: "Job not found" }, 404);
				if (url.pathname === `/history/${promptId}`) return response({ [promptId]: historyItem });
				throw new Error(`Unexpected upstream request: ${url.pathname}`);
			}),
		});
		const detail = await app.fetch(getRequest(`/api/v1/jobs/${promptId}`));
		expect(detail.status).toBe(200);
		expect(calls).toEqual([`/api/jobs/${promptId}`, `/history/${promptId}`]);
		expect(await detail.json()).toMatchObject({
			id: promptId,
			status: "failed",
			workflow_id: workflowId,
			execution_error: { exception_message: "node failed" },
			outputs: { "7": { images: [{ filename: "partial.png", type: "output" }] } },
		});
	});

	test("wait returns a terminal snapshot, returns the latest snapshot on timeout, and sets Bun's per-request timeout", async () => {
		const promptId = randomUUID();
		let reads = 0;
		const jobs = new JobService({ store, comfy: client(async (input) => {
			const url = new URL(String(input));
			if (url.pathname === `/api/jobs/${promptId}`) {
				reads++;
				return response({ id: promptId, status: reads === 1 ? "pending" : "completed", outputs: { "4": { images: [{ filename: "done.png" }] } } });
			}
			throw new Error(`Unexpected upstream request: ${url.pathname}`);
		}), pollIntervalMs: 1 });
		const app = createHubApp({ config, store, comfy: client(async () => { throw new Error("unused"); }), jobs });
		const timeoutCalls: number[] = [];
		const completed = await app.fetch(getRequest(`/api/v1/jobs/${promptId}/wait?timeout=1`), {
			timeout(_request, seconds) { timeoutCalls.push(seconds); },
		});
		expect(completed.status).toBe(200);
		const completeSnapshot = await completed.json() as { status: string; wait_timed_out: boolean; outputs: Record<string, unknown> };
		expect(completeSnapshot.status).toBe("completed");
		expect(completeSnapshot.wait_timed_out).toBe(false);
		expect(completeSnapshot.outputs).toEqual({ "4": { images: [{ filename: "done.png" }] } });
		expect(timeoutCalls).toEqual([0]);

		const latestId = randomUUID();
		const timeoutApp = createHubApp({
			config,
			store,
			comfy: client(async (input) => {
				if (new URL(String(input)).pathname === `/api/jobs/${latestId}`) return response({ id: latestId, status: "in_progress", execution_start_time: 123 });
				throw new Error("Unexpected upstream request");
			}),
		});
		const timedOut = await timeoutApp.fetch(getRequest(`/api/v1/jobs/${latestId}/wait?timeout=0`));
		const latestSnapshot = await timedOut.json() as { status: string; execution_start_time: number; wait_timed_out: boolean };
		expect(latestSnapshot).toMatchObject({ status: "in_progress", execution_start_time: 123, wait_timed_out: true });
	});

	test("REST wait defaults to five minutes while terminal jobs still return immediately", async () => {
		const promptId = randomUUID();
		const comfy = client(async (input) => {
			const path = new URL(String(input)).pathname;
			if (path === `/api/jobs/${promptId}`) return response({ id: promptId, status: "completed", outputs: {} });
			if (path === `/history/${promptId}`) return response({});
			throw new Error(`Unexpected upstream request: ${path}`);
		});
		const jobs = new RecordingJobService({ store, comfy, pollIntervalMs: 1 });
		const app = createHubApp({ config, store, comfy, jobs });
		const timeoutCalls: number[] = [];
		const result = await app.fetch(getRequest(`/api/v1/jobs/${promptId}/wait`), {
			timeout(_request, seconds) { timeoutCalls.push(seconds); },
		});
		expect(result.status).toBe(200);
		expect(jobs.waitTimeouts).toEqual([300_000]);
		expect(await result.json()).toMatchObject({ id: promptId, status: "completed", wait_timed_out: false });
		expect(timeoutCalls).toEqual([0]);
	});

	test("an aborted wait stops polling only and never sends an upstream cancellation", async () => {
		const promptId = randomUUID();
		const methods: string[] = [];
		const comfy = client(async (input, init) => {
			methods.push(`${init?.method} ${new URL(String(input)).pathname}`);
			if (new URL(String(input)).pathname === `/api/jobs/${promptId}`) return response({ id: promptId, status: "pending" });
			throw new Error("Unexpected upstream request");
		});
		const jobs = new JobService({ store, comfy, pollIntervalMs: 100 });
		const abort = new AbortController();
		const waiting = jobs.wait(promptId, 10_000, abort.signal, { id: promptId, status: "pending" });
		abort.abort(new DOMException("client disconnected", "AbortError"));
		await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
		expect(methods).toEqual([]);
	});

	test("the HTTP wait request aborts cleanly on disconnect without cancelling the ComfyUI job", async () => {
		const promptId = randomUUID();
		const abort = new AbortController();
		const calls: string[] = [];
		const comfy = client(async (input, init) => {
			const url = new URL(String(input));
			calls.push(`${init?.method} ${url.pathname}`);
			if (url.pathname === `/api/jobs/${promptId}`) {
				queueMicrotask(() => abort.abort(new DOMException("disconnected", "AbortError")));
				return response({ id: promptId, status: "pending" });
			}
			throw new Error(`Unexpected upstream request: ${url.pathname}`);
		});
		const app = createHubApp({
			config,
			store,
			comfy,
			jobs: new JobService({ store, comfy, pollIntervalMs: 100 }),
		});
		const request = new Request(`http://127.0.0.1:3000/api/v1/jobs/${promptId}/wait?timeout=30`, { signal: abort.signal });
		const result = await app.fetch(request);
		expect(result.status).toBe(499);
		expect(calls).toEqual([`GET /api/jobs/${promptId}`]);
	});

	test("cancel only dequeues a still-pending job; a queue-to-running race never interrupts it", async () => {
		const promptId = randomUUID();
		let status: "pending" | "in_progress" = "pending";
		const calls: Array<{ method: string; path: string; body?: unknown }> = [];
		const app = createHubApp({
			config,
			store,
			comfy: client(async (input, init) => {
				const url = new URL(String(input));
				const method = init?.method ?? "GET";
				calls.push({ method, path: url.pathname, ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}) });
				if (url.pathname === `/api/jobs/${promptId}`) return response({ id: promptId, status });
				if (url.pathname === `/history/${promptId}`) return response({});
				if (url.pathname === "/queue" && method === "GET") return response({ queue_running: [], queue_pending: status === "pending" ? [[1, promptId, {}, {}, []]] : [] });
				if (url.pathname === "/queue" && method === "POST") {
					status = "in_progress";
					return new Response(null, { status: 200 });
				}
				throw new Error(`Unexpected upstream call: ${method} ${url.pathname}`);
			}),
		});
		const result = await app.fetch(new Request(`http://127.0.0.1:3000/api/v1/jobs/${promptId}/cancel`, { method: "POST" }));
		expect(result.status).toBe(200);
		expect(await result.json()).toEqual({ job_id: promptId, cancelled: false, outcome: "not_cancelled", status: "in_progress" });
		expect(calls.some((call) => call.method === "POST" && call.path === "/queue" && JSON.stringify(call.body) === JSON.stringify({ delete: [promptId] }))).toBe(true);
		expect(calls.some((call) => call.path === "/interrupt" || call.path.endsWith("/cancel"))).toBe(false);
	});

	test("cancel confirms a pending removal when the job disappears from the queue", async () => {
		const promptId = randomUUID();
		let present = true;
		const calls: string[] = [];
		const app = createHubApp({
			config,
			store,
			comfy: client(async (input, init) => {
				const url = new URL(String(input));
				calls.push(`${init?.method} ${url.pathname}`);
				if (url.pathname === `/api/jobs/${promptId}`) return present ? response({ id: promptId, status: "pending" }) : response({ error: "Job not found" }, 404);
				if (url.pathname === `/history/${promptId}`) return response({});
				if (url.pathname === "/queue" && init?.method === "GET") return response({ queue_running: [], queue_pending: present ? [[1, promptId, {}, {}, []]] : [] });
				if (url.pathname === "/queue" && init?.method === "POST") {
					present = false;
					return new Response(null, { status: 200 });
				}
				throw new Error(`Unexpected upstream request: ${url.pathname}`);
			}),
		});
		const result = await app.fetch(new Request(`http://127.0.0.1:3000/api/v1/jobs/${promptId}/cancel`, { method: "POST" }));
		expect(await result.json()).toEqual({ job_id: promptId, cancelled: true, outcome: "cancelled", status: "cancelled" });
		expect(calls).not.toContain("POST /interrupt");
		expect(calls).not.toContain(`POST /api/jobs/${promptId}/cancel`);
	});

	test("a failed queue-delete with no authoritative follow-up stays explicitly uncertain", async () => {
		const workflowId = await createWorkflow();
		const promptId = randomUUID();
		store.beginJobSubmission({
			promptId,
			workflowId,
			clientRequestId: null,
			requestFingerprint: "cancel-uncertain",
			metadata: {},
		});
		store.updateJobSubmission(promptId, "accepted");
		let deleteAttempted = false;
		const calls: string[] = [];
		const app = createHubApp({
			config,
			store,
			comfy: client(async (input, init) => {
				const url = new URL(String(input));
				const method = init?.method ?? "GET";
				calls.push(`${method} ${url.pathname}`);
				if (url.pathname === `/api/jobs/${promptId}`) {
					return deleteAttempted ? response({ error: "Job not found" }, 404) : response({ id: promptId, status: "pending" });
				}
				if (url.pathname === `/history/${promptId}`) return response({});
				if (url.pathname === "/queue" && method === "GET") return response({ queue_running: [], queue_pending: [] });
				if (url.pathname === "/queue" && method === "POST") {
					deleteAttempted = true;
					throw new TypeError("connection lost while deleting queue item");
				}
				throw new Error(`Unexpected upstream request: ${method} ${url.pathname}`);
			}),
		});
		const result = await app.fetch(new Request(`http://127.0.0.1:3000/api/v1/jobs/${promptId}/cancel`, { method: "POST" }));
		expect(result.status).toBe(202);
		expect(await result.json()).toEqual({
			job_id: promptId,
			cancelled: null,
			outcome: "unknown",
			status: "unknown",
			error: {
				code: "cancel_outcome_unknown",
				message: "ComfyUI did not confirm whether the pending job was removed",
			},
		});
		expect(store.getJobSubmission(promptId)?.state).toBe("accepted");
		expect(calls.filter((call) => call === "POST /queue")).toHaveLength(1);
		expect(calls.some((call) => call.endsWith("/cancel") || call === "POST /interrupt")).toBe(false);
	});
});
