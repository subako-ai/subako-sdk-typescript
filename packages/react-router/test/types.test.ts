import type { ToolDefinition } from "@subako-ai/sdk";
import type { NavigateSource } from "@subako-ai/tools";
import { navigateTool } from "@subako-ai/tools";
import type { NavigateFunction } from "react-router";
import { describe, expect, it } from "vitest";
import { fromReactRouter, type ReactRouterSource } from "../src/index.js";

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// The binding answers with the spec its tool takes, so a spread is all the app writes.
const routerFills: Equals<ReturnType<typeof fromReactRouter>, NavigateSource> = true;

/**
 * The router is typed structurally, so nothing guarantees the real `useNavigate()` fits — this
 * is where that is checked. `@subako-ai/react-hook-form` learned it the hard way: a signature
 * can be right in shape and still be refused, because a function-typed property is checked
 * contravariantly and a method is not.
 */
const realNavigate = (() => {}) as NavigateFunction;
const takesTheRealThing: ReactRouterSource = { navigate: realNavigate, routes: [] };

/** Never called: it is here so `tsc` checks the shape an app actually writes. */
function shape(source: ReactRouterSource): ToolDefinition {
	return navigateTool({ ...fromReactRouter(source), description: "Go somewhere." });
}

describe("the react-router surface", () => {
	it("holds at compile time", () => {
		expect(routerFills).toBe(true);
		expect(takesTheRealThing.routes).toEqual([]);
		expect(typeof shape).toBe("function");
	});
});
