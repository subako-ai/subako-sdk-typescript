import type { ToolDefinition } from "@subako-ai/sdk";
import type { FormSource } from "@subako-ai/tools";
import { formTool } from "@subako-ai/tools";
import { describe, expect, it } from "vitest";
import { fromReactHookForm, type ReactHookFormLike } from "../src/index.js";

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// The adapter answers with the spec its tool takes, so a spread is all the app writes.
const hookFormFills: Equals<ReturnType<typeof fromReactHookForm>, FormSource> = true;

/** Never called: it is here so `tsc` checks the shape an app actually writes. */
function shape(form: ReactHookFormLike): ToolDefinition {
	return formTool({ ...fromReactHookForm(form), description: "The signup form." });
}

describe("the react-hook-form surface", () => {
	it("holds at compile time", () => {
		expect(hookFormFills).toBe(true);
		expect(typeof shape).toBe("function");
	});
});
