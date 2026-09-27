import { afterEach, describe, expect, test } from "bun:test";
import { symlink, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiStaticHandler } from "../src/ui-static.ts";

let roots: string[] = [];

async function makeDist(): Promise<{ root: string; outside: string }> {
	const parent = await mkdtemp(join(tmpdir(), "comfy-ui-static-"));
	roots.push(parent);
	const root = join(parent, "dist");
	const outside = join(parent, "private.txt");
	await mkdir(root);
	await writeFile(join(root, "index.html"), "<main>hub app</main>");
	await mkdir(join(root, "assets"));
	await writeFile(join(root, "assets", "bundle.js"), "console.log('built');");
	await writeFile(outside, "private data");
	return { root, outside };
}

afterEach(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
	roots = [];
});

describe("production UI static handler", () => {
	test("serves the built app and static assets, and falls back only for UI HTML routes", async () => {
		const { root } = await makeDist();
		const serve = createUiStaticHandler(root);
		const home = await serve(new Request("http://127.0.0.1:3000/"));
		expect(home?.status).toBe(200);
		expect(await home?.text()).toBe("<main>hub app</main>");
		expect(home?.headers.get("content-type")).toBe("text/html; charset=utf-8");

		const deepLink = await serve(new Request("http://127.0.0.1:3000/workflows", { headers: { accept: "text/html" } }));
		expect(await deepLink?.text()).toBe("<main>hub app</main>");
		const jobDeepLink = await serve(new Request("http://127.0.0.1:3000/jobs/11111111-1111-4111-8111-111111111111", { headers: { accept: "text/html" } }));
		expect(await jobDeepLink?.text()).toBe("<main>hub app</main>");
		const script = await serve(new Request("http://127.0.0.1:3000/assets/bundle.js"));
		expect(await script?.text()).toContain("console.log");
		expect(script?.headers.get("content-type")).toBe("text/javascript; charset=utf-8");

		expect(await serve(new Request("http://127.0.0.1:3000/missing.js", { headers: { accept: "text/html" } }))).toBeNull();
		expect(await serve(new Request("http://127.0.0.1:3000/unknown", { headers: { accept: "text/html" } }))).toBeNull();
		expect(await serve(new Request("http://127.0.0.1:3000/jobs/11111111-1111-4111-8111-111111111111/cancel", { headers: { accept: "text/html" } }))).toBeNull();
		expect(await serve(new Request("http://127.0.0.1:3000/workflows", { headers: { accept: "application/json" } }))).toBeNull();
	});

	test("never handles API, MCP, or health routes and refuses traversal or outside symlinks", async () => {
		const { root, outside } = await makeDist();
		await symlink(outside, join(root, "leak.txt"));
		const serve = createUiStaticHandler(root);
		for (const path of ["/api", "/api/v1/jobs", "/api/v1/jobs/11111111-1111-4111-8111-111111111111/cancel", "/api%2fv1/jobs", "/mcp", "/mcp/session", "/health"]) {
			expect(await serve(new Request(`http://127.0.0.1:3000${path}`, { headers: { accept: "text/html" } }))).toBeNull();
		}
		const traversal = await serve(new Request("http://127.0.0.1:3000/%2e%2e%2fprivate.txt"));
		expect(traversal?.status).toBe(404);
		const symlinkResponse = await serve(new Request("http://127.0.0.1:3000/leak.txt"));
		expect(symlinkResponse).toBeNull();
		expect(await readFile(outside, "utf8")).toBe("private data");
	});

	test("supports HEAD without returning the built document body", async () => {
		const { root } = await makeDist();
		const response = await createUiStaticHandler(root)(new Request("http://127.0.0.1:3000/", { method: "HEAD" }));
		expect(response?.status).toBe(200);
		expect(await response?.text()).toBe("");
	});

	test("guards LAN UI requests against untrusted Host and Origin headers", async () => {
		const { root } = await makeDist();
		const serve = createUiStaticHandler(root, { allowLan: true });
		const url = "http://192.168.1.20:3000/";
		const accepted = await serve(new Request(url, { headers: { host: "192.168.1.20:3000", origin: "http://192.168.1.20:3000" } }));
		expect(accepted?.status).toBe(200);

		const spoofedHost = await serve(new Request(url, { headers: { host: "attacker.example" } }));
		expect(spoofedHost?.status).toBe(403);
		expect(await spoofedHost?.json()).toMatchObject({ error: { code: "host_not_allowed" } });

		const crossOrigin = await serve(new Request(url, { headers: { host: "192.168.1.20:3000", origin: "http://attacker.example" } }));
		expect(crossOrigin?.status).toBe(403);
		expect(await crossOrigin?.json()).toMatchObject({ error: { code: "origin_not_allowed" } });

		const publicHost = await serve(new Request("http://attacker.example:3000/", { headers: { host: "attacker.example:3000" } }));
		expect(publicHost?.status).toBe(403);
	});
});
