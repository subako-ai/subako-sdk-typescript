import { describe, expect, it } from "vitest";
import { json, stubFetch, testClient } from "./support.js";

describe("a session attachment", () => {
	it("is read by its id", async () => {
		const http = stubFetch(() => new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } }));
		const client = testClient({ fetch: http.fetch });

		const blob = await client.sessions.readAttachment("s1", "a1");

		expect(await blob.text()).toBe("%PDF-1.7");
		expect(new URL(http.calls[0]!.url).pathname).toBe("/v1/sessions/s1/attachments/a1");
	});

	it("is uploaded under its name, and answers with the id an input names", async () => {
		const upload = {
			id: "u1",
			name: "report.pdf",
			media_type: "application/pdf",
			bytes: 8,
			expires_at: "2026-01-02T00:00:00Z",
		};
		const http = stubFetch(() => json(upload));
		const client = testClient({ fetch: http.fetch });

		await expect(client.sessions.createUpload("s1", new Blob(["%PDF-1.7"]), { name: "report.pdf" })).resolves.toEqual(
			upload,
		);

		const request = http.calls[0]!;
		expect(request.method).toBe("POST");
		expect(request.url).toBe("https://api.test/v1/sessions/s1/uploads?name=report.pdf");
		expect(request.headers.get("content-type")).toBe("application/octet-stream");
		await expect(request.text()).resolves.toBe("%PDF-1.7");
	});
});
