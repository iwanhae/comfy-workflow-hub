import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { HubConfig } from "./config.ts";
import { isAllowedRequestHost } from "./config.ts";
import { ComfyApiClient } from "./comfy-client.ts";
import { ComfyUpstreamError, HttpError } from "./errors.ts";
import { streamMultipartFile } from "./multipart.ts";
import { HubStore } from "./storage.ts";

const JSON_BODY_LIMIT = 16 * 1024;

function jsonResponse(value: unknown, status = 200, headers?: Headers | Record<string, string> | [string, string][]): Response {
	const responseHeaders = new Headers(headers);
	responseHeaders.set("content-type", "application/json; charset=utf-8");
	responseHeaders.set("cache-control", "no-store");
	return new Response(JSON.stringify(value), { status, headers: responseHeaders });
}

function errorResponse(status: number, code: string, message: string): Response {
	return jsonResponse({ error: { code, message } }, status);
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
		reader.releaseLock();
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

function guardRequest(request: Request, allowLan: boolean, isMutation: boolean): void {
	const url = new URL(request.url);
	if (!isAllowedRequestHost(url.hostname, allowLan)) {
		throw new HttpError(403, "host_not_allowed", "Request Host must be loopback or an explicitly enabled private-LAN address");
	}
	if (isMutation) {
		const origin = request.headers.get("origin");
		if (origin) {
			try {
				if (new URL(origin).origin !== url.origin) throw new Error("cross-origin");
			} catch {
				throw new HttpError(403, "origin_not_allowed", "Cross-origin state-changing requests are not allowed");
			}
		}
	}
}

export interface HubAppOptions {
	config: HubConfig;
	store: HubStore;
	comfy: ComfyApiClient;
}

export function createHubApp({ config, store, comfy }: HubAppOptions): { fetch: (request: Request) => Promise<Response> } {
	return {
		async fetch(request: Request): Promise<Response> {
			try {
				const url = new URL(request.url);
				const path = url.pathname;
				const mutation = request.method !== "GET" && request.method !== "HEAD";
				guardRequest(request, config.hubAllowLan, mutation);

				if (request.method === "GET" && path === "/health") return jsonResponse({ ok: true });
				if (request.method === "GET" && path === "/api/v1/status") {
					return jsonResponse({
						ok: true,
						workflow_count: store.workflowCount(),
						comfy_configured: true,
					});
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

				if (request.method === "POST" && path === "/api/v1/workflows") {
					const data = parseMetadata(await readJsonBody(request));
					const workflow = await store.workflowUpload(data.uploadId, data, config.maxWorkflowBytes);
					return jsonResponse(workflow, 201, { etag: `"${workflow.sha256}"` });
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

				if (request.method === "GET" && path === "/api/v1/comfy/nodes") return jsonResponse(await comfy.getNodes());
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
				if (error instanceof HttpError) return errorResponse(error.status, error.code, error.message);
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
