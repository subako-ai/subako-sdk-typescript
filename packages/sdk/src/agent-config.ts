/**
 * A published version's config, read back in the shape publishing takes. Core
 * answers a version's config as it stored it, unread, so the spec can only
 * call it an object, and it spells the model `{ format, config: { ... } }`
 * where publishing takes `{ format, ... }`. This reads every field, and
 * refuses anything publishing has no spelling for, so publishing what it
 * answers publishes the same config again.
 */
import type * as api from "./generated/index.js";
import {
	AnthropicEffortBody,
	DisplayNameWhenBody,
	ImageInputBody,
	PolicyActionBody,
	ReasoningEffortBody,
} from "./generated/index.js";

/** `T` with every field present: a list left out is empty, a setting left out `null`. */
type Present<T> = { [K in keyof T]-?: Exclude<T[K], undefined> };

/** A version's config with every field present, which publishing takes as it is. */
export type AgentVersionConfig = Present<
	Omit<api.AgentConfigBody, "model" | "mcp" | "sandboxes" | "builtin" | "functions" | "volume">
> & {
	model: Present<api.ModelConfigBody>;
	mcp: Present<api.McpGrantBody>[];
	sandboxes: Present<api.SandboxGrantBody>[];
	builtin: Present<api.BuiltinGrantsBody>;
	functions: Present<api.FunctionGrantBody>[];
	volume: Present<api.VolumeConfigBody>;
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
	const config = record(version.config, "", [
		"system_prompt",
		"model",
		"mcp",
		"skills",
		"sandboxes",
		"builtin",
		"functions",
		"volume",
	]);
	return {
		system_prompt: optional(config["system_prompt"], (prompt) => string(prompt, "system_prompt")),
		model: readModel(config["model"], "model"),
		mcp: list(config["mcp"], "mcp", readMcp),
		skills: list(config["skills"], "skills", readSkill),
		sandboxes: list(config["sandboxes"], "sandboxes", readSandbox),
		builtin: readBuiltin(config["builtin"], "builtin"),
		functions: list(config["functions"], "functions", readFunction),
		volume: readVolume(config["volume"], "volume"),
	};
}

const POLICIES = Object.values(PolicyActionBody);
const REASONING_EFFORTS = Object.values(ReasoningEffortBody);
const ANTHROPIC_EFFORTS = Object.values(AnthropicEffortBody);
const IMAGE_INPUTS = Object.values(ImageInputBody);
const DISPLAY_NAME_WHENS = Object.values(DisplayNameWhenBody);

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
				"image_input",
				"thinking",
				"effort",
			]);
			return {
				format,
				model: string(settings["model"], at(settingsPath, "model")),
				max_tokens: count(settings["max_tokens"], at(settingsPath, "max_tokens")),
				context_window: count(settings["context_window"], at(settingsPath, "context_window")),
				image_input: readImageInput(settings["image_input"], at(settingsPath, "image_input")),
				thinking: optional(settings["thinking"], (thinking) => readThinking(thinking, at(settingsPath, "thinking"))),
				effort: optional(settings["effort"], (effort) => oneOf(effort, at(settingsPath, "effort"), ANTHROPIC_EFFORTS)),
			};
		}
		case "openai_responses": {
			const settings = record(model["config"], settingsPath, [
				"model",
				"max_tokens",
				"context_window",
				"image_input",
				"reasoning_effort",
			]);
			return {
				format,
				model: string(settings["model"], at(settingsPath, "model")),
				max_tokens: count(settings["max_tokens"], at(settingsPath, "max_tokens")),
				context_window: count(settings["context_window"], at(settingsPath, "context_window")),
				image_input: readImageInput(settings["image_input"], at(settingsPath, "image_input")),
				reasoning_effort: optional(settings["reasoning_effort"], (effort) =>
					oneOf(effort, at(settingsPath, "reasoning_effort"), REASONING_EFFORTS),
				),
			};
		}
		default:
			return format satisfies never;
	}
}

/** Core stores only an `unsupported` model, leaving the setting out for one that reads images. */
function readImageInput(value: unknown, path: string): api.ImageInputBody | null {
	return optional(value, (setting) => oneOf(setting, path, IMAGE_INPUTS));
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

/** A config published before a builtin setting existed leaves it out, and it reads as its default. */
function readBuiltin(value: unknown, path: string): Present<api.BuiltinGrantsBody> {
	const grants = value === undefined ? {} : record(value, path, ["session_display_name"]);
	const displayName = grants["session_display_name"];
	return {
		session_display_name:
			displayName === undefined
				? { when: "never" }
				: readSessionDisplayName(displayName, at(path, "session_display_name")),
	};
}

function readSessionDisplayName(value: unknown, path: string): api.SessionDisplayNameGrantBody {
	const grant = record(value, path, ["when"]);
	return { when: oneOf(grant["when"], at(path, "when"), DISPLAY_NAME_WHENS) };
}

function readFunctionSource(value: unknown, path: string): api.FunctionSourceBody {
	const source = record(value, path, ["type", "package", "function_id", "version"]);
	const type = oneOf(source["type"], at(path, "type"), ["platform", "workspace"] as const);
	switch (type) {
		case "platform":
			record(value, path, ["type", "package"]);
			return { type, package: string(source["package"], at(path, "package")) };
		case "workspace":
			record(value, path, ["type", "function_id", "version"]);
			return {
				type,
				function_id: string(source["function_id"], at(path, "function_id")),
				version: readVersionPin(source["version"], at(path, "version")),
			};
		default:
			return type satisfies never;
	}
}

/** Core leaves a function grant's network out when it is `none`. */
function readFunctionNetwork(value: unknown, path: string): api.FunctionNetworkBody {
	if (value === undefined) {
		return { type: "none" };
	}
	const network = record(value, path, ["type", "hosts"]);
	const type = oneOf(network["type"], at(path, "type"), ["none", "unrestricted", "allowlist"] as const);
	switch (type) {
		case "none":
		case "unrestricted":
			record(value, path, ["type"]);
			return { type };
		case "allowlist":
			return { type, hosts: list(network["hosts"], at(path, "hosts"), string) };
		default:
			return type satisfies never;
	}
}

function readFunction(value: unknown, path: string): Present<api.FunctionGrantBody> {
	const grant = record(value, path, [
		"name",
		"source",
		"default_policy",
		"tools",
		"timeout_secs",
		"network",
		"http_credentials",
	]);
	return {
		name: string(grant["name"], at(path, "name")),
		source: readFunctionSource(grant["source"], at(path, "source")),
		default_policy: oneOf(grant["default_policy"], at(path, "default_policy"), POLICIES),
		tools: readTools(grant["tools"], at(path, "tools")),
		timeout_secs: optional(grant["timeout_secs"], (secs) => count(secs, at(path, "timeout_secs"), 1)),
		network: readFunctionNetwork(grant["network"], at(path, "network")),
		http_credentials: list(grant["http_credentials"], at(path, "http_credentials"), string),
	};
}

const VOLUME_DATA = ["disabled", "enabled"] as const;

/** A config published before the volume existed leaves it out, and it reads as its default: no `/volume/data`. */
function readVolume(value: unknown, path: string): Present<api.VolumeConfigBody> {
	const volume = value === undefined ? {} : record(value, path, ["data"]);
	const data = volume["data"];
	if (data === undefined) {
		return { data: { type: "disabled" } };
	}
	const dataPath = at(path, "data");
	return {
		data: {
			type: oneOf(record(data, dataPath, ["type"])["type"], at(dataPath, "type"), VOLUME_DATA),
		},
	};
}
