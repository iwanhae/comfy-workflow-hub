import type { ComfyApiClient, ComfyJob } from "./comfy-client.ts";
import { HttpError } from "./errors.ts";
import type { JobService } from "./jobs.ts";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_TRACKED_JOBS = 1_000;
const MAX_PROGRESS_NODES = 64;
const MAX_SSE_SUBSCRIBERS = 50;
const SSE_QUEUE_CAPACITY = 4;
const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_SNAPSHOT_BYTES = 256 * 1024;

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "submission_rejected"]);
const UPSTREAM_STATUSES = new Set(["pending", "in_progress", "completed", "failed", "cancelled"]);

export interface ProgressNode {
	node_id: string;
	title?: string;
	state?: string;
	value?: number;
	max?: number;
}

export interface ProgressJob {
	job_id: string;
	status: string;
	workflow_id?: string;
	create_time?: number;
	current_node?: ProgressNode | null;
	last_completed_node_id?: string;
	progress?: { value: number; max: number };
	progress_state?: ProgressNode[];
	updated_at: string;
}

export interface ProgressState {
	upstream: "connecting" | "connected" | "reconnecting" | "closed";
	queue_remaining: number | null;
	last_reconciled_at: string | null;
}

export interface JobProgressSnapshot {
	type: "snapshot";
	sequence: number;
	state: ProgressState;
	jobs: ProgressJob[];
	truncated: boolean;
}

export interface ProgressTimers {
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(timer: unknown): void;
	setInterval(callback: () => void, delayMs: number): unknown;
	clearInterval(timer: unknown): void;
}

export interface ProgressWebSocket {
	onopen: ((event: Event) => void) | null;
	onmessage: ((event: MessageEvent) => void) | null;
	onclose: ((event: CloseEvent) => void) | null;
	onerror: ((event: Event) => void) | null;
	close(code?: number, reason?: string): void;
}

export type ProgressWebSocketFactory = (url: URL) => ProgressWebSocket;

export interface JobProgressServiceOptions {
	comfy: ComfyApiClient;
	jobs: JobService;
	clientId: string;
	webSocketFactory?: ProgressWebSocketFactory;
	pollIntervalMs?: number;
	heartbeatIntervalMs?: number;
	reconnectBaseMs?: number;
	now?: () => number;
	random?: () => number;
	timers?: ProgressTimers;
}

interface Subscriber {
	controller: ReadableStreamDefaultController<Uint8Array>;
	signal?: AbortSignal;
	onAbort?: () => void;
}

type JobPatch = Partial<Omit<ProgressJob, "job_id" | "updated_at">>;

const defaultTimers: ProgressTimers = {
	setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
	clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
	setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
	clearInterval: (timer) => globalThis.clearInterval(timer as ReturnType<typeof setInterval>),
};

/**
 * Owns the Hub's one ComfyUI websocket, a bounded shared progress cache, and
 * same-origin SSE subscribers. Only safe job/progress fields leave this class;
 * prompt graphs, execution errors, and arbitrary websocket payloads are never
 * copied into the browser event stream.
 */
export class JobProgressService {
	private readonly comfy: ComfyApiClient;
	private readonly jobs: JobService;
	private readonly clientId: string;
	private readonly webSocketFactory: ProgressWebSocketFactory;
	private readonly pollIntervalMs: number;
	private readonly heartbeatIntervalMs: number;
	private readonly reconnectBaseMs: number;
	private readonly now: () => number;
	private readonly random: () => number;
	private readonly timers: ProgressTimers;
	private readonly trackedJobs = new Map<string, ProgressJob>();
	private readonly subscribers = new Set<Subscriber>();
	private state: ProgressState = { upstream: "connecting", queue_remaining: null, last_reconciled_at: null };
	private sequence = 0;
	private queueEventRevision = 0;
	private omittedJobs = false;
	private started = false;
	private closed = false;
	private socket: ProgressWebSocket | null = null;
	private reconnectTimer: unknown;
	private pollTimer: unknown;
	private heartbeatTimer: unknown;
	private reconnectAttempt = 0;
	private refreshPromise: Promise<void> | null = null;
	private refreshController: AbortController | null = null;

	constructor(options: JobProgressServiceOptions) {
		this.comfy = options.comfy;
		this.jobs = options.jobs;
		this.clientId = options.clientId;
		this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
		this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
		this.reconnectBaseMs = options.reconnectBaseMs ?? 500;
		this.now = options.now ?? Date.now;
		this.random = options.random ?? Math.random;
		this.timers = options.timers ?? defaultTimers;
	}

	start(): void {
		if (this.started || this.closed) return;
		this.started = true;
		this.connect();
		void this.refreshNow();
		this.pollTimer = this.timers.setInterval(() => void this.refreshNow(), this.pollIntervalMs);
	}

	/** A non-throwing, single-flight read reconciliation; safe for reconnects and tests. */
	refreshNow(): Promise<void> {
		if (this.closed) return Promise.resolve();
		if (this.refreshPromise) return this.refreshPromise;
		const controller = new AbortController();
		this.refreshController = controller;
		const refresh = this.reconcile(controller.signal).catch(() => undefined);
		const wrapped = refresh.finally(() => {
			if (this.refreshController === controller) this.refreshController = null;
			if (this.refreshPromise === wrapped) this.refreshPromise = null;
		});
		this.refreshPromise = wrapped;
		return wrapped;
	}

	getSnapshot(): JobProgressSnapshot {
		const orderedJobs = [...this.trackedJobs.values()].sort((left, right) => {
			const leftActive = isTerminal(left.status) ? 0 : 1;
			const rightActive = isTerminal(right.status) ? 0 : 1;
			return rightActive - leftActive
				|| numberOrZero(right.create_time) - numberOrZero(left.create_time)
				|| Date.parse(right.updated_at) - Date.parse(left.updated_at);
		});
		const jobs: ProgressJob[] = [];
		let snapshotBytes = Buffer.byteLength(JSON.stringify({ type: "snapshot", sequence: this.sequence, state: this.state, jobs: [], truncated: this.omittedJobs })) + 16;
		for (const source of orderedJobs) {
			const job = cloneJob(source);
			const jobBytes = Buffer.byteLength(JSON.stringify(job)) + (jobs.length > 0 ? 1 : 0);
			if (snapshotBytes + jobBytes > MAX_SNAPSHOT_BYTES) break;
			snapshotBytes += jobBytes;
			jobs.push(job);
		}
		return {
			type: "snapshot",
			sequence: this.sequence,
			state: { ...this.state },
			jobs: jobs.map(cloneJob),
			truncated: this.omittedJobs || jobs.length < orderedJobs.length,
		};
	}

	assertSubscriberCapacity(): void {
		if (this.closed) throw new HttpError(503, "events_unavailable", "The job event feed is shutting down");
		if (this.subscribers.size >= MAX_SSE_SUBSCRIBERS) {
			throw new HttpError(503, "events_busy", "The job event feed has reached its subscriber limit");
		}
	}

	createSseResponse(signal?: AbortSignal): Response {
		this.assertSubscriberCapacity();
		let activeSubscriber: Subscriber | null = null;
		const body = new ReadableStream<Uint8Array>({
			start: (controller) => {
				if (signal?.aborted || this.closed) {
					controller.close();
					return;
				}
				const subscriber: Subscriber = { controller, ...(signal ? { signal } : {}) };
				activeSubscriber = subscriber;
				const onAbort = () => this.removeSubscriber(subscriber, true);
				if (signal) {
					subscriber.onAbort = onAbort;
					signal.addEventListener("abort", onAbort, { once: true });
				}
				this.subscribers.add(subscriber);
				this.ensureHeartbeat();
				this.send(subscriber, "snapshot", this.getSnapshot());
			},
			cancel: () => {
				if (activeSubscriber) this.removeSubscriber(activeSubscriber, false);
			},
		}, { highWaterMark: SSE_QUEUE_CAPACITY });
		return new Response(body, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache, no-transform",
				connection: "keep-alive",
				"x-accel-buffering": "no",
			},
		});
	}

	/** Immediately reflect a Hub submission while the upstream event catches up. */
	noteSubmission(jobId: string, workflowId: string, status: string): void {
		if (!validJobId(jobId)) return;
		this.applyJob(jobId, {
			workflow_id: workflowId,
			status,
		}, false);
	}

	/** Reflect a confirmed pending-queue deletion without waiting for a poll. */
	noteCancellation(jobId: string): void {
		if (!validJobId(jobId)) return;
		this.applyJob(jobId, { status: "cancelled", current_node: null }, false);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.pollTimer !== undefined) this.timers.clearInterval(this.pollTimer);
		if (this.heartbeatTimer !== undefined) this.timers.clearInterval(this.heartbeatTimer);
		if (this.reconnectTimer !== undefined) this.timers.clearTimeout(this.reconnectTimer);
		this.pollTimer = undefined;
		this.heartbeatTimer = undefined;
		this.reconnectTimer = undefined;
		this.refreshController?.abort(new DOMException("Hub is shutting down", "AbortError"));
		const socket = this.socket;
		this.socket = null;
		if (socket) {
			socket.onopen = null;
			socket.onmessage = null;
			socket.onerror = null;
			socket.onclose = null;
			try {
				socket.close(1000, "Hub shutdown");
			} catch {
				// A socket can already be closed by the upstream.
			}
		}
		this.setState({ upstream: "closed" });
		for (const subscriber of [...this.subscribers]) this.removeSubscriber(subscriber, true);
		this.trackedJobs.clear();
	}

	private async reconcile(signal: AbortSignal): Promise<void> {
		const queueEventRevision = this.queueEventRevision;
		const [queueResult, jobsResult] = await Promise.allSettled([
			this.comfy.getQueue(signal),
			this.jobs.listForProgress(signal, { includeAcceptedFallback: true }),
		]);
		if (this.closed || signal.aborted) return;

		if (jobsResult.status === "fulfilled") {
			for (const job of jobsResult.value) this.applyComfyJob(job);
		}
		if (queueResult.status === "fulfilled") {
			const queue = asRecord(queueResult.value);
			if (queue) {
				this.applyQueue(queue);
				const remaining = queueRemaining(queue);
				this.setState({
					...(queueEventRevision === this.queueEventRevision ? { queue_remaining: remaining } : {}),
					last_reconciled_at: new Date(this.now()).toISOString(),
				});
			}
		} else if (jobsResult.status === "fulfilled") {
			this.setState({ last_reconciled_at: new Date(this.now()).toISOString() });
		}
	}

	private async reconcileAfterConnect(): Promise<void> {
		const inFlight = this.refreshPromise;
		if (inFlight) await inFlight;
		if (!this.closed) await this.refreshNow();
	}

	private applyComfyJob(job: ComfyJob): void {
		if (!validJobId(job.id)) return;
		const patch: JobPatch = {};
		if (typeof job.status === "string" && UPSTREAM_STATUSES.has(job.status)) patch.status = job.status;
		if (typeof job.workflow_id === "string" && /^[a-f0-9]{64}$/.test(job.workflow_id)) patch.workflow_id = job.workflow_id;
		const createTime = safeNumber(job.create_time);
		if (createTime !== undefined) patch.create_time = createTime;
		this.applyJob(job.id, patch, false);
	}

	private applyQueue(queue: Record<string, unknown>): void {
		for (const [field, status] of [["queue_running", "in_progress"], ["queue_pending", "pending"]] as const) {
			const entries = queue[field];
			if (!Array.isArray(entries)) continue;
			for (const entry of entries) {
				let id: unknown;
				if (Array.isArray(entry)) id = entry[1];
				else if (asRecord(entry)) id = (entry as Record<string, unknown>).prompt_id ?? (entry as Record<string, unknown>).id;
				if (typeof id === "string" && validJobId(id)) this.applyJob(id, { status }, false);
			}
		}
	}

	private connect(): void {
		if (this.closed || !this.started || this.socket) return;
		this.setState({ upstream: this.reconnectAttempt === 0 ? "connecting" : "reconnecting" });
		let socket: ProgressWebSocket;
		try {
			socket = this.webSocketFactory(this.webSocketUrl());
		} catch {
			this.scheduleReconnect();
			return;
		}
		this.socket = socket;
		socket.onopen = () => {
			if (this.socket !== socket || this.closed) return;
			this.reconnectAttempt = 0;
			this.setState({ upstream: "connected" });
			void this.reconcileAfterConnect();
		};
		socket.onmessage = (event) => {
			if (this.socket !== socket || this.closed) return;
			this.onUpstreamMessage(event.data);
		};
		socket.onerror = () => {
			if (this.socket !== socket || this.closed) return;
			try {
				socket.close();
			} catch {
				this.onSocketClosed(socket);
			}
		};
		socket.onclose = () => this.onSocketClosed(socket);
	}

	private webSocketUrl(): URL {
		const url = this.comfy.getBaseUrl();
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		url.pathname = "/ws";
		url.search = "";
		url.hash = "";
		url.searchParams.set("clientId", this.clientId);
		return url;
	}

	private onSocketClosed(socket: ProgressWebSocket): void {
		if (this.socket !== socket || this.closed) return;
		this.socket = null;
		this.setState({ upstream: "reconnecting" });
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		if (this.closed || this.reconnectTimer !== undefined) return;
		const exponent = Math.min(this.reconnectAttempt, 10);
		const base = Math.min(MAX_RECONNECT_DELAY_MS, this.reconnectBaseMs * 2 ** exponent);
		const jitter = 0.8 + Math.max(0, Math.min(1, this.random())) * 0.4;
		const delayMs = Math.round(Math.min(MAX_RECONNECT_DELAY_MS, base * jitter));
		this.reconnectAttempt++;
		this.reconnectTimer = this.timers.setTimeout(() => {
			this.reconnectTimer = undefined;
			this.connect();
		}, delayMs);
	}

	private onUpstreamMessage(raw: unknown): void {
		// ComfyUI may send binary preview frames on this same socket. They are not
		// progress messages and are intentionally neither decoded nor forwarded.
		if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_MESSAGE_BYTES) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw) as unknown;
		} catch {
			return;
		}
		const message = asRecord(parsed);
		if (!message || typeof message.type !== "string") return;
		const data = asRecord(message.data);
		if (!data) return;

		switch (message.type) {
			case "status": {
				const status = asRecord(data.status);
				const execInfo = status ? asRecord(status.exec_info) : null;
				const remaining = execInfo ? safeNumber(execInfo.queue_remaining) : undefined;
				if (remaining !== undefined) {
					this.queueEventRevision++;
					this.setState({ queue_remaining: remaining });
				}
				break;
			}
			case "executing": {
				const id = promptId(data);
				if (!id) break;
				const nodeId = data.node === null ? null : safeNodeId(data.node);
				this.applyJob(id, {
					status: "in_progress",
					...(nodeId === null ? { current_node: null } : nodeId ? { current_node: { node_id: nodeId } } : {}),
				}, true);
				break;
			}
			case "progress": {
				const id = promptId(data);
				if (!id) break;
				const value = safeNumber(data.value);
				const max = safeNumber(data.max);
				const nodeId = safeNodeId(data.node);
				this.applyJob(id, {
					status: "in_progress",
					...(nodeId ? { current_node: { node_id: nodeId } } : {}),
					...(value !== undefined && max !== undefined ? { progress: { value, max } } : {}),
				}, true);
				break;
			}
			case "progress_state": {
				const id = promptId(data);
				if (!id) break;
				this.applyJob(id, { status: "in_progress", progress_state: parseProgressState(data.nodes) }, true);
				break;
			}
			case "executed": {
				const id = promptId(data);
				const nodeId = safeNodeId(data.node);
				if (id && nodeId) this.applyJob(id, {
					status: "in_progress",
					current_node: null,
					last_completed_node_id: nodeId,
				}, true);
				break;
			}
			case "execution_success": {
				const id = promptId(data);
				if (id) this.applyJob(id, { status: "completed", current_node: null }, true);
				break;
			}
			case "execution_error": {
				const id = promptId(data);
				if (id) this.applyJob(id, { status: "failed", current_node: null }, true);
				break;
			}
			case "execution_interrupted": {
				const id = promptId(data);
				if (id) this.applyJob(id, { status: "cancelled", current_node: null }, true);
				break;
			}
		}
	}

	private applyJob(jobId: string, patch: JobPatch, ignoreWhenTerminal: boolean): void {
		if (this.closed || !validJobId(jobId)) return;
		const current = this.trackedJobs.get(jobId) ?? {
			job_id: jobId,
			status: "unknown",
			updated_at: new Date(this.now()).toISOString(),
		};
		if (ignoreWhenTerminal && isTerminal(current.status)) return;
		const next: ProgressJob = { ...current };
		if (patch.status !== undefined && canAdvanceStatus(current.status, patch.status)) next.status = patch.status;
		if (patch.workflow_id !== undefined) next.workflow_id = patch.workflow_id;
		if (patch.create_time !== undefined) next.create_time = patch.create_time;
		if (patch.current_node !== undefined) next.current_node = patch.current_node ? { ...patch.current_node } : null;
		if (patch.last_completed_node_id !== undefined) next.last_completed_node_id = patch.last_completed_node_id;
		if (patch.progress !== undefined) next.progress = { ...patch.progress };
		if (patch.progress_state !== undefined) next.progress_state = patch.progress_state.map((node) => ({ ...node }));
		if (isTerminal(next.status) && !isTerminal(current.status)) next.current_node = null;
		if (sameJob(current, next)) return;
		next.updated_at = new Date(this.now()).toISOString();
		this.trackedJobs.set(jobId, next);
		this.trimJobs();
		this.publish("job", { type: "job", sequence: ++this.sequence, job: cloneJob(next) });
	}

	private setState(patch: Partial<ProgressState>): void {
		if (this.closed && patch.upstream !== "closed") return;
		const next = { ...this.state, ...patch };
		if (JSON.stringify(next) === JSON.stringify(this.state)) return;
		this.state = next;
		this.publish("state", { type: "state", sequence: ++this.sequence, state: { ...next } });
	}

	private publish(event: string, payload: unknown): void {
		if (this.closed) return;
		for (const subscriber of [...this.subscribers]) this.send(subscriber, event, payload);
	}

	private send(subscriber: Subscriber, event: string, payload: unknown): void {
		if (!this.subscribers.has(subscriber)) return;
		if (subscriber.signal?.aborted) {
			this.removeSubscriber(subscriber, true);
			return;
		}
		const desiredSize = subscriber.controller.desiredSize;
		if (desiredSize === null || desiredSize <= 0) {
			// EventSource reconnects automatically and receives a fresh snapshot;
			// dropping a slow reader bounds per-client buffering and memory.
			this.removeSubscriber(subscriber, true);
			return;
		}
		const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
		try {
			subscriber.controller.enqueue(new TextEncoder().encode(frame));
		} catch {
			this.removeSubscriber(subscriber, false);
		}
	}

	private ensureHeartbeat(): void {
		if (this.heartbeatTimer !== undefined || this.subscribers.size === 0) return;
		this.heartbeatTimer = this.timers.setInterval(() => {
			const payload = { type: "heartbeat", at: new Date(this.now()).toISOString() };
			for (const subscriber of [...this.subscribers]) this.send(subscriber, "heartbeat", payload);
		}, this.heartbeatIntervalMs);
	}

	private removeSubscriber(subscriber: Subscriber, close: boolean): void {
		if (!this.subscribers.delete(subscriber)) return;
		if (subscriber.signal && subscriber.onAbort) subscriber.signal.removeEventListener("abort", subscriber.onAbort);
		if (close) {
			try {
				subscriber.controller.close();
			} catch {
				// A cancelled stream may already have closed its controller.
			}
		}
		if (this.subscribers.size === 0 && this.heartbeatTimer !== undefined) {
			this.timers.clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
	}

	private trimJobs(): void {
		if (this.trackedJobs.size <= MAX_TRACKED_JOBS) return;
		const oldestFirst = [...this.trackedJobs.values()].sort((left, right) => {
			const leftTerminal = isTerminal(left.status) ? 0 : 1;
			const rightTerminal = isTerminal(right.status) ? 0 : 1;
			return leftTerminal - rightTerminal || Date.parse(left.updated_at) - Date.parse(right.updated_at);
		});
		while (this.trackedJobs.size > MAX_TRACKED_JOBS) {
			const oldest = oldestFirst.shift();
			if (!oldest) break;
			this.trackedJobs.delete(oldest.job_id);
			this.omittedJobs = true;
		}
	}
}

function parseProgressState(value: unknown): ProgressNode[] {
	const nodes = asRecord(value);
	if (!nodes) return [];
	const result: ProgressNode[] = [];
	for (const [key, raw] of Object.entries(nodes).slice(0, MAX_PROGRESS_NODES)) {
		const item = asRecord(raw);
		if (!item) continue;
		const nestedState = asRecord(item.state);
		const nodeId = safeNodeId(item.real_node) ?? safeNodeId(item.display_node) ?? safeNodeId(key);
		if (!nodeId) continue;
		const title = safeLabel(item.display_node) ?? safeLabel(item.title);
		const valueNumber = safeNumber(nestedState?.value ?? item.value);
		const maxNumber = safeNumber(nestedState?.max ?? item.max);
		const state = safeLabel(nestedState?.state ?? item.state);
		result.push({
			node_id: nodeId,
			...(title ? { title } : {}),
			...(state ? { state } : {}),
			...(valueNumber !== undefined ? { value: valueNumber } : {}),
			...(maxNumber !== undefined ? { max: maxNumber } : {}),
		});
	}
	return result;
}

function queueRemaining(queue: Record<string, unknown>): number | null {
	const execInfo = asRecord(queue.exec_info);
	const explicit = execInfo ? safeNumber(execInfo.queue_remaining) : undefined;
	if (explicit !== undefined) return explicit;
	const running = Array.isArray(queue.queue_running) ? queue.queue_running.length : 0;
	const pending = Array.isArray(queue.queue_pending) ? queue.queue_pending.length : 0;
	return running + pending;
}

function promptId(data: Record<string, unknown>): string | null {
	return typeof data.prompt_id === "string" && validJobId(data.prompt_id) ? data.prompt_id : null;
}

function validJobId(value: string): boolean {
	return value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

function safeNodeId(value: unknown): string | null {
	if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
	if (typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value)) return value;
	return null;
}

function safeLabel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const result = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 128);
	return result || undefined;
}

function safeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000_000
		? value
		: undefined;
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function isTerminal(status: string): boolean {
	return TERMINAL_STATUSES.has(status);
}

function statusRank(status: string): number {
	if (isTerminal(status)) return 3;
	if (status === "in_progress") return 2;
	if (status === "pending") return 1;
	return 0;
}

function canAdvanceStatus(current: string, next: string): boolean {
	if (current === next) return true;
	if (isTerminal(current)) return false;
	if (isTerminal(next)) return true;
	return statusRank(next) >= statusRank(current);
}

function sameJob(left: ProgressJob, right: ProgressJob): boolean {
	const leftCopy = { ...left, updated_at: "" };
	const rightCopy = { ...right, updated_at: "" };
	return JSON.stringify(leftCopy) === JSON.stringify(rightCopy);
}

function cloneJob(job: ProgressJob): ProgressJob {
	return {
		...job,
		...(job.current_node !== undefined ? { current_node: job.current_node ? { ...job.current_node } : null } : {}),
		...(job.progress ? { progress: { ...job.progress } } : {}),
		...(job.progress_state ? { progress_state: job.progress_state.map((node) => ({ ...node })) } : {}),
	};
}
