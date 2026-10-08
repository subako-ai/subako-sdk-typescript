import type { ToolCall } from "@subako-ai/sdk";
import { describe, expect, it } from "vitest";
import { submitTool } from "../src/index.js";

const call: ToolCall = { callId: "call-1", signal: new AbortController().signal };

describe("submitTool", () => {
	it("takes no arguments, so a strict schema has nothing to fill in", () => {
		const tool = submitTool({ description: "Submit the add-todo form.", submit: () => undefined });

		expect(tool.parameters).toEqual({ type: "object", properties: {}, additionalProperties: false });
		expect(tool.description).toBe("Submit the add-todo form.");
	});

	it("submits, and says so", async () => {
		let sent = 0;
		const tool = submitTool({
			submit: () => {
				sent += 1;
			},
		});

		expect(await tool.execute({}, call)).toBe("The form was submitted.");
		expect(sent).toBe(1);
	});

	it("answers with the form's own errors when the form refused it", async () => {
		const tool = submitTool({
			submit: () => false,
			read: () => ({ values: { title: "" }, errors: { title: "a title is required" } }),
		});

		expect(await tool.execute({}, call)).toEqual({
			text: "the form refused it — title: a title is required",
			is_error: true,
		});
	});

	it("says the form refused it when there is nothing to read", async () => {
		const tool = submitTool({ submit: () => false });

		expect(await tool.execute({}, call)).toEqual({ text: "the form refused it", is_error: true });
	});

	it("does not read a form that went through, because it may be gone", async () => {
		let reads = 0;
		const tool = submitTool({
			submit: () => true,
			read: () => {
				reads += 1;
				return { values: {} };
			},
		});

		await tool.execute({}, call);

		expect(reads).toBe(0);
	});
});
