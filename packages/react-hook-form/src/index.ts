import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { FieldSpec, FieldTable, FormReading, FormSource } from "@subako-ai/tools";

/** A plain object, which is the only shape the form's values and errors ever arrive in. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A branch the write descends into. An array is a leaf: it is what `useFieldArray` holds, and
 * writing one means replacing it. So is anything with a prototype of its own — a Date, a File.
 */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const proto: unknown = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
};

/** The part of a react-hook-form form this adapter uses, spelled structurally so any `UseFormReturn` fits. */
export interface ReactHookFormLike {
	setValue(name: string, value: unknown, options?: { shouldValidate?: boolean; shouldDirty?: boolean }): void;
	/** Resolves once the form has been validated, which is what puts the errors where `read` looks. */
	trigger(): Promise<boolean>;
	getValues(): object;
	readonly formState: { readonly errors: object };
}

export interface FromReactHookFormOptions {
	/** A Standard Schema for the form; without one the registered names describe it. */
	readonly schema?: StandardSchemaV1<unknown, Record<string, unknown>>;
}

/** Writes one value, or descends into a nested object and writes its leaves by path. */
function writeInto(form: ReactHookFormLike, path: string, value: unknown): void {
	if (isPlainObject(value)) {
		for (const [name, nested] of Object.entries(value)) {
			writeInto(form, `${path}.${name}`, nested);
		}
		return;
	}
	form.setValue(path, value, { shouldValidate: true, shouldDirty: true });
}

const valuesOf = (form: ReactHookFormLike): Record<string, unknown> => {
	const current: unknown = form.getValues();
	return isRecord(current) ? current : {};
};

/** The names the form holds right now, which is what it was registered with. */
function fieldsOf(form: ReactHookFormLike): FieldTable {
	const fields: Record<string, FieldSpec> = {};
	for (const name of Object.keys(valuesOf(form))) {
		// The values alone do not say what a field takes, so the DSL's plainest type stands in.
		fields[name] = { type: "string" };
	}
	return fields;
}

/** The messages the form's own validation left behind, one per field it is unhappy with. */
function errorsOf(form: ReactHookFormLike): Readonly<Record<string, string>> | undefined {
	const errors: Record<string, string> = {};
	const visit = (value: unknown, path: string): void => {
		if (!isRecord(value) && !Array.isArray(value)) {
			return;
		}
		// FieldError refs may point back into a DOM/React tree. Only error branches
		// are traversed; the field's message, type, types and ref are metadata.
		const entry = value as Record<string, unknown>;
		const message = entry["message"];
		const fieldError = typeof entry["type"] === "string" || typeof message === "string";
		if (typeof message === "string" && message !== "" && path !== "") {
			errors[path] = message;
		}
		for (const [name, nested] of Object.entries(entry)) {
			if (fieldError && ["message", "type", "types", "ref"].includes(name)) {
				continue;
			}
			visit(nested, path === "" ? name : `${path}.${name}`);
		}
	};
	visit(form.formState.errors, "");
	return Object.keys(errors).length === 0 ? undefined : errors;
}

/** A react-hook-form form as a `formTool` spec; without a `schema` every registered name is a string field. */
export function fromReactHookForm(form: ReactHookFormLike, options: FromReactHookFormOptions = {}): FormSource {
	const schema = options.schema;
	return {
		...(schema === undefined ? { fields: fieldsOf(form) } : { schema }),
		apply: async (filled) => {
			for (const [name, value] of Object.entries(filled)) {
				writeInto(form, name, value);
			}
			// `read` runs as soon as this resolves, and two things stand between `setValue` and the
			// errors it leaves: the validation itself, which `trigger` is the promise for, and the
			// update that publishes it to `formState`, which lands a turn later. Waiting for only
			// the first is enough when a fill clears an error and not when it raises one, so both
			// are waited for here. `trigger` answers for the whole form, so what `read` reports is
			// the form as it now stands rather than only the fields this call wrote.
			await form.trigger();
			await new Promise((resolve) => {
				setTimeout(resolve, 0);
			});
		},
		read: (): FormReading => {
			const errors = errorsOf(form);
			return errors === undefined ? { values: valuesOf(form) } : { values: valuesOf(form), errors };
		},
	};
}
