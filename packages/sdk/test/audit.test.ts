import { describe, expect, it } from "vitest";
import { type AuditLogEntryBody, auditEventOf, KnownAuditAction } from "../src/index.js";
import { json, stubFetch, testClient } from "./support.js";

const entry = (overrides: Partial<AuditLogEntryBody>): AuditLogEntryBody => ({
	id: "0198a5b0-0000-7000-8000-000000000001",
	occurred_at: "2026-01-01T00:00:00Z",
	action: "api_key_created",
	category: "management",
	result: "success",
	actor: { type: "user", user_id: "0198a5b0-0000-7000-8000-000000000002", grant_id: null },
	details: { permissions: ["agent.read"], expires_at: null },
	names: { actor: { state: "current", name: "Alice" }, issuer: null, workspace: null, subject: null },
	...overrides,
});

describe("organization.listAuditLogs", () => {
	it("reads the organization's audit log with its filters as the query", async () => {
		const http = stubFetch(() => json({ items: [entry({})], next_cursor: null, prev_cursor: null }));
		const client = testClient({ fetch: http.fetch });

		const page = await client.organization.listAuditLogs({
			category: "authentication",
			result: "denied",
			actor_id: "0198a5b0-0000-7000-8000-000000000003",
			since: "2026-01-01T00:00:00Z",
		});

		const url = new URL(http.calls[0]!.url);
		expect(url.pathname).toBe("/v1/organization/audit-logs");
		expect(url.searchParams.get("category")).toBe("authentication");
		expect(url.searchParams.get("result")).toBe("denied");
		expect(url.searchParams.get("actor_id")).toBe("0198a5b0-0000-7000-8000-000000000003");
		expect(url.searchParams.get("since")).toBe("2026-01-01T00:00:00Z");
		expect(page.items).toHaveLength(1);
	});
});

describe("auditEventOf", () => {
	it("types a known action's details by its action", () => {
		const read = auditEventOf(entry({}));
		expect(read.kind).toBe("event");
		if (read.kind === "event" && read.event.action === "api_key_created") {
			expect(read.event.details.permissions).toEqual(["agent.read"]);
		}
	});

	it("reads a refused attempt as denied, whatever its details", () => {
		expect(auditEventOf(entry({ result: "denied", details: {} }))).toEqual({
			kind: "denied",
			action: "api_key_created",
		});
	});

	it("keeps an action this version does not know, with its details as sent", () => {
		expect(auditEventOf(entry({ action: "added_later", category: null, details: { n: 1 } }))).toEqual({
			kind: "unknown",
			action: "added_later",
			details: { n: 1 },
		});
	});

	it("knows every action the document lists", () => {
		for (const action of Object.values(KnownAuditAction)) {
			expect(auditEventOf(entry({ action })).kind).toBe("event");
		}
	});
});
