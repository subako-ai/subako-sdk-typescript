import type { FormReader, FormReading } from "./form-tool.js";
import type { FieldSpec, FieldTable, FieldType } from "./schema.js";

/** A form element, or the ref a component keeps it in. */
export type FormElementSource = HTMLFormElement | { readonly current: HTMLFormElement | null } | null;

type FieldElement = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** Controls that hold no value a model could fill, and passwords, which are nobody's to read. */
const SKIPPED = new Set(["hidden", "submit", "button", "reset", "image", "file", "password"]);

const isInput = (element: FieldElement): element is HTMLInputElement => element.tagName === "INPUT";
const isSelect = (element: FieldElement): element is HTMLSelectElement => element.tagName === "SELECT";

function resolve(source: FormElementSource): HTMLFormElement | null {
	if (source === null) {
		return null;
	}
	return "current" in source ? source.current : source;
}

/** Every named control the form carries, in document order. */
function controls(form: HTMLFormElement): FieldElement[] {
	const found: FieldElement[] = [];
	for (const element of form.querySelectorAll<FieldElement>("input, select, textarea")) {
		if (element.name === "" || (isInput(element) && SKIPPED.has(element.type))) {
			continue;
		}
		found.push(element);
	}
	return found;
}

const typeOf = (element: FieldElement): FieldType => {
	if (!isInput(element)) {
		return "string";
	}
	if (element.type === "checkbox") {
		return "boolean";
	}
	return element.type === "number" || element.type === "range" ? "number" : "string";
};

/** The two ways a label attaches, and the property that already knows both. */
function labelOf(element: FieldElement, form: HTMLFormElement): string | undefined {
	const own = element.labels?.[0]?.textContent?.trim();
	if (own !== undefined && own !== "") {
		return own;
	}
	const wrapping = element.closest("label")?.textContent?.trim();
	if (wrapping !== undefined && wrapping !== "") {
		return wrapping;
	}
	if (element.id === "") {
		return undefined;
	}
	for (const label of form.querySelectorAll("label")) {
		if (label.htmlFor === element.id) {
			const text = label.textContent?.trim();
			if (text !== undefined && text !== "") {
				return text;
			}
		}
	}
	return undefined;
}

/** A select's own options, or the values of a radio group, which is a select spelled out. */
function optionsOf(element: FieldElement, group: readonly FieldElement[]): readonly string[] | undefined {
	if (isSelect(element)) {
		const values = [...element.options].map((option) => option.value).filter((value) => value !== "");
		return values.length === 0 ? undefined : values;
	}
	if (isInput(element) && element.type === "radio") {
		const values = group.filter((other) => isInput(other) && other.type === "radio").map((other) => other.value);
		return values.length === 0 ? undefined : values;
	}
	return undefined;
}

/** The form as the model reads it: the names, the types, the labels, and what each one accepts. */
function readFields(form: HTMLFormElement): FieldTable {
	const elements = controls(form);
	const fields: Record<string, FieldSpec> = {};
	for (const element of elements) {
		if (fields[element.name] !== undefined) {
			continue;
		}
		const group = elements.filter((other) => other.name === element.name);
		const label = labelOf(element, form);
		const options = optionsOf(element, group);
		fields[element.name] = {
			type: typeOf(element),
			...(label === undefined ? {} : { label }),
			...(group.some((other) => other.required) ? { required: true } : {}),
			...(options === undefined ? {} : { options }),
		};
	}
	return fields;
}

/** One control's current value; an unchecked radio has nothing to say. */
function valueOf(element: FieldElement): unknown {
	if (!isInput(element)) {
		return element.value;
	}
	if (element.type === "checkbox") {
		return element.checked;
	}
	if (element.type === "radio") {
		return element.checked ? element.value : undefined;
	}
	if (element.type === "number" || element.type === "range") {
		return element.value === "" ? undefined : Number(element.value);
	}
	return element.value;
}

function readValues(form: HTMLFormElement): FormReading {
	const values: Record<string, unknown> = {};
	const errors: Record<string, string> = {};
	for (const element of controls(form)) {
		if (element.validationMessage !== "") {
			errors[element.name] = element.validationMessage;
		}
		const value = valueOf(element);
		if (value !== undefined) {
			values[element.name] = value;
		}
	}
	return Object.keys(errors).length === 0 ? { values } : { values, errors };
}

/**
 * The fields as a live view of the form: a component builds its tool while rendering, and the
 * form only reaches the DOM after that, so the table answers from whatever is mounted when it
 * is read. A proxy rather than a getter, because the table is usually spread into `formTool`.
 */
function liveFields(source: FormElementSource): FieldTable {
	const now = (): FieldTable => {
		const form = resolve(source);
		return form === null ? {} : readFields(form);
	};
	return new Proxy<FieldTable>(
		{},
		{
			get: (_target, key) => (typeof key === "string" ? now()[key] : undefined),
			has: (_target, key) => typeof key === "string" && key in now(),
			ownKeys: () => Object.keys(now()),
			getOwnPropertyDescriptor: (_target, key) => {
				const value = typeof key === "string" ? now()[key] : undefined;
				return value === undefined ? undefined : { value, enumerable: true, configurable: true, writable: false };
			},
		},
	);
}

/** An existing form, read the way autofill reads one; a reader, so the app writes. */
export function fromFormElement(source: FormElementSource): FormReader {
	return {
		fields: liveFields(source),
		read: () => {
			const current = resolve(source);
			return current === null ? { values: {} } : readValues(current);
		},
	};
}
