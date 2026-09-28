import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createHubApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { ComfyApiClient } from "../src/comfy-client.ts";
import { HubStore } from "../src/storage.ts";

describe("shared knowledge board", () => {
	test("REST create, update, list, get and delete persist across a server restart", async () => {
		const root = await mkdtemp(join(tmpdir(), "comfy-knowledge-test-"));
		const config = loadConfig({ DATA_DIR: join(root, "data"), COMFY_BASE_URL: "http://192.168.0.2:8188", COMFY_ALLOW_LAN: "true" }, root);
		let store = new HubStore({ dataDir: config.dataDir, uploadTtlMs: config.uploadTtlMs });
		const comfy = new ComfyApiClient({ baseUrl: new URL("http://192.168.0.2:8188"), timeoutMs: 1000, fetchImpl: async () => { throw new Error("No upstream requests expected"); } });
		const request = (path: string, method = "GET", value?: unknown) => new Request(`http://127.0.0.1:3000${path}`, {
			method,
			...(value ? { headers: { "content-type": "application/json" }, body: JSON.stringify(value) } : {}),
		});
		try {
			await store.initialize();
			let app = createHubApp({ config, store, comfy });
			const createdResponse = await app.fetch(request("/api/v1/knowledge", "POST", { title: "  Save prompts  ", body: "Record seed and model." }));
			expect(createdResponse.status).toBe(201);
			const created = await createdResponse.json() as { id: string; title: string; createdAt: number };
			expect(created.title).toBe("Save prompts");
			store.close();
			store = new HubStore({ dataDir: config.dataDir, uploadTtlMs: config.uploadTtlMs });
			await store.initialize();
			app = createHubApp({ config, store, comfy });
			expect((await (await app.fetch(request("/api/v1/knowledge"))).json() as { entries: unknown[] }).entries).toHaveLength(1);
			const updatedResponse = await app.fetch(request("/api/v1/knowledge", "POST", { id: created.id, title: "Workflow tip", body: "Keep seed and model." }));
			expect(updatedResponse.status).toBe(200);
			const updated = await updatedResponse.json() as { id: string; title: string; createdAt: number };
			expect(updated).toMatchObject({ id: created.id, title: "Workflow tip", createdAt: created.createdAt });
			expect((await (await app.fetch(request(`/api/v1/knowledge/${created.id}`))).json() as { body: string }).body).toBe("Keep seed and model.");
			expect((await app.fetch(request(`/api/v1/knowledge/${created.id}`, "DELETE"))).status).toBe(200);
			expect((await app.fetch(request(`/api/v1/knowledge/${created.id}`))).status).toBe(404);
		} finally {
			store.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
