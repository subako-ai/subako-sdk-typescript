import type { StandardSchemaV1 } from "@standard-schema/spec";
import { parametersOf, type ToolCall } from "@subako-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { formTool, type JsonSchema } from "../src/index.js";

const call: ToolCall = { callId: "call-1", signal: new AbortController().signal };

const contact = {
	email: { type: "string", label: "Email address", required: true },
	plan: { type: "string", options: ["basic", "pro"] },
	agree: { type: "boolean" },
} as const;

describe("formTool", () => {
	it("turns the field DSL into a JSON Schema whose properties are all optional", () => {
		const tool = formTool({ description: "The contact form.", fields: contact, apply: () => undefined });

		expect(tool.parameters).toEqual({
			type: "object",
			additionalProperties: false,
			properties: {
				email: { type: "string", description: "Email address" },
				plan: { type: "string", enum: ["basic", "pro", ""] },
				agree: { type: "boolean" },
			},
		});
		// Nothing is required, so a partial fill is a valid call; the description says what the form wants.
		expect(parametersOf(tool)["required"]).toBeUndefined();
		expect(tool.description).toContain("- email (string, required) — Email address");
		expect(tool.description).toContain("- plan (string, one of basic, pro)");
	});

	it("tells the model what a blank means, however the form was described", () => {
		const fromFields = formTool({ fields: contact, apply: () => undefined });
		const fromSchema = formTool({
			schema: z.object({ title: z.string() }).partial(),
			apply: () => undefined,
		});

		// Without this the model has no way to know it may leave a field out, so it stops and asks.
		expect(fromFields.description).toContain("Leave a field blank to keep what it already has.");
		expect(fromSchema.description).toContain("Leave a field blank to keep what it already has.");
	});

	it("offers a blank among a field's options, so a strict schema can decline to change it", () => {
		const tool = formTool({ fields: contact, apply: () => undefined });

		// Under a strict schema the model must pick one of the listed values. Without a blank
		// among them it cannot leave the field alone, so it stops and asks the person instead.
		expect((parametersOf(tool)["properties"] as Record<string, JsonSchema>)["plan"]).toEqual({
			type: "string",
			enum: ["basic", "pro", ""],
		});
	});

	it("leaves a field the call left blank alone", async () => {
		const applied: Record<string, unknown>[] = [];
		const tool = formTool({
			fields: contact,
			apply: (values) => {
				applied.push(values);
			},
		});

		// A strict schema makes the model fill every property, so a field it has nothing to say
		// about arrives blank. Applying that would wipe what the person already typed.
		await tool.execute({ email: "ada@example.com", plan: "" }, call);

		expect(applied).toEqual([{ email: "ada@example.com" }]);
	});

	it("leaves a blank alone however deep in the call it sits", async () => {
		const applied: Record<string, unknown>[] = [];
		const tool = formTool({
			schema: z
				.object({
					title: z.string(),
					meta: z.object({ subject: z.string(), message: z.string() }).partial(),
				})
				.partial(),
			apply: (values) => {
				applied.push(values);
			},
		});

		// The nested shape is where this bites: `meta.message` blank is the model saying nothing
		// about the message, and writing it would empty what the person already wrote.
		await tool.execute({ title: "Acme NDA", meta: { subject: "Please sign", message: "" } }, call);

		expect(applied).toEqual([{ title: "Acme NDA", meta: { subject: "Please sign" } }]);
	});

	it("drops a nested object the call said nothing about at all", async () => {
		const applied: Record<string, unknown>[] = [];
		const tool = formTool({
			schema: z.object({ title: z.string(), meta: z.object({ subject: z.string() }).partial() }).partial(),
			apply: (values) => {
				applied.push(values);
			},
		});

		// Every property filled, nothing said: an empty `meta` would still be a write, and
		// `setValue("meta", {})` is exactly the whole-object clobber the nested write avoids.
		await tool.execute({ title: "Acme NDA", meta: { subject: "" } }, call);

		expect(applied).toEqual([{ title: "Acme NDA" }]);
	});

	it("validates, applies, and answers with the read", async () => {
		const applied: Record<string, unknown>[] = [];
		const tool = formTool({
			fields: contact,
			apply: (values) => {
				applied.push(values);
			},
			read: () => ({ values: { email: "ada@example.com" }, errors: { plan: "pick one" } }),
		});

		const answer = await tool.execute({ email: "ada@example.com", agree: true }, call);

		expect(applied).toEqual([{ email: "ada@example.com", agree: true }]);
		expect(answer).toBe(JSON.stringify({ values: { email: "ada@example.com" }, errors: { plan: "pick one" } }));
	});

	it("answers with the applied values when the spec has no read", async () => {
		const tool = formTool({ fields: contact, apply: () => undefined });

		expect(await tool.execute({ plan: "pro" }, call)).toBe(JSON.stringify({ values: { plan: "pro" } }));
	});

	it("answers an argument the form would refuse as an error, and applies nothing", async () => {
		let applied = 0;
		const tool = formTool({
			fields: contact,
			apply: () => {
				applied += 1;
			},
		});

		expect(await tool.execute({ email: 5 }, call)).toEqual({
			text: "email takes a string, not number",
			is_error: true,
		});
		expect(await tool.execute({ nickname: "ada" }, call)).toEqual({
			text: "this form has no field named nickname",
			is_error: true,
		});
		expect(await tool.execute({ plan: "gold" }, call)).toEqual({
			text: "plan takes one of basic, pro",
			is_error: true,
		});
		expect(applied).toBe(0);
	});

	it("validates with a Standard Schema, and refuses what the schema refuses", async () => {
		const schema = z.object({ email: z.string(), age: z.number() });
		const applied: Record<string, unknown>[] = [];
		const tool = formTool({
			description: "The signup form.",
			schema,
			parameters: z.toJSONSchema(schema),
			apply: (values) => {
				applied.push(values);
			},
		});

		// `parameters` given by hand wins over anything the schema could say about itself.
		expect(parametersOf(tool)["properties"]).toEqual({ email: { type: "string" }, age: { type: "number" } });
		expect(await tool.execute({ email: "ada@example.com", age: 36 }, call)).toBe(
			JSON.stringify({ values: { email: "ada@example.com", age: 36 } }),
		);

		const refused = await tool.execute({ email: "ada@example.com", age: "thirty" }, call);
		expect(refused).toMatchObject({ is_error: true });
		expect(applied).toHaveLength(1);
	});

	it("takes the JSON Schema from a schema that describes itself", () => {
		const schema = z.object({ email: z.string(), age: z.number() });

		// Zod 4 carries the Standard Schema v1.1 JSON Schema hook, so nothing else is needed.
		expect(parametersOf(formTool({ schema, apply: () => undefined }))["properties"]).toEqual({
			email: { type: "string" },
			age: { type: "number" },
		});
	});

	it("asks for parameters when neither the schema nor the fields can give them", () => {
		const schema: StandardSchemaV1<unknown, Record<string, unknown>> = {
			"~standard": { version: 1, vendor: "test", validate: () => ({ value: {} }) },
		};

		expect(() => formTool({ schema, apply: () => undefined })).toThrow(/cannot describe itself/);
		expect(() => formTool({ apply: () => undefined })).toThrow(/`schema`, `fields`, or `parameters`/);
	});
});
