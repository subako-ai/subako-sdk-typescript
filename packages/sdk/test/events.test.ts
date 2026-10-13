import { describe, expect, it } from "vitest";
import type { ContentBlockBody, MessageBody, SessionEventBody } from "../src/index.js";
import { isRunning, latestDisplayName, pendingApprovals, transcript } from "../src/index.js";
import { EMPTY_TRANSCRIPT, foldTranscript } from "../src/events.js";

/** When every event here was appended; the helpers read no time. */
const AT = "2026-01-01T00:00:00Z";

const text = (body: string): ContentBlockBody => ({ type: "text", data: { text: body } });

const toolCall = (id: string, name: string, args: Record<string, unknown>): ContentBlockBody => ({
	type: "tool_call",
	data: { id, name, arguments: args },
});

const message = (role: MessageBody["role"], content: readonly ContentBlockBody[]): MessageBody => ({
	role,
	content: [...content],
});

const fromAssistant = (seq: number, content: readonly ContentBlockBody[]): SessionEventBody => ({
	seq,
	created_at: AT,
	type: "message_assistant",
	message: message("assistant", content),
});

const result = (seq: number, callId: string, said: string, isError = false): SessionEventBody => ({
	seq,
	created_at: AT,
	type: "tool_result",
	call_id: callId,
	content: [text(said)],
	is_error: isError,
});

const requested = (seq: number, callId: string, tool: string): SessionEventBody => ({
	seq,
	created_at: AT,
	type: "approval_requested",
	args_hash: `h-${callId}`,
	arguments: { path: "/etc/hosts" },
	call_id: callId,
	server: "fs",
	tool,
});

const resolved = (seq: number, callId: string, decision: "allow" | "deny"): SessionEventBody => ({
	seq,
	created_at: AT,
	type: "approval_resolved",
	call_id: callId,
	decision,
});

describe("pendingApprovals", () => {
	it("answers with nothing for an empty log", () => {
		expect(pendingApprovals([])).toEqual([]);
	});

	it("keeps the approvals no decision has settled, in seq order", () => {
		const events = [
			requested(1, "call-1", "read_file"),
			requested(2, "call-2", "write_file"),
			resolved(3, "call-1", "allow"),
			requested(4, "call-3", "delete_file"),
		];

		expect(pendingApprovals(events).map((approval) => approval.seq)).toEqual([2, 4]);
	});

	it("answers with the events themselves", () => {
		const asked = requested(1, "call-1", "read_file");

		const [approval] = pendingApprovals([asked]);

		expect(approval).toBe(asked);
		expect(approval).toMatchObject({ call_id: "call-1", server: "fs", tool: "read_file" });
	});

	it("drops an approval a decision settled, whichever the decision was", () => {
		const events = [
			requested(1, "call-1", "read_file"),
			resolved(2, "call-1", "deny"),
			requested(3, "call-2", "write_file"),
			resolved(4, "call-2", "allow"),
		];

		expect(pendingApprovals(events)).toEqual([]);
	});

	it("keeps an approval asked again after its decision", () => {
		const events = [requested(1, "call-1", "read_file"), resolved(2, "call-1", "deny")];
		const again = requested(3, "call-1", "read_file");

		expect(pendingApprovals([...events, again])).toEqual([again]);
	});

	it.each(["run_completed", "run_failed", "run_cancelled"] as const)(
		"drops every approval when %s ends the run that asked",
		(type) => {
			const ended = { seq: 3, created_at: AT, type, run_id: "r1", error: "boom" } as SessionEventBody;
			const later = requested(4, "call-3", "read_file");

			expect(
				pendingApprovals([requested(1, "call-1", "read_file"), requested(2, "call-2", "read_file"), ended, later]),
			).toEqual([later]);
		},
	);
});

describe("isRunning", () => {
	const queued = (seq: number, runId: string): SessionEventBody => ({
		seq,
		created_at: AT,
		type: "run_queued",
		run_id: runId,
	});
	const started = (seq: number, runId: string): SessionEventBody => ({
		seq,
		created_at: AT,
		type: "run_started",
		run_id: runId,
	});
	const completed = (seq: number, runId: string): SessionEventBody => ({
		seq,
		created_at: AT,
		type: "run_completed",
		run_id: runId,
	});

	it("answers with false for an empty log", () => {
		expect(isRunning([])).toBe(false);
	});

	it("is true from the queue until the run ends, whichever way it ends", () => {
		expect(isRunning([queued(1, "r1")])).toBe(true);
		expect(isRunning([queued(1, "r1"), started(2, "r1")])).toBe(true);
		expect(isRunning([queued(1, "r1"), started(2, "r1"), completed(3, "r1")])).toBe(false);
		expect(
			isRunning([queued(1, "r1"), { seq: 2, created_at: AT, type: "run_failed", run_id: "r1", error: "boom" }]),
		).toBe(false);
		expect(isRunning([queued(1, "r1"), { seq: 2, created_at: AT, type: "run_cancelled", run_id: "r1" }])).toBe(false);
	});

	it("stays true while another run is still open", () => {
		const events = [queued(1, "r1"), queued(2, "r2"), completed(3, "r1")];

		expect(isRunning(events)).toBe(true);
		expect(isRunning([...events, completed(4, "r2")])).toBe(false);
	});

	it("ignores everything that is not a run", () => {
		expect(isRunning([result(1, "call-1", "done")])).toBe(false);
	});
});

describe("latestDisplayName", () => {
	const renamed = (seq: number, name: string, author: "user" | "agent"): SessionEventBody => ({
		seq,
		created_at: AT,
		type: "session_display_name_changed",
		display_name: name,
		author,
	});

	it("answers with undefined while the log announced no name", () => {
		expect(latestDisplayName([])).toBeUndefined();
		expect(latestDisplayName([result(1, "call-1", "done")])).toBeUndefined();
	});

	it("answers with the last announcement, as the event itself", () => {
		const last = renamed(3, "Trip plan", "user");

		expect(latestDisplayName([renamed(1, "Trip", "agent"), result(2, "call-1", "done"), last])).toBe(last);
	});
});

describe("transcript", () => {
	it("answers with nothing for an empty log", () => {
		expect(transcript([])).toEqual([]);
	});

	it("reads a turn: the user, the assistant's call, and the result that answered it", () => {
		const asked = message("user", [text("What is in /etc/hosts?")]);
		const answered = message("assistant", [
			text("Reading it."),
			toolCall("call-1", "read_file", { path: "/etc/hosts" }),
		]);
		const events: SessionEventBody[] = [
			{ seq: 1, created_at: AT, type: "message_user", source: "client", message: asked },
			{ seq: 2, created_at: AT, type: "message_assistant", message: answered },
			result(3, "call-1", "127.0.0.1 localhost"),
		];

		expect(transcript(events)).toEqual([
			{ seq: 1, createdAt: AT, role: "user", message: asked, source: "client" },
			{
				seq: 2,
				createdAt: AT,
				role: "assistant",
				message: answered,
				toolCalls: [
					{
						id: "call-1",
						name: "read_file",
						arguments: { path: "/etc/hosts" },
						result: { content: [text("127.0.0.1 localhost")], is_error: false },
					},
				],
			},
		]);
	});

	it("leaves a message with no tool calls without the field", () => {
		const [only] = transcript([fromAssistant(1, [text("Nothing to do.")])]);

		expect(only).toEqual({ seq: 1, createdAt: AT, role: "assistant", message: expect.any(Object) });
		expect(only).not.toHaveProperty("toolCalls");
	});

	it("skips a result that joins nothing", () => {
		const said = message("user", [text("Hi")]);
		const events: SessionEventBody[] = [
			{ seq: 1, created_at: AT, type: "message_user", source: "client", message: said },
			result(2, "call-gone", "an answer nobody asked for"),
		];

		expect(transcript(events)).toEqual([{ seq: 1, createdAt: AT, role: "user", message: said, source: "client" }]);
	});

	it("skips approvals that join nothing", () => {
		const events = [requested(1, "call-gone", "read_file"), resolved(2, "call-gone", "allow")];

		expect(transcript(events)).toEqual([]);
	});

	it("joins the approval of a call, pending and then decided", () => {
		const asked = [fromAssistant(1, [toolCall("call-1", "read_file", {})]), requested(2, "call-1", "read_file")];

		expect(transcript(asked)[0]?.toolCalls?.[0]).toEqual({
			id: "call-1",
			name: "read_file",
			arguments: {},
			approval: "pending",
		});

		const denied = transcript([...asked, resolved(3, "call-1", "deny")]);
		expect(denied[0]?.toolCalls?.[0]?.approval).toBe("denied");

		const allowed = transcript([...asked, resolved(3, "call-1", "allow")]);
		expect(allowed[0]?.toolCalls?.[0]?.approval).toBe("allowed");
	});

	it("joins an approval logged ahead of the message that made the call", () => {
		const events: SessionEventBody[] = [
			requested(1, "call-1", "read_file"),
			fromAssistant(2, [toolCall("call-1", "read_file", {})]),
		];

		expect(transcript(events)[0]?.toolCalls?.[0]?.approval).toBe("pending");
		expect(transcript([...events, resolved(3, "call-1", "allow")])[0]?.toolCalls?.[0]?.approval).toBe("allowed");
	});

	it("joins an early approval when the message arrives in a later fold", () => {
		const asked = foldTranscript(EMPTY_TRANSCRIPT, [requested(1, "call-1", "read_file")]);
		const made = foldTranscript(asked, [
			requested(1, "call-1", "read_file"),
			fromAssistant(2, [toolCall("call-1", "read_file", {})]),
		]);

		expect(made.messages[0]?.toolCalls?.[0]?.approval).toBe("pending");
	});

	it("voids an early approval the run ended before its message arrived", () => {
		const events: SessionEventBody[] = [
			requested(1, "call-1", "read_file"),
			{ seq: 2, created_at: AT, type: "run_cancelled", run_id: "r1" },
			fromAssistant(3, [toolCall("call-1", "read_file", {})]),
		];

		expect(transcript(events)[0]?.toolCalls?.[0]?.approval).toBe("voided");
	});

	it("voids an approval the run ended before anyone decided, and leaves a decided one", () => {
		const events: SessionEventBody[] = [
			fromAssistant(1, [toolCall("call-1", "read_file", {}), toolCall("call-2", "write_file", {})]),
			requested(2, "call-1", "read_file"),
			resolved(3, "call-1", "allow"),
			requested(4, "call-2", "write_file"),
			{ seq: 5, created_at: AT, type: "run_cancelled", run_id: "r1" },
		];

		const calls = transcript(events)[0]?.toolCalls;
		expect(calls?.map((call) => call.approval)).toEqual(["allowed", "voided"]);
		// A later run asking again starts the approval over.
		const again = transcript([...events, requested(6, "call-2", "write_file")]);
		expect(again[0]?.toolCalls?.[1]?.approval).toBe("pending");
	});

	it("carries an error result as the wire sent it", () => {
		const events = [fromAssistant(1, [toolCall("call-1", "read_file", {})]), result(2, "call-1", "no such file", true)];

		expect(transcript(events)[0]?.toolCalls?.[0]?.result).toEqual({
			content: [{ type: "text", data: { text: "no such file" } }],
			is_error: true,
		});
	});

	it("hands back the very messages the events carry", () => {
		const asked = message("user", [text("Hi")]);
		const answered = message("assistant", [text("Hello.")]);
		const events: SessionEventBody[] = [
			{ seq: 1, created_at: AT, type: "message_user", source: "client", message: asked },
			{ seq: 2, created_at: AT, type: "message_assistant", message: answered },
		];
		const [user, assistant] = transcript(events);

		expect(user?.message).toBe(asked);
		expect(assistant?.message).toBe(answered);
	});

	it("ignores every other event", () => {
		const noise: SessionEventBody[] = [
			{ seq: 1, created_at: AT, type: "run_queued", run_id: "r1" },
			{ seq: 2, created_at: AT, type: "tool_call", call_id: "call-1", name: "read_file", arguments: {} },
			{ seq: 3, created_at: AT, type: "run_completed", run_id: "r1" },
		];

		expect(transcript(noise)).toEqual([]);
	});
});
