import { parametersOf } from "@subako-ai/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { fromFormElement } from "../src/form-element.js";
import { formTool } from "../src/form-tool.js";

/** The contact form as a framework would have rendered it; the reader only ever sees the DOM. */
const CONTACT = `
<form data-testid="contact">
	<label for="email">Email address</label>
	<input id="email" name="email" type="email" required />
	<label>
		Newsletter
		<input name="newsletter" type="checkbox" />
	</label>
	<select name="plan">
		<option value="">Pick one</option>
		<option value="basic">Basic</option>
		<option value="pro">Pro</option>
	</select>
	<input name="token" type="hidden" value="x" />
	<input name="secret" type="password" />
	<button type="submit">Send</button>
</form>
`;

function mount(): HTMLFormElement {
	document.body.innerHTML = CONTACT;
	const form = document.querySelector<HTMLFormElement>("[data-testid='contact']");
	if (form === null) {
		throw new Error("the contact form was not rendered");
	}
	return form;
}

beforeEach(() => {
	document.body.innerHTML = "";
});

describe("fromFormElement", () => {
	it("reads a form the way autofill does: names, types, labels, required and options", () => {
		expect(fromFormElement(mount()).fields).toEqual({
			email: { type: "string", label: "Email address", required: true },
			newsletter: { type: "boolean", label: "Newsletter" },
			plan: { type: "string", options: ["basic", "pro"] },
		});
	});

	it("reads the current values, and takes a ref as well as an element", () => {
		const form = mount();
		form.querySelector<HTMLInputElement>("[name='email']")?.setAttribute("value", "ada@example.com");
		const newsletter = form.querySelector<HTMLInputElement>("[name='newsletter']");
		if (newsletter !== null) {
			newsletter.checked = true;
		}
		const plan = form.querySelector<HTMLSelectElement>("[name='plan']");
		if (plan !== null) {
			plan.value = "pro";
		}

		expect(fromFormElement({ current: form }).read().values).toEqual({
			email: "ada@example.com",
			newsletter: true,
			plan: "pro",
		});
		// A ref that has not been filled in yet reads nothing rather than throwing.
		expect(fromFormElement({ current: null }).fields).toEqual({});
	});

	it("reads the form when it is asked, so a tool may be built before the form is mounted", () => {
		const ref: { current: HTMLFormElement | null } = { current: null };
		const source = fromFormElement(ref);
		expect(source.fields).toEqual({});
		expect(source.read().values).toEqual({});

		ref.current = mount();

		expect(Object.keys(source.fields)).toEqual(["email", "newsletter", "plan"]);
		expect(source.fields["email"]).toEqual({ type: "string", label: "Email address", required: true });
		expect("plan" in source.fields).toBe(true);
		expect("nickname" in source.fields).toBe(false);

		// So does the tool built from it: `formTool` derives its schema when the client reads it.
		const tool = formTool({ ...source, apply: () => undefined });
		expect(parametersOf(tool)["properties"]).toEqual({
			email: { type: "string", description: "Email address" },
			newsletter: { type: "boolean", description: "Newsletter" },
			plan: { type: "string", enum: ["basic", "pro", ""] },
		});
		expect(tool.description).toContain("- email (string, required) — Email address");
	});
});
