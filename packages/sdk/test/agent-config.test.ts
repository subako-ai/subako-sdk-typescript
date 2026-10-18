import { describe, expect, it } from "vitest";
import { type AgentVersionConfig, type PublishAgentVersionBody, readAgentConfig } from "../src/index.js";

const PROVIDER_ID = "0198e5a4-6b1c-7d2e-8f3a-4b5c6d7e8f90";

/** A config as Core answers one: every field written out. */
const CONFIG: AgentVersionConfig = {
	system_prompt: null,
	model: {
		format: "anthropic",
		model: "claude-sonnet-5",
		max_tokens: 8192,
		context_window: 200_000,
		image_input: "supported",
		thinking: null,
		effort: null,
	},
	mcp: [],
	skills: [],
	sandboxes: [],
	builtin: { session_display_name: { when: "never" }, ask_user: null },
	functions: [],
	volume: { data: { type: "disabled" } },
};

describe("readAgentConfig", () => {
	it("answers the version's config, which publishing takes as it is", () => {
		const config = readAgentConfig({ config: CONFIG });
		expect(config).toEqual(CONFIG);
		const body: PublishAgentVersionBody = { ...config, model_provider_id: PROVIDER_ID };
		expect(body.model.format).toBe("anthropic");
	});
});
