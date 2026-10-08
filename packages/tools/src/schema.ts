import type { StandardSchemaV1 } from "@standard-schema/spec";
import { validateSchema as validateAgainst } from "@subako-ai/sdk";

// The SDK runs a Standard Schema itself, so the reading and the phrasing of its issues live
// there and this package uses them rather than keeping a second copy.
export { describesItself, jsonSchemaOf } from "@subako-ai/sdk";

/** A JSON Schema object, in the shape the API takes for a tool's `parameters`. */
export type JsonSchema = Record<string, unknown>;

/** The types the light field DSL knows; anything richer wants a schema. */
export type FieldType = "string" | "number" | "boolean";

/** One field of a form, as much of it as the model needs to fill it in. */
export interface FieldSpec {
	readonly type: FieldType;
	/** What the field is called on screen; it becomes the property's description. */
	readonly label?: string;
	/** Whether the form itself needs the field, which the description says and the schema does not. */
	readonly required?: boolean;
	/** The values the field accepts, which become an `enum`. */
	readonly options?: readonly string[];
}

/** The fields of one form, keyed by the name the app knows them by. */
export type FieldTable = Readonly<Record<string, FieldSpec>>;

/** What a validation answered with: the values to apply, or the reason they were refused. */
export type Validated =
	| { readonly ok: true; readonly values: Record<string, unknown> }
	| { readonly ok: false; readonly message: string };

/** A plain object, which is the only shape a tool's arguments ever arrive in. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The SDK's reading of a schema, in the shape a form's own validation answers in. */
export async function validateSchema(
	schema: StandardSchemaV1<unknown, Record<string, unknown>>,
	args: unknown,
): Promise<Validated> {
	const validated = await validateAgainst(schema, args);
	return validated.ok ? { ok: true, values: validated.value } : validated;
}

/** The DSL's own JSON Schema; every property is optional, so a partial fill is a valid call. */
export function fieldsToJsonSchema(fields: FieldTable): JsonSchema {
	const properties: Record<string, JsonSchema> = {};
	for (const [name, field] of Object.entries(fields)) {
		const property: JsonSchema = { type: field.type };
		if (field.label !== undefined) {
			property["description"] = field.label;
		}
		if (field.options !== undefined) {
			// The blank is how a strict schema says "leave this one alone"; `withoutBlanks` drops it.
			property["enum"] = [...field.options, ""];
		}
		properties[name] = property;
	}
	return { type: "object", properties, additionalProperties: false };
}

/** One line per field, so the model reads what the form wants without guessing at the schema. */
export function describeFields(fields: FieldTable): string {
	return Object.entries(fields)
		.map(([name, field]) => {
			const notes: string[] = [field.type];
			if (field.required === true) {
				notes.push("required");
			}
			if (field.options !== undefined) {
				notes.push(`one of ${field.options.join(", ")}`);
			}
			const label = field.label === undefined ? "" : ` — ${field.label}`;
			return `- ${name} (${notes.join(", ")})${label}`;
		})
		.join("\n");
}

/** A value a strict schema put there because it had to, standing for "no value". */
export const isBlank = (value: unknown): boolean => value === undefined || value === null || value === "";

/**
 * The call without the fields it said nothing about, so a fill never wipes what it did not mean
 * to. It goes all the way down, because a nested form is where this bites hardest: a strict
 * schema fills `meta.message` blank as readily as `message`, and the write is by leaf. An array
 * is a value, not a level — replacing one whole is what writing it means.
 */
export function withoutBlanks(args: unknown): unknown {
	if (!isRecord(args)) {
		return args;
	}
	const said: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(args)) {
		if (isBlank(value)) {
			continue;
		}
		if (isRecord(value)) {
			const inner = withoutBlanks(value) as Record<string, unknown>;
			// An object left entirely blank said nothing either, and writing `{}` over it is the
			// whole-object clobber that writing leaf by leaf exists to avoid.
			if (Object.keys(inner).length > 0) {
				said[name] = inner;
			}
			continue;
		}
		said[name] = value;
	}
	return said;
}

/** What every validation insists on first: the arguments are an object of field values. */
export const asValues = (args: unknown): Validated =>
	isRecord(args)
		? { ok: true, values: args }
		: { ok: false, message: "the arguments must be an object of field values" };

/** The DSL's own validation: known names, the declared types, and the options a field allows. */
export function validateFields(fields: FieldTable, args: unknown): Validated {
	const given = asValues(args);
	if (!given.ok) {
		return given;
	}
	const values: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(given.values)) {
		if (value === undefined) {
			continue;
		}
		const field = fields[name];
		if (field === undefined) {
			return { ok: false, message: `this form has no field named ${name}` };
		}
		if (typeof value !== field.type) {
			return { ok: false, message: `${name} takes a ${field.type}, not ${typeof value}` };
		}
		if (field.options !== undefined && (typeof value !== "string" || !field.options.includes(value))) {
			return { ok: false, message: `${name} takes one of ${field.options.join(", ")}` };
		}
		values[name] = value;
	}
	return { ok: true, values };
}
