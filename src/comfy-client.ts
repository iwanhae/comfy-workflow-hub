import { ComfyUpstreamError } from "./errors.ts";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class ComfyApiClient {
	private readonly baseUrl: URL;
	private readonly fetchImpl: FetchLike;
	private readonly timeoutMs: number;

	constructor(options: { baseUrl: URL; timeoutMs: number; fetchImpl?: FetchLike }) {
		this.baseUrl = new URL(options.baseUrl);
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.timeoutMs = options.timeoutMs;
	}

	getNodes(): Promise<unknown> {
		return this.get("/object_info");
	}

	getModels(): Promise<unknown> {
		return this.get("/models");
	}

	getModelFolder(folder: string): Promise<unknown> {
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(folder)) throw new Error("Invalid model folder");
		return this.get(`/models/${encodeURIComponent(folder)}`);
	}

	getJobs(): Promise<unknown> {
		return this.get("/api/jobs");
	}

	getJob(id: string): Promise<unknown> {
		return this.get(`/api/jobs/${encodeURIComponent(this.validatePathId(id))}`);
	}

	getQueue(): Promise<unknown> {
		return this.get("/queue");
	}

	getHistory(id: string): Promise<unknown> {
		return this.get(`/history/${encodeURIComponent(this.validatePathId(id))}`);
	}

	getSystemStats(): Promise<unknown> {
		return this.get("/system_stats");
	}

	private validatePathId(id: string): string {
		if (!id || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id)) throw new Error("Invalid ComfyUI job id");
		return id;
	}

	private async get(path: string): Promise<unknown> {
		const url = new URL(path.replace(/^\//, ""), this.baseUrl);
		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method: "GET",
				headers: { accept: "application/json" },
				redirect: "error",
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (error) {
			if (error instanceof Error && error.name === "TimeoutError") {
				throw new ComfyUpstreamError(504, "ComfyUI read request timed out");
			}
			throw new ComfyUpstreamError(502, error instanceof Error ? error.message : "ComfyUI request failed");
		}
		const body = await response.text();
		if (!response.ok) {
			throw new ComfyUpstreamError(response.status, body.slice(0, 2048) || response.statusText);
		}
		try {
			return JSON.parse(body);
		} catch {
			throw new ComfyUpstreamError(502, "ComfyUI returned a non-JSON response");
		}
	}
}
