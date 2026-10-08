import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictError, SubakoError, type SubakoClient, SubakoTimeoutError } from "../src/index.js";
import { empty, type FetchStub, hang, json, stubFetch, testClient, text } from "./support.js";

const agent = { id: "a1", name: "triage" };
const session = { id: "s1", token: "sbk_st_x" };
const version = { skill_id: "sk1", version: 1 };

afterEach(() => {
	vi.useRealTimers();
});

/** Runs `call` to completion, letting every backoff elapse at once. */
async function settle<T>(call: Promise<T>): Promise<unknown> {
	const settled: Promise<unknown> = call.then(
		(value: T) => value,
		(error: unknown) => error,
	);
	await vi.advanceTimersByTimeAsync(120_000);
	return settled;
}

const keys = (http: FetchStub): readonly (string | null)[] =>
	http.calls.map((call) => call.headers.get("idempotency-key"));

const envelope = (code: string, status: number): Response => json({ error: { code, message: code } }, status);

const archive = (): ReadableStream<Uint8Array> =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array([1, 2, 3]));
			controller.close();
		},
	});

describe("retries", () => {
	it.each([[503], [500], [429], [408]])("tries again after %i", async (status) => {
		vi.useFakeTimers();
		const http = stubFetch(
			() => empty(status),
			() => json(agent),
		);
		const client = testClient({ fetch: http.fetch });

		await expect(settle(client.agents.get("a1"))).resolves.toEqual(agent);
		expect(http.calls).toHaveLength(2);
	});

	it("tries again after a connection failure", async () => {
		vi.useFakeTimers();
		let attempts = 0;
		const http = stubFetch(() => {
			attempts += 1;
			if (attempts === 1) {
				throw new TypeError("fetch failed");
			}
			return json(agent);
		});
		const client = testClient({ fetch: http.fetch });

		await expect(settle(client.agents.get("a1"))).resolves.toEqual(agent);
		expect(http.calls).toHaveLength(2);
	});

	it("tries again after a timeout", async () => {
		vi.useFakeTimers();
		let attempts = 0;
		const http = stubFetch((request) => {
			attempts += 1;
			return attempts === 1 ? hang(request) : json(agent);
		});
		const client = testClient({ fetch: http.fetch, timeout: 1_000 });

		await expect(settle(client.agents.get("a1"))).resolves.toEqual(agent);
		expect(http.calls).toHaveLength(2);
	});

	it.each([200, 503])("classifies a stalled HTTP %i body as a timeout", async (status) => {
		vi.useFakeTimers();
		const http = stubFetch(
			(request) =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							request.signal.addEventListener("abort", () => controller.error(request.signal.reason), { once: true });
						},
					}),
					{ status, headers: { "content-type": "application/json" } },
				),
		);
		const client = testClient({ fetch: http.fetch, timeout: 100, maxRetries: 0 });
		const error = await settle(client.agents.get("a1"));
		expect(error).toBeInstanceOf(SubakoTimeoutError);
		expect((error as Error).cause).toBeInstanceOf(DOMException);
		expect((error as Error).message).toContain("100ms");
	});

	it("retries a body timeout under the same idempotency key", async () => {
		vi.useFakeTimers();
		const http = stubFetch(
			(request) =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							request.signal.addEventListener("abort", () => controller.error(request.signal.reason), { once: true });
						},
					}),
					{ headers: { "content-type": "application/json" } },
				),
			() => json(session, 201),
		);
		const client = testClient({ fetch: http.fetch, timeout: 100 });
		await expect(settle(client.sessions.create({ agent_id: "a1" }))).resolves.toEqual(session);
		expect(http.calls).toHaveLength(2);
		expect(keys(http)[0]).toBeTruthy();
		expect(keys(http)[0]).toBe(keys(http)[1]);
	});

	it("preserves the caller's abort while reading a body and does not retry it", async () => {
		vi.useFakeTimers();
		const stop = new AbortController();
		const cause = new Error("the caller stopped");
		const http = stubFetch(
			(request) =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							request.signal.addEventListener("abort", () => controller.error(request.signal.reason), { once: true });
						},
					}),
					{ headers: { "content-type": "application/json" } },
				),
		);
		const client = testClient({ fetch: http.fetch });
		const call = client.agents.get("a1", { signal: stop.signal }).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(1);
		stop.abort(cause);
		await expect(call).resolves.toBe(cause);
		expect(http.calls).toHaveLength(1);
	});

	it.each([[409], [400], [404]])("does not try again after %i", async (status) => {
		vi.useFakeTimers();
		const http = stubFetch(() => envelope("conflict", status));
		const client = testClient({ fetch: http.fetch });

		const error = await settle(client.agents.get("a1"));
		expect(error).toBeInstanceOf(SubakoError);
		expect(http.calls).toHaveLength(1);
	});

	it.each([[429], [500], [503]])("gives up after maxRetries and throws the last %i", async (status) => {
		vi.useFakeTimers();
		const http = stubFetch(() => text("down", status));
		const client = testClient({ fetch: http.fetch });

		const error = await settle(client.agents.get("a1"));
		expect((error as SubakoError).status).toBe(status);
		expect(http.calls).toHaveLength(3);
	});

	it("gives up after a timeout budget of its own", async () => {
		vi.useFakeTimers();
		const http = stubFetch(hang);
		const client = testClient({ fetch: http.fetch, timeout: 500, maxRetries: 1 });

		const error = await settle(client.agents.get("a1"));
		expect(error).toBeInstanceOf(SubakoTimeoutError);
		expect(http.calls).toHaveLength(2);
	});

	it("takes maxRetries from the call", async () => {
		vi.useFakeTimers();
		const http = stubFetch(() => empty(503));
		const client = testClient({ fetch: http.fetch });

		await settle(client.agents.get("a1", { maxRetries: 0 }));
		expect(http.calls).toHaveLength(1);
	});

	it("waits out the server's Retry-After", async () => {
		vi.useFakeTimers();
		const http = stubFetch(
			() => empty(429, { "retry-after": "2" }),
			() => json(agent),
		);
		const client = testClient({ fetch: http.fetch });

		const call = client.agents.get("a1");
		await vi.advanceTimersByTimeAsync(1_900);
		expect(http.calls).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(200);
		await expect(call).resolves.toEqual(agent);
		expect(http.calls).toHaveLength(2);
	});
});

describe("an operation that takes an idempotency key", () => {
	it("repeats a connection failure under the key it started with", async () => {
		vi.useFakeTimers();
		let attempts = 0;
		const http = stubFetch(() => {
			attempts += 1;
			if (attempts === 1) {
				throw new TypeError("fetch failed");
			}
			return json(session, 201);
		});
		const client = testClient({ fetch: http.fetch });

		await expect(settle(client.sessions.create({ agent_id: "a1" }))).resolves.toEqual(session);
		expect(http.calls).toHaveLength(2);
		const [first, second] = keys(http);
		expect(first).toMatch(/^[0-9a-f-]{36}$/);
		expect(second).toBe(first);
	});

	it("does not repeat a 409, which the server settles under its own lock", async () => {
		vi.useFakeTimers();
		const http = stubFetch(() => envelope("conflict", 409));
		const client = testClient({ fetch: http.fetch });

		const error = await settle(client.sessions.create({ agent_id: "a1" }));
		expect((error as SubakoError).code).toBe("conflict");
		expect(http.calls).toHaveLength(1);
	});

	it("reports a key reused with another request as the conflict it is, without repeating it", async () => {
		vi.useFakeTimers();
		const http = stubFetch(() => envelope("conflict", 409));
		const client = testClient({ fetch: http.fetch });

		const error = await settle(client.sessions.create({ agent_id: "a1" }, { idempotencyKey: "mine" }));
		expect(error).toBeInstanceOf(ConflictError);
		expect((error as SubakoError).status).toBe(409);
		expect(http.calls).toHaveLength(1);
	});

	it("sends the caller's own key verbatim", async () => {
		vi.useFakeTimers();
		const http = stubFetch(
			() => empty(503),
			() => json(session, 201),
		);
		const client = testClient({ fetch: http.fetch });

		await settle(client.sessions.create({ agent_id: "a1" }, { idempotencyKey: "run-2026-09-06" }));
		expect(keys(http)).toEqual(["run-2026-09-06", "run-2026-09-06"]);
	});

	it("gives every call a key of its own", async () => {
		const http = stubFetch(() => json(session, 201));
		const client = testClient({ fetch: http.fetch });

		await client.sessions.create({ agent_id: "a1" });
		await client.sessions.create({ agent_id: "a1" });
		const [first, second] = keys(http);
		expect(first).not.toBe(second);
	});

	it("repeats an upload whose body it can read twice, under the same key", async () => {
		vi.useFakeTimers();
		const http = stubFetch(
			() => empty(503),
			() => json(version, 201),
		);
		const client = testClient({ fetch: http.fetch });

		await expect(settle(client.skills.create(new Uint8Array([1, 2, 3])))).resolves.toEqual(version);
		expect(http.calls).toHaveLength(2);
		const [first, second] = keys(http);
		expect(second).toBe(first);
	});

	it("never repeats an upload streaming a body it can only read once", async () => {
		vi.useFakeTimers();
		const http = stubFetch(() => empty(503));
		const client = testClient({ fetch: http.fetch });

		const error = await settle(client.skills.create(archive()));
		expect((error as SubakoError).status).toBe(503);
		expect(http.calls).toHaveLength(1);
		expect(keys(http)[0]).toMatch(/^[0-9a-f-]{36}$/);
	});
});

describe("an operation that takes no idempotency key", () => {
	const calls: ReadonlyArray<[string, (client: SubakoClient) => Promise<unknown>]> = [
		["agents.get", (client) => client.agents.get("a1")],
		["sessions.updateClientTools", (client) => client.sessions.updateClientTools("s1", "c1", { tools: [] })],
	];

	it.each(calls)("repeats %s after a 500 and sends no key", async (_name, call) => {
		vi.useFakeTimers();
		const http = stubFetch(
			() => empty(500),
			() => json(agent),
		);
		const client = testClient({ fetch: http.fetch });

		await expect(settle(call(client))).resolves.toEqual(agent);
		expect(http.calls).toHaveLength(2);
		expect(keys(http)).toEqual([null, null]);
	});

	it("sends no key on the event stream", async () => {
		const live = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		});
		const http = stubFetch(() => new Response(live, { status: 200, headers: { "content-type": "text/event-stream" } }));
		const client = testClient({ fetch: http.fetch });

		const connection = client.sessions.connect("s1");
		await connection.ready.catch(() => undefined);
		connection.close();
		expect(keys(http)).toEqual([null]);
	});

	it("ignores an idempotency key the caller passes anyway", async () => {
		const http = stubFetch(() => json(agent));
		const client = testClient({ fetch: http.fetch });

		await client.agents.get("a1", { idempotencyKey: "mine" });
		expect(keys(http)).toEqual([null]);
	});
});

describe("a request that was never built", () => {
	it("reports the credential's own failure without retrying", async () => {
		const http = stubFetch(() => json({ id: "a1" }));
		let calls = 0;
		const client = testClient({
			fetch: http.fetch,
			apiKey: () => {
				calls += 1;
				throw new Error("refresh failed");
			},
		});

		await expect(client.agents.get("a1")).rejects.toThrow("refresh failed");
		expect(calls).toBe(1);
		expect(http.calls).toHaveLength(0);
	});
});
