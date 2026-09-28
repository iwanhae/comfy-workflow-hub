import { afterEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1:3000/" });
Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
Object.defineProperty(globalThis, "MutationObserver", { configurable: true, value: dom.window.MutationObserver });
Object.defineProperty(globalThis, "Event", { configurable: true, value: dom.window.Event });
Object.defineProperty(globalThis, "MouseEvent", { configurable: true, value: dom.window.MouseEvent });
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
	static instances: FakeEventSource[] = [];
	readonly url: string;
	closed = false;
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;
	private readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();

	constructor(url: string) {
		this.url = url;
		FakeEventSource.instances.push(this);
	}

	addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}

	dispatch(type: string, data: unknown): void {
		const event = new dom.window.MessageEvent(type, { data: JSON.stringify(data) }) as unknown as MessageEvent<string>;
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}

	close(): void { this.closed = true; }
}

Object.defineProperty(dom.window, "EventSource", { configurable: true, value: FakeEventSource });
Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeEventSource });

const originalFetch = globalThis.fetch;

const { act, cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { default: App } = await import("../web/src/App.tsx");

const pendingId = "11111111-1111-4111-8111-111111111111";
const runningId = "22222222-2222-4222-8222-222222222222";
const workflowId = "a".repeat(64);
const savedWorkflow = {
	id: workflowId,
	sha256: workflowId,
	filename: "shared-api.json",
	name: "Shared portrait",
	description: "A file-first workflow",
	bytes: 72,
	createdAt: Date.now(),
};
const imageAssetId = "44444444-4444-4444-8444-444444444444";
const imageAsset = {
	asset_id: imageAssetId, kind: "image" as const, origin: "input" as const, status: "ready", sha256: "b".repeat(64), bytes: 128,
	content_type: "image/png", original_filename: "portrait.png", original_asset_id: null, filename: "portrait.png",
	workflow_value: "comfy-hub/source/portrait.png", job_id: null, node_id: null, output_key: null,
	download_url: `/api/v1/assets/${imageAssetId}/content`, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
};

afterEach(() => {
	cleanup();
	dom.reconfigure({ url: "http://127.0.0.1:3000/" });
	FakeEventSource.instances = [];
	globalThis.fetch = originalFetch;
});

function response(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function setFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>): string[] {
	const calls: string[] = [];
	(globalThis as Record<string, unknown>).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input), "http://127.0.0.1:3000");
		calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
		return handler(url, init);
	};
	return calls;
}

function captureWindowIntervals(): { intervals: Array<{ id: number; delay: number; callback: () => void }>; restore: () => void } {
	const intervals: Array<{ id: number; delay: number; callback: () => void }> = [];
	const setDescriptor = Object.getOwnPropertyDescriptor(dom.window, "setInterval");
	const clearDescriptor = Object.getOwnPropertyDescriptor(dom.window, "clearInterval");
	Object.defineProperty(dom.window, "setInterval", {
		configurable: true,
		value: (callback: () => void, delay = 0) => {
			const id = intervals.length + 1;
			intervals.push({ id, delay, callback });
			return id;
		},
	});
	Object.defineProperty(dom.window, "clearInterval", { configurable: true, value: () => undefined });
	return {
		intervals,
		restore: () => {
			if (setDescriptor) Object.defineProperty(dom.window, "setInterval", setDescriptor);
			else Reflect.deleteProperty(dom.window, "setInterval");
			if (clearDescriptor) Object.defineProperty(dom.window, "clearInterval", clearDescriptor);
			else Reflect.deleteProperty(dom.window, "clearInterval");
		},
	};
}

function sharedReads(url: URL): Response | null {
	if (url.pathname === "/api/v1/status") return response({ ok: true, workflow_count: 1, comfy_configured: true });
	if (url.pathname === "/api/v1/comfy/status") return response({ devices: [] });
	if (url.pathname === "/api/v1/comfy/queue") return response({ queue_running: [], queue_pending: [] });
	if (url.pathname.startsWith("/api/v1/assets")) return response({ assets: [], pagination: { total: 0 } });
	if (url.pathname === `/api/v1/workflows/${workflowId}`) return response({ metadata: savedWorkflow, workflow: { "1": { class_type: "EmptyImage", inputs: {} } } });
	return null;
}

describe("shared hub browser flows", () => {
	test("opens job activity details in an overlay with its saved JSON, inputs and outputs", async () => {
		const output = { ...imageAsset, asset_id: "77777777-7777-4777-8777-777777777777", origin: "output", job_id: pendingId, workflow_value: null, original_filename: "result.png" };
		setFetch((url) => {
			const common = url.pathname.startsWith("/api/v1/assets") ? null : sharedReads(url);
			if (common) return common;
			if (url.pathname === "/api/v1/jobs") return response({ jobs: [{ id: pendingId, status: "completed", workflow_id: workflowId, create_time: Date.now() }], pagination: { total: 1, has_more: false } });
			if (url.pathname === `/api/v1/jobs/${pendingId}`) return response({ id: pendingId, status: "completed", workflow_id: workflowId, create_time: Date.now() });
			if (url.pathname === "/api/v1/assets") return response({ assets: [imageAsset, output], pagination: { total: 2, offset: 0, has_more: false } });
			throw new Error(`Unexpected test request: ${url.pathname}`);
		});
		render(<App />);
		fireEvent.click(await screen.findByRole("button", { name: /Saved workflow run · completed/ }));
		const dialog = await screen.findByRole("dialog", { name: /Saved workflow run/ });
		expect(dialog.closest(".detail-backdrop")).toBeTruthy();
		await screen.findByText("Shared portrait");
		expect(screen.getByText("Referenced Hub inputs")).toBeTruthy();
		expect(screen.getByText("result.png")).toBeTruthy();
		expect(screen.getByRole("link", { name: /Original JSON/ }).getAttribute("href")).toBe(`/api/v1/workflows/${workflowId}/content`);
		fireEvent.click(screen.getByText("View API JSON"));
		expect(dialog.textContent).toContain("EmptyImage");
		fireEvent.keyDown(window, { key: "Escape" });
		expect(screen.queryByRole("dialog", { name: /Saved workflow run/ })).toBeNull();
	});

	test("uses SSE snapshot and progress deltas, and only offers cancellation for pending jobs", async () => {
		const calls = setFetch((url, init) => {
			const common = sharedReads(url);
			if (common) return common;
			if (url.pathname === "/api/v1/jobs" && init?.method !== "POST") {
				return response({ jobs: [
					{ id: pendingId, status: "pending", workflow_id: workflowId, create_time: Date.now() },
					{ id: runningId, status: "in_progress", create_time: Date.now() },
				], pagination: { total: 2, has_more: false } });
			}
			if (url.pathname === `/api/v1/jobs/${pendingId}`) return response({ id: pendingId, status: "pending", workflow_id: workflowId, create_time: Date.now() });
			if (url.pathname === `/api/v1/jobs/${runningId}`) return response({ id: runningId, status: "in_progress", create_time: Date.now() });
			if (url.pathname === `/api/v1/jobs/${pendingId}/cancel` && init?.method === "POST") return response({ cancelled: true, status: "cancelled", outcome: "cancelled" });
			throw new Error(`Unexpected test request: ${init?.method ?? "GET"} ${url.pathname}`);
		});

		render(<App />);
		const source = FakeEventSource.instances[0];
		expect(source?.url).toBe("/api/v1/events");
		act(() => {
			source?.dispatch("snapshot", {
				type: "snapshot", sequence: 4, state: { upstream: "connected", queue_remaining: 2, last_reconciled_at: new Date().toISOString() },
				jobs: [{ job_id: runningId, status: "in_progress", current_node: { node_id: "23" }, progress: { value: 4, max: 10 }, updated_at: new Date().toISOString() }],
			});
			source?.dispatch("job", {
				type: "job", sequence: 5,
				job: { job_id: runningId, status: "in_progress", current_node: { node_id: "23" }, progress: { value: 6, max: 10 }, updated_at: new Date().toISOString() },
			});
		});

		await screen.findByText("60% · node 23");
		fireEvent.click(screen.getByRole("button", { name: /External ComfyUI job · in_progress/ }));
		await screen.findByText("Running jobs cannot be cancelled from the Hub.");
		expect(screen.queryByRole("button", { name: "Cancel queued job" })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /Saved workflow run · pending/ }));
		const cancel = await screen.findByRole("button", { name: "Cancel queued job" });
		expect(screen.getByText(/The Hub never interrupts a running job/)).toBeTruthy();
		fireEvent.click(cancel);
		await screen.findByText(/Removed from the pending queue/);
		expect(calls.filter((call) => call === `POST /api/v1/jobs/${pendingId}/cancel`)).toHaveLength(1);
		expect(calls.some((call) => call === `POST /api/v1/jobs/${runningId}/cancel`)).toBe(false);
	});

	test("stages a browser-selected API JSON file, saves it unchanged, then submits by ID with a retry key", async () => {
		let persisted = false;
		const submittedBodies: Array<Record<string, unknown>> = [];
		const calls = setFetch((url, init) => {
			if (url.pathname === "/api/v1/status") return response({ ok: true, workflow_count: persisted ? 1 : 0, comfy_configured: true });
			if (url.pathname === "/api/v1/comfy/status") return response({ devices: [] });
			if (url.pathname === "/api/v1/comfy/queue") return response({ queue_running: [], queue_pending: [] });
			if (url.pathname === "/api/v1/jobs" && init?.method !== "POST") return response({ jobs: [], pagination: { total: 0, has_more: false } });
			if (url.pathname === "/api/v1/workflows" && init?.method !== "POST") return response({ workflows: persisted ? [savedWorkflow] : [], total: persisted ? 1 : 0, limit: 100, offset: 0 });
			if (url.pathname === "/api/v1/uploads" && init?.method === "POST") {
				expect(init.body).toBeInstanceOf(dom.window.FormData);
				const body = init.body as FormData;
				expect(body.get("file")).toBeTruthy();
				return response({ upload_id: "33333333-3333-4333-8333-333333333333", bytes: 72 }, 201);
			}
			if (url.pathname === "/api/v1/workflows" && init?.method === "POST") {
				const body = JSON.parse(String(init.body)) as Record<string, unknown>;
				expect(body).toEqual({ upload_id: "33333333-3333-4333-8333-333333333333", name: "Shared portrait", description: "A file-first workflow" });
				persisted = true;
				return response(savedWorkflow, 201);
			}
			if (url.pathname === "/api/v1/jobs" && init?.method === "POST") {
				submittedBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
				return response({ job_id: pendingId, workflow_id: workflowId, status: "submitted", reused: false }, 201);
			}
			if (url.pathname === `/api/v1/jobs/${pendingId}`) return response({ id: pendingId, status: "pending", workflow_id: workflowId, create_time: Date.now() });
			if (url.pathname.startsWith("/api/v1/assets")) return response({ assets: [], pagination: { total: 0, offset: 0, has_more: false } });
			if (url.pathname === `/api/v1/workflows/${workflowId}`) return response({ metadata: savedWorkflow, workflow: { "1": { class_type: "EmptyImage", inputs: {} } } });
			throw new Error(`Unexpected test request: ${init?.method ?? "GET"} ${url.pathname}`);
		});

		render(<App />);
		fireEvent.click(screen.getByRole("button", { name: "Workflows" }));
		await screen.findByText("No saved workflows yet");
		fireEvent.click(screen.getByRole("button", { name: "Upload workflow" }));
		const file = new dom.window.File(['{"1":{"class_type":"EmptyImage","inputs":{}}}'], "portrait-api.json", { type: "application/json" });
		fireEvent.change(screen.getByLabelText("Workflow JSON file"), { target: { files: [file] } });
		fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: "Shared portrait" } });
		fireEvent.change(screen.getByLabelText(/Notes/), { target: { value: "A file-first workflow" } });
		fireEvent.click(screen.getByRole("button", { name: "Upload & save" }));
		await screen.findByRole("button", { name: /Shared portrait/ });
		expect(screen.getByText("IMMUTABLE VERSION")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: /Shared portrait/ }));
		const requestInput = screen.getByLabelText(/Retry-safe request ID/) as HTMLInputElement;
		const requestId = requestInput.value;
		expect(requestId).toMatch(/^[0-9a-f-]{36}$/i);
		fireEvent.click(screen.getByRole("button", { name: "Submit job" }));
		await screen.findByText(/Job submitted\. Its workflow remains unchanged\./);
		expect(submittedBodies[0]).toEqual({ workflow_id: workflowId, client_request_id: requestId, metadata: { source: "web-ui" } });
		expect(calls.some((call) => call.startsWith("POST /api/v1/uploads"))).toBe(true);
		expect(calls.some((call) => call.startsWith("POST /api/v1/workflows"))).toBe(true);
		expect(calls.some((call) => call.startsWith("POST /api/v1/jobs"))).toBe(true);
		await waitFor(() => expect(screen.getByRole("button", { name: "Cancel queued job" })).toBeTruthy());
	});

	test("upgrades same-host HTTP asset URLs on HTTPS pages without accepting another host", async () => {
		dom.reconfigure({ url: "https://hub.example/assets" });
		setFetch((url) => {
			if (url.pathname === "/api/v1/status") return response({ ok: true, workflow_count: 0, comfy_configured: true });
			if (url.pathname === "/api/v1/comfy/status") return response({ devices: [] });
			if (url.pathname === "/api/v1/comfy/queue") return response({ queue_running: [], queue_pending: [] });
			if (url.pathname === "/api/v1/jobs") return response({ jobs: [], pagination: { total: 0, has_more: false } });
			if (url.pathname === "/api/v1/assets") return response({ assets: [
				{ ...imageAsset, download_url: `http://hub.example/api/v1/assets/${imageAssetId}/content` },
				{ ...imageAsset, asset_id: "55555555-5555-4555-8555-555555555555", download_url: "http://another.example/api/v1/assets/55555555-5555-4555-8555-555555555555/content" },
			], pagination: { total: 2, offset: 0, has_more: false } });
			throw new Error(`Unexpected test request: ${url.pathname}`);
		});
		render(<App />);
		fireEvent.click(screen.getByRole("button", { name: "Assets" }));
		const link = await screen.findByRole("link", { name: /Download original/ });
		expect(link.getAttribute("href")).toBe(`https://hub.example/api/v1/assets/${imageAssetId}/content`);
		expect(screen.getAllByRole("link", { name: /Download original/ })).toHaveLength(1);
	});

	test("enlarges an image in a dialog without downloading it", async () => {
		const calls = setFetch((url) => {
			if (url.pathname === "/api/v1/status") return response({ ok: true, workflow_count: 0, comfy_configured: true });
			if (url.pathname === "/api/v1/comfy/status") return response({ devices: [] });
			if (url.pathname === "/api/v1/comfy/queue") return response({ queue_running: [], queue_pending: [] });
			if (url.pathname === "/api/v1/jobs") return response({ jobs: [], pagination: { total: 0, has_more: false } });
			if (url.pathname === "/api/v1/assets") return response({ assets: [imageAsset], pagination: { total: 1, offset: 0, has_more: false } });
			throw new Error(`Unexpected test request: ${url.pathname}`);
		});
		render(<App />);
		fireEvent.click(screen.getByRole("button", { name: "Assets" }));
		fireEvent.click(await screen.findByRole("button", { name: "Enlarge portrait.png" }));
		const dialog = screen.getByRole("dialog", { name: "Preview portrait.png" });
		expect(dialog.querySelector("img")?.getAttribute("src")).toContain(`/api/v1/assets/${imageAssetId}/content`);
		expect(dialog.querySelector("img")?.hasAttribute("download")).toBe(false);
		expect(dialog.querySelector("a[download]")).toBeTruthy();
		expect(calls.some((call) => call.includes(`/api/v1/assets/${imageAssetId}/content`))).toBe(false);
		fireEvent.keyDown(window, { key: "Escape" });
		expect(screen.queryByRole("dialog", { name: "Preview portrait.png" })).toBeNull();
	});

	test("refreshes a selected job from live status and archive polling without reselecting", async () => {
		const timer = captureWindowIntervals();
		let detailStatus = "pending";
		let assetStatus = "pending";
		let archiveCreated = false;
		let emptyCompletedReads = 0;
		const outputAsset = {
			...imageAsset,
			asset_id: "77777777-7777-4777-8777-777777777777",
			origin: "output" as const,
			status: assetStatus,
			bytes: assetStatus === "ready" ? 64 : null,
			original_filename: "result.png",
			filename: "result.png",
			workflow_value: null,
			job_id: pendingId,
			node_id: "9",
			output_key: "images",
			download_url: "/api/v1/assets/77777777-7777-4777-8777-777777777777/content",
		};
		const calls = setFetch((url, init) => {
			if (url.pathname === "/api/v1/status") return response({ ok: true, workflow_count: 1, comfy_configured: true });
			if (url.pathname === "/api/v1/comfy/status") return response({ devices: [] });
			if (url.pathname === "/api/v1/comfy/queue") return response({ queue_running: [], queue_pending: [] });
			if (url.pathname === "/api/v1/jobs" && init?.method !== "POST") {
				return response({ jobs: [{ id: pendingId, status: detailStatus, workflow_id: workflowId, create_time: Date.now() }], pagination: { total: 1, has_more: false } });
			}
			if (url.pathname === `/api/v1/jobs/${pendingId}`) return response({ id: pendingId, status: detailStatus, workflow_id: workflowId, create_time: Date.now() });
			if (url.pathname === "/api/v1/assets") {
				expect(url.searchParams.get("job_id")).toBe(pendingId);
				if (detailStatus === "completed" && !archiveCreated) emptyCompletedReads++;
				const assets = archiveCreated ? [{ ...outputAsset, status: assetStatus, bytes: assetStatus === "ready" ? 64 : null, download_url: assetStatus === "ready" ? outputAsset.download_url : null }] : [];
				return response({ assets, pagination: { total: assets.length, offset: 0, has_more: false } });
			}
			if (url.pathname === `/api/v1/workflows/${workflowId}`) return response({ metadata: savedWorkflow, workflow: { "1": { class_type: "EmptyImage", inputs: {} } } });
			throw new Error(`Unexpected test request: ${init?.method ?? "GET"} ${url.pathname}`);
		});

		try {
			render(<App />);
			await screen.findByRole("button", { name: /Saved workflow run · pending/ });
			fireEvent.click(screen.getByRole("button", { name: /Saved workflow run · pending/ }));
			await screen.findByRole("button", { name: "Cancel queued job" });
			expect(screen.queryByText("Archiving…")).toBeNull();
			const source = FakeEventSource.instances[0];
			act(() => source?.dispatch("snapshot", {
				type: "snapshot", sequence: 1, state: { upstream: "connected", queue_remaining: 1, last_reconciled_at: new Date().toISOString() },
				jobs: [{ job_id: pendingId, status: "pending", updated_at: new Date().toISOString() }],
			}));

			act(() => source?.dispatch("job", {
				type: "job", sequence: 2,
				job: { job_id: pendingId, status: "in_progress", updated_at: new Date().toISOString() },
			}));
			await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel queued job" })).toBeNull());
			await screen.findByText("Running jobs cannot be cancelled from the Hub.");

			detailStatus = "completed";
			act(() => source?.dispatch("job", {
				type: "job", sequence: 3,
				job: { job_id: pendingId, status: "completed", updated_at: new Date().toISOString() },
			}));
			await waitFor(() => expect(emptyCompletedReads).toBeGreaterThan(0));
			await screen.findByText(/No output assets are recorded yet/);
			expect(screen.getByRole("button", { name: "Refresh outputs" })).toBeTruthy();

			const archivePoll = timer.intervals.find((interval) => interval.delay === 7_500);
			expect(archivePoll).toBeTruthy();
			archiveCreated = true;
			await act(async () => { archivePoll?.callback(); });
			await screen.findByText("Archiving…");

			assetStatus = "ready";
			await act(async () => { archivePoll?.callback(); });
			await screen.findByRole("link", { name: /Download original/ });
			expect(screen.getByText(/1 output ready/)).toBeTruthy();
			const assetReadIndexes = calls.map((call, index) => call.startsWith("GET /api/v1/assets?") ? index : -1).filter((index) => index >= 0);
			expect(assetReadIndexes.every((index) => calls[index - 1] === `GET /api/v1/jobs/${pendingId}`)).toBe(true);
		} finally {
			cleanup();
			timer.restore();
		}
	});

	test("bounds empty-output discovery retries and keeps a manual refresh available", async () => {
		const timer = captureWindowIntervals();
		let outputReads = 0;
		const calls = setFetch((url, init) => {
			if (url.pathname === "/api/v1/status") return response({ ok: true, workflow_count: 0, comfy_configured: true });
			if (url.pathname === "/api/v1/comfy/status") return response({ devices: [] });
			if (url.pathname === "/api/v1/comfy/queue") return response({ queue_running: [], queue_pending: [] });
			if (url.pathname === "/api/v1/jobs" && init?.method !== "POST") return response({ jobs: [{ id: pendingId, status: "completed", create_time: Date.now() }], pagination: { total: 1, has_more: false } });
			if (url.pathname === `/api/v1/jobs/${pendingId}`) return response({ id: pendingId, status: "completed", create_time: Date.now() });
			if (url.pathname === "/api/v1/assets") {
				expect(url.searchParams.get("job_id")).toBe(pendingId);
				outputReads++;
				return response({ assets: [], pagination: { total: 0, offset: 0, has_more: false } });
			}
			throw new Error(`Unexpected test request: ${init?.method ?? "GET"} ${url.pathname}`);
		});

		try {
			render(<App />);
			fireEvent.click(await screen.findByRole("button", { name: /External ComfyUI job · completed/ }));
			await screen.findByRole("button", { name: "Refresh outputs" });
			await waitFor(() => expect(outputReads).toBe(1));
			const poll = timer.intervals.find((interval) => interval.delay === 7_500);
			expect(poll).toBeTruthy();
			for (let expected = 2; expected <= 8; expected++) {
				await act(async () => { poll?.callback(); });
				await waitFor(() => expect(outputReads).toBe(expected));
			}
			await act(async () => { poll?.callback(); });
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(outputReads).toBe(8);

			fireEvent.click(screen.getByRole("button", { name: "Refresh outputs" }));
			await waitFor(() => expect(outputReads).toBe(9));
			expect(calls.filter((call) => call === `GET /api/v1/jobs/${pendingId}`)).toHaveLength(9);
			expect((screen.getByRole("button", { name: "Refresh outputs" }) as HTMLButtonElement).disabled).toBe(false);
		} finally {
			cleanup();
			timer.restore();
		}
	});

	test("keeps pending external jobs read-only", async () => {
		const externalId = "external-prompt-abc";
		const calls = setFetch((url, init) => {
			const common = sharedReads(url);
			if (common) return common;
			if (url.pathname === "/api/v1/jobs" && init?.method !== "POST") return response({ jobs: [{ id: externalId, status: "pending", create_time: Date.now() }], pagination: { total: 1, has_more: false } });
			if (url.pathname === `/api/v1/comfy/jobs/${externalId}`) return response({ id: externalId, status: "pending", create_time: Date.now() });
			throw new Error(`Unexpected test request: ${init?.method ?? "GET"} ${url.pathname}`);
		});

		render(<App />);
		fireEvent.click(await screen.findByRole("button", { name: /External ComfyUI job · pending/ }));
		await screen.findByText("External ComfyUI jobs are read-only in the Hub.");
		expect(screen.queryByRole("button", { name: "Cancel queued job" })).toBeNull();
		expect(calls.some((call) => call.includes("/cancel"))).toBe(false);
	});

	test("ignores a selected-job response that resolves after switching to another job", async () => {
		const firstId = "88888888-8888-4888-8888-888888888888";
		const secondId = "99999999-9999-4999-8999-999999999999";
		let resolveFirst!: (value: Response) => void;
		const firstDetail = new Promise<Response>((resolve) => { resolveFirst = resolve; });
		const calls = setFetch((url, init) => {
			const common = sharedReads(url);
			if (common) return common;
			if (url.pathname === "/api/v1/jobs" && init?.method !== "POST") return response({ jobs: [
				{ id: firstId, status: "pending", workflow_id: workflowId, workflow_name: "First job", create_time: 2 },
				{ id: secondId, status: "pending", workflow_id: workflowId, workflow_name: "Second job", create_time: 1 },
			], pagination: { total: 2, has_more: false } });
			if (url.pathname === `/api/v1/jobs/${firstId}`) return firstDetail;
			if (url.pathname === `/api/v1/jobs/${secondId}`) return response({ id: secondId, status: "pending", workflow_id: workflowId, workflow_name: "Second job", create_time: 1 });
			throw new Error(`Unexpected test request: ${init?.method ?? "GET"} ${url.pathname}`);
		});

		render(<App />);
		fireEvent.click(await screen.findByRole("button", { name: /First job · pending/ }));
		await waitFor(() => expect(calls.some((call) => call === `GET /api/v1/jobs/${firstId}`)).toBe(true));
		fireEvent.click(screen.getByRole("button", { name: /Second job · pending/ }));
		await screen.findByRole("button", { name: "Cancel queued job" });
		expect(document.getElementById("job-detail-title")?.textContent).toBe("Second job");

		resolveFirst(response({ id: firstId, status: "pending", workflow_id: workflowId, workflow_name: "First job", create_time: 2 }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(document.getElementById("job-detail-title")?.textContent).toBe("Second job");
		expect(screen.getByRole("button", { name: "Cancel queued job" })).toBeTruthy();
	});

	test("refreshes the visible assets page so newly archived outputs appear in place", async () => {
		const timer = captureWindowIntervals();
		let assetAvailable = false;
		const visibilityDescriptor = Object.getOwnPropertyDescriptor(dom.window.document, "visibilityState");
		Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, value: "visible" });
		const calls = setFetch((url, init) => {
			if (url.pathname === "/api/v1/status") return response({ ok: true, workflow_count: 0, comfy_configured: true });
			if (url.pathname === "/api/v1/comfy/status") return response({ devices: [] });
			if (url.pathname === "/api/v1/comfy/queue") return response({ queue_running: [], queue_pending: [] });
			if (url.pathname === "/api/v1/jobs" && init?.method !== "POST") return response({ jobs: [], pagination: { total: 0, has_more: false } });
			if (url.pathname === "/api/v1/assets") {
				const assets = assetAvailable ? [imageAsset] : [];
				return response({ assets, pagination: { total: assets.length, offset: 0, has_more: false } });
			}
			throw new Error(`Unexpected test request: ${init?.method ?? "GET"} ${url.pathname}`);
		});

		try {
			render(<App />);
			fireEvent.click(screen.getByRole("button", { name: "Assets" }));
			await screen.findByText("No assets yet");
			assetAvailable = true;
			const assetsPoll = timer.intervals.find((interval) => interval.delay === 10_000);
			expect(assetsPoll).toBeTruthy();
			await act(async () => { assetsPoll?.callback(); });
			await screen.findByRole("button", { name: `Copy workflow value ${imageAsset.workflow_value}` });
			expect(calls.filter((call) => call.startsWith("GET /api/v1/assets?")).length).toBeGreaterThanOrEqual(2);
			expect(screen.getByRole("heading", { name: "Assets in and out." })).toBeTruthy();
		} finally {
			cleanup();
			timer.restore();
			if (visibilityDescriptor) Object.defineProperty(dom.window.document, "visibilityState", visibilityDescriptor);
			else Reflect.deleteProperty(dom.window.document, "visibilityState");
		}
	});

	test("lists jobs newest-first in the activity table and filters statuses", async () => {
		setFetch((url, init) => {
			const common = sharedReads(url);
			if (common) return common;
			if (url.pathname === "/api/v1/jobs" && init?.method !== "POST") return response({ jobs: [
				{ id: "unknown-job", status: "unknown", create_time: 3 },
				{ id: "queued-job", status: "queued", create_time: 2 },
				{ id: "running-job", status: "running", create_time: 1 },
			], pagination: { total: 3, has_more: false } });
			throw new Error(`Unexpected test request: ${init?.method ?? "GET"} ${url.pathname}`);
		});
		render(<App />);
		await screen.findByRole("button", { name: /External ComfyUI job · unknown/ });
		const rows = screen.getAllByRole("button", { name: /External ComfyUI job/ });
		expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
			"External ComfyUI job · unknown", "External ComfyUI job · queued", "External ComfyUI job · running",
		]);
		fireEvent.click(screen.getByRole("button", { name: /^Queue/ }));
		expect(screen.getByRole("button", { name: /External ComfyUI job · queued/ })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /External ComfyUI job · running/ })).toBeNull();
	});

	test("pages server-side in 100-job slices and keeps SSE updates on the visible page", async () => {
		const offsets: number[] = [];
		setFetch((url, init) => {
			const common = sharedReads(url);
			if (common) return common;
			if (url.pathname === "/api/v1/jobs" && init?.method !== "POST") {
				const offset = Number(url.searchParams.get("offset") ?? 0);
				offsets.push(offset);
				const total = 205;
				const jobs = Array.from({ length: Math.max(0, Math.min(100, total - offset)) }, (_, index) => ({
					id: `job-${offset + index}`, status: "completed", create_time: total - offset - index,
				}));
				return response({ jobs, pagination: { total, offset, has_more: offset + jobs.length < total } });
			}
			throw new Error(`Unexpected test request: ${init?.method ?? "GET"} ${url.pathname}`);
		});
		render(<App />);
		await screen.findByText("job-0");
		expect(offsets).toContain(0);
		expect(screen.getByText("Showing 1–100 of 205")).toBeTruthy();
		const source = FakeEventSource.instances[0]!;
		act(() => source.dispatch("job", { sequence: 1, job: { job_id: "job-101", status: "failed", updated_at: new Date().toISOString() } }));
		expect(screen.queryByText("job-101")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Next" }));
		await screen.findByText("Showing 101–200 of 205");
		expect(offsets).toContain(100);
		expect(screen.getByText("job-101")).toBeTruthy();
		act(() => source.dispatch("job", { sequence: 2, job: { job_id: "job-0", status: "failed", updated_at: new Date().toISOString() } }));
		expect(screen.queryByText("job-0")).toBeNull();
	});

	test("requires an original image for mask uploads and displays the copy-ready workflow value", async () => {
		const maskValue = "comfy-hub/mask/mask.png";
		const maskAsset = {
			...imageAsset, asset_id: "55555555-5555-4555-8555-555555555555", kind: "mask" as const,
			original_filename: "portrait-mask.png", filename: "portrait-mask.png", workflow_value: maskValue,
			original_asset_id: imageAssetId,
		};
		let promoted: Record<string, unknown> | null = null;
		const clipboardWrites: string[] = [];
		const clipboardDescriptor = Object.getOwnPropertyDescriptor(dom.window.navigator, "clipboard");
		Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { clipboardWrites.push(value); } } });
		const calls = setFetch((url, init) => {
			if (url.pathname === "/api/v1/status") return response({ ok: true, workflow_count: 0, comfy_configured: true });
			if (url.pathname === "/api/v1/comfy/status") return response({ devices: [] });
			if (url.pathname === "/api/v1/comfy/queue") return response({ queue_running: [], queue_pending: [] });
			if (url.pathname === "/api/v1/jobs" && init?.method !== "POST") return response({ jobs: [], pagination: { total: 0, has_more: false } });
			if (url.pathname.startsWith("/api/v1/assets") && init?.method !== "POST") {
				const assets = promoted ? [imageAsset, maskAsset] : [imageAsset];
				return response({ assets, pagination: { total: assets.length, offset: 0, has_more: false } });
			}
			if (url.pathname === "/api/v1/uploads" && init?.method === "POST") {
				expect(init.body).toBeInstanceOf(dom.window.FormData);
				expect((init.body as FormData).get("file")).toBeTruthy();
				return response({ upload_id: "66666666-6666-4666-8666-666666666666" }, 201);
			}
			if (url.pathname === "/api/v1/assets" && init?.method === "POST") {
				promoted = JSON.parse(String(init.body)) as Record<string, unknown>;
				expect(promoted).toEqual({ upload_id: "66666666-6666-4666-8666-666666666666", kind: "mask", original_asset_id: imageAssetId });
				return response(maskAsset, 201);
			}
			throw new Error(`Unexpected test request: ${init?.method ?? "GET"} ${url.pathname}`);
		});
		try {
			render(<App />);
			fireEvent.click(screen.getByRole("button", { name: "Assets" }));
			await screen.findByRole("button", { name: `Copy workflow value ${imageAsset.workflow_value}` });
			fireEvent.click(screen.getByRole("button", { name: "Upload image or mask" }));
			fireEvent.change(screen.getByLabelText("Asset type"), { target: { value: "mask" } });
			const originalSelect = screen.getByLabelText("Original input image") as HTMLSelectElement;
			expect(originalSelect.options[1]?.value).toBe(imageAssetId);
			const file = new dom.window.File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "portrait-mask.png", { type: "image/png" });
			fireEvent.change(screen.getByLabelText("Image file"), { target: { files: [file] } });
			fireEvent.change(originalSelect, { target: { value: imageAssetId } });
			fireEvent.click(screen.getByRole("button", { name: "Upload asset" }));
			await screen.findByRole("button", { name: `Copy workflow value ${maskValue}` });
			fireEvent.click(screen.getByRole("button", { name: `Copy workflow value ${maskValue}` }));
			await screen.findByText(/Paste it into your local API-format workflow JSON/);
			expect(clipboardWrites).toEqual([maskValue]);
			expect(calls.filter((call) => call.startsWith("POST /api/v1/uploads"))).toHaveLength(1);
			expect(calls.filter((call) => call === "POST /api/v1/assets")).toHaveLength(1);
		} finally {
			if (clipboardDescriptor) Object.defineProperty(dom.window.navigator, "clipboard", clipboardDescriptor);
			else Reflect.deleteProperty(dom.window.navigator, "clipboard");
		}
	});
});
