import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ConnectionStatus,
	NotFoundError,
	type SessionConnection,
	type SessionEventBody,
	type SessionState,
	SubakoConnectionError,
	SubakoError,
	SubakoTimeoutError,
	UnauthorizedError,
} from "../src/index.js";
import { empty, frame, hang, json, liveSse, openSse, sse, stubFetch, testClient, userEvent } from "./support.js";

afterEach(() => {
	vi.useRealTimers();
});

/** The next event a subscriber is handed after this call. */
function nextEvent(connection: SessionConnection): Promise<SessionEventBody> {
	const read = connection.state.events.length;
	return new Promise((resolve) => {
		const stop = connection.subscribe((state) => {
			const event = state.events[read];
			if (event !== undefined) {
				stop();
				resolve(event);
			}
		});
	});
}

/** The seq of every event a subscriber is handed after this call. */
function seenEvents(connection: SessionConnection): number[] {
	let read = connection.state.events.length;
	const seen: number[] = [];
	connection.subscribe((state) => {
		for (const event of state.events.slice(read)) {
			seen.push(event.seq);
		}
		read = state.events.length;
	});
	return seen;
}

/** The statuses a subscriber is handed, one per change. */
function seenStatuses(connection: SessionConnection): ConnectionStatus[] {
	const seen: ConnectionStatus[] = [];
	connection.subscribe((state) => {
		if (seen.at(-1) !== state.status) {
			seen.push(state.status);
		}
	});
	return seen;
}

const seqs = (connection: SessionConnection): number[] => connection.state.events.map((event) => event.seq);

/** Iterates to the end, which only a closed or failed connection reaches. */
async function drain(connection: SessionConnection): Promise<number[]> {
	const seen: number[] = [];
	for await (const event of connection) {
		seen.push(event.seq);
	}
	return seen;
}

const queued = (seq: number): SessionEventBody =>
	({ seq, type: "run_queued", run_id: `r${seq}` }) as unknown as SessionEventBody;

/** A user turn as a page of the log carries it. */
const said = (seq: number): SessionEventBody => ({
	seq,
	created_at: "2026-01-01T00:00:00Z",
	type: "message_user",
	source: "client",
	message: { role: "user", content: [{ type: "text", data: { text: `turn ${seq}` } }] },
});

describe("the session connection", () => {
	it("waits before reconnecting, and resumes from the last seq", async () => {
		vi.useFakeTimers();
		const http = stubFetch(
			() => sse([userEvent(1)]),
			() => sse([frame(2, { type: "run_queued", run_id: "r1" })]),
		);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1");

		expect(await nextEvent(connection)).toMatchObject({ seq: 1 });
		expect(http.calls).toHaveLength(1);
		expect(http.calls[0]?.headers.has("last-event-id")).toBe(false);

		const second = nextEvent(connection);
		await vi.advanceTimersByTimeAsync(2_999);
		expect(http.calls).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(1);
		expect((await second).seq).toBe(2);
		expect(http.calls).toHaveLength(2);
		expect(http.calls[1]?.headers.get("last-event-id")).toBe("1");
		expect(new URL(http.calls[1]!.url).searchParams.get("after_seq")).toBe("1");

		connection.close();
	});

	it("starts from afterSeq", async () => {
		const http = stubFetch(() => sse([frame(8, { type: "tool_call", call_id: "c1", name: "search", arguments: {} })]));
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1", { afterSeq: 7 });

		expect((await nextEvent(connection)).seq).toBe(8);
		expect(new URL(http.calls[0]!.url).searchParams.get("after_seq")).toBe("7");
		expect(http.calls[0]?.headers.get("last-event-id")).toBe("7");

		connection.close();
	});

	it("resumes from the cursor the stream opened at, which delivered no event", async () => {
		vi.useFakeTimers();
		const http = stubFetch(
			() => sse(["id: 12\n\n"]),
			() => sse([frame(13, { type: "run_queued", run_id: "r13" })]),
		);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1");

		const first = nextEvent(connection);
		await vi.advanceTimersByTimeAsync(3_000);

		expect((await first).seq).toBe(13);
		// The stream started at the live head, and nothing but the head reached the log.
		expect(seqs(connection)).toEqual([13]);
		expect(http.calls[0]?.headers.has("last-event-id")).toBe(false);
		expect(http.calls[1]?.headers.get("last-event-id")).toBe("12");
		expect(new URL(http.calls[1]!.url).searchParams.get("after_seq")).toBe("12");

		connection.close();
	});

	it("counts a stream that carried nothing but its cursor as a failed reconnect", async () => {
		vi.useFakeTimers();
		const http = stubFetch(() => sse(["id: 12\n\n"]));
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1", { maxReconnects: 2 });

		await vi.advanceTimersByTimeAsync(60_000);

		// One opening connection and two reconnects, each of them opening and delivering nothing.
		expect(http.calls).toHaveLength(3);
		expect(connection.state.status).toBe("failed");
		expect(connection.state.lastSeq).toBe(12);
		expect(connection.state.error).toBeInstanceOf(SubakoConnectionError);
	});

	it("takes the reconnect delay from the server's retry field", async () => {
		vi.useFakeTimers();
		const http = stubFetch(
			() => sse(["retry: 100\n\n", userEvent(1)]),
			() => sse([userEvent(2)]),
		);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1");

		await nextEvent(connection);
		const second = nextEvent(connection);
		await vi.advanceTimersByTimeAsync(99);
		expect(http.calls).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(1);
		expect((await second).seq).toBe(2);

		connection.close();
	});

	it("ignores keep-alive comments and joins multi-line data", async () => {
		const http = stubFetch(() =>
			sse([": keep-alive\n\n", 'id: 5\nevent: run_queued\ndata: {"seq": 5,\ndata: "type": "run_queued"}\n\n']),
		);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1");

		expect(await nextEvent(connection)).toEqual({ seq: 5, type: "run_queued" });

		connection.close();
	});

	it("fails at once when the server refuses the first connection", async () => {
		const http = stubFetch(() => json({ error: { code: "not_found", message: "no such session" } }, 404));
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1");

		await expect(connection.ready).rejects.toBeInstanceOf(NotFoundError);
		expect(connection.state.status).toBe("failed");
		expect(connection.state.error).toBeInstanceOf(NotFoundError);
		expect(http.calls).toHaveLength(1);
	});

	it("gives up after maxReconnects consecutive failures and keeps the last one", async () => {
		vi.useFakeTimers();
		const http = stubFetch(
			() => sse([]),
			() => empty(503),
		);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1", { maxReconnects: 3 });
		const iterated = drain(connection).catch((error: unknown) => error);

		await vi.advanceTimersByTimeAsync(120_000);

		expect(connection.state.status).toBe("failed");
		expect((connection.state.error as SubakoError).status).toBe(503);
		expect(await iterated).toBe(connection.state.error);
		expect(http.calls).toHaveLength(4);
	});

	it("reports closes that delivered nothing as a connection error", async () => {
		vi.useFakeTimers();
		const http = stubFetch(() => sse([]));
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1", { maxReconnects: 1 });

		await vi.advanceTimersByTimeAsync(120_000);

		expect(connection.state.error).toBeInstanceOf(SubakoConnectionError);
		expect(http.calls).toHaveLength(2);
	});

	it("retries opening the stream like any request", async () => {
		vi.useFakeTimers();
		const http = stubFetch(
			() => empty(503),
			() => sse([userEvent(1)]),
		);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1");

		const first = nextEvent(connection);
		await vi.advanceTimersByTimeAsync(2_000);

		expect((await first).seq).toBe(1);
		expect(http.calls).toHaveLength(2);

		connection.close();
	});

	it("takes maxRetries for the opening request from the caller", async () => {
		const http = stubFetch(() => empty(503));
		const client = testClient({ fetch: http.fetch, maxRetries: 3 });
		const connection = client.sessions.connect("s1", { maxRetries: 0 });

		const error = await connection.ready.catch((e: unknown) => e);

		expect((error as SubakoError).status).toBe(503);
		expect(http.calls).toHaveLength(1);
	});

	it("closes quietly when the caller aborts", async () => {
		const controller = new AbortController();
		const http = stubFetch((request) => openSse([userEvent(1)], { close: false, signal: request.signal }).response);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1", { signal: controller.signal });
		const events = connection[Symbol.asyncIterator]();

		expect((await events.next()).value?.seq).toBe(1);
		const pending = events.next();
		controller.abort();

		await expect(pending).resolves.toEqual({ done: true, value: undefined });
		expect(connection.state.status).toBe("closed");
	});

	it("lets go of the caller's signal when it closes", async () => {
		const controller = new AbortController();
		const http = stubFetch(() => sse([userEvent(1)]));
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1", { signal: controller.signal });

		await connection.ready;
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);

		connection.close();

		// A signal shared by many connections must not collect the ones that ended.
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it("opens nothing when the signal is already aborted", async () => {
		const http = stubFetch(() => sse([userEvent(1)]));
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1", { signal: AbortSignal.abort() });

		await expect(connection.ready).rejects.toBeInstanceOf(SubakoConnectionError);
		expect(connection.state.status).toBe("closed");
		expect(http.calls).toHaveLength(0);
	});

	it("gives up at the first drop when no reconnect is allowed", async () => {
		vi.useFakeTimers();
		const http = stubFetch(() => sse([userEvent(1)]));
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1", { maxReconnects: 0 });

		await nextEvent(connection);
		await vi.advanceTimersByTimeAsync(60_000);

		expect(connection.state.status).toBe("failed");
		expect(connection.state.error).toBeInstanceOf(SubakoConnectionError);
		expect(http.calls).toHaveLength(1);
	});

	it("stays closed when a stream opens after the close, and lets it go", async () => {
		vi.useFakeTimers();
		const late = openSse([userEvent(2)], { close: false });
		let arrive = (): void => undefined;
		const held = new Promise<Response>((resolve) => {
			arrive = () => resolve(late.response);
		});
		const http = stubFetch(
			() => sse([userEvent(1)]),
			() => held,
		);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1");
		const seen = seenStatuses(connection);

		await nextEvent(connection);
		await vi.advanceTimersByTimeAsync(3_000);
		expect(connection.state.status).toBe("reconnecting");
		expect(http.calls).toHaveLength(2);

		connection.close();
		arrive();
		await vi.advanceTimersByTimeAsync(10);

		expect(connection.state.status).toBe("closed");
		expect(seen).toEqual(["open", "reconnecting", "closed"]);
		expect(seqs(connection)).toEqual([1]);
		expect(late.canceled()).toBe(true);
	});

	it("delivers nothing after the close, to the log and to every subscriber alike", async () => {
		vi.useFakeTimers();
		const live = liveSse();
		const http = stubFetch(() => live.response);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1");
		await connection.ready;

		const seen = seenEvents(connection);
		const iterated = drain(connection);

		// The frames are in the body, but nothing has read them yet.
		live.push(userEvent(1));
		live.push(userEvent(2));
		connection.close();
		await vi.advanceTimersByTimeAsync(10);

		expect(seen).toEqual([]);
		expect(seqs(connection)).toEqual([]);
		expect(await iterated).toEqual([]);
		expect(connection.state.lastSeq).toBeUndefined();
	});

	it("iterates a closed connection over the log it already holds", async () => {
		const http = stubFetch(() => sse([userEvent(1), userEvent(2)]));
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1");

		await nextEvent(connection);
		await nextEvent(connection);
		connection.close();

		expect(await drain(connection)).toEqual([1, 2]);
		expect(connection.state.status).toBe("closed");
	});

	it("stops streaming on close, and keeps streaming when an iteration breaks", async () => {
		vi.useFakeTimers();
		const live = liveSse();
		const http = stubFetch(() => live.response);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1");
		await connection.ready;

		const seen: SessionEventBody[] = [];
		live.push(userEvent(1));
		for await (const event of connection) {
			seen.push(event);
			break;
		}
		expect(seen).toHaveLength(1);
		expect(connection.state.status).toBe("open");

		// The connection outlives the iteration: the log keeps filling.
		live.push(userEvent(2));
		await vi.advanceTimersByTimeAsync(10);
		expect(seqs(connection)).toEqual([1, 2]);

		connection.close();
		live.close();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(http.calls).toHaveLength(1);
		expect(connection.state.status).toBe("closed");
	});
});

describe("the session connection, reconnecting", () => {
	it("fails at once when the server refuses the reconnect outright", async () => {
		vi.useFakeTimers();
		const http = stubFetch(
			() => sse([userEvent(1)]),
			() => json({ error: { code: "unauthorized", message: "token expired" } }, 401),
		);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1");

		await nextEvent(connection);
		await vi.advanceTimersByTimeAsync(3_000);

		expect(connection.state.status).toBe("failed");
		expect(connection.state.error).toBeInstanceOf(UnauthorizedError);
		expect(http.calls).toHaveLength(2);
	});

	it("does not retry a reconnect on its own; the loop's backoff is the retry", async () => {
		vi.useFakeTimers();
		const http = stubFetch(
			() => sse([userEvent(1)]),
			() => empty(503),
			() => sse([userEvent(2)]),
		);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1");

		await nextEvent(connection);
		const second = nextEvent(connection);
		await vi.advanceTimersByTimeAsync(3_000);
		expect(http.calls).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(6_000);

		expect((await second).seq).toBe(2);
		expect(http.calls).toHaveLength(3);

		connection.close();
	});

	it("drops what the reconnect replays, and never lets the last seq fall back", async () => {
		vi.useFakeTimers();
		const http = stubFetch(
			() => sse([userEvent(1), userEvent(2)]),
			() => sse([userEvent(1), userEvent(2), userEvent(3)]),
		);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1");
		const seen = seenEvents(connection);

		await nextEvent(connection);
		await vi.advanceTimersByTimeAsync(3_000);

		expect(seen).toEqual([1, 2, 3]);
		expect(seqs(connection)).toEqual([1, 2, 3]);
		expect(connection.state.lastSeq).toBe(3);

		connection.close();
	});

	it("opens the stream again on reconnect(), keeping the log and re-registering the clients", async () => {
		vi.useFakeTimers();
		const live = liveSse();
		let streams = 0;
		const http = stubFetch((request) => {
			const { pathname } = new URL(request.url);
			if (pathname.endsWith("/events/stream")) {
				streams += 1;
				// The first stream ends with no budget to reconnect on; the second is the one reconnect() opens.
				return streams === 1 ? sse([userEvent(1)]) : live.response;
			}
			if (request.method === "POST" && pathname.endsWith("/clients")) {
				return json({ id: "cl1", name: "web", expires_at: null }, 201);
			}
			if (request.method === "DELETE") {
				return empty(204);
			}
			throw new Error(`no route for ${request.method} ${pathname}`);
		});
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1", { maxReconnects: 0 });
		const tools = connection.createToolClient("web");
		tools.addTool("navigate", {
			description: "Go to a page.",
			parameters: { type: "object" },
			execute: () => "at /contact",
		});
		await connection.ready;
		await tools.ready;
		await vi.advanceTimersByTimeAsync(10);

		expect(connection.state.status).toBe("failed");
		expect(tools.state.status).toBe("left");
		const registrations = (): number =>
			http.calls.filter((call) => call.method === "POST" && call.url.endsWith("/clients")).length;
		expect(registrations()).toBe(1);

		connection.reconnect();
		expect(connection.state.status).toBe("connecting");
		await connection.ready;
		await vi.advanceTimersByTimeAsync(10);

		// The same connection, carrying what it had, with its client registered again.
		expect(connection.state.status).toBe("open");
		expect(seqs(connection)).toEqual([1]);
		expect(registrations()).toBe(2);
		expect(tools.state.status).toBe("serving");

		live.push(userEvent(2));
		await vi.advanceTimersByTimeAsync(10);
		expect(seqs(connection)).toEqual([1, 2]);

		connection.close();
	});

	it.each(["before reconnect", "while rejoining"] as const)("keeps an explicit deletion permanent %s", async (when) => {
		vi.useFakeTimers();
		const first = liveSse();
		const second = liveSse();
		let streams = 0;
		let release = (): void => undefined;
		const leaving = new Promise<void>((resolve) => {
			release = resolve;
		});
		const http = stubFetch(async (request) => {
			if (request.url.endsWith("/events/stream")) return ++streams === 1 ? first.response : second.response;
			if (request.method === "POST" && request.url.endsWith("/clients")) {
				return json({ id: "cl1", name: "web", expires_at: null }, 201);
			}
			if (request.method === "DELETE") {
				await leaving;
				return empty(204);
			}
			throw new Error(`unexpected ${request.method} ${request.url}`);
		});
		const connection = testClient({ fetch: http.fetch }).sessions.connect("s1", { maxReconnects: 0 });
		const tools = connection.createToolClient("web", { lifetime: { type: "never" } });
		await tools.ready;
		first.close();
		await vi.advanceTimersByTimeAsync(1);
		expect(connection.state.status).toBe("failed");
		if (when === "while rejoining") {
			connection.reconnect();
			await connection.ready;
			await vi.advanceTimersByTimeAsync(1);
		}
		const deleted = connection.deleteToolClient(tools);
		release();
		await deleted;
		if (when === "before reconnect") {
			connection.reconnect();
			await connection.ready;
		}
		await vi.advanceTimersByTimeAsync(1);
		expect(tools.state.status).toBe("left");
		expect(http.calls.filter((request) => request.method === "POST" && request.url.endsWith("/clients"))).toHaveLength(
			1,
		);
		connection.close();
	});

	it("reconnects from nothing but a failure", async () => {
		vi.useFakeTimers();
		const live = liveSse();
		const http = stubFetch(() => live.response);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1");
		await connection.ready;

		connection.reconnect();
		expect(connection.state.status).toBe("open");
		connection.close();
		connection.reconnect();

		expect(connection.state.status).toBe("closed");
		expect(http.calls).toHaveLength(1);
	});

	it("closes promptly when aborted during the reconnect wait", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const http = stubFetch(() => sse([userEvent(1)]));
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1", { signal: controller.signal });

		await nextEvent(connection);
		await vi.advanceTimersByTimeAsync(100);
		controller.abort();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(connection.state.status).toBe("closed");
		expect(http.calls).toHaveLength(1);
	});
});

describe("the session connection, deadlines and framing", () => {
	it("bounds reaching the server but not the reading of the log", async () => {
		vi.useFakeTimers();
		const live = liveSse();
		const http = stubFetch(() => live.response);
		const client = testClient({ fetch: http.fetch, timeout: 1_000 });
		const connection = client.sessions.connect("s1");

		const first = nextEvent(connection);
		live.push(userEvent(1));
		expect((await first).seq).toBe(1);

		// Well past the per-attempt timeout, the same connection is still delivering.
		const second = nextEvent(connection);
		await vi.advanceTimersByTimeAsync(10_000);
		live.push(userEvent(2));
		expect((await second).seq).toBe(2);
		expect(http.calls).toHaveLength(1);

		connection.close();
	});

	it("gives up on a connection that never answers", async () => {
		vi.useFakeTimers();
		const http = stubFetch(hang);
		const client = testClient({ fetch: http.fetch, timeout: 1_000, maxRetries: 0 });
		const connection = client.sessions.connect("s1");

		const settled = connection.ready.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(5_000);

		expect(await settled).toBeInstanceOf(SubakoTimeoutError);
		expect(http.calls).toHaveLength(1);
	});

	it("waits out a CRLF split across two chunks", async () => {
		vi.useFakeTimers();
		const live = liveSse();
		const http = stubFetch(() => live.response);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1");
		await connection.ready;

		const first = nextEvent(connection);
		live.push('data: {"seq": 5, "type": "run_queued"}\r');
		await vi.advanceTimersByTimeAsync(1);
		// The CR alone may be half of a CRLF, so the line is not a line yet.
		expect(seqs(connection)).toEqual([]);

		live.push("\n\r\n");
		expect(await first).toEqual({ seq: 5, type: "run_queued" });

		connection.close();
	});

	it("reports a frame that is not JSON at once", async () => {
		const http = stubFetch(() => sse(["id: 5\ndata: {not json\n\n"]));
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1");

		await connection.ready;
		const error = await drain(connection).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(SubakoError);
		expect((error as Error).message).toContain("not JSON");
		expect(http.calls).toHaveLength(1);
	});
});

describe("the session connection, state and history", () => {
	it("reads the log to its end, then streams on from the last seq", async () => {
		const http = stubFetch(
			() => json({ items: [queued(1), queued(2)], next_cursor: 2 }),
			() => json({ items: [queued(3)], next_cursor: null }),
			() => sse([userEvent(4)]),
		);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1", { history: true });

		await connection.ready;
		expect(seqs(connection)).toEqual([1, 2, 3]);
		// The log is walked oldest first, so the fold meets the events in seq order.
		expect(new URL(http.calls[0]!.url).searchParams.get("order")).toBe("asc");
		expect(new URL(http.calls[1]!.url).searchParams.get("after_seq")).toBe("2");
		expect(new URL(http.calls[2]!.url).searchParams.get("after_seq")).toBe("3");
		expect(http.calls[2]?.headers.get("last-event-id")).toBe("3");

		expect((await nextEvent(connection)).seq).toBe(4);
		expect(seqs(connection)).toEqual([1, 2, 3, 4]);
		expect(connection.state.lastSeq).toBe(4);

		connection.close();
	});

	it("reads the history from afterSeq on, and joins it to the stream without a gap", async () => {
		const http = stubFetch(
			() => json({ items: [queued(6), queued(7)], next_cursor: null }),
			() => sse([userEvent(6), userEvent(7), userEvent(8)]),
		);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1", { history: true, afterSeq: 5 });

		await connection.ready;
		expect(new URL(http.calls[0]!.url).searchParams.get("after_seq")).toBe("5");
		expect(new URL(http.calls[1]!.url).searchParams.get("after_seq")).toBe("7");
		expect(http.calls[1]?.headers.get("last-event-id")).toBe("7");

		expect((await nextEvent(connection)).seq).toBe(8);
		// The stream replayed 6 and 7; only what the history had not seen is delivered.
		expect(seqs(connection)).toEqual([6, 7, 8]);

		connection.close();
	});

	it("reads the newest events back to the latest run, then streams on from the last seq", async () => {
		const live = liveSse();
		const http = stubFetch(
			() => json({ items: [said(9), said(8)], next_cursor: 8 }),
			() => json({ items: [queued(7), said(6)], next_cursor: 6 }),
			() => live.response,
		);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1", { history: { latest: 2 } });

		await connection.ready;
		// Two events were asked for, but the run they belong to started further back.
		expect(seqs(connection)).toEqual([7, 8, 9]);
		expect(connection.state.hasEarlier).toBe(true);
		expect(connection.isRunning).toBe(true);
		const first = new URL(http.calls[0]!.url).searchParams;
		expect([first.get("order"), first.get("limit")]).toEqual(["desc", "2"]);
		expect(new URL(http.calls[1]!.url).searchParams.get("before_seq")).toBe("8");
		expect(new URL(http.calls[2]!.url).searchParams.get("after_seq")).toBe("9");

		live.push(userEvent(10));
		expect((await nextEvent(connection)).seq).toBe(10);

		connection.close();
	});

	it("puts earlier events in front of the ones it holds, until the log has none left", async () => {
		const live = liveSse();
		const http = stubFetch(
			() => json({ items: [queued(5), said(4)], next_cursor: null }),
			() => live.response,
			() => json({ items: [said(3), said(2)], next_cursor: 2 }),
			() => json({ items: [said(1)], next_cursor: null }),
		);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1", { history: { latest: 2 } });
		await connection.ready;
		expect(connection.transcript.map((message) => message.seq)).toEqual([4]);

		// A second call while the first is under way joins it.
		await Promise.all([connection.loadEarlier(2), connection.loadEarlier(2)]);
		expect(http.calls).toHaveLength(3);
		const earlier = new URL(http.calls[2]!.url).searchParams;
		expect([earlier.get("order"), earlier.get("before_seq"), earlier.get("limit")]).toEqual(["desc", "4", "2"]);
		expect(seqs(connection)).toEqual([2, 3, 4, 5]);
		expect(connection.state.hasEarlier).toBe(true);
		// The transcript starts over from the new first event rather than folding onto the old one.
		expect(connection.transcript.map((message) => message.seq)).toEqual([2, 3, 4]);

		await connection.loadEarlier();
		expect(seqs(connection)).toEqual([1, 2, 3, 4, 5]);
		expect(connection.state.hasEarlier).toBe(false);
		await connection.loadEarlier();
		expect(http.calls).toHaveLength(4);

		live.push(userEvent(6));
		expect((await nextEvent(connection)).seq).toBe(6);
		expect(connection.transcript.map((message) => message.seq)).toEqual([1, 2, 3, 4, 6]);

		connection.close();
	});

	it("says whether the log holds events before the first it holds", async () => {
		const live = liveSse();
		const http = stubFetch(
			() => live.response,
			() => json({ items: [said(12)], next_cursor: null }),
		);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1");
		expect(connection.state.hasEarlier).toBe(false);

		live.push("id: 12\n\n");
		await vi.waitFor(() => expect(connection.state.lastSeq).toBe(12));
		expect(connection.state.hasEarlier).toBe(true);
		// With nothing held yet, the read starts after the cursor the stream opened at.
		await connection.loadEarlier(1);
		expect(new URL(http.calls[1]!.url).searchParams.get("before_seq")).toBe("13");
		expect(seqs(connection)).toEqual([12]);

		connection.close();
		await connection.loadEarlier();
		expect(http.calls).toHaveLength(2);
	});

	it("holds every event and the last seq", async () => {
		const http = stubFetch(() => sse([userEvent(1), userEvent(2)]));
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1");

		expect(connection.state.lastSeq).toBeUndefined();
		await nextEvent(connection);
		await nextEvent(connection);

		expect(seqs(connection)).toEqual([1, 2]);
		expect(connection.state.lastSeq).toBe(2);

		connection.close();
	});

	it("gives a subscriber the events after it subscribed, and an iterator the log before it", async () => {
		vi.useFakeTimers();
		const live = liveSse();
		const http = stubFetch(() => live.response);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1");
		await connection.ready;

		live.push(userEvent(1));
		await vi.advanceTimersByTimeAsync(10);

		const late = seenEvents(connection);
		const iterated: number[] = [];
		const iteration = (async () => {
			for await (const event of connection) {
				iterated.push(event.seq);
				if (event.seq === 2) {
					break;
				}
			}
		})();

		live.push(userEvent(2));
		await vi.advanceTimersByTimeAsync(10);
		await iteration;

		expect(late).toEqual([2]);
		expect(iterated).toEqual([1, 2]);

		connection.close();
	});

	it("walks its statuses from connecting to closed", async () => {
		vi.useFakeTimers();
		const live = liveSse();
		const http = stubFetch(
			() => sse([userEvent(1)]),
			() => live.response,
		);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1");
		const seen = seenStatuses(connection);

		expect(connection.state.status).toBe("connecting");
		await nextEvent(connection);
		expect(connection.state.status).toBe("open");
		await vi.advanceTimersByTimeAsync(3_000);
		expect(connection.state.status).toBe("open");
		connection.close();

		expect(seen).toEqual(["open", "reconnecting", "open", "closed"]);
		expect(connection.state.status).toBe("closed");
	});

	it("keeps delivering when a listener throws, and reports what it threw", async () => {
		const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const http = stubFetch(() => sse([userEvent(1), userEvent(2)]));
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1");

		const stop = connection.subscribe(() => {
			throw new Error("listener blew up");
		});
		const seen = seenEvents(connection);
		await connection.ready;
		await new Promise((resolve) => setTimeout(resolve, 5));

		expect(seen).toEqual([1, 2]);
		expect(seqs(connection)).toEqual([1, 2]);
		// One state per change reached the thrower: the open, the two events, and the drop after them.
		// Every one of them is reported, and nothing is thrown where no caller could catch it.
		expect(reported).toHaveBeenCalledTimes(4);
		stop();
		connection.close();
		reported.mockRestore();
	});
	it("replaces the state and the events array on every event, and copies no event", async () => {
		vi.useFakeTimers();
		const live = liveSse();
		const http = stubFetch(() => live.response);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1");
		await connection.ready;

		const states: SessionState[] = [];
		connection.subscribe((state) => states.push(state));
		live.push(userEvent(1));
		await vi.advanceTimersByTimeAsync(10);
		live.push(userEvent(2));
		await vi.advanceTimersByTimeAsync(10);

		expect(states).toHaveLength(2);
		expect(states[0]).not.toBe(states[1]);
		expect(states[0]?.events).not.toBe(states[1]?.events);
		expect(states.map((state) => state.events.length)).toEqual([1, 2]);
		// Only the array is new; the events in it are the ones already delivered.
		expect(states[1]?.events[0]).toBe(states[0]?.events[0]);
		expect(connection.state).toBe(states[1]);
		expect(connection.state.lastSeq).toBe(2);

		connection.close();
	});

	it("keeps the same events array across a status change", async () => {
		vi.useFakeTimers();
		const live = liveSse();
		const http = stubFetch(() => live.response);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1");
		await connection.ready;

		const states: SessionState[] = [];
		connection.subscribe((state) => states.push(state));
		live.push(userEvent(1));
		await vi.advanceTimersByTimeAsync(10);
		connection.close();

		expect(states.map((state) => state.status)).toEqual(["open", "closed"]);
		expect(states[1]?.events).toBe(states[0]?.events);
		expect(states[1]).not.toBe(states[0]);
	});

	it("notifies a subscriber of the states after it subscribed, and no earlier one", async () => {
		vi.useFakeTimers();
		const live = liveSse();
		const http = stubFetch(() => live.response);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1");
		await connection.ready;

		live.push(userEvent(1));
		await vi.advanceTimersByTimeAsync(10);
		const states: SessionState[] = [];
		connection.subscribe((state) => states.push(state));
		live.push(userEvent(2));
		await vi.advanceTimersByTimeAsync(10);

		expect(states).toHaveLength(1);
		// The state it is handed still holds everything, the event it missed included.
		expect(states[0]?.events.map((event) => event.seq)).toEqual([1, 2]);

		connection.close();
	});

	it("hands every listener every state", async () => {
		vi.useFakeTimers();
		const live = liveSse();
		const http = stubFetch(() => live.response);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1");
		await connection.ready;

		const first: SessionState[] = [];
		const second: SessionState[] = [];
		connection.subscribe((state) => first.push(state));
		connection.subscribe((state) => second.push(state));
		live.push(userEvent(1));
		await vi.advanceTimersByTimeAsync(10);
		connection.close();

		expect(first.map((state) => state.status)).toEqual(["open", "closed"]);
		expect(second).toEqual(first);
		expect(second[0]).toBe(first[0]);
	});
});

describe("the session connection, as a session", () => {
	it("posts input, cancels the run, and decides an approval under the connection's workspace", async () => {
		const stream = openSse([], { close: false });
		const http = stubFetch((request) =>
			new URL(request.url).pathname.endsWith("/events/stream") ? stream.response : json({ seq: 1 }),
		);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1", { workspaceId: "w2" });
		await connection.ready;

		await connection.send("hello");
		await connection.cancel();
		await connection.resolveApproval("c1", "allow");
		await connection.resolveApproval("c2", "deny", "not this one");
		await connection.answerInput("c3", { type: "declined", data: { message: "later" } });

		const written = http.calls.slice(1);
		expect(written.map((call) => new URL(call.url).pathname)).toEqual([
			"/v1/sessions/s1/events",
			"/v1/sessions/s1/cancel",
			"/v1/sessions/s1/approvals/c1",
			"/v1/sessions/s1/approvals/c2",
			"/v1/sessions/s1/inputs/c3",
		]);
		expect(await written[0]?.json()).toEqual({ type: "input", text: "hello" });
		expect(await written[2]?.json()).toEqual({ decision: "allow" });
		expect(await written[3]?.json()).toEqual({ decision: "deny", message: "not this one" });
		expect(await written[4]?.json()).toEqual({ type: "declined", data: { message: "later" } });
		expect(written.map((call) => call.headers.get("kikuvi-workspace"))).toEqual(["w2", "w2", "w2", "w2", "w2"]);

		connection.close();
	});

	it("derives the transcript, the approvals and the run once per events array", async () => {
		vi.useFakeTimers();
		const live = liveSse();
		const http = stubFetch(() => live.response);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1");
		await connection.ready;

		expect(connection.transcript).toEqual([]);
		expect(connection.approvals).toEqual([]);
		expect(connection.isRunning).toBe(false);

		live.push(userEvent(1));
		live.push(frame(2, { type: "run_queued", run_id: "r1" }));
		await vi.advanceTimersByTimeAsync(10);

		const read = connection.transcript;
		expect(read.map((message) => message.seq)).toEqual([1]);
		expect(connection.isRunning).toBe(true);
		// The events array is the whole cache key, so an unchanged log is read once.
		expect(connection.transcript).toBe(read);

		live.push(
			frame(3, {
				type: "approval_requested",
				call_id: "c1",
				server: "fs",
				tool: "read",
				args_hash: "h",
				arguments: {},
			}),
		);
		await vi.advanceTimersByTimeAsync(10);

		expect(connection.approvals.map((approval) => approval.call_id)).toEqual(["c1"]);
		expect(connection.isRunning).toBe(true);
		expect(connection.transcript).not.toBe(read);

		live.push(
			frame(4, {
				type: "input_requested",
				call_id: "c2",
				request: { questions: [{ id: "ok", prompt: "Go?", required: true, widget: { type: "confirm" } }] },
			}),
		);
		await vi.advanceTimersByTimeAsync(10);
		expect(connection.inputs.map((input) => input.call_id)).toEqual(["c2"]);
		expect(connection.state.inputs).toBe(connection.inputs);

		// The run ending takes the approval and the form it was waiting on with it.
		live.push(frame(5, { type: "run_completed", run_id: "r1" }));
		await vi.advanceTimersByTimeAsync(10);

		expect(connection.approvals).toEqual([]);
		expect(connection.inputs).toEqual([]);
		expect(connection.isRunning).toBe(false);

		connection.close();
	});

	it("carries the readings on the snapshot, and hands a subscriber the one they are on", async () => {
		vi.useFakeTimers();
		const live = liveSse();
		const http = stubFetch(() => live.response);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1");
		await connection.ready;

		const states: SessionState[] = [];
		connection.subscribe((state) => states.push(state));
		// Nothing has changed, so the snapshot a subscriber compares against is the same object.
		expect(connection.state).toBe(connection.state);

		live.push(userEvent(1));
		live.push(frame(2, { type: "run_queued", run_id: "r1" }));
		await vi.advanceTimersByTimeAsync(10);

		const state = connection.state;
		// The snapshot and the connection are one reading, so a render needs nothing but the snapshot.
		expect(state.transcript).toBe(connection.transcript);
		expect(state.approvals).toBe(connection.approvals);
		expect(state.isRunning).toBe(true);
		expect(states.at(-1)).toBe(state);
		expect(states.at(-1)?.transcript.map((message) => message.seq)).toEqual([1]);

		connection.close();
	});

	it("leaves a snapshot the connection has moved past reading its own events", async () => {
		vi.useFakeTimers();
		const live = liveSse();
		const http = stubFetch(() => live.response);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1");
		await connection.ready;

		live.push(userEvent(1));
		await vi.advanceTimersByTimeAsync(10);
		const before = connection.state;

		live.push(userEvent(2));
		await vi.advanceTimersByTimeAsync(10);

		expect(connection.state).not.toBe(before);
		expect(connection.state.transcript.map((message) => message.seq)).toEqual([1, 2]);
		// What a render was handed is what it keeps reading, however far the log has moved on.
		expect(before.transcript.map((message) => message.seq)).toEqual([1]);
		expect(before.transcript).toBe(before.transcript);

		connection.close();
	});

	it("folds a new event into the transcript, leaving the messages it did not touch", async () => {
		vi.useFakeTimers();
		const live = liveSse();
		const http = stubFetch(() => live.response);
		const client = testClient({ fetch: http.fetch });
		const connection = client.sessions.connect("s1");
		await connection.ready;

		live.push(userEvent(1));
		live.push(
			frame(2, {
				type: "message_assistant",
				message: {
					role: "assistant",
					content: [{ type: "tool_call", data: { id: "c1", name: "search", arguments: { query: "subako" } } }],
				},
			}),
		);
		await vi.advanceTimersByTimeAsync(10);
		const before = connection.transcript;
		expect(before).toHaveLength(2);

		// An event that touches no message leaves every message it already made alone.
		live.push(userEvent(3));
		await vi.advanceTimersByTimeAsync(10);
		const after = connection.transcript;
		expect(after[0]).toBe(before[0]);
		expect(after[1]).toBe(before[1]);

		// The result joins the one message that carries the call, and only that one is made again.
		live.push(
			frame(4, {
				type: "tool_result",
				call_id: "c1",
				is_error: false,
				content: [{ type: "text", data: { text: "found it" } }],
			}),
		);
		await vi.advanceTimersByTimeAsync(10);
		const joined = connection.transcript;
		expect(joined[0]).toBe(before[0]);
		expect(joined[2]).toBe(after[2]);
		expect(joined[1]).not.toBe(before[1]);
		expect(joined[1]?.toolCalls?.[0]?.result).toEqual({
			content: [{ type: "text", data: { text: "found it" } }],
			is_error: false,
		});
		// The message itself is the event's own, whatever the join made of the calls beside it.
		expect(joined[1]?.message).toBe(before[1]?.message);

		connection.close();
	});
});
