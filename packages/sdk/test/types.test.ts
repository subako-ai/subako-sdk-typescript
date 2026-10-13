import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import type {
	AgentBody,
	ApprovalDecision,
	CreatedSessionBody,
	CreatedSessionReceiptBody,
	FunctionBody,
	FunctionVersionBody,
	Page,
	PendingApproval,
	SessionConnection,
	SessionEventBody,
	ToolClient,
	ToolDefinition,
	TranscriptMessage,
} from "../src/index.js";
import { SubakoClient, SubakoSessionClient } from "../src/index.js";

const client = new SubakoClient({ apiKey: "k" });
const browser = new SubakoSessionClient({ getToken: (sessionId) => `t-${sessionId}` });

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// A read answers with the response body the spec declares.
const getsOneAgent: Equals<Awaited<ReturnType<typeof client.agents.get>>, AgentBody> = true;

// A package's reads answer with the bodies the SDK names for them.
const getsOneFunction: Equals<Awaited<ReturnType<typeof client.functions.get>>, FunctionBody> = true;
const pagesFunctionVersions: Equals<
	Awaited<ReturnType<typeof client.functions.listVersions>>["items"],
	readonly FunctionVersionBody[]
> = true;

// A 204 answers with nothing.
const deletesAnAgent: Equals<Awaited<ReturnType<typeof client.agents.delete>>, void> = true;

// A mint answers with the secret, or with the receipt a replay carries instead.
const createsOrReplays: Equals<
	Awaited<ReturnType<typeof client.sessions.create>>,
	CreatedSessionBody | CreatedSessionReceiptBody
> = true;

// A listing answers with a page, keyed by the cursor its query takes.
const pagesAgentsById: Equals<Awaited<ReturnType<typeof client.agents.list>>["nextCursor"], string | null> = true;
const pagesEventsBySeq: Equals<
	Awaited<ReturnType<typeof client.sessions.listEvents>>,
	Page<SessionEventBody, number>
> = true;

// Following a session answers with the connection, not with a promise.
const connects: Equals<ReturnType<typeof client.sessions.connect>, SessionConnection> = true;

// The connection carries the session's own writes, and the readings it derives from the log.
const readsTranscript: Equals<SessionConnection["transcript"], readonly TranscriptMessage[]> = true;
const readsApprovals: Equals<SessionConnection["approvals"], readonly PendingApproval[]> = true;
const sendsText: Equals<Parameters<SessionConnection["send"]>, [string]> = true;
const decides: Equals<
	Parameters<SessionConnection["resolveApproval"]>,
	[string, ApprovalDecision, (string | undefined)?]
> = true;

// A session client binds the same session routes, with the same signatures.
const connectsFromBrowser: Equals<ReturnType<typeof browser.connect>, SessionConnection> = true;
const readsOneSession: Equals<
	Awaited<ReturnType<typeof browser.get>>,
	Awaited<ReturnType<typeof client.sessions.get>>
> = true;

// A handler names the type its `parse` guarantees; without one the arguments stay unknown.
const tools: Readonly<Record<string, ToolDefinition>> = {
	navigate: {
		description: "Go to a page.",
		parameters: { type: "object" },
		parse: (args) => ({ to: String(args["to"]) }),
		execute: (args: { to: string }) => `at ${args.to}`,
	},
	raw: {
		description: "Takes the arguments as they came.",
		parameters: { type: "object" },
		execute: (args) => JSON.stringify(args),
	},
};

declare const coupon: StandardSchemaV1<unknown, { code: string }>;

/** Never called: it is here so `tsc` checks the shapes an app actually writes. */
function declares(client: ToolClient): void {
	// A schema is the parameters the model reads and the validation both, so `execute` takes
	// what the schema read rather than what arrived.
	client.addTool("apply_coupon", {
		description: "Apply a coupon.",
		schema: coupon,
		execute: (args) => {
			const inferred: Equals<typeof args, { code: string }> = true;
			return inferred ? args.code : "";
		},
	});
	// The call site is where a handler's type comes from: `parse` says what the arguments
	// are, and `execute` takes them without naming the type a second time.
	client.addTool("apply_coupon", {
		description: "Apply a coupon.",
		parameters: { type: "object" },
		parse: (args) => String(args["code"]),
		execute: (code) => code.trim(),
	});
	// A destructured handler is the case that hid this: with nothing to infer from, the
	// binding pattern makes its own `any` and the mistake never surfaces.
	client.addTool("navigate", {
		description: "Go to a page.",
		parameters: { type: "object" },
		parse: (args) => ({ to: String(args["to"]) }),
		execute: (args) => {
			const inferred: Equals<typeof args, { to: string }> = true;
			return inferred ? `at ${args.to}` : "";
		},
	});
	// Without a `parse` there is nothing to infer from, and the arguments stay unknown.
	client.addTool("raw", {
		description: "Takes the arguments as they came.",
		parameters: { type: "object" },
		execute: (args) => JSON.stringify(args),
	});
}

describe("method signatures", () => {
	it("hold at compile time", () => {
		expect([
			getsOneAgent,
			getsOneFunction,
			pagesFunctionVersions,
			deletesAnAgent,
			createsOrReplays,
			pagesAgentsById,
			pagesEventsBySeq,
			connects,
			readsTranscript,
			readsApprovals,
			sendsText,
			decides,
			connectsFromBrowser,
			readsOneSession,
		]).toEqual(Array.from({ length: 14 }, () => true));
		expect(Object.keys(tools)).toEqual(["navigate", "raw"]);
		expect(typeof declares).toBe("function");
	});

	it("reject the wrong shapes", () => {
		const rejected = (): void => {
			// @ts-expect-error the agent id is required
			void client.agents.get();
			// @ts-expect-error a rename needs the name to give
			void client.agents.rename("a1");
			// @ts-expect-error the body is checked against the spec
			void client.agents.create({ nam: "triage" });
			// @ts-expect-error the event log pages by seq, not by id
			void client.sessions.listEvents("s1", { after: "e1" });
			// @ts-expect-error an archive is bytes, not a string
			void client.skills.create("archive.tar.gz");
			// @ts-expect-error the workspace override is a string
			void client.agents.get("a1", { workspaceId: 1 });
			const serving = client.sessions.connect("s1").createToolClient("web");
			// @ts-expect-error a tool without an execute serves nothing
			serving.addTool("navigate", { description: "Go to a page.", parameters: { type: "object" } });
			// The hook agrees with the schema on the type, so it is the second validation being
			// declared at all that is refused, not a disagreement between the two.
			const both = {
				description: "Apply.",
				schema: coupon,
				parse: (args: { code: string }) => args,
				execute: (): string => "",
			};
			// @ts-expect-error a tool validates one way or the other, never both
			serving.addTool("apply_coupon", both);
			// @ts-expect-error a tool has to say what its arguments are, as a schema or as parameters
			serving.addTool("apply_coupon", { description: "Apply.", execute: () => "" });
		};
		expect(rejected).toBeTypeOf("function");
	});

	it("take one cursor of an id-keyed listing at a time", () => {
		const accepted = (): void => {
			void client.workspaces.list({ after: "w1", limit: 25 });
			void client.workspaces.list({ before: "w1", limit: 25 });
			void client.organization.listMembers({ after: undefined, order: "asc" });
			// The event log's two bounds make a window, so both together stand.
			void client.sessions.listEvents("s1", { after_seq: 1, before_seq: 9 });
		};
		const rejected = (): void => {
			// @ts-expect-error a page starts past one cursor or before one, never both
			void client.workspaces.list({ after: "w1", before: "w2" });
			// @ts-expect-error a page starts past one cursor or before one, never both
			void client.agents.listVersions("a1", { after: "v1", before: "v2" });
		};
		expect(accepted).toBeTypeOf("function");
		expect(rejected).toBeTypeOf("function");
	});

	it("keep the workspace routes off the session client", () => {
		const rejected = (): void => {
			// @ts-expect-error a session token creates no sessions
			void browser.create({ agent_id: "a1" });
			// @ts-expect-error a session token lists no sessions
			void browser.list();
			// @ts-expect-error a session token deletes no sessions
			void browser.delete("s1");
			// @ts-expect-error a session token mints no tokens
			void browser.mintToken("s1");
			// @ts-expect-error the other namespaces need a workspace credential
			void browser.agents;
			// @ts-expect-error a session token implies its workspace, so there is none to name
			void new SubakoSessionClient({ baseUrl: "https://api.test", getToken: () => "t", workspaceId: "w1" });
		};
		expect(rejected).toBeTypeOf("function");
	});
});
