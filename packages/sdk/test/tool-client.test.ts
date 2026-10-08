import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionConnection, ToolCall, ToolClient, ToolClientState, ToolDefinition } from "../src/index.js";
import {
	empty,
	type FetchStub,
	frame,
	hang,
	type Handler,
	json,
	type LiveSse,
	liveSse,
	stubFetch,
	testSessionClient,
} from "./support.js";

afterEach(() => {
	vi.useRealTimers();
});

const CLIENT_ID = "cl1";

/** Answers every route a client touches, with the stream held open. */
function router(live: LiveSse, overrides: Readonly<Record<string, Handler>> = {}): Handler {
	return (request) => {
		const { pathname } = new URL(request.url);
		const override = Object.entries(overrides).find(([suffix]) => pathname.endsWith(suffix));
		if (override !== undefined) {
			return override[1](request);
		}
		if (pathname.endsWith("/events/stream")) {
			return live.response;
		}
		if (pathname.endsWith("/ping")) {
			return json({ expires_at: null });
		}
		if (pathname.endsWith("/ack")) {
			return json({ seq: 0, type: "client_tool_acked", client_id: CLIENT_ID, call_id: "x" });
		}
		if (pathname.endsWith("/result")) {
			return empty(204);
		}
		if (pathname.endsWith("/tools")) {
			return json({ seq: 0, type: "client_tools_updated", client_id: CLIENT_ID, tools: [] });
		}
		if (request.method === "POST" && pathname.endsWith("/clients")) {
			return json({ id: CLIENT_ID, name: "web", expires_at: null }, 201);
		}
		if (request.method === "DELETE") {
			return empty(204);
		}
		throw new Error(`no route for ${request.method} ${pathname}`);
	};
}

const sent = (http: FetchStub, method: string, suffix: string): readonly Request[] =>
	http.calls.filter((call) => call.method === method && new URL(call.url).pathname.endsWith(suffix));

const body = async (request: Request | undefined): Promise<unknown> => request?.json();

/** Lets the pending answers settle without moving a deadline that matters. */
async function flush(): Promise<void> {
	await vi.advanceTimersByTimeAsync(1);
	await vi.advanceTimersByTimeAsync(1);
}

/** The phases one call passed through, in order. */
function seenPhases(client: ToolClient, callId = "call-1"): string[] {
	const seen: string[] = [];
	client.subscribe((state) => {
		const phase = state.calls.find((call) => call.callId === callId)?.phase;
		if (phase !== undefined && seen.at(-1) !== phase) {
			seen.push(phase);
		}
	});
	return seen;
}

const dispatch = (seq: number, callId: string, tool: string, args: Record<string, unknown>, clientId = CLIENT_ID) =>
	frame(seq, { type: "client_tool_dispatched", client_id: clientId, call_id: callId, tool, arguments: args });

const navigate = {
	description: "Go to a page.",
	parameters: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
	execute: (args: { to: string }) => `at ${args.to}`,
};

const fillForm = { description: "Fills the form.", parameters: { type: "object" }, execute: () => "filled" };

const search = { description: "Searches.", parameters: { type: "object" }, execute: () => "found" };

interface Stack {
	readonly http: FetchStub;
	readonly live: LiveSse;
	readonly connection: SessionConnection;
}

function connect(overrides: Readonly<Record<string, Handler>> = {}): Stack {
	const live = liveSse();
	const http = stubFetch(router(live, overrides));
	const browser = testSessionClient({ fetch: http.fetch });
	return { http, live, connection: browser.connect("s1") };
}

describe("the tool client", () => {
	it("refuses a tool with no name, rather than offering the server a set it will reject", () => {
		const { connection } = connect();
		const client = connection.createToolClient("web");

		// One client carries every tool, so a nameless one is not a tool that goes missing — it is
		// the whole set refused, and every tool on the page stops working.
		expect(() => client.addTool("", navigate)).toThrow(/name/);
		expect(() => client.addTool("   ", navigate)).toThrow(/name/);
		expect(client.state.tools).toEqual([]);
	});

	it("registers once the connection is open, then pings at half the ttl", async () => {
		vi.useFakeTimers();
		const { http, connection } = connect();

		const client = connection.createToolClient("web");
		client.addTool("navigate", navigate);
		expect(client.state.status).toBe("joining");
		await flush();
		await client.ready;

		// The stream is opened first, so no dispatch can precede the subscription.
		expect(http.calls.map((call) => call.method)).toEqual(["GET", "POST"]);
		expect(client.state.status).toBe("serving");
		expect(client.state.id).toBe(CLIENT_ID);
		expect(client.state.name).toBe("web");
		expect(await body(http.calls[1])).toEqual({
			name: "web",
			lifetime: { type: "ttl", data: { seconds: 60 } },
			tools: [{ name: "navigate", description: navigate.description, parameters: navigate.parameters }],
		});

		await vi.advanceTimersByTimeAsync(30_000);
		expect(sent(http, "POST", "/ping")).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(sent(http, "POST", "/ping")).toHaveLength(2);

		connection.close();
	});

	it("sends no ping under a lifetime that never lapses", async () => {
		vi.useFakeTimers();
		const { http, connection } = connect();

		const client = connection.createToolClient("web", { lifetime: { type: "never" } });
		client.addTool("navigate", navigate);
		await flush();
		await client.ready;
		await vi.advanceTimersByTimeAsync(600_000);

		expect(await body(http.calls[1])).toMatchObject({ lifetime: { type: "never" } });
		expect(sent(http, "POST", "/ping")).toHaveLength(0);

		connection.close();
	});

	it("acks a dispatch, runs the tool, and answers with what it returned", async () => {
		vi.useFakeTimers();
		const { http, live, connection } = connect();
		const seen: ToolCall[] = [];
		const client = connection.createToolClient("web");
		client.addTool("navigate", {
			...navigate,
			execute: (args: { to: string }, call) => {
				seen.push(call);
				return `at ${args.to}`;
			},
		});
		await flush();
		await client.ready;

		live.push(dispatch(1, "call-1", "navigate", { to: "/contact" }));
		await flush();

		expect(sent(http, "POST", "/ack")).toHaveLength(1);
		expect(new URL(sent(http, "POST", "/ack")[0]!.url).pathname).toContain("/calls/call-1/ack");
		expect(await body(sent(http, "POST", "/result")[0])).toEqual({ text: "at /contact" });
		expect(seen.map((call) => call.callId)).toEqual(["call-1"]);
		expect(seen[0]?.signal.aborted).toBe(false);

		connection.close();
	});

	it("runs calls concurrently", async () => {
		vi.useFakeTimers();
		const { http, live, connection } = connect();
		const running: string[] = [];
		let release = (): void => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const client = connection.createToolClient("web");
		client.addTool("wait", {
			description: "Waits.",
			parameters: { type: "object" },
			execute: async (_args, call) => {
				running.push(call.callId);
				await held;
				return "done";
			},
		});
		await flush();
		await client.ready;

		live.push(dispatch(1, "call-1", "wait", {}));
		live.push(dispatch(2, "call-2", "wait", {}));
		await flush();
		expect(running).toEqual(["call-1", "call-2"]);
		expect(sent(http, "POST", "/result")).toHaveLength(0);

		release();
		await flush();
		expect(sent(http, "POST", "/result")).toHaveLength(2);

		connection.close();
	});

	it.each([
		[
			"a tool that throws",
			"navigate",
			{
				navigate: {
					...navigate,
					execute: () => {
						throw new Error("the router is gone");
					},
				},
			},
			"the router is gone",
		],
		["a tool it does not serve", "teleport", { navigate }, "no tool named teleport"],
		[
			"arguments it cannot parse",
			"navigate",
			{
				navigate: {
					...navigate,
					parse: () => {
						throw new TypeError("to is required");
					},
				},
			},
			"to is required",
		],
	])("answers with an error for %s", async (_case, tool, tools, message) => {
		vi.useFakeTimers();
		const { http, live, connection } = connect();
		const client = connection.createToolClient("web");
		for (const [name, tool] of Object.entries(tools as Readonly<Record<string, ToolDefinition>>)) {
			client.addTool(name, tool);
		}
		await flush();
		await client.ready;

		live.push(dispatch(1, "call-1", tool, { to: "/contact" }));
		await flush();

		expect(sent(http, "POST", "/ack")).toHaveLength(1);
		const answer = (await body(sent(http, "POST", "/result")[0])) as { text: string; is_error: boolean };
		expect(answer.is_error).toBe(true);
		expect(answer.text).toContain(message);

		connection.close();
	});

	it("swaps the tools and the handlers behind them", async () => {
		vi.useFakeTimers();
		const { http, live, connection } = connect();
		const client = connection.createToolClient("web");
		client.addTool("navigate", navigate);
		await flush();
		await client.ready;

		client.addTool("fill_form", fillForm);
		client.removeTool("navigate");
		await flush();

		expect(await body(sent(http, "PUT", "/tools")[0])).toEqual({
			tools: [{ name: "fill_form", description: "Fills the form.", parameters: { type: "object" } }],
		});

		live.push(dispatch(1, "call-1", "fill_form", {}));
		live.push(dispatch(2, "call-2", "navigate", { to: "/contact" }));
		await flush();

		const answers = await Promise.all(sent(http, "POST", "/result").map((call) => call.json()));
		expect(answers).toEqual([{ text: "filled" }, { text: "no tool named navigate is served here", is_error: true }]);

		connection.close();
	});

	it("ignores the dispatches meant for other clients", async () => {
		vi.useFakeTimers();
		const { http, live, connection } = connect();
		const client = connection.createToolClient("web");
		client.addTool("navigate", navigate);
		await flush();
		await client.ready;

		live.push(dispatch(1, "call-1", "navigate", { to: "/contact" }, "other-client"));
		await flush();

		expect(sent(http, "POST", "/ack")).toHaveLength(0);
		expect(sent(http, "POST", "/result")).toHaveLength(0);

		connection.close();
	});

	it("is deleted when the connection closes", async () => {
		vi.useFakeTimers();
		const { http, connection } = connect();
		const client = connection.createToolClient("web");
		client.addTool("navigate", navigate);
		await flush();
		await client.ready;

		connection.close();
		await flush();

		expect(sent(http, "DELETE", `/clients/${CLIENT_ID}`)).toHaveLength(1);
		expect(sent(http, "POST", "/ping")).toHaveLength(0);
	});

	it("is deleted when the connection's signal aborts", async () => {
		vi.useFakeTimers();
		const stop = new AbortController();
		const live = liveSse();
		const http = stubFetch(router(live));
		const browser = testSessionClient({ fetch: http.fetch });
		const connection = browser.connect("s1", { signal: stop.signal });
		const client = connection.createToolClient("web");
		client.addTool("navigate", navigate);
		await flush();
		await client.ready;

		stop.abort();
		await flush();

		expect(sent(http, "DELETE", `/clients/${CLIENT_ID}`)).toHaveLength(1);
		expect(connection.state.status).toBe("closed");
	});

	it("aborts a running call when the client is deleted, and answers nothing after it", async () => {
		vi.useFakeTimers();
		const { http, live, connection } = connect();
		let aborted: boolean | undefined;
		const client = connection.createToolClient("web");
		client.addTool("wait", {
			description: "Waits.",
			parameters: { type: "object" },
			execute: (_args, call) =>
				new Promise<string>((resolve) => {
					call.signal.addEventListener("abort", () => {
						aborted = true;
						resolve("stopped");
					});
				}),
		});
		await flush();
		await client.ready;

		live.push(dispatch(1, "call-1", "wait", {}));
		await flush();
		expect(sent(http, "POST", "/ack")).toHaveLength(1);

		await connection.deleteToolClient(client);
		await flush();

		expect(aborted).toBe(true);
		expect(sent(http, "POST", "/result")).toHaveLength(0);
		expect(sent(http, "DELETE", `/clients/${CLIENT_ID}`)).toHaveLength(1);

		connection.close();
	});

	it("answers with what execute returned when it returned a result body", async () => {
		vi.useFakeTimers();
		const { http, live, connection } = connect();
		const client = connection.createToolClient("web");
		client.addTool("navigate", { ...navigate, execute: () => ({ text: "the page is gone", is_error: true }) });
		await flush();
		await client.ready;

		live.push(dispatch(1, "call-1", "navigate", { to: "/contact" }));
		await flush();

		expect(await body(sent(http, "POST", "/result")[0])).toEqual({ text: "the page is gone", is_error: true });

		connection.close();
	});

	it("gives each client on one connection only the dispatches meant for it", async () => {
		vi.useFakeTimers();
		let registrations = 0;
		const { http, live, connection } = connect({
			"/clients": (request) => {
				if (request.method !== "POST") {
					return empty(204);
				}
				registrations += 1;
				return json({ id: `cl${registrations}`, name: `web-${registrations}`, expires_at: null }, 201);
			},
		});
		const served: string[] = [];
		const owned = (owner: string): ToolDefinition => ({
			...navigate,
			execute: (_args, call) => `${owner}:${call.callId}`,
		});
		const first = connection.createToolClient("web");
		first.addTool("navigate", owned("first"));
		const second = connection.createToolClient("web");
		second.addTool("navigate", owned("second"));
		await flush();
		await first.ready;
		await second.ready;
		expect([first.state.id, second.state.id]).toEqual(["cl1", "cl2"]);

		live.push(dispatch(1, "call-1", "navigate", { to: "/a" }, "cl1"));
		live.push(dispatch(2, "call-2", "navigate", { to: "/b" }, "cl2"));
		await flush();
		for (const call of sent(http, "POST", "/result")) {
			served.push(new URL(call.url).pathname);
		}

		const answers = await Promise.all(sent(http, "POST", "/result").map((call) => call.json()));
		expect(answers).toEqual([{ text: "first:call-1" }, { text: "second:call-2" }]);
		expect(served[0]).toContain("/clients/cl1/");
		expect(served[1]).toContain("/clients/cl2/");

		connection.close();
	});

	it("serves a dispatch that arrived while the registration was in flight", async () => {
		vi.useFakeTimers();
		let register = (): void => undefined;
		const answered = new Promise<void>((resolve) => {
			register = resolve;
		});
		const { http, live, connection } = connect({
			"/clients": async (request) => {
				if (request.method !== "POST") {
					return empty(204);
				}
				await answered;
				return json({ id: CLIENT_ID, name: "web", expires_at: null }, 201);
			},
		});
		const client = connection.createToolClient("web");
		client.addTool("navigate", navigate);
		await flush();

		live.push(dispatch(1, "call-1", "navigate", { to: "/contact" }));
		await flush();
		expect(sent(http, "POST", "/ack")).toHaveLength(0);

		register();
		await client.ready;
		await flush();

		expect(sent(http, "POST", "/ack")).toHaveLength(1);
		expect(await body(sent(http, "POST", "/result")[0])).toEqual({ text: "at /contact" });

		connection.close();
	});

	it("runs a dispatch the reconnect replayed only once", async () => {
		vi.useFakeTimers();
		const first = liveSse();
		const second = liveSse();
		let streams = 0;
		const http = stubFetch(
			router(second, {
				"/events/stream": () => {
					streams += 1;
					return streams === 1 ? first.response : second.response;
				},
			}),
		);
		const browser = testSessionClient({ fetch: http.fetch });
		const connection = browser.connect("s1");
		const client = connection.createToolClient("web");
		client.addTool("navigate", navigate);
		await flush();
		await client.ready;

		const replayed = dispatch(1, "call-1", "navigate", { to: "/contact" });
		first.push(replayed);
		await flush();
		expect(sent(http, "POST", "/ack")).toHaveLength(1);

		first.close();
		await vi.advanceTimersByTimeAsync(3_000);
		second.push(replayed);
		await flush();

		expect(streams).toBe(2);
		expect(sent(http, "POST", "/ack")).toHaveLength(1);
		expect(sent(http, "POST", "/result")).toHaveLength(1);

		connection.close();
	});

	it("reports a background failure through onError", async () => {
		vi.useFakeTimers();
		const failures: unknown[] = [];
		const { http, live, connection } = connect({ "/ack": () => empty(403) });
		const client = connection.createToolClient("web", { onError: (error) => failures.push(error) });
		client.addTool("navigate", navigate);
		await flush();
		await client.ready;

		live.push(dispatch(1, "call-1", "navigate", { to: "/contact" }));
		await flush();

		expect(failures).toHaveLength(1);
		expect(sent(http, "POST", "/result")).toHaveLength(0);

		connection.close();
	});

	it("reports an answer the server refused through onError", async () => {
		vi.useFakeTimers();
		const failures: unknown[] = [];
		const { http, live, connection } = connect({ "/result": () => empty(403) });
		const client = connection.createToolClient("web", { onError: (error) => failures.push(error) });
		client.addTool("navigate", navigate);
		await flush();
		await client.ready;

		live.push(dispatch(1, "call-1", "navigate", { to: "/contact" }));
		await flush();

		expect(sent(http, "POST", "/ack")).toHaveLength(1);
		expect(sent(http, "POST", "/result")).toHaveLength(1);
		expect(failures).toHaveLength(1);

		connection.close();
	});
});

describe("the tool client, deleted and failing", () => {
	it("registers nothing when it is deleted before the stream opens", async () => {
		vi.useFakeTimers();
		const { http, connection } = connect();
		const client = connection.createToolClient("web");
		client.addTool("navigate", navigate);

		await connection.deleteToolClient(client);
		await flush();

		expect(http.calls.map((call) => call.method)).toEqual(["GET"]);
		await expect(client.ready).rejects.toThrow(/left before it registered/);
		expect(client.state.id).toBeUndefined();
		// The delete it never registered under is what settles it.
		expect(client.state.status).toBe("left");

		connection.close();
	});

	it("retries a delete the server refused, and stops serving from the first attempt", async () => {
		vi.useFakeTimers();
		const failures: unknown[] = [];
		let deletes = 0;
		const { http, live, connection } = connect({
			[`/clients/${CLIENT_ID}`]: (request) => {
				if (request.method !== "DELETE") {
					return empty(404);
				}
				deletes += 1;
				return deletes === 1 ? empty(409) : empty(204);
			},
		});
		const client = connection.createToolClient("web", { onError: (error) => failures.push(error) });
		client.addTool("navigate", navigate);
		await flush();
		await client.ready;

		await expect(connection.deleteToolClient(client)).rejects.toThrow();
		expect(failures).toHaveLength(1);

		// The client stopped serving even though the server still has it registered.
		live.push(dispatch(1, "call-1", "navigate", { to: "/contact" }));
		await vi.advanceTimersByTimeAsync(60_000);
		expect(sent(http, "POST", "/ack")).toHaveLength(0);
		expect(sent(http, "POST", "/ping")).toHaveLength(0);

		await connection.deleteToolClient(client);
		expect(sent(http, "DELETE", `/clients/${CLIENT_ID}`)).toHaveLength(2);

		// Once the server has been told, there is nothing left to retry.
		await connection.deleteToolClient(client);
		expect(sent(http, "DELETE", `/clients/${CLIENT_ID}`)).toHaveLength(2);

		connection.close();
	});

	it("tells the server nothing when a client that has left changes its tools", async () => {
		vi.useFakeTimers();
		const { http, connection } = connect();
		const client = connection.createToolClient("web");
		client.addTool("navigate", navigate);
		await flush();
		await client.ready;

		await connection.deleteToolClient(client);
		client.addTool("fill_form", fillForm);
		await flush();

		expect(sent(http, "PUT", "/tools")).toHaveLength(0);
		expect(client.state.tools).toEqual(["navigate", "fill_form"]);

		connection.close();
	});

	it("stops serving and keeps nothing when the registration fails", async () => {
		vi.useFakeTimers();
		const { http, live, connection } = connect({
			"/clients": (request) => (request.method === "POST" ? empty(400) : empty(204)),
		});
		const client = connection.createToolClient("web");
		client.addTool("navigate", navigate);
		await flush();

		await expect(client.ready).rejects.toThrow();
		expect(client.state.status).toBe("failed");
		expect(client.state.error).toBeInstanceOf(Error);
		live.push(dispatch(1, "call-1", "navigate", { to: "/contact" }));
		await flush();
		expect(sent(http, "POST", "/ack")).toHaveLength(0);

		// Nothing was buffered and nothing stayed attached, so the close has nobody to send away.
		connection.close();
		await flush();
		expect(sent(http, "DELETE", `/clients/${CLIENT_ID}`)).toHaveLength(0);
		expect(sent(http, "POST", "/ack")).toHaveLength(0);
	});

	it("leaves when the server says this client left, and answers nothing after it", async () => {
		vi.useFakeTimers();
		const { http, live, connection } = connect();
		let aborted = false;
		const client = connection.createToolClient("web");
		client.addTool("wait", {
			description: "Waits.",
			parameters: { type: "object" },
			execute: (_args, call) =>
				new Promise<string>((resolve) => {
					call.signal.addEventListener("abort", () => {
						aborted = true;
						resolve("stopped");
					});
				}),
		});
		await flush();
		await client.ready;
		live.push(dispatch(1, "call-1", "wait", {}));
		await flush();
		expect(sent(http, "POST", "/ack")).toHaveLength(1);

		live.push(frame(2, { type: "client_left", client_id: CLIENT_ID, reason: "timed_out" }));
		await flush();

		expect(client.state.status).toBe("left");
		expect(client.state.calls[0]?.phase).toBe("failed");
		expect(aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(sent(http, "POST", "/ping")).toHaveLength(0);
		expect(sent(http, "POST", "/result")).toHaveLength(0);
		// The registration is already gone, so there is nothing to delete.
		await connection.deleteToolClient(client);
		expect(sent(http, "DELETE", `/clients/${CLIENT_ID}`)).toHaveLength(0);

		connection.close();
	});

	it("leaves when a ping meets a refusal every later ping would meet", async () => {
		vi.useFakeTimers();
		const failures: unknown[] = [];
		const { http, connection } = connect({ "/ping": () => empty(404) });
		const client = connection.createToolClient("web", { onError: (error) => failures.push(error) });
		client.addTool("navigate", navigate);
		await flush();
		await client.ready;

		await vi.advanceTimersByTimeAsync(30_000);
		await flush();

		expect(sent(http, "POST", "/ping")).toHaveLength(1);
		expect(failures).toHaveLength(1);
		expect(client.state.status).toBe("left");
		// A client that is no longer registered pings no more.
		await vi.advanceTimersByTimeAsync(120_000);
		expect(sent(http, "POST", "/ping")).toHaveLength(1);

		connection.close();
	});

	it("refuses a client created after the connection closed", async () => {
		vi.useFakeTimers();
		const { http, connection } = connect();
		await connection.ready;
		connection.close();

		const client = connection.createToolClient("web");
		client.addTool("navigate", navigate);
		await expect(client.ready).rejects.toThrow(/connection ended/);
		await flush();

		// It waits in no status: there is nothing to serve, and the failure says so.
		expect(client.state.status).toBe("failed");
		expect(client.state.error).toBeInstanceOf(Error);
		expect(http.calls.map((call) => call.method)).toEqual(["GET"]);
		// Nothing is owed on a client that never registered.
		await expect(connection.deleteToolClient(client)).resolves.toBeUndefined();
	});
});

describe("the tool client, as a store", () => {
	it("notifies its subscribers on the registration and on the delete", async () => {
		vi.useFakeTimers();
		const { connection } = connect();
		const client = connection.createToolClient("web");
		client.addTool("navigate", navigate);
		const states: ToolClientState[] = [];
		client.subscribe((state) => states.push(state));

		expect(client.state).toEqual({
			status: "joining",
			error: undefined,
			id: undefined,
			name: undefined,
			tools: ["navigate"],
			calls: [],
		});
		await flush();
		await client.ready;

		expect(states.map((state) => state.status)).toEqual(["serving"]);
		expect(states[0]).toMatchObject({ id: CLIENT_ID, name: "web", tools: ["navigate"] });
		expect(client.state).toBe(states[0]);

		await connection.deleteToolClient(client);

		expect(states.map((state) => state.status)).toEqual(["serving", "leaving", "left"]);
		expect(states[2]?.id).toBe(CLIENT_ID);

		connection.close();
	});

	it("names the tools it serves, and the ones that replaced them", async () => {
		vi.useFakeTimers();
		const { connection } = connect();
		const client = connection.createToolClient("web");
		client.addTool("navigate", navigate);
		await flush();
		await client.ready;
		expect(client.state.tools).toEqual(["navigate"]);

		const states: ToolClientState[] = [];
		client.subscribe((state) => states.push(state));
		client.removeTool("navigate");
		client.addTool("fill_form", fillForm);
		await flush();

		expect(states.map((state) => state.tools)).toEqual([[], ["fill_form"]]);
		expect(client.state.tools).toEqual(["fill_form"]);

		connection.close();
	});

	it("walks a call from the ack to the answer", async () => {
		vi.useFakeTimers();
		const { live, connection } = connect();
		const client = connection.createToolClient("web");
		client.addTool("navigate", navigate);
		await flush();
		await client.ready;
		const phases = seenPhases(client);

		live.push(dispatch(1, "call-1", "navigate", { to: "/contact" }));
		await flush();

		expect(phases).toEqual(["acked", "running", "answered"]);
		expect(client.state.calls).toEqual([
			{
				callId: "call-1",
				tool: "navigate",
				arguments: { to: "/contact" },
				phase: "answered",
				answer: { text: "at /contact" },
			},
		]);

		connection.close();
	});

	it("settles a call the tool threw in as failed, with the answer it sent", async () => {
		vi.useFakeTimers();
		const { live, connection } = connect();
		const client = connection.createToolClient("web");
		client.addTool("navigate", {
			...navigate,
			execute: () => {
				throw new Error("the router is gone");
			},
		});
		await flush();
		await client.ready;
		const phases = seenPhases(client);

		live.push(dispatch(1, "call-1", "navigate", { to: "/contact" }));
		await flush();

		// An error answer is still an answer the server took; `failed` is for a call that never got one.
		expect(phases).toEqual(["acked", "running", "answered"]);
		expect(client.state.calls[0]?.answer).toEqual({ text: "the router is gone", is_error: true });

		connection.close();
	});

	it("settles a call the server never took as failed", async () => {
		vi.useFakeTimers();
		const { live, connection } = connect({ "/ack": () => empty(403) });
		const client = connection.createToolClient("web", { onError: () => undefined });
		client.addTool("navigate", navigate);
		await flush();
		await client.ready;

		live.push(dispatch(1, "call-1", "navigate", { to: "/contact" }));
		await flush();

		expect(client.state.calls).toEqual([
			{ callId: "call-1", tool: "navigate", arguments: { to: "/contact" }, phase: "failed" },
		]);

		connection.close();
	});
});

describe("the tool client, as a declared set", () => {
	it("registers with the tools declared before the stream opened", async () => {
		vi.useFakeTimers();
		const { http, connection } = connect();
		const client = connection.createToolClient("web");

		client.addTool("navigate", navigate);
		await flush();
		await client.ready;

		expect(await body(http.calls[1])).toMatchObject({
			tools: [{ name: "navigate", description: navigate.description, parameters: navigate.parameters }],
		});
		// The registration carried the set, so there is nothing left to update.
		expect(sent(http, "PUT", "/tools")).toHaveLength(0);
		expect(client.state.tools).toEqual(["navigate"]);

		connection.close();
	});

	it("sends the changes made in one tick as one update", async () => {
		vi.useFakeTimers();
		const { http, connection } = connect();
		const client = connection.createToolClient("web");
		client.addTool("navigate", navigate);
		await flush();
		await client.ready;

		client.addTool("fill_form", fillForm);
		client.addTool("search", search);
		client.removeTool("navigate");
		await flush();

		const updates = sent(http, "PUT", "/tools");
		expect(updates).toHaveLength(1);
		expect(await body(updates[0])).toEqual({
			tools: [
				{ name: "fill_form", description: "Fills the form.", parameters: { type: "object" } },
				{ name: "search", description: "Searches.", parameters: { type: "object" } },
			],
		});
		expect(client.state.tools).toEqual(["fill_form", "search"]);

		connection.close();
	});

	it("serves a tool declared after the registration", async () => {
		vi.useFakeTimers();
		const { http, live, connection } = connect();
		const client = connection.createToolClient("web");
		await flush();
		await client.ready;

		client.addTool("fill_form", fillForm);
		await flush();

		live.push(dispatch(1, "call-1", "fill_form", {}));
		await flush();

		expect(sent(http, "PUT", "/tools")).toHaveLength(1);
		expect(await body(sent(http, "POST", "/result")[0])).toEqual({ text: "filled" });

		connection.close();
	});

	it("sends the set a call changed, and waits for it, before it answers that call", async () => {
		vi.useFakeTimers();
		let update: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			update = resolve;
		});
		const { http, live, connection } = connect({
			"/tools": async () => {
				await held;
				return json({ seq: 0, type: "client_tools_updated", client_id: CLIENT_ID, tools: [] });
			},
		});
		const client = connection.createToolClient("web");
		client.addTool("open_form", {
			description: "Opens the form.",
			parameters: { type: "object" },
			execute: () => {
				client.addTool("fill_form", fillForm);
				return "the form is open";
			},
		});
		await flush();
		await client.ready;

		live.push(dispatch(1, "call-1", "open_form", {}));
		await flush();

		// The update the call made is still in flight, so the answer it would race is not out.
		expect(await body(sent(http, "PUT", "/tools")[0])).toMatchObject({
			tools: [{ name: "open_form" }, { name: "fill_form" }],
		});
		expect(sent(http, "POST", "/result")).toHaveLength(0);

		update?.();
		await flush();

		// The model's next turn hears about the call and can reach fill_form with it.
		expect(await body(sent(http, "POST", "/result")[0])).toEqual({ text: "the form is open" });
		expect(client.state.calls[0]?.phase).toBe("answered");

		connection.close();
	});

	it("swaps the handler behind a tool without telling the server", async () => {
		vi.useFakeTimers();
		const { http, live, connection } = connect();
		const client = connection.createToolClient("web");
		client.addTool("navigate", navigate);
		await flush();
		await client.ready;

		// The model was already offered exactly this; only the closure behind it moved.
		client.addTool("navigate", { ...navigate, execute: () => "at the new one" });
		await flush();
		expect(sent(http, "PUT", "/tools")).toHaveLength(0);

		live.push(dispatch(1, "call-1", "navigate", { to: "/contact" }));
		await flush();

		expect(await body(sent(http, "POST", "/result")[0])).toEqual({ text: "at the new one" });

		connection.close();
	});

	it("sends a set the server refused again on the next ping tick", async () => {
		vi.useFakeTimers();
		const failures: unknown[] = [];
		let updates = 0;
		const live = liveSse();
		const http = stubFetch(
			router(live, {
				"/tools": () => {
					updates += 1;
					return updates === 1
						? empty(500)
						: json({ seq: 0, type: "client_tools_updated", client_id: CLIENT_ID, tools: [] });
				},
			}),
		);
		const browser = testSessionClient({ fetch: http.fetch, maxRetries: 0 });
		const connection = browser.connect("s1");
		const client = connection.createToolClient("web", { onError: (error) => failures.push(error) });
		client.addTool("navigate", navigate);
		await flush();
		await client.ready;

		client.addTool("fill_form", fillForm);
		await flush();
		expect(sent(http, "PUT", "/tools")).toHaveLength(1);
		expect(failures).toHaveLength(1);

		// The server still holds the old set, so the tick that keeps the client alive sends the new one again.
		await vi.advanceTimersByTimeAsync(30_000);
		await flush();

		const sends = sent(http, "PUT", "/tools");
		expect(sends).toHaveLength(2);
		expect(await body(sends[1])).toMatchObject({ tools: [{ name: "navigate" }, { name: "fill_form" }] });
		expect(client.state.tools).toEqual(["navigate", "fill_form"]);

		// Once the server has it, later ticks owe it nothing.
		await vi.advanceTimersByTimeAsync(120_000);
		expect(sent(http, "PUT", "/tools")).toHaveLength(2);

		connection.close();
	});

	it("retries a refused set once under a lifetime that never lapses", async () => {
		vi.useFakeTimers();
		let updates = 0;
		const live = liveSse();
		const http = stubFetch(
			router(live, {
				"/tools": () => {
					updates += 1;
					return updates === 1
						? empty(500)
						: json({ seq: 0, type: "client_tools_updated", client_id: CLIENT_ID, tools: [] });
				},
			}),
		);
		const browser = testSessionClient({ fetch: http.fetch, maxRetries: 0 });
		const connection = browser.connect("s1");
		const client = connection.createToolClient("web", { lifetime: { type: "never" }, onError: () => undefined });
		client.addTool("navigate", navigate);
		await flush();
		await client.ready;

		client.addTool("fill_form", fillForm);
		await flush();
		expect(sent(http, "PUT", "/tools")).toHaveLength(1);

		// No ping tick to carry it, so the client keeps one timer of its own for the retry.
		await vi.advanceTimersByTimeAsync(30_000);
		await flush();

		expect(sent(http, "PUT", "/tools")).toHaveLength(2);
		expect(await body(sent(http, "PUT", "/tools")[1])).toMatchObject({
			tools: [{ name: "navigate" }, { name: "fill_form" }],
		});

		connection.close();
	});

	it("keeps a tool declared while the registration was in flight", async () => {
		vi.useFakeTimers();
		let register = (): void => undefined;
		const answered = new Promise<void>((resolve) => {
			register = resolve;
		});
		const { http, connection } = connect({
			"/clients": async (request) => {
				if (request.method !== "POST") {
					return empty(204);
				}
				await answered;
				return json({ id: CLIENT_ID, name: "web", expires_at: null }, 201);
			},
		});
		const client = connection.createToolClient("web");
		client.addTool("navigate", navigate);
		await flush();

		client.addTool("fill_form", fillForm);
		register();
		await client.ready;
		await flush();

		const updates = sent(http, "PUT", "/tools");
		expect(updates).toHaveLength(1);
		expect(await body(updates[0])).toMatchObject({
			tools: [{ name: "navigate" }, { name: "fill_form" }],
		});

		connection.close();
	});
});

describe.each(["delete", "close"] as const)("a call interrupted by %s", (ending) => {
	it.each(["ack", "parse", "schema"] as const)("never executes after waiting for %s", async (waiting) => {
		vi.useFakeTimers();
		let release = (): void => undefined;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { http, live, connection } = connect(
			waiting === "ack"
				? {
						"/ack": async () => {
							// Even a transport that finishes after cancellation must never start the tool.
							await pending;
							return json({ seq: 2, type: "client_tool_acked", client_id: CLIENT_ID, call_id: "call-1" });
						},
					}
				: {},
		);
		const onError = vi.fn();
		const client = connection.createToolClient("web", { lifetime: { type: "never" }, onError });
		const execute = vi.fn(() => "submitted");
		const parse = vi.fn(async () => {
			await pending;
			return {};
		});
		const spec = { description: "Submit the form.", parameters: { type: "object" }, execute };
		if (waiting === "schema") {
			client.addTool("submit", {
				...spec,
				schema: {
					"~standard": {
						version: 1,
						vendor: "test",
						validate: async () => ({ value: await parse() }),
					},
				},
			});
		} else {
			client.addTool("submit", { ...spec, ...(waiting === "parse" ? { parse } : {}) });
		}
		await client.ready;
		live.push(dispatch(1, "call-1", "submit", {}));
		await flush();
		expect(sent(http, "POST", "/ack")).toHaveLength(1);
		if (waiting !== "ack") expect(parse).toHaveBeenCalledOnce();

		if (ending === "delete") await connection.deleteToolClient(client);
		else connection.close();
		release();
		await flush();

		expect(execute).not.toHaveBeenCalled();
		expect(sent(http, "POST", "/result")).toHaveLength(0);
		expect(client.state.calls).toMatchObject([{ callId: "call-1", phase: "failed" }]);
		expect(onError).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		connection.close();
	});
});

describe("tool cancellation boundaries", () => {
	it("does not answer an old call after reconnecting the client", async () => {
		vi.useFakeTimers();
		const first = liveSse();
		const second = liveSse();
		let streams = 0;
		let release = (): void => undefined;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const http = stubFetch(
			router(first, {
				"/events/stream": () => (++streams === 1 ? first.response : second.response),
			}),
		);
		const connection = testSessionClient({ fetch: http.fetch }).connect("s1", { maxReconnects: 0 });
		const client = connection.createToolClient("web", { lifetime: { type: "never" } });
		const execute = vi.fn(async () => {
			await pending;
			return "finished";
		});
		client.addTool("wait", { description: "Wait.", parameters: { type: "object" }, execute });
		await client.ready;
		first.push(dispatch(1, "call-1", "wait", {}));
		await flush();
		expect(execute).toHaveBeenCalledOnce();
		first.close();
		await flush();
		expect(connection.state.status).toBe("failed");
		connection.reconnect();
		await connection.ready;
		await flush();
		expect(client.state.status).toBe("serving");
		release();
		await flush();
		expect(sent(http, "POST", "/result")).toHaveLength(0);
		expect(client.state.calls[0]?.phase).toBe("failed");
		connection.close();
	});

	it("aborts the ACK request when the client leaves", async () => {
		vi.useFakeTimers();
		const { http, live, connection } = connect({ "/ack": hang });
		const onError = vi.fn();
		const client = connection.createToolClient("web", { lifetime: { type: "never" }, onError });
		const execute = vi.fn(() => "submitted");
		client.addTool("submit", { description: "Submit.", parameters: { type: "object" }, execute });
		await client.ready;
		live.push(dispatch(1, "call-1", "submit", {}));
		await flush();
		await connection.deleteToolClient(client);
		await flush();
		expect(sent(http, "POST", "/ack")[0]?.signal.aborted).toBe(true);
		expect(execute).not.toHaveBeenCalled();
		expect(onError).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		connection.close();
	});

	it("does not execute if a running-state subscriber deletes the client", async () => {
		vi.useFakeTimers();
		const { live, connection } = connect();
		const client = connection.createToolClient("web");
		const execute = vi.fn(() => "submitted");
		client.addTool("submit", { description: "Submit.", parameters: { type: "object" }, execute });
		client.subscribe((state) => {
			if (state.calls.some((call) => call.phase === "running")) void connection.deleteToolClient(client);
		});
		await client.ready;
		live.push(dispatch(1, "call-1", "submit", {}));
		await flush();
		expect(execute).not.toHaveBeenCalled();
		connection.close();
	});

	it("answers a validation that outlived the deadline as an error without executing", async () => {
		vi.useFakeTimers();
		let release = (): void => undefined;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { http, live, connection } = connect();
		const client = connection.createToolClient("web", { lifetime: { type: "never" } });
		const execute = vi.fn(() => "submitted");
		client.addTool("submit", {
			description: "Submit.",
			parameters: { type: "object" },
			execute,
			parse: async () => {
				await pending;
				return {};
			},
		});
		await client.ready;
		live.push(dispatch(1, "call-1", "submit", {}));
		await vi.advanceTimersByTimeAsync(290_001);
		release();
		await flush();
		expect(execute).not.toHaveBeenCalled();
		expect(await body(sent(http, "POST", "/result")[0])).toMatchObject({ is_error: true });
		expect(client.state.calls[0]?.phase).toBe("answered");
		connection.close();
	});
});

/**
 * A Standard Schema written out by hand. The SDK speaks the protocol and depends on no
 * library that implements it, so its own tests implement it too; `@subako-ai/tools` drives
 * the same code with zod, which is where a real library's behavior is covered.
 */
function couponSchema(describesItself: boolean): StandardSchemaV1<unknown, { code: string }> {
	const validate = (value: unknown): StandardSchemaV1.Result<{ code: string }> => {
		const code = (value as Record<string, unknown> | null)?.["code"];
		return typeof code === "string" && code !== ""
			? { value: { code } }
			: { issues: [{ message: "a coupon code is a non-empty string", path: ["code"] }] };
	};
	const props = { version: 1, vendor: "handwritten", validate } as const;
	if (!describesItself) {
		return { "~standard": props };
	}
	const converter = {
		input: () => ({ type: "object", properties: { code: { type: "string" } }, required: ["code"] }),
		output: () => ({ type: "object" }),
	};
	const described: StandardSchemaV1<unknown, { code: string }> & StandardJSONSchemaV1<unknown, { code: string }> = {
		"~standard": { ...props, jsonSchema: converter },
	};
	return described;
}

describe("a tool declared with a schema", () => {
	it("offers the schema's own JSON Schema as the tool's parameters", async () => {
		vi.useFakeTimers();
		const { http, connection } = connect();
		const client = connection.createToolClient("web");

		client.addTool("apply_coupon", {
			description: "Apply a coupon.",
			schema: couponSchema(true),
			execute: ({ code }) => `applied ${code}`,
		});
		await flush();
		await client.ready;

		expect(await body(http.calls[1])).toMatchObject({
			tools: [
				{
					name: "apply_coupon",
					description: "Apply a coupon.",
					parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
				},
			],
		});

		connection.close();
	});

	it("hands the handler what the schema read, not the arguments as they came", async () => {
		vi.useFakeTimers();
		const { http, live, connection } = connect();
		const client = connection.createToolClient("web");

		client.addTool("apply_coupon", {
			description: "Apply a coupon.",
			schema: couponSchema(true),
			execute: (args) => JSON.stringify(args),
		});
		await flush();
		await client.ready;

		live.push(dispatch(1, "call-1", "apply_coupon", { code: "SPRING", note: "ignored" }));
		await flush();

		expect(await body(sent(http, "POST", "/result")[0])).toEqual({ text: '{"code":"SPRING"}' });

		connection.close();
	});

	it("answers with the schema's own reason, and never runs the handler, when the arguments are refused", async () => {
		vi.useFakeTimers();
		const { http, live, connection } = connect();
		const client = connection.createToolClient("web");
		let ran = false;

		client.addTool("apply_coupon", {
			description: "Apply a coupon.",
			schema: couponSchema(true),
			execute: () => {
				ran = true;
				return "applied";
			},
		});
		await flush();
		await client.ready;

		live.push(dispatch(1, "call-1", "apply_coupon", { code: "" }));
		await flush();

		const answer = (await body(sent(http, "POST", "/result")[0])) as { text: string; is_error: boolean };
		expect(answer.is_error).toBe(true);
		expect(answer.text).toContain("code: a coupon code is a non-empty string");
		expect(ran).toBe(false);

		connection.close();
	});

	it("refuses a schema that cannot say what it takes, unless the parameters are beside it", async () => {
		const { connection } = connect();
		const client = connection.createToolClient("web");
		const opaque = {
			description: "Apply a coupon.",
			schema: couponSchema(false),
			execute: ({ code }: { code: string }) => `applied ${code}`,
		};

		// The model is offered the parameters, not the schema, so a schema that cannot be
		// written as one is only half a declaration.
		expect(() => client.addTool("apply_coupon", opaque)).toThrow(/parameters/);

		client.addTool("apply_coupon", { ...opaque, parameters: { type: "object" } });
		expect(client.state.tools).toEqual(["apply_coupon"]);

		connection.close();
	});
});
