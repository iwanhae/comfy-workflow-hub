import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHubApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { ComfyApiClient, type FetchLike } from "../src/comfy-client.ts";
import { HubStore } from "../src/storage.ts";

const validWorkflowText = '{\n  "1": {"class_type":"CheckpointLoaderSimple", "inputs": {"ckpt_name":"example.safetensors"}}\n}\n';
const validWorkflow = new TextEncoder().encode(validWorkflowText);
const liveLikeComfyUrl = "http://192.168.0.2:8188";

let root: string;
let config: ReturnType<typeof loadConfig>;
let store: HubStore;
let comfy: ComfyApiClient;
let app: ReturnType<typeof createHubApp>;

function mockedComfyClient(fetchImpl?: FetchLike): ComfyApiClient {
	return new ComfyApiClient({
		baseUrl: new URL(liveLikeComfyUrl),
		timeoutMs: 1000,
		fetchImpl: fetchImpl ?? (async () => new Response("{}", { headers: { "content-type": "application/json" } })),
	});
}

function uploadRequest(bytes: Uint8Array, filename = "workflow.json"): Request {
	const form = new FormData();
	form.append("file", new Blob([bytes], { type: "application/json" }), filename);
	return new Request("http://127.0.0.1:3000/api/v1/uploads", { method: "POST", body: form });
}

function multipartRequest(
	fileBytes: Uint8Array,
	options: { chunkSize?: number; extraPart?: boolean; closingBoundary?: string } = {},
): Request {
	const boundary = "hub-split-boundary-42";
	const parts = [
		Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="split.json"\r\nContent-Type: application/json\r\n\r\n`),
		Buffer.from(fileBytes),
		Buffer.from(`\r\n--${boundary}${options.extraPart ? `\r\nContent-Disposition: form-data; name="extra"\r\n\r\nnope\r\n--${boundary}` : ""}${options.closingBoundary ?? "--"}\r\n`),
	];
	const body = Buffer.concat(parts);
	const chunkSize = options.chunkSize ?? 7;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (let offset = 0; offset < body.length; offset += chunkSize) {
				controller.enqueue(body.subarray(offset, Math.min(offset + chunkSize, body.length)));
			}
			controller.close();
		},
	});
	return new Request("http://127.0.0.1:3000/api/v1/uploads", {
		method: "POST",
		headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
		body: stream,
	});
}

async function stage(bytes: Uint8Array = validWorkflow, filename = "workflow.json"): Promise<{ upload_id: string; sha256: string }> {
	const response = await app.fetch(uploadRequest(bytes, filename));
	expect(response.status).toBe(201);
	return (await response.json()) as { upload_id: string; sha256: string };
}

async function uploadWorkflow(uploadId: string, metadata: { name?: string; description?: string } = {}): Promise<Response> {
	return app.fetch(
		new Request("http://127.0.0.1:3000/api/v1/workflows", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ upload_id: uploadId, ...metadata }),
		}),
	);
}

async function errorCode(response: Response): Promise<string> {
	return ((await response.json()) as { error: { code: string } }).error.code;
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "comfy-hub-test-"));
	config = loadConfig({
		DATA_DIR: join(root, "state"),
		COMFY_BASE_URL: liveLikeComfyUrl,
		COMFY_ALLOW_LAN: "true",
		MAX_UPLOAD_BYTES: "1048576",
		MAX_WORKFLOW_BYTES: "524288",
	}, root);
	store = new HubStore({ dataDir: config.dataDir, uploadTtlMs: config.uploadTtlMs });
	await store.initialize();
	comfy = mockedComfyClient();
	app = createHubApp({ config, store, comfy });
});

afterEach(async () => {
	store.close();
	await rm(root, { recursive: true, force: true });
});

describe("workflow staging and immutable storage", () => {
	test("preserves exact API JSON bytes, records metadata, and deduplicates by SHA-256", async () => {
		const firstStage = await stage(validWorkflow, "first-original-café.json");
		const firstResponse = await uploadWorkflow(firstStage.upload_id, { name: "Initial name", description: "First notes" });
		expect(firstResponse.status).toBe(201);
		const first = (await firstResponse.json()) as { id: string; sha256: string; filename: string; name: string; description: string };
		expect(first.id).toBe(createHash("sha256").update(validWorkflow).digest("hex"));
		expect(first.sha256).toBe(first.id);
		expect(first.name).toBe("Initial name");
		expect(first.filename).toBe("first-original-café.json");
		expect(first.description).toBe("First notes");

		const secondStage = await stage(validWorkflow, "second-original.json");
		const secondResponse = await uploadWorkflow(secondStage.upload_id, { name: "Ignored duplicate name", description: "Ignored notes" });
		expect(secondResponse.status).toBe(201);
		const second = (await secondResponse.json()) as { id: string; filename: string; name: string; description: string };
		expect(second.id).toBe(first.id);
		expect(second.filename).toBe("first-original-café.json");
		expect(second.name).toBe("Initial name");
		expect(second.description).toBe("First notes");
		expect(store.workflowCount()).toBe(1);

		const listResponse = await app.fetch(new Request("http://127.0.0.1:3000/api/v1/workflows"));
		const list = (await listResponse.json()) as { workflows: Array<{ id: string; bytes: number; filename: string }>; total: number };
		expect(list.total).toBe(1);
		expect(list.workflows[0]?.id).toBe(first.id);
		expect(list.workflows[0]?.bytes).toBe(validWorkflow.length);
		expect(list.workflows[0]?.filename).toBe("first-original-café.json");
		const detailResponse = await app.fetch(new Request(`http://127.0.0.1:3000/api/v1/workflows/${first.id}`));
		const detail = (await detailResponse.json()) as { metadata: { filename: string; name: string; description: string } };
		expect(detail.metadata.filename).toBe("first-original-café.json");
		expect(detail.metadata.name).toBe("Initial name");
		expect(detail.metadata.description).toBe("First notes");

		const contentResponse = await app.fetch(new Request(`http://127.0.0.1:3000/api/v1/workflows/${first.id}/content`));
		expect(contentResponse.status).toBe(200);
		expect(contentResponse.headers.get("etag")).toBe(`"${first.id}"`);
		expect(new Uint8Array(await contentResponse.arrayBuffer())).toEqual(validWorkflow);
		const stored = await readFile(join(config.dataDir, "workflows", `${first.id}.json`));
		expect(stored).toEqual(Buffer.from(validWorkflow));
	});

	test("atomically permits only one claimant for a staged upload_id", async () => {
		const staged = await stage();
		const results = await Promise.allSettled([
			store.workflowUpload(staged.upload_id, {}, config.maxWorkflowBytes),
			store.workflowUpload(staged.upload_id, {}, config.maxWorkflowBytes),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect(store.workflowCount()).toBe(1);
	});

	test("deduplicates concurrent commits through independent SQLite connections", async () => {
		const otherStore = new HubStore({ dataDir: config.dataDir, uploadTtlMs: config.uploadTtlMs });
		await otherStore.initialize();
		try {
			const first = await stage();
			const second = await stage();
			const results = await Promise.all([
				store.workflowUpload(first.upload_id, { name: "first" }, config.maxWorkflowBytes),
				otherStore.workflowUpload(second.upload_id, { name: "second" }, config.maxWorkflowBytes),
			]);
			expect(results[0]?.id).toBe(results[1]?.id);
			expect(store.workflowCount()).toBe(1);
		} finally {
			otherStore.close();
		}
	});

	test("rejects replayed and unknown upload ids and prevents traversal", async () => {
		const staged = await stage();
		expect((await uploadWorkflow(staged.upload_id)).status).toBe(201);
		const replay = await uploadWorkflow(staged.upload_id);
		expect(replay.status).toBe(409);
		expect(await errorCode(replay)).toBe("upload_already_claimed");

		const traversal = await uploadWorkflow("../../../../etc/passwd");
		expect(traversal.status).toBe(400);
		expect(await errorCode(traversal)).toBe("invalid_upload_id");
		expect(store.stagingPath(randomUUID())).toContain(join(config.dataDir, "staging"));
	});

	test("rejects malformed JSON and UI-format workflows", async () => {
		const malformed = await stage(new TextEncoder().encode("{broken"));
		const malformedResponse = await uploadWorkflow(malformed.upload_id);
		expect(malformedResponse.status).toBe(400);
		expect(await errorCode(malformedResponse)).toBe("invalid_workflow_json");

		const ui = await stage(new TextEncoder().encode(JSON.stringify({ nodes: [], links: [] })));
		const uiResponse = await uploadWorkflow(ui.upload_id);
		expect(uiResponse.status).toBe(400);
		expect(await errorCode(uiResponse)).toBe("ui_workflow_not_supported");
		expect(store.workflowCount()).toBe(0);
	});

	test("expires staged uploads and refuses to claim them", async () => {
		let clock = 1_000;
		const expiryStore = new HubStore({ dataDir: join(root, "expiry"), uploadTtlMs: 100, now: () => clock });
		await expiryStore.initialize();
		const uploadId = randomUUID();
		const digest = createHash("sha256").update(validWorkflow).digest("hex");
		await writeFile(expiryStore.stagingPath(uploadId), validWorkflow);
		await expiryStore.addStagedUpload({
			uploadId,
			sha256: digest,
			bytes: validWorkflow.length,
			filename: "workflow.json",
			contentType: "application/json",
		});
		clock = 1_101;
		expiryStore.close();
		const afterRestart = new HubStore({ dataDir: join(root, "expiry"), uploadTtlMs: 100, now: () => clock });
		await afterRestart.initialize();
		await expect(afterRestart.workflowUpload(uploadId, {}, config.maxWorkflowBytes)).rejects.toMatchObject({ status: 410 });
		expect(afterRestart.workflowCount()).toBe(0);
		expect(await Bun.file(afterRestart.stagingPath(uploadId)).exists()).toBe(false);
		afterRestart.close();
	});

	test("recovers old interrupted claims and orphan staging files after restart, but not recent claims", async () => {
		const recoveryDir = join(root, "recovery");
		let clock = Date.now();
		const graceMs = 1_000;
		const crashedStore = new HubStore({
			dataDir: recoveryDir,
			uploadTtlMs: 10_000,
			recoveryGraceMs: graceMs,
			now: () => clock,
		});
		await crashedStore.initialize();
		const uploadId = randomUUID();
		const sha256 = createHash("sha256").update(validWorkflow).digest("hex");
		await writeFile(crashedStore.stagingPath(uploadId), validWorkflow);
		await crashedStore.addStagedUpload({
			uploadId,
			sha256,
			bytes: validWorkflow.length,
			filename: "recovered.json",
			contentType: "application/json",
		});
		crashedStore.db.prepare("UPDATE staged_uploads SET state = 'claimed', claimed_at = ? WHERE upload_id = ?").run(clock, uploadId);

		const orphanId = randomUUID();
		const orphanPath = crashedStore.stagingPath(orphanId);
		await writeFile(orphanPath, "partial upload");
		await utimes(orphanPath, new Date(clock), new Date(clock));
		crashedStore.close();

		clock += 500;
		const restartedStore = new HubStore({
			dataDir: recoveryDir,
			uploadTtlMs: 10_000,
			recoveryGraceMs: graceMs,
			now: () => clock,
		});
		await restartedStore.initialize();
		await expect(restartedStore.workflowUpload(uploadId, {}, config.maxWorkflowBytes)).rejects.toMatchObject({ status: 409 });
		expect(await Bun.file(orphanPath).exists()).toBe(true);

		clock += 600;
		await restartedStore.reapExpiredUploads();
		expect(await Bun.file(orphanPath).exists()).toBe(false);
		const recovered = await restartedStore.workflowUpload(uploadId, {}, config.maxWorkflowBytes);
		expect(recovered.filename).toBe("recovered.json");
		expect(restartedStore.workflowCount()).toBe(1);
		restartedStore.close();
	});

	test("migrates existing workflow rows while marking their unavailable filenames null", async () => {
		const legacyDir = join(root, "legacy");
		await mkdir(legacyDir, { recursive: true });
		const legacyDb = new Database(join(legacyDir, "hub.sqlite"), { create: true });
		legacyDb.exec(`
			CREATE TABLE workflows (
				id TEXT PRIMARY KEY,
				sha256 TEXT NOT NULL UNIQUE,
				name TEXT,
				description TEXT,
				bytes INTEGER NOT NULL,
				created_at INTEGER NOT NULL
			);
			PRAGMA user_version = 1;
		`);
		const digest = createHash("sha256").update(validWorkflow).digest("hex");
		legacyDb.prepare(`
			INSERT INTO workflows(id, sha256, name, description, bytes, created_at)
			VALUES (?, ?, ?, ?, ?, ?)
		`).run(digest, digest, "Legacy", null, validWorkflow.length, Date.now());
		legacyDb.close();

		const migrated = new HubStore({ dataDir: legacyDir, uploadTtlMs: config.uploadTtlMs });
		expect(migrated.getWorkflow(digest)?.name).toBe("Legacy");
		expect(migrated.getWorkflow(digest)?.filename).toBeNull();
		expect((migrated.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3);
		migrated.close();
	});

	test("migrates the milestone 1 schema to durable jobs without changing stored workflow rows", async () => {
		const legacyDir = join(root, "milestone-1");
		await mkdir(legacyDir, { recursive: true });
		const legacyDb = new Database(join(legacyDir, "hub.sqlite"), { create: true });
		legacyDb.exec(`
			CREATE TABLE workflows (
				id TEXT PRIMARY KEY,
				sha256 TEXT NOT NULL UNIQUE,
				original_filename TEXT NOT NULL,
				name TEXT,
				description TEXT,
				bytes INTEGER NOT NULL CHECK (bytes > 0),
				created_at INTEGER NOT NULL
			);
			PRAGMA user_version = 2;
		`);
		const digest = createHash("sha256").update(validWorkflow).digest("hex");
		legacyDb.prepare(`
			INSERT INTO workflows(id, sha256, original_filename, name, description, bytes, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(digest, digest, "persisted.json", "Persisted", null, validWorkflow.length, Date.now());
		legacyDb.close();

		const migrated = new HubStore({ dataDir: legacyDir, uploadTtlMs: config.uploadTtlMs });
		expect(migrated.getWorkflow(digest)?.filename).toBe("persisted.json");
		expect((migrated.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3);
		expect(migrated.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'job_submissions'").get()).toBeTruthy();
		expect(migrated.clientId).toMatch(/^[0-9a-f-]{36}$/);
		migrated.close();
	});
});

describe("HTTP boundaries and Comfy proxy", () => {
	test("accepts multipart delimiters split across one-byte chunks", async () => {
		const response = await app.fetch(multipartRequest(validWorkflow, { chunkSize: 1 }));
		expect(response.status).toBe(201);
		const staged = (await response.json()) as { upload_id: string; bytes: number };
		expect(staged.bytes).toBe(validWorkflow.length);
		const committed = await uploadWorkflow(staged.upload_id);
		expect(committed.status).toBe(201);
	});

	test("rejects malformed closing delimiters and extra multipart parts", async () => {
		const malformed = await app.fetch(multipartRequest(validWorkflow, { chunkSize: 3, closingBoundary: "-" }));
		expect(malformed.status).toBe(400);
		expect(await errorCode(malformed)).toBe("invalid_multipart");

		const extra = await app.fetch(multipartRequest(validWorkflow, { chunkSize: 5, extraPart: true }));
		expect(extra.status).toBe(400);
		expect(await errorCode(extra)).toBe("invalid_multipart");
		expect(store.workflowCount()).toBe(0);
	});

	test("streams multipart to a size limit and rejects non-multipart payloads", async () => {
		const tooLarge = new Uint8Array(config.maxUploadBytes + 1);
		const response = await app.fetch(uploadRequest(tooLarge));
		expect(response.status).toBe(413);
		expect(await errorCode(response)).toBe("upload_too_large");

		const badContentType = await app.fetch(new Request("http://127.0.0.1:3000/api/v1/uploads", { method: "POST", body: "nope" }));
		expect(badContentType.status).toBe(415);
		expect(store.workflowCount()).toBe(0);
	});

	test("blocks disallowed Host and cross-origin mutation requests", async () => {
		const badHost = await app.fetch(new Request("http://example.com/health"));
		expect(badHost.status).toBe(403);
		const badOrigin = await app.fetch(
			new Request("http://127.0.0.1:3000/api/v1/workflows", {
				method: "POST",
				headers: { origin: "https://attacker.invalid", "content-type": "application/json" },
				body: "{}",
			}),
		);
		expect(badOrigin.status).toBe(403);
	});

	test("proxies only the documented GET endpoints to the configured Comfy target", async () => {
		const calls: string[] = [];
		const readOnly = mockedComfyClient(async (input, init) => {
			calls.push(`${init?.method} ${String(input)}`);
			return new Response(JSON.stringify({ path: new URL(String(input)).pathname }), {
				headers: { "content-type": "application/json" },
			});
		});
		const readApp = createHubApp({ config, store, comfy: readOnly });
		for (const route of [
			"/api/v1/comfy/nodes",
			"/api/v1/comfy/models",
			"/api/v1/comfy/models/checkpoints",
			"/api/v1/comfy/status",
			"/api/v1/comfy/jobs",
			"/api/v1/comfy/jobs/job-1",
			"/api/v1/comfy/queue",
			"/api/v1/comfy/history/job-1",
			"/api/v1/comfy/system",
		]) {
			const response = await readApp.fetch(new Request(`http://127.0.0.1:3000${route}`));
			expect(response.status).toBe(200);
		}
		expect(calls.map((call) => call.split(" ")[1])).toEqual([
			`${liveLikeComfyUrl}/object_info`,
			`${liveLikeComfyUrl}/models`,
			`${liveLikeComfyUrl}/models/checkpoints`,
			`${liveLikeComfyUrl}/system_stats`,
			`${liveLikeComfyUrl}/api/jobs`,
			`${liveLikeComfyUrl}/api/jobs/job-1`,
			`${liveLikeComfyUrl}/queue`,
			`${liveLikeComfyUrl}/history/job-1`,
			`${liveLikeComfyUrl}/system_stats`,
		]);
		expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
	});

	test("does not allow arbitrary public upstream targets without explicit LAN opt-in", () => {
		expect(() => loadConfig({ COMFY_BASE_URL: "https://example.com" }, root)).toThrow("COMFY_ALLOW_LAN=true");
		expect(() => loadConfig({ HUB_HOST: "0.0.0.0" }, root)).toThrow("HUB_ALLOW_LAN=true");
		expect(
			loadConfig({ COMFY_BASE_URL: liveLikeComfyUrl, COMFY_ALLOW_LAN: "true" }, root).comfyBaseUrl.origin,
		).toBe(liveLikeComfyUrl);
	});
});
