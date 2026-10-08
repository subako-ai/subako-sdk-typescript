import { describe, expect, it } from "vitest";
import {
	AgentConfigError,
	type AgentVersionConfig,
	type PublishAgentVersionBody,
	readAgentConfig,
} from "../src/index.js";

const SKILL_ID = "0198e5a4-6b1c-7d2e-8f3a-4b5c6d7e8f90";

/** A config as Core stores it: the model under `config`, empty lists left out. */
const stored = (config: Record<string, unknown>) => ({ config });

const sonnet = { format: "anthropic", config: { model: "claude-sonnet-5", max_tokens: 8192, context_window: 200_000 } };

/** The error reading `config` throws. */
function failure(config: Record<string, unknown>): AgentConfigError {
	try {
		readAgentConfig(stored(config));
	} catch (error) {
		if (error instanceof AgentConfigError) return error;
		throw error;
	}
	throw new Error("the config read");
}

describe("readAgentConfig", () => {
	it("reads a minimal config with every list empty and every setting null", () => {
		expect(readAgentConfig(stored({ model: sonnet }))).toEqual({
			system_prompt: null,
			model: {
				format: "anthropic",
				model: "claude-sonnet-5",
				max_tokens: 8192,
				context_window: 200_000,
				thinking: null,
				effort: null,
			},
			mcp: [],
			skills: [],
			sandboxes: [],
		});
	});

	it("flattens each model format into the shape publishing takes", () => {
		const anthropic = readAgentConfig(
			stored({
				model: {
					format: "anthropic",
					config: {
						model: "claude-haiku-4-5",
						max_tokens: 32000,
						context_window: 200_000,
						thinking: { type: "enabled", config: { budget_tokens: 16000 } },
						effort: "high",
					},
				},
			}),
		);
		expect(anthropic.model).toEqual({
			format: "anthropic",
			model: "claude-haiku-4-5",
			max_tokens: 32000,
			context_window: 200_000,
			thinking: { type: "enabled", budget_tokens: 16000 },
			effort: "high",
		});

		const adaptive = readAgentConfig(
			stored({
				model: {
					format: "anthropic",
					config: {
						model: "claude-opus-5",
						max_tokens: 32000,
						context_window: 200_000,
						thinking: { type: "adaptive" },
					},
				},
			}),
		);
		expect(adaptive.model).toMatchObject({ thinking: { type: "adaptive" }, effort: null });

		const betweenTools = readAgentConfig(
			stored({
				model: {
					format: "anthropic",
					config: {
						model: "claude-sonnet-5-5",
						max_tokens: 64_000,
						context_window: 1_000_000,
						thinking: { type: "between_tools" },
					},
				},
			}),
		);
		expect(betweenTools.model).toMatchObject({ context_window: 1_000_000, thinking: { type: "between_tools" } });

		const openai = readAgentConfig(
			stored({
				model: {
					format: "openai_responses",
					config: { model: "gpt-5", max_tokens: 8192, context_window: 200000, reasoning_effort: "medium" },
				},
			}),
		);
		expect(openai.model).toEqual({
			format: "openai_responses",
			model: "gpt-5",
			max_tokens: 8192,
			context_window: 200000,
			reasoning_effort: "medium",
		});
	});

	it("reads every grant, and reads a sandbox stored without a network as unrestricted", () => {
		const config = readAgentConfig(
			stored({
				system_prompt: "Be brief.",
				model: sonnet,
				mcp: [
					{
						name: "tickets",
						url: "https://mcp.example.com/tickets",
						default_policy: "require_approval",
						tools: [{ name: "search_tickets", policy: "allow" }],
					},
					{ name: "wiki", url: "https://wiki.example.com/mcp", default_policy: "deny" },
				],
				skills: [
					{ name: "refunds", skill_id: SKILL_ID, version: { type: "latest" } },
					{ name: "policy", skill_id: SKILL_ID, version: { type: "pinned", number: 3 } },
				],
				sandboxes: [
					{
						name: "build",
						environment: { type: "platform", release: "2026" },
						network: { type: "none" },
						default_policy: "allow",
					},
					{ name: "old", environment: { type: "platform", release: "2026" }, default_policy: "deny" },
				],
			}),
		);
		expect(config).toEqual({
			system_prompt: "Be brief.",
			model: {
				format: "anthropic",
				model: "claude-sonnet-5",
				max_tokens: 8192,
				context_window: 200_000,
				thinking: null,
				effort: null,
			},
			mcp: [
				{
					name: "tickets",
					url: "https://mcp.example.com/tickets",
					default_policy: "require_approval",
					tools: [{ name: "search_tickets", policy: "allow" }],
				},
				{ name: "wiki", url: "https://wiki.example.com/mcp", default_policy: "deny", tools: [] },
			],
			skills: [
				{ name: "refunds", skill_id: SKILL_ID, version: { type: "latest" } },
				{ name: "policy", skill_id: SKILL_ID, version: { type: "pinned", number: 3 } },
			],
			sandboxes: [
				{
					name: "build",
					environment: { type: "platform", release: "2026" },
					network: { type: "none" },
					default_policy: "allow",
					tools: [],
				},
				{
					name: "old",
					environment: { type: "platform", release: "2026" },
					network: { type: "unrestricted" },
					default_policy: "deny",
					tools: [],
				},
			],
		});
	});

	it("answers what publishing takes as it is", () => {
		const config: AgentVersionConfig = readAgentConfig(stored({ model: sonnet }));
		const body: PublishAgentVersionBody = { ...config, model_provider_id: SKILL_ID };
		expect(body.model.format).toBe("anthropic");
	});

	it("refuses a field publishing has no spelling for, naming where it is", () => {
		const subagent = failure({ model: sonnet, subagent: { agents: [{ type: "self_version" }] } });
		expect(subagent.path).toBe("subagent");
		expect(subagent.message).toBe("cannot read the agent config: subagent is a field publishing has no spelling for");

		const pinnedLatest = failure({
			model: sonnet,
			skills: [{ name: "refunds", skill_id: SKILL_ID, version: { type: "latest", number: 2 } }],
		});
		expect(pinnedLatest.path).toBe("skills[0].version.number");
	});

	it("refuses a workspace environment, which publishing cannot name", () => {
		const workspace = failure({
			model: sonnet,
			sandboxes: [
				{
					name: "data",
					environment: { type: "workspace", environment_id: SKILL_ID, version: { type: "latest" } },
					default_policy: "deny",
				},
			],
		});
		expect(workspace.path).toBe("sandboxes[0].environment.environment_id");
	});

	it("refuses a value of the wrong shape, naming where it is in the stored document", () => {
		expect(failure({ model: sonnet, mcp: [{ name: "x", url: "https://x.test", default_policy: "maybe" }] }).path).toBe(
			"mcp[0].default_policy",
		);
		expect(
			failure({ model: { format: "anthropic", config: { model: "claude-sonnet-5", max_tokens: -1 } } }).message,
		).toBe("cannot read the agent config: model.config.max_tokens is not a whole number of at least 0");
		expect(failure({ model: { format: "gemini", config: {} } }).path).toBe("model.format");
		expect(failure({ model: sonnet, skills: { name: "refunds" } }).path).toBe("skills");
		expect(
			failure({ model: sonnet, skills: [{ name: "x", skill_id: SKILL_ID, version: { type: "pinned", number: 0 } }] })
				.path,
		).toBe("skills[0].version.number");
		expect(failure({ model: sonnet, system_prompt: 7 }).path).toBe("system_prompt");
		const thinking = (value: unknown) => ({ ...sonnet, config: { ...sonnet.config, thinking: value } });
		expect(failure({ model: thinking({ budget_tokens: 1024 }) }).path).toBe("model.config.thinking.budget_tokens");
		expect(failure({ model: thinking({ type: "adaptive", config: { budget_tokens: 1024 } }) }).path).toBe(
			"model.config.thinking.config",
		);
		expect(failure({ model: { ...sonnet, config: { ...sonnet.config, effort: "extreme" } } }).path).toBe(
			"model.config.effort",
		);
		expect(() => readAgentConfig({ config: [] as unknown as Record<string, unknown> })).toThrow(
			"cannot read the agent config: the config is not an object",
		);
	});
});
