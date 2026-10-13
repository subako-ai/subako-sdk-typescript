import { describe, expect, it } from "vitest";
import { json, stubFetch, testClient } from "./support.js";

const bytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
const version = { id: "fv1", function_id: "fn1", version: 1 };

const page = (ids: readonly string[], next: string | null): Response =>
	json({ items: ids.map((id) => ({ id })), next_cursor: next, prev_cursor: null });

const streamOf = (chunk: Uint8Array): ReadableStream<Uint8Array> =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(chunk);
			controller.close();
		},
	});

describe("function archives", () => {
	it("sends a Uint8Array as gzip with an idempotency key", async () => {
		const http = stubFetch(() => json(version, 201));
		const client = testClient({ fetch: http.fetch });

		await expect(client.functions.create(bytes)).resolves.toEqual(version);

		const request = http.calls[0]!;
		expect(request.method).toBe("POST");
		expect(request.url).toBe("https://api.test/v1/functions");
		expect(request.headers.get("content-type")).toBe("application/gzip");
		expect(request.headers.get("idempotency-key")).toBeTruthy();
		await expect(request.arrayBuffer().then((buffer) => new Uint8Array(buffer))).resolves.toEqual(bytes);
	});

	it("sends a Blob when pushing a version", async () => {
		const http = stubFetch(() => json(version, 201));
		const client = testClient({ fetch: http.fetch });

		await client.functions.pushVersion("fn1", new Blob([bytes]));

		const request = http.calls[0]!;
		expect(request.url).toBe("https://api.test/v1/functions/fn1/versions");
		expect(request.headers.get("content-type")).toBe("application/gzip");
		expect(request.headers.get("idempotency-key")).toBeTruthy();
		await expect(request.arrayBuffer().then((buffer) => new Uint8Array(buffer))).resolves.toEqual(bytes);
	});

	it("sends a ReadableStream", async () => {
		const http = stubFetch(() => json(version, 201));
		const client = testClient({ fetch: http.fetch });

		await client.functions.create(streamOf(bytes));

		const request = http.calls[0]!;
		expect(request.headers.get("content-type")).toBe("application/gzip");
		await expect(request.arrayBuffer().then((buffer) => new Uint8Array(buffer))).resolves.toEqual(bytes);
	});
});

describe("function requests", () => {
	it("reads, renames and deletes by id", async () => {
		const http = stubFetch(
			() => json({ id: "fn1" }),
			() => json({ id: "fn1" }),
			() => new Response(null, { status: 204 }),
		);
		const client = testClient({ fetch: http.fetch });

		await client.functions.get("fn1");
		await client.functions.rename("fn1", { display_name: "CSV tools" });
		await client.functions.delete("fn1");

		expect(http.calls.map((call) => [call.method, call.url])).toEqual([
			["GET", "https://api.test/v1/functions/fn1"],
			["PATCH", "https://api.test/v1/functions/fn1"],
			["DELETE", "https://api.test/v1/functions/fn1"],
		]);
		expect(await http.calls[1]!.json()).toEqual({ display_name: "CSV tools" });
	});

	it("reads one version by its number", async () => {
		const http = stubFetch(() => json(version));
		const client = testClient({ fetch: http.fetch });

		await expect(client.functions.getVersion("fn1", 3)).resolves.toEqual(version);

		expect(http.calls[0]!.url).toBe("https://api.test/v1/functions/fn1/versions/3");
	});

	it("lists the platform packages", async () => {
		const listing = {
			packages: [{ name: "files", description: "Read and edit files", functions: [] }],
		};
		const http = stubFetch(() => json(listing));
		const client = testClient({ fetch: http.fetch });

		await expect(client.functions.platform()).resolves.toEqual(listing);

		expect(http.calls.map((call) => [call.method, call.url])).toEqual([
			["GET", "https://api.test/v1/functions/platform"],
		]);
	});
});

describe("function paging", () => {
	it("walks the packages, carrying the query", async () => {
		const http = stubFetch(
			() => page(["f1", "f2"], "f2"),
			() => page(["f3"], null),
		);
		const client = testClient({ fetch: http.fetch });

		const seen: string[] = [];
		for await (const fn of await client.functions.list({ limit: 2, order: "asc" })) {
			seen.push(fn.id);
		}

		expect(seen).toEqual(["f1", "f2", "f3"]);
		const second = new URL(http.calls[1]!.url);
		expect(second.pathname).toBe("/v1/functions");
		expect(second.searchParams.get("after")).toBe("f2");
		expect(second.searchParams.get("limit")).toBe("2");
		expect(second.searchParams.get("order")).toBe("asc");
	});

	it("walks a package's versions", async () => {
		const http = stubFetch(
			() => page(["v2"], "v2"),
			() => page(["v1"], null),
		);
		const client = testClient({ fetch: http.fetch });

		const seen: string[] = [];
		for await (const item of await client.functions.listVersions("fn1", { limit: 1 })) {
			seen.push(item.id);
		}

		expect(seen).toEqual(["v2", "v1"]);
		const second = new URL(http.calls[1]!.url);
		expect(second.pathname).toBe("/v1/functions/fn1/versions");
		expect(second.searchParams.get("after")).toBe("v2");
	});
});
