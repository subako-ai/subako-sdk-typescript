import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Where the example's server is, which `EXAMPLE_PORT` moves for both this and verify.mjs. */
const api = `http://127.0.0.1:${process.env["EXAMPLE_PORT"] ?? 9800}`;

export default defineConfig({
	plugins: [react()],
	server: {
		port: Number(process.env["EXAMPLE_WEB_PORT"] ?? 5173),
		strictPort: true,
		// The example's server holds the api key, so the page reaches it same-origin.
		proxy: { "/api": { target: api } },
	},
});
