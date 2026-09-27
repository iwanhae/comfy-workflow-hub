import { createHash, randomUUID } from "node:crypto";
import { open, link, rename, stat, unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import { ComfyUpstreamError, HttpError } from "./errors.ts";
import type { ComfyApiClient, ComfyFileReference } from "./comfy-client.ts";
import type { AssetMetadata, HubStore, InputAssetKind, OutputAssetKind, StagedAssetUpload } from "./storage.ts";

const INPUT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface AssetUploadInput {
	uploadId: string;
	kind: InputAssetKind;
	originalAssetId: string | null;
}

export interface AssetUploadResult {
	asset: AssetMetadata;
	statusCode: number;
	reused: boolean;
}

interface SniffedImage {
	contentType: string;
	extension: string;
}

export interface DiscoveredOutput {
	nodeId: string;
	outputKey: string;
	ref: ComfyFileReference;
	kind: OutputAssetKind;
}

interface OutputArchiveTask {
	asset: AssetMetadata;
	ref: ComfyFileReference;
}

export class AssetService {
	private readonly store: HubStore;
	private readonly comfy: ComfyApiClient;
	private readonly maxAssetBytes: number;
	private readonly maxOutputBytes: number;
	private readonly maxConcurrentArchives: number;
	private readonly transferIdleTimeoutMs: number;
	private readonly archiveQueue = new Map<string, OutputArchiveTask>();
	private readonly inFlightArchives = new Map<string, AbortController>();
	private readonly activeArchiveTasks = new Set<Promise<void>>();
	private started = false;
	private stopping = false;

	constructor(options: {
		store: HubStore;
		comfy: ComfyApiClient;
		maxAssetBytes: number;
		maxOutputBytes: number;
		maxConcurrentArchives?: number;
		transferIdleTimeoutMs?: number;
	}) {
		this.store = options.store;
		this.comfy = options.comfy;
		this.maxAssetBytes = options.maxAssetBytes;
		this.maxOutputBytes = options.maxOutputBytes;
		this.maxConcurrentArchives = options.maxConcurrentArchives ?? 2;
		this.transferIdleTimeoutMs = options.transferIdleTimeoutMs ?? 120_000;
	}

	start(): void {
		if (this.started || this.stopping) return;
		this.started = true;
		for (const asset of this.store.listPendingOutputAssets()) {
			const ref = outputReferenceFromAsset(asset);
			if (ref) this.enqueueOutput(asset, ref);
		}
	}

	async close(): Promise<void> {
		if (this.stopping) {
			await Promise.allSettled([...this.activeArchiveTasks]);
			return;
		}
		this.stopping = true;
		this.archiveQueue.clear();
		for (const controller of this.inFlightArchives.values()) {
			controller.abort(new DOMException("Hub is shutting down", "AbortError"));
		}
		await Promise.allSettled([...this.activeArchiveTasks]);
	}

	async upload(input: AssetUploadInput, signal?: AbortSignal): Promise<AssetUploadResult> {
		if (!INPUT_UUID.test(input.uploadId)) throw new HttpError(400, "invalid_upload_id", "upload_id must be a UUID");
		if (input.kind !== "image" && input.kind !== "mask") throw new HttpError(400, "invalid_asset_kind", "kind must be image or mask");
		if (input.kind === "mask" && !input.originalAssetId) {
			throw new HttpError(400, "original_asset_required", "original_asset_id is required for a mask");
		}
		if (input.kind === "image" && input.originalAssetId !== null) {
			throw new HttpError(400, "invalid_request", "original_asset_id is only valid for masks");
		}

		const previous = this.store.getInputAssetByUploadId(input.uploadId);
		if (previous) {
			if (previous.kind !== input.kind || previous.originalAssetId !== input.originalAssetId) {
				throw new HttpError(409, "upload_id_reused", "upload_id was already promoted with different asset metadata");
			}
			return { asset: previous, statusCode: previous.status === "ready" ? 200 : previous.status === "rejected" ? 409 : 202, reused: true };
		}

		const originalAsset = input.kind === "mask" && input.originalAssetId
			? this.store.getMaskOriginalAsset(input.originalAssetId)
			: null;
		if (input.kind === "mask" && !originalAsset) {
			throw new HttpError(400, "invalid_original_asset", "original_asset_id must identify a ready image asset");
		}

		const staged = this.store.claimStagedAssetUpload(input.uploadId);
		const stagedPath = this.store.stagingPath(input.uploadId);
		let linkedPath: string | null = null;
		let asset: AssetMetadata | null = null;
		try {
			if (staged.bytes <= 0) throw new HttpError(400, "empty_asset", "Image and mask assets cannot be empty");
			if (staged.bytes > this.maxAssetBytes) {
				throw new HttpError(413, "asset_too_large", `Asset exceeds the ${this.maxAssetBytes}-byte limit`);
			}
			const info = await stat(stagedPath);
			if (!info.isFile() || info.size !== staged.bytes) {
				throw new HttpError(409, "staged_file_changed", "Staged upload size does not match its record");
			}
			const { sha256, bytes } = await hashFile(stagedPath);
			if (sha256 !== staged.sha256 || bytes !== staged.bytes) {
				throw new HttpError(409, "staged_file_changed", "Staged upload digest does not match its record");
			}
			const sniffed = await sniffImage(stagedPath);
			validateDeclaredImageMime(staged.contentType, sniffed.contentType);

			const id = randomUUID();
			const filename = `${id}.${sniffed.extension}`;
			const storageName = filename;
			const subfolder = `comfy-hub/${id}`;
			const destination = join(this.store.inputAssetsDir, storageName);
			await link(stagedPath, destination);
			linkedPath = destination;
			await syncDirectory(this.store.inputAssetsDir);
			asset = this.store.createInputAsset({
				id,
				kind: input.kind,
				upload: staged,
				sha256,
				bytes,
				contentType: sniffed.contentType,
				storageName,
				originalAssetId: input.originalAssetId,
			});
			await unlink(stagedPath).catch(() => undefined);
			this.store.finishAssetClaim(input.uploadId);

			const originalRef = originalAsset
				? { filename: originalAsset.comfyFilename!, subfolder: originalAsset.comfySubfolder!, type: originalAsset.comfyType! }
				: undefined;
			try {
				const ref = await this.comfy.uploadInputAsset({
					path: destination,
					filename,
					subfolder,
					contentType: sniffed.contentType,
					bytes,
					kind: input.kind,
					...(originalRef ? { originalRef } : {}),
				}, signal);
				validateUploadedRef(ref, subfolder);
				asset = this.store.finishInputAssetUpload(id, ref);
				return { asset, statusCode: 201, reused: false };
			} catch (error) {
				if (isDefinitiveUpstreamRejection(error)) {
					asset = this.store.markInputAssetRejected(id);
					throw new HttpError(502, "comfy_asset_upload_rejected", "ComfyUI rejected the asset upload", {
						asset_id: id,
						upstream_status: error.status,
					});
				}
				asset = this.store.markInputAssetAmbiguous(id);
				return { asset, statusCode: 202, reused: false };
			}
		} catch (error) {
			if (asset) {
				if (asset.status === "uploading") this.store.markInputAssetRejected(asset.id);
			} else {
				await this.store.rejectClaimedAssetUpload(input.uploadId);
				if (linkedPath) await unlink(linkedPath).catch(() => undefined);
			}
			throw error;
		} finally {
			this.store.finishAssetClaim(input.uploadId);
		}
	}

	async archiveCompletedJob(jobId: string, outputs: unknown): Promise<AssetMetadata[]> {
		const discovered = discoverOutputFiles(outputs);
		for (const output of discovered) {
			const id = outputAssetId(jobId, output);
			const extension = safeExtension(output.ref.filename) || "bin";
			const storageName = `${id}.${extension}`;
			const contentType = mimeForExtension(extension) ?? "application/octet-stream";
			let asset = this.store.ensureOutputAsset({
				id,
				kind: output.kind,
				jobId,
				nodeId: output.nodeId,
				outputKey: output.outputKey,
				filename: output.ref.filename,
				subfolder: output.ref.subfolder,
				type: output.ref.type,
				storageName,
				contentType,
			});
			const finalPath = this.store.assetContentPath(asset);
			if (asset.status === "ready" && finalPath && await fileMatches(finalPath, asset.bytes)) continue;
			if (asset.status === "ready") asset = this.store.markOutputAssetPending(id);
			if (asset.status === "pending") this.enqueueOutput(asset, output.ref);
		}
		return this.store.listJobAssets(jobId);
	}

	private enqueueOutput(asset: AssetMetadata, ref: ComfyFileReference): void {
		if (this.stopping || asset.status !== "pending" || this.inFlightArchives.has(asset.id) || this.archiveQueue.has(asset.id)) return;
		this.archiveQueue.set(asset.id, { asset, ref });
		this.dispatchArchives();
	}

	private dispatchArchives(): void {
		while (!this.stopping && this.inFlightArchives.size < this.maxConcurrentArchives && this.archiveQueue.size > 0) {
			const first = this.archiveQueue.entries().next().value as [string, OutputArchiveTask] | undefined;
			if (!first) return;
			const [assetId, task] = first;
			this.archiveQueue.delete(assetId);
			const controller = new AbortController();
			this.inFlightArchives.set(assetId, controller);
			let active!: Promise<void>;
			active = this.archiveOneOutput(task.asset, task.ref, controller.signal)
				.catch(() => {
					// The durable row remains pending. It is retried on a later history
					// discovery or at the next service startup.
				})
				.finally(() => {
					this.inFlightArchives.delete(assetId);
					this.activeArchiveTasks.delete(active);
					this.dispatchArchives();
				})
				.catch(() => undefined);
			this.activeArchiveTasks.add(active);
		}
	}

	private async archiveOneOutput(asset: AssetMetadata, ref: ComfyFileReference, signal: AbortSignal): Promise<void> {
		const finalPath = this.store.assetContentPath(asset);
		if (!finalPath) throw new Error("Output asset has no archive path");
		const response = await this.comfy.getView(ref, signal);
		const rawLength = response.headers.get("content-length");
		const advertisedLength = rawLength === null ? null : Number(rawLength);
		if (advertisedLength !== null && Number.isSafeInteger(advertisedLength) && advertisedLength > this.maxOutputBytes) {
			await response.body?.cancel().catch(() => undefined);
			throw new HttpError(413, "output_too_large", "ComfyUI output exceeds the configured archive limit");
		}
		if (!response.body) throw new Error("ComfyUI returned an empty output stream");
		const tempPath = join(this.store.outputAssetsDir, `.${asset.id}.${randomUUID()}.partial`);
		const file = await open(tempPath, "wx", 0o600);
		const reader = response.body.getReader();
		const hash = createHash("sha256");
		let bytes = 0;
		let closed = false;
		try {
			while (true) {
				if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
				const next = await readWithIdleTimeout(reader, this.transferIdleTimeoutMs, signal);
				if (next.done) break;
				const chunk = Buffer.from(next.value);
				bytes += chunk.byteLength;
				if (bytes > this.maxOutputBytes) {
					await reader.cancel("output exceeds configured archive limit").catch(() => undefined);
					throw new HttpError(413, "output_too_large", "ComfyUI output exceeds the configured archive limit");
				}
				hash.update(chunk);
				let offset = 0;
				while (offset < chunk.byteLength) {
					const result = await file.write(chunk, offset, chunk.byteLength - offset);
					if (result.bytesWritten <= 0) throw new Error("Could not write archived output");
					offset += result.bytesWritten;
				}
			}
			if (advertisedLength !== null && Number.isSafeInteger(advertisedLength) && bytes !== advertisedLength) {
				throw new Error("ComfyUI output byte count did not match its Content-Length");
			}
			await file.sync();
			await file.close();
			closed = true;
			await rename(tempPath, finalPath);
			await syncDirectory(this.store.outputAssetsDir);
			const responseType = normalizedContentType(response.headers.get("content-type"));
			this.store.finishOutputAssetArchive(asset.id, {
				sha256: hash.digest("hex"),
				bytes,
				contentType: mimeForExtension(safeExtension(ref.filename)) ?? responseType ?? asset.contentType ?? "application/octet-stream",
			});
		} catch (error) {
			await reader.cancel(error).catch(() => undefined);
			if (!closed) await file.close().catch(() => undefined);
			await unlink(tempPath).catch(() => undefined);
			throw error;
		} finally {
			reader.releaseLock();
		}
	}
}

export function discoverOutputFiles(outputs: unknown): DiscoveredOutput[] {
	if (!isRecord(outputs)) return [];
	const discovered: DiscoveredOutput[] = [];
	const seen = new Set<string>();
	const mediaKeys = new Set(["images", "videos", "video", "audio", "audios", "files", "file", "gifs", "animations"]);
	for (const [nodeId, nodeOutput] of Object.entries(outputs)) {
		if (!/^[A-Za-z0-9_:-]{1,128}$/.test(nodeId) || !isRecord(nodeOutput)) continue;
		for (const [outputKey, value] of Object.entries(nodeOutput)) {
			if (outputKey.toLowerCase() === "text" || outputKey.toLowerCase() === "texts") continue;
			const visit = (candidate: unknown, inheritedKey: string): void => {
				if (Array.isArray(candidate)) {
					for (const item of candidate) visit(item, inheritedKey);
					return;
				}
				if (!isRecord(candidate)) return;
				if (typeof candidate.filename === "string") {
					const ref = safeOutputRef(candidate);
					if (!ref) return;
					const identity = JSON.stringify([nodeId, ref.filename, ref.subfolder, ref.type]);
					if (!seen.has(identity)) {
						seen.add(identity);
						discovered.push({ nodeId, outputKey: inheritedKey, ref, kind: outputKind(inheritedKey, ref.filename) });
					}
					return;
				}
				for (const [childKey, child] of Object.entries(candidate)) {
					if (childKey.toLowerCase() === "text" || childKey.toLowerCase() === "texts") continue;
					visit(child, mediaKeys.has(childKey.toLowerCase()) ? childKey : inheritedKey);
				}
			};
			visit(value, outputKey);
		}
	}
	return discovered;
}

function outputAssetId(jobId: string, output: DiscoveredOutput): string {
	const digest = createHash("sha256")
		.update(JSON.stringify([jobId, output.nodeId, output.ref.filename, output.ref.subfolder, output.ref.type]))
		.digest("hex");
	return `out_${digest}`;
}

function safeOutputRef(value: Record<string, unknown>): ComfyFileReference | null {
	const filename = value.filename;
	const subfolder = value.subfolder ?? "";
	const type = value.type ?? "output";
	if (typeof filename !== "string" || typeof subfolder !== "string" || typeof type !== "string") return null;
	if (!isSafeFilename(filename) || !isSafeSubfolder(subfolder) || !["output", "temp"].includes(type)) return null;
	return { filename, subfolder, type };
}

function outputReferenceFromAsset(asset: AssetMetadata): ComfyFileReference | null {
	if (asset.origin !== "output" || !asset.sourceFilename || asset.sourceSubfolder === null || !asset.sourceType) return null;
	return safeOutputRef({ filename: asset.sourceFilename, subfolder: asset.sourceSubfolder, type: asset.sourceType });
}

function isSafeFilename(value: string): boolean {
	return value.length > 0 && value.length <= 255 && value !== "." && value !== ".."
		&& !/[\\/\u0000-\u001f\u007f]/.test(value);
}

function isSafeSubfolder(value: string): boolean {
	if (!value) return true;
	if (value.length > 512 || /[\\\u0000-\u001f\u007f]/.test(value)) return false;
	return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function validateUploadedRef(ref: ComfyFileReference, expectedSubfolder: string): void {
	if (!isSafeFilename(ref.filename) || !isSafeSubfolder(ref.subfolder) || ref.subfolder !== expectedSubfolder || ref.type !== "input") {
		throw new Error("ComfyUI returned an unsafe asset reference");
	}
}

async function sniffImage(path: string): Promise<SniffedImage> {
	const bytes = Buffer.from(await Bun.file(path).slice(0, 16).arrayBuffer());
	if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return { contentType: "image/png", extension: "png" };
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return { contentType: "image/jpeg", extension: "jpg" };
	}
	if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
		return { contentType: "image/webp", extension: "webp" };
	}
	if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) {
		return { contentType: "image/gif", extension: "gif" };
	}
	if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
		return { contentType: "image/bmp", extension: "bmp" };
	}
	if (bytes.length >= 4 && (bytes.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00]))
		|| bytes.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])))) {
		return { contentType: "image/tiff", extension: "tif" };
	}
	throw new HttpError(415, "unsupported_image", "Asset bytes are not a supported raster image (PNG, JPEG, WebP, GIF, BMP, or TIFF)");
}

function validateDeclaredImageMime(declared: string, actual: string): void {
	const normalized = declared.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	if (!normalized || normalized === "application/octet-stream" || normalized === "binary/octet-stream") return;
	const alias = normalized === "image/jpg" ? "image/jpeg" : normalized;
	if (alias !== actual) throw new HttpError(415, "image_mime_mismatch", "Declared Content-Type does not match the image bytes");
}

function outputKind(outputKey: string, filename: string): OutputAssetKind {
	const extension = safeExtension(filename);
	if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "avif"].includes(extension)) return "image";
	if (["mp4", "webm", "mov", "mkv", "avi", "m4v"].includes(extension)) return "video";
	if (["wav", "mp3", "flac", "ogg", "opus", "m4a", "aac", "aiff"].includes(extension)) return "audio";
	const key = outputKey.toLowerCase();
	if (key.includes("image") || key === "gifs" || key === "animations") return "image";
	if (key.includes("video")) return "video";
	if (key.includes("audio")) return "audio";
	return "file";
}

function safeExtension(filename: string): string {
	const extension = extname(filename).slice(1).toLowerCase();
	return /^[a-z0-9]{1,12}$/.test(extension) ? extension : "";
}

function mimeForExtension(extension: string): string | null {
	const types: Record<string, string> = {
		png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
		bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", avif: "image/avif",
		mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska", avi: "video/x-msvideo", m4v: "video/x-m4v",
		wav: "audio/wav", mp3: "audio/mpeg", flac: "audio/flac", ogg: "audio/ogg", opus: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", aiff: "audio/aiff",
	};
	return types[extension] ?? null;
}

function normalizedContentType(value: string | null): string | null {
	const type = value?.split(";", 1)[0]?.trim().toLowerCase();
	if (!type || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) return null;
	return type;
}

function isDefinitiveUpstreamRejection(error: unknown): error is ComfyUpstreamError {
	return error instanceof ComfyUpstreamError && error.status >= 400 && error.status < 500
		&& error.status !== 408 && error.status !== 429;
}

async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
	const hash = createHash("sha256");
	let bytes = 0;
	for await (const chunk of Bun.file(path).stream()) {
		const buffer = Buffer.from(chunk);
		hash.update(buffer);
		bytes += buffer.byteLength;
	}
	return { sha256: hash.digest("hex"), bytes };
}

async function fileMatches(path: string, expectedBytes: number | null): Promise<boolean> {
	if (expectedBytes === null) return false;
	try {
		const info = await stat(path);
		return info.isFile() && info.size === expectedBytes;
	} catch {
		return false;
	}
}

async function syncDirectory(path: string): Promise<void> {
	const directory = await open(path, "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

function readWithIdleTimeout<T>(
	reader: { read: () => Promise<T> },
	timeoutMs: number,
	signal: AbortSignal,
): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			callback();
		};
		const timer = setTimeout(() => finish(() => reject(new DOMException("ComfyUI output transfer was idle", "TimeoutError"))), timeoutMs);
		const onAbort = () => finish(() => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError")));
		signal.addEventListener("abort", onAbort, { once: true });
		reader.read().then(
			(value) => finish(() => resolve(value)),
			(error: unknown) => finish(() => reject(error)),
		);
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
