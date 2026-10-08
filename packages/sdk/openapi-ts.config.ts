import { defineConfig, type UserConfig } from "@hey-api/openapi-ts";

const api = (input: string, path: string): UserConfig => ({
	input,
	output: {
		path,
		postProcess: [],
		// NodeNext ESM resolution needs explicit extensions on relative imports.
		importFileExtension: ".js",
	},
	plugins: [
		{
			name: "@hey-api/client-fetch",
			// Bundled so the published package carries no runtime dependency.
			bundle: true,
			// Core supplies the default endpoint or the caller's override.
			baseUrl: false,
		},
		{
			name: "@hey-api/typescript",
			enums: "javascript",
		},
		{
			name: "@hey-api/sdk",
			operations: "flat",
			client: "@hey-api/client-fetch",
			responseStyle: "fields",
		},
	],
});

export default defineConfig(api("../../openapi/public.json", "src/generated"));
