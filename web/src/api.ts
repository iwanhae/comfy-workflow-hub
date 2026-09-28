export interface JobRecord {
	id: string;
	status?: string;
	workflow_id?: string;
	create_time?: number;
	current_node?: ProgressNode | null;
	progress?: { value: number; max: number };
	progress_state?: ProgressNode[];
	execution_error?: unknown;
	submission_error?: unknown;
	outputs?: unknown;
	local_submission_state?: string;
	[key: string]: unknown;
}

export interface ProgressNode {
	node_id: string;
	title?: string;
	state?: string;
	value?: number;
	max?: number;
}

export interface LiveJob extends Omit<JobRecord, "id"> {
	job_id: string;
	updated_at: string;
}

export interface ProgressState {
	upstream: "connecting" | "connected" | "reconnecting" | "closed" | string;
	queue_remaining: number | null;
	last_reconciled_at: string | null;
}

export interface WorkflowMetadata {
	id: string;
	sha256: string;
	filename: string | null;
	name: string | null;
	description: string | null;
	bytes: number;
	createdAt: number;
}

export interface AssetRecord {
	asset_id: string;
	kind: "image" | "mask" | "video" | "audio" | "file";
	origin: "input" | "output";
	status: string;
	sha256: string | null;
	bytes: number | null;
	content_type: string | null;
	original_filename: string | null;
	original_asset_id: string | null;
	filename: string | null;
	workflow_value: string | null;
	job_id: string | null;
	node_id: string | null;
	output_key: string | null;
	download_url: string | null;
	created_at: string;
	updated_at: string;
}

export interface Page<T> {
	items: T[];
	total: number;
	hasMore: boolean;
}

export class HubApiError extends Error {
	readonly status: number;
	readonly code: string | null;
	readonly details: unknown;

	constructor(message: string, status: number, code: string | null = null, details?: unknown) {
		super(message);
		this.name = "HubApiError";
		this.status = status;
		this.code = code;
		this.details = details;
	}
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	let response: Response;
	try {
		response = await fetch(path, { ...init, headers: { accept: "application/json", ...init?.headers } });
	} catch (error) {
		throw new HubApiError(error instanceof Error ? error.message : "Network request failed", 0, "network_error");
	}
	const text = await response.text();
	let value: unknown = null;
	if (text) {
		try {
			value = JSON.parse(text) as unknown;
		} catch {
			if (response.ok) throw new HubApiError("The Hub returned an invalid response.", response.status, "invalid_response");
		}
	}
	if (!response.ok) {
		const body = isRecord(value) && isRecord(value.error) ? value.error : null;
		throw new HubApiError(
			typeof body?.message === "string" ? body.message : `Request failed (${response.status}).`,
			response.status,
			typeof body?.code === "string" ? body.code : null,
			body?.details,
		);
	}
	return value as T;
}

export async function listJobs(offset = 0): Promise<Page<JobRecord>> {
	const data = await request<{ jobs: JobRecord[]; pagination: { total: number; offset: number; has_more: boolean } }>(`/api/v1/jobs?limit=100&offset=${offset}`);
	return { items: data.jobs, total: data.pagination.total, hasMore: data.pagination.has_more };
}

export async function getJob(id: string): Promise<JobRecord> {
	if (isUuid(id)) return request<JobRecord>(`/api/v1/jobs/${encodeURIComponent(id)}`);
	return request<JobRecord>(`/api/v1/comfy/jobs/${encodeURIComponent(id)}`);
}

export async function listWorkflows(offset = 0): Promise<Page<WorkflowMetadata>> {
	const data = await request<{ workflows: WorkflowMetadata[]; total: number; limit: number; offset: number }>(`/api/v1/workflows?limit=100&offset=${offset}`);
	return { items: data.workflows, total: data.total, hasMore: data.offset + data.workflows.length < data.total };
}

export async function getWorkflow(id: string): Promise<{ metadata: WorkflowMetadata; workflow: Record<string, unknown> }> {
	return request(`/api/v1/workflows/${encodeURIComponent(id)}`);
}

export async function listAssets(jobId?: string): Promise<AssetRecord[]> {
	const assets: AssetRecord[] = [];
	let offset = 0;
	while (true) {
		const page = await listAssetPage(offset, jobId);
		assets.push(...page.items);
		if (!page.hasMore || page.items.length === 0) return assets;
		offset += page.items.length;
	}
}

export async function listAssetPage(offset = 0, jobId?: string): Promise<Page<AssetRecord>> {
	const query = new URLSearchParams({ limit: "100", offset: String(offset) });
	if (jobId && isUuid(jobId)) query.set("job_id", jobId);
	const data = await request<{ assets: AssetRecord[]; pagination: { total: number; offset: number; has_more: boolean } }>(`/api/v1/assets?${query.toString()}`);
	return { items: data.assets, total: data.pagination.total, hasMore: data.pagination.has_more };
}

export async function stageAndCommitWorkflow(file: File, name: string, description: string): Promise<WorkflowMetadata> {
	const body = createBrowserFormData();
	body.append("file", file, file.name);
	const staged = await request<{ upload_id: string }>("/api/v1/uploads", { method: "POST", body });
	return request<WorkflowMetadata>("/api/v1/workflows", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			upload_id: staged.upload_id,
			...(name.trim() ? { name: name.trim() } : {}),
			...(description.trim() ? { description: description.trim() } : {}),
		}),
	});
}

export async function stageAndPromoteAsset(file: File, kind: "image" | "mask", originalAssetId?: string): Promise<AssetRecord> {
	const body = createBrowserFormData();
	body.append("file", file, file.name);
	const staged = await request<{ upload_id: string }>("/api/v1/uploads", { method: "POST", body });
	return request<AssetRecord>("/api/v1/assets", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ upload_id: staged.upload_id, kind, ...(kind === "mask" ? { original_asset_id: originalAssetId } : {}) }),
	});
}

export interface JobSubmitResult {
	job_id: string;
	workflow_id: string;
	status: string;
	reused: boolean;
}

export async function submitJob(workflowId: string, clientRequestId: string | null): Promise<JobSubmitResult> {
	return request<JobSubmitResult>("/api/v1/jobs", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ workflow_id: workflowId, ...(clientRequestId ? { client_request_id: clientRequestId } : {}), metadata: { source: "web-ui" } }),
	});
}

export async function cancelPendingJob(id: string): Promise<{ cancelled: boolean | null; outcome: string; status: string }> {
	return request(`/api/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

export async function getHubStatus(): Promise<{ workflow_count: number; comfy_configured: boolean }> {
	return request("/api/v1/status");
}

export async function getComfyQueue(): Promise<Record<string, unknown>> {
	return request("/api/v1/comfy/queue");
}

export async function getComfyStatus(): Promise<Record<string, unknown>> {
	return request("/api/v1/comfy/status");
}

export async function searchNodes(query: string): Promise<{ nodes: Array<Record<string, unknown>>; pagination: { total: number } }> {
	return request(`/api/v1/comfy/nodes/search?${new URLSearchParams({ q: query, limit: "50", offset: "0" })}`);
}

export async function getNode(id: string): Promise<Record<string, unknown>> {
	return request(`/api/v1/comfy/nodes/${encodeURIComponent(id)}`);
}

export async function searchModels(query: string): Promise<{ models: Array<{ folder: string; name: string }>; pagination: { total: number } }> {
	return request(`/api/v1/comfy/models/search?${new URLSearchParams({ q: query, limit: "50", offset: "0" })}`);
}

export async function getModel(folder: string, name: string): Promise<Record<string, unknown>> {
	return request(`/api/v1/comfy/models/${encodeURIComponent(folder)}/${encodeURIComponent(name)}`);
}

export interface KnowledgeEntry { id: string; title: string; body: string; createdAt: number; updatedAt: number }
export async function listKnowledge(): Promise<KnowledgeEntry[]> { return (await request<{entries: KnowledgeEntry[]}>('/api/v1/knowledge')).entries; }
export async function setKnowledge(entry: {id?: string; title: string; body: string}): Promise<KnowledgeEntry> { return request('/api/v1/knowledge', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(entry)}); }
export async function deleteKnowledge(id: string): Promise<void> { await request(`/api/v1/knowledge/${encodeURIComponent(id)}`, {method:'DELETE'}); }

export function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function newRequestId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
		const random = Math.floor(Math.random() * 16);
		return (char === "x" ? random : (random & 0x3) | 0x8).toString(16);
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createBrowserFormData(): FormData {
	return typeof window === "undefined" ? new FormData() : new window.FormData();
}
