import type { ToolDefinition } from "@subako-ai/sdk";
import type { NavigateSource } from "@subako-ai/tools";
import { navigateTool } from "@subako-ai/tools";
import type { AnyRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { fromTanStackRouter } from "../src/index.js";

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// The adapter answers with the spec its tool takes, so a spread is all the app writes.
const routerFills: Equals<ReturnType<typeof fromTanStackRouter>, NavigateSource> = true;

/** Never called: it is here so `tsc` checks the shape an app actually writes. */
function shape(router: AnyRouter): ToolDefinition {
	return navigateTool({ ...fromTanStackRouter(router), description: "Go somewhere." });
}

describe("the tanstack-router surface", () => {
	it("holds at compile time", () => {
		expect(routerFills).toBe(true);
		expect(typeof shape).toBe("function");
	});
});
