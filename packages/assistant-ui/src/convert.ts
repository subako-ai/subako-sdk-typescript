import type { ThreadMessageLike } from "@assistant-ui/react";
import type { ContentBlockBody, TranscriptMessage } from "@subako-ai/sdk";

/** One part of an assistant-ui message; its content is either a string or these. */
type ContentPart = Extract<ThreadMessageLike["content"], readonly unknown[]>[number];

/** The part a `tool_call` block becomes, with the result and the approval joined to it. */
type ToolCallPart = Extract<ContentPart, { type: "tool-call" }>;

/** One `tool_call` block of the log, as the SDK's `transcript` joined it. */
type TranscriptCall = NonNullable<TranscriptMessage["toolCalls"]>[number];

/** The arguments arrive as JSON off the wire; assistant-ui asks for them typed as JSON. */
const asArguments = (args: Record<string, unknown>): NonNullable<ToolCallPart["args"]> =>
	args as NonNullable<ToolCallPart["args"]>;

/** A tool result is content blocks; assistant-ui renders one value, so the blocks are read as text. */
const resultText = (content: readonly ContentBlockBody[]): string =>
	content.map((block) => (block.type === "text" ? block.data.text : JSON.stringify(block.data))).join("\n");

/**
 * The approval, in assistant-ui's spelling: an id with no decision is what its
 * renderers read as "still waiting", which is what shows the prompt.
 */
function approvalOf(call: TranscriptCall): ToolCallPart["approval"] {
	switch (call.approval) {
		case "pending":
			return { id: call.id };
		case "allowed":
			return { id: call.id, approved: true };
		case "denied":
			return { id: call.id, approved: false };
		// The run ended before anyone decided, so there is nothing left to answer.
		case "voided":
		case undefined:
			return undefined;
	}
}

function toolCallPart(call: TranscriptCall): ContentPart {
	const approval = approvalOf(call);
	return {
		type: "tool-call",
		toolCallId: call.id,
		toolName: call.name,
		args: asArguments(call.arguments),
		...(call.result === undefined ? {} : { result: resultText(call.result.content), isError: call.result.is_error }),
		...(approval === undefined ? {} : { approval }),
	};
}

/**
 * One message of the log as assistant-ui reads it: `text` becomes a text part,
 * `thinking` a reasoning part, and every `tool_call` the joined call, so its
 * result and its approval travel with it.
 *
 * The id is the event's `seq`, which the log never reuses. The conversion is
 * pure, and assistant-ui caches it on the identity of the message object rather
 * than on that id — so what keeps the cache warm is the connection's transcript
 * handing back the same message until an event touches it.
 */
export function convertMessage(message: TranscriptMessage): ThreadMessageLike {
	// `transcript` joins result and approval onto the calls, so the blocks are read through them.
	const calls = new Map((message.toolCalls ?? []).map((call) => [call.id, call]));
	const content: ContentPart[] = [];
	for (const block of message.message.content) {
		switch (block.type) {
			case "text":
				content.push({ type: "text", text: block.data.text });
				break;
			case "thinking":
				content.push({ type: "reasoning", text: block.data.thinking });
				break;
			case "tool_call":
				content.push(toolCallPart(calls.get(block.data.id) ?? { ...block.data }));
				break;
			default:
				break;
		}
	}
	return {
		role: message.role,
		id: String(message.seq),
		content,
		// Where a user turn came from: the client, a steer, or something outside the browser.
		...(message.source === undefined ? {} : { metadata: { custom: { source: message.source } } }),
	};
}
