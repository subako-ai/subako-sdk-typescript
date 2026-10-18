/**
 * Forms an agent puts to a person through `builtin:ask_user`: reading a
 * pending one, and spelling the answer `answerInput` sends.
 */
import type * as api from "./generated/index.js";

/** A form the session is still waiting on: the event that put it, with its seq. */
export type PendingInput = Extract<api.SessionEventBody, { type: "input_requested" }>;

/** How a person answers a form: submitted with one outcome per question, or declined. */
export type InputAnswer = api.InputResponseForm;

/**
 * A question's widget as this client reads it: one of the widgets it was built
 * knowing, or `unsupported` for one a newer Core put that it cannot name.
 * Which custom ids a client can draw is up to its renderers; this only reads
 * the kinds.
 */
export type ReadWidget = api.QuestionWidgetBody | { readonly type: "unsupported"; readonly name: string };

/** Reads `widget`, answering `unsupported` for a kind this client does not know. */
export function readWidget(widget: api.QuestionWidgetBody): ReadWidget {
	switch (widget.type) {
		case "select":
		case "text":
		case "confirm":
		case "custom":
			return widget;
		// A Core newer than this client may ask with a widget it was built without.
		default:
			return { type: "unsupported", name: String((widget as { readonly type: unknown }).type) };
	}
}

/** The name a grant lists `widget` under: the built-in's kind, or the custom widget's id. */
export function widgetName(widget: ReadWidget): string {
	switch (widget.type) {
		case "select":
		case "text":
		case "confirm":
			return widget.type;
		case "custom":
			return widget.data.id;
		case "unsupported":
			return widget.name;
		default:
			return widget satisfies never;
	}
}

/** A submission carrying `outcomes`, keyed by question id, in the form's own order. */
export function submittedAnswer(
	input: PendingInput,
	outcomes: Readonly<Record<string, api.QuestionOutcomeBody>>,
): InputAnswer {
	return {
		type: "submitted",
		data: {
			answers: input.request.questions.map((question) => ({
				question_id: question.id,
				outcome: outcomes[question.id] ?? { type: "skipped" },
			})),
		},
	};
}

/**
 * Every question of `input` answered `unsupported`: what a client that can draw
 * none of them sends when the person tells the agent so, so it can ask again
 * another way.
 */
export function unsupportedAnswer(input: PendingInput): InputAnswer {
	return submittedAnswer(
		input,
		Object.fromEntries(input.request.questions.map((question) => [question.id, { type: "unsupported" } as const])),
	);
}
