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
