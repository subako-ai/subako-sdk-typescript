import { describe, expect, it } from "vitest";
import { toolOrigin } from "../src/index.js";

describe("toolOrigin", () => {
	it("reads a granted or client tool as its source, its name, and the tool", () => {
		expect(toolOrigin("mcp__rooms__lookup")).toEqual({ kind: "mcp", source: "rooms", tool: "lookup" });
		expect(toolOrigin("skill__review__read")).toEqual({ kind: "skill", source: "review", tool: "read" });
		expect(toolOrigin("sandbox__py-3__exec")).toEqual({ kind: "sandbox", source: "py-3", tool: "exec" });
		expect(toolOrigin("fn__files__write")).toEqual({ kind: "fn", source: "files", tool: "write" });
		expect(toolOrigin("client__page__fill_form")).toEqual({ kind: "client", source: "page", tool: "fill_form" });
		expect(toolOrigin("builtin__session_display_name__set")).toEqual({
			kind: "builtin",
			source: "session_display_name",
			tool: "set",
		});
	});

	it("keeps a tool name that carries the separator itself whole", () => {
		expect(toolOrigin("mcp__github__list__issues")).toEqual({ kind: "mcp", source: "github", tool: "list__issues" });
	});

	it("reads anything else as the engine's own tool, under the name it gave it", () => {
		for (const name of ["think", "web__search__now", "mcp__rooms", "mcp____lookup", "mcp__rooms__", "__x__y"]) {
			expect(toolOrigin(name)).toEqual({ kind: "engine", tool: name });
		}
	});
});
