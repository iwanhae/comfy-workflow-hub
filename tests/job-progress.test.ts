import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHubApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { ComfyApiClient, type FetchLike } from "../src/comfy-client.ts";
import { type ProgressTimers, type ProgressWebSocket } from "../src/job-progress.ts";
import { HubStore } from "../src/storage.ts";

const baseUrl = "https://127.0.0.1:8188";

class FakeTimers implements ProgressTimers {
	nowMs = 1_700_000_000_000;
	private nextId = 1;
	private readonly tasks = new Map<number, { callback: () => void; due: number; interval: number | null }>();

	setTimeout(callback: () => void, delayMs: number): unknown {
		return this.add(callback, delayMs, null);
	}

	clearTimeout(timer: unknown): void {
		this.tasks.delete(Number(timer));
	}

	setInterval(callback: () => void, delayMs: number): unknown {
		return this.add(callback, delayMs, delayMs);
	}

	clearInterval(timer: unknown): void {
		this.tasks.delete(Number(timer));
	}

	get activeIntervals(): number {
		return [...this.tasks.values()].filter((task) => task.interval !== null).length;
	}

	get activeTimeouts(): number {
		return [...this.tasks.values()].filter((task) => task.interval === null).length;
	}

	async advance(ms: number): Promise<void> {
		const target = this.nowMs + ms;
		let executions = 0;
		while (true) {
			const next = [...this.tasks.entries()]
				.filter(([, task]) => task.due <= target)
				.sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
			if (!next) break;
			if (++executions > 500) throw new Error("Fake timer runaway");
			const [id, task] = next;
			this.nowMs = task.due;
			if (task.interval === null) this.tasks.delete(id);
			else task.due += task.interval;
			task.callback();
			await flushMicrotasks();
		}
		this.nowMs = target;
		await flushMicrotasks();
	}

	private add(callback: () => void, delayMs: number, interval: number | null): number {
		const id = this.nextId++;
		this.tasks.set(id, { callback, due: this.nowMs + delayMs, interval });
		return id;
	}
}

class FakeSocket implements ProgressWebSocket {
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	closed = false;

	open(): void {
		this.onopen?.(new Event("open"));
	}

	message(data: unknown): void {
		this.onmessage?.({ data } as MessageEvent);
	}

	disconnect(): void {
		this.closed = true;
		this.onclose?.(new CloseEvent("close"));
	}

	close(): void {
		this.closed = true;
	}
}

interface TestEvent {
	event: string;
	data: Record<string, unknown>;
}

interface SseReader {
	read(): Promise<{ done: boolean; value?: Uint8Array }>;
	cancel(): Promise<void>;
}

let root: string;
let store: HubStore;
let config: ReturnType<typeof loadConfig>;
let timers: FakeTimers;
let upstreamJobs: Array<Record<string, unknown>>;
let sockets: FakeSocket[];
let socketUrls: URL[];
let apps: Array<ReturnType<typeof createHubApp>>;

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

function fakeFetch(): FetchLike {
	return async (input) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/jobs") {
			const offset = Number(url.searchParams.get("offset") ?? "0");
			const limit = Number(url.searchParams.get("limit") ?? "100");
			const jobs = upstreamJobs.slice(offset, offset + limit);
			return jsonResponse({
				jobs,
				pagination: { offset, limit, total: upstreamJobs.length, has_more: offset + jobs.length < upstreamJobs.length },
			});
		}
		if (url.pathname === "/queue") return jsonResponse({
			queue_running: [],
			queue_pending: [],
			exec_info: { queue_remaining: 0 },
		});
		throw new Error(`Unexpected progress test request: ${url.pathname}`);
	};
}

function makeApp(fetchImpl = fakeFetch()): ReturnType<typeof createHubApp> {
	const socketsForApp = sockets;
	const app = createHubApp({
		config,
		store,
		comfy: new ComfyApiClient({ baseUrl: new URL(baseUrl), timeoutMs: 500, fetchImpl }),
		jobProgressOptions: {
			webSocketFactory: (url) => {
				socketUrls.push(url);
				const socket = new FakeSocket();
				socketsForApp.push(socket);
				return socket;
			},
			pollIntervalMs: 5_000,
			heartbeatIntervalMs: 15_000,
			reconnectBaseMs: 500,
			now: () => timers.nowMs,
			random: () => 0.5,
			timers,
		},
	});
	apps.push(app);
	return app;
}

async function openFeed(app: ReturnType<typeof createHubApp>, signal?: AbortSignal): Promise<{
	response: Response;
	reader: SseReader;
	initial: TestEvent;
}> {
	const response = await app.fetch(new Request("http://127.0.0.1:3000/api/v1/events", { signal }));
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toContain("text/event-stream");
	const reader = response.body!.getReader() as unknown as SseReader;
	const initial = await readEvent(reader);
	return { response, reader, initial };
}

async function readEvent(reader: SseReader): Promise<TestEvent> {
	const result = await reader.read();
	if (result.done) throw new Error("SSE stream closed before the expected event");
	const text = new TextDecoder().decode(result.value!);
	const event = /^event: ([^\n]+)\ndata: ([^\n]+)\n\n$/.exec(text);
	if (!event) throw new Error(`Invalid SSE frame: ${text}`);
	return { event: event[1]!, data: JSON.parse(event[2]!) as Record<string, unknown> };
}

async function readMatchingEvent(reader: SseReader, match: (event: TestEvent) => boolean): Promise<TestEvent> {
	for (let i = 0; i < 20; i++) {
		const event = await readEvent(reader);
		if (match(event)) return event;
	}
	throw new Error("Did not receive the expected SSE event");
}

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "comfy-hub-progress-test-"));
	config = loadConfig({
		DATA_DIR: join(root, "state"),
		COMFY_BASE_URL: baseUrl,
		MAX_UPLOAD_BYTES: "1048576",
		MAX_WORKFLOW_BYTES: "524288",
	}, root);
	store = new HubStore({ dataDir: config.dataDir, uploadTtlMs: config.uploadTtlMs });
	await store.initialize();
	timers = new FakeTimers();
	upstreamJobs = [];
	sockets = [];
	socketUrls = [];
	apps = [];
});

afterEach(async () => {
	for (const app of apps) await app.close();
	store.close();
	await rm(root, { recursive: true, force: true });
});

describe("shared real-time job progress", () => {
	test("fans the same job delta out to every Hub subscriber over one upstream socket", async () => {
		const app = makeApp();
		const first = await openFeed(app);
		const second = await openFeed(app);
		expect(socketUrls).toHaveLength(1);
		sockets[0]!.open();
		await readMatchingEvent(first.reader, (event) => event.event === "state");
		await readMatchingEvent(second.reader, (event) => event.event === "state");
		sockets[0]!.message(JSON.stringify({ type: "executing", data: { prompt_id: "shared-job", node: "4" } }));
		const firstDelta = await readMatchingEvent(first.reader, (event) => event.event === "job");
		const secondDelta = await readMatchingEvent(second.reader, (event) => event.event === "job");
		expect(firstDelta.data.job).toMatchObject({ job_id: "shared-job", current_node: { node_id: "4" } });
		expect(secondDelta.data.job).toEqual(firstDelta.data.job);
		await first.reader.cancel();
		await second.reader.cancel();
	});

	test("converts the trusted upstream URL and streams keyed node/progress deltas without raw errors", async () => {
		const app = makeApp();
		const { reader, initial } = await openFeed(app);
		expect(initial).toMatchObject({ event: "snapshot", data: { type: "snapshot", jobs: [] } });
		expect(socketUrls).toHaveLength(1);
		expect(socketUrls[0]?.href).toBe(`wss://127.0.0.1:8188/ws?clientId=${store.clientId}`);

		const socket = sockets[0]!;
		socket.open();
		expect((await readEvent(reader)).event).toBe("state");
		socket.message(JSON.stringify({ type: "status", data: { status: { exec_info: { queue_remaining: 3 } } } }));
		expect((await readMatchingEvent(reader, (event) => event.event === "state" && (event.data.state as Record<string, unknown>).queue_remaining === 3)).data.state)
			.toMatchObject({ queue_remaining: 3 });

		const id = "external-job-01";
		socket.message(JSON.stringify({ type: "executing", data: { prompt_id: id, node: "17" } }));
		const executing = await readMatchingEvent(reader, (event) => event.event === "job");
		expect(executing).toMatchObject({ event: "job", data: { job: { job_id: id, status: "in_progress", current_node: { node_id: "17" } } } });

		socket.message(JSON.stringify({ type: "progress", data: { prompt_id: id, node: "17", value: 4, max: 20 } }));
		expect((await readMatchingEvent(reader, (event) => event.event === "job")).data.job).toMatchObject({ progress: { value: 4, max: 20 } });

		socket.message(JSON.stringify({
			type: "progress_state",
			data: { prompt_id: id, nodes: { "17": { display_node: "Sampler", real_node: "17", state: { state: "running", value: 4, max: 20 } } } },
		}));
		const progressStateEvent = await readMatchingEvent(reader, (event) => event.event === "job");
		expect(progressStateEvent.data.job).toMatchObject({ progress_state: [{ node_id: "17", title: "Sampler", state: "running", value: 4, max: 20 }] });

		socket.message(JSON.stringify({ type: "executed", data: { prompt_id: id, node: "17", output: { private: "never forwarded" } } }));
		expect((await readMatchingEvent(reader, (event) => event.event === "job")).data.job).toMatchObject({ last_completed_node_id: "17" });

		socket.message(JSON.stringify({ type: "execution_error", data: { prompt_id: id, exception_message: "private traceback", traceback: "private argv" } }));
		const failed = await readMatchingEvent(reader, (event) => event.event === "job");
		expect(failed.data.job).toMatchObject({ status: "failed" });
		expect(JSON.stringify(failed)).not.toContain("private traceback");
		expect(JSON.stringify(failed)).not.toContain("private argv");

		socket.message(JSON.stringify({ type: "execution_interrupted", data: { prompt_id: "interrupted-job" } }));
		expect((await readMatchingEvent(reader, (event) => event.event === "job")).data.job)
			.toMatchObject({ job_id: "interrupted-job", status: "cancelled" });

		await timers.advance(15_000);
		expect((await readMatchingEvent(reader, (event) => event.event === "heartbeat")).data.type).toBe("heartbeat");
	});

	test("polls externally submitted jobs and reconnect reconciliation recovers a missed completion", async () => {
		const externalId = "external-agent-job";
		const app = makeApp();
		const { reader, initial } = await openFeed(app);
		expect((initial.data.jobs as unknown[])).toHaveLength(0);

		upstreamJobs = [{ id: externalId, status: "pending", create_time: timers.nowMs }];
		await timers.advance(5_000);
		expect((await readEvent(reader)).data.job).toMatchObject({ job_id: externalId, status: "pending" });
		expect((await readEvent(reader)).event).toBe("state");

		sockets[0]!.disconnect();
		expect((await readEvent(reader)).data.state).toMatchObject({ upstream: "reconnecting" });
		upstreamJobs = [{ id: externalId, status: "completed", create_time: timers.nowMs }];
		expect(timers.activeTimeouts).toBe(1);
		await timers.advance(500);
		expect(sockets).toHaveLength(2);
		sockets[1]!.open();
		const stateEvent = await readMatchingEvent(reader, (event) => event.event === "state" && (event.data.state as Record<string, unknown>).upstream === "connected");
		expect(stateEvent).toMatchObject({ event: "state", data: { state: { upstream: "connected" } } });
		const completion = await readMatchingEvent(reader, (event) => event.event === "job");
		expect(completion.data.job).toMatchObject({ job_id: externalId, status: "completed" });
		expect(socketUrls[1]?.searchParams.get("clientId")).toBe(store.clientId);
	});

	test("ignores binary previews and prevents a stale queue snapshot from regressing terminal status", async () => {
		const id = "status-precedence-job";
		upstreamJobs = [{ id, status: "pending", create_time: timers.nowMs }];
		const app = makeApp();
		const { reader } = await openFeed(app);
		sockets[0]!.open();
		expect((await readEvent(reader)).event).toBe("state");

		const binarySuccess = new TextEncoder().encode(JSON.stringify({ type: "execution_success", data: { prompt_id: id } }));
		sockets[0]!.message(binarySuccess);
		sockets[0]!.message(JSON.stringify({ type: "executing", data: { prompt_id: id, node: "2" } }));
		expect((await readMatchingEvent(reader, (event) => event.event === "job")).data.job).toMatchObject({ status: "in_progress" });
		sockets[0]!.message(JSON.stringify({ type: "execution_success", data: { prompt_id: id } }));
		expect((await readMatchingEvent(reader, (event) => event.event === "job")).data.job).toMatchObject({ status: "completed" });

		// A new upstream poll can still return a stale pending row briefly.
		await timers.advance(5_000);
		const second = await openFeed(app);
		const finalJob = (second.initial.data.jobs as Array<Record<string, unknown>>).find((job) => job.job_id === id);
		expect(finalJob?.status).toBe("completed");
	});

	test("checks Origin and Host for SSE, removes aborted/cancelled subscribers, and closes sockets and timers on shutdown", async () => {
		const app = makeApp();
		const crossOrigin = await app.fetch(new Request("http://127.0.0.1:3000/api/v1/events", {
			headers: { origin: "https://attacker.invalid" },
		}));
		expect(crossOrigin.status).toBe(403);
		const wrongHost = await app.fetch(new Request("http://127.0.0.1:3000/api/v1/events", {
			headers: { host: "attacker.invalid:3000" },
		}));
		expect(wrongHost.status).toBe(403);
		const emptyOrigin = await app.fetch(new Request("http://127.0.0.1:3000/api/v1/events", {
			headers: { origin: "" },
		}));
		expect(emptyOrigin.status).toBe(403);
		expect(socketUrls).toHaveLength(0);

		const controller = new AbortController();
		const first = await openFeed(app, controller.signal);
		expect(timers.activeIntervals).toBe(2); // shared poll + one heartbeat
		controller.abort();
		expect(await first.reader.read()).toMatchObject({ done: true });
		expect(timers.activeIntervals).toBe(1);

		const second = await openFeed(app);
		await second.reader.cancel();
		expect(timers.activeIntervals).toBe(1);
		expect(sockets).toHaveLength(1);

		apps = apps.filter((candidate) => candidate !== app);
		await app.close();
		expect(sockets[0]?.closed).toBe(true);
		expect(timers.activeIntervals).toBe(0);
		expect(timers.activeTimeouts).toBe(0);
	});
});
