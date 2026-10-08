import type { ToolDefinition } from "@subako-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { FormReader } from "../src/index.js";
import { formTool, fromFormElement, navigateTool } from "../src/index.js";

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// Both core tools answer with what the SDK's client table takes.
const buildsAForm: Equals<ReturnType<typeof formTool>, ToolDefinition> = true;
const buildsANavigate: Equals<ReturnType<typeof navigateTool>, ToolDefinition> = true;
// A form element only reads, so the app supplies the `apply` next to it.
const elementReads: Equals<ReturnType<typeof fromFormElement>, FormReader> = true;

/** Never called: it is here so `tsc` checks the shapes an app actually writes. */
function shapes(
	formRef: { current: HTMLFormElement | null },
	write: (values: Record<string, unknown>) => void,
): ToolDefinition[] {
	const navigate = navigateTool({
		routes: [{ to: "/" }, { to: "/users/$userId", params: { userId: "string" } }],
		navigate: () => undefined,
		description: "Go somewhere.",
	});
	const readOnly = formTool({ ...fromFormElement(formRef), apply: write });
	const typed = formTool({
		schema: z.object({ email: z.string() }),
		apply: (values) => write({ email: String(values["email"]) }),
	});
	const described = formTool({ fields: { email: { type: "string", required: true } }, apply: write });
	return [navigate, readOnly, typed, described];
}

describe("the tools surface", () => {
	it("holds at compile time", () => {
		expect([buildsAForm, buildsANavigate, elementReads]).toEqual([true, true, true]);
		expect(typeof shapes).toBe("function");
	});
});
