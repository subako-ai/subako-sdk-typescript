import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ClientOutdatedError,
	ConflictError,
	ForbiddenError,
	InternalError,
	InvalidRequestError,
	NotFoundError,
	SubakoConnectionError,
	SubakoError,
	SubakoTimeoutError,
	UnauthorizedError,
} from "../src/index.js";
import { empty, hang, json, stubFetch, testClient, text } from "./support.js";

const envelope = (code: string, message: string, status: number): Response =>
	json({ error: { code, message } }, status);

afterEach(() => {
	vi.useRealTimers();
});

describe("error codes", () => {
	it.each([
		["unauthorized", 401, UnauthorizedError],
		["forbidden", 403, ForbiddenError],
		["not_found", 404, NotFoundError],
		["invalid_request", 400, InvalidRequestError],
		["conflict", 409, ConflictError],
		["client_outdated", 400, ClientOutdatedError],
		["internal", 500, InternalError],
	])("maps %s onto its class", async (code, status, expected) => {
		const http = stubFetch(() => envelope(code, `${code} happened`, status));
		const client = testClient({ fetch: http.fetch, maxRetries: 0 });

		const error = await client.agents.get("a1").catch((thrown: unknown) => thrown);

		expect(error).toBeInstanceOf(expected);
		expect(error).toBeInstanceOf(SubakoError);
		expect((error as SubakoError).status).toBe(status);
		expect((error as SubakoError).code).toBe(code);
		expect((error as SubakoError).message).toBe(`${code} happened`);
		expect((error as SubakoError).body).toEqual({ error: { code, message: `${code} happened` } });
	});

	it("keeps a code it does not know", async () => {
		const http = stubFetch(() => envelope("quota_exceeded", "too much", 429));
		const client = testClient({ fetch: http.fetch, maxRetries: 0 });

		const error = await client.agents.get("a1").catch((thrown: unknown) => thrown);

		expect(error).toBeInstanceOf(SubakoError);
		expect((error as SubakoError).constructor).toBe(SubakoError);
		expect((error as SubakoError).code).toBe("quota_exceeded");
		expect((error as SubakoError).message).toBe("too much");
	});
});

describe("bodies that are not envelopes", () => {
	it("keep the text as the message and leave the code null", async () => {
		const http = stubFetch(() => text("<html>gateway</html>", 502, "text/html"));
		const client = testClient({ fetch: http.fetch, maxRetries: 0 });

		const error = await client.agents.get("a1").catch((thrown: unknown) => thrown);

		expect((error as SubakoError).code).toBeNull();
		expect((error as SubakoError).status).toBe(502);
		expect((error as SubakoError).message).toBe("<html>gateway</html>");
	});

	it("fall back to the status when the body is empty", async () => {
		const http = stubFetch(() => empty(503));
		const client = testClient({ fetch: http.fetch, maxRetries: 0 });

		const error = await client.agents.get("a1").catch((thrown: unknown) => thrown);

		expect((error as SubakoError).message).toBe("HTTP 503");
		expect((error as SubakoError).code).toBeNull();
	});
});

describe("failures without a response", () => {
	it("report a connection error", async () => {
		const http = stubFetch(() => {
			throw new TypeError("fetch failed");
		});
		const client = testClient({ fetch: http.fetch, maxRetries: 0 });

		const error = await client.agents.get("a1").catch((thrown: unknown) => thrown);

		expect(error).toBeInstanceOf(SubakoConnectionError);
		expect((error as SubakoError).status).toBeUndefined();
		expect((error as SubakoError).code).toBeNull();
		expect((error as Error).message).toContain("fetch failed");
	});

	it("report a timeout once the attempt outlives it", async () => {
		vi.useFakeTimers();
		const http = stubFetch(hang);
		const client = testClient({ fetch: http.fetch, maxRetries: 0, timeout: 1000 });

		const call = client.agents.get("a1");
		const settled = call.catch((thrown: unknown) => thrown);
		await vi.advanceTimersByTimeAsync(1000);

		const error = await settled;
		expect(error).toBeInstanceOf(SubakoTimeoutError);
		expect(error).toBeInstanceOf(SubakoConnectionError);
		expect((error as Error).message).toBe("request timed out after 1000ms");
	});

	it("rethrow the caller's own abort untouched", async () => {
		const http = stubFetch(hang);
		const client = testClient({ fetch: http.fetch });
		const controller = new AbortController();
		const reason = new Error("caller changed their mind");

		const settled = client.agents.get("a1", { signal: controller.signal }).catch((thrown: unknown) => thrown);
		controller.abort(reason);

		await expect(settled).resolves.toBe(reason);
	});
});
