import { describe, expect, it } from "vitest";
import type { PendingInput, QuestionWidgetBody, SessionEventBody } from "../src/index.js";
import { pendingInputs, readWidget, submittedAnswer, unsupportedAnswer, widgetName } from "../src/index.js";

const AT = "2026-01-01T00:00:00Z";

const form = (seq: number, callId: string): PendingInput => ({
	seq,
	created_at: AT,
	type: "input_requested",
	call_id: callId,
	request: {
		questions: [
			{
				id: "day",
				prompt: "Which day?",
				required: true,
				widget: {
					type: "select",
					data: { options: [{ label: "Tue" }, { label: "Wed" }], multiple: false, allow_other: false },
				},
			},
			{
				id: "seats",
				prompt: "Where?",
				required: false,
				widget: { type: "custom", data: { id: "seat_picker", props: {} } },
			},
		],
	},
});

const settled = (seq: number, callId: string): SessionEventBody => ({
	seq,
	created_at: AT,
	type: "input_resolved",
	call_id: callId,
	resolution: { type: "expired" },
});

describe("pendingInputs", () => {
	it("keeps the forms no answer has settled, in seq order, and drops them with the run", () => {
		const events: SessionEventBody[] = [form(1, "c1"), form(2, "c2"), settled(3, "c1"), form(4, "c3")];
		expect(pendingInputs(events).map((input) => input.call_id)).toEqual(["c2", "c3"]);
		expect(pendingInputs(events)[0]).toBe(events[1]);
		expect(pendingInputs([...events, { seq: 5, created_at: AT, type: "run_failed", run_id: "r", error: "x" }])).toEqual(
			[],
		);
	});
});

describe("readWidget", () => {
	it("reads the widgets this client knows and names one it does not", () => {
		const known: QuestionWidgetBody[] = [
			{ type: "select", data: { options: [], multiple: false, allow_other: false } },
			{ type: "text", data: { multiline: false } },
			{ type: "confirm" },
			{ type: "custom", data: { id: "seat_picker", props: {} } },
		];
		for (const widget of known) {
			expect(readWidget(widget)).toBe(widget);
		}
		expect(known.map((widget) => widgetName(readWidget(widget)))).toEqual(["select", "text", "confirm", "seat_picker"]);
		const newer = { type: "slider", data: {} } as unknown as QuestionWidgetBody;
		expect(readWidget(newer)).toEqual({ type: "unsupported", name: "slider" });
		expect(widgetName(readWidget(newer))).toBe("slider");
	});
});

describe("answers", () => {
	it("submits one outcome per question in the form's order, skipping what is left out", () => {
		expect(submittedAnswer(form(1, "c1"), { day: { type: "answered", data: { value: ["Tue"] } } })).toEqual({
			type: "submitted",
			data: {
				answers: [
					{ question_id: "day", outcome: { type: "answered", data: { value: ["Tue"] } } },
					{ question_id: "seats", outcome: { type: "skipped" } },
				],
			},
		});
	});

	it("answers every question unsupported", () => {
		expect(unsupportedAnswer(form(1, "c1"))).toEqual({
			type: "submitted",
			data: {
				answers: [
					{ question_id: "day", outcome: { type: "unsupported" } },
					{ question_id: "seats", outcome: { type: "unsupported" } },
				],
			},
		});
	});
});
