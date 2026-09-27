import { randomUUID } from "node:crypto";
import { ComfyPromptRejectedError, ComfyUpstreamError } from "./errors.ts";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ComfyJobStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled" | (string & {});

export interface ComfyJob {
	id: string;
	status?: ComfyJobStatus;
	workflow_id?: string;
	[key: string]: unknown;
}

export interface ComfyJobListPage {
	jobs: ComfyJob[];
	pagination: {
		offset: number;
		limit: number | null;
		total: number;
		has_more: boolean;
	};
}

export interface ComfyPromptResponse {
	prompt_id: string;
	number?: number;
	node_errors?: unknown;
}

export interface ComfyPromptRequest {
	prompt: Record<string, unknown>;
	prompt_json?: string;
	client_id: string;
	prompt_id: string;
	extra_data: Record<string, unknown>;
}

export interface ComfyFileReference {
	filename: string;
	subfolder: string;
	type: string;
}

export interface ComfyInputUpload {
	path: string;
	filename: string;
	subfolder: string;
	contentType: string;
	bytes: number;
	kind: "image" | "mask";
	originalRef?: ComfyFileReference;
}

export class ComfyApiClient {
	private readonly baseUrl: URL;
	private readonly fetchImpl: FetchLike;
	private readonly timeoutMs: number;

	constructor(options: { baseUrl: URL; timeoutMs: number; fetchImpl?: FetchLike }) {
		this.baseUrl = new URL(options.baseUrl);
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.timeoutMs = options.timeoutMs;
	}

	getNodes(signal?: AbortSignal): Promise<unknown> {
		return this.get("/object_info", signal);
	}

	getModels(signal?: AbortSignal): Promise<unknown> {
		return this.get("/models", signal);
	}

	getModelFolder(folder: string, signal?: AbortSignal): Promise<unknown> {
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(folder)) throw new Error("Invalid model folder");
		return this.get(`/models/${encodeURIComponent(folder)}`, signal);
	}

	getJobs(signal?: AbortSignal): Promise<unknown> {
		return this.get("/api/jobs", signal);
	}

	listJobsPage(options: { limit: number; offset: number; signal?: AbortSignal }): Promise<ComfyJobListPage> {
		const query = new URLSearchParams({ limit: String(options.limit), offset: String(options.offset) });
		return this.get(`/api/jobs?${query.toString()}`, options.signal) as Promise<ComfyJobListPage>;
	}

	getJob(id: string, signal?: AbortSignal): Promise<ComfyJob> {
		return this.get(`/api/jobs/${encodeURIComponent(this.validatePathId(id))}`, signal) as Promise<ComfyJob>;
	}

	submitPrompt(body: ComfyPromptRequest, signal?: AbortSignal): Promise<ComfyPromptResponse> {
		return this.request("/prompt", {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: serializePromptRequest(body),
			redirect: "error",
		}, signal, { promptPost: true }) as Promise<ComfyPromptResponse>;
	}

	deletePendingJob(id: string, signal?: AbortSignal): Promise<void> {
		return this.request("/queue", {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({ delete: [this.validatePathId(id)] }),
			redirect: "error",
		}, signal, { allowEmpty: true }).then(() => undefined);
	}

	getQueue(signal?: AbortSignal): Promise<unknown> {
		return this.get("/queue", signal);
	}

	getHistory(id: string, signal?: AbortSignal): Promise<unknown> {
		return this.get(`/history/${encodeURIComponent(this.validatePathId(id))}`, signal);
	}

	async uploadInputAsset(input: ComfyInputUpload, signal?: AbortSignal): Promise<ComfyFileReference> {
		const boundary = `comfy-hub-${randomUUID()}`;
		const fields: Array<[string, string]> = [
			["type", "input"],
			["subfolder", input.subfolder],
			["overwrite", "false"],
		];
		if (input.kind === "mask") {
			if (!input.originalRef) throw new Error("A ComfyUI mask upload requires an original image reference");
			fields.push(["original_ref", JSON.stringify(input.originalRef)]);
		}
		const multipart = createMultipartStream({ boundary, path: input.path, filename: input.filename, contentType: input.contentType, bytes: input.bytes, fields });
		const url = input.kind === "mask" ? "/upload/mask" : "/upload/image";
		const result = await this.request(url, {
			method: "POST",
			headers: {
				"content-type": `multipart/form-data; boundary=${boundary}`,
				"content-length": String(multipart.contentLength),
				accept: "application/json",
			},
			body: multipart.body,
			redirect: "error",
		}, signal);
		if (!isRecord(result)
			|| typeof result.name !== "string"
			|| typeof result.subfolder !== "string"
			|| typeof result.type !== "string") {
			throw new ComfyUpstreamError(502, "ComfyUI returned an invalid asset upload reference");
		}
		return { filename: result.name, subfolder: result.subfolder, type: result.type };
	}

	async getView(ref: ComfyFileReference, signal?: AbortSignal): Promise<Response> {
		const query = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder, type: ref.type });
		const path = `/view?${query.toString()}`;
		const headerController = new AbortController();
		const headerTimer = setTimeout(() => {
			headerController.abort(new DOMException("ComfyUI output headers timed out", "TimeoutError"));
		}, this.timeoutMs);
		const requestSignal = signal ? AbortSignal.any([signal, headerController.signal]) : headerController.signal;
		let response: Response;
		try {
			const url = new URL(path.replace(/^\//, ""), this.baseUrl);
			response = await this.fetchImpl(url, {
				method: "GET",
				headers: { accept: "*/*" },
				signal: requestSignal,
				redirect: "error",
			});
		} catch (error) {
			if (signal?.aborted) throw signal.reason ?? error;
			if (headerController.signal.aborted || (error instanceof Error && error.name === "TimeoutError")) {
				throw new ComfyUpstreamError(504, "ComfyUI output headers timed out");
			}
			throw new ComfyUpstreamError(502, error instanceof Error ? error.message : "ComfyUI output download failed");
		} finally {
			clearTimeout(headerTimer);
		}
		if (!response.ok) {
			const message = await readResponsePreview(response, 2048).catch(() => "");
			throw new ComfyUpstreamError(response.status, message.slice(0, 2048) || response.statusText);
		}
		return response;
	}

	getSystemStats(signal?: AbortSignal): Promise<unknown> {
		return this.get("/system_stats", signal);
	}

	private validatePathId(id: string): string {
		if (!id || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id)) throw new Error("Invalid ComfyUI job id");
		return id;
	}

	private async get(path: string, signal?: AbortSignal): Promise<unknown> {
		return this.request(path, {
			method: "GET",
			headers: { accept: "application/json" },
			redirect: "error",
		}, signal);
	}

	private async request(
		path: string,
		init: RequestInit,
		signal?: AbortSignal,
		options: { allowEmpty?: boolean; promptPost?: boolean } = {},
	): Promise<unknown> {
		const url = new URL(path.replace(/^\//, ""), this.baseUrl);
		const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
		const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		let response: Response;
		let body: string;
		try {
			response = await this.fetchImpl(url, { ...init, signal: requestSignal });
			body = await response.text();
		} catch (error) {
			if (signal?.aborted) throw signal.reason ?? error;
			if (timeoutSignal.aborted || (error instanceof Error && error.name === "TimeoutError")) {
				throw new ComfyUpstreamError(504, "ComfyUI request timed out");
			}
			throw new ComfyUpstreamError(502, error instanceof Error ? error.message : "ComfyUI request failed");
		}
		if (!response.ok) {
			const payload = parseOptionalJson(body);
			if (options.promptPost && response.status === 400) {
				throw new ComfyPromptRejectedError(promptRejectionMessage(payload, body), payload ?? body.slice(0, 2048));
			}
			throw new ComfyUpstreamError(response.status, body.slice(0, 2048) || response.statusText);
		}
		if (!body.trim() && options.allowEmpty) return null;
		try {
			return JSON.parse(body);
		} catch {
			throw new ComfyUpstreamError(502, "ComfyUI returned a non-JSON response");
		}
	}
}

function parseOptionalJson(value: string): unknown | null {
	if (!value.trim()) return null;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return null;
	}
}

function promptRejectionMessage(payload: unknown, raw: string): string {
	if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
		const error = (payload as Record<string, unknown>).error;
		if (typeof error === "string" && error.trim()) return error.slice(0, 1000);
		if (typeof error === "object" && error !== null && !Array.isArray(error)) {
			const message = (error as Record<string, unknown>).message;
			if (typeof message === "string" && message.trim()) return message.slice(0, 1000);
		}
	}
	return raw.trim().slice(0, 1000) || "ComfyUI rejected the prompt";
}

function serializePromptRequest(body: ComfyPromptRequest): string {
	const promptJson = body.prompt_json ?? JSON.stringify(body.prompt);
	if (body.prompt_json !== undefined) {
		let value: unknown;
		try {
			value = JSON.parse(body.prompt_json);
		} catch {
			throw new Error("prompt_json must be valid JSON");
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error("prompt_json must contain an API-format workflow object");
		}
	}
	return `{"prompt":${promptJson},"client_id":${JSON.stringify(body.client_id)},"prompt_id":${JSON.stringify(body.prompt_id)},"extra_data":${JSON.stringify(body.extra_data)}}`;
}

function createMultipartStream(input: {
	boundary: string;
	path: string;
	filename: string;
	contentType: string;
	bytes: number;
	fields: Array<[string, string]>;
}): { body: ReadableStream<Uint8Array>; contentLength: number } {
	const fileHeader = Buffer.from(
		`--${input.boundary}\r\nContent-Disposition: form-data; name="image"; filename="${input.filename}"\r\nContent-Type: ${input.contentType}\r\n\r\n`,
		"utf8",
	);
	const fieldParts = input.fields.map(([name, value]) => Buffer.from(
		`\r\n--${input.boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`,
		"utf8",
	));
	const closing = Buffer.from(`\r\n--${input.boundary}--\r\n`, "ascii");
	const contentLength = fileHeader.byteLength + input.bytes + fieldParts.reduce((sum, part) => sum + part.byteLength, 0) + closing.byteLength;
	const reader = Bun.file(input.path).stream().getReader();
	let state: "header" | "file" | "fields" | "closing" | "done" = "header";
	let fieldIndex = 0;
	let readerReleased = false;
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (state === "header") {
				state = "file";
				controller.enqueue(fileHeader);
				return;
			}
			if (state === "file") {
				const next = await reader.read();
				if (!next.done) {
					controller.enqueue(next.value);
					return;
				}
				reader.releaseLock();
				readerReleased = true;
				state = "fields";
			}
			if (state === "fields") {
				if (fieldIndex < fieldParts.length) {
					controller.enqueue(fieldParts[fieldIndex++]!);
					return;
				}
				state = "closing";
			}
			if (state === "closing") {
				state = "done";
				controller.enqueue(closing);
				return;
			}
			controller.close();
		},
		async cancel(reason) {
			if (!readerReleased) {
				await reader.cancel(reason).catch(() => undefined);
				reader.releaseLock();
				readerReleased = true;
			}
		},
	});
	return { body, contentLength };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readResponsePreview(response: Response, maxBytes: number, timeoutMs = 2_000): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			timedOut = true;
			reject(new DOMException("ComfyUI error response body timed out", "TimeoutError"));
		}, timeoutMs);
	});
	try {
		while (total < maxBytes) {
			const next = await Promise.race([reader.read(), timeout]);
			if (next.done) break;
			const piece = next.value.subarray(0, maxBytes - total);
			chunks.push(piece);
			total += piece.byteLength;
			if (piece.byteLength !== next.value.byteLength) break;
		}
		if (total >= maxBytes) await reader.cancel("error preview limit reached").catch(() => undefined);
	} catch (error) {
		if (!timedOut) throw error;
		void reader.cancel(error).catch(() => undefined);
	} finally {
		clearTimeout(timer!);
		try {
			reader.releaseLock();
		} catch {
			// A timed-out read may still be unwinding after cancellation.
		}
	}
	return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total));
}
