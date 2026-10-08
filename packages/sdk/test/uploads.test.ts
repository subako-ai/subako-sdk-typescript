import { describe, expect, it } from "vitest";
import { json, stubFetch, testClient } from "./support.js";

const bytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
const version = { id: "sv1", skill_id: "sk1", version: 1 };

const streamOf = (chunk: Uint8Array): ReadableStream<Uint8Array> =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(chunk);
			controller.close();
		},
	});

describe("skill archives", () => {
	it("sends a Uint8Array as gzip", async () => {
		const http = stubFetch(() => json(version, 201));
		const client = testClient({ fetch: http.fetch });

		await expect(client.skills.create(bytes)).resolves.toEqual(version);

		const request = http.calls[0]!;
		expect(request.url).toBe("https://api.test/v1/skills");
		expect(request.headers.get("content-type")).toBe("application/gzip");
		await expect(request.arrayBuffer().then((buffer) => new Uint8Array(buffer))).resolves.toEqual(bytes);
	});

	it("sends a Blob", async () => {
		const http = stubFetch(() => json(version, 201));
		const client = testClient({ fetch: http.fetch });

		await client.skills.pushVersion("sk1", new Blob([bytes]));

		const request = http.calls[0]!;
		expect(request.url).toBe("https://api.test/v1/skills/sk1/versions");
		expect(request.headers.get("content-type")).toBe("application/gzip");
		await expect(request.arrayBuffer().then((buffer) => new Uint8Array(buffer))).resolves.toEqual(bytes);
	});

	it("sends a ReadableStream", async () => {
		const http = stubFetch(() => json(version, 201));
		const client = testClient({ fetch: http.fetch });

		await client.skills.create(streamOf(bytes));

		const request = http.calls[0]!;
		expect(request.headers.get("content-type")).toBe("application/gzip");
		await expect(request.arrayBuffer().then((buffer) => new Uint8Array(buffer))).resolves.toEqual(bytes);
	});
});

describe("skill versions", () => {
	it("reads one version by its number", async () => {
		const http = stubFetch(() => json(version));
		const client = testClient({ fetch: http.fetch });

		await expect(client.skills.getVersion("sk1", 3)).resolves.toEqual(version);

		expect(http.calls[0]!.url).toBe("https://api.test/v1/skills/sk1/versions/3");
	});

	it("reads a version's archive as a presigned download", async () => {
		const bundle = {
			url: "https://objects.test/skills/sk1/bundle.tar.gz?signature=s",
			expires_at: "2026-01-01T00:15:00Z",
			bytes: 512,
		};
		const http = stubFetch(() => json(bundle));
		const client = testClient({ fetch: http.fetch });

		await expect(client.skills.getBundle("sk1", 2)).resolves.toEqual(bundle);

		expect(http.calls[0]!.url).toBe("https://api.test/v1/skills/sk1/versions/2/bundle");
	});
});
