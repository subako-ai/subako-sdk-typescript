import type { ThreadMessageLike } from "@assistant-ui/react";
import {
	type ContentBlockBody,
	type LiveBlock,
	type LiveMessage,
	liveKey,
	type TranscriptMessage,
} from "@subako-ai/sdk";

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

/**
 * The arguments a call streamed so far, once they parse; `undefined` while
 * they are still partial. JSON that ends in `}` and parses is an object, as
 * arguments are, and most frames leave the text mid-value, so nothing else is
 * parsed at all.
 */
function partialArguments(text: string): NonNullable<ToolCallPart["args"]> | undefined {
	if (!text.trimEnd().endsWith("}")) {
		return undefined;
	}
	try {
		return asArguments(JSON.parse(text) as Record<string, unknown>);
	} catch {
		return undefined;
	}
}

function livePart(block: LiveBlock): ContentPart {
	switch (block.type) {
		case "text":
			return { type: "text", text: block.text };
		case "thinking":
			return { type: "reasoning", text: block.thinking };
		case "tool_call": {
			const args = partialArguments(block.arguments);
			return {
				type: "tool-call",
				toolCallId: block.id,
				toolName: block.name,
				argsText: block.arguments,
				...(args === undefined ? {} : { args }),
			};
		}
		// COVERAGE(never): a live block has no other type, which `satisfies never` proves.
		default:
			return block satisfies never;
	}
}

/**
 * A message a model call is still producing, as assistant-ui reads it: an
 * assistant message marked running, whose tool calls carry the argument text
 * streamed so far. Its id is the model call's, so it keeps its place in the
 * thread from one frame to the next until the logged message replaces it.
 */
export function convertLiveMessage(message: LiveMessage): ThreadMessageLike {
	return {
		role: "assistant",
		id: `live:${liveKey(message.target)}`,
		content: message.content.map(livePart),
		status: { type: "running" },
	};
}
