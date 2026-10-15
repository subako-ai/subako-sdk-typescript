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
const endsRun = (
	event: api.SessionEventBody,
): event is Extract<api.SessionEventBody, { type: "run_completed" | "run_failed" | "run_cancelled" }> =>
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

/** A display name the log announced, and who wrote it. */
export type DisplayNameChange = EventOf<"session_display_name_changed">;

/**
 * The last display name the log announced, or `undefined` while it announced none.
 * A name given at creation is not on the log, so a session nobody renamed reads
 * its name from `sessions.get` instead.
 */
export function latestDisplayName(events: readonly api.SessionEventBody[]): DisplayNameChange | undefined {
	return events.findLast((event): event is DisplayNameChange => event.type === "session_display_name_changed");
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

/** One block of a message still being produced: the text its deltas carried so far, at its place in the message. */
export type LiveBlock =
	| { readonly type: "text"; readonly index: number; readonly text: string }
	| { readonly type: "thinking"; readonly index: number; readonly thinking: string }
	/** `arguments` is the JSON text received so far, which parses only once the call is complete. */
	| {
			readonly type: "tool_call";
			readonly index: number;
			readonly id: string;
			readonly name: string;
			readonly arguments: string;
	  };

/** What a live message previews, and so which commit ends it: the target its delta frames name. */
export type LiveTarget = api.DeltaTargetBody;

/** A key for `target` that no other live target shares, for a list that renders them. */
export function liveKey(target: LiveTarget): string {
	switch (target.type) {
		case "model_call":
			return `model_call:${target.data.model_call_id}`;
		// COVERAGE(never): a target has no other type, which `satisfies never` proves.
		default:
			return target.type satisfies never;
	}
}

/** The key of the target `event` commits, when it commits one. */
function committedBy(event: api.SessionEventBody): string | undefined {
	switch (event.type) {
		case "message_assistant": {
			const call = event.message.model_call_id;
			return call === undefined || call === null
				? undefined
				: liveKey({ type: "model_call", data: { model_call_id: call } });
		}
		default:
			return undefined;
	}
}

/**
 * Output a model call is still producing, built from the stream's delta
 * frames. It is a preview: the log never holds it, frames may be missing, and
 * the event that commits its target replaces it.
 */
export interface LiveMessage {
	readonly runId: string;
	readonly target: LiveTarget;
	/** The last frame applied, so one already held is dropped. */
	readonly n: number;
	/** In content order. A reader that joined mid-call holds a block from where it joined. */
	readonly content: readonly LiveBlock[];
}

/**
 * The live messages, and what the log has settled under them: a frame that
 * arrives after the commit of its target, or after its run ended, previews
 * nothing.
 */
export interface LiveState {
	readonly messages: readonly LiveMessage[];
	/**
	 * The targets the log committed in the run under way, keyed by `liveKey`. A
	 * session runs one run at a time, so the run's end clears them: `ended`
	 * covers them from then on.
	 */
	readonly committed: ReadonlySet<string>;
	/** The runs the log ended. */
	readonly ended: ReadonlySet<string>;
}

/** No live message, and nothing settled. */
export const EMPTY_LIVE: LiveState = { messages: [], committed: new Set(), ended: new Set() };

type DeltaPart = api.DeltaPartBody;

/** `part` appended to the block it grows, or as a new block in its place. */
function grow(content: readonly LiveBlock[], part: DeltaPart): readonly LiveBlock[] {
	const at = content.findIndex((block) => block.index === part.data.index);
	const block = at === -1 ? undefined : content[at];
	let next: LiveBlock;
	switch (part.type) {
		case "text":
			next = {
				type: "text",
				index: part.data.index,
				text: (block?.type === "text" ? block.text : "") + part.data.text,
			};
			break;
		case "thinking":
			next = {
				type: "thinking",
				index: part.data.index,
				thinking: (block?.type === "thinking" ? block.thinking : "") + part.data.thinking,
			};
			break;
		case "tool_call":
			next = {
				type: "tool_call",
				index: part.data.index,
				id: part.data.id,
				name: part.data.name,
				arguments: (block?.type === "tool_call" ? block.arguments : "") + part.data.arguments,
			};
			break;
		// COVERAGE(never): a part has no other type, which `satisfies never` proves.
		default:
			return part satisfies never;
	}
	if (at === -1) {
		return [...content, next].sort((a, b) => a.index - b.index);
	}
	return content.map((existing, i) => (i === at ? next : existing));
}

/**
 * The live state after one delta frame: its message grown by an `append`, gone
 * after a `discard`, and unchanged by a frame already held or one whose
 * target or run the log settled. Only the message the frame names is
 * replaced, so every other keeps its identity.
 */
export function foldDelta(live: LiveState, frame: api.SessionDeltaBody): LiveState {
	const key = liveKey(frame.target);
	if (live.committed.has(key) || live.ended.has(frame.run_id)) {
		return live;
	}
	const at = live.messages.findIndex((message) => liveKey(message.target) === key);
	const message = at === -1 ? undefined : live.messages[at];
	if (message !== undefined && frame.n <= message.n) {
		return live;
	}
	switch (frame.delta.type) {
		case "discard":
			return message === undefined ? live : { ...live, messages: live.messages.filter((_, i) => i !== at) };
		case "append": {
			const content = frame.delta.data.parts.reduce(grow, message?.content ?? []);
			const next: LiveMessage = { runId: frame.run_id, target: frame.target, n: frame.n, content };
			return {
				...live,
				messages: message === undefined ? [...live.messages, next] : live.messages.map((m, i) => (i === at ? next : m)),
			};
		}
		// COVERAGE(never): a delta has no other type, which `satisfies never` proves.
		default:
			return frame.delta satisfies never;
	}
}

/**
 * The live state once `event` is in the log: the message it commits leaves,
 * and a run that ended takes every message it was still producing with it.
 * Either way, a later frame for what it settled is dropped.
 */
export function settleLive(live: LiveState, event: api.SessionEventBody): LiveState {
	if (endsRun(event)) {
		const run = event.run_id;
		return {
			messages: live.messages.filter((message) => message.runId !== run),
			committed: new Set(),
			ended: new Set([...live.ended, run]),
		};
	}
	const key = committedBy(event);
	if (key === undefined) {
		return live;
	}
	return {
		...live,
		messages: live.messages.filter((message) => liveKey(message.target) !== key),
		committed: new Set([...live.committed, key]),
	};
}
