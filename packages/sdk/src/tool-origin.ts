/**
 * Where a tool the model called comes from, read off the name it called it
 * by. The engine names every tool `<source>__<name>__<tool>`: an MCP server, a
 * skill, a sandbox, or a function package an agent's grant names
 * (`fn__files__write`), a server the platform serves
 * itself (`builtin__session_display_name__set`), or a client a page registered. None
 * of their names carries `__`, so the name splits one way only; anything else
 * is the engine's own tool, under the name it gave it.
 */
export type ToolOrigin =
	| {
			readonly kind: ToolSource;
			/** The grant's name, the builtin server's, or the client's. */
			readonly source: string;
			/** The tool, as its server or client calls it. */
			readonly tool: string;
	  }
	| { readonly kind: "engine"; readonly tool: string };

/** What reaches a tool: one of the agent's grants, a server the platform serves itself, or a client on the session. */
export type ToolSource = "mcp" | "skill" | "sandbox" | "fn" | "builtin" | "client";

const SOURCES: readonly ToolSource[] = ["mcp", "skill", "sandbox", "fn", "builtin", "client"];

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
