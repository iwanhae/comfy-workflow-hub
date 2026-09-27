import { loadConfig } from "./config.ts";
import { ComfyApiClient } from "./comfy-client.ts";
import { createHubApp } from "./app.ts";
import { HubStore } from "./storage.ts";

const config = loadConfig();
const store = new HubStore({ dataDir: config.dataDir, uploadTtlMs: config.uploadTtlMs });
await store.initialize();

const comfy = new ComfyApiClient({ baseUrl: config.comfyBaseUrl, timeoutMs: config.upstreamTimeoutMs });
const app = createHubApp({ config, store, comfy });
const server = Bun.serve({
	hostname: config.host,
	port: config.port,
	fetch: app.fetch,
});
const expirySweep = setInterval(() => {
	void store.reapExpiredUploads().catch((error) => console.error("Could not clean expired staged uploads:", error));
}, 60_000);

console.log(`Comfy workflow hub listening at ${server.url}`);
console.log(`Persistent data directory: ${config.dataDir}`);

let shuttingDown = false;
const shutdown = () => {
	if (shuttingDown) return;
	shuttingDown = true;
	clearInterval(expirySweep);
	server.stop(true);
	void app.close().then(
		() => {
			store.close();
			process.exit(0);
		},
		(error) => {
			console.error("Could not finish output archive shutdown:", error);
			store.close();
			process.exit(1);
		},
	);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
