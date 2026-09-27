import { createHash } from "node:crypto";
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
	private readonly now: () => number;
	private readonly uploadTtlMs: number;
	private readonly recoveryGraceMs: number;
	private readonly activeStaging = new Set<string>();
	private readonly activeClaims = new Set<string>();

	constructor(options: { dataDir: string; uploadTtlMs: number; now?: () => number; recoveryGraceMs?: number }) {
		this.dataDir = options.dataDir;
		this.stagingDir = join(options.dataDir, "staging");
		this.workflowsDir = join(options.dataDir, "workflows");
		this.uploadTtlMs = options.uploadTtlMs;
		this.now = options.now ?? Date.now;
		this.recoveryGraceMs = options.recoveryGraceMs ?? 24 * 60 * 60 * 1000;
		mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
		this.db = new Database(join(options.dataDir, "hub.sqlite"), { create: true });
		this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
		const versionRow = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
		if (versionRow.user_version > 2) throw new Error(`Hub database schema ${versionRow.user_version} is newer than this server`);
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
			this.db.exec("PRAGMA user_version = 2");
		});
		migrate.immediate();
	}

	async initialize(): Promise<void> {
		await Promise.all([
			mkdir(this.stagingDir, { recursive: true, mode: 0o700 }),
			mkdir(this.workflowsDir, { recursive: true, mode: 0o700 }),
		]);
		await this.reapExpiredUploads();
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
