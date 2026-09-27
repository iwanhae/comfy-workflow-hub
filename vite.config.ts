import { defineConfig } from "vite";
import type { ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

const hubProxy: ProxyOptions = {
	target: "http://127.0.0.1:3000",
	changeOrigin: true,
	configure: (proxy) => {
		// The Hub intentionally requires same-origin browser mutations. The
		// local Vite proxy is the trusted same-origin bridge during development.
		proxy.on("proxyReq", (proxyRequest) => proxyRequest.removeHeader("origin"));
	},
};

export default defineConfig({
	root: "web",
	plugins: [react()],
	server: {
		host: "127.0.0.1",
		port: 5173,
		proxy: {
			"/api": { ...hubProxy },
			"/mcp": { ...hubProxy },
			"/health": { ...hubProxy },
		},
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
});
