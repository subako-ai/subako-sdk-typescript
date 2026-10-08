import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ToolDefinition } from "@subako-ai/sdk";
import {
	asValues,
	describeFields,
	describesItself,
	type FieldTable,
	fieldsToJsonSchema,
	type JsonSchema,
	jsonSchemaOf,
	type Validated,
	validateFields,
	validateSchema,
	withoutBlanks,
} from "./schema.js";

/** What the form says about itself after a fill, so the model can correct what it got wrong. */
export interface FormReading {
	readonly values: Record<string, unknown>;
	/** One message per field the form is unhappy with. */
	readonly errors?: Readonly<Record<string, string>>;
}

/** What an adapter contributes to a `formTool`: the description, the write, and the read back. */
export interface FormSource {
	/** A Standard Schema (zod, valibot, arktype) validating the arguments. */
	readonly schema?: StandardSchemaV1<unknown, Record<string, unknown>>;
	/** Or the light description, which derives its own schema. */
	readonly fields?: FieldTable;
	/** The JSON Schema the model sees, for a `schema` that cannot describe itself. */
	readonly parameters?: JsonSchema;
	/** Writes the values, in the app's own idiom, and resolves once they are in place. */
	apply(values: Record<string, unknown>): void | Promise<unknown>;
	/** Read after `apply` resolved, and answered with; the applied values stand in when it is absent. */
	read?(): FormReading;
}

/** What an adapter that only reads a form contributes; the app supplies the `apply`. */
export interface FormReader {
	readonly fields: FieldTable;
	read(): FormReading;
}

export interface FormToolSpec extends FormSource {
	/** What the form is, as the model reads it; the fields are listed under it. */
	readonly description?: string;
}

const DEFAULT_DESCRIPTION = "Fill in this form. Every field is optional, so a partial fill is fine.";

/** A strict schema makes the model fill every property; this is how it says it has nothing to add. */
const BLANK_CONVENTION = "Leave a field blank to keep what it already has.";

/** The JSON Schema the model is offered, from whichever of the three the spec carries. */
function parametersOf(spec: FormToolSpec): JsonSchema {
	if (spec.parameters !== undefined) {
		return spec.parameters;
	}
	if (spec.schema !== undefined) {
		if (describesItself(spec.schema)) {
			return jsonSchemaOf(spec.schema);
		}
		throw new TypeError(
			"formTool: this schema cannot describe itself as JSON Schema, so pass `parameters` next to it (zod 4: `z.toJSONSchema(schema)`)",
		);
	}
	if (spec.fields !== undefined) {
		return fieldsToJsonSchema(spec.fields);
	}
	throw new TypeError("formTool: describe the form with `schema`, `fields`, or `parameters`");
}

function descriptionOf(spec: FormToolSpec): string {
	const head = `${spec.description ?? DEFAULT_DESCRIPTION} ${BLANK_CONVENTION}`;
	if (spec.fields === undefined || Object.keys(spec.fields).length === 0) {
		return head;
	}
	return `${head}\n\nFields:\n${describeFields(spec.fields)}`;
}

/** One form the model can fill in: the arguments are validated, applied, and read back as the answer. */
export function formTool(spec: FormToolSpec): ToolDefinition {
	// A `fields` table may be a live reading of a form that is not in the DOM yet, so the schema
	// and the description are derived when the client reads them; the spec is still refused here.
	parametersOf(spec);
	const schema = spec.schema;
	const fields = spec.fields;
	// A spec carrying only `parameters` has said all it means to: that schema is the whole contract.
	const validate = async (args: unknown): Promise<Validated> => {
		if (schema !== undefined) {
			return await validateSchema(schema, args);
		}
		if (fields !== undefined) {
			return validateFields(fields, args);
		}
		return asValues(args);
	};
	return {
		get description(): string {
			return descriptionOf(spec);
		},
		get parameters(): JsonSchema {
			return parametersOf(spec);
		},
		execute: async (args) => {
			// A provider whose schema is strict makes the model fill every property, so a field it
			// has nothing to say about arrives blank. That is "leave it alone", not "clear it".
			const validated = await validate(withoutBlanks(args));
			if (!validated.ok) {
				return { text: validated.message, is_error: true };
			}
			await spec.apply(validated.values);
			const reading: FormReading = spec.read?.() ?? { values: validated.values };
			return JSON.stringify(reading);
		},
	};
}
