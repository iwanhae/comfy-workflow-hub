import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { chmod, link, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { HttpError } from "./errors.ts";

export interface StagedUpload {
	uploadId: string;
	sha256: string;
	bytes: number;
	filename: string;
	contentType: string;
	createdAt: number;
	expiresAt: number;
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

interface StagedRow {
	upload_id: string;
	sha256: string;
	bytes: number;
	filename: string;
	content_type: string;
	created_at: number;
	expires_at: number;
	state: string;
}

interface WorkflowRow {
	id: string;
	sha256: string;
	original_filename: string | null;
	name: string | null;
	description: string | null;
	bytes: number;
	created_at: number;
}

export interface WorkflowUploadMetadata {
	name?: string | null;
	description?: string | null;
}

export type InputAssetKind = "image" | "mask";
export type OutputAssetKind = "image" | "video" | "audio" | "file";
export type AssetKind = InputAssetKind | OutputAssetKind;
export type AssetOrigin = "input" | "output";
export type AssetStatus = "uploading" | "ambiguous" | "ready" | "rejected" | "pending";

export interface AssetMetadata {
	id: string;
	kind: AssetKind;
	origin: AssetOrigin;
	status: AssetStatus;
	sha256: string | null;
	bytes: number | null;
	contentType: string | null;
	originalFilename: string | null;
	storageName: string | null;
	uploadId: string | null;
	originalAssetId: string | null;
	comfyFilename: string | null;
	comfySubfolder: string | null;
	comfyType: string | null;
	jobId: string | null;
	nodeId: string | null;
	outputKey: string | null;
	sourceFilename: string | null;
	sourceSubfolder: string | null;
	sourceType: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface StagedAssetUpload extends StagedUpload {}

interface AssetRow {
	id: string;
	kind: AssetKind;
	origin: AssetOrigin;
	status: AssetStatus;
	sha256: string | null;
	bytes: number | null;
	content_type: string | null;
	original_filename: string | null;
	storage_name: string | null;
	upload_id: string | null;
	original_asset_id: string | null;
	comfy_filename: string | null;
	comfy_subfolder: string | null;
	comfy_type: string | null;
	job_id: string | null;
	node_id: string | null;
	output_key: string | null;
	source_filename: string | null;
	source_subfolder: string | null;
	source_type: string | null;
	created_at: number;
	updated_at: number;
}

function assetFromRow(row: AssetRow): AssetMetadata {
	return {
		id: row.id,
		kind: row.kind,
		origin: row.origin,
		status: row.status,
		sha256: row.sha256,
		bytes: row.bytes,
		contentType: row.content_type,
		originalFilename: row.original_filename,
		storageName: row.storage_name,
		uploadId: row.upload_id,
		originalAssetId: row.original_asset_id,
		comfyFilename: row.comfy_filename,
		comfySubfolder: row.comfy_subfolder,
		comfyType: row.comfy_type,
		jobId: row.job_id,
		nodeId: row.node_id,
		outputKey: row.output_key,
		sourceFilename: row.source_filename,
		sourceSubfolder: row.source_subfolder,
		sourceType: row.source_type,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export type JobSubmissionState = "submitting" | "accepted" | "ambiguous" | "rejected" | "cancelled";

export interface JobSubmission {
	promptId: string;
	workflowId: string;
	clientRequestId: string | null;
	requestFingerprint: string;
	metadata: Record<string, unknown>;
	state: JobSubmissionState;
	createdAt: number;
	updatedAt: number;
	upstreamError: unknown | null;
}

export interface KnowledgeEntry { id: string; title: string; body: string; createdAt: number; updatedAt: number }

interface JobSubmissionRow {
	prompt_id: string;
	workflow_id: string;
	client_request_id: string | null;
	request_fingerprint: string;
	metadata_json: string;
	state: JobSubmissionState;
	created_at: number;
	updated_at: number;
	upstream_error_json: string | null;
}

function metadataFromRow(row: WorkflowRow): WorkflowMetadata {
	return {
		id: row.id,
		sha256: row.sha256,
		filename: row.original_filename,
		name: row.name,
		description: row.description,
		bytes: row.bytes,
		createdAt: row.created_at,
	};
}

function submissionFromRow(row: JobSubmissionRow): JobSubmission {
	return {
		promptId: row.prompt_id,
		workflowId: row.workflow_id,
		clientRequestId: row.client_request_id,
		requestFingerprint: row.request_fingerprint,
		metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
		state: row.state,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		upstreamError: row.upstream_error_json === null ? null : JSON.parse(row.upstream_error_json) as unknown,
	};
}

function workflowPath(root: string, sha256: string): string {
	if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid stored workflow digest");
	return join(root, "workflows", `${sha256}.json`);
}

async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
	const file = Bun.file(path);
	const hash = createHash("sha256");
	let bytes = 0;
	const stream = file.stream();
	for await (const chunk of stream) {
		const buffer = Buffer.from(chunk);
		hash.update(buffer);
		bytes += buffer.byteLength;
	}
	return { sha256: hash.digest("hex"), bytes };
}

export class HubStore {
	readonly db: Database;
	readonly dataDir: string;
	readonly stagingDir: string;
	readonly workflowsDir: string;
	readonly assetsDir: string;
	readonly inputAssetsDir: string;
	readonly outputAssetsDir: string;
	readonly clientId: string;
	private readonly now: () => number;
	private readonly uploadTtlMs: number;
	private readonly recoveryGraceMs: number;
	private readonly activeStaging = new Set<string>();
	private readonly activeClaims = new Set<string>();

	constructor(options: { dataDir: string; uploadTtlMs: number; now?: () => number; recoveryGraceMs?: number }) {
		this.dataDir = options.dataDir;
		this.stagingDir = join(options.dataDir, "staging");
		this.workflowsDir = join(options.dataDir, "workflows");
		this.assetsDir = join(options.dataDir, "assets");
		this.inputAssetsDir = join(this.assetsDir, "inputs");
		this.outputAssetsDir = join(options.dataDir, "outputs");
		this.uploadTtlMs = options.uploadTtlMs;
		this.now = options.now ?? Date.now;
		this.recoveryGraceMs = options.recoveryGraceMs ?? 24 * 60 * 60 * 1000;
		mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
		this.db = new Database(join(options.dataDir, "hub.sqlite"), { create: true });
		this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
		const versionRow = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
		if (versionRow.user_version > 5) throw new Error(`Hub database schema ${versionRow.user_version} is newer than this server`);
		const migrate = this.db.transaction(() => {
			this.db.exec(`
				CREATE TABLE IF NOT EXISTS staged_uploads (
					upload_id TEXT PRIMARY KEY,
					sha256 TEXT NOT NULL,
					bytes INTEGER NOT NULL CHECK (bytes >= 0),
					filename TEXT NOT NULL,
					content_type TEXT NOT NULL,
					created_at INTEGER NOT NULL,
					expires_at INTEGER NOT NULL,
					claimed_at INTEGER,
					state TEXT NOT NULL CHECK (state IN ('ready', 'claimed', 'consumed', 'rejected', 'expired'))
				);
				CREATE INDEX IF NOT EXISTS staged_uploads_expiry ON staged_uploads(state, expires_at);
			`);
			if (versionRow.user_version === 1) {
				// Existing records predate filename retention, so their filename is unknown.
				this.db.exec("ALTER TABLE workflows ADD COLUMN original_filename TEXT");
			} else {
				this.db.exec(`CREATE TABLE IF NOT EXISTS workflows (
					id TEXT PRIMARY KEY,
					sha256 TEXT NOT NULL UNIQUE,
					original_filename TEXT NOT NULL,
					name TEXT,
					description TEXT,
					bytes INTEGER NOT NULL CHECK (bytes > 0),
					created_at INTEGER NOT NULL
				)`);
			}
			this.db.exec("CREATE INDEX IF NOT EXISTS workflows_created ON workflows(created_at DESC, id DESC)");
			if (versionRow.user_version < 3) {
				this.db.exec(`
					CREATE TABLE job_submissions (
						prompt_id TEXT PRIMARY KEY,
						workflow_id TEXT NOT NULL REFERENCES workflows(id),
						client_request_id TEXT UNIQUE,
						request_fingerprint TEXT NOT NULL,
						metadata_json TEXT NOT NULL,
						state TEXT NOT NULL CHECK (state IN ('submitting', 'accepted', 'ambiguous', 'rejected', 'cancelled')),
						created_at INTEGER NOT NULL,
						updated_at INTEGER NOT NULL,
						upstream_error_json TEXT
					);
					CREATE INDEX job_submissions_workflow_created ON job_submissions(workflow_id, created_at DESC);
					CREATE TABLE hub_settings (
						key TEXT PRIMARY KEY,
						value TEXT NOT NULL
					);
				`);
			}
			if (versionRow.user_version < 4) {
				this.db.exec(`
					CREATE TABLE assets (
						id TEXT PRIMARY KEY,
						kind TEXT NOT NULL CHECK (kind IN ('image', 'mask', 'video', 'audio', 'file')),
						origin TEXT NOT NULL CHECK (origin IN ('input', 'output')),
						status TEXT NOT NULL CHECK (status IN ('uploading', 'ambiguous', 'ready', 'rejected', 'pending')),
						sha256 TEXT,
						bytes INTEGER CHECK (bytes IS NULL OR bytes >= 0),
						content_type TEXT,
						original_filename TEXT,
						storage_name TEXT,
						upload_id TEXT UNIQUE,
						original_asset_id TEXT REFERENCES assets(id),
						comfy_filename TEXT,
						comfy_subfolder TEXT,
						comfy_type TEXT,
						job_id TEXT,
						node_id TEXT,
						output_key TEXT,
						source_filename TEXT,
						source_subfolder TEXT,
						source_type TEXT,
						created_at INTEGER NOT NULL,
						updated_at INTEGER NOT NULL,
						CHECK ((origin = 'input' AND upload_id IS NOT NULL) OR (origin = 'output' AND job_id IS NOT NULL AND node_id IS NOT NULL))
					);
					CREATE INDEX assets_created ON assets(created_at DESC, id DESC);
					CREATE INDEX assets_job_node ON assets(job_id, node_id, created_at DESC);
					CREATE UNIQUE INDEX assets_output_identity ON assets(job_id, node_id, source_filename, source_subfolder, source_type)
						WHERE origin = 'output';
				`);
			}
			if (versionRow.user_version < 5) this.db.exec(`
				CREATE TABLE knowledge (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
				CREATE INDEX knowledge_updated ON knowledge(updated_at DESC, id DESC);
				CREATE TABLE job_input_assets (job_id TEXT NOT NULL, asset_id TEXT NOT NULL REFERENCES assets(id), node_id TEXT NOT NULL, input_name TEXT NOT NULL, PRIMARY KEY(job_id, asset_id, node_id, input_name));
				CREATE INDEX job_input_assets_job ON job_input_assets(job_id);
			`);
			this.db.exec("PRAGMA user_version = 5");
		});
		migrate.immediate();
		const clientId = this.db.transaction(() => {
			this.db.prepare("INSERT OR IGNORE INTO hub_settings(key, value) VALUES ('client_id', ?)").run(randomUUID());
			const row = this.db.prepare("SELECT value FROM hub_settings WHERE key = 'client_id'").get() as { value: string } | null;
			if (!row) throw new Error("Durable ComfyUI client id was not created");
			return row.value;
		});
		this.clientId = clientId.immediate();
	}

	async initialize(): Promise<void> {
		await Promise.all([
			mkdir(this.stagingDir, { recursive: true, mode: 0o700 }),
			mkdir(this.workflowsDir, { recursive: true, mode: 0o700 }),
			mkdir(this.inputAssetsDir, { recursive: true, mode: 0o700 }),
			mkdir(this.outputAssetsDir, { recursive: true, mode: 0o700 }),
		]);
		// A process can die after ComfyUI accepted an upload but before its response
		// was committed locally. Such an attempt must never be POSTed a second time.
		this.db.prepare("UPDATE assets SET status = 'ambiguous', updated_at = ? WHERE origin = 'input' AND status = 'uploading'").run(this.now());
		await this.reapExpiredUploads();
		await this.reapPartialOutputArchives();
	}

	private async reapPartialOutputArchives(): Promise<void> {
		const entries = await readdir(this.outputAssetsDir, { withFileTypes: true });
		await Promise.all(entries.map(async (entry) => {
			if (!entry.isFile() || !/^\.out_[a-f0-9]{64}\.[0-9a-f-]{36}\.partial$/.test(entry.name)) return;
			await unlink(join(this.outputAssetsDir, entry.name)).catch(() => undefined);
		}));
	}

	beginStaging(uploadId: string): void {
		this.stagingPath(uploadId);
		this.activeStaging.add(uploadId);
	}

	finishStaging(uploadId: string): void {
		this.activeStaging.delete(uploadId);
	}

	async reapExpiredUploads(): Promise<void> {
		const now = this.now();
		this.db.prepare(`
			UPDATE staged_uploads SET state = 'expired'
			WHERE state = 'ready' AND expires_at <= ?
		`).run(now);

		const staleClaims = this.db.prepare(`
			SELECT upload_id, claimed_at FROM staged_uploads
			WHERE state = 'claimed' AND (claimed_at IS NULL OR claimed_at <= ?)
		`).all(now - this.recoveryGraceMs) as Array<{ upload_id: string; claimed_at: number | null }>;
		const recovered: string[] = [];
		for (const row of staleClaims) {
			if (this.activeClaims.has(row.upload_id)) continue;
			const update = this.db.prepare(`
				UPDATE staged_uploads
				SET state = CASE WHEN expires_at <= ? THEN 'expired' ELSE 'ready' END, claimed_at = NULL
				WHERE upload_id = ? AND state = 'claimed' AND claimed_at IS ?
			`).run(now, row.upload_id, row.claimed_at);
			if (update.changes > 0) recovered.push(row.upload_id);
		}

		for (const uploadId of recovered) {
			const state = this.db.prepare("SELECT state FROM staged_uploads WHERE upload_id = ?").get(uploadId) as { state: string } | null;
			if (state?.state !== "ready") continue;
			try {
				await stat(this.stagingPath(uploadId));
			} catch {
				this.db.prepare("UPDATE staged_uploads SET state = 'rejected' WHERE upload_id = ? AND state = 'ready'").run(uploadId);
			}
		}

		const rows = this.db.prepare("SELECT upload_id, state FROM staged_uploads").all() as Array<{ upload_id: string; state: string }>;
		const states = new Map(rows.map((row) => [row.upload_id, row.state]));
		const protectedUploads = new Set(
			rows.filter((row) => row.state === "ready" || row.state === "claimed").map((row) => row.upload_id),
		);
		for (const uploadId of this.activeStaging) protectedUploads.add(uploadId);
		const files = await readdir(this.stagingDir, { withFileTypes: true });
		await Promise.all(files.map(async (entry) => {
			const match = /^([0-9a-f-]{36})\.upload$/.exec(entry.name);
			if (!entry.isFile() || !match) return;
			const uploadId = match[1]!;
			if (protectedUploads.has(uploadId)) return;
			const state = states.get(uploadId);
			if (state && !["ready", "claimed"].includes(state)) {
				await unlink(this.stagingPath(uploadId)).catch(() => undefined);
				return;
			}
			if (!state && !this.activeStaging.has(uploadId)) {
				const info = await stat(join(this.stagingDir, entry.name)).catch(() => null);
				if (info && info.mtimeMs <= now - this.recoveryGraceMs) {
					await unlink(join(this.stagingDir, entry.name)).catch(() => undefined);
				}
			}
		}));
	}

	async addStagedUpload(input: {
		uploadId: string;
		sha256: string;
		bytes: number;
		filename: string;
		contentType: string;
	}): Promise<StagedUpload> {
		await this.reapExpiredUploads();
		const createdAt = this.now();
		const expiresAt = createdAt + this.uploadTtlMs;
		this.db.prepare(`
			INSERT INTO staged_uploads(upload_id, sha256, bytes, filename, content_type, created_at, expires_at, state)
			VALUES (?, ?, ?, ?, ?, ?, ?, 'ready')
		`).run(input.uploadId, input.sha256, input.bytes, input.filename, input.contentType, createdAt, expiresAt);
		return { ...input, createdAt, expiresAt };
	}

	stagingPath(uploadId: string): string {
		if (!/^[0-9a-f-]{36}$/.test(uploadId)) throw new HttpError(400, "invalid_upload_id", "upload_id must be a UUID");
		return join(this.stagingDir, `${uploadId}.upload`);
	}

	async workflowUpload(uploadId: string, metadata: WorkflowUploadMetadata, maxWorkflowBytes: number): Promise<WorkflowMetadata> {
		const path = this.stagingPath(uploadId);
		const now = this.now();
		const claim = this.db.prepare(`
			UPDATE staged_uploads SET state = 'claimed', claimed_at = ?
			WHERE upload_id = ? AND state = 'ready' AND expires_at > ?
			RETURNING upload_id, sha256, bytes, filename, content_type, created_at, expires_at, state
		`).get(now, uploadId, now) as StagedRow | null;

		if (!claim) {
			const previous = this.db.prepare("SELECT state, expires_at FROM staged_uploads WHERE upload_id = ?").get(uploadId) as
				| Pick<StagedRow, "state" | "expires_at">
				| null;
			if (previous?.state === "expired" || (previous?.state === "ready" && previous.expires_at <= now)) {
				this.db.prepare("UPDATE staged_uploads SET state = 'expired' WHERE upload_id = ? AND state = 'ready'").run(uploadId);
				await unlink(path).catch(() => undefined);
				throw new HttpError(410, "upload_expired", "The staged upload has expired");
			}
			if (previous) throw new HttpError(409, "upload_already_claimed", "The upload_id has already been used");
			throw new HttpError(404, "upload_not_found", "No staged upload exists for this upload_id");
		}
		this.activeClaims.add(uploadId);

		try {
			if (claim.bytes <= 0) throw new HttpError(400, "empty_workflow", "Workflow uploads cannot be empty");
			if (claim.bytes > maxWorkflowBytes) {
				throw new HttpError(413, "workflow_too_large", `Workflow exceeds the ${maxWorkflowBytes}-byte limit`);
			}
			const info = await stat(path);
			if (info.size !== claim.bytes) throw new HttpError(409, "staged_file_changed", "Staged upload size does not match its record");
			const bytes = Buffer.from(await Bun.file(path).arrayBuffer());
			const digest = createHash("sha256").update(bytes).digest("hex");
			if (digest !== claim.sha256) throw new HttpError(409, "staged_file_changed", "Staged upload digest does not match its record");
			let workflow: unknown;
			try {
				workflow = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
			} catch {
				throw new HttpError(400, "invalid_workflow_json", "Staged workflow is not valid UTF-8 JSON");
			}
			validateApiWorkflow(workflow);
			const destination = workflowPath(this.dataDir, claim.sha256);
			await chmod(path, 0o444);
			try {
				await link(path, destination);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const existing = await hashFile(destination);
				if (existing.sha256 !== claim.sha256 || existing.bytes !== claim.bytes) {
					throw new Error("Content-addressed workflow file failed its integrity check");
				}
			}

			const commit = this.db.transaction(() => {
				this.db.prepare(`
					INSERT INTO workflows(id, sha256, original_filename, name, description, bytes, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(sha256) DO NOTHING
				`).run(claim.sha256, claim.sha256, claim.filename, metadata.name ?? null, metadata.description ?? null, claim.bytes, this.now());
				this.db.prepare("UPDATE staged_uploads SET state = 'consumed' WHERE upload_id = ? AND state = 'claimed'").run(uploadId);
				const row = this.db.prepare("SELECT * FROM workflows WHERE sha256 = ?").get(claim.sha256) as WorkflowRow | null;
				if (!row) throw new Error("Workflow commit did not produce a record");
				return metadataFromRow(row);
			});
			const result = commit.immediate();
			await unlink(path).catch(() => undefined);
			return result;
		} catch (error) {
			this.db.prepare("UPDATE staged_uploads SET state = 'rejected' WHERE upload_id = ? AND state = 'claimed'").run(uploadId);
			await unlink(path).catch(() => undefined);
			throw error;
		} finally {
			this.activeClaims.delete(uploadId);
		}
	}

	listWorkflows(limit: number, offset: number): WorkflowMetadata[] {
		const rows = this.db.prepare(`
			SELECT * FROM workflows ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
		`).all(limit, offset) as WorkflowRow[];
		return rows.map(metadataFromRow);
	}

	getWorkflow(id: string): WorkflowMetadata | null {
		if (!/^[a-f0-9]{64}$/.test(id)) return null;
		const row = this.db.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as WorkflowRow | null;
		return row ? metadataFromRow(row) : null;
	}

	workflowContentPath(id: string): string | null {
		const row = this.getWorkflow(id);
		return row ? workflowPath(this.dataDir, row.sha256) : null;
	}

	workflowCount(): number {
		const row = this.db.prepare("SELECT COUNT(*) AS count FROM workflows").get() as { count: number };
		return row.count;
	}

	async readWorkflowContent(id: string): Promise<{ metadata: WorkflowMetadata; workflow: Record<string, unknown>; workflowJson: string }> {
		const metadata = this.getWorkflow(id);
		if (!metadata) throw new HttpError(404, "workflow_not_found", "Workflow not found");
		const path = this.workflowContentPath(id);
		if (!path) throw new HttpError(404, "workflow_not_found", "Workflow not found");
		let bytes: Buffer;
		try {
			bytes = Buffer.from(await Bun.file(path).arrayBuffer());
		} catch {
			throw new HttpError(500, "workflow_storage_error", "Stored workflow content is unavailable");
		}
		const digest = createHash("sha256").update(bytes).digest("hex");
		if (digest !== metadata.sha256 || bytes.byteLength !== metadata.bytes) {
			throw new HttpError(500, "workflow_storage_error", "Stored workflow content failed its integrity check");
		}
		let workflowJson: string;
		let workflow: unknown;
		try {
			workflowJson = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			workflow = JSON.parse(workflowJson);
		} catch {
			throw new HttpError(500, "workflow_storage_error", "Stored workflow content is not valid UTF-8 JSON");
		}
		validateApiWorkflow(workflow);
		return { metadata, workflow, workflowJson };
	}

	getInputAssetByUploadId(uploadId: string): AssetMetadata | null {
		const row = this.db.prepare("SELECT * FROM assets WHERE upload_id = ?").get(uploadId) as AssetRow | null;
		return row ? assetFromRow(row) : null;
	}

	getAsset(id: string): AssetMetadata | null {
		if (!isAssetId(id)) return null;
		const row = this.db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as AssetRow | null;
		return row ? assetFromRow(row) : null;
	}

	getMaskOriginalAsset(id: string): AssetMetadata | null {
		const asset = this.getAsset(id);
		return asset?.kind === "image" && asset.status === "ready" && asset.comfyFilename !== null
			&& asset.comfySubfolder !== null && asset.comfyType !== null
			? asset
			: null;
	}

	claimStagedAssetUpload(uploadId: string): StagedAssetUpload {
		if (!/^[0-9a-f-]{36}$/.test(uploadId)) throw new HttpError(400, "invalid_upload_id", "upload_id must be a UUID");
		const now = this.now();
		const claim = this.db.prepare(`
			UPDATE staged_uploads SET state = 'claimed', claimed_at = ?
			WHERE upload_id = ? AND state = 'ready' AND expires_at > ?
			RETURNING upload_id, sha256, bytes, filename, content_type, created_at, expires_at
		`).get(now, uploadId, now) as Omit<StagedRow, "state"> | null;
		if (!claim) {
			const previous = this.db.prepare("SELECT state, expires_at FROM staged_uploads WHERE upload_id = ?").get(uploadId) as
				| { state: string; expires_at: number }
				| null;
			if (previous?.state === "expired" || (previous?.state === "ready" && previous.expires_at <= now)) {
				this.db.prepare("UPDATE staged_uploads SET state = 'expired' WHERE upload_id = ? AND state = 'ready'").run(uploadId);
				throw new HttpError(410, "upload_expired", "The staged upload has expired");
			}
			if (previous) throw new HttpError(409, "upload_already_claimed", "The upload_id has already been used");
			throw new HttpError(404, "upload_not_found", "No staged upload exists for this upload_id");
		}
		this.activeClaims.add(uploadId);
		return {
			uploadId: claim.upload_id,
			sha256: claim.sha256,
			bytes: claim.bytes,
			filename: claim.filename,
			contentType: claim.content_type,
			createdAt: claim.created_at,
			expiresAt: claim.expires_at,
		};
	}

	finishAssetClaim(uploadId: string): void {
		this.activeClaims.delete(uploadId);
	}

	async rejectClaimedAssetUpload(uploadId: string): Promise<void> {
		this.db.prepare("UPDATE staged_uploads SET state = 'rejected', claimed_at = NULL WHERE upload_id = ? AND state = 'claimed'").run(uploadId);
		this.activeClaims.delete(uploadId);
		await unlink(this.stagingPath(uploadId)).catch(() => undefined);
	}

	createInputAsset(input: {
		id: string;
		kind: InputAssetKind;
		upload: StagedAssetUpload;
		sha256: string;
		bytes: number;
		contentType: string;
		storageName: string;
		originalAssetId: string | null;
	}): AssetMetadata {
		assertAssetId(input.id);
		assertStorageName(input.storageName);
		const now = this.now();
		const commit = this.db.transaction(() => {
			const consumed = this.db.prepare(`
				UPDATE staged_uploads SET state = 'consumed', claimed_at = NULL
				WHERE upload_id = ? AND state = 'claimed'
			`).run(input.upload.uploadId);
			if (consumed.changes === 0) throw new HttpError(409, "upload_already_claimed", "The upload_id has already been used");
			this.db.prepare(`
				INSERT INTO assets(
					id, kind, origin, status, sha256, bytes, content_type, original_filename,
					storage_name, upload_id, original_asset_id, created_at, updated_at
				) VALUES (?, ?, 'input', 'uploading', ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
				input.id,
				input.kind,
				input.sha256,
				input.bytes,
				input.contentType,
				input.upload.filename,
				input.storageName,
				input.upload.uploadId,
				input.originalAssetId,
				now,
				now,
			);
			const row = this.db.prepare("SELECT * FROM assets WHERE id = ?").get(input.id) as AssetRow | null;
			if (!row) throw new Error("Input asset intent was not persisted");
			return assetFromRow(row);
		});
		const asset = commit.immediate();
		this.activeClaims.delete(input.upload.uploadId);
		return asset;
	}

	finishInputAssetUpload(id: string, ref: { filename: string; subfolder: string; type: string }): AssetMetadata {
		return this.updateAsset(id, `
			UPDATE assets SET status = 'ready', comfy_filename = ?, comfy_subfolder = ?, comfy_type = ?, updated_at = ?
			WHERE id = ? AND origin = 'input' AND status = 'uploading'
		`, [ref.filename, ref.subfolder, ref.type, this.now(), id]);
	}

	markInputAssetAmbiguous(id: string): AssetMetadata {
		return this.updateAsset(id, `
			UPDATE assets SET status = 'ambiguous', updated_at = ?
			WHERE id = ? AND origin = 'input' AND status IN ('uploading', 'ambiguous')
		`, [this.now(), id]);
	}

	markInputAssetRejected(id: string): AssetMetadata {
		return this.updateAsset(id, `
			UPDATE assets SET status = 'rejected', updated_at = ?
			WHERE id = ? AND origin = 'input' AND status IN ('uploading', 'ambiguous', 'rejected')
		`, [this.now(), id]);
	}

	ensureOutputAsset(input: {
		id: string;
		kind: OutputAssetKind;
		jobId: string;
		nodeId: string;
		outputKey: string;
		filename: string;
		subfolder: string;
		type: string;
		storageName: string;
		contentType: string;
	}): AssetMetadata {
		assertAssetId(input.id);
		assertStorageName(input.storageName);
		const now = this.now();
		this.db.prepare(`
			INSERT OR IGNORE INTO assets(
				id, kind, origin, status, content_type, original_filename, storage_name,
				job_id, node_id, output_key, source_filename, source_subfolder, source_type,
				created_at, updated_at
			) VALUES (?, ?, 'output', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			input.id,
			input.kind,
			input.contentType,
			input.filename,
			input.storageName,
			input.jobId,
			input.nodeId,
			input.outputKey,
			input.filename,
			input.subfolder,
			input.type,
			now,
			now,
		);
		const row = this.db.prepare("SELECT * FROM assets WHERE id = ?").get(input.id) as AssetRow | null;
		if (!row) throw new Error("Output asset intent was not persisted");
		return assetFromRow(row);
	}

	markOutputAssetPending(id: string): AssetMetadata {
		return this.updateAsset(id, `
			UPDATE assets SET status = 'pending', sha256 = NULL, bytes = NULL, updated_at = ?
			WHERE id = ? AND origin = 'output'
		`, [this.now(), id]);
	}

	finishOutputAssetArchive(id: string, input: { sha256: string; bytes: number; contentType: string }): AssetMetadata {
		return this.updateAsset(id, `
			UPDATE assets SET status = 'ready', sha256 = ?, bytes = ?, content_type = ?, updated_at = ?
			WHERE id = ? AND origin = 'output'
		`, [input.sha256, input.bytes, input.contentType, this.now(), id]);
	}

	listAssets(options: { limit: number; offset: number; jobId?: string }): { assets: AssetMetadata[]; total: number } {
		const rows = options.jobId
			? this.db.prepare("SELECT DISTINCT a.* FROM assets a LEFT JOIN job_input_assets i ON i.asset_id = a.id WHERE a.job_id = ? OR i.job_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?")
				.all(options.jobId, options.jobId, options.limit, options.offset) as AssetRow[]
			: this.db.prepare("SELECT * FROM assets ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?")
				.all(options.limit, options.offset) as AssetRow[];
		const count = options.jobId
			? this.db.prepare("SELECT COUNT(DISTINCT a.id) AS count FROM assets a LEFT JOIN job_input_assets i ON i.asset_id = a.id WHERE a.job_id = ? OR i.job_id = ?").get(options.jobId, options.jobId) as { count: number }
			: this.db.prepare("SELECT COUNT(*) AS count FROM assets").get() as { count: number };
		return { assets: rows.map(assetFromRow), total: count.count };
	}

	listJobAssets(jobId: string): AssetMetadata[] {
		const rows = this.db.prepare("SELECT DISTINCT a.* FROM assets a LEFT JOIN job_input_assets i ON i.asset_id = a.id WHERE a.job_id = ? OR i.job_id = ? ORDER BY a.origin, a.node_id, a.id").all(jobId, jobId) as AssetRow[];
		return rows.map(assetFromRow);
	}

	associateJobInputAssets(jobId: string, workflow: Record<string, unknown>): void {
		const assets = this.db.prepare("SELECT * FROM assets WHERE origin = 'input' AND status = 'ready'").all() as AssetRow[];
		const insert = this.db.prepare("INSERT OR IGNORE INTO job_input_assets(job_id, asset_id, node_id, input_name) VALUES (?, ?, ?, ?)");
		const tx = this.db.transaction(() => {
			for (const [nodeId, rawNode] of Object.entries(workflow)) {
				if (!isRecord(rawNode) || !isRecord(rawNode.inputs)) continue;
				const expectedKind = inputAssetKindForNode(rawNode.class_type);
				if (!expectedKind) continue;
				for (const [inputName, value] of Object.entries(rawNode.inputs)) {
					if (inputName !== "image" || typeof value !== "string") continue;
					const candidates = assets.filter((row) => row.kind === expectedKind && row.comfy_type === "input" && row.comfy_filename !== null
						&& (row.comfy_subfolder ? `${row.comfy_subfolder}/${row.comfy_filename}` === value : row.comfy_filename === value));
					// A bare filename is valid only when unambiguous in the expected loader/kind namespace.
					const unnamespaced = candidates.length === 0 && !value.includes("/")
						? assets.filter((row) => row.kind === expectedKind && row.comfy_type === "input" && row.comfy_filename === value)
						: [];
					const matches = candidates.length ? candidates : unnamespaced;
					if (matches.length === 1) insert.run(jobId, matches[0]!.id, nodeId, inputName);
				}
			}
		});
		tx.immediate();
	}

	listKnowledge(): KnowledgeEntry[] {
		return (this.db.prepare("SELECT * FROM knowledge ORDER BY updated_at DESC, id DESC").all() as Array<{id:string;title:string;body:string;created_at:number;updated_at:number}>).map((r) => ({ id:r.id,title:r.title,body:r.body,createdAt:r.created_at,updatedAt:r.updated_at }));
	}
	getKnowledge(id: string): KnowledgeEntry | null {
		const row = this.db.prepare("SELECT * FROM knowledge WHERE id = ?").get(id) as {id:string;title:string;body:string;created_at:number;updated_at:number} | null;
		return row ? { id:row.id,title:row.title,body:row.body,createdAt:row.created_at,updatedAt:row.updated_at } : null;
	}
	setKnowledge(input: { id?: string; title: string; body: string }): KnowledgeEntry {
		const id = input.id ?? randomUUID(); const now = this.now();
		if (input.id) {
			const result = this.db.prepare("UPDATE knowledge SET title = ?, body = ?, updated_at = ? WHERE id = ?").run(input.title, input.body, now, id);
			if (!result.changes) throw new HttpError(404, "knowledge_not_found", "Knowledge entry not found");
		} else this.db.prepare("INSERT INTO knowledge(id,title,body,created_at,updated_at) VALUES(?,?,?,?,?)").run(id,input.title,input.body,now,now);
		return this.getKnowledge(id)!;
	}
	deleteKnowledge(id: string): void {
		if (!this.db.prepare("DELETE FROM knowledge WHERE id = ?").run(id).changes) throw new HttpError(404, "knowledge_not_found", "Knowledge entry not found");
	}

	listPendingOutputAssets(): AssetMetadata[] {
		const rows = this.db.prepare(`
			SELECT * FROM assets WHERE origin = 'output' AND status = 'pending'
			ORDER BY created_at ASC, id ASC
		`).all() as AssetRow[];
		return rows.map(assetFromRow);
	}

	assetContentPath(asset: AssetMetadata): string | null {
		if (!asset.storageName) return null;
		assertStorageName(asset.storageName);
		const root = asset.origin === "input" ? this.inputAssetsDir : this.outputAssetsDir;
		return join(root, asset.storageName);
	}

	private updateAsset(id: string, sql: string, params: unknown[]): AssetMetadata {
		const result = this.db.prepare(sql).run(...params as never[]);
		if (result.changes === 0) {
			const row = this.db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as AssetRow | null;
			if (!row) throw new Error("Asset record disappeared before it could be updated");
			return assetFromRow(row);
		}
		const row = this.db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as AssetRow | null;
		if (!row) throw new Error("Updated asset could not be read");
		return assetFromRow(row);
	}

	beginJobSubmission(input: {
		promptId: string;
		workflowId: string;
		clientRequestId: string | null;
		requestFingerprint: string;
		metadata: Record<string, unknown>;
	}): { submission: JobSubmission; reused: boolean } {
		const now = this.now();
		const create = this.db.transaction(() => {
			if (input.clientRequestId !== null) {
				const existing = this.db.prepare("SELECT * FROM job_submissions WHERE client_request_id = ?")
					.get(input.clientRequestId) as JobSubmissionRow | null;
				if (existing) {
					if (existing.request_fingerprint !== input.requestFingerprint) {
						throw new HttpError(409, "idempotency_key_reused", "client_request_id was already used with a different workflow or metadata");
					}
					return { submission: submissionFromRow(existing), reused: true };
				}
			}
			this.db.prepare(`
				INSERT INTO job_submissions(
					prompt_id, workflow_id, client_request_id, request_fingerprint, metadata_json,
					state, created_at, updated_at, upstream_error_json
				) VALUES (?, ?, ?, ?, ?, 'submitting', ?, ?, NULL)
			`).run(
				input.promptId,
				input.workflowId,
				input.clientRequestId,
				input.requestFingerprint,
				JSON.stringify(input.metadata),
				now,
				now,
			);
			const row = this.db.prepare("SELECT * FROM job_submissions WHERE prompt_id = ?").get(input.promptId) as JobSubmissionRow | null;
			if (!row) throw new Error("Job submission attempt was not persisted");
			return { submission: submissionFromRow(row), reused: false };
		});
		return create.immediate();
	}

	getJobSubmission(promptId: string): JobSubmission | null {
		const row = this.db.prepare("SELECT * FROM job_submissions WHERE prompt_id = ?").get(promptId) as JobSubmissionRow | null;
		return row ? submissionFromRow(row) : null;
	}

	listJobSubmissions(): JobSubmission[] {
		const rows = this.db.prepare("SELECT * FROM job_submissions ORDER BY created_at DESC, prompt_id DESC").all() as JobSubmissionRow[];
		return rows.map(submissionFromRow);
	}

	updateJobSubmission(promptId: string, state: JobSubmissionState, upstreamError: unknown | null = null): JobSubmission {
		const now = this.now();
		const errorJson = upstreamError === null ? null : JSON.stringify(upstreamError);
		const result = this.db.prepare(`
			UPDATE job_submissions SET state = ?, updated_at = ?, upstream_error_json = ? WHERE prompt_id = ?
		`).run(state, now, errorJson, promptId);
		if (result.changes === 0) throw new Error("Job submission attempt disappeared before it could be updated");
		const row = this.db.prepare("SELECT * FROM job_submissions WHERE prompt_id = ?").get(promptId) as JobSubmissionRow | null;
		if (!row) throw new Error("Updated job submission attempt could not be read");
		return submissionFromRow(row);
	}

	markJobSubmissionAcceptedIfUnresolved(promptId: string): JobSubmission | null {
		this.db.prepare(`
			UPDATE job_submissions SET state = 'accepted', updated_at = ?, upstream_error_json = NULL
			WHERE prompt_id = ? AND state IN ('submitting', 'ambiguous')
		`).run(this.now(), promptId);
		return this.getJobSubmission(promptId);
	}

	replaceJobSubmissionPromptId(oldPromptId: string, promptId: string): JobSubmission {
		const update = this.db.prepare("UPDATE job_submissions SET prompt_id = ?, updated_at = ? WHERE prompt_id = ?")
			.run(promptId, this.now(), oldPromptId);
		if (update.changes === 0) throw new Error("Job submission attempt disappeared before its prompt id could be updated");
		const row = this.db.prepare("SELECT * FROM job_submissions WHERE prompt_id = ?").get(promptId) as JobSubmissionRow | null;
		if (!row) throw new Error("Job submission attempt could not be read after its prompt id was updated");
		return submissionFromRow(row);
	}

	close(): void {
		this.db.close();
	}
}

export function validateApiWorkflow(value: unknown): asserts value is Record<string, { class_type: string; inputs: Record<string, unknown> }> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new HttpError(400, "invalid_workflow_format", "Workflow must be a ComfyUI API-format object");
	}
	const candidate = value as Record<string, unknown>;
	if (Array.isArray(candidate.nodes) || "links" in candidate) {
		throw new HttpError(400, "ui_workflow_not_supported", "UI-format workflows are not accepted; upload an API-format workflow");
	}
	const entries = Object.entries(candidate);
	if (entries.length === 0) throw new HttpError(400, "empty_workflow", "Workflow must contain at least one node");
	for (const [nodeId, node] of entries) {
		if (!nodeId || !node || typeof node !== "object" || Array.isArray(node)) {
			throw new HttpError(400, "invalid_workflow_format", `Workflow node ${nodeId || "<empty>"} is invalid`);
		}
		const record = node as Record<string, unknown>;
		if (typeof record.class_type !== "string" || record.class_type.trim() === "") {
			throw new HttpError(400, "invalid_workflow_format", `Workflow node ${nodeId} is missing class_type`);
		}
		if (!record.inputs || typeof record.inputs !== "object" || Array.isArray(record.inputs)) {
			throw new HttpError(400, "invalid_workflow_format", `Workflow node ${nodeId} is missing an inputs object`);
		}
	}
}

function isAssetId(id: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
		|| /^out_[a-f0-9]{64}$/.test(id);
}

function assertAssetId(id: string): void {
	if (!isAssetId(id)) throw new Error("Invalid asset id");
}

function assertStorageName(name: string): void {
	if (!/^[a-z0-9_-]{1,80}(?:\.[a-z0-9]{1,12})?$/.test(name)) {
		throw new Error("Invalid stored asset name");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inputAssetKindForNode(value: unknown): InputAssetKind | null {
	if (value === "LoadImage") return "image";
	if (value === "LoadImageMask") return "mask";
	return null;
}
