import type * as api from "./generated/index.js";

type EventOf<T extends api.SessionEventBody["type"]> = Extract<api.SessionEventBody, { type: T }>;

type ToolCallBlock = Extract<api.ContentBlockBody, { type: "tool_call" }>;

/** An approval the session is still waiting on: the event that asked, with its seq. */
export type PendingApproval = EventOf<"approval_requested">;

/** What the log said one tool call answered with, as it came off the wire. */
export type ToolCallResult = Pick<EventOf<"tool_result">, "content" | "is_error">;

/**
 * Asked for and unanswered, the decision that settled it, or `voided`: the run
 * ended before anyone decided, and Core dropped the request with it.
 */
export type ApprovalState = "pending" | "allowed" | "denied" | "voided";

/** One `tool_call` block of an assistant message, joined to what the log later said about it. */
export type TranscriptToolCall = Readonly<ToolCallBlock["data"]> & {
	/** The `tool_result` for this call, once the log carries one. */
	readonly result?: ToolCallResult;
	/** Set only for a call an `approval_requested` named. */
	readonly approval?: ApprovalState;
};

/** One turn of the conversation: the message as it arrived, and the calls it made. */
export interface TranscriptMessage {
	readonly seq: number;
	/** When the log appended it: the event's `created_at`. */
	readonly createdAt: string;
	readonly role: "user" | "assistant";
	/** The same object the event carries, never copied. */
	readonly message: api.MessageBody;
	/** Where a user message came from; unset for an assistant one. */
	readonly source?: api.InputSourceBody;
	/** The assistant's `tool_call` blocks, in the order the message holds them. */
	readonly toolCalls?: readonly TranscriptToolCall[];
}

const isToolCall = (block: api.ContentBlockBody): block is ToolCallBlock => block.type === "tool_call";

/** Whether `event` ends a run, which drops whatever approval it was waiting on. */
const endsRun = (event: api.SessionEventBody): boolean =>
	event.type === "run_completed" || event.type === "run_failed" || event.type === "run_cancelled";

/**
 * The approvals with no `approval_resolved` after them, in seq order, as the
 * events themselves. A run that ends takes its approvals with it, since a
 * session runs one run at a time and Core voids them with the run.
 */
export function pendingApprovals(events: readonly api.SessionEventBody[]): readonly PendingApproval[] {
	// Insertion order is seq order, and a call asked again keeps the place its first ask took.
	const waiting = new Map<string, PendingApproval>();
	for (const event of events) {
		if (event.type === "approval_requested") {
			waiting.set(event.call_id, event);
		} else if (event.type === "approval_resolved") {
			waiting.delete(event.call_id);
		} else if (endsRun(event)) {
			waiting.clear();
		}
	}
	return [...waiting.values()];
}

/** Whether a run is queued or under way: one with no terminal event after it. */
export function isRunning(events: readonly api.SessionEventBody[]): boolean {
	const open = new Set<string>();
	for (const event of events) {
		switch (event.type) {
			case "run_queued":
			case "run_started":
				open.add(event.run_id);
				break;
			case "run_completed":
			case "run_failed":
			case "run_cancelled":
				open.delete(event.run_id);
				break;
			default:
				break;
		}
	}
	return open.size > 0;
}

/** Where one `tool_call` sits: the message that carries it, and its place among that message's calls. */
interface CallPlace {
	readonly index: number;
	readonly position: number;
}

/** What the log says came of one tool call, apart from the call itself. */
type CallFacts = Pick<TranscriptToolCall, "result" | "approval">;

/** A transcript in progress: what a fold made of the events it has read, and how far it read. */
export interface TranscriptFold {
	readonly messages: readonly TranscriptMessage[];
	/** Events already folded, so the next fold reads only what came after them. */
	readonly read: number;
	/** Where every `tool_call` so far sits, so a later event finds its own in one lookup. */
	readonly places: ReadonlyMap<string, CallPlace>;
	/**
	 * What came of calls no message has made yet. The engine reports its message
	 * on one channel and makes the call on another, so Core can log the approval
	 * the call asks for ahead of the message carrying it; the facts join the
	 * call once that message arrives.
	 */
	readonly early: ReadonlyMap<string, CallFacts>;
	/** The calls whose approval is still pending, which the run ending voids. */
	readonly waiting: ReadonlySet<string>;
}

/** Where a fold starts: no messages, no calls, nothing read. */
export const EMPTY_TRANSCRIPT: TranscriptFold = {
	messages: [],
	read: 0,
	places: new Map(),
	early: new Map(),
	waiting: new Set(),
};

/**
 * Folds the events after `previous.read` into the transcript it carries. Only the
 * messages a new event touched are replaced, so every other message — and the
 * whole result, when nothing arrived — keeps the identity it had.
 */
export function foldTranscript(previous: TranscriptFold, events: readonly api.SessionEventBody[]): TranscriptFold {
	// The log only ever grows; a shorter one is another log, and is read from the start.
	const from = events.length < previous.read ? 0 : previous.read;
	if (from === events.length) {
		return previous;
	}
	const messages: TranscriptMessage[] = from === 0 ? [] : [...previous.messages];
	const places = new Map<string, CallPlace>(from === 0 ? undefined : previous.places);
	const early = new Map<string, CallFacts>(from === 0 ? undefined : previous.early);
	const waiting = new Set<string>(from === 0 ? undefined : previous.waiting);
	/**
	 * Rebuilds the one message a result or an approval joins, leaving every other
	 * message alone; for a call no message has made yet, keeps the facts for it.
	 */
	const join = (callId: string, facts: CallFacts): void => {
		const place = places.get(callId);
		const message = place === undefined ? undefined : messages[place.index];
		const call = place === undefined ? undefined : message?.toolCalls?.[place.position];
		if (place === undefined || message?.toolCalls === undefined || call === undefined) {
			early.set(callId, { ...early.get(callId), ...facts });
			return;
		}
		const toolCalls = [...message.toolCalls];
		toolCalls[place.position] = { ...call, ...facts };
		messages[place.index] = { ...message, toolCalls };
	};
	for (const event of events.slice(from)) {
		switch (event.type) {
			case "message_user":
				messages.push({
					seq: event.seq,
					createdAt: event.created_at,
					role: "user",
					message: event.message,
					source: event.source,
				});
				break;
			case "message_assistant": {
				const index = messages.length;
				const toolCalls = event.message.content.filter(isToolCall).map((block, position) => {
					places.set(block.data.id, { index, position });
					const facts = early.get(block.data.id);
					early.delete(block.data.id);
					return { ...block.data, ...facts };
				});
				messages.push({
					seq: event.seq,
					createdAt: event.created_at,
					role: "assistant",
					message: event.message,
					...(toolCalls.length === 0 ? {} : { toolCalls }),
				});
				break;
			}
			case "tool_result":
				join(event.call_id, { result: { content: event.content, is_error: event.is_error } });
				break;
			case "approval_requested":
				waiting.add(event.call_id);
				join(event.call_id, { approval: "pending" });
				break;
			case "approval_resolved":
				waiting.delete(event.call_id);
				join(event.call_id, { approval: event.decision === "allow" ? "allowed" : "denied" });
				break;
			case "run_completed":
			case "run_failed":
			case "run_cancelled":
				for (const callId of waiting) {
					join(callId, { approval: "voided" });
				}
				waiting.clear();
				break;
			default:
				break;
		}
	}
	return { messages, read: events.length, places, early, waiting };
}

/** The log's conversation in seq order, each `tool_call` joined to its `tool_result` and its approval. */
export function transcript(events: readonly api.SessionEventBody[]): readonly TranscriptMessage[] {
	return foldTranscript(EMPTY_TRANSCRIPT, events).messages;
}
