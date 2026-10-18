/**
 * A published version's config, in the shape publishing takes. Core writes
 * every field of a version's `config` out, lists empty and settings
 * `null` where nothing is set, but the spec shares that schema with the
 * publish body, where every field may be left out; this names what Core
 * answers.
 */
import type * as api from "./generated/index.js";

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

/** Reads the config `version` was published with, as `publishVersion` takes one. */
export function readAgentConfig(version: Pick<api.AgentVersionBody, "config">): AgentVersionConfig {
	return version.config as AgentVersionConfig;
}
