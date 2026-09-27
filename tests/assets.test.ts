import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHubApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { ComfyApiClient, type FetchLike } from "../src/comfy-client.ts";
import { HubStore } from "../src/storage.ts";

const baseUrl = "http://192.168.0.2:8188";
const pngBytes = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
	0, 0, 0, 0, 0, 0, 0, 0,
]);

let root: string;
let config: ReturnType<typeof loadConfig>;
let store: HubStore;
let app: ReturnType<typeof createHubApp>;

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function comfy(fetchImpl: FetchLike): ComfyApiClient {
	return new ComfyApiClient({ baseUrl: new URL(baseUrl), timeoutMs: 1_000, fetchImpl });
}

async function stage(bytes: Uint8Array, filename: string, contentType = "image/png"): Promise<string> {
	const form = new FormData();
	form.append("file", new Blob([bytes], { type: contentType }), filename);
	const response = await app.fetch(new Request("http://127.0.0.1:3000/api/v1/uploads", { method: "POST", body: form }));
	expect(response.status).toBe(201);
	return (await response.json() as { upload_id: string }).upload_id;
}

async function promote(uploadId: string, kind: "image" | "mask", originalAssetId?: string): Promise<Response> {
	return app.fetch(new Request("http://127.0.0.1:3000/api/v1/assets", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ upload_id: uploadId, kind, ...(originalAssetId ? { original_asset_id: originalAssetId } : {}) }),
	}));
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "comfy-assets-test-"));
	config = loadConfig({
		DATA_DIR: join(root, "state"),
		COMFY_BASE_URL: baseUrl,
		COMFY_ALLOW_LAN: "true",
		MAX_UPLOAD_BYTES: "1048576",
		MAX_ASSET_BYTES: "524288",
		MAX_OUTPUT_BYTES: "1048576",
		MAX_WORKFLOW_BYTES: "524288",
	}, root);
	store = new HubStore({ dataDir: config.dataDir, uploadTtlMs: config.uploadTtlMs });
	await store.initialize();
	app = createHubApp({ config, store, comfy: comfy(async () => json({})) });
});

afterEach(async () => {
	await app.close();
	store.close();
	await rm(root, { recursive: true, force: true });
});

async function waitForAssets(jobId: string, status: "ready" | "pending", timeoutMs = 2_000): Promise<Array<Record<string, unknown>>> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const response = await app.fetch(new Request(`http://127.0.0.1:3000/api/v1/assets?job_id=${jobId}&limit=100`));
		const page = await response.json() as { assets: Array<Record<string, unknown>> };
		if (page.assets.length > 0 && page.assets.every((asset) => asset.status === status)) return page.assets;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Assets for job ${jobId} did not become ${status}`);
}

async function promptly<T>(promise: Promise<T>, message: string, timeoutMs = 300): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
		]);
	} finally {
		clearTimeout(timer!);
	}
}

describe("input asset promotion", () => {
	test("streams the staged image and mask through ComfyUI v1 multipart endpoints", async () => {
		const calls: Array<{ path: string; body: string; headers: Headers }> = [];
		const client = comfy(async (input, init) => {
			const url = new URL(String(input));
			const body = Buffer.from(await new Response(init?.body as ReadableStream<Uint8Array>).arrayBuffer()).toString("latin1");
			calls.push({ path: url.pathname, body, headers: new Headers(init?.headers) });
			if (url.pathname === "/upload/mask") {
				const requestedSubfolder = /name="subfolder"\r\n\r\n([^\r]+)/.exec(body)?.[1] ?? "";
				return json({ name: "mask-final.png", subfolder: requestedSubfolder, type: "input" });
			}
			if (url.pathname === "/upload/image") {
				const requestedSubfolder = /name="subfolder"\r\n\r\n([^\r]+)/.exec(body)?.[1] ?? "";
				return json({ name: "image-final.png", subfolder: requestedSubfolder, type: "input" });
			}
			throw new Error(`Unexpected upstream request: ${url.pathname}`);
		});
		app = createHubApp({ config, store, comfy: client });

		const imageUploadId = await stage(pngBytes, "../../private/portrait.png");
		const imageResponse = await promote(imageUploadId, "image");
		expect(imageResponse.status).toBe(201);
		const image = await imageResponse.json() as Record<string, unknown>;
		expect(image).toMatchObject({ kind: "image", status: "ready", filename: "image-final.png", type: "input" });
		expect(image.workflow_value).toBe(`${image.subfolder as string}/image-final.png`);
		expect(String(image.subfolder)).toMatch(/^comfy-hub\/[0-9a-f-]{36}$/);
		const imageAssetId = image.asset_id as string;
		const imageCall = calls[0]!;
		expect(imageCall.path).toBe("/upload/image");
		expect(imageCall.body).toContain('name="image"; filename="');
		expect(imageCall.body).toContain(Buffer.from(pngBytes).toString("latin1"));
		expect(imageCall.body).toContain('name="type"\r\n\r\ninput');
		expect(imageCall.body).toContain(`name="subfolder"\r\n\r\n${String(image.subfolder)}`);
		expect(imageCall.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
		expect(await Bun.file(join(store.inputAssetsDir, `${imageAssetId}.png`)).exists()).toBe(true);

		const maskUploadId = await stage(pngBytes, "mask.png");
		const maskResponse = await promote(maskUploadId, "mask", imageAssetId);
		expect(maskResponse.status).toBe(201);
		const mask = await maskResponse.json() as Record<string, unknown>;
		expect(mask).toMatchObject({ kind: "mask", status: "ready", original_asset_id: imageAssetId, type: "input" });
		expect(calls[1]?.path).toBe("/upload/mask");
		const originalRefText = /name="original_ref"\r\n\r\n([^\r]+)/.exec(calls[1]!.body)?.[1];
		expect(JSON.parse(originalRefText!)).toEqual({ filename: "image-final.png", subfolder: image.subfolder, type: "input" });
		expect(calls[1]!.body).toContain('name="image"; filename="');
	});

	test("rejects MIME mismatches and missing or invalid mask originals without calling ComfyUI", async () => {
		let upstreamCalls = 0;
		app = createHubApp({ config, store, comfy: comfy(async () => { upstreamCalls++; return json({}); }) });
		const mismatch = await stage(pngBytes, "not-an-image.png", "text/plain");
		const badMime = await promote(mismatch, "image");
		expect(badMime.status).toBe(415);
		expect(await badMime.json()).toMatchObject({ error: { code: "image_mime_mismatch" } });

		const missingOriginal = await promote(await stage(pngBytes, "mask.png"), "mask");
		expect(missingOriginal.status).toBe(400);
		expect(await missingOriginal.json()).toMatchObject({ error: { code: "original_asset_required" } });

		const badOriginal = await promote(await stage(pngBytes, "mask.png"), "mask", "../../etc/passwd");
		expect(badOriginal.status).toBe(400);
		expect(upstreamCalls).toBe(0);
	});

	test("enforces the configured promoted-asset size limit", async () => {
		let upstreamCalls = 0;
		app = createHubApp({ config, store, comfy: comfy(async () => { upstreamCalls++; return json({}); }) });
		const oversized = new Uint8Array(config.maxAssetBytes + 1);
		oversized.set(pngBytes.subarray(0, 8));
		const response = await promote(await stage(oversized, "large.png"), "image");
		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({ error: { code: "asset_too_large" } });
		expect(upstreamCalls).toBe(0);
	});

	test("records an ambiguous upload and never promotes the same staged upload twice, including after restart", async () => {
		let calls = 0;
		app = createHubApp({ config, store, comfy: comfy(async () => {
			calls++;
			throw new TypeError("connection dropped after ComfyUI accepted the body");
		}) });
		const uploadId = await stage(pngBytes, "lost-response.png");
		const first = await promote(uploadId, "image");
		expect(first.status).toBe(202);
		const result = await first.json() as { asset_id: string; status: string; workflow_value: string | null };
		expect(result.status).toBe("ambiguous");
		expect(result.workflow_value).toBeNull();
		expect(calls).toBe(1);

		await app.close();
		store.close();
		store = new HubStore({ dataDir: config.dataDir, uploadTtlMs: config.uploadTtlMs });
		await store.initialize();
		app = createHubApp({ config, store, comfy: comfy(async () => { calls++; return json({}); }) });
		const retry = await promote(uploadId, "image");
		expect(retry.status).toBe(202);
		expect(await retry.json()).toMatchObject({ asset_id: result.asset_id, status: "ambiguous" });
		expect(calls).toBe(1);
	});

	test("invalid upstream traversal references stay ambiguous instead of becoming workflow inputs", async () => {
		app = createHubApp({ config, store, comfy: comfy(async () => json({ name: "../escape.png", subfolder: "../../outside", type: "input" })) });
		const response = await promote(await stage(pngBytes, "image.png"), "image");
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({ status: "ambiguous", workflow_value: null });
	});
});

describe("output asset archive and content", () => {
	test("archives image, video, audio, and file outputs, associates the job/node and streams ranges", async () => {
		const jobId = randomUUID();
		const calls: string[] = [];
		const historyItem = {
			status: { status_str: "success" },
			outputs: {
				"459:461": {
					images: [{ filename: "frame.png", subfolder: "batch/one", type: "output" }, { filename: "../secret.png", subfolder: "", type: "output" }],
					videos: [{ filename: "clip.mp4", subfolder: "", type: "output" }],
					audio: [{ filename: "music.wav", subfolder: "", type: "output" }],
					files: [{ filename: "report.bin", subfolder: "", type: "output" }],
					text: ["not a file", { value: "also not a file" }],
				},
			},
		};
		const client = comfy(async (input) => {
			const url = new URL(String(input));
			calls.push(url.pathname);
			if (url.pathname === "/api/jobs") {
				return json({ jobs: [{ id: jobId, status: "completed" }], pagination: { offset: 0, limit: 100, total: 1, has_more: false } });
			}
			if (url.pathname === `/api/jobs/${jobId}`) return json({ id: jobId, status: "completed", outputs: {} });
			if (url.pathname === `/history/${jobId}`) return json({ [jobId]: historyItem });
			if (url.pathname === "/view") {
				const filename = url.searchParams.get("filename");
				return new Response(new TextEncoder().encode(`content:${filename}`), { headers: { "content-type": "application/octet-stream" } });
			}
			throw new Error(`Unexpected upstream call: ${url.pathname}`);
		});
		app = createHubApp({ config, store, comfy: client });

		const job = await app.fetch(new Request(`http://127.0.0.1:3000/api/v1/jobs/${jobId}`));
		expect(job.status).toBe(200);
		const assetsResponse = await app.fetch(new Request(`http://127.0.0.1:3000/api/v1/assets?job_id=${jobId}&limit=10`));
		expect(assetsResponse.status).toBe(200);
		const page = await assetsResponse.json() as { assets: Array<Record<string, unknown>>; pagination: { total: number } };
		expect(page.pagination.total).toBe(4);
		expect(page.assets.map((asset) => asset.kind).sort()).toEqual(["audio", "file", "image", "video"]);
		expect(page.assets.every((asset) => asset.status === "pending" && asset.job_id === jobId && asset.node_id === "459:461")).toBe(true);
		const readyAssets = await waitForAssets(jobId, "ready");
		expect(readyAssets).toHaveLength(4);
		expect(readyAssets.every((asset) => typeof asset.download_url === "string" && String(asset.download_url).startsWith("http://127.0.0.1:3000/"))).toBe(true);
		expect(calls.filter((path) => path === "/view")).toHaveLength(4);

		const image = readyAssets.find((asset) => asset.kind === "image")!;
		const contentUrl = new URL(String(image.download_url));
		const partial = await app.fetch(new Request(contentUrl.toString(), { headers: { range: "bytes=2-7" } }));
		expect(partial.status).toBe(206);
		expect(partial.headers.get("content-range")).toMatch(/^bytes 2-7\//);
		expect(partial.headers.get("accept-ranges")).toBe("bytes");
		expect(partial.headers.get("content-disposition")).toMatch(/^attachment; filename="asset-out_[a-f0-9]{64}\.png"$/);
		expect(await partial.text()).toBe("ntent:");
		const invalidRange = await app.fetch(new Request(contentUrl.toString(), { headers: { range: "bytes=99999-" } }));
		expect(invalidRange.status).toBe(416);
		expect(invalidRange.headers.get("content-range")).toMatch(/^bytes \*\//);

		const detail = await app.fetch(new Request(`http://127.0.0.1:3000/api/v1/assets/${image.asset_id}`));
		expect(detail.status).toBe(200);
		expect(await detail.json()).toMatchObject({ asset_id: image.asset_id, status: "ready", node_id: "459:461" });

		const jobs = await app.fetch(new Request("http://127.0.0.1:3000/api/v1/jobs?limit=10"));
		expect(jobs.status).toBe(200);
		expect(calls.filter((path) => path === "/view")).toHaveLength(4);
	});

	test("keeps a failed partial archive pending and recovers it after a process restart", async () => {
		const jobId = randomUUID();
		let viewCalls = 0;
		const history = {
			[jobId]: {
				status: { status_str: "success" },
				outputs: { "9": { images: [{ filename: "recover.png", subfolder: "", type: "output" }] } },
			},
		};
		const client = comfy(async (input) => {
			const url = new URL(String(input));
			if (url.pathname === `/api/jobs/${jobId}`) return json({ id: jobId, status: "completed" });
			if (url.pathname === `/history/${jobId}`) return json(history);
			if (url.pathname === "/view") {
				viewCalls++;
				if (viewCalls === 1) {
					return new Response(new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("partial"));
							controller.error(new Error("connection interrupted"));
						},
					}));
				}
				return new Response(new TextEncoder().encode("recovered archive"), { headers: { "content-type": "image/png" } });
			}
			throw new Error(`Unexpected upstream call: ${url.pathname}`);
		});
		app = createHubApp({ config, store, comfy: client });
		const firstJobRead = await app.fetch(new Request(`http://127.0.0.1:3000/api/v1/jobs/${jobId}`));
		expect(firstJobRead.status).toBe(200);
		let pending = await app.fetch(new Request(`http://127.0.0.1:3000/api/v1/assets?job_id=${jobId}`));
		let page = await pending.json() as { assets: Array<Record<string, unknown>> };
		expect(page.assets).toHaveLength(1);
		expect(page.assets[0]).toMatchObject({ status: "pending", download_url: null });
		await app.close();
		expect(viewCalls).toBe(1);
		expect((await readdir(store.outputAssetsDir)).filter((name) => name.endsWith(".partial"))).toHaveLength(0);
		store.close();
		store = new HubStore({ dataDir: config.dataDir, uploadTtlMs: config.uploadTtlMs });
		await store.initialize();
		app = createHubApp({ config, store, comfy: client });
		const recoveredJobRead = await app.fetch(new Request(`http://127.0.0.1:3000/api/v1/jobs/${jobId}`));
		expect(recoveredJobRead.status).toBe(200);
		const recoveredAssets = await waitForAssets(jobId, "ready");
		expect(recoveredAssets[0]).toMatchObject({ status: "ready", bytes: "recovered archive".length });
		expect(viewCalls).toBe(2);
	});

	test("enforces the output byte limit against streamed bytes, not upstream metadata", async () => {
		const jobId = randomUUID();
		const client = comfy(async (input) => {
			const url = new URL(String(input));
			if (url.pathname === `/api/jobs/${jobId}`) return json({ id: jobId, status: "completed" });
			if (url.pathname === `/history/${jobId}`) {
				return json({ [jobId]: {
					status: { status_str: "success" },
					outputs: { "3": { files: [{ filename: "large.bin", subfolder: "", type: "output" }] } },
				} });
			}
			if (url.pathname === "/view") {
				return new Response(new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array(config.maxOutputBytes + 1));
						controller.close();
					},
				}));
			}
			throw new Error(`Unexpected upstream call: ${url.pathname}`);
		});
		app = createHubApp({ config, store, comfy: client });
		const job = await app.fetch(new Request(`http://127.0.0.1:3000/api/v1/jobs/${jobId}`));
		expect(job.status).toBe(200);
		const response = await app.fetch(new Request(`http://127.0.0.1:3000/api/v1/assets?job_id=${jobId}`));
		const page = await response.json() as { assets: Array<Record<string, unknown>> };
		expect(page.assets).toHaveLength(1);
		expect(page.assets[0]).toMatchObject({ status: "pending", bytes: null, download_url: null });
		await app.close();
		expect((await readdir(store.outputAssetsDir)).filter((name) => name.endsWith(".partial"))).toHaveLength(0);
	});

	test("job get and wait return while bounded background transfers are held open", async () => {
		const jobId = randomUUID();
		const releaseGate = (() => {
			let release!: () => void;
			const promise = new Promise<void>((resolve) => { release = resolve; });
			return { promise, release };
		})();
		let markStarted!: () => void;
		const twoStarted = new Promise<void>((resolve) => { markStarted = resolve; });
		let started = 0;
		let active = 0;
		let maxActive = 0;
		let upstreamAborts = 0;
		const videoRefs = ["clip-one.mp4", "clip-two.mp4", "clip-three.mp4"];
		const client = new ComfyApiClient({
			baseUrl: new URL(baseUrl),
			timeoutMs: 20,
			fetchImpl: async (input, init) => {
				const url = new URL(String(input));
				if (url.pathname === "/api/jobs") return json({
					jobs: [{ id: jobId, status: "completed" }],
					pagination: { offset: 0, limit: 100, total: 1, has_more: false },
				});
				if (url.pathname === `/api/jobs/${jobId}`) return json({ id: jobId, status: "completed" });
				if (url.pathname === `/history/${jobId}`) {
					return json({ [jobId]: {
						status: { status_str: "success" },
						outputs: { "459:461": { videos: videoRefs.map((filename) => ({ filename, subfolder: "", type: "output" })) } },
					} });
				}
				if (url.pathname === "/view") {
					started++;
					active++;
					maxActive = Math.max(maxActive, active);
					if (started === 2) markStarted();
					let ended = false;
					const finish = () => {
						if (ended) return;
						ended = true;
						active--;
					};
					const signal = init?.signal;
					signal?.addEventListener("abort", () => {
						upstreamAborts++;
						finish();
					}, { once: true });
					return new Response(new ReadableStream<Uint8Array>({
						async pull(controller) {
							await releaseGate.promise;
							finish();
							controller.enqueue(new TextEncoder().encode("archived video bytes"));
							controller.close();
						},
						cancel() { finish(); },
					}), { headers: { "content-type": "video/mp4" } });
				}
				throw new Error(`Unexpected upstream call: ${url.pathname}`);
			},
		});
		app = createHubApp({ config, store, comfy: client });
		const requestAbort = new AbortController();
		const jobResponse = await promptly(
			app.fetch(new Request(`http://127.0.0.1:3000/api/v1/jobs/${jobId}`, { signal: requestAbort.signal })),
			"job get waited for output transfer",
		);
		expect(jobResponse.status).toBe(200);
		await promptly(twoStarted, "bounded workers did not start two output transfers");
		requestAbort.abort(new DOMException("caller disconnected after its response", "AbortError"));
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(upstreamAborts).toBe(0);
		expect(started).toBe(2);
		expect(maxActive).toBe(2);

		const waitResponse = await promptly(
			app.fetch(new Request(`http://127.0.0.1:3000/api/v1/jobs/${jobId}/wait?timeout=0`)),
			"job wait waited for output transfer",
		);
		expect(waitResponse.status).toBe(200);
		expect(await waitResponse.json()).toMatchObject({ status: "completed", wait_timed_out: false });
		const pendingResponse = await app.fetch(new Request(`http://127.0.0.1:3000/api/v1/assets?job_id=${jobId}`));
		const pendingPage = await pendingResponse.json() as { assets: Array<Record<string, unknown>> };
		expect(pendingPage.assets).toHaveLength(3);
		expect(pendingPage.assets.every((asset) => asset.status === "pending" && asset.download_url === null && asset.node_id === "459:461")).toBe(true);
		expect(started).toBe(2);
		const pendingDetail = await promptly(
			app.fetch(new Request(`http://127.0.0.1:3000/api/v1/assets/${pendingPage.assets[0]!.asset_id}`)),
			"pending asset get blocked on output transfer",
		);
		expect(await pendingDetail.json()).toMatchObject({ status: "pending", download_url: null });
		const jobListResponse = await promptly(
			app.fetch(new Request("http://127.0.0.1:3000/api/v1/jobs?limit=10")),
			"job list waited for output transfer",
		);
		expect(jobListResponse.status).toBe(200);
		expect(await jobListResponse.json()).toMatchObject({ jobs: [{ id: jobId, status: "completed" }] });
		expect(started).toBe(2);

		releaseGate.release();
		const readyAssets = await waitForAssets(jobId, "ready");
		expect(readyAssets).toHaveLength(3);
		expect(started).toBe(3);
		expect(maxActive).toBe(2);
		expect(upstreamAborts).toBe(0);
	});
});
