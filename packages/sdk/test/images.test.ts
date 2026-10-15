import { describe, expect, it } from "vitest";
import { stubFetch, testClient } from "./support.js";

describe("a session image", () => {
	it("is read by its digest", async () => {
		const http = stubFetch(() => new Response("png-bytes", { headers: { "content-type": "image/png" } }));
		const client = testClient({ fetch: http.fetch });

		const blob = await client.sessions.readImage("s1", "ab".repeat(32));

		expect(await blob.text()).toBe("png-bytes");
		expect(new URL(http.calls[0]!.url).pathname).toBe(`/v1/sessions/s1/images/${"ab".repeat(32)}`);
	});
});
