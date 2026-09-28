import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHubApp, type HubRequestServer } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { ComfyApiClient, type FetchLike } from "../src/comfy-client.ts";
import { JobService } from "../src/jobs.ts";
import { HubStore } from "../src/storage.ts";

const apiWorkflow = new TextEncoder().encode('{"1":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"example.safetensors"}}}');
const modelFiles = {
	diffusion_models: ["qwen_image_2.1_int8_convrot.safetensors"],
	text_encoders: [
		"qwen3vl_8b_int8_convrot.safetensors",
		"qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors",
	],
	vae: ["qwen_image_2.1_vae_bf16.safetensors"],
};

let root: string;
let config: ReturnType<typeof loadConfig>;
let store: HubStore;
let app: ReturnType<typeof createHubApp>;
let upstreamCalls: Array<{ url: string; method: string; signal?: AbortSignal }>;
let jobStatus: "pending" | "completed" = "pending";
let modelFolderOverride: Record<string, string[]> | null;
let jobs: RecordingJobService;

class RecordingJobService extends JobService {
	waitTimeouts: number[] = [];

	override wait(...args: Parameters<JobService["wait"]>): ReturnType<JobService["wait"]> {
		this.waitTimeouts.push(args[1]);
		return super.wait(...args);
	}
}

function nodeCatalog(): Record<string, unknown> {
	const choices = ["qwen_image_2.1_int8_convrot.safetensors", "another-model.safetensors"];
	return {
		UNETLoader: {
			name: "UNETLoader",
			display_name: "Load Diffusion Model",
			category: "loaders",
			description: "Loads a diffusion model.",
			input: { required: { unet_name: [choices, {}], weight_dtype: [["default", "fp8_e4m3fn"], {}] } },
			output: ["MODEL"],
			output_name: ["model"],
		},
		CLIPLoader: {
			name: "CLIPLoader",
			display_name: "Load CLIP",
			category: "loaders",
			input: { required: { clip_name: [[...modelFiles.text_encoders], {}], type: [["qwen_image", "stable_diffusion"], {}] } },
			output: ["CLIP"],
			output_name: ["clip"],
		},
		VAELoader: {
			name: "VAELoader",
			display_name: "Load VAE",
			category: "loaders",
			input: { required: { vae_name: [[...modelFiles.vae], {}] } },
			output: ["VAE"],
			output_name: ["vae"],
		},
		KSampler: {
			name: "KSampler",
			display_name: "KSampler",
			category: "sampling",
			description: "Samples a latent image.",
			input: { required: { steps: ["INT", { default: 20 }] } },
			output: ["LATENT"],
			output_name: ["latent"],
		},
	};
}

function mockComfyFetch(): FetchLike {
	return async (input, init = {}) => {
		const url = new URL(String(input));
		const method = init.method ?? "GET";
		upstreamCalls.push({ url: url.toString(), method, ...(init.signal ? { signal: init.signal } : {}) });
		if (url.pathname === "/object_info") return Response.json(nodeCatalog());
		if (url.pathname === "/models") return Response.json(Object.keys(modelFiles));
		const folderMatch = /^\/models\/([^/]+)$/.exec(url.pathname);
		if (folderMatch) {
			const folder = decodeURIComponent(folderMatch[1]!);
			return Response.json(modelFolderOverride?.[folder] ?? modelFiles[folder as keyof typeof modelFiles] ?? []);
		}
		if (url.pathname === "/system_stats") {
			return Response.json({
				system: { comfyui_version: "0.37.0", python_version: "3.12.4", pytorch_version: "2.7.0", argv: ["must-not-leak"] },
				devices: [{ name: "Mock GPU", type: "cuda", index: 0, vram_total: 24, vram_free: 18, argv: ["must-not-leak"] }],
			});
		}
		if (url.pathname === "/queue") return Response.json({ queue_running: [[0, "active"]], queue_pending: [[1, "waiting"], [2, "waiting-2"]] });
		if (url.pathname.startsWith("/api/jobs/")) {
			return Response.json({ id: url.pathname.slice("/api/jobs/".length), status: jobStatus, outputs: {} });
		}
		if (url.pathname === "/api/jobs") return Response.json({ jobs: [], pagination: { offset: 0, limit: 100, total: 0, has_more: false } });
		if (url.pathname.startsWith("/history/")) return Response.json({});
		if (url.pathname === "/upload/image") {
			const body = await new Response(init.body).text();
			const subfolder = /name="subfolder"\r\n\r\n([^\r\n]+)/.exec(body)?.[1] ?? "";
			return Response.json({ name: "uploaded.png", subfolder, type: "input" });
		}
		if (url.pathname === "/upload/mask") return Response.json({ name: "mask.png", subfolder: "comfy-hub/mock", type: "input" });
		return new Response(JSON.stringify({ error: `Unexpected mocked Comfy route: ${url.pathname}` }), { status: 404 });
	};
}

function rpcRequest(method: string, params: Record<string, unknown> = {}, id = 1, options: { signal?: AbortSignal; headers?: Record<string, string> } = {}): Request {
	return new Request("http://127.0.0.1:3000/mcp", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			host: "127.0.0.1:3000",
			...options.headers,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
		...(options.signal ? { signal: options.signal } : {}),
	});
}

async function rpcPayload(response: Response): Promise<Record<string, unknown>> {
	const text = await response.text();
	if (response.headers.get("content-type")?.includes("text/event-stream")) {
		const data = text.split("\n").find((line) => line.startsWith("data:"));
		if (!data) throw new Error(`Missing MCP SSE data event: ${text}`);
		return JSON.parse(data.slice("data:".length).trim()) as Record<string, unknown>;
	}
	return JSON.parse(text) as Record<string, unknown>;
}

async function initializeMcp(): Promise<void> {
	const response = await app.fetch(rpcRequest("initialize", {
		protocolVersion: "2025-03-26",
		capabilities: {},
		clientInfo: { name: "hub-mcp-test", version: "1.0.0" },
	}));
	expect(response.status).toBe(200);
	const initialized = await app.fetch(new Request("http://127.0.0.1:3000/mcp", {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream", host: "127.0.0.1:3000" },
		body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
	}));
	expect(initialized.status).toBe(202);
}

async function callTool(name: string, args: Record<string, unknown>, id = 2, options: { signal?: AbortSignal; headers?: Record<string, string>; server?: HubRequestServer } = {}): Promise<Record<string, unknown>> {
	const response = await app.fetch(rpcRequest("tools/call", { name, arguments: args }, id, options), options.server);
	return rpcPayload(response);
}

function toolValue(payload: Record<string, unknown>): Record<string, unknown> {
	const result = payload.result as Record<string, unknown> | undefined;
	if (!result) throw new Error(`MCP call returned no result: ${JSON.stringify(payload)}`);
	if (result.structuredContent && typeof result.structuredContent === "object") {
		return result.structuredContent as Record<string, unknown>;
	}
	const content = result.content as Array<{ text?: string }> | undefined;
	if (!content?.[0]?.text) throw new Error(`MCP call returned no JSON content: ${JSON.stringify(payload)}`);
	return JSON.parse(content[0].text) as Record<string, unknown>;
}

async function stage(bytes: Uint8Array, filename: string): Promise<string> {
	const form = new FormData();
	form.append("file", new Blob([bytes]), filename);
	const response = await app.fetch(new Request("http://127.0.0.1:3000/api/v1/uploads", { method: "POST", body: form }));
	expect(response.status).toBe(201);
	return ((await response.json()) as { upload_id: string }).upload_id;
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "comfy-hub-mcp-test-"));
	config = loadConfig({
		DATA_DIR: join(root, "state"),
		COMFY_BASE_URL: "http://192.168.0.2:8188",
		COMFY_ALLOW_LAN: "true",
		MAX_UPLOAD_BYTES: "1048576",
		MAX_WORKFLOW_BYTES: "524288",
	}, root);
	store = new HubStore({ dataDir: config.dataDir, uploadTtlMs: config.uploadTtlMs });
	await store.initialize();
	upstreamCalls = [];
	jobStatus = "pending";
	modelFolderOverride = null;
	const comfy = new ComfyApiClient({ baseUrl: config.comfyBaseUrl, timeoutMs: 1000, fetchImpl: mockComfyFetch() });
	jobs = new RecordingJobService({ store, comfy, pollIntervalMs: 10 });
	app = createHubApp({
		config,
		store,
		comfy,
		jobs,
	});
});

afterEach(async () => {
	await app.close();
	store.close();
	await rm(root, { recursive: true, force: true });
});

describe("remote MCP over Streamable HTTP", () => {
	test("initializes, exposes exactly 20 tools, and uploads/lists/gets stored workflows", async () => {
		await initializeMcp();
		const listResponse = await app.fetch(rpcRequest("tools/list", {}, 2));
		const listPayload = await rpcPayload(listResponse);
		const tools = (listPayload.result as { tools: Array<{ name: string; description?: string }> }).tools;
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"asset_get", "asset_list", "asset_upload", "job_cancel", "job_get", "job_list", "job_submit", "job_wait",
			"knowledge_delete", "knowledge_get", "knowledge_list", "knowledge_set", "model_get", "model_list", "node_get", "node_list", "server_get", "workflow_get", "workflow_list", "workflow_upload",
		].sort());
		expect(tools).toHaveLength(20);
		expect(tools.find((tool) => tool.name === "workflow_upload")?.description).toContain("MCP cannot read a client-local file path");

		const uploadId = await stage(apiWorkflow, "workflow-api.json");
		const committed = toolValue(await callTool("workflow_upload", { upload_id: uploadId, name: "Test graph" }, 3));
		const workflowId = committed.id as string;
		expect(workflowId).toMatch(/^[a-f0-9]{64}$/);
		expect(committed.name).toBe("Test graph");

		const page = toolValue(await callTool("workflow_list", { limit: 10, offset: 0 }, 4));
		expect(page.total).toBe(1);
		expect((page.workflows as Array<{ id: string }>)[0]?.id).toBe(workflowId);

		const detail = toolValue(await callTool("workflow_get", { workflow_id: workflowId }, 5));
		expect(detail.metadata).toMatchObject({ id: workflowId, filename: "workflow-api.json" });
		expect(detail.workflow).toEqual({ "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "example.safetensors" } } });
		const card = toolValue(await callTool("knowledge_set", { title: "Tip", body: "Save the prompt" }, 6));
		const edited = toolValue(await callTool("knowledge_set", { id: card.id, title: "Tip updated", body: "Save the prompt carefully" }, 7));
		expect(edited).toMatchObject({ id: card.id, title: "Tip updated", body: "Save the prompt carefully" });
		expect(toolValue(await callTool("knowledge_get", { id: card.id }, 8))).toMatchObject({ title: "Tip updated" });
		expect((toolValue(await callTool("knowledge_list", {}, 9)).result as unknown[])).toHaveLength(1);
		expect(toolValue(await callTool("knowledge_delete", { id: card.id }, 10))).toEqual({ deleted: true });
		expect(upstreamCalls.some((call) => call.method === "POST" && new URL(call.url).pathname === "/prompt")).toBe(false);
	});

	test("serves compact node/model discovery, full details, and safe server status", async () => {
		await initializeMcp();
		const nodeList = toolValue(await callTool("node_list", { query: "sampler", limit: 1, offset: 0 }, 10));
		expect(nodeList.nodes).toEqual([expect.objectContaining({ node_id: "KSampler", category: "sampling" })]);
		expect(JSON.stringify(nodeList)).not.toContain("qwen_image_2.1_int8_convrot.safetensors");

		const node = toolValue(await callTool("node_get", { node_id: "KSampler" }, 11));
		expect(node).toMatchObject({ name: "KSampler", input: { required: { steps: ["INT", { default: 20 }] } } });
		const restNodeSearch = await app.fetch(new Request("http://127.0.0.1:3000/api/v1/comfy/nodes/search?q=sampler&limit=1"));
		expect((await restNodeSearch.json() as { nodes: unknown }).nodes).toEqual([expect.objectContaining({ node_id: "KSampler" })]);
		const restNodeDetail = await app.fetch(new Request("http://127.0.0.1:3000/api/v1/comfy/nodes/KSampler"));
		expect(await restNodeDetail.json()).toMatchObject({ name: "KSampler" });

		const models = toolValue(await callTool("model_list", { query: "qwen", limit: 10, offset: 0 }, 12));
		expect(models.pagination).toMatchObject({ total: 4, has_more: false });
		expect((models.models as Array<{ name: string }>).map((model) => model.name)).toContain("qwen_image_2.1_vae_bf16.safetensors");
		const restModelSearch = await app.fetch(new Request("http://127.0.0.1:3000/api/v1/comfy/models/search?q=qwen&limit=10"));
		expect((await restModelSearch.json() as { pagination: unknown }).pagination).toMatchObject({ total: 4 });

		const model = toolValue(await callTool("model_get", {
			folder: "diffusion_models",
			name: "qwen_image_2.1_int8_convrot.safetensors",
		}, 13));
		expect(model.installed).toBe(true);
		expect(model.loaders).toEqual([expect.objectContaining({ node_id: "UNETLoader", input_name: "unet_name" })]);

		const server = toolValue(await callTool("server_get", {}, 14));
		expect(server).toMatchObject({ version: { comfyui: "0.37.0" }, devices: [{ name: "Mock GPU", type: "cuda" }], queue: { running: 1, pending: 2 } });
		expect(JSON.stringify(server)).not.toContain("must-not-leak");

		expect(upstreamCalls.filter((call) => new URL(call.url).pathname === "/object_info")).toHaveLength(1);
		expect(upstreamCalls.filter((call) => /^\/models\//.test(new URL(call.url).pathname))).toHaveLength(3);
	});

	test("shares REST asset behavior and returns stable same-origin content URLs", async () => {
		await initializeMcp();
		const uploadId = await stage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "sample.png");
		const promoted = toolValue(await callTool("asset_upload", { upload_id: uploadId, kind: "image" }, 20));
		expect(promoted).toMatchObject({ status: "ready", kind: "image", workflow_value: expect.any(String) });
		const assetId = promoted.asset_id as string;
		const downloadUrl = promoted.download_url as string;
		expect(new URL(downloadUrl).origin).toBe("http://127.0.0.1:3000");
		expect(new URL(downloadUrl).pathname).toBe(`/api/v1/assets/${assetId}/content`);

		const listed = toolValue(await callTool("asset_list", { limit: 10, offset: 0 }, 21));
		expect((listed.assets as Array<{ asset_id: string }>)[0]?.asset_id).toBe(assetId);
		const detail = toolValue(await callTool("asset_get", { asset_id: assetId }, 22));
		expect(detail.download_url).toBe(downloadUrl);
		const forwarded = { "x-forwarded-proto": "https" };
		const secureDetail = toolValue(await callTool("asset_get", { asset_id: assetId }, 23, { headers: forwarded }));
		expect(secureDetail.download_url).toBe(`https://127.0.0.1:3000/api/v1/assets/${assetId}/content`);
		const secureList = toolValue(await callTool("asset_list", { limit: 10, offset: 0 }, 24, { headers: forwarded }));
		expect((secureList.assets as Array<{ download_url: string }>)[0]?.download_url).toBe(secureDetail.download_url);
		const content = await app.fetch(new Request(downloadUrl));
		expect(content.status).toBe(200);
		expect(new Uint8Array(await content.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
	});

	test("uses shared job semantics, caps waits, disables Bun timeout only for job_wait, and aborts polling only", async () => {
		await initializeMcp();
		const jobId = "11111111-1111-4111-8111-111111111111";
		const job = toolValue(await callTool("job_get", { job_id: jobId }, 30));
		expect(job).toMatchObject({ id: jobId, status: "pending" });

		const timeoutCalls: Array<{ request: Request; seconds: number }> = [];
		const wait = toolValue(await callTool("job_wait", { job_id: jobId, timeout_seconds: 0 }, 31, {
			server: { timeout: (request, seconds) => { timeoutCalls.push({ request, seconds }); } },
		}));
		expect(wait).toMatchObject({ id: jobId, status: "pending", wait_timed_out: true });
		expect(timeoutCalls[0]?.seconds).toBe(0);

		const invalid = await callTool("job_wait", { job_id: jobId, timeout_seconds: 301 }, 32);
		expect(invalid.result).toMatchObject({ isError: true });
		expect(upstreamCalls.some((call) => call.method === "POST" && ["/interrupt", "/queue"].includes(new URL(call.url).pathname))).toBe(false);

		const controller = new AbortController();
		const request = rpcRequest("tools/call", { name: "job_wait", arguments: { job_id: jobId, timeout_seconds: 300 } }, 33, { signal: controller.signal });
		const pending = app.fetch(request);
		await new Promise((resolve) => setTimeout(resolve, 30));
		controller.abort(new DOMException("client disconnected", "AbortError"));
		await pending.catch(() => undefined);
		await new Promise((resolve) => setTimeout(resolve, 25));
		const waitReads = upstreamCalls.filter((call) => new URL(call.url).pathname === `/api/jobs/${jobId}`);
		expect(waitReads.some((call) => call.signal?.aborted)).toBe(true);
		expect(upstreamCalls.some((call) => call.method === "POST" && ["/interrupt", "/queue"].includes(new URL(call.url).pathname))).toBe(false);
	});

	test("applies MCP list and wait defaults without waiting for the five-minute timeout", async () => {
		await initializeMcp();
		const jobId = "22222222-2222-4222-8222-222222222222";
		const list = toolValue(await callTool("job_list", {}, 34));
		expect(list.pagination).toMatchObject({ limit: 50, offset: 0 });

		jobStatus = "completed";
		const timeoutCalls: number[] = [];
		const result = toolValue(await callTool("job_wait", { job_id: jobId }, 35, {
			server: { timeout: (_request, seconds) => timeoutCalls.push(seconds) },
		}));
		expect(jobs.waitTimeouts).toEqual([300_000]);
		expect(result).toMatchObject({ id: jobId, status: "completed", wait_timed_out: false });
		expect(timeoutCalls).toEqual([0]);
	});

	test("accepts MCP requests with forwarded Host and Origin headers", async () => {
		const missingHost = await app.fetch(new Request("http://127.0.0.1:3000/mcp", {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 39, method: "initialize", params: {} }),
		}));
		expect(missingHost.status).not.toBe(403);

		const badHost = await app.fetch(rpcRequest("initialize", {}, 40, { headers: { host: "evil.example" } }));
		expect(badHost.status).not.toBe(403);

		const badOrigin = await app.fetch(rpcRequest("initialize", {}, 41, { headers: { origin: "http://evil.example" } }));
		expect(badOrigin.status).not.toBe(403);
	});
});
