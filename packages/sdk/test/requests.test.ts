import { describe, expect, it } from "vitest";
import { empty, json, stubFetch, testClient } from "./support.js";

describe("path parameters", () => {
	it("fills the url from the positional arguments, in order", async () => {
		const http = stubFetch(() => empty(204));
		const client = testClient({ fetch: http.fetch });

		await client.sessions.answerCall("s1", "c1", "call1", { text: "done" });

		expect(http.calls[0]?.url).toBe("https://api.test/v1/sessions/s1/clients/c1/calls/call1/result");
		expect(http.calls[0]?.method).toBe("POST");
	});

	it("escapes a path parameter", async () => {
		const http = stubFetch(() => json({ id: "a/b" }));
		const client = testClient({ fetch: http.fetch });

		await client.agents.get("a/b");

		expect(http.calls[0]?.url).toBe("https://api.test/v1/agents/a%2Fb");
	});
});

describe("params", () => {
	it("become the query of a read", async () => {
		const http = stubFetch(() => json({ items: [] }));
		const client = testClient({ fetch: http.fetch });

		await client.skills.list({ limit: 25, order: "asc" });

		const url = new URL(http.calls[0]!.url);
		expect(url.pathname).toBe("/v1/skills");
		expect(url.searchParams.get("limit")).toBe("25");
		expect(url.searchParams.get("order")).toBe("asc");
	});

	it("become the json body of a write", async () => {
		const http = stubFetch(() => json({ id: "a1" }, 201));
		const client = testClient({ fetch: http.fetch });

		await client.agents.create({ name: "triage" });

		const request = http.calls[0]!;
		expect(request.method).toBe("POST");
		expect(request.headers.get("content-type")).toBe("application/json");
		await expect(request.text()).resolves.toBe(JSON.stringify({ name: "triage" }));
	});

	it("ride the query of a listing, not its body", async () => {
		const http = stubFetch(() => json({ items: [] }));
		const client = testClient({ fetch: http.fetch });

		await client.sessions.listEvents("s1", { after_seq: 41 });

		expect(new URL(http.calls[0]!.url).searchParams.get("after_seq")).toBe("41");
	});

	it("spell a usage report's grouping as repeated keys and its filter as a deep object", async () => {
		const http = stubFetch(() => json({ items: [], finalized_before: null, next_cursor: null }));
		const client = testClient({ fetch: http.fetch });

		await client.workspaces.usageReport("w1", {
			starting_at: "2026-10-01T00:00:00Z",
			ending_at: "2026-10-02T00:00:00Z",
			bucket_width: "1h",
			group_by: ["metadata.tenant_id", "model"],
			metadata: { env: "prod", region: "jp" },
		});

		const url = new URL(http.calls[0]!.url);
		expect(url.pathname).toBe("/v1/workspaces/w1/usage-report");
		expect(url.searchParams.getAll("group_by")).toEqual(["metadata.tenant_id", "model"]);
		expect(url.searchParams.get("metadata[env]")).toBe("prod");
		expect(url.searchParams.get("metadata[region]")).toBe("jp");
		expect(url.searchParams.get("bucket_width")).toBe("1h");
		expect(url.searchParams.get("starting_at")).toBe("2026-10-01T00:00:00Z");
	});

	it("spell a vault listing's metadata filter as a deep object beside its external id", async () => {
		const http = stubFetch(() => json({ items: [], next_cursor: null, prev_cursor: null }));
		const client = testClient({ fetch: http.fetch });

		await client.vaults.list({ external_id: "user_42", metadata: { plan: "pro", region: "jp" } });

		const url = new URL(http.calls[0]!.url);
		expect(url.pathname).toBe("/v1/vaults");
		expect(url.searchParams.get("external_id")).toBe("user_42");
		expect(url.searchParams.get("metadata[plan]")).toBe("pro");
		expect(url.searchParams.get("metadata[region]")).toBe("jp");
	});

	it("spell a session listing's metadata filter as a deep object beside its agent", async () => {
		const http = stubFetch(() => json({ items: [], next_cursor: null, prev_cursor: null }));
		const client = testClient({ fetch: http.fetch });

		await client.sessions.list({ agent_id: "a1", metadata: { user_id: "user_42", tenant: "t_1" } });

		const url = new URL(http.calls[0]!.url);
		expect(url.pathname).toBe("/v1/sessions");
		expect(url.searchParams.get("agent_id")).toBe("a1");
		expect(url.searchParams.get("metadata[user_id]")).toBe("user_42");
		expect(url.searchParams.get("metadata[tenant]")).toBe("t_1");
	});

	it("carry a new API key in a provider update, the key alone", async () => {
		const http = stubFetch(() => json({ id: "p1" }));
		const client = testClient({ fetch: http.fetch });

		await client.modelProviders.update("p1", { api_key: "sk-rotated" });

		const request = http.calls[0]!;
		expect(request.method).toBe("PATCH");
		expect(new URL(request.url).pathname).toBe("/v1/model-providers/p1");
		await expect(request.text()).resolves.toBe(JSON.stringify({ api_key: "sk-rotated" }));
	});

	it("bind a model provider to a role instead of a key", async () => {
		const http = stubFetch(() => json({ id: "p1" }));
		const client = testClient({ fetch: http.fetch });
		const auth = {
			type: "aws_web_identity",
			role_arn: "arn:aws:iam::123456789012:role/subako-bedrock",
			region: "us-east-1",
		} as const;

		await client.modelProviders.create({
			format: "anthropic",
			display_name: "Claude on Bedrock",
			base_url: "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic",
			auth,
		});

		const request = http.calls[0]!;
		expect(new URL(request.url).pathname).toBe("/v1/model-providers");
		expect(JSON.parse(await request.text())).toMatchObject({ auth });
	});

	it("bind a model provider to an Anthropic federation rule instead of a key", async () => {
		const http = stubFetch(() => json({ id: "p1" }));
		const client = testClient({ fetch: http.fetch });
		const auth = {
			type: "anthropic_workload_identity",
			organization_id: "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
			service_account_id: "svac_01Subako",
			federation_rule_id: "fdrl_01Subako",
			workspace_id: "wrkspc_01Subako",
		} as const;

		await client.modelProviders.create({
			format: "anthropic",
			display_name: "Claude",
			base_url: "https://api.anthropic.com",
			auth,
		});

		const request = http.calls[0]!;
		expect(JSON.parse(await request.text())).toMatchObject({ auth });
	});

	it("bind a model provider to an OpenAI workload identity provider instead of a key", async () => {
		const http = stubFetch(() => json({ id: "p1" }));
		const client = testClient({ fetch: http.fetch });
		const auth = {
			type: "openai_workload_identity",
			identity_provider_id: "idp_01Subako",
			service_account_id: "user-01Subako",
		} as const;

		await client.modelProviders.create({
			format: "openai_responses",
			display_name: "OpenAI",
			base_url: "https://api.openai.com/v1",
			auth,
		});

		const request = http.calls[0]!;
		expect(JSON.parse(await request.text())).toMatchObject({ auth });
	});

	it("read the workspace's workload identity", async () => {
		const http = stubFetch(() =>
			json({
				issuer: "https://oidc.subako.test",
				subject: "workspace:w1",
				aws: { audience: "sts.amazonaws.com" },
				anthropic: { audience: "https://api.anthropic.com" },
				openai: { audience: "https://api.openai.com/v1" },
			}),
		);
		const client = testClient({ fetch: http.fetch });

		const identity = await client.modelProviders.workloadIdentity();

		expect(new URL(http.calls[0]!.url).pathname).toBe("/v1/workload-identity");
		expect(identity.subject).toBe("workspace:w1");
		expect(identity.anthropic.audience).toBe("https://api.anthropic.com");
		expect(identity.openai.audience).toBe("https://api.openai.com/v1");
	});

	it("narrow the model providers listing to one type", async () => {
		const http = stubFetch(() => json({ items: [] }));
		const client = testClient({ fetch: http.fetch });

		await client.modelProviders.list({ type: "byok" });

		const url = new URL(http.calls[0]!.url);
		expect(url.pathname).toBe("/v1/model-providers");
		expect(url.searchParams.get("type")).toBe("byok");
	});
});

describe("requests without a body", () => {
	it("send neither a body nor a content type", async () => {
		const http = stubFetch(() => json({ run_id: null }));
		const client = testClient({ fetch: http.fetch });

		await client.sessions.cancelRun("s1");

		const request = http.calls[0]!;
		expect(request.method).toBe("POST");
		expect(request.headers.has("content-type")).toBe(false);
		await expect(request.text()).resolves.toBe("");
	});
});

describe("responses", () => {
	it("answer with the parsed body", async () => {
		const http = stubFetch(() => json({ id: "a1", name: "triage" }));
		const client = testClient({ fetch: http.fetch });

		await expect(client.agents.get("a1")).resolves.toEqual({ id: "a1", name: "triage" });
	});

	it("answer with undefined when the server sends 204", async () => {
		const http = stubFetch(() => empty(204));
		const client = testClient({ fetch: http.fetch });

		await expect(client.agents.delete("a1")).resolves.toBeUndefined();
		expect(http.calls[0]?.method).toBe("DELETE");
	});

	it("carry the method the spec names", async () => {
		const http = stubFetch(
			() => empty(204),
			() => json({ id: "s1" }),
			() => json({}),
		);
		const client = testClient({ fetch: http.fetch });

		await client.organization.changeMemberRole("u1", { role: "admin" });
		await client.skills.rename("sk1", { display_name: "renamed" });
		await client.me.rename({ display_name: null });

		expect(http.calls.map((call) => call.method)).toEqual(["PUT", "PATCH", "PATCH"]);
		// A clear travels as an explicit null, which Core requires rather than an absent field.
		expect(await http.calls[2]?.json()).toEqual({ display_name: null });
	});
});
