import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { type FieldErrors, type Resolver, useFieldArray, useForm, type UseFormReturn } from "react-hook-form";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fromReactHookForm } from "../src/index.js";

afterEach(cleanup);

describe("fromReactHookForm", () => {
	it("reads nested, array and root errors by field path without traversing field refs", async () => {
		interface Values {
			meta: { subject: string };
			signers: { email: string }[];
		}
		let form: UseFormReturn<Values> | undefined;
		function Form(): ReactNode {
			form = useForm<Values>({ defaultValues: { meta: { subject: "" }, signers: [{ email: "" }] } });
			useFieldArray({
				control: form.control,
				name: "signers",
				rules: { minLength: { value: 2, message: "Two signers are required" } },
			});
			const errors = form.formState.errors;
			return <input {...form.register("meta.subject")} aria-invalid={errors.meta?.subject !== undefined} />;
		}
		render(<Form />);
		if (form === undefined) throw new Error("the form was not built");
		const source = fromReactHookForm(form);
		await act(async () => {
			await form?.trigger("signers");
			form?.setError("meta.subject", { type: "required", message: "A subject is required" });
			form?.setError("signers.0.email", { type: "validate", message: "Invalid email" });
			form?.setError("root.server", { type: "server", message: "Try again" });
		});
		expect(source.read?.().errors).toEqual({
			"meta.subject": "A subject is required",
			"signers.0.email": "Invalid email",
			"signers.root": "Two signers are required",
			"root.server": "Try again",
		});
		await act(async () => {
			form?.clearErrors();
		});
		expect(source.read?.().errors).toBeUndefined();
	});

	it("writes every value through setValue, and reads the values back", async () => {
		let form: UseFormReturn<{ email: string; plan: string }> | undefined;
		function Signup(): ReactNode {
			form = useForm({ defaultValues: { email: "", plan: "" } });
			return null;
		}
		render(<Signup />);
		if (form === undefined) {
			throw new Error("the form was not built");
		}
		const written = vi.spyOn(form, "setValue");
		const source = fromReactHookForm(form);

		expect(source.fields).toEqual({ email: { type: "string" }, plan: { type: "string" } });
		await act(async () => {
			await source.apply({ email: "ada@example.com", plan: "pro" });
		});

		expect(written.mock.calls).toEqual([
			["email", "ada@example.com", { shouldValidate: true, shouldDirty: true }],
			["plan", "pro", { shouldValidate: true, shouldDirty: true }],
		]);
		expect(source.read?.().values).toEqual({ email: "ada@example.com", plan: "pro" });
	});

	it("reads back the errors the fill left, not the ones it cleared", async () => {
		interface Values {
			title: string;
		}
		const resolver: Resolver<Values> = (values) => {
			if (values.title === "") {
				const errors: FieldErrors<Values> = { title: { type: "required", message: "a title is required" } };
				return { values: {}, errors };
			}
			return { values, errors: {} };
		};

		let form: UseFormReturn<Values> | undefined;
		function Modal(): ReactNode {
			form = useForm<Values>({ defaultValues: { title: "" }, resolver });
			// The component subscribes to the errors, the way a form that shows them does.
			return <span>{JSON.stringify(form.formState.errors)}</span>;
		}
		render(<Modal />);
		if (form === undefined) {
			throw new Error("the form was not built");
		}
		const source = fromReactHookForm(form);

		// A refused submit leaves an error behind.
		await act(async () => {
			await form?.trigger();
		});
		expect(source.read?.().errors).toEqual({ title: "a title is required" });

		// The fill that fixes it, read back the way `formTool` does: apply, then read, with no
		// `act` to flush React in between — a tool call has no such wrapper around it.
		await source.apply({ title: "Buy eggs" });

		expect(source.read?.()).toEqual({ values: { title: "Buy eggs" } });
	});

	it("writes a nested value by path, leaving its siblings alone", async () => {
		interface Nested {
			meta: { subject: string; message: string; emailSettings: { recipientSigned: boolean } };
		}
		let form: UseFormReturn<Nested> | undefined;
		function Wizard(): ReactNode {
			form = useForm<Nested>({
				defaultValues: {
					meta: { subject: "", message: "", emailSettings: { recipientSigned: true } },
				},
			});
			return null;
		}
		render(<Wizard />);
		if (form === undefined) {
			throw new Error("the form was not built");
		}
		const source = fromReactHookForm(form);

		// Writing `meta` whole would take `message` and `emailSettings` with it.
		await act(async () => {
			await source.apply({ meta: { subject: "Acme NDA" } });
		});

		expect(form.getValues()).toEqual({
			meta: { subject: "Acme NDA", message: "", emailSettings: { recipientSigned: true } },
		});
	});

	it("writes nothing for an empty nested object", async () => {
		interface Nested {
			meta: { subject: string };
		}
		let form: UseFormReturn<Nested> | undefined;
		function Wizard(): ReactNode {
			form = useForm<Nested>({ defaultValues: { meta: { subject: "Acme NDA" } } });
			return null;
		}
		render(<Wizard />);
		if (form === undefined) {
			throw new Error("the form was not built");
		}
		const written = vi.spyOn(form, "setValue");
		const source = fromReactHookForm(form);

		// Nothing was specified under `meta`, so nothing is written.
		await act(async () => {
			await source.apply({ meta: {} });
		});

		expect(written).not.toHaveBeenCalled();
		expect(form.getValues()).toEqual({ meta: { subject: "Acme NDA" } });
	});

	it("writes an array whole, because that is what writing a field array means", async () => {
		interface WithList {
			signers: { email: string }[];
		}
		let form: UseFormReturn<WithList> | undefined;
		function Signers(): ReactNode {
			form = useForm<WithList>({ defaultValues: { signers: [] } });
			return null;
		}
		render(<Signers />);
		if (form === undefined) {
			throw new Error("the form was not built");
		}
		const written = vi.spyOn(form, "setValue");
		const source = fromReactHookForm(form);

		await act(async () => {
			await source.apply({ signers: [{ email: "ada@example.com" }] });
		});

		expect(written.mock.calls).toEqual([
			["signers", [{ email: "ada@example.com" }], { shouldValidate: true, shouldDirty: true }],
		]);
	});
});
