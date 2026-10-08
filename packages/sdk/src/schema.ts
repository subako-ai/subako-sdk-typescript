import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import type { ToolParameters } from "./tool-client.js";

/** The JSON Schema draft asked of a schema that can describe itself. */
const TARGET = "draft-2020-12";

/** What a validation answered with: the value the handler takes, or the reason the model is given. */
export type Validated<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Standard Schema v1.1 lets a schema hand out its own JSON Schema, which zod 4 does. */
export function describesItself<A>(
	schema: StandardSchemaV1<unknown, A>,
): schema is StandardSchemaV1<unknown, A> & StandardJSONSchemaV1 {
	const props: object = schema["~standard"];
	if (!("jsonSchema" in props)) {
		return false;
	}
	const converter: unknown = props.jsonSchema;
	return isRecord(converter) && typeof converter["input"] === "function";
}

/** The JSON Schema a self-describing schema answers with, for the arguments the model sends. */
export const jsonSchemaOf = (schema: StandardJSONSchemaV1): ToolParameters =>
	schema["~standard"].jsonSchema.input({ target: TARGET });

/** One issue, as a person and a model both read it: where it was, and what was wrong. */
function issueText(issue: StandardSchemaV1.Issue): string {
	const path = issue.path?.map((segment) => String(typeof segment === "object" ? segment.key : segment)).join(".");
	return path === undefined || path === "" ? issue.message : `${path}: ${issue.message}`;
}

/**
 * Runs a Standard Schema over the raw arguments. The failure is phrased for the model,
 * which is the one that has to correct it: every issue, each under the path it was at.
 */
export async function validateSchema<A>(schema: StandardSchemaV1<unknown, A>, args: unknown): Promise<Validated<A>> {
	const result = await schema["~standard"].validate(args);
	if (result.issues !== undefined) {
		return { ok: false, message: result.issues.map(issueText).join("; ") };
	}
	return { ok: true, value: result.value };
}
