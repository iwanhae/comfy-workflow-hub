import { realpath, readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { isAllowedRequestHost } from "./config.ts";

const CONTENT_TYPES: Record<string, string> = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".ico": "image/x-icon",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".webmanifest": "application/manifest+json",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

/**
 * Serve a built UI without letting URL paths escape its directory. A missing
 * file falls back to index.html only for known UI routes and HTML navigations;
 * API, MCP, health, and unknown asset requests continue to the Hub handler.
 */
export function createUiStaticHandler(
	distDirectory: string,
	options: { allowLan?: boolean } = {},
): (request: Request) => Promise<Response | null> {
	const rootPath = resolve(distDirectory);
	const allowLan = options.allowLan ?? false;
	let rootPromise: Promise<string> | null = null;
	const getRoot = () => rootPromise ??= realpath(rootPath);

	return async (request) => {
		if (request.method !== "GET" && request.method !== "HEAD") return null;
		const url = new URL(request.url);
		if (isReservedHubPath(url.pathname)) return null;

		const decoded = decodePath(url.pathname);
		if (decoded === null) return notFound(request.method);
		if (isReservedHubPath(decoded)) return null;
		const requestError = uiRequestError(request, allowLan);
		if (requestError) return forbidden(request.method, requestError.code, requestError.message);

		try {
			const root = await getRoot();
			const requestedRelative = decoded === "/" ? "index.html" : decoded.slice(1);
			const candidate = resolve(root, requestedRelative);
			if (!isInside(root, candidate)) return notFound(request.method);
			const existing = await realpath(candidate).catch(() => null);
			if (existing && isInside(root, existing)) {
				const info = await stat(existing);
				if (info.isFile()) return fileResponse(request.method, await readFile(existing), existing, info.size);
			}

			if (isUiRoute(decoded) && (decoded === "/" || acceptsHtml(request))) {
				const index = resolve(root, "index.html");
				const indexRealPath = await realpath(index).catch(() => null);
				if (!indexRealPath || !isInside(root, indexRealPath)) return null;
				const info = await stat(indexRealPath);
				if (!info.isFile()) return null;
				return fileResponse(request.method, await readFile(indexRealPath), indexRealPath, info.size);
			}
		} catch {
			// A dev server or a source-only checkout may not have a production build.
			return null;
		}
		return null;
	};
}

function uiRequestError(request: Request, allowLan: boolean): { code: string; message: string } | null {
	const url = new URL(request.url);
	if (!isAllowedRequestHost(url.hostname, allowLan)) {
		return { code: "host_not_allowed", message: "Request Host must be loopback or an explicitly enabled private-LAN address" };
	}
	const host = request.headers.get("host");
	if (host !== null) {
		try {
			const hostUrl = new URL(`${url.protocol}//${host}`);
			if (hostUrl.username || hostUrl.password || hostUrl.pathname !== "/" || hostUrl.search || hostUrl.hash || hostUrl.origin !== url.origin) {
				throw new Error("host mismatch");
			}
		} catch {
			return { code: "host_not_allowed", message: "Request Host must match the Hub request origin" };
		}
	}
	const origin = request.headers.get("origin");
	if (origin !== null) {
		try {
			if (new URL(origin).origin !== url.origin) throw new Error("origin mismatch");
		} catch {
			return { code: "origin_not_allowed", message: "Cross-origin UI requests are not allowed" };
		}
	}
	return null;
}

function decodePath(pathname: string): string | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return null;
	}
	if (!decoded.startsWith("/") || decoded.includes("\\") || decoded.includes("\0")) return null;
	if (decoded.split("/").some((segment) => segment === "." || segment === "..")) return null;
	return decoded;
}

function isInside(root: string, target: string): boolean {
	const path = relative(root, target);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function isReservedHubPath(pathname: string): boolean {
	return pathname === "/api" || pathname.startsWith("/api/")
		|| pathname === "/mcp" || pathname.startsWith("/mcp/")
		|| pathname === "/health";
}

function isUiRoute(pathname: string): boolean {
	return pathname === "/" || pathname === "/jobs" || pathname === "/workflows"
		|| pathname === "/assets" || pathname === "/catalog"
		|| /^\/jobs\/[0-9a-f-]{36}$/.test(pathname)
		|| /^\/workflows\/[a-f0-9]{64}$/.test(pathname);
}

function acceptsHtml(request: Request): boolean {
	return (request.headers.get("accept") ?? "").toLowerCase().split(",").some((part) => part.trim().startsWith("text/html"));
}

function fileResponse(method: string, bytes: Buffer, path: string, size: number): Response {
	const isIndex = extname(path).toLowerCase() === ".html";
	const headers = new Headers({
		"content-type": CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
		"content-length": String(size),
		"x-content-type-options": "nosniff",
		"cache-control": isIndex ? "no-cache" : "public, max-age=31536000, immutable",
	});
	return new Response(method === "HEAD" ? null : new Uint8Array(bytes), { headers });
}

function notFound(method: string): Response {
	return new Response(method === "HEAD" ? null : "Not found", {
		status: 404,
		headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
	});
}

function forbidden(method: string, code: string, message: string): Response {
	return new Response(method === "HEAD" ? null : JSON.stringify({ error: { code, message } }), {
		status: 403,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		},
	});
}
