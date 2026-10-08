import { defineConfig } from "blume";

// The site is built from `docs/`, which is Blume's default content root. The
// output is static: no adapter is named here, so `blume build` writes a plain
// site that any host serves. It is served by a Cloudflare Worker that has no
// script of its own — just `dist/` behind the assets binding — so nothing
// renders at request time and no adapter has to match the platform.
export default defineConfig({
	// `<Component path>` previews, which Blume otherwise looks for in `examples/`.
	// That directory holds runnable example apps with their own `node_modules`, not
	// preview components, so pointing this elsewhere keeps the build out of them.
	examples: "docs/_previews",
	content: {
		// `workshop/` is teaching material that happens to live here and is not part
		// of this site. It is untracked, so it is left where it is rather than moved.
		exclude: ["**/_*", "**/.*", "workshop/**"],
	},
	// Spelled out rather than detected. Blume reads the origin from the host's
	// build environment, but recognizes Cloudflare only by `CF_PAGES`, which
	// Workers Builds does not set — so without this the canonical URLs, the
	// sitemap and the Open Graph images would have no origin to point at.
	deployment: { site: "https://typescript-sdk-docs.subako.ai" },
	description:
		"The TypeScript SDK for Subako — sessions, streaming, and the tools your own client answers, typed end to end.",
	navigation: {
		cta: { href: "https://docs.subako.ai", label: "Subako Docs" },
		// Spelled out rather than generated. Blume's own order puts every root-level
		// page above every group, which would stand React ahead of the sessions it is
		// bindings for; this is reading order instead. A page added to `docs/` has to
		// be added here too, or it is reachable and unlisted.
		sidebar: [
			"/",
			"/quickstart",
			"/server-jobs",
			"/clients-and-auth",
			{
				label: "Sessions",
				items: ["/sessions/connection", "/sessions/reading-the-log", "/sessions/sandboxes"],
			},
			{
				label: "Tools",
				items: ["/tools/client-tools", "/tools/forms", "/tools/navigation"],
			},
			{
				label: "Workspace",
				items: ["/workspace/agents", "/workspace/skills", "/workspace/vaults", "/workspace/keys-and-access"],
			},
			"/react",
			"/assistant-ui",
			{
				label: "Reference",
				items: ["/reference/pagination", "/reference/errors", "/reference/timeouts-and-retries", "/reference/packages"],
			},
		],
	},
	theme: {
		// The same muted sage as docs.subako.ai, so the two sites read as one family.
		accent: { dark: "oklch(0.72 0.05 168)", light: "oklch(0.55 0.05 168)" },
	},
	title: "Subako TypeScript SDK",
});
