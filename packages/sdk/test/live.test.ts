import { describe, expect, it } from "vitest";
import {
	EMPTY_LIVE,
	foldDelta,
	LIVE_REDRAW_MS,
	liveKey,
	type SessionDeltaBody,
	type SessionEventBody,
	settleLive,
} from "../src/index.js";
import { deltaFrame, frame, liveSse, stubFetch, testClient } from "./support.js";

const append = (call: string, n: number, parts: readonly unknown[], run = "r1") =>
	({
		run_id: run,
		target: { type: "model_call", data: { model_call_id: call } },
		n,
		delta: { type: "append", data: { parts } },
	}) as SessionDeltaBody;

const text = (index: number, text: string) => ({ type: "text", data: { index, text } });

const discard = (call: string, n: number): SessionDeltaBody => ({
	run_id: "r1",
	target: { type: "model_call", data: { model_call_id: call } },
	n,
	delta: { type: "discard" },
});

const committed = (seq: number, call: string): SessionEventBody =>
	({
		seq,
		created_at: "2026-01-01T00:00:00Z",
		type: "message_assistant",
		message: { role: "assistant", content: [{ type: "text", data: { text: "Hello" } }], model_call_id: call },
	}) as SessionEventBody;

const target = (call: string) => ({ type: "model_call", data: { model_call_id: call } }) as const;

const runEnd = (type: string, run: string) =>
	({ seq: 9, type, run_id: run, error: "x" }) as unknown as SessionEventBody;

describe("foldDelta", () => {
	it("builds each block of a call in content order, joining its fragments", () => {
		let live = EMPTY_LIVE;
		live = foldDelta(live, append("mc1", 0, [text(1, "wor")]));
		live = foldDelta(
			live,
			append("mc1", 1, [
				{ type: "thinking", data: { index: 0, thinking: "hmm" } },
				text(1, "ld"),
				{ type: "tool_call", data: { index: 2, id: "t1", name: "echo", arguments: '{"a":' } },
			]),
		);
		live = foldDelta(
			live,
			append("mc1", 2, [{ type: "tool_call", data: { index: 2, id: "t1", name: "echo", arguments: "1}" } }]),
		);
		expect(live.messages).toEqual([
			{
				runId: "r1",
				target: target("mc1"),
				n: 2,
				content: [
					{ type: "thinking", index: 0, thinking: "hmm" },
					{ type: "text", index: 1, text: "world" },
					{ type: "tool_call", index: 2, id: "t1", name: "echo", arguments: '{"a":1}' },
				],
			},
		]);
	});

	it("drops a frame it already holds, and keeps every other message's identity", () => {
		const first = foldDelta(EMPTY_LIVE, append("mc1", 0, [text(0, "a")]));
		const both = foldDelta(first, append("mc2", 0, [text(0, "b")]));
		expect(foldDelta(both, append("mc1", 0, [text(0, "a")]))).toBe(both);
		const grown = foldDelta(both, append("mc2", 1, [text(0, "c")]));
		expect(grown.messages[0]).toBe(both.messages[0]);
		expect(grown.messages[1]?.content).toEqual([{ type: "text", index: 0, text: "bc" }]);
	});

	it("forgets a discarded call, and ignores a discard for one it never held", () => {
		const live = foldDelta(EMPTY_LIVE, append("mc1", 0, [text(0, "a")]));
		expect(foldDelta(live, discard("mc1", 1)).messages).toEqual([]);
		expect(foldDelta(live, discard("mc9", 0))).toBe(live);
	});

	it("previews nothing the log settled: a committed call, or any call of an ended run", () => {
		const committedOne = settleLive(EMPTY_LIVE, committed(5, "mc1"));
		expect(foldDelta(committedOne, append("mc1", 2, [text(0, "!")]))).toBe(committedOne);
		const ended = settleLive(EMPTY_LIVE, runEnd("run_cancelled", "r1"));
		expect(foldDelta(ended, append("mc7", 0, [text(0, "late")]))).toBe(ended);
		expect(foldDelta(ended, append("mc7", 0, [text(0, "next")], "r2")).messages).toHaveLength(1);
	});
});

describe("liveKey", () => {
	it("tells targets apart", () => {
		expect(liveKey(target("mc1"))).not.toEqual(liveKey(target("mc2")));
	});
});

describe("settleLive", () => {
	const live = foldDelta(
		foldDelta(EMPTY_LIVE, append("mc1", 0, [text(0, "a")])),
		append("mc2", 0, [text(0, "b")], "r2"),
	);

	it("drops the message the log commits, and nothing else", () => {
		expect(settleLive(live, committed(5, "mc1")).messages.map((m) => m.target)).toEqual([target("mc2")]);
		const unstamped = { ...committed(5, "mc1"), message: { role: "assistant", content: [] } } as SessionEventBody;
		expect(settleLive(live, unstamped)).toBe(live);
	});

	it("drops every message of a run that ended, and forgets the run's commits", () => {
		for (const type of ["run_completed", "run_failed", "run_cancelled"]) {
			const ended = settleLive(settleLive(live, committed(5, "mc2")), runEnd(type, "r2"));
			expect(ended.messages.map((m) => m.target)).toEqual([target("mc1")]);
			expect(ended.committed.size).toBe(0);
		}
		expect(settleLive(live, { seq: 9, type: "run_started", run_id: "r2" } as SessionEventBody)).toBe(live);
	});
});

describe("the session connection, following deltas", () => {
	it("asks for deltas only when told to", async () => {
		const http = stubFetch(
			() => liveSse().response,
			() => liveSse().response,
		);
		const client = testClient({ fetch: http.fetch });
		const plain = client.sessions.connect("s1");
		const following = client.sessions.connect("s2", { deltas: true });
		await plain.ready;
		await following.ready;
		expect(new URL(http.calls[0]!.url).searchParams.has("deltas")).toBe(false);
		expect(new URL(http.calls[1]!.url).searchParams.get("deltas")).toBe("true");
		plain.close();
		following.close();
	});

	it("holds a call's output in live until the log commits it, and ignores frames for what it committed", async () => {
		const stream = liveSse();
		const http = stubFetch(() => stream.response);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1", { deltas: true });
		await connection.ready;

		const grew = new Promise<void>((resolve) => {
			const stop = connection.subscribe((state) => {
				if (state.live[0]?.n === 1) {
					stop();
					resolve();
				}
			});
		});
		stream.push(deltaFrame(append("mc1", 0, [text(0, "Hel")])));
		stream.push(deltaFrame(append("mc1", 1, [text(0, "lo")])));
		await grew;
		expect(connection.live).toEqual([
			{ runId: "r1", target: target("mc1"), n: 1, content: [{ type: "text", index: 0, text: "Hello" }] },
		]);
		expect(connection.state.events).toEqual([]);

		const settled = new Promise<void>((resolve) => {
			const stop = connection.subscribe((state) => {
				if (state.events.length === 1) {
					stop();
					resolve();
				}
			});
		});
		const event = committed(4, "mc1");
		stream.push(frame(4, event as unknown as Record<string, unknown>));
		await settled;
		expect(connection.live).toEqual([]);

		// A frame the server kept for a reader that joined late, past the commit.
		stream.push(deltaFrame(append("mc1", 2, [text(0, "!")])));
		stream.push(frame(5, { type: "run_queued", run_id: "r2" }));
		await new Promise<void>((resolve) => {
			const stop = connection.subscribe((state) => {
				if (state.events.length === 2) {
					stop();
					resolve();
				}
			});
		});
		expect(connection.live).toEqual([]);
		connection.close();
	});

	it("moves live once frames have gathered, and at once with an event", async () => {
		const stream = liveSse();
		const http = stubFetch(() => stream.response);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1", { deltas: true });
		await connection.ready;
		const seen: number[] = [];
		const until = (done: (live: typeof connection.live, events: number) => boolean) =>
			new Promise<void>((resolve) => {
				const stop = connection.subscribe((state) => {
					const n = state.live[0]?.n;
					if (n !== undefined && seen.at(-1) !== n) {
						seen.push(n);
					}
					if (done(state.live, state.events.length)) {
						stop();
						resolve();
					}
				});
			});

		const gathered = until((live) => live.length === 1);
		stream.push(deltaFrame(append("mc1", 0, [text(0, "Hel")])));
		stream.push(deltaFrame(append("mc1", 1, [text(0, "lo")])));
		await gathered;
		// Both frames arrived within one redraw, so live moved once, to the second.
		expect(seen).toEqual([1]);

		const delivered = until((_, events) => events === 1);
		const sent = Date.now();
		stream.push(deltaFrame(append("mc1", 2, [text(0, "!")])));
		stream.push(frame(4, { type: "run_started", run_id: "r1" }));
		await delivered;
		expect(Date.now() - sent).toBeLessThan(LIVE_REDRAW_MS);
		expect(connection.live[0]?.content).toEqual([{ type: "text", index: 0, text: "Hello!" }]);

		// A frame still gathering when the connection closes moves nothing.
		stream.push(deltaFrame(append("mc1", 3, [text(0, "?")])));
		await new Promise((resolve) => setTimeout(resolve, 20));
		connection.close();
		await new Promise((resolve) => setTimeout(resolve, LIVE_REDRAW_MS * 1.5));
		expect(connection.live[0]?.n).toBe(2);
	});

	it("refuses a delta frame that is not JSON, as it refuses an event", async () => {
		const http = stubFetch(() => {
			const stream = liveSse();
			stream.push("event: delta\ndata: {not json\n\n");
			return stream.response;
		});
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1", { deltas: true });
		const failed = new Promise<unknown>((resolve) => {
			connection.subscribe((state) => {
				if (state.status === "failed") {
					resolve(state.error);
				}
			});
		});
		expect(String(await failed)).toContain("not JSON");
	});
});
