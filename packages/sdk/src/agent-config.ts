/**
 * A published version's config, read back in the shape publishing takes. Core
 * answers a version's config as it stored it, unread, so the spec can only
 * call it an object, and it spells the model `{ format, config: { ... } }`
 * where publishing takes `{ format, ... }`. This reads every field, and
 * refuses anything publishing has no spelling for, so publishing what it
 * answers publishes the same config again.
 */
import type * as api from "./generated/index.js";
import { AnthropicEffortBody, PolicyActionBody, ReasoningEffortBody } from "./generated/index.js";

/** `T` with every field present: a list left out is empty, a setting left out `null`. */
type Present<T> = { [K in keyof T]-?: Exclude<T[K], undefined> };

/** A version's config with every field present, which publishing takes as it is. */
export type AgentVersionConfig = Present<Omit<api.AgentConfigBody, "model" | "mcp" | "sandboxes">> & {
	model: Present<api.ModelConfigBody>;
	mcp: Present<api.McpGrantBody>[];
	sandboxes: Present<api.SandboxGrantBody>[];
};

/**
 * A version's config holds something {@link readAgentConfig} cannot read:
 * a field publishing has no spelling for, or a value of the wrong shape. A
 * client older than the Core that published the version meets this.
 */
export class AgentConfigError extends Error {
	/** Where in the stored config reading stopped, as Core names a field: `mcp[0].default_policy`. */
	readonly path: string;

	constructor(path: string, problem: string) {
		super(`cannot read the agent config: ${path === "" ? "the config" : path} ${problem}`);
		this.name = new.target.name;
		this.path = path;
	}
}

/** Reads the config `version` was published with, as `publishVersion` takes one. */
export function readAgentConfig(version: Pick<api.AgentVersionBody, "config">): AgentVersionConfig {
	const config = record(version.config, "", ["system_prompt", "model", "mcp", "skills", "sandboxes"]);
	return {
		system_prompt: optional(config["system_prompt"], (prompt) => string(prompt, "system_prompt")),
		model: readModel(config["model"], "model"),
		mcp: list(config["mcp"], "mcp", readMcp),
		skills: list(config["skills"], "skills", readSkill),
		sandboxes: list(config["sandboxes"], "sandboxes", readSandbox),
	};
}

const POLICIES = Object.values(PolicyActionBody);
const REASONING_EFFORTS = Object.values(ReasoningEffortBody);
const ANTHROPIC_EFFORTS = Object.values(AnthropicEffortBody);

const at = (path: string, key: string | number): string =>
	typeof key === "number" ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`;

/** An object holding no field but `keys`. */
function record(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new AgentConfigError(path, "is not an object");
	}
	const unknown = Object.keys(value).find((key) => !keys.includes(key));
	if (unknown !== undefined) {
		throw new AgentConfigError(at(path, unknown), "is a field publishing has no spelling for");
	}
	return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
	if (typeof value !== "string") {
		throw new AgentConfigError(path, "is not a string");
	}
	return value;
}

/** A whole number no less than `min`, as Core's integer fields hold. */
function count(value: unknown, path: string, min = 0): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
		throw new AgentConfigError(path, `is not a whole number of at least ${min}`);
	}
	return value;
}

function oneOf<T extends string>(value: unknown, path: string, options: readonly T[]): T {
	const found = options.find((option) => option === value);
	if (found === undefined) {
		throw new AgentConfigError(path, `is not one of ${options.join(", ")}`);
	}
	return found;
}

/** Core leaves an unset setting out of the document; `null` is how this reads one. */
function optional<T>(value: unknown, read: (value: unknown) => T): T | null {
	return value === undefined || value === null ? null : read(value);
}

/** Core leaves an empty list out of the document, so an absent one is empty. */
function list<T>(value: unknown, path: string, read: (value: unknown, path: string) => T): T[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value)) {
		throw new AgentConfigError(path, "is not a list");
	}
	return value.map((item: unknown, index) => read(item, at(path, index)));
}

// CODESYNC(model-config-json-shape)
function readModel(value: unknown, path: string): Present<api.ModelConfigBody> {
	const model = record(value, path, ["format", "config"]);
	const format = oneOf(model["format"], at(path, "format"), ["anthropic", "openai_responses"] as const);
	const settingsPath = at(path, "config");
	switch (format) {
		case "anthropic": {
			const settings = record(model["config"], settingsPath, [
				"model",
				"max_tokens",
				"context_window",
				"thinking",
				"effort",
			]);
			return {
				format,
				model: string(settings["model"], at(settingsPath, "model")),
				max_tokens: count(settings["max_tokens"], at(settingsPath, "max_tokens")),
				context_window: count(settings["context_window"], at(settingsPath, "context_window")),
				thinking: optional(settings["thinking"], (thinking) => readThinking(thinking, at(settingsPath, "thinking"))),
				effort: optional(settings["effort"], (effort) => oneOf(effort, at(settingsPath, "effort"), ANTHROPIC_EFFORTS)),
			};
		}
		case "openai_responses": {
			const settings = record(model["config"], settingsPath, [
				"model",
				"max_tokens",
				"context_window",
				"reasoning_effort",
			]);
			return {
				format,
				model: string(settings["model"], at(settingsPath, "model")),
				max_tokens: count(settings["max_tokens"], at(settingsPath, "max_tokens")),
				context_window: count(settings["context_window"], at(settingsPath, "context_window")),
				reasoning_effort: optional(settings["reasoning_effort"], (effort) =>
					oneOf(effort, at(settingsPath, "reasoning_effort"), REASONING_EFFORTS),
				),
			};
		}
		default:
			return format satisfies never;
	}
}

/** Core stores a thinking mode as `{ type, config }`, where publishing spells its budget beside `type`. */
function readThinking(value: unknown, path: string): api.AnthropicThinkingBody {
	const thinking = record(value, path, ["type", "config"]);
	const type = oneOf(thinking["type"], at(path, "type"), ["adaptive", "disabled", "between_tools", "enabled"] as const);
	switch (type) {
		case "adaptive":
		case "disabled":
		case "between_tools":
			// Only a budget carries settings.
			record(value, path, ["type"]);
			return { type };
		case "enabled": {
			const configPath = at(path, "config");
			const budget = record(thinking["config"], configPath, ["budget_tokens"]);
			return { type, budget_tokens: count(budget["budget_tokens"], at(configPath, "budget_tokens")) };
		}
		default:
			return type satisfies never;
	}
}

function readTools(value: unknown, path: string): api.ToolRuleBody[] {
	return list(value, path, (rule, rulePath) => {
		const fields = record(rule, rulePath, ["name", "policy"]);
		return {
			name: string(fields["name"], at(rulePath, "name")),
			policy: oneOf(fields["policy"], at(rulePath, "policy"), POLICIES),
		};
	});
}

function readMcp(value: unknown, path: string): Present<api.McpGrantBody> {
	const grant = record(value, path, ["name", "url", "default_policy", "tools"]);
	return {
		name: string(grant["name"], at(path, "name")),
		url: string(grant["url"], at(path, "url")),
		default_policy: oneOf(grant["default_policy"], at(path, "default_policy"), POLICIES),
		tools: readTools(grant["tools"], at(path, "tools")),
	};
}

function readVersionPin(value: unknown, path: string): api.VersionPinBody {
	const pin = record(value, path, ["type", "number"]);
	const type = oneOf(pin["type"], at(path, "type"), ["latest", "pinned"] as const);
	switch (type) {
		case "latest":
			// A latest pin names no number.
			record(value, path, ["type"]);
			return { type };
		case "pinned":
			return { type, number: count(pin["number"], at(path, "number"), 1) };
		default:
			return type satisfies never;
	}
}

function readSkill(value: unknown, path: string): api.SkillGrantBody {
	const grant = record(value, path, ["name", "skill_id", "version"]);
	return {
		name: string(grant["name"], at(path, "name")),
		skill_id: string(grant["skill_id"], at(path, "skill_id")),
		version: readVersionPin(grant["version"], at(path, "version")),
	};
}

function readSandbox(value: unknown, path: string): Present<api.SandboxGrantBody> {
	const grant = record(value, path, ["name", "environment", "network", "default_policy", "tools"]);
	const environmentPath = at(path, "environment");
	// A workspace environment is a spelling Core stores and publishing does not take.
	const environment = record(grant["environment"], environmentPath, ["type", "release"]);
	const networkPath = at(path, "network");
	return {
		name: string(grant["name"], at(path, "name")),
		environment: {
			type: oneOf(environment["type"], at(environmentPath, "type"), ["platform"] as const),
			release: string(environment["release"], at(environmentPath, "release")),
		},
		// Core reads a sandbox stored without one as unrestricted.
		network:
			grant["network"] === undefined
				? { type: "unrestricted" }
				: {
						type: oneOf(record(grant["network"], networkPath, ["type"])["type"], at(networkPath, "type"), [
							"unrestricted",
							"none",
						] as const),
					},
		default_policy: oneOf(grant["default_policy"], at(path, "default_policy"), POLICIES),
		tools: readTools(grant["tools"], at(path, "tools")),
	};
}
