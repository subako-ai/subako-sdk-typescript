"use client";

import type { InputAnswer, PendingInput, QuestionBody, QuestionOutcomeBody, ReadWidget } from "@subako-ai/sdk";
import { readWidget, submittedAnswer, unsupportedAnswer, widgetName } from "@subako-ai/sdk";
import type { ReactNode } from "react";
import { useState } from "react";

/** What a custom widget's renderer is handed: the agent's props, and the answer so far. */
export interface WidgetProps {
	/** What the agent filled in, as the widget's props schema describes it. */
	readonly props: unknown;
	/** The answer so far: `undefined` until the person gives one. */
	readonly value: unknown;
	/** Sets the answer, which must match the widget's answer schema; `undefined` clears it. */
	readonly onChange: (value: unknown) => void;
	readonly question: QuestionBody;
}

/** A renderer for one custom widget, registered under the widget's id. */
export type WidgetRenderer = (props: WidgetProps) => ReactNode;

/** The custom widgets a client draws, by widget id. An id with no renderer answers `unsupported`. */
export type WidgetRenderers = Readonly<Record<string, WidgetRenderer>>;

export interface SubakoInputFormProps {
	readonly input: PendingInput;
	readonly widgets?: WidgetRenderers;
	/** Sends the answer: `session.answerInput(input.call_id, answer)`. */
	readonly onAnswer: (answer: InputAnswer) => Promise<void>;
}

/** Whether this client can draw `widget`. */
const drawable = (widget: ReadWidget, widgets: WidgetRenderers): boolean => {
	switch (widget.type) {
		case "select":
		case "text":
		case "confirm":
			return true;
		case "custom":
			return widgets[widget.data.id] !== undefined;
		case "unsupported":
			return false;
		default:
			return widget satisfies never;
	}
};

/** Whether `value` is an answer at all, rather than a blank. */
const given = (value: unknown): boolean =>
	value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0);

/** The question's outcome on submit: drawn and answered, left blank, or not drawable here. */
function outcomeOf(canDraw: boolean, value: unknown): QuestionOutcomeBody {
	if (!canDraw) {
		return { type: "unsupported" };
	}
	return given(value) ? { type: "answered", data: { value } } : { type: "skipped" };
}

interface FieldProps {
	readonly question: QuestionBody;
	readonly widget: ReadWidget;
	readonly widgets: WidgetRenderers;
	readonly value: unknown;
	readonly onChange: (value: unknown) => void;
}

/** A select: radios for one pick, checkboxes for several, and a text box for the person's own answer. */
function SelectField({
	question,
	widget,
	value,
	onChange,
}: FieldProps & { readonly widget: Extract<ReadWidget, { type: "select" }> }): ReactNode {
	const picked = Array.isArray(value) ? (value as string[]) : [];
	const labels = widget.data.options.map((option) => option.label);
	const other = picked.find((label) => !labels.includes(label)) ?? "";
	const chosen = picked.filter((label) => labels.includes(label));
	const set = (next: readonly string[], otherText: string) =>
		onChange(otherText === "" ? [...next] : [...next, otherText]);
	return (
		<div className="subako-input-options" role={widget.data.multiple ? "group" : "radiogroup"}>
			{widget.data.options.map((option) => (
				<label key={option.label} className="subako-input-option">
					<input
						type={widget.data.multiple ? "checkbox" : "radio"}
						name={question.id}
						checked={chosen.includes(option.label)}
						onChange={(event) => {
							if (widget.data.multiple) {
								set(
									event.target.checked ? [...chosen, option.label] : chosen.filter((label) => label !== option.label),
									other,
								);
							} else {
								set([option.label], "");
							}
						}}
					/>
					<span>{option.label}</span>
					{option.description === undefined ? null : <span className="subako-input-hint">{option.description}</span>}
				</label>
			))}
			{widget.data.allow_other ? (
				<input
					className="subako-input-text"
					aria-label="Other"
					placeholder="Other"
					value={other}
					onChange={(event) => set(widget.data.multiple ? chosen : [], event.target.value)}
				/>
			) : null}
		</div>
	);
}

function Field(props: FieldProps): ReactNode {
	const { question, widget, widgets, value, onChange } = props;
	switch (widget.type) {
		case "select":
			return <SelectField {...props} widget={widget} />;
		case "text":
			return widget.data.multiline ? (
				<textarea
					className="subako-input-text"
					aria-label={question.prompt}
					rows={3}
					value={typeof value === "string" ? value : ""}
					onChange={(event) => onChange(event.target.value)}
				/>
			) : (
				<input
					className="subako-input-text"
					aria-label={question.prompt}
					value={typeof value === "string" ? value : ""}
					onChange={(event) => onChange(event.target.value)}
				/>
			);
		case "confirm":
			return (
				<div className="subako-input-options" role="radiogroup">
					{[true, false].map((answer) => (
						<label key={String(answer)} className="subako-input-option">
							<input type="radio" name={question.id} checked={value === answer} onChange={() => onChange(answer)} />
							<span>{answer ? "Yes" : "No"}</span>
						</label>
					))}
				</div>
			);
		case "custom": {
			const Render = widgets[widget.data.id];
			return Render === undefined ? (
				<Unsupported widget={widget} />
			) : (
				<Render props={widget.data.props} value={value} onChange={onChange} question={question} />
			);
		}
		case "unsupported":
			return <Unsupported widget={widget} />;
		default:
			return widget satisfies never;
	}
}

function Unsupported({ widget }: { readonly widget: ReadWidget }): ReactNode {
	return <div className="subako-input-hint">This app can’t show “{widgetName(widget)}”.</div>;
}

/**
 * One form an agent put through `builtin:ask_user`: each question drawn with
 * its widget, a Submit that sends one outcome per question, and a Dismiss.
 * A custom widget draws with the renderer `widgets` registers under its id; a
 * question this client cannot draw is sent as `unsupported`, so the agent can
 * ask it another way. A form none of whose questions can be drawn shows only
 * a button that tells the agent so.
 */
export function SubakoInputForm({ input, widgets = {}, onAnswer }: SubakoInputFormProps): ReactNode {
	const [values, setValues] = useState<Readonly<Record<string, unknown>>>({});
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const questions = input.request.questions.map((question) => {
		const widget = readWidget(question.widget);
		return { question, widget, canDraw: drawable(widget, widgets) };
	});
	const send = (answer: InputAnswer) => {
		setSending(true);
		setError(undefined);
		onAnswer(answer).then(
			() => setSending(false),
			(cause: unknown) => {
				setSending(false);
				setError(cause instanceof Error ? cause.message : String(cause));
			},
		);
	};
	const failure = error === undefined ? null : <div className="subako-input-error">{error}</div>;

	if (questions.every(({ canDraw }) => !canDraw)) {
		return (
			<div className="subako-input-form" data-testid={`input-${input.call_id}`}>
				<div className="subako-input-hint">This app can’t show the agent’s question.</div>
				<div className="subako-input-actions">
					<button type="button" disabled={sending} onClick={() => send(unsupportedAnswer(input))}>
						Tell the agent
					</button>
				</div>
				{failure}
			</div>
		);
	}

	const missing = questions.some(
		({ question, canDraw }) => question.required && canDraw && !given(values[question.id]),
	);
	return (
		<form
			className="subako-input-form"
			data-testid={`input-${input.call_id}`}
			onSubmit={(event) => {
				event.preventDefault();
				send(
					submittedAnswer(
						input,
						Object.fromEntries(
							questions.map(({ question, canDraw }) => [question.id, outcomeOf(canDraw, values[question.id])]),
						),
					),
				);
			}}
		>
			{questions.map(({ question, widget }) => (
				<fieldset key={question.id} className="subako-input-question">
					<legend className="subako-input-prompt">
						{question.header === undefined ? null : <strong>{question.header}: </strong>}
						{question.prompt}
						{question.required ? " *" : null}
					</legend>
					<Field
						question={question}
						widget={widget}
						widgets={widgets}
						value={values[question.id]}
						onChange={(value) => setValues((previous) => ({ ...previous, [question.id]: value }))}
					/>
				</fieldset>
			))}
			<div className="subako-input-actions">
				<button type="submit" disabled={sending || missing}>
					Submit
				</button>
				<button type="button" disabled={sending} onClick={() => send({ type: "declined", data: {} })}>
					Dismiss
				</button>
			</div>
			{failure}
		</form>
	);
}
