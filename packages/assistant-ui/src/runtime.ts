"use client";

import type { AppendMessage, AssistantRuntime, AttachmentAdapter } from "@assistant-ui/react";
import { useExternalStoreRuntime } from "@assistant-ui/react";
import { useSessionState } from "@subako-ai/react";
import type { InputAnswer, LiveMessage, SessionState, TranscriptMessage } from "@subako-ai/sdk";
import { useMemo } from "react";
import { convertLiveMessage, convertMessage } from "./convert.js";

/**
 * What the runtime reads off a session: the SDK's `SessionConnection`, or
 * anything else that carries the same members. It is spelled structurally so a
 * session from `useSession` fits without this package naming the hook's type.
 */
export interface SubakoSession {
	/** The connection as it stands, transcript and all: the store the runtime subscribes to and reads. */
	readonly state: SessionState;
	/** Calls `listener` with the state after every change; returns an unsubscribe. */
	readonly subscribe: (listener: (state: SessionState) => void) => () => void;
	/** Posts a user turn, which queues a run or steers the active one. */
	send(text: string, options?: { readonly uploadIds?: readonly string[] }): Promise<void>;
	/** Uploads a file for the next turn to carry, and answers with the id that turn names it by. */
	upload(file: Blob, options: { readonly name: string }): Promise<{ readonly id: string }>;
	/** Downloads a file a message carries. */
	readAttachment(attachmentId: string): Promise<Blob>;
	/** Cancels the active run. */
	cancel(): Promise<void>;
	resolveApproval(callId: string, decision: "allow" | "deny", message?: string): Promise<void>;
	/** Answers a form the agent put through `builtin:ask_user`. */
	answerInput(callId: string, answer: InputAnswer): Promise<void>;
}

/** One message of the thread: one the log holds, or one a model call is still producing. */
type ThreadEntry = TranscriptMessage | LiveMessage;

/** The thread before the connection is open: no messages, and the same array on every render. */
const NOTHING: readonly ThreadEntry[] = [];

const convertEntry = (entry: ThreadEntry) => ("target" in entry ? convertLiveMessage(entry) : convertMessage(entry));

/** assistant-ui hands the composer's parts; a session takes one string. */
function appendedText(message: AppendMessage): string {
	let text = "";
	for (const part of message.content) {
		if (part.type === "text") {
			text += part.text;
		}
	}
	return text;
}

/**
 * The composer's files, uploaded when the turn is sent rather than when they
 * are picked, so a file taken back leaves nothing behind. A sent attachment's
 * id is its upload's, which is what the turn names.
 */
function attachmentAdapter(session: SubakoSession): AttachmentAdapter {
	return {
		accept: "*",
		async add({ file }) {
			return {
				id: crypto.randomUUID(),
				type: file.type.startsWith("image/") ? "image" : "file",
				name: file.name,
				contentType: file.type,
				file,
				status: { type: "requires-action", reason: "composer-send" },
			};
		},
		async send(attachment) {
			const { id } = await session.upload(attachment.file, { name: attachment.name });
			return { ...attachment, id, status: { type: "complete" }, content: [] };
		},
		async remove() {},
	};
}

export interface SubakoRuntimeOptions {
	/**
	 * Lets the composer attach files. Set it for a session whose agent enables
	 * attachments; any other refuses the upload.
	 */
	readonly allowAttachments?: boolean;
}

/**
 * An assistant-ui runtime over one Subako session: the log is the store, and
 * every action the thread offers is a call on the session.
 *
 * | assistant-ui              | Subako                                            |
 * | ------------------------- | ------------------------------------------------- |
 * | `messages`                | `state.transcript`, then `state.live`             |
 * | `isRunning`               | `state.isRunning`                                 |
 * | `onNew`                   | `send(text, { uploadIds })`                       |
 * | `adapters.attachments`    | `upload(file, { name })`, with `allowAttachments` |
 * | `onCancel`                | `cancel()`                                        |
 * | `onRespondToToolApproval` | `resolveApproval(callId, decision, reason)`       |
 *
 * The runtime keeps no messages of its own: what the server put on the log is
 * what the thread shows, and a send that fails leaves the log as it was. A
 * `null` session is the one `useSession` has yet to open: an empty thread, and
 * a composer disabled until there is something to send to.
 *
 * The session is a value, not something React re-renders for, so the runtime
 * subscribes to it here: a chat handed the session by a parent that does not
 * re-render still follows the log.
 *
 * A session opened with `deltas` also shows what a model is writing while it
 * writes it: each of `state.live` follows the log as a running assistant
 * message, which the logged message replaces once it lands.
 */
export function useSubakoRuntime(session: SubakoSession | null, options?: SubakoRuntimeOptions): AssistantRuntime {
	const attaches = options?.allowAttachments === true;
	const attachments = useMemo(
		() => (session === null || !attaches ? undefined : attachmentAdapter(session)),
		[session, attaches],
	);
	// The snapshot this render was woken for, which is what the thread is built from.
	const state = useSessionState(session);
	const transcript = state?.transcript;
	const live = state?.live;
	// Rebuilt only when either part changes, so assistant-ui's per-message cache stays warm.
	const messages = useMemo(
		(): readonly ThreadEntry[] =>
			transcript === undefined
				? NOTHING
				: live === undefined || live.length === 0
					? transcript
					: [...transcript, ...live],
		[transcript, live],
	);
	return useExternalStoreRuntime<ThreadEntry>({
		messages,
		isRunning: state?.isRunning ?? false,
		isDisabled: session === null,
		convertMessage: convertEntry,
		onNew: async (message) => {
			await session?.send(appendedText(message), {
				uploadIds: (message.attachments ?? []).map((attachment) => attachment.id),
			});
		},
		...(attachments === undefined ? {} : { adapters: { attachments } }),
		onCancel: async () => {
			await session?.cancel();
		},
		// The approval's id is the call it gates, which is what the session answers by.
		onRespondToToolApproval: async ({ approvalId, approved, reason }) => {
			await session?.resolveApproval(approvalId, approved ? "allow" : "deny", reason);
		},
	});
}
