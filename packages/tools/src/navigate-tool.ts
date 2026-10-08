import type { ToolDefinition } from "@subako-ai/sdk";
import { isBlank, isRecord, type JsonSchema } from "./schema.js";

/** What a path parameter carries; anything richer is not a path parameter. */
export type RouteParamType = "string" | "number";

/** One destination the model may name, and what the path needs to be built. */
export interface RouteSpec {
	/** The route's path, as the app's router spells it: `/users/$userId`, say. */
	readonly to: string;
	/** What is on the page, as the model reads it. */
	readonly description?: string;
	/** The path parameters, keyed by name; every one of them is needed to navigate. */
	readonly params?: Readonly<Record<string, RouteParamType>>;
}

/** What an adapter contributes to a `navigateTool`: where it can go, and how. */
export interface NavigateSource {
	/** The allowlist: nothing outside it reaches `navigate`. */
	readonly routes: readonly RouteSpec[];
	navigate(to: string, params?: Record<string, string | number>): void | Promise<unknown>;
	/** Where the app ended up, answered with; `to` stands in when it is absent. */
	read?(): { readonly location: string };
}

export interface NavigateToolSpec extends NavigateSource {
	readonly description?: string;
}

const DEFAULT_DESCRIPTION = "Go to a page of this app.";

/** The parameters of every route in one object; the chosen route's own are checked when the call arrives. */
function paramProperties(routes: readonly RouteSpec[]): Record<string, JsonSchema> | undefined {
	const properties: Record<string, JsonSchema> = {};
	for (const route of routes) {
		for (const [name, type] of Object.entries(route.params ?? {})) {
			const known = properties[name];
			// One name declared twice with two types is described as the wider of the two.
			properties[name] = known !== undefined && known["type"] !== type ? { type: "string" } : { type };
		}
	}
	return Object.keys(properties).length === 0 ? undefined : properties;
}

function parametersOf(routes: readonly RouteSpec[]): JsonSchema {
	const params = paramProperties(routes);
	const properties: Record<string, JsonSchema> = {
		to: { type: "string", enum: routes.map((route) => route.to), description: "The route to go to." },
	};
	if (params !== undefined) {
		properties["params"] = {
			type: "object",
			description: "The path parameters the chosen route needs.",
			properties: params,
			additionalProperties: false,
		};
	}
	return { type: "object", properties, required: ["to"], additionalProperties: false };
}

function describeRoutes(routes: readonly RouteSpec[]): string {
	return routes
		.map((route) => {
			const params = Object.entries(route.params ?? {}).map(([name, type]) => `${name} (${type})`);
			const takes = params.length === 0 ? "" : ` — takes ${params.join(", ")}`;
			const about = route.description === undefined ? "" : ` — ${route.description}`;
			return `- ${route.to}${about}${takes}`;
		})
		.join("\n");
}

/** What the call named, or the reason it named nothing this router can go to. */
type Chosen =
	| { readonly ok: true; readonly to: string; readonly params: Record<string, string | number> }
	| { readonly ok: false; readonly message: string };

function choose(routes: readonly RouteSpec[], args: unknown): Chosen {
	if (!isRecord(args)) {
		return { ok: false, message: "the arguments must be an object naming a route" };
	}
	const to = args["to"];
	if (typeof to !== "string") {
		return { ok: false, message: "`to` must name one of this app's routes" };
	}
	const route = routes.find((candidate) => candidate.to === to);
	if (route === undefined) {
		return { ok: false, message: `this app has no route ${to}; it has ${routes.map((r) => r.to).join(", ")}` };
	}
	const given = args["params"];
	if (given !== undefined && !isRecord(given)) {
		return { ok: false, message: "`params` must be an object of path parameters" };
	}
	const supplied: Record<string, unknown> = given ?? {};
	const params: Record<string, string | number> = {};
	for (const [name, type] of Object.entries(route.params ?? {})) {
		const value = supplied[name];
		if (type === "string" && typeof value === "string") {
			params[name] = value;
			continue;
		}
		if (type === "number" && typeof value === "number") {
			params[name] = value;
			continue;
		}
		return { ok: false, message: `${to} needs a ${type} ${name}` };
	}
	for (const [name, value] of Object.entries(supplied)) {
		// `params` describes every route's parameters at once, and a provider whose schema is
		// strict — openai_responses among them — makes the model fill each one. A blank for a
		// parameter this route does not take is that, not a mistake, so it is dropped.
		if (route.params?.[name] === undefined && !isBlank(value)) {
			return { ok: false, message: `${to} takes no path parameter named ${name}` };
		}
	}
	return { ok: true, to, params };
}

/** The app's own routes as one tool; `routes` is the allowlist, so an external URL is not a destination. */
export function navigateTool(spec: NavigateToolSpec): ToolDefinition {
	const routes = spec.routes;
	if (routes.length === 0) {
		throw new TypeError("navigateTool: list at least one route the model may go to");
	}
	const head = spec.description ?? DEFAULT_DESCRIPTION;
	return {
		description: `${head}\n\nRoutes:\n${describeRoutes(routes)}`,
		parameters: parametersOf(routes),
		execute: async (args) => {
			const chosen = choose(routes, args);
			if (!chosen.ok) {
				return { text: chosen.message, is_error: true };
			}
			await spec.navigate(chosen.to, chosen.params);
			return JSON.stringify(spec.read?.() ?? { location: chosen.to });
		},
	};
}
