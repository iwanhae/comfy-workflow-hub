import { isIP } from "node:net";
import { resolve } from "node:path";

export interface HubConfig {
	dataDir: string;
	host: string;
	port: number;
	hubAllowLan: boolean;
	comfyBaseUrl: URL;
	comfyAllowLan: boolean;
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

function envBoolean(env: Env, name: string, fallback = false): boolean {
	const value = env[name]?.trim().toLowerCase();
	if (value === undefined || value === "") return fallback;
	if (["1", "true", "yes", "on"].includes(value)) return true;
	if (["0", "false", "no", "off"].includes(value)) return false;
	throw new Error(`${name} must be a boolean (true/false)`);
}

function positiveInteger(env: Env, name: string, fallback: number): number {
	const raw = env[name]?.trim();
	if (!raw) return fallback;
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return parsed;
}

function normalizedHostname(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]")
		? hostname.slice(1, -1).toLowerCase()
		: hostname.toLowerCase();
}

export function isLoopbackHost(hostname: string): boolean {
	const host = normalizedHostname(hostname);
	if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
	if (isIP(host) === 4) return host.startsWith("127.");
	return false;
}

export function isPrivateNetworkHost(hostname: string): boolean {
	const host = normalizedHostname(hostname);
	if (isIP(host) === 4) {
		const [a, b] = host.split(".").map(Number);
		return (
			a === 10 ||
			(a === 172 && b! >= 16 && b! <= 31) ||
			(a === 192 && b === 168) ||
			(a === 169 && b === 254)
		);
	}
	if (isIP(host) === 6) {
		return host.startsWith("fc") || host.startsWith("fd") || /^fe[89ab]/.test(host);
	}
	return false;
}

function validateHubBindHost(host: string, allowLan: boolean): void {
	if (host === "0.0.0.0" || host === "::") {
		if (!allowLan) throw new Error("Binding the hub beyond loopback requires HUB_ALLOW_LAN=true");
		return;
	}
	if (isLoopbackHost(host)) return;
	if (allowLan && isPrivateNetworkHost(host)) return;
	throw new Error("HUB_HOST must be loopback unless HUB_ALLOW_LAN=true and it is a private LAN address");
}

function validateComfyUrl(url: URL, allowLan: boolean): void {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("COMFY_BASE_URL must use http or https");
	}
	if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
		throw new Error("COMFY_BASE_URL must be an origin without credentials, path, query, or fragment");
	}
	if (isLoopbackHost(url.hostname)) return;
	if (allowLan && isPrivateNetworkHost(url.hostname)) return;
	throw new Error(
		"COMFY_BASE_URL must target loopback; set COMFY_ALLOW_LAN=true only for a trusted private-LAN ComfyUI host",
	);
}

export function loadConfig(env: Env = process.env, cwd = process.cwd()): HubConfig {
	const hubAllowLan = envBoolean(env, "HUB_ALLOW_LAN");
	const comfyAllowLan = envBoolean(env, "COMFY_ALLOW_LAN");
	const host = env.HUB_HOST?.trim() || "127.0.0.1";
	validateHubBindHost(host, hubAllowLan);
	const port = positiveInteger(env, "HUB_PORT", 3000);
	if (port > 65_535) throw new Error("HUB_PORT must be between 1 and 65535");

	const rawBaseUrl = env.COMFY_BASE_URL?.trim() || "http://127.0.0.1:8188";
	let comfyBaseUrl: URL;
	try {
		comfyBaseUrl = new URL(rawBaseUrl);
	} catch {
		throw new Error("COMFY_BASE_URL must be a valid absolute URL");
	}
	validateComfyUrl(comfyBaseUrl, comfyAllowLan);

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
		hubAllowLan,
		comfyBaseUrl,
		comfyAllowLan,
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

export function isAllowedRequestHost(hostname: string, allowLan: boolean): boolean {
	return isLoopbackHost(hostname) || (allowLan && isPrivateNetworkHost(hostname));
}
