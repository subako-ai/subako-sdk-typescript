import type { SessionEventBody, TranscriptMessage } from "@subako-ai/sdk";
import { transcript } from "@subako-ai/sdk";
import { describe, expect, it } from "vitest";
import { convertMessage } from "../src/convert.js";

/** When every event here was appended; nothing under test reads the time. */
const AT = "2026-01-01T00:00:00Z";

/** The converted content is always a list here; a string is the other half of the union. */
const parts = (message: TranscriptMessage) => {
	const { content } = convertMessage(message);
	if (typeof content === "string") {
		throw new Error("expected parts, not a string");
	}
	return content;
};

const userTurn = (seq: number, text: string): SessionEventBody => ({
	seq,
	created_at: AT,
	type: "message_user",
	source: "client",
	message: { role: "user", content: [{ type: "text", data: { text } }] },
});

const assistantTurn = (seq: number, text: string, callId: string): SessionEventBody => ({
	seq,
	created_at: AT,
	type: "message_assistant",
	message: {
		role: "assistant",
		content: [
			{ type: "text", data: { text } },
			{ type: "tool_call", data: { id: callId, name: "search", arguments: { query: "subako" } } },
		],
	},
});

const toolResult = (seq: number, callId: string, text: string, isError = false): SessionEventBody => ({
	seq,
	created_at: AT,
	type: "tool_result",
	call_id: callId,
	is_error: isError,
	content: [{ type: "text", data: { text } }],
});

const asked = (seq: number, callId: string): SessionEventBody => ({
	seq,
	created_at: AT,
	type: "approval_requested",
	call_id: callId,
	server: "web",
	tool: "search",
	arguments: {},
	args_hash: "h1",
});

/** The one message the events describe, so a case reads as the log that produced it. */
const only = (events: readonly SessionEventBody[], index = 0): TranscriptMessage => {
	const message = transcript(events)[index];
	if (message === undefined) {
		throw new Error("the events carry no such message");
	}
	return message;
};

describe("convertMessage", () => {
	it("maps a user turn to a text part, carrying where it came from", () => {
		const message = only([userTurn(1, "hello")]);
		const converted = convertMessage(message);

		expect(converted.role).toBe("user");
		expect(converted.id).toBe("1");
		expect(parts(message)).toEqual([{ type: "text", text: "hello" }]);
		expect(converted.metadata?.custom).toEqual({ source: "client" });
	});

	it("maps an assistant turn to a text part and a tool call with no result yet", () => {
		const converted = parts(only([assistantTurn(2, "looking", "c1")]));

		expect(converted).toEqual([
			{ type: "text", text: "looking" },
			{ type: "tool-call", toolCallId: "c1", toolName: "search", args: { query: "subako" } },
		]);
	});

	it("joins the tool result onto the call, as text, with its error flag", () => {
		const converted = parts(only([assistantTurn(2, "looking", "c1"), toolResult(3, "c1", "found it", true)]));

		expect(converted[1]).toEqual({
			type: "tool-call",
			toolCallId: "c1",
			toolName: "search",
			args: { query: "subako" },
			result: "found it",
			isError: true,
		});
	});

	it("marks a pending approval with a decision assistant-ui reads as unanswered", () => {
		const converted = parts(only([assistantTurn(2, "looking", "c1"), asked(3, "c1")]));

		// No decision recorded on the approval is what shows the prompt.
		expect(converted[1]).toEqual({
			type: "tool-call",
			toolCallId: "c1",
			toolName: "search",
			args: { query: "subako" },
			approval: { id: "c1" },
		});
	});

	it("carries a settled approval as its decision, so no prompt is shown", () => {
		const resolved: SessionEventBody = {
			seq: 4,
			created_at: AT,
			type: "approval_resolved",
			call_id: "c1",
			decision: "deny",
		};
		const converted = parts(only([assistantTurn(2, "looking", "c1"), asked(3, "c1"), resolved]));

		expect(converted[1]).toMatchObject({ approval: { id: "c1", approved: false } });
	});

	it("maps a thinking block to a reasoning part", () => {
		const thinking: SessionEventBody = {
			seq: 5,
			created_at: AT,
			type: "message_assistant",
			message: {
				role: "assistant",
				content: [{ type: "thinking", data: { thinking: "one moment", redacted: false } }],
			},
		};

		expect(parts(only([thinking]))).toEqual([{ type: "reasoning", text: "one moment" }]);
	});

	it("is pure: one message converts to an equal value every time, under the seq as its id", () => {
		const message = only([assistantTurn(2, "looking", "c1"), toolResult(3, "c1", "found it")]);

		// Equal, not the same object: the caching is assistant-ui's, keyed on the message it was handed.
		expect(convertMessage(message)).toEqual(convertMessage(message));
		expect(convertMessage(message).id).toBe("2");
	});
});
