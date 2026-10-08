import { useTool } from "@subako-ai/react";
import { fromReactHookForm } from "@subako-ai/react-hook-form";
import { formTool, submitTool } from "@subako-ai/tools";
import { type ReactNode, useCallback, useRef } from "react";
import { type FieldErrors, type Resolver, useForm } from "react-hook-form";
import { z } from "zod";
import { useAgent } from "../agent";
import { useApp } from "../app";

const Fields = z.object({
	title: z.string().min(1, "a title is required").describe("What the todo is called."),
	notes: z.string().describe("Anything worth remembering about it."),
	due: z.string().describe("The due date as YYYY-MM-DD, or empty."),
});

type Values = z.infer<typeof Fields>;

/** A partial fill is a valid call, so the schema the model is offered is the partial one. */
const Fill = Fields.partial();

/** react-hook-form's resolver contract, in the few lines zod needs; no extra dependency. */
const resolver: Resolver<Values> = (values) => {
	const parsed = Fields.safeParse(values);
	if (parsed.success) {
		return { values: parsed.data, errors: {} };
	}
	const errors: FieldErrors<Values> = {};
	for (const issue of parsed.error.issues) {
		const name = issue.path[0];
		if (typeof name === "string" && name in Fields.shape) {
			const key = name as keyof Values;
			errors[key] ??= { type: issue.code, message: issue.message };
		}
	}
	return { values: {}, errors };
};

export interface AddTodoModalProps {
	readonly onClose: () => void;
}

/** The add-todo modal, and the form tool that exists only while it is mounted. */
export function AddTodoModal({ onClose }: AddTodoModalProps): ReactNode {
	const app = useApp();
	const { client } = useAgent();
	const formRef = useRef<HTMLFormElement>(null);
	const form = useForm<Values>({ defaultValues: { title: "", notes: "", due: "" }, resolver });

	// `fromReactHookForm` writes with setValue and reads back with getValues, so the model sees
	// what it actually wrote; `target` lights the form up while a call is running. The definition
	// is rebuilt on every render, which the client answers with nothing but a fresh handler.
	const source = fromReactHookForm(form, { schema: Fill });

	useTool(
		client,
		"fill_todo_form",
		formTool({
			...source,
			description: "Fill in the open add-todo form. Submitting it is submit_add_todo's part, not this one's.",
		}),
		{ target: formRef },
	);

	// react-hook-form's `handleSubmit` runs the valid path or leaves errors behind, and answers
	// either way, so the flag set inside it is what says which of the two happened.
	const sent = useRef(false);

	const submit = form.handleSubmit(async (values) => {
		await app.addTodo({ title: values.title, notes: values.notes, due: values.due === "" ? null : values.due });
		sent.current = true;
		form.reset();
		onClose();
	});

	const send = useCallback(async () => {
		sent.current = false;
		await submit();
		// `handleSubmit` answers before the errors it left behind have been validated and published,
		// and the answer is read as soon as this resolves; the adapter's `apply` waits for the same
		// two things after a fill.
		await form.trigger();
		await new Promise((resolve) => {
			setTimeout(resolve, 0);
		});
		return sent.current;
	}, [form, submit]);

	// The modal unmounts on a submit that went through, so the form is only read on a refusal.
	useTool(
		client,
		"submit_add_todo",
		submitTool({
			description: "Submit the open add-todo form, which is what creates the todo. Fill it in first.",
			submit: send,
			read: () => source.read?.() ?? { values: form.getValues() },
		}),
		{ target: formRef },
	);

	const errors = form.formState.errors;

	return (
		<div className="backdrop" onClick={onClose}>
			<div className="modal" role="dialog" aria-label="Add todo" onClick={(event) => event.stopPropagation()}>
				<h2>Add todo</h2>
				<form ref={formRef} className="form" onSubmit={(event) => void submit(event)}>
					<label htmlFor="todo-title">Title</label>
					<input id="todo-title" required {...form.register("title")} />
					{errors.title === undefined ? null : <p className="error">{errors.title.message}</p>}

					<label htmlFor="todo-notes">Notes</label>
					<textarea id="todo-notes" rows={3} {...form.register("notes")} />

					<label htmlFor="todo-due">Due date</label>
					<input id="todo-due" type="date" {...form.register("due")} />

					<div className="actions">
						<button type="button" onClick={onClose}>
							Cancel
						</button>
						<button type="submit" className="primary" disabled={form.formState.isSubmitting}>
							Add
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}
