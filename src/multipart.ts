import { createHash } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { basename } from "node:path";
import { HttpError } from "./errors.ts";
import { releaseReaderLock } from "./stream-utils.ts";

const MAX_HEADER_BYTES = 8 * 1024;
const STREAM_PIECE_BYTES = 64 * 1024;

export interface MultipartFileResult {
	bytes: number;
	sha256: string;
	filename: string;
	contentType: string;
}

function getBoundary(contentType: string | null): string {
	if (!contentType) throw new HttpError(415, "multipart_required", "Expected multipart/form-data with a file field");
	const match = /^multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
	const boundary = match?.[1] ?? match?.[2];
	if (!boundary || boundary.length > 70 || /[^\x21-\x7e]/.test(boundary)) {
		throw new HttpError(400, "invalid_multipart", "Multipart boundary is missing or invalid");
	}
	return boundary;
}

function parsePartHeaders(value: Buffer): { filename: string; contentType: string } {
	let decoded: string;
	try {
		decoded = new TextDecoder("utf-8", { fatal: true }).decode(value);
	} catch {
		throw new HttpError(400, "invalid_multipart", "Multipart headers must be valid UTF-8");
	}
	const lines = decoded.split("\r\n");
	const headers = new Map<string, string>();
	for (const line of lines) {
		const separator = line.indexOf(":");
		if (separator <= 0) throw new HttpError(400, "invalid_multipart", "Malformed multipart part headers");
		const name = line.slice(0, separator).trim().toLowerCase();
		if (headers.has(name)) throw new HttpError(400, "invalid_multipart", `Duplicate multipart header: ${name}`);
		headers.set(name, line.slice(separator + 1).trim());
	}
	const disposition = headers.get("content-disposition");
	if (!disposition || !/^form-data(?:\s*;|$)/i.test(disposition)) {
		throw new HttpError(400, "invalid_multipart", "Expected one file field named file");
	}
	const nameMatch = /(?:^|;)\s*name=(?:"([^"]*)"|([^;\s]+))/i.exec(disposition);
	if ((nameMatch?.[1] ?? nameMatch?.[2]) !== "file") {
		throw new HttpError(400, "invalid_multipart", "Expected one file field named file");
	}
	const filenameMatch = /(?:^|;)\s*filename=(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))/i.exec(disposition);
	const rawFilename = (filenameMatch?.[1] ?? filenameMatch?.[2] ?? "upload.bin").replace(/\\(.)/g, "$1");
	const filename = basename(rawFilename.replaceAll("\\", "/")).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255) || "upload.bin";
	const contentType = headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
	return { filename, contentType };
}

/**
 * Streams the single supported multipart file field to a new file. Only a
 * bounded boundary/header tail and at most one 64 KiB input piece are held in
 * memory; upload contents are never accumulated as a whole.
 */
export async function streamMultipartFile(
	request: Request,
	destination: string,
	maxBytes: number,
): Promise<MultipartFileResult> {
	const boundary = getBoundary(request.headers.get("content-type"));
	if (!request.body) throw new HttpError(400, "empty_upload", "Multipart request body is empty");
	const opening = Buffer.from(`--${boundary}\r\n`, "ascii");
	const marker = Buffer.from(`\r\n--${boundary}`, "ascii");
	const maxRequestBytes = maxBytes + MAX_HEADER_BYTES + boundary.length + 256;
	const declaredLength = Number(request.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxRequestBytes) {
		throw new HttpError(413, "upload_too_large", `Upload exceeds the ${maxBytes}-byte limit`);
	}

	const file = await open(destination, "wx", 0o600);
	const hash = createHash("sha256");
	const reader = request.body.getReader();
	let bytes = 0;
	let requestBytes = 0;
	let headerBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	let bodyBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	let trailingBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	let part: { filename: string; contentType: string } | undefined;
	let state: "headers" | "body" | "trailing" = "headers";
	let complete = false;

	const writePayload = async (chunk: Buffer): Promise<void> => {
		if (chunk.length === 0) return;
		bytes += chunk.length;
		if (bytes > maxBytes) throw new HttpError(413, "upload_too_large", `Upload exceeds the ${maxBytes}-byte limit`);
		hash.update(chunk);
		let written = 0;
		while (written < chunk.length) {
			const result = await file.write(chunk, written, chunk.length - written);
			if (result.bytesWritten <= 0) throw new Error("Could not write staged upload");
			written += result.bytesWritten;
		}
	};

	const processBody = async (chunk: Buffer): Promise<void> => {
		bodyBuffer = bodyBuffer.length ? Buffer.concat([bodyBuffer, chunk]) : chunk;
		let searchFrom = 0;
		while (true) {
			const candidate = bodyBuffer.indexOf(marker, searchFrom);
			if (candidate === -1) break;
			const suffixAt = candidate + marker.length;
			if (bodyBuffer.length < suffixAt + 2) {
				await writePayload(bodyBuffer.subarray(0, candidate));
				bodyBuffer = bodyBuffer.subarray(candidate);
				return;
			}
			const suffix = bodyBuffer.subarray(suffixAt, suffixAt + 2).toString("ascii");
			if (suffix === "--") {
				await writePayload(bodyBuffer.subarray(0, candidate));
				trailingBuffer = bodyBuffer.subarray(suffixAt + 2);
				bodyBuffer = Buffer.alloc(0);
				state = "trailing";
				complete = true;
				return;
			}
			if (suffix === "\r\n") {
				throw new HttpError(400, "invalid_multipart", "Only one multipart file field is supported");
			}
			searchFrom = candidate + 1;
		}

		const retain = marker.length + 1;
		if (bodyBuffer.length > retain) {
			const safeLength = bodyBuffer.length - retain;
			await writePayload(bodyBuffer.subarray(0, safeLength));
			bodyBuffer = bodyBuffer.subarray(safeLength);
		}
	};

	const processPiece = async (piece: Buffer): Promise<void> => {
		if (state === "trailing") {
			trailingBuffer = trailingBuffer.length ? Buffer.concat([trailingBuffer, piece]) : piece;
			if (trailingBuffer.length > 2 || !Buffer.from("\r\n").subarray(0, trailingBuffer.length).equals(trailingBuffer)) {
				throw new HttpError(400, "invalid_multipart", "Unexpected multipart epilogue");
			}
			return;
		}
		if (state === "headers") {
			headerBuffer = headerBuffer.length ? Buffer.concat([headerBuffer, piece]) : piece;
			const separatorAt = headerBuffer.indexOf("\r\n\r\n");
			if (separatorAt === -1) {
				if (headerBuffer.length > MAX_HEADER_BYTES) throw new HttpError(413, "multipart_headers_too_large", "Multipart headers exceed the limit");
				return;
			}
			if (separatorAt > MAX_HEADER_BYTES || !headerBuffer.subarray(0, opening.length).equals(opening)) {
				throw new HttpError(400, "invalid_multipart", "Malformed multipart opening boundary or headers");
			}
			part = parsePartHeaders(headerBuffer.subarray(opening.length, separatorAt));
			const firstPayload = headerBuffer.subarray(separatorAt + 4);
			headerBuffer = Buffer.alloc(0);
			state = "body";
			await processBody(firstPayload);
			return;
		}
		await processBody(piece);
	};

	try {
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			const incoming = result.value;
			requestBytes += incoming.byteLength;
			if (requestBytes > maxRequestBytes) throw new HttpError(413, "upload_too_large", `Upload exceeds the ${maxBytes}-byte limit`);
			for (let offset = 0; offset < incoming.byteLength; offset += STREAM_PIECE_BYTES) {
				await processPiece(Buffer.from(incoming.subarray(offset, Math.min(offset + STREAM_PIECE_BYTES, incoming.byteLength))));
			}
		}
		if (!complete) {
			throw new HttpError(400, "invalid_multipart", "Multipart file is missing its closing boundary");
		}
		if (trailingBuffer.length !== 0 && !trailingBuffer.equals(Buffer.from("\r\n"))) {
			throw new HttpError(400, "invalid_multipart", "Unexpected multipart epilogue");
		}
		if (!part) throw new HttpError(400, "invalid_multipart", "Multipart file field is missing");
		await file.sync();
		await file.close();
		return { bytes, sha256: hash.digest("hex"), ...part };
	} catch (error) {
		await reader.cancel(error).catch(() => undefined);
		await file.close().catch(() => undefined);
		await unlink(destination).catch(() => undefined);
		throw error;
	} finally {
		releaseReaderLock(reader);
	}
}
