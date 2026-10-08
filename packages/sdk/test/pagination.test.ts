import { describe, expect, it } from "vitest";
import { Page } from "../src/index.js";
import { json, stubFetch, testClient } from "./support.js";

const agentPage = (ids: readonly string[], next: string | null, previous: string | null = null): Response =>
	json({
		items: ids.map((id) => ({ id, name: id, workspace_id: "w1", created_at: "2026-01-01T00:00:00Z" })),
		next_cursor: next,
		prev_cursor: previous,
	});

const eventPage = (seqs: readonly number[], next: number | null): Response =>
	json({ items: seqs.map((seq) => ({ seq, type: "run_queued", run_id: `r${seq}` })), next_cursor: next });

describe("paging", () => {
	it("walks every page from the first", async () => {
		const http = stubFetch(
			() => agentPage(["a1", "a2"], "a2"),
			() => agentPage(["a3"], "a3"),
			() => agentPage([], null),
		);
		const client = testClient({ fetch: http.fetch });

		const seen: string[] = [];
		for await (const agent of await client.agents.list({ limit: 2 })) {
			seen.push(agent.id);
		}

		expect(seen).toEqual(["a1", "a2", "a3"]);
		expect(http.calls).toHaveLength(3);
		expect(new URL(http.calls[0]!.url).searchParams.get("after")).toBeNull();
		expect(new URL(http.calls[1]!.url).searchParams.get("after")).toBe("a2");
		expect(new URL(http.calls[1]!.url).searchParams.get("limit")).toBe("2");
		expect(new URL(http.calls[2]!.url).searchParams.get("after")).toBe("a3");
	});

	it("keeps a search on every page it walks", async () => {
		const http = stubFetch(
			() => agentPage(["a1"], "a1"),
			() => agentPage([], null),
		);
		const client = testClient({ fetch: http.fetch });

		const first = await client.agents.list({ search: "triage" });
		await first.nextPage();

		for (const call of http.calls) {
			expect(new URL(call.url).searchParams.get("search")).toBe("triage");
		}
		expect(new URL(http.calls[1]!.url).searchParams.get("after")).toBe("a1");
	});

	it("hands the next page over one at a time", async () => {
		const http = stubFetch(
			() => agentPage(["a1"], "a1"),
			() => agentPage(["a2"], null),
		);
		const client = testClient({ fetch: http.fetch });

		const first = await client.agents.list();
		expect(first).toBeInstanceOf(Page);
		expect(first.nextCursor).toBe("a1");

		const second = await first.nextPage();
		expect(second?.items.map((agent) => agent.id)).toEqual(["a2"]);
		expect(second?.nextCursor).toBeNull();
		await expect(second?.nextPage()).resolves.toBeNull();
	});

	it("steps back under before, dropping the after it came by", async () => {
		const http = stubFetch(
			() => agentPage(["a3", "a4"], "a4", "a3"),
			() => agentPage(["a1", "a2"], "a2", null),
			() => agentPage(["a3", "a4"], "a4", "a3"),
		);
		const client = testClient({ fetch: http.fetch });

		const page = await client.agents.list({ limit: 2, after: "a2" });
		expect(page.previousCursor).toBe("a3");

		const first = await page.previousPage();
		expect(first?.items.map((agent) => agent.id)).toEqual(["a1", "a2"]);
		expect(first?.previousCursor).toBeNull();
		await expect(first?.previousPage()).resolves.toBeNull();

		const back = new URL(http.calls[1]!.url).searchParams;
		expect(back.get("before")).toBe("a3");
		expect(back.get("after")).toBeNull();
		expect(back.get("limit")).toBe("2");

		await first?.nextPage();
		const forward = new URL(http.calls[2]!.url).searchParams;
		expect(forward.get("after")).toBe("a2");
		expect(forward.get("before")).toBeNull();
	});

	it("has no page before the first", async () => {
		const http = stubFetch(() => json({ items: [], next_cursor: null }));
		const client = testClient({ fetch: http.fetch });

		const page = await client.workspaces.list();
		expect(page.previousCursor).toBeNull();
		await expect(page.previousPage()).resolves.toBeNull();
		expect(http.calls).toHaveLength(1);
	});

	it("pages the event log by seq, newest first, under before_seq", async () => {
		const http = stubFetch(
			() => eventPage([43, 42], 42),
			() => eventPage([], null),
		);
		const client = testClient({ fetch: http.fetch });

		const page = await client.sessions.listEvents("s1", { after_seq: 41 });
		expect(page.nextCursor).toBe(42);

		const seen: number[] = [];
		for await (const event of page) {
			seen.push(event.seq);
		}

		expect(seen).toEqual([43, 42]);
		// The event log pages forward only.
		expect(page.previousCursor).toBeNull();
		expect(new URL(http.calls[0]!.url).searchParams.get("after_seq")).toBe("41");
		expect(new URL(http.calls[1]!.url).searchParams.get("before_seq")).toBe("42");
	});

	it("pages the event log under after_seq when the walk runs the other way", async () => {
		const http = stubFetch(
			() => eventPage([42, 43], 43),
			() => eventPage([], null),
		);
		const client = testClient({ fetch: http.fetch });

		const page = await client.sessions.listEvents("s1", { order: "asc" });
		expect(page.nextCursor).toBe(43);
		await page.nextPage();

		const second = new URL(http.calls[1]!.url).searchParams;
		expect(second.get("after_seq")).toBe("43");
		expect(second.get("before_seq")).toBeNull();
		expect(second.get("order")).toBe("asc");
	});

	it("treats a missing cursor as the last page", async () => {
		const http = stubFetch(() => json({ items: [] }));
		const client = testClient({ fetch: http.fetch });

		const page = await client.workspaces.list();
		expect(page.nextCursor).toBeNull();
		await expect(page.nextPage()).resolves.toBeNull();
		expect(http.calls).toHaveLength(1);
	});
});
