import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Every project tests against the workspace packages' sources, as the SDK's own tests do. */
const source = (name: string): string => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));
const sdk = source("sdk");
const tools = source("tools");
const react = source("react");

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "sdk",
					include: ["packages/sdk/test/**/*.test.ts"],
					environment: "node",
				},
			},
			{
				resolve: { alias: { "@subako-ai/sdk": sdk } },
				test: {
					// The form reader reads a form, so these tests want a DOM.
					name: "tools",
					include: ["packages/tools/test/**/*.test.ts"],
					environment: "happy-dom",
				},
			},
			{
				resolve: { alias: { "@subako-ai/sdk": sdk } },
				test: {
					// The React bindings render, so their tests want a DOM.
					name: "react",
					include: ["packages/react/test/**/*.test.{ts,tsx}"],
					environment: "happy-dom",
				},
			},
			{
				resolve: { alias: { "@subako-ai/sdk": sdk, "@subako-ai/tools": tools } },
				test: {
					// The router reads `window` when it is created.
					name: "tanstack-router",
					include: ["packages/tanstack-router/test/**/*.test.ts"],
					environment: "happy-dom",
				},
			},
			{
				resolve: { alias: { "@subako-ai/sdk": sdk, "@subako-ai/tools": tools } },
				test: {
					// The binding is plain functions; no DOM is needed to drive them.
					name: "react-router",
					include: ["packages/react-router/test/**/*.test.ts"],
					environment: "node",
				},
			},
			{
				resolve: { alias: { "@subako-ai/sdk": sdk, "@subako-ai/tools": tools } },
				test: {
					// The test renders a component to call `useForm`.
					name: "react-hook-form",
					include: ["packages/react-hook-form/test/**/*.test.{ts,tsx}"],
					environment: "happy-dom",
				},
			},
			{
				resolve: { alias: { "@subako-ai/sdk": sdk, "@subako-ai/react": react } },
				test: {
					name: "assistant-ui",
					include: ["packages/assistant-ui/test/**/*.test.{ts,tsx}"],
					environment: "happy-dom",
				},
			},
		],
	},
});
