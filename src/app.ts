import { randomUUID } from "node:crypto";
import { stat, unlink } from "node:fs/promises";
import type { HubConfig } from "./config.ts";
import { AssetService, assetResponse } from "./assets.ts";
import { ComfyApiClient } from "./comfy-client.ts";
import { ComfyDiscovery } from "./discovery.ts";
import { ComfyUpstreamError, HttpError } from "./errors.ts";
import { JobService } from "./jobs.ts";
import { JobProgressService, type JobProgressServiceOptions } from "./job-progress.ts";
import { createHubMcpHandler } from "./mcp.ts";
import { streamMultipartFile } from "./multipart.ts";
import { releaseReaderLock } from "./stream-utils.ts";
import { type AssetMetadata, HubStore } from "./storage.ts";

const JSON_BODY_LIMIT = 16 * 1024;

function jsonResponse(value: unknown, status = 200, headers?: Headers | Record<string, string> | [string, string][]): Response {
	const responseHeaders = new Headers(headers);
	responseHeaders.set("content-type", "application/json; charset=utf-8");
	responseHeaders.set("cache-control", "no-store");
	return new Response(JSON.stringify(value), { status, headers: responseHeaders });
}

function errorResponse(status: number, code: string, message: string, details?: unknown): Response {
	return jsonResponse({ error: { code, message, ...(details !== undefined ? { details } : {}) } }, status);
}

async function readJsonBody(request: Request): Promise<unknown> {
	if (!request.body) throw new HttpError(400, "missing_body", "Request body is required");
	const length = Number(request.headers.get("content-length"));
	if (Number.isFinite(length) && length > JSON_BODY_LIMIT) {
		throw new HttpError(413, "request_too_large", "JSON request body exceeds the limit");
	}
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > JSON_BODY_LIMIT) throw new HttpError(413, "request_too_large", "JSON request body exceeds the limit");
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel(error).catch(() => undefined);
		throw error;
	} finally {
		releaseReaderLock(reader);
	}
	try {
		const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new HttpError(400, "invalid_json", "Request body must be valid UTF-8 JSON");
	}
}

function parseMetadata(value: unknown): { uploadId: string; name?: string | null; description?: string | null } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new HttpError(400, "invalid_request", "Request body must be an object");
	}
	const body = value as Record<string, unknown>;
	for (const key of Object.keys(body)) {
		if (!["upload_id", "name", "description"].includes(key)) {
			throw new HttpError(400, "invalid_request", `Unknown field: ${key}`);
		}
	}
	if (typeof body.upload_id !== "string" || !/^[0-9a-f-]{36}$/.test(body.upload_id)) {
		throw new HttpError(400, "invalid_upload_id", "upload_id must be a UUID");
	}
	const name = parseOptionalText(body.name, "name", 200);
	const description = parseOptionalText(body.description, "description", 2000);
	return { uploadId: body.upload_id, ...(name !== undefined ? { name } : {}), ...(description !== undefined ? { description } : {}) };
}

function parseAssetUpload(value: unknown): { uploadId: string; kind: "image" | "mask"; originalAssetId: string | null } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new HttpError(400, "invalid_request", "Request body must be an object");
	}
	const body = value as Record<string, unknown>;
	for (const key of Object.keys(body)) {
		if (!["upload_id", "kind", "original_asset_id"].includes(key)) throw new HttpError(400, "invalid_request", `Unknown field: ${key}`);
	}
	if (typeof body.upload_id !== "string" || !/^[0-9a-f-]{36}$/.test(body.upload_id)) {
		throw new HttpError(400, "invalid_upload_id", "upload_id must be a UUID");
	}
	if (body.kind !== "image" && body.kind !== "mask") throw new HttpError(400, "invalid_asset_kind", "kind must be image or mask");
	let originalAssetId: string | null = null;
	if (body.original_asset_id !== undefined) {
		if (typeof body.original_asset_id !== "string"
			|| !(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.original_asset_id)
				|| /^out_[a-f0-9]{64}$/.test(body.original_asset_id))) {
			throw new HttpError(400, "invalid_original_asset", "original_asset_id must identify an image asset");
		}
		originalAssetId = body.original_asset_id;
	}
	if (body.kind === "mask" && originalAssetId === null) {
		throw new HttpError(400, "original_asset_required", "original_asset_id is required for a mask");
	}
	if (body.kind === "image" && originalAssetId !== null) {
		throw new HttpError(400, "invalid_request", "original_asset_id is only valid for masks");
	}
	return { uploadId: body.upload_id, kind: body.kind, originalAssetId };
}

function parseJobSubmission(value: unknown): { workflowId: string; metadata: Record<string, unknown>; clientRequestId: string | null } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new HttpError(400, "invalid_request", "Request body must be an object");
	}
	const body = value as Record<string, unknown>;
	for (const key of Object.keys(body)) {
		if (!["workflow_id", "metadata", "client_request_id"].includes(key)) {
			throw new HttpError(400, "invalid_request", `Unknown field: ${key}`);
		}
	}
	if (typeof body.workflow_id !== "string" || !/^[a-f0-9]{64}$/.test(body.workflow_id)) {
		throw new HttpError(400, "invalid_workflow_id", "workflow_id must be a stored workflow SHA-256 id");
	}
	let metadata: Record<string, unknown> = {};
	if (body.metadata !== undefined) {
		if (!body.metadata || typeof body.metadata !== "object" || Array.isArray(body.metadata)) {
			throw new HttpError(400, "invalid_metadata", "metadata must be a JSON object");
		}
		metadata = body.metadata as Record<string, unknown>;
		if (JSON.stringify(metadata).length > JSON_BODY_LIMIT - 1024) {
			throw new HttpError(413, "metadata_too_large", "metadata exceeds the request size limit");
		}
	}
	let clientRequestId: string | null = null;
	if (body.client_request_id !== undefined) {
		if (typeof body.client_request_id !== "string" || body.client_request_id.length < 1 || body.client_request_id.length > 256 || /[\u0000-\u001f\u007f]/.test(body.client_request_id)) {
			throw new HttpError(400, "invalid_client_request_id", "client_request_id must be printable text up to 256 characters");
		}
		clientRequestId = body.client_request_id.trim();
		if (!clientRequestId) throw new HttpError(400, "invalid_client_request_id", "client_request_id cannot be empty");
	}
	return { workflowId: body.workflow_id, metadata, clientRequestId };
}

function parseKnowledge(value: unknown): { id?: string; title: string; body: string } {
	if (!isRecord(value)) throw new HttpError(400, "invalid_request", "Request body must be an object");
	for (const key of Object.keys(value)) if (!["id", "title", "body"].includes(key)) throw new HttpError(400, "invalid_request", `Unknown field: ${key}`);
	if (value.id !== undefined && (typeof value.id !== "string" || !/^[0-9a-f-]{36}$/.test(value.id))) throw new HttpError(400, "invalid_knowledge_id", "id must be a UUID");
	if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 200) throw new HttpError(400, "invalid_knowledge_title", "title must be non-empty text up to 200 characters");
	if (typeof value.body !== "string" || value.body.length > 10_000) throw new HttpError(400, "invalid_knowledge_body", "body must be text up to 10000 characters");
	return { ...(typeof value.id === "string" ? { id: value.id } : {}), title: value.title.trim(), body: value.body };
}

function parseOptionalText(value: unknown, field: string, maxLength: number): string | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value !== "string" || value.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
		throw new HttpError(400, "invalid_request", `${field} must be text up to ${maxLength} characters`);
	}
	return value.trim() || null;
}

function parsePositiveQuery(value: string | null, fallback: number, max: number, field: string): number {
	if (value === null) return fallback;
	if (!/^\d+$/.test(value)) throw new HttpError(400, "invalid_query", `${field} must be a positive integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
		throw new HttpError(400, "invalid_query", `${field} must be between 1 and ${max}`);
	}
	return parsed;
}

function parseOffsetQuery(value: string | null, field = "offset"): number {
	const raw = value ?? "0";
	if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
		throw new HttpError(400, "invalid_query", `${field} must be a non-negative integer`);
	}
	return Number(raw);
}

function parseWaitTimeout(value: string | null): number {
	if (value === null) return 300_000;
	if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
		throw new HttpError(400, "invalid_query", "timeout must be a number of seconds between 0 and 300");
	}
	const seconds = Number(value);
	if (!Number.isFinite(seconds) || seconds < 0 || seconds > 300) {
		throw new HttpError(400, "invalid_query", "timeout must be a number of seconds between 0 and 300");
	}
	return seconds * 1000;
}

function decodePathSegment(value: string): string {
	try {
		const decoded = decodeURIComponent(value);
		if (!decoded || decoded.includes("/") || decoded.includes("\\") || decoded === "." || decoded === "..") {
			throw new Error("invalid path segment");
		}
		return decoded;
	} catch {
		throw new HttpError(400, "invalid_path", "Invalid URL path segment");
	}
}

function decodeComfyId(value: string): string {
	const id = decodePathSegment(value);
	if (id.length > 512 || /[\u0000-\u001f\u007f]/.test(id)) {
		throw new HttpError(400, "invalid_path", "Invalid ComfyUI job id");
	}
	return id;
}

function decodeJobId(value: string): string {
	const id = decodePathSegment(value);
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
		throw new HttpError(400, "invalid_job_id", "job id must be a canonical lowercase UUID");
	}
	return id;
}

async function isMcpJobWaitRequest(request: Request): Promise<boolean> {
	if (request.method !== "POST" || !request.body) return false;
	const length = Number(request.headers.get("content-length"));
	if (Number.isFinite(length) && length > 64 * 1024) return false;
	const reader = request.clone().body?.getReader();
	if (!reader) return false;
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 64 * 1024) {
				await reader.cancel("MCP body inspection limit reached").catch(() => undefined);
				return false;
			}
			chunks.push(value);
		}
	} catch {
		return false;
	} finally {
		releaseReaderLock(reader);
	}
	try {
		const body = JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size).toString("utf8")) as unknown;
		const requests = Array.isArray(body) ? body : [body];
		return requests.some((item) => isRecord(item)
			&& item.method === "tools/call"
			&& isRecord(item.params)
			&& item.params.name === "job_wait");
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface HubAppOptions {
	config: HubConfig;
	store: HubStore;
	comfy: ComfyApiClient;
	jobs?: JobService;
	jobProgressOptions?: Partial<Omit<JobProgressServiceOptions, "comfy" | "jobs" | "clientId">>;
}

export interface HubRequestServer {
	timeout(request: Request, seconds: number): void;
}

export function createHubApp({ config, store, comfy, jobs: suppliedJobs, jobProgressOptions }: HubAppOptions): {
	fetch: (request: Request, server?: HubRequestServer) => Promise<Response>;
	close: () => Promise<void>;
} {
	const assets = new AssetService({
		store,
		comfy,
		maxAssetBytes: config.maxAssetBytes,
		maxOutputBytes: config.maxOutputBytes,
		maxConcurrentArchives: config.maxConcurrentArchives,
		transferIdleTimeoutMs: config.transferIdleTimeoutMs,
	});
	const jobs = suppliedJobs ?? new JobService({ store, comfy, assets });
	jobs.attachAssetService(assets);
	const jobProgress = new JobProgressService({ comfy, jobs, clientId: store.clientId, ...jobProgressOptions });
	assets.start();
	const discovery = new ComfyDiscovery(comfy);
	const mcp = createHubMcpHandler({ config, store, comfy, assets, jobs, discovery });
	return {
		close: async () => {
			jobProgress.close();
			await Promise.all([assets.close(), mcp.close()]);
		},
		async fetch(request: Request, server?: HubRequestServer): Promise<Response> {
			try {
				const url = new URL(request.url);
				const path = url.pathname;
				if (path === "/mcp") {
					if (server && await isMcpJobWaitRequest(request)) server.timeout(request, 0);
					return await mcp.fetch(request);
				}

				if (request.method === "GET" && path === "/health") return jsonResponse({ ok: true });
				if (request.method === "GET" && path === "/api/v1/status") {
					return jsonResponse({
						ok: true,
						workflow_count: store.workflowCount(),
						comfy_configured: true,
					});
				}

				if (path === "/api/v1/knowledge" && request.method === "GET") return jsonResponse({ entries: store.listKnowledge() });
				if (path === "/api/v1/knowledge" && request.method === "POST") {
					const input = parseKnowledge(await readJsonBody(request));
					return jsonResponse(store.setKnowledge(input), input.id ? 200 : 201);
				}
				const knowledgeMatch = /^\/api\/v1\/knowledge\/([^/]+)$/.exec(path);
				if (knowledgeMatch && request.method === "GET") {
					const entry = store.getKnowledge(decodePathSegment(knowledgeMatch[1]!));
					if (!entry) throw new HttpError(404, "knowledge_not_found", "Knowledge entry not found");
					return jsonResponse(entry);
				}
				if (knowledgeMatch && request.method === "DELETE") {
					store.deleteKnowledge(decodePathSegment(knowledgeMatch[1]!));
					return jsonResponse({ deleted: true });
				}

				if (request.method === "GET" && path === "/api/v1/events") {
					server?.timeout(request, 0);
					jobProgress.assertSubscriberCapacity();
					jobProgress.start();
					await jobProgress.refreshNow();
					if (request.signal.aborted) return new Response(null, { status: 499 });
					jobProgress.assertSubscriberCapacity();
					return jobProgress.createSseResponse(request.signal);
				}

				if (request.method === "POST" && path === "/api/v1/uploads") {
					const uploadId = randomUUID();
					const stagedPath = store.stagingPath(uploadId);
					store.beginStaging(uploadId);
					try {
						const file = await streamMultipartFile(request, stagedPath, config.maxUploadBytes);
						const staged = await store.addStagedUpload({ uploadId, ...file });
						return jsonResponse({
							upload_id: staged.uploadId,
							sha256: staged.sha256,
							bytes: staged.bytes,
							filename: staged.filename,
							expires_at: new Date(staged.expiresAt).toISOString(),
						}, 201);
					} catch (error) {
						await unlink(stagedPath).catch(() => undefined);
						throw error;
					} finally {
						store.finishStaging(uploadId);
					}
				}

				if (request.method === "POST" && path === "/api/v1/assets") {
					const input = parseAssetUpload(await readJsonBody(request));
					const result = await assets.upload(input, request.signal);
					return jsonResponse(await assetResponse(result.asset, request, store), result.statusCode);
				}

				if (request.method === "GET" && path === "/api/v1/assets") {
					const limit = parsePositiveQuery(url.searchParams.get("limit"), 50, 100, "limit");
					const offset = parseOffsetQuery(url.searchParams.get("offset"));
					const jobIdValue = url.searchParams.get("job_id");
					const jobId = jobIdValue === null ? undefined : decodeJobId(jobIdValue);
					const page = store.listAssets({ limit, offset, ...(jobId ? { jobId } : {}) });
					return jsonResponse({
						assets: await Promise.all(page.assets.map((asset) => assetResponse(asset, request, store))),
						pagination: { limit, offset, total: page.total, has_more: offset + page.assets.length < page.total },
					});
				}

				const assetMatch = /^\/api\/v1\/assets\/([^/]+)(?:\/(content))?$/.exec(path);
				if (request.method === "GET" && assetMatch) {
					const id = decodePathSegment(assetMatch[1]!);
					const asset = store.getAsset(id);
					if (!asset) throw new HttpError(404, "asset_not_found", "Asset not found");
					if (assetMatch[2] === "content") return await streamAssetContent(request, asset, store);
					return jsonResponse(await assetResponse(asset, request, store));
				}

				if (request.method === "POST" && path === "/api/v1/workflows") {
					const data = parseMetadata(await readJsonBody(request));
					const workflow = await store.workflowUpload(data.uploadId, data, config.maxWorkflowBytes);
					return jsonResponse(workflow, 201, { etag: `"${workflow.sha256}"` });
				}

				if (request.method === "POST" && path === "/api/v1/jobs") {
					const input = parseJobSubmission(await readJsonBody(request));
					const result = await jobs.submit(input, request.signal);
					const progressStatus = result.status === "submitted" ? "pending" : result.status === "cancelled" ? "cancelled" : "submission_unknown";
					jobProgress.noteSubmission(result.job_id, result.workflow_id, progressStatus);
					return jsonResponse(result, result.reused ? 200 : result.status === "submission_unknown" ? 202 : 201);
				}

				if (request.method === "GET" && path === "/api/v1/jobs") {
					const limit = parsePositiveQuery(url.searchParams.get("limit"), 50, 100, "limit");
					const offset = parseOffsetQuery(url.searchParams.get("offset"));
					return jsonResponse(await jobs.list({ limit, offset, signal: request.signal }));
				}

				const hubJobMatch = /^\/api\/v1\/jobs\/([^/]+)(?:\/(wait|cancel))?$/.exec(path);
				if (hubJobMatch) {
					const jobId = decodeJobId(hubJobMatch[1]!);
					const action = hubJobMatch[2];
					if (!action && request.method === "GET") return jsonResponse(await jobs.get(jobId, request.signal));
					if (action === "wait" && request.method === "GET") {
						// Bun's default idleTimeout includes time spent awaiting a handler.
						// Disable it only for this wait request; the caller's abort signal
						// still stops polling without touching the upstream job.
						server?.timeout(request, 0);
						const timeoutMs = parseWaitTimeout(url.searchParams.get("timeout"));
						return jsonResponse(await jobs.wait(jobId, timeoutMs, request.signal));
					}
					if (action === "cancel" && request.method === "POST") {
						const result = await jobs.cancel(jobId, request.signal);
						if (result.cancelled === true) jobProgress.noteCancellation(jobId);
						return jsonResponse(result, result.outcome === "unknown" ? 202 : 200);
					}
				}

				if (request.method === "GET" && path === "/api/v1/workflows") {
					const limit = parsePositiveQuery(url.searchParams.get("limit"), 50, 100, "limit");
					const offsetRaw = url.searchParams.get("offset") ?? "0";
					if (!/^\d+$/.test(offsetRaw) || !Number.isSafeInteger(Number(offsetRaw))) {
						throw new HttpError(400, "invalid_query", "offset must be a non-negative integer");
					}
					const offset = Number(offsetRaw);
					return jsonResponse({ workflows: store.listWorkflows(limit, offset), limit, offset, total: store.workflowCount() });
				}

				const workflowMatch = /^\/api\/v1\/workflows\/([^/]+)(?:\/(content))?$/.exec(path);
				if (request.method === "GET" && workflowMatch) {
					const id = decodePathSegment(workflowMatch[1]!);
					const metadata = store.getWorkflow(id);
					if (!metadata) throw new HttpError(404, "workflow_not_found", "Workflow not found");
					const contentPath = store.workflowContentPath(id);
					if (!contentPath) throw new HttpError(404, "workflow_not_found", "Workflow not found");
					if (workflowMatch[2] === "content") {
						return new Response(Bun.file(contentPath), {
							headers: {
								"content-type": "application/json; charset=utf-8",
								"cache-control": "public, max-age=31536000, immutable",
								etag: `"${metadata.sha256}"`,
								"x-workflow-id": metadata.id,
							},
						});
					}
					const workflow = await Bun.file(contentPath).json();
					return jsonResponse({ metadata, workflow }, 200, { etag: `"${metadata.sha256}"` });
				}

				if (request.method === "GET" && path === "/api/v1/comfy/nodes/search") {
					const limit = parsePositiveQuery(url.searchParams.get("limit"), 50, 100, "limit");
					const offset = parseOffsetQuery(url.searchParams.get("offset"));
					return jsonResponse(await discovery.listNodes({ limit, offset, query: url.searchParams.get("q") ?? "" }));
				}
				const nodeDetailMatch = /^\/api\/v1\/comfy\/nodes\/([^/]+)$/.exec(path);
				if (request.method === "GET" && nodeDetailMatch) {
					return jsonResponse(await discovery.getNode(decodePathSegment(nodeDetailMatch[1]!)));
				}
				if (request.method === "GET" && path === "/api/v1/comfy/nodes") return jsonResponse(await comfy.getNodes());
				if (request.method === "GET" && path === "/api/v1/comfy/models/search") {
					const limit = parsePositiveQuery(url.searchParams.get("limit"), 50, 100, "limit");
					const offset = parseOffsetQuery(url.searchParams.get("offset"));
					const folder = url.searchParams.get("folder") ?? undefined;
					return jsonResponse(await discovery.listModels({
						limit,
						offset,
						query: url.searchParams.get("q") ?? "",
						...(folder ? { folder } : {}),
					}));
				}
				const modelDetailMatch = /^\/api\/v1\/comfy\/models\/([^/]+)\/([^/]+)$/.exec(path);
				if (request.method === "GET" && modelDetailMatch) {
					return jsonResponse(await discovery.getModel(
						decodePathSegment(modelDetailMatch[1]!),
						decodePathSegment(modelDetailMatch[2]!),
					));
				}
				if (request.method === "GET" && path === "/api/v1/comfy/models") return jsonResponse(await comfy.getModels());
				const modelMatch = /^\/api\/v1\/comfy\/models\/([^/]+)$/.exec(path);
				if (request.method === "GET" && modelMatch) {
					const folder = decodePathSegment(modelMatch[1]!);
					if (!/^[A-Za-z0-9_-]{1,128}$/.test(folder)) throw new HttpError(400, "invalid_path", "Invalid ComfyUI model folder");
					return jsonResponse(await comfy.getModelFolder(folder));
				}
				if (request.method === "GET" && path === "/api/v1/comfy/status") return jsonResponse(await comfy.getSystemStats());
				if (request.method === "GET" && path === "/api/v1/comfy/queue") return jsonResponse(await comfy.getQueue());
				if (request.method === "GET" && path === "/api/v1/comfy/system") return jsonResponse(await comfy.getSystemStats());
				if (request.method === "GET" && path === "/api/v1/comfy/jobs") {
					return jsonResponse(await comfy.getJobs());
				}
				const jobMatch = /^\/api\/v1\/comfy\/jobs\/([^/]+)$/.exec(path);
				if (request.method === "GET" && jobMatch) return jsonResponse(await comfy.getJob(decodeComfyId(jobMatch[1]!)));
				const historyMatch = /^\/api\/v1\/comfy\/history\/([^/]+)$/.exec(path);
				if (request.method === "GET" && historyMatch) return jsonResponse(await comfy.getHistory(decodeComfyId(historyMatch[1]!)));

				throw new HttpError(404, "not_found", "Route not found");
			} catch (error) {
				if (request.signal.aborted) return new Response(null, { status: 499 });
				if (error instanceof HttpError) return errorResponse(error.status, error.code, error.message, error.details);
				if (error instanceof ComfyUpstreamError) {
					const status = error.status === 504 ? 504 : 502;
					return errorResponse(status, "comfy_upstream_error", error.message);
				}
				console.error("Hub request failed:", error);
				return errorResponse(500, "internal_error", "Hub request failed");
			}
		},
	};
}

async function streamAssetContent(request: Request, asset: AssetMetadata, store: HubStore): Promise<Response> {
	const path = store.assetContentPath(asset);
	if (!path) throw new HttpError(404, "asset_content_not_found", "Asset content is not available");
	let info;
	try {
		info = await stat(path);
	} catch {
		throw new HttpError(404, "asset_content_not_found", "Asset content is not available");
	}
	if (!info.isFile() || (asset.origin === "output" && (asset.status !== "ready" || info.size !== asset.bytes))) {
		throw new HttpError(404, "asset_content_not_ready", "Archived output content is not ready");
	}
	const size = info.size;
	const rangeHeader = request.headers.get("range");
	const range = rangeHeader === null ? null : parseByteRange(rangeHeader, size);
	if (rangeHeader !== null && range === null) {
		return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}`, "accept-ranges": "bytes", "cache-control": "private, no-store" } });
	}
	const start = range?.start ?? 0;
	const end = range?.end ?? Math.max(0, size - 1);
	const length = size === 0 ? 0 : end - start + 1;
	const headers = new Headers({
		"content-type": safeContentType(asset.contentType),
		"content-length": String(length),
		"content-disposition": `attachment; filename="asset-${asset.id}${safeStoredExtension(asset.storageName)}"`,
		"x-content-type-options": "nosniff",
		"accept-ranges": "bytes",
		"cache-control": "private, no-store",
	});
	if (range) headers.set("content-range", `bytes ${start}-${end}/${size}`);
	const file = Bun.file(path);
	const body = size === 0 ? new Uint8Array() : file.slice(start, end + 1);
	return new Response(body, { status: range ? 206 : 200, headers });
}

function parseByteRange(value: string, size: number): { start: number; end: number } | null {
	const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
	if (!match || (!match[1] && !match[2]) || size <= 0) return null;
	let start: number;
	let end: number;
	if (!match[1]) {
		const suffixLength = Number(match[2]);
		if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
		start = Math.max(0, size - suffixLength);
		end = size - 1;
	} else {
		start = Number(match[1]);
		end = match[2] ? Number(match[2]) : size - 1;
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return null;
		end = Math.min(end, size - 1);
	}
	return { start, end };
}

function safeContentType(value: string | null): string {
	return value && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value) ? value : "application/octet-stream";
}

function safeStoredExtension(storageName: string | null): string {
	const extension = storageName?.match(/(\.[a-z0-9]{1,12})$/i)?.[1] ?? "";
	return extension;
}
