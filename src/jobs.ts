import { createHash, randomUUID } from "node:crypto";
import type { ComfyJob, ComfyJobStatus } from "./comfy-client.ts";
import type { ComfyApiClient } from "./comfy-client.ts";
import { ComfyPromptRejectedError, ComfyUpstreamError, HttpError } from "./errors.ts";
import { type HubStore, type JobSubmission, type JobSubmissionState } from "./storage.ts";

const UPSTREAM_PAGE_SIZE = 100;
const MAX_UPSTREAM_PAGES = 1_000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "submission_rejected"]);

export interface JobSubmitInput {
	workflowId: string;
	metadata: Record<string, unknown>;
	clientRequestId: string | null;
}

export interface JobSubmitResult {
	job_id: string;
	workflow_id: string;
	status: "submitted" | "submission_unknown" | "cancelled";
	submission_state: JobSubmissionState;
	reused: boolean;
}

export interface JobListResult {
	jobs: ComfyJob[];
	pagination: { offset: number; limit: number; total: number; has_more: boolean };
}

export interface JobCancelResult {
	job_id: string;
	cancelled: boolean | null;
	outcome: "cancelled" | "not_cancelled" | "unknown";
	status: ComfyJobStatus | "not_found" | "unknown";
	error?: { code: string; message: string };
}

export class JobService {
	private readonly store: HubStore;
	private readonly comfy: ComfyApiClient;
	private readonly pollIntervalMs: number;
	private readonly now: () => number;

	constructor(options: { store: HubStore; comfy: ComfyApiClient; pollIntervalMs?: number; now?: () => number }) {
		this.store = options.store;
		this.comfy = options.comfy;
		this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
		this.now = options.now ?? Date.now;
	}

	async submit(input: JobSubmitInput, signal?: AbortSignal): Promise<JobSubmitResult> {
		const { metadata, workflow, workflowJson } = await this.store.readWorkflowContent(input.workflowId);
		const metadataJson = canonicalJson(input.metadata);
		const requestFingerprint = createHash("sha256")
			.update(JSON.stringify({ workflow_id: metadata.id, metadata: JSON.parse(metadataJson) }))
			.digest("hex");
		const attempt = this.store.beginJobSubmission({
			promptId: randomUUID(),
			workflowId: metadata.id,
			clientRequestId: input.clientRequestId,
			requestFingerprint,
			metadata: JSON.parse(metadataJson) as Record<string, unknown>,
		});

		if (attempt.reused) return this.resultFromAttempt(attempt.submission, true);

		const { submission } = attempt;
		let attemptPromptId = submission.promptId;
		const extraData = { comfy_hub_workflow_id: submission.workflowId };
		try {
			const accepted = await this.comfy.submitPrompt({
				prompt: workflow,
				prompt_json: workflowJson,
				client_id: this.store.clientId,
				prompt_id: submission.promptId,
				extra_data: extraData,
			}, signal);
			if (!isCanonicalUuid(accepted.prompt_id)) {
				throw new ComfyUpstreamError(502, "ComfyUI returned a successful response without a canonical prompt_id");
			}
			let acceptedId = submission.promptId;
			if (accepted.prompt_id !== acceptedId) {
				acceptedId = this.store.replaceJobSubmissionPromptId(acceptedId, accepted.prompt_id).promptId;
			}
			attemptPromptId = acceptedId;
			this.store.updateJobSubmission(acceptedId, "accepted");
			return {
				job_id: acceptedId,
				workflow_id: submission.workflowId,
				status: "submitted",
				submission_state: "accepted",
				reused: false,
			};
		} catch (error) {
			if (error instanceof ComfyPromptRejectedError) {
				this.store.updateJobSubmission(attemptPromptId, "rejected", {
					message: error.message,
					payload: error.payload,
				});
				throw rejectedError(attemptPromptId, submission.workflowId, error.message, error.payload);
			}
			const reason = serializeSubmissionError(error);
			this.store.updateJobSubmission(attemptPromptId, "ambiguous", reason);
			return {
				job_id: attemptPromptId,
				workflow_id: submission.workflowId,
				status: "submission_unknown",
				submission_state: "ambiguous",
				reused: false,
			};
		}
	}

	async list(options: { limit: number; offset: number; signal?: AbortSignal }): Promise<JobListResult> {
		const upstream = await this.listAllUpstreamJobs(options.signal);
		const localSubmissions = this.store.listJobSubmissions();
		const localById = new Map(localSubmissions.map((submission) => [submission.promptId, submission]));
		const seen = new Set<string>();
		const jobs: ComfyJob[] = [];

		for (const job of upstream) {
			if (typeof job.id !== "string" || seen.has(job.id)) continue;
			seen.add(job.id);
			const local = localById.get(job.id);
			jobs.push(local ? addLocalMapping(job, this.reconcileSubmission(local)) : job);
		}

		for (const submission of localSubmissions) {
			if (seen.has(submission.promptId)) continue;
			const local = localAttemptJob(submission);
			if (!local) continue;
			seen.add(submission.promptId);
			jobs.push(local);
		}

		jobs.sort((a, b) => numericField(b, "create_time") - numericField(a, "create_time"));
		const total = jobs.length;
		const page = jobs.slice(options.offset, options.offset + options.limit);
		return {
			jobs: page,
			pagination: {
				offset: options.offset,
				limit: options.limit,
				total,
				has_more: options.offset + page.length < total,
			},
		};
	}

	async get(promptId: string, signal?: AbortSignal): Promise<ComfyJob> {
		validateJobId(promptId);
		const submission = this.store.getJobSubmission(promptId);
		try {
			const job = await this.getUpstreamJob(promptId, signal);
			return submission ? addLocalMapping(job, this.reconcileSubmission(submission)) : job;
		} catch (error) {
			if (!(error instanceof HttpError) || error.code !== "job_not_found") throw error;
			const local = submission && localAttemptJob(submission);
			if (local) return local;
			throw error;
		}
	}

	async wait(
		promptId: string,
		timeoutMs: number,
		signal?: AbortSignal,
		initialSnapshot?: ComfyJob,
	): Promise<ComfyJob> {
		validateJobId(promptId);
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 300_000) {
			throw new HttpError(400, "invalid_wait_timeout", "Job wait timeout must be between 0 and 300 seconds");
		}
		const deadline = this.now() + timeoutMs;
		let snapshot = initialSnapshot ?? await this.get(promptId, signal);
		if (isTerminal(snapshot.status)) return { ...snapshot, wait_timed_out: false };
		if (timeoutMs <= 0) return { ...snapshot, wait_timed_out: true };

		while (true) {
			throwIfAborted(signal);
			const remaining = deadline - this.now();
			if (remaining <= 0) return { ...snapshot, wait_timed_out: true };
			await delay(Math.min(this.pollIntervalMs, remaining), signal);
			throwIfAborted(signal);
			const pollTimeoutSignal = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - this.now())));
			const pollSignal = signal ? AbortSignal.any([signal, pollTimeoutSignal]) : pollTimeoutSignal;
			try {
				snapshot = await this.get(promptId, pollSignal);
			} catch (error) {
				if (signal?.aborted) throw signal.reason ?? error;
				if (pollTimeoutSignal.aborted || this.now() >= deadline) return { ...snapshot, wait_timed_out: true };
				if (error instanceof HttpError && error.code === "job_not_found") {
					return { ...snapshot, wait_timed_out: true };
				}
				throw error;
			}
			if (isTerminal(snapshot.status)) return { ...snapshot, wait_timed_out: false };
		}
	}

	async cancel(promptId: string, signal?: AbortSignal): Promise<JobCancelResult> {
		validateJobId(promptId);
		const submission = this.store.getJobSubmission(promptId);
		let before: ComfyJob;
		try {
			before = await this.getUpstreamJob(promptId, signal);
		} catch (error) {
			if (error instanceof HttpError && error.code === "job_not_found") {
				const local = submission && localAttemptJob(submission);
				if (local) {
					const cancelled = submission?.state === "cancelled";
					return {
						job_id: promptId,
						cancelled,
						outcome: cancelled ? "cancelled" : "not_cancelled",
						status: local.status ?? "not_found",
					};
				}
				throw error;
			}
			throw error;
		}
		if (before.status !== "pending") {
			return { job_id: promptId, cancelled: false, outcome: "not_cancelled", status: before.status ?? "not_found" };
		}

		try {
			// Deliberately only dequeue by id. The v1 /api/jobs/{id}/cancel route can
			// interrupt running jobs, so it is never used by this hub.
			await this.comfy.deletePendingJob(promptId, signal);
		} catch {
			const afterFailure = await this.readAfterCancel(promptId, signal);
			if (afterFailure) {
				return { job_id: promptId, cancelled: false, outcome: "not_cancelled", status: afterFailure.status ?? "not_found" };
			}
			return {
				job_id: promptId,
				cancelled: null,
				outcome: "unknown",
				status: "unknown",
				error: {
					code: "cancel_outcome_unknown",
					message: "ComfyUI did not confirm whether the pending job was removed",
				},
			};
		}

		const after = await this.readAfterCancel(promptId, signal);
		if (after) return { job_id: promptId, cancelled: false, outcome: "not_cancelled", status: after.status ?? "not_found" };
		if (submission) this.store.updateJobSubmission(promptId, "cancelled");
		return { job_id: promptId, cancelled: true, outcome: "cancelled", status: "cancelled" };
	}

	private async listAllUpstreamJobs(signal?: AbortSignal): Promise<ComfyJob[]> {
		const jobs: ComfyJob[] = [];
		let offset = 0;
		for (let pageCount = 0; pageCount < MAX_UPSTREAM_PAGES; pageCount++) {
			throwIfAborted(signal);
			const page = await this.comfy.listJobsPage({ limit: UPSTREAM_PAGE_SIZE, offset, ...(signal ? { signal } : {}) });
			if (!page || !Array.isArray(page.jobs)) throw new ComfyUpstreamError(502, "ComfyUI returned an invalid jobs page");
			jobs.push(...page.jobs.filter(isComfyJob));
			const pagination = page.pagination;
			if (pagination && typeof pagination.has_more === "boolean") {
				if (!pagination.has_more) return jobs;
			} else if (typeof pagination?.total === "number" && offset + page.jobs.length >= pagination.total) {
				return jobs;
			} else if (page.jobs.length < UPSTREAM_PAGE_SIZE) {
				return jobs;
			}
			if (page.jobs.length === 0) return jobs;
			offset += page.jobs.length;
		}
		throw new ComfyUpstreamError(502, "ComfyUI job listing exceeded the pagination safety limit");
	}

	private async getUpstreamJob(promptId: string, signal?: AbortSignal): Promise<ComfyJob> {
		try {
			const job = await this.comfy.getJob(promptId, signal);
			if (!job || typeof job !== "object" || Array.isArray(job)) {
				throw new ComfyUpstreamError(502, "ComfyUI returned an invalid job record");
			}
			return { ...job, id: typeof job.id === "string" ? job.id : promptId };
		} catch (error) {
			if (!(error instanceof ComfyUpstreamError) || error.status !== 404) throw error;
		}

		const fromHistory = await this.getHistoryJob(promptId, signal);
		if (fromHistory) return fromHistory;
		const fromQueue = await this.getQueuedJob(promptId, signal);
		if (fromQueue) return fromQueue;
		throw new HttpError(404, "job_not_found", "ComfyUI job not found");
	}

	private async getHistoryJob(promptId: string, signal?: AbortSignal): Promise<ComfyJob | null> {
		const response = await this.comfy.getHistory(promptId, signal);
		if (!isRecord(response)) return null;
		const item = isRecord(response[promptId]) ? response[promptId] : null;
		if (!item) return null;
		const prompt = Array.isArray(item.prompt) ? item.prompt : [];
		const extraData = isRecord(prompt[3]) ? prompt[3] : {};
		const statusInfo = isRecord(item.status) ? item.status : {};
		const statusString = statusInfo.status_str;
		const messages = Array.isArray(statusInfo.messages) ? statusInfo.messages : [];
		const interrupted = messages.some((message) => Array.isArray(message) && message[0] === "execution_interrupted");
		const executionError = messages.find((message) => Array.isArray(message) && message[0] === "execution_error");
		const status = statusString === "success" ? "completed" : statusString === "error" ? (interrupted ? "cancelled" : "failed") : "completed";
		return {
			id: promptId,
			status,
			priority: prompt[0],
			create_time: extraData.create_time,
			outputs: isRecord(item.outputs) ? item.outputs : {},
			execution_status: statusInfo,
			...(executionError ? { execution_error: executionError[1] } : {}),
			...(workflowIdFromExtra(extraData) ? { workflow_id: workflowIdFromExtra(extraData) } : {}),
		};
	}

	private async getQueuedJob(promptId: string, signal?: AbortSignal): Promise<ComfyJob | null> {
		const response = await this.comfy.getQueue(signal);
		if (!isRecord(response)) return null;
		for (const [field, status] of [["queue_running", "in_progress"], ["queue_pending", "pending"]] as const) {
			const entries = response[field];
			if (!Array.isArray(entries)) continue;
			for (const entry of entries) {
				if (!Array.isArray(entry) || entry[1] !== promptId) continue;
				const extraData = isRecord(entry[3]) ? entry[3] : {};
				return {
					id: promptId,
					status,
					priority: entry[0],
					create_time: extraData.create_time,
					outputs_count: 0,
					previewable_outputs_count: 0,
					...(workflowIdFromExtra(extraData) ? { workflow_id: workflowIdFromExtra(extraData) } : {}),
				};
			}
		}
		return null;
	}

	private async readAfterCancel(promptId: string, signal?: AbortSignal): Promise<ComfyJob | null> {
		try {
			return await this.getUpstreamJob(promptId, signal);
		} catch (error) {
			if (error instanceof HttpError && error.code === "job_not_found") return null;
			throw error;
		}
	}

	private reconcileSubmission(submission: JobSubmission): JobSubmission {
		if (submission.state !== "submitting" && submission.state !== "ambiguous") return submission;
		return this.store.markJobSubmissionAcceptedIfUnresolved(submission.promptId) ?? submission;
	}

	private resultFromAttempt(submission: JobSubmission, reused: boolean): JobSubmitResult {
		if (submission.state === "rejected") {
			const saved = isRecord(submission.upstreamError) ? submission.upstreamError : {};
			throw rejectedError(
				submission.promptId,
				submission.workflowId,
				typeof saved.message === "string" ? saved.message : "ComfyUI rejected the prompt",
				saved.payload,
			);
		}
		return {
			job_id: submission.promptId,
			workflow_id: submission.workflowId,
			status: submission.state === "cancelled" ? "cancelled" : submission.state === "accepted" ? "submitted" : "submission_unknown",
			submission_state: submission.state,
			reused,
		};
	}
}

function rejectedError(promptId: string, workflowId: string, message: string, payload: unknown): HttpError {
	return new HttpError(422, "prompt_rejected", message, {
		job_id: promptId,
		workflow_id: workflowId,
		upstream: payload,
	});
}

function addLocalMapping(job: ComfyJob, submission: JobSubmission): ComfyJob {
	return {
		...job,
		workflow_id: submission.workflowId,
		local_submission_state: submission.state,
	};
}

function localAttemptJob(submission: JobSubmission): ComfyJob | null {
	if (submission.state === "accepted") return null;
	const status = submission.state === "rejected"
		? "submission_rejected"
		: submission.state === "cancelled"
			? "cancelled"
			: "submission_unknown";
	return {
		id: submission.promptId,
		status,
		workflow_id: submission.workflowId,
		create_time: submission.createdAt,
		local_submission_state: submission.state,
		...(submission.upstreamError !== null ? { submission_error: submission.upstreamError } : {}),
	};
}

function workflowIdFromExtra(extraData: Record<string, unknown>): string | undefined {
	const workflowId = extraData.comfy_hub_workflow_id;
	return typeof workflowId === "string" ? workflowId : undefined;
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (!isRecord(value)) return value;
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
	return sorted;
}

function isCanonicalUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

function validateJobId(value: string): void {
	if (!isCanonicalUuid(value)) throw new HttpError(400, "invalid_job_id", "job_id must be a canonical lowercase UUID");
}

function isComfyJob(value: unknown): value is ComfyJob {
	return isRecord(value) && typeof value.id === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTerminal(status: unknown): boolean {
	return typeof status === "string" && TERMINAL_STATUSES.has(status);
}

function numericField(value: Record<string, unknown>, field: string): number {
	const candidate = value[field];
	return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
}

function serializeSubmissionError(error: unknown): Record<string, unknown> {
	if (error instanceof ComfyUpstreamError) {
		return { status: error.status, message: error.message.slice(0, 2_000) };
	}
	if (error instanceof Error) return { name: error.name, message: error.message.slice(0, 2_000) };
	return { message: "ComfyUI submission outcome is unknown" };
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	throwIfAborted(signal);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
