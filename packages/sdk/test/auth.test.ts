import { afterEach, describe, expect, it, vi } from "vitest";
import { SubakoClient, SubakoSessionClient, UnauthorizedError } from "../src/index.js";
import { json, sse, stubFetch, testClient, testSessionClient, userEvent } from "./support.js";

afterEach(() => {
	vi.useRealTimers();
});

const agent = { id: "a1", name: "triage", workspace_id: "w1", created_at: "2026-01-01T00:00:00Z" };
const posted = { seq: 7 };
const expired = (): Response => json({ error: { code: "unauthorized", message: "token expired" } }, 401);

/** A credential that hands out a new token every time it is called, and counts the calls. */
function minting(): { readonly token: () => Promise<string>; readonly minted: () => number } {
	let minted = 0;
	return {
		token: async () => {
			minted += 1;
			return await Promise.resolve(`sbk_ak_${minted}`);
		},
		minted: () => minted,
	};
}

const authorizations = (calls: readonly Request[]): (string | null)[] =>
	calls.map((call) => call.headers.get("authorization"));

describe("a token function", () => {
	it("is called once for a run of requests, and the token is reused", async () => {
		vi.useFakeTimers();
		const http = stubFetch(() => json(agent));
		const credential = minting();
		const client = testClient({ fetch: http.fetch, apiKey: credential.token });

		await client.agents.get("a1");
		await client.agents.get("a1");
		await client.agents.get("a1");

		expect(credential.minted()).toBe(1);
		expect(authorizations(http.calls)).toEqual(["Bearer sbk_ak_1", "Bearer sbk_ak_1", "Bearer sbk_ak_1"]);
	});

	it("is called once for requests that start together", async () => {
		vi.useFakeTimers();
		const http = stubFetch(() => json(agent));
		const credential = minting();
		const client = testClient({ fetch: http.fetch, apiKey: credential.token });

		await Promise.all([client.agents.get("a1"), client.agents.get("a2"), client.agents.get("a3")]);

		expect(credential.minted()).toBe(1);
		expect(authorizations(http.calls)).toEqual(["Bearer sbk_ak_1", "Bearer sbk_ak_1", "Bearer sbk_ak_1"]);
	});

	it("is called again after a 401, and the request goes once more with the fresh token", async () => {
		vi.useFakeTimers();
		const http = stubFetch(expired, () => json(agent));
		const credential = minting();
		const client = testClient({ fetch: http.fetch, apiKey: credential.token });

		await expect(client.agents.get("a1")).resolves.toMatchObject({ id: "a1" });

		expect(credential.minted()).toBe(2);
		expect(authorizations(http.calls)).toEqual(["Bearer sbk_ak_1", "Bearer sbk_ak_2"]);
	});

	it("keeps the idempotency key of the attempt the 401 refused", async () => {
		vi.useFakeTimers();
		const http = stubFetch(expired, () => json(posted));
		const credential = minting();
		const client = testClient({ fetch: http.fetch, apiKey: credential.token });

		await client.sessions.postEvent("s1", { type: "input", text: "hello" });

		const keys = http.calls.map((call) => call.headers.get("idempotency-key"));
		expect(keys[0]).toEqual(expect.any(String));
		expect(keys[1]).toBe(keys[0]);
		expect(authorizations(http.calls)).toEqual(["Bearer sbk_ak_1", "Bearer sbk_ak_2"]);
	});

	it("gives up when the fresh token is refused too", async () => {
		vi.useFakeTimers();
		const http = stubFetch(expired);
		const credential = minting();
		const client = testClient({ fetch: http.fetch, apiKey: credential.token });

		await expect(client.agents.get("a1")).rejects.toBeInstanceOf(UnauthorizedError);

		expect(credential.minted()).toBe(2);
		expect(http.calls).toHaveLength(2);
	});

	it("surfaces its own failure, and is called again by the next request", async () => {
		vi.useFakeTimers();
		const http = stubFetch(() => json(agent));
		let calls = 0;
		const client = testClient({
			fetch: http.fetch,
			apiKey: () => {
				calls += 1;
				throw new RangeError("the backend has no session token yet");
			},
		});

		await expect(client.agents.get("a1")).rejects.toThrow(RangeError);
		await expect(client.agents.get("a1")).rejects.toThrow("the backend has no session token yet");

		expect(calls).toBe(2);
		expect(http.calls).toHaveLength(0);
	});
});

describe("a string credential", () => {
	it("throws on a 401 without trying again", async () => {
		vi.useFakeTimers();
		const http = stubFetch(expired);
		const client = testClient({ fetch: http.fetch, apiKey: "sbk_ak_static" });

		await expect(client.agents.get("a1")).rejects.toBeInstanceOf(UnauthorizedError);

		expect(http.calls).toHaveLength(1);
	});
});

describe("the event stream", () => {
	it("refreshes the token a 401 refused and opens again", async () => {
		vi.useFakeTimers();
		const http = stubFetch(expired, () => sse([userEvent(1)]));
		const credential = minting();
		const client = testClient({ fetch: http.fetch, apiKey: credential.token });
		const connection = client.sessions.connect("s1");

		await connection.ready;

		expect(credential.minted()).toBe(2);
		expect(authorizations(http.calls)).toEqual(["Bearer sbk_ak_1", "Bearer sbk_ak_2"]);
		expect(connection.state.status).toBe("open");

		connection.close();
	});

	it("fails the connection when the fresh token is refused too", async () => {
		vi.useFakeTimers();
		const http = stubFetch(expired);
		const credential = minting();
		const client = testClient({ fetch: http.fetch, apiKey: credential.token });
		const connection = client.sessions.connect("s1");

		await expect(connection.ready).rejects.toBeInstanceOf(UnauthorizedError);

		expect(credential.minted()).toBe(2);
		expect(http.calls).toHaveLength(2);
		expect(connection.state.status).toBe("failed");
	});
});

/** A `getToken` that hands out a new token per call, and records who it was asked for. */
function minter(): {
	readonly getToken: (sessionId: string) => Promise<string>;
	readonly asked: () => readonly string[];
} {
	const asked: string[] = [];
	return {
		getToken: async (sessionId) => {
			asked.push(sessionId);
			return await Promise.resolve(`sbk_st_${sessionId}_${asked.filter((id) => id === sessionId).length}`);
		},
		asked: () => asked,
	};
}

describe("a session client", () => {
	it("takes a getToken", () => {
		// @ts-expect-error getToken is required
		expect(() => new SubakoSessionClient({ baseUrl: "https://api.test" })).toThrow(TypeError);
	});

	it("refuses a request that names no session, which no method of its own can make", async () => {
		const http = stubFetch(() => json({ id: "s" }));
		const browser = testSessionClient({ fetch: http.fetch });

		await expect(browser.get("")).rejects.toThrow(TypeError);
		expect(http.calls).toHaveLength(0);
	});

	it("asks for one session's token once, and every request under it carries that one", async () => {
		vi.useFakeTimers();
		const http = stubFetch(() => json({ id: "s1", items: [], next_cursor: null }));
		const tokens = minter();
		const browser = testSessionClient({ fetch: http.fetch, getToken: tokens.getToken });

		await browser.get("s1");
		await browser.get("s1");
		await browser.listEvents("s1");

		expect(tokens.asked()).toEqual(["s1"]);
		expect(authorizations(http.calls)).toEqual(["Bearer sbk_st_s1_1", "Bearer sbk_st_s1_1", "Bearer sbk_st_s1_1"]);
	});

	it("asks once per session for requests that start together", async () => {
		vi.useFakeTimers();
		const http = stubFetch(() => json({ id: "s" }));
		const tokens = minter();
		const browser = testSessionClient({ fetch: http.fetch, getToken: tokens.getToken });

		await Promise.all([browser.get("s1"), browser.get("s1"), browser.get("s2")]);

		expect(tokens.asked()).toEqual(["s1", "s2"]);
	});

	it("carries a token per session, and the tokens never cross", async () => {
		vi.useFakeTimers();
		const http = stubFetch(() => json({ id: "s" }));
		const tokens = minter();
		const browser = testSessionClient({ fetch: http.fetch, getToken: tokens.getToken });

		await browser.get("s1");
		await browser.get("s2");

		expect(tokens.asked()).toEqual(["s1", "s2"]);
		expect(authorizations(http.calls)).toEqual(["Bearer sbk_st_s1_1", "Bearer sbk_st_s2_1"]);
	});

	it("refreshes only the session whose token a 401 refused", async () => {
		vi.useFakeTimers();
		const refuse = new Set(["sbk_st_s2_1"]);
		const http = stubFetch((request) =>
			refuse.has(request.headers.get("authorization")?.slice("Bearer ".length) ?? "") ? expired() : json({ id: "s" }),
		);
		const tokens = minter();
		const browser = testSessionClient({ fetch: http.fetch, getToken: tokens.getToken });

		await browser.get("s1");
		await browser.get("s2");
		await browser.get("s1");
		await browser.get("s2");

		// s2 was asked twice, s1 only once, and s1 kept the token it already had.
		expect(tokens.asked()).toEqual(["s1", "s2", "s2"]);
		expect(authorizations(http.calls)).toEqual([
			"Bearer sbk_st_s1_1",
			"Bearer sbk_st_s2_1",
			"Bearer sbk_st_s2_2",
			"Bearer sbk_st_s1_1",
			"Bearer sbk_st_s2_2",
		]);
	});

	it("opens the event stream with the session's own token", async () => {
		vi.useFakeTimers();
		const http = stubFetch(() => sse([userEvent(1)]));
		const browser = testSessionClient({ fetch: http.fetch });
		const connection = browser.connect("s7");

		await connection.ready;

		expect(authorizations(http.calls)).toEqual(["Bearer sbk_st_s7"]);
		expect(http.calls[0]?.url).toBe("https://api.test/v1/sessions/s7/events/stream");

		connection.close();
	});

	it("registers a client with the session's own token", async () => {
		vi.useFakeTimers();
		const http = stubFetch(() => json({ client_id: "c1", name: "web", tools: [] }));
		const browser = testSessionClient({ fetch: http.fetch });

		await browser.registerClient("s7", { name: "web", lifetime: { type: "never" }, tools: [] });

		expect(authorizations(http.calls)).toEqual(["Bearer sbk_st_s7"]);
		expect(http.calls[0]?.url).toBe("https://api.test/v1/sessions/s7/clients");
	});
});

describe("an external credential", () => {
	const externalClient = (fetch: typeof globalThis.fetch): SubakoClient =>
		new SubakoClient({ baseUrl: "https://console.test/api/core", credential: "external", fetch, maxRetries: 0 });

	it("sends no Authorization header, for whatever holds the credential to attach it", async () => {
		const http = stubFetch(() => json(agent));
		const client = externalClient(http.fetch);

		await client.agents.get("a1");

		expect(authorizations(http.calls)).toEqual([null]);
		expect(http.calls[0]?.url).toBe("https://console.test/api/core/v1/agents/a1");
	});

	it("answers a 401 with UnauthorizedError and does not resend, since the SDK holds nothing to refresh", async () => {
		const http = stubFetch(expired, () => json(agent));
		const client = externalClient(http.fetch);

		await expect(client.agents.get("a1")).rejects.toBeInstanceOf(UnauthorizedError);

		expect(http.calls).toHaveLength(1);
	});
});
