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
				image_input: null,
				thinking: null,
				effort: null,
			},
			mcp: [],
			skills: [],
			sandboxes: [],
			builtin: { session_display_name: { when: "never" } },
			functions: [],
			volume: { data: { type: "disabled" } },
		});
	});

	it("reads function grants and the volume setting", () => {
		const config = readAgentConfig(
			stored({
				model: sonnet,
				functions: [
					{
						name: "csv",
						source: { type: "platform", package: "csv-tools" },
						default_policy: "allow",
						tools: [{ name: "parse", policy: "deny" }],
						timeout_secs: 300,
					},
					{ name: "files", source: { type: "platform", package: "files" }, default_policy: "allow" },
				],
				volume: { data: { type: "enabled" } },
			}),
		);
		expect(config.functions).toEqual([
			{
				name: "csv",
				source: { type: "platform", package: "csv-tools" },
				default_policy: "allow",
				tools: [{ name: "parse", policy: "deny" }],
				timeout_secs: 300,
				network: { type: "none" },
				http_credentials: [],
			},
			{
				name: "files",
				source: { type: "platform", package: "files" },
				default_policy: "allow",
				tools: [],
				timeout_secs: null,
				network: { type: "none" },
				http_credentials: [],
			},
		]);
		expect(config.volume).toEqual({ data: { type: "enabled" } });
	});

	it("reads a function grant's network and credential origins", () => {
		const grant = (network: unknown, http_credentials?: unknown) => ({
			name: "web",
			source: { type: "platform", package: "http" },
			default_policy: "allow",
			network,
			http_credentials,
		});
		const config = readAgentConfig(
			stored({
				model: sonnet,
				functions: [
					grant({ type: "allowlist", hosts: ["api.example.com", "*.example.org"] }, ["https://api.example.com"]),
					grant({ type: "unrestricted" }),
					grant({ type: "none" }),
				],
			}),
		);
		expect(config.functions.map(({ network, http_credentials }) => ({ network, http_credentials }))).toEqual([
			{
				network: { type: "allowlist", hosts: ["api.example.com", "*.example.org"] },
				http_credentials: ["https://api.example.com"],
			},
			{ network: { type: "unrestricted" }, http_credentials: [] },
			{ network: { type: "none" }, http_credentials: [] },
		]);
		expect(failure({ model: sonnet, functions: [grant({ type: "proxy" })] }).path).toBe("functions[0].network.type");
		expect(failure({ model: sonnet, functions: [grant({ type: "none", hosts: [] })] }).path).toBe(
			"functions[0].network.hosts",
		);
		expect(failure({ model: sonnet, functions: [grant({ type: "allowlist", hosts: [1] })] }).path).toBe(
			"functions[0].network.hosts[0]",
		);
		expect(failure({ model: sonnet, functions: [grant({ type: "unrestricted" }, "https://a.example")] }).path).toBe(
			"functions[0].http_credentials",
		);
	});

	it("reads a workspace function source with its version pin", () => {
		const config = readAgentConfig(
			stored({
				model: sonnet,
				functions: [
					{
						name: "csv",
						source: { type: "workspace", function_id: "fn1", version: { type: "pinned", number: 2 } },
						default_policy: "allow",
					},
					{
						name: "latest",
						source: { type: "workspace", function_id: "fn2", version: { type: "latest" } },
						default_policy: "deny",
					},
				],
			}),
		);
		expect(config.functions.map((grant) => grant.source)).toEqual([
			{ type: "workspace", function_id: "fn1", version: { type: "pinned", number: 2 } },
			{ type: "workspace", function_id: "fn2", version: { type: "latest" } },
		]);
	});

	it("refuses a function source it cannot spell, and a volume it cannot spell", () => {
		const grant = (source: unknown) => ({ name: "csv", source, default_policy: "allow" });
		const platform = { type: "platform", package: "csv-tools" };
		expect(failure({ model: sonnet, functions: [grant({ type: "remote", package: "x" })] }).path).toBe(
			"functions[0].source.type",
		);
		expect(failure({ model: sonnet, functions: [grant({ ...platform, function_id: "fn1" })] }).path).toBe(
			"functions[0].source.function_id",
		);
		expect(
			failure({
				model: sonnet,
				functions: [grant({ type: "workspace", function_id: "fn1", version: { type: "pinned", number: 0 } })],
			}).path,
		).toBe("functions[0].source.version.number");
		expect(failure({ model: sonnet, functions: [grant({ type: "workspace", function_id: "fn1" })] }).path).toBe(
			"functions[0].source.version",
		);
		expect(failure({ model: sonnet, functions: [{ ...grant(platform), timeout_secs: 0 }] }).path).toBe(
			"functions[0].timeout_secs",
		);
		expect(failure({ model: sonnet, volume: { data: { type: "readonly" } } }).path).toBe("volume.data.type");
		expect(failure({ model: sonnet, volume: { size: 1 } }).path).toBe("volume.size");
	});

	it("reads the display-name setting under builtin, absent as never", () => {
		for (const when of ["never", "empty", "until_user_edits"] as const) {
			expect(readAgentConfig(stored({ model: sonnet, builtin: { session_display_name: { when } } })).builtin).toEqual({
				session_display_name: { when },
			});
		}
		expect(readAgentConfig(stored({ model: sonnet, builtin: {} })).builtin).toEqual({
			session_display_name: { when: "never" },
		});
		expect(failure({ model: sonnet, builtin: { session_display_name: null } }).path).toBe(
			"builtin.session_display_name",
		);
		expect(failure({ model: sonnet, builtin: { session_display_name: { when: "always" } } }).path).toBe(
			"builtin.session_display_name.when",
		);
		expect(failure({ model: sonnet, builtin: { subagent: {} } }).path).toBe("builtin.subagent");
		expect(failure({ model: sonnet, session_display_name: { when: "empty" } }).path).toBe("session_display_name");
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
			image_input: null,
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
					config: {
						model: "gpt-5",
						max_tokens: 8192,
						context_window: 200000,
						image_input: "unsupported",
						reasoning_effort: "medium",
					},
				},
			}),
		);
		expect(openai.model).toEqual({
			format: "openai_responses",
			model: "gpt-5",
			max_tokens: 8192,
			context_window: 200000,
			image_input: "unsupported",
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
				image_input: null,
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
			builtin: { session_display_name: { when: "never" } },
			functions: [],
			volume: { data: { type: "disabled" } },
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
