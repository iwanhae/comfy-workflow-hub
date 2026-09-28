import {
	createMcpHandler,
	McpServer,
	type CallToolResult,
	type McpRequestContext,
	type ServerContext,
	type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import type { HubConfig } from "./config.ts";
import type { ComfyApiClient } from "./comfy-client.ts";
import { ComfyUpstreamError, HttpError } from "./errors.ts";
import type { ComfyDiscovery } from "./discovery.ts";
import { assetResponse, type AssetService } from "./assets.ts";
import type { JobService } from "./jobs.ts";
import type { HubStore } from "./storage.ts";

const SERVER_INFO = { name: "comfy-workflow-hub", version: "1.0.0" };
const PAGE_LIMIT = z.number().int().min(1).max(100).default(50);
const PAGE_OFFSET = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0);
const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const JOB_ID = UUID;
const WORKFLOW_ID = z.string().regex(/^[a-f0-9]{64}$/);
const ASSET_ID = z.union([UUID, z.string().regex(/^out_[a-f0-9]{64}$/)]);
const OPTIONAL_NAME = optionalText(200);
const OPTIONAL_DESCRIPTION = optionalText(2000);
const CLIENT_REQUEST_ID = z.string().min(1).max(256)
	.refine((value) => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value), "client_request_id must be printable text")
	.transform((value) => value.trim());
const JOB_METADATA = z.record(z.string(), z.unknown())
	.refine((value) => JSON.stringify(value).length <= 15 * 1024, "metadata exceeds the request size limit");

export interface HubMcpOptions {
	config: Pick<HubConfig, "maxWorkflowBytes">;
	store: HubStore;
	comfy: ComfyApiClient;
	assets: AssetService;
	jobs: JobService;
	discovery: ComfyDiscovery;
}

export function createHubMcpHandler(options: HubMcpOptions) {
	return createMcpHandler((context) => createRequestServer(context, options), { maxRequestBodySize: 64 * 1024 });
}

function createRequestServer(context: McpRequestContext, options: HubMcpOptions): McpServer {
	const server = new McpServer(SERVER_INFO);
	const request = context.requestInfo;
	const { assets, comfy, discovery, jobs, store } = options;

	registerJsonTool(server, "node_list", "Search and page a compact list of ComfyUI node schemas from the live /object_info catalog.", z.object({
		query: z.string().max(200).optional(),
		limit: PAGE_LIMIT,
		offset: PAGE_OFFSET,
	}), (args) => discovery.listNodes(args));

	registerJsonTool(server, "node_get", "Return the full live ComfyUI /object_info schema for one exact node class id.", z.object({
		node_id: z.string().min(1).max(256),
	}), (args) => discovery.getNode(args.node_id));

	registerJsonTool(server, "model_list", "Search and page installed ComfyUI models from /models and /models/{folder}. Results are compact; set folder to limit the lookup to one installed folder.", z.object({
		folder: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
		query: z.string().max(300).optional(),
		limit: PAGE_LIMIT,
		offset: PAGE_OFFSET,
	}), (args) => discovery.listModels(args));

	registerJsonTool(server, "model_get", "Verify an exact installed model file and return any live loader choices/schema that include it.", z.object({
		folder: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
		name: z.string().min(1).max(1024),
	}), (args) => discovery.getModel(args.folder, args.name));

	registerJsonTool(server, "knowledge_list", "List saved knowledge board cards.", z.object({}), () => store.listKnowledge());
	registerJsonTool(server, "knowledge_get", "Get one saved knowledge card by id.", z.object({ id: UUID }), (args) => {
		const entry = store.getKnowledge(args.id);
		if (!entry) throw new HttpError(404, "knowledge_not_found", "Knowledge entry not found");
		return entry;
	});
	registerJsonTool(server, "knowledge_set", "Create a knowledge card when id is omitted, or update the existing card when id is supplied.", z.object({
		id: UUID.optional(), title: z.string().trim().min(1).max(200), body: z.string().max(10_000),
	}), (args) => store.setKnowledge(args));
	registerJsonTool(server, "knowledge_delete", "Delete one saved knowledge card by id.", z.object({ id: UUID }), (args) => { store.deleteKnowledge(args.id); return { deleted: true }; });

	registerJsonTool(server, "workflow_upload", "Commit a staged ComfyUI API-format workflow. First upload the bytes out-of-band to POST /api/v1/uploads (multipart field `file`) and pass its returned upload_id here. MCP cannot read a client-local file path; this tool never accepts raw workflow JSON.", z.object({
		upload_id: UUID,
		name: OPTIONAL_NAME,
		description: OPTIONAL_DESCRIPTION,
	}), async (args) => store.workflowUpload(args.upload_id, {
		...(args.name !== undefined ? { name: args.name } : {}),
		...(args.description !== undefined ? { description: args.description } : {}),
	}, options.config.maxWorkflowBytes));

	registerJsonTool(server, "workflow_list", "Return a paginated list of immutable workflows already stored by this hub.", z.object({
		limit: PAGE_LIMIT,
		offset: PAGE_OFFSET,
	}), (args) => ({
		workflows: store.listWorkflows(args.limit, args.offset),
		limit: args.limit,
		offset: args.offset,
		total: store.workflowCount(),
	}));

	registerJsonTool(server, "workflow_get", "Return the metadata and parsed API-format graph for an immutable stored workflow.", z.object({
		workflow_id: WORKFLOW_ID,
	}), async (args) => {
		const { metadata, workflow } = await store.readWorkflowContent(args.workflow_id);
		return { metadata, workflow };
	});

	registerJsonTool(server, "job_submit", "Submit a stored workflow by workflow_id. Inline workflow JSON is not accepted. A client_request_id makes retries idempotent.", z.object({
		workflow_id: WORKFLOW_ID,
		metadata: JOB_METADATA.default({}),
		client_request_id: CLIENT_REQUEST_ID.optional(),
	}), (args) => jobs.submit({
		workflowId: args.workflow_id,
		metadata: args.metadata,
		clientRequestId: args.client_request_id ?? null,
	}));

	registerJsonTool(server, "job_list", "Return a paginated merged list of ComfyUI jobs and this hub's submission metadata.", z.object({
		limit: PAGE_LIMIT,
		offset: PAGE_OFFSET,
	}), (args) => jobs.list(args));

	registerJsonTool(server, "job_get", "Read the current status and outputs for one ComfyUI job, including any hub workflow mapping.", z.object({
		job_id: JOB_ID,
	}), (args) => jobs.get(args.job_id));

	registerJsonTool(server, "job_wait", "Wait up to timeout_seconds (0–300, default 300) for a job to become terminal. On timeout return the latest status with wait_timed_out=true. Client cancellation aborts this tool's polling only; it never interrupts or cancels the ComfyUI job.", z.object({
		job_id: JOB_ID,
		timeout_seconds: z.number().min(0).max(300).default(300),
	}), (args, ctx) => jobs.wait(args.job_id, args.timeout_seconds * 1000, ctx.mcpReq.signal));

	registerJsonTool(server, "job_cancel", "Remove a job only if it is still pending. Running ComfyUI jobs are never interrupted.", z.object({
		job_id: JOB_ID,
	}), (args) => jobs.cancel(args.job_id));

	registerJsonTool(server, "asset_upload", "Promote a staged image or mask as a ComfyUI input asset. First upload bytes out-of-band to POST /api/v1/uploads (multipart field `file`) and pass its returned upload_id here. MCP cannot read a client-local file path. Masks require original_asset_id.", z.object({
		upload_id: UUID,
		kind: z.enum(["image", "mask"]),
		original_asset_id: ASSET_ID.optional(),
	}), async (args) => {
		const result = await assets.upload({
			uploadId: args.upload_id,
			kind: args.kind,
			originalAssetId: args.original_asset_id ?? null,
		});
		if (!request) throw new HttpError(500, "request_context_missing", "MCP request context is unavailable");
		return {
			...(await assetResponse(result.asset, request, store)),
			upload_status_code: result.statusCode,
			reused: result.reused,
		};
	});

	registerJsonTool(server, "asset_list", "Return a paginated asset list, optionally filtered to one job_id; each available asset includes the shared same-origin download_url.", z.object({
		limit: PAGE_LIMIT,
		offset: PAGE_OFFSET,
		job_id: JOB_ID.optional(),
	}), async (args) => {
		const page = store.listAssets({
			limit: args.limit,
			offset: args.offset,
			...(args.job_id ? { jobId: args.job_id } : {}),
		});
		if (!request) throw new HttpError(500, "request_context_missing", "MCP request context is unavailable");
		return {
			assets: await Promise.all(page.assets.map((asset) => assetResponse(asset, request, store))),
			pagination: {
				limit: args.limit,
				offset: args.offset,
				total: page.total,
				has_more: args.offset + page.assets.length < page.total,
			},
		};
	});

	registerJsonTool(server, "asset_get", "Return asset metadata and a stable same-origin download URL when local bytes are available.", z.object({
		asset_id: ASSET_ID,
	}), async (args) => {
		const asset = store.getAsset(args.asset_id);
		if (!asset) throw new HttpError(404, "asset_not_found", "Asset not found");
		if (!request) throw new HttpError(500, "request_context_missing", "MCP request context is unavailable");
		return assetResponse(asset, request, store);
	});

	registerJsonTool(server, "server_get", "Return a safe ComfyUI version/device/queue summary. System argv and other raw process details are intentionally omitted.", z.object({}), async () => {
		const [statsValue, queueValue] = await Promise.all([
			comfy.getSystemStats(),
			comfy.getQueue(),
		]);
		return serverSummary(statsValue, queueValue);
	});

	return server;
}

function registerJsonTool<Schema extends z.ZodType>(
	server: McpServer,
	name: string,
	description: string,
	inputSchema: Schema,
	handler: (args: z.output<Schema>, context: ServerContext) => unknown | Promise<unknown>,
): void {
	const callback = async (rawArgs: unknown, context: ServerContext): Promise<CallToolResult> => {
		try {
			const value = await handler(rawArgs as z.output<Schema>, context);
			const structuredContent = isRecord(value) ? value : { result: value };
			return {
				content: [{ type: "text", text: JSON.stringify(value) }],
				structuredContent,
			};
		} catch (error) {
			if (name === "job_wait" && context.mcpReq.signal.aborted) throw context.mcpReq.signal.reason ?? error;
			const payload = toolError(error);
			return {
				content: [{ type: "text", text: JSON.stringify({ error: payload }) }],
				structuredContent: { error: payload },
				isError: true,
			};
		}
	};
	server.registerTool(name, { description, inputSchema: inputSchema as StandardSchemaWithJSON }, callback);
}

function toolError(error: unknown): { code: string; message: string; details?: unknown } {
	if (error instanceof HttpError) {
		return {
			code: error.code,
			message: error.message,
			...(error.details !== undefined ? { details: error.details } : {}),
		};
	}
	if (error instanceof ComfyUpstreamError) {
		return { code: "comfy_upstream_error", message: error.message, details: { upstream_status: error.status } };
	}
	return { code: "internal_error", message: "Hub request failed" };
}

function serverSummary(statsValue: unknown, queueValue: unknown): Record<string, unknown> {
	const stats = isRecord(statsValue) ? statsValue : {};
	const system = isRecord(stats.system) ? stats.system : {};
	const devices = Array.isArray(stats.devices) ? stats.devices : [];
	const queue = isRecord(queueValue) ? queueValue : {};
	const running = Array.isArray(queue.queue_running) ? queue.queue_running : [];
	const pending = Array.isArray(queue.queue_pending) ? queue.queue_pending : [];
	return {
		version: {
			comfyui: stringValue(system.comfyui_version),
			python: stringValue(system.python_version),
			pytorch: stringValue(system.pytorch_version),
		},
		devices: devices.filter(isRecord).map((device) => ({
			...(stringValue(device.name) ? { name: device.name } : {}),
			...(stringValue(device.type) ? { type: device.type } : {}),
			...(numberValue(device.index) !== null ? { index: device.index } : {}),
			...(numberValue(device.vram_total) !== null ? { vram_total: device.vram_total } : {}),
			...(numberValue(device.vram_free) !== null ? { vram_free: device.vram_free } : {}),
		})),
		queue: { running: running.length, pending: pending.length },
	};
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalText(maxLength: number) {
	return z.string()
		.max(maxLength)
		.refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), "Text contains unsupported control characters")
		.nullable()
		.optional()
		.transform((value) => typeof value === "string" ? value.trim() || null : value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
