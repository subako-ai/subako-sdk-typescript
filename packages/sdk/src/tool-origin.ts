/**
 * Where a tool the model called comes from, read off the name it called it
 * by. The engine names every tool `<source>__<name>__<tool>`: an MCP server, a
 * skill, or a sandbox an agent's grant names, or a client a page registered.
 * Neither a grant's name nor a client's carries `_`, so the name splits one
 * way only; anything else is the engine's own tool, under the name it gave it.
 */
export type ToolOrigin =
	| {
			readonly kind: ToolSource;
			/** The grant's name, or the client's. */
			readonly source: string;
			/** The tool, as its server or client calls it. */
			readonly tool: string;
	  }
	| { readonly kind: "engine"; readonly tool: string };

/** What reaches a tool: one of the agent's grants, or a client on the session. */
export type ToolSource = "mcp" | "skill" | "sandbox" | "client";

const SOURCES: readonly ToolSource[] = ["mcp", "skill", "sandbox", "client"];

const isSource = (value: string): value is ToolSource => (SOURCES as readonly string[]).includes(value);

/** Reads `name` as `<source>__<name>__<tool>`, or as the engine's own tool when it is not one. */
export function toolOrigin(name: string): ToolOrigin {
	const [kind, source, ...rest] = name.split("__");
	const tool = rest.join("__");
	if (kind === undefined || source === undefined || source === "" || tool === "" || !isSource(kind)) {
		return { kind: "engine", tool: name };
	}
	return { kind, source, tool };
}
