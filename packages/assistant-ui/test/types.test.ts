import type { AssistantRuntime, ThreadMessageLike } from "@assistant-ui/react";
import { useSession } from "@subako-ai/react";
import type { TranscriptMessage } from "@subako-ai/sdk";
import { describe, expect, it } from "vitest";
import type { SubakoSession } from "../src/index.js";
import { convertMessage, useSubakoRuntime } from "../src/index.js";

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// The converter is the pure half of the package: one message of the log, one assistant-ui message.
const converts: Equals<Parameters<typeof convertMessage>, [TranscriptMessage]> = true;
const convertsTo: Equals<ReturnType<typeof convertMessage>, ThreadMessageLike> = true;

// The runtime is assistant-ui's own, so anything that takes one takes this.
const buildsARuntime: Equals<ReturnType<typeof useSubakoRuntime>, AssistantRuntime> = true;

// A session from the React hook is what the runtime reads; the type here is only its structure,
// and the null the hook hands back before its effect has connected.
const readsASession: SubakoSession | null = undefined as unknown as ReturnType<typeof useSession>;

/** Never called: it is here so `tsc` checks the shape an app actually writes. */
function shapes(sessionId: string): AssistantRuntime {
	return useSubakoRuntime(useSession(sessionId));
}

describe("the assistant-ui surface", () => {
	it("holds at compile time", () => {
		expect([converts, convertsTo, buildsARuntime]).toEqual([true, true, true]);
		expect(typeof shapes).toBe("function");
		expect(readsASession).toBeUndefined();
	});
});
