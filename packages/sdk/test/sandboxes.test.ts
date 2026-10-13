import { describe, expect, it } from "vitest";
import { empty, json, stubFetch, testClient, testSessionClient } from "./support.js";

describe("the sandbox listing", () => {
	it("reads the session's sandboxes", async () => {
		const sandbox = { name: "build", status: "running" };
		const http = stubFetch(() => json({ items: [sandbox] }));
		const client = testClient({ fetch: http.fetch });

		const list = await client.sessions.listSandboxes("s1");

		expect(http.calls[0]?.url).toBe("https://api.test/v1/sessions/s1/sandboxes");
		expect(http.calls[0]?.method).toBe("GET");
		expect(list.items).toEqual([sandbox]);
	});

	// A grant list is bounded, so the whole set travels at once: no query goes out
	// and no cursor comes back. `Page` would promise a call that cannot be made.
	it("takes no query, and carries no cursor", async () => {
		const http = stubFetch(() => json({ items: [] }));
		const client = testClient({ fetch: http.fetch });

		const list = await client.sessions.listSandboxes("s1");

		expect(new URL(http.calls[0]!.url).search).toBe("");
		expect(list).toEqual({ items: [] });
	});
});

describe("a sandbox archive", () => {
	it("reads where to fetch it, its size, and when the url lapses", async () => {
		const archive = { url: "https://store.test/a.tar.zst", bytes: 4096, expires_at: "2026-01-01T00:00:00Z" };
		const http = stubFetch(() => json(archive));
		const client = testClient({ fetch: http.fetch });

		await expect(client.sessions.getSandboxArchive("s1", "build")).resolves.toEqual(archive);

		expect(http.calls[0]?.url).toBe("https://api.test/v1/sessions/s1/sandboxes/build/archive");
		expect(http.calls[0]?.method).toBe("GET");
	});

	it("is deleted by name, and answers with no body", async () => {
		const http = stubFetch(() => empty(204));
		const client = testClient({ fetch: http.fetch });

		await client.sessions.deleteSandboxArchive("s1", "build");

		expect(http.calls[0]?.url).toBe("https://api.test/v1/sessions/s1/sandboxes/build/archive");
		expect(http.calls[0]?.method).toBe("DELETE");
	});

	it("escapes a name that carries a slash", async () => {
		const http = stubFetch(() => empty(204));
		const client = testClient({ fetch: http.fetch });

		await client.sessions.deleteSandboxArchive("s1", "a/b");

		expect(http.calls[0]?.url).toBe("https://api.test/v1/sessions/s1/sandboxes/a%2Fb/archive");
	});
});

describe("a session token", () => {
	it("reaches the sandbox routes, which sit on the half both clients bind", async () => {
		const http = stubFetch(() => json({ items: [] }));
		const browser = testSessionClient({ fetch: http.fetch, getToken: () => "sbk_st_s1" });

		await browser.listSandboxes("s1");

		expect(http.calls[0]?.url).toBe("https://api.test/v1/sessions/s1/sandboxes");
		expect(http.calls[0]?.headers.get("authorization")).toBe("Bearer sbk_st_s1");
	});
});

describe("the session volume", () => {
	const written = { path: "/tmp/a b/c.txt", bytes: 2 };

	it("writes to the path with each segment encoded once", async () => {
		const http = stubFetch(() => json(written));
		const client = testClient({ fetch: http.fetch });

		await expect(client.sessions.writeVolumeFile("s1", "/tmp/a b/c.txt", "hi")).resolves.toEqual(written);

		const request = http.calls[0]!;
		expect(request.method).toBe("PUT");
		expect(new URL(request.url).pathname).toBe("/v1/sessions/s1/volume/files/tmp%2Fa%20b%2Fc.txt");
		expect(await request.text()).toBe("hi");
	});

	it("sends bytes as they are", async () => {
		const http = stubFetch(() => json(written));
		const client = testClient({ fetch: http.fetch });

		await client.sessions.writeVolumeFile("s1", "/tmp/a.bin", new Uint8Array([1, 2, 3]));

		expect(new Uint8Array(await http.calls[0]!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("reads a file as a blob whatever content type it is labelled with", async () => {
		const http = stubFetch(() => new Response("{}", { headers: { "content-type": "application/json" } }));
		const client = testClient({ fetch: http.fetch });

		const blob = await client.sessions.readVolumeFile("s1", "/tmp/a.json");

		expect(blob).toBeInstanceOf(Blob);
		expect(await blob.text()).toBe("{}");
		expect(new URL(http.calls[0]!.url).pathname).toBe("/v1/sessions/s1/volume/files/tmp%2Fa.json");
	});

	it("lists beneath a prefix", async () => {
		const http = stubFetch(() => json({ items: [] }));
		const client = testClient({ fetch: http.fetch });

		await client.sessions.listVolumeFiles("s1", { prefix: "/tmp/x" });
		await client.sessions.listVolumeFiles("s1");

		expect(new URL(http.calls[0]!.url).searchParams.get("prefix")).toBe("/tmp/x");
		expect(new URL(http.calls[1]!.url).search).toBe("");
	});

	it("deletes one file, or the whole volume", async () => {
		const http = stubFetch(() => empty(204));
		const client = testClient({ fetch: http.fetch });

		await expect(client.sessions.deleteVolumeFile("s1", "/tmp/a.txt")).resolves.toBeUndefined();
		await expect(client.sessions.deleteVolume("s1")).resolves.toBeUndefined();

		expect(http.calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
			["DELETE", "/v1/sessions/s1/volume/files/tmp%2Fa.txt"],
			["DELETE", "/v1/sessions/s1/volume"],
		]);
	});
});
