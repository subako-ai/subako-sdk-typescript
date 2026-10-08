import { describe, expect, it } from "vitest";
import {
	type ClientOptions,
	SubakoClient,
	type SubakoClientOptions,
	SubakoSessionClient,
	VERSION,
} from "../src/index.js";
import { json, stubFetch, testClient } from "./support.js";

const agent = { id: "a1", name: "triage", workspace_id: "w1", created_at: "2026-01-01T00:00:00Z" };

describe("construction", () => {
	it("refuses no credential", () => {
		// @ts-expect-error one credential is required
		expect(() => new SubakoClient({})).toThrow(TypeError);
	});

	it("refuses two credentials", () => {
		// @ts-expect-error the credentials are mutually exclusive
		expect(() => new SubakoClient({ apiKey: "k", accessToken: "t" })).toThrow(TypeError);
	});

	it("refuses an external credential alongside one of its own", () => {
		// @ts-expect-error an external credential excludes apiKey and accessToken
		expect(() => new SubakoClient({ credential: "external", accessToken: "t" })).toThrow(TypeError);
	});

	it("refuses a session token, which reaches only one session", () => {
		expect(
			// @ts-expect-error a session token belongs to SubakoSessionClient
			() => new SubakoClient({ baseUrl: "https://api.test", sessionToken: "sbk_st_1" }),
		).toThrow(TypeError);
	});
});

describe.each([
	{
		name: "SubakoClient with an API key",
		make: (options: ClientOptions) => new SubakoClient({ apiKey: "k", ...options }).sessions,
		token: "k",
	},
	{
		name: "SubakoClient with an access token",
		make: (options: ClientOptions) => new SubakoClient({ accessToken: "t", ...options }).sessions,
		token: "t",
	},
	{
		name: "SubakoSessionClient",
		make: (options: ClientOptions) => new SubakoSessionClient({ getToken: (id) => `token-${id}`, ...options }),
		token: "token-s1",
	},
])("$name endpoint", ({ make, token }) => {
	it.each([{}, { baseUrl: undefined }])("uses Subako Cloud for %j", async (options) => {
		const http = stubFetch(() => json({ id: "s1", status: "idle" }));
		const client = make({ ...options, fetch: http.fetch });

		await expect(client.get("s1")).resolves.toMatchObject({ id: "s1" });

		expect(http.calls).toHaveLength(1);
		expect(http.calls[0]?.url).toBe("https://api.us.cloud.subako.ai/v1/sessions/s1");
		expect(http.calls[0]?.headers.get("authorization")).toBe(`Bearer ${token}`);
	});

	it.each(["http://localhost:8080", "https://custom.example.test/subako"])(
		"uses the explicit endpoint %s",
		async (baseUrl) => {
			const http = stubFetch(() => json({ id: "s1", status: "idle" }));
			const client = make({ baseUrl, fetch: http.fetch });

			await client.get("s1");

			expect(http.calls).toHaveLength(1);
			expect(http.calls[0]?.url).toBe(`${baseUrl}/v1/sessions/s1`);
			expect(http.calls[0]?.headers.get("authorization")).toBe(`Bearer ${token}`);
		},
	);

	it.each(["", null, 42])("rejects an explicitly invalid endpoint %j", (baseUrl) => {
		expect(() => make({ baseUrl: baseUrl as string })).toThrow("baseUrl must be a non-empty string");
	});
});

describe("the session routes", () => {
	it("are reached with an api key like any other", async () => {
		const http = stubFetch(() => json({ id: "s1", status: "idle" }));
		const client = testClient({ fetch: http.fetch, apiKey: "sbk_ak_1" });

		await expect(client.sessions.get("s1")).resolves.toMatchObject({ id: "s1" });

		expect(http.calls[0]?.headers.get("authorization")).toBe("Bearer sbk_ak_1");
		expect(http.calls[0]?.url).toBe("https://api.test/v1/sessions/s1");
	});

	it("share the client's one token with the workspace routes", async () => {
		const http = stubFetch(() => json({ items: [], next_cursor: null }));
		const client = testClient({ fetch: http.fetch, apiKey: "sbk_ak_1" });

		await client.sessions.listEvents("s1");
		await client.sessions.listEvents("s2");
		await client.agents.list();

		expect(http.calls.map((call) => call.headers.get("authorization"))).toEqual([
			"Bearer sbk_ak_1",
			"Bearer sbk_ak_1",
			"Bearer sbk_ak_1",
		]);
	});
});

/** The Authorization header one credential produces. */
async function authorization(credential: Partial<SubakoClientOptions>): Promise<string | null> {
	const http = stubFetch(() => json(agent));
	const client = new SubakoClient({
		baseUrl: "https://api.test",
		fetch: http.fetch,
		...credential,
	} as SubakoClientOptions);

	await client.agents.get("a1");

	return http.calls[0]?.headers.get("authorization") ?? null;
}

describe("authorization", () => {
	it("sends an api key as a bearer token", async () => {
		await expect(authorization({ apiKey: "sbk_ak_1" })).resolves.toBe("Bearer sbk_ak_1");
	});

	it("sends an access token as a bearer token", async () => {
		await expect(authorization({ accessToken: "sbk_at_1" })).resolves.toBe("Bearer sbk_at_1");
	});

	it("sends the token a function answered with", async () => {
		const http = stubFetch(() => json(agent));
		const client = testClient({ fetch: http.fetch, apiKey: () => "sbk_ak_1" });

		await client.agents.get("a1");

		expect(http.calls[0]?.headers.get("authorization")).toBe("Bearer sbk_ak_1");
	});
});

describe("headers", () => {
	it("sends the SDK's user agent and merges the client's own headers", async () => {
		const http = stubFetch(() => json(agent));
		const client = testClient({ fetch: http.fetch, headers: { "X-Trace": "t1" } });

		await client.agents.get("a1");

		expect(http.calls[0]?.headers.get("subako-user-agent")).toBe(`subako-sdk-js/${VERSION}`);
		expect(http.calls[0]?.headers.get("x-trace")).toBe("t1");
	});

	it("merges per-call headers over the client's", async () => {
		const http = stubFetch(() => json(agent));
		const client = testClient({ fetch: http.fetch, headers: { "X-Trace": "t1" } });

		await client.agents.get("a1", { headers: { "X-Trace": "t2" } });

		expect(http.calls[0]?.headers.get("x-trace")).toBe("t2");
	});
});

describe("workspace", () => {
	it("sends the client's workspace on every request", async () => {
		const http = stubFetch(() => json(agent));
		const client = testClient({ fetch: http.fetch, workspaceId: "w1" });

		await client.agents.get("a1");

		expect(http.calls[0]?.headers.get("kikuvi-workspace")).toBe("w1");
	});

	it("lets a call name another workspace", async () => {
		const http = stubFetch(() => json(agent));
		const client = testClient({ fetch: http.fetch, workspaceId: "w1" });

		await client.agents.get("a1", { workspaceId: "w2" });

		expect(http.calls[0]?.headers.get("kikuvi-workspace")).toBe("w2");
	});

	it("sends no workspace header when none is configured", async () => {
		const http = stubFetch(() => json(agent));
		const client = testClient({ fetch: http.fetch });

		await client.agents.get("a1");

		expect(http.calls[0]?.headers.has("kikuvi-workspace")).toBe(false);
	});
});

describe("an empty credential", () => {
	it("is refused by the constructor", () => {
		expect(() => new SubakoClient({ baseUrl: "https://api.test", apiKey: "" })).toThrow(TypeError);
	});

	it("is refused when a token function answers with one", async () => {
		const http = stubFetch(() => json({ id: "a1" }));
		const client = testClient({ fetch: http.fetch, apiKey: () => "" });

		await expect(client.agents.get("a1")).rejects.toThrow(TypeError);
		expect(http.calls).toHaveLength(0);
	});
});
