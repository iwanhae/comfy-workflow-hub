import { resolve } from "node:path";

export interface HubConfig {
	dataDir: string;
	host: string;
	port: number;
	comfyBaseUrl: URL;
	maxUploadBytes: number;
	maxAssetBytes: number;
	maxOutputBytes: number;
	maxConcurrentArchives: number;
	transferIdleTimeoutMs: number;
	maxWorkflowBytes: number;
	uploadTtlMs: number;
	upstreamTimeoutMs: number;
}

type Env = Record<string, string | undefined>;

const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_WORKFLOW_BYTES = 10 * 1024 * 1024;

function positiveInteger(env: Env, name: string, fallback: number): number {
	const raw = env[name]?.trim();
	if (!raw) return fallback;
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return parsed;
}

function validateComfyUrl(url: URL): void {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("COMFY_BASE_URL must use http or https");
	}
	if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
		throw new Error("COMFY_BASE_URL must be an origin without credentials, path, query, or fragment");
	}
}

export function loadConfig(env: Env = process.env, cwd = process.cwd()): HubConfig {
	const host = env.HUB_HOST?.trim() || "127.0.0.1";
	const port = positiveInteger(env, "HUB_PORT", 3000);
	if (port > 65_535) throw new Error("HUB_PORT must be between 1 and 65535");

	const rawBaseUrl = env.COMFY_BASE_URL?.trim() || "http://127.0.0.1:8188";
	let comfyBaseUrl: URL;
	try {
		comfyBaseUrl = new URL(rawBaseUrl);
	} catch {
		throw new Error("COMFY_BASE_URL must be a valid absolute URL");
	}
	validateComfyUrl(comfyBaseUrl);

	const maxUploadBytes = positiveInteger(env, "MAX_UPLOAD_BYTES", DEFAULT_MAX_UPLOAD_BYTES);
	const maxAssetBytes = positiveInteger(env, "MAX_ASSET_BYTES", maxUploadBytes);
	const maxOutputBytes = positiveInteger(env, "MAX_OUTPUT_BYTES", DEFAULT_MAX_OUTPUT_BYTES);
	const maxConcurrentArchives = positiveInteger(env, "MAX_CONCURRENT_ARCHIVES", 2);
	if (maxConcurrentArchives > 16) throw new Error("MAX_CONCURRENT_ARCHIVES must be between 1 and 16");
	const transferIdleTimeoutMs = positiveInteger(env, "COMFY_TRANSFER_IDLE_TIMEOUT_MS", 120_000);
	const maxWorkflowBytes = positiveInteger(env, "MAX_WORKFLOW_BYTES", DEFAULT_MAX_WORKFLOW_BYTES);
	if (maxWorkflowBytes > maxUploadBytes) {
		throw new Error("MAX_WORKFLOW_BYTES cannot exceed MAX_UPLOAD_BYTES");
	}

	return {
		dataDir: resolve(cwd, env.DATA_DIR?.trim() || "data"),
		host,
		port,
		comfyBaseUrl,
		maxUploadBytes,
		maxAssetBytes,
		maxOutputBytes,
		maxConcurrentArchives,
		transferIdleTimeoutMs,
		maxWorkflowBytes,
		uploadTtlMs: positiveInteger(env, "UPLOAD_TTL_SECONDS", 15 * 60) * 1000,
		upstreamTimeoutMs: positiveInteger(env, "COMFY_TIMEOUT_MS", 30_000),
	};
}
