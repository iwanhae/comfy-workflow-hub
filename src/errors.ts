export class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "HttpError";
	}
}

export class ComfyUpstreamError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ComfyUpstreamError";
	}
}

export class ComfyPromptRejectedError extends ComfyUpstreamError {
	constructor(message: string, readonly payload: unknown) {
		super(400, message);
		this.name = "ComfyPromptRejectedError";
	}
}
