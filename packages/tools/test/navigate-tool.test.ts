import type { ToolCall } from "@subako-ai/sdk";
import { describe, expect, it } from "vitest";
import { navigateTool, type RouteSpec } from "../src/index.js";

const call: ToolCall = { callId: "call-1", signal: new AbortController().signal };

const routes: readonly RouteSpec[] = [
	{ to: "/", description: "The dashboard" },
	{ to: "/contact" },
	{ to: "/users/$userId", params: { userId: "string" } },
];

interface Move {
	readonly to: string;
	readonly params: Record<string, string | number> | undefined;
}

function tool(moves: Move[], read?: () => { location: string }) {
	return navigateTool({
		routes,
		navigate: (to, params) => {
			moves.push({ to, params });
		},
		...(read === undefined ? {} : { read }),
	});
}

describe("navigateTool", () => {
	it("makes the routes an enum and the path parameters one object", () => {
		const moves: Move[] = [];

		expect(tool(moves).parameters).toEqual({
			type: "object",
			additionalProperties: false,
			required: ["to"],
			properties: {
				to: {
					type: "string",
					enum: ["/", "/contact", "/users/$userId"],
					description: "The route to go to.",
				},
				params: {
					type: "object",
					description: "The path parameters the chosen route needs.",
					additionalProperties: false,
					properties: { userId: { type: "string" } },
				},
			},
		});
		expect(tool(moves).description).toContain("- / — The dashboard");
		expect(tool(moves).description).toContain("- /users/$userId — takes userId (string)");
	});

	it("navigates, and answers with where the app ended up", async () => {
		const moves: Move[] = [];
		const navigate = tool(moves, () => ({ location: "/users/7" }));

		expect(await navigate.execute({ to: "/users/$userId", params: { userId: "7" } }, call)).toBe(
			JSON.stringify({ location: "/users/7" }),
		);
		expect(moves).toEqual([{ to: "/users/$userId", params: { userId: "7" } }]);
		expect(await tool(moves).execute({ to: "/contact" }, call)).toBe(JSON.stringify({ location: "/contact" }));
	});

	it("refuses a route the app does not have, and a parameter it does not take", async () => {
		const moves: Move[] = [];
		const navigate = tool(moves);

		expect(await navigate.execute({ to: "https://example.com" }, call)).toEqual({
			text: "this app has no route https://example.com; it has /, /contact, /users/$userId",
			is_error: true,
		});
		expect(await navigate.execute({ to: "/users/$userId" }, call)).toEqual({
			text: "/users/$userId needs a string userId",
			is_error: true,
		});
		expect(await navigate.execute({ to: "/contact", params: { userId: "7" } }, call)).toEqual({
			text: "/contact takes no path parameter named userId",
			is_error: true,
		});
		expect(moves).toEqual([]);
	});

	it("ignores a blank path parameter the chosen route does not take", async () => {
		const moves: Move[] = [];
		const navigate = tool(moves);

		// A strict schema — openai_responses among them — makes the model fill every property of
		// `params`, so a route with none of its own arrives carrying the other routes' names, blank.
		expect(await navigate.execute({ to: "/contact", params: { userId: "" } }, call)).toBe(
			JSON.stringify({ location: "/contact" }),
		);
		expect(moves).toEqual([{ to: "/contact", params: {} }]);
	});

	it("wants at least one route", () => {
		expect(() => navigateTool({ routes: [], navigate: () => undefined })).toThrow(/at least one route/);
	});
});
