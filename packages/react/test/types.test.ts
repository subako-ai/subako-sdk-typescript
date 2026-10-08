import type { SessionConnection, SessionState, ToolClient, ToolDefinition } from "@subako-ai/sdk";
import type { RefObject } from "react";
import { describe, expect, it } from "vitest";
import { useSession, useSessionState, useTool, useToolClient } from "../src/index.js";

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// The three hooks mirror the SDK's layers: a connection, a client on it, a tool on the client.
// Each is opened by an effect, so each is null until that effect has run.
const opensASession: Equals<ReturnType<typeof useSession>, SessionConnection | null> = true;
const opensAClient: Equals<ReturnType<typeof useToolClient>, ToolClient | null> = true;

// Acquiring and reading are two hooks: the second hands back the snapshot, null session and all.
const readsASession: Equals<ReturnType<typeof useSessionState>, SessionState | null> = true;

/** Never called: it is here so `tsc` checks the shapes an app actually writes. */
function shapes(sessionId: string, formRef: RefObject<HTMLFormElement | null>): ToolDefinition[] {
	const session = useSession(sessionId);
	const state = useSessionState(session);
	const client = useToolClient(session, "chat");
	// `useTool` takes the SDK's own definition; the constructors in `@subako-ai/tools` answer with one.
	const fill: ToolDefinition = {
		description: "The signup form.",
		parameters: { type: "object", properties: { email: { type: "string" } } },
		execute: async () => "filled",
	};
	// A ref to any element is a target, not only a ref to a bare HTMLElement.
	useTool(client, "fill", fill, { target: formRef });
	// A tool written at the call site takes its handler's type from its own `parse`.
	useTool(client, "apply_coupon", {
		description: "Apply a coupon.",
		parameters: { type: "object", properties: { code: { type: "string" } } },
		parse: (args) => String(args["code"]),
		execute: (code) => `applied ${code.trim()}`,
	});
	// The read is the return: a component draws the snapshot, and nothing until there is one.
	return state === null ? [] : [fill];
}

describe("the React surface", () => {
	it("holds at compile time", () => {
		expect([opensASession, opensAClient, readsASession]).toEqual([true, true, true]);
		expect(typeof shapes).toBe("function");
	});
});
