import type { RouteSpec } from "@subako-ai/tools";
import { describe, expect, it } from "vitest";
import { fromReactRouter, routesOf } from "../src/index.js";

const routes: readonly RouteSpec[] = [
	{ to: "/", description: "The dashboard" },
	{ to: "/documents" },
	{ to: "/documents/:id" },
];

/** A source whose `navigate` records where it was sent. */
function recording(location?: () => string) {
	const went: string[] = [];
	const source = fromReactRouter({
		navigate: (to) => {
			went.push(to);
		},
		routes,
		...(location === undefined ? {} : { location }),
	});
	return { went, source };
}

describe("fromReactRouter", () => {
	it("takes a route's path parameters from its path", () => {
		expect(recording().source.routes).toEqual([
			{ to: "/", description: "The dashboard" },
			{ to: "/documents" },
			{ to: "/documents/:id", params: { id: "string" } },
		]);
	});

	it("leaves the parameters a route declared for itself", () => {
		const source = fromReactRouter({
			navigate: () => undefined,
			routes: [{ to: "/pages/:page", params: { page: "number" } }],
		});

		expect(source.routes).toEqual([{ to: "/pages/:page", params: { page: "number" } }]);
	});

	it("navigates to a built path rather than to the pattern", async () => {
		const { went, source } = recording();

		await source.navigate("/documents/:id", { id: "7" });

		expect(went).toEqual(["/documents/7"]);
	});

	it("escapes what it puts in the path", async () => {
		const { went, source } = recording();

		await source.navigate("/documents/:id", { id: "a b/c" });

		expect(went).toEqual(["/documents/a%20b%2Fc"]);
	});

	it("reads where the app says it is", async () => {
		const { source } = recording(() => "/documents/7");

		await source.navigate("/documents/:id", { id: "7" });

		expect(source.read?.()).toEqual({ location: "/documents/7" });
	});

	it("falls back to the path it built when the app does not say", async () => {
		const { source } = recording();

		await source.navigate("/documents/:id", { id: "7" });

		// `navigateTool` would otherwise answer with the pattern, which is not a place.
		expect(source.read?.()).toEqual({ location: "/documents/7" });
	});

	it("refuses a splat, which is not a destination a model can name", () => {
		expect(() => fromReactRouter({ navigate: () => undefined, routes: [{ to: "/reports/*" }] })).toThrow(/splat/);
	});

	it("refuses an optional segment, which is not a destination this binding builds", () => {
		expect(() => fromReactRouter({ navigate: () => undefined, routes: [{ to: "/docs/:id?/edit" }] })).toThrow(
			/optional segment/,
		);
	});
});

describe("routesOf", () => {
	it("flattens a data router's route objects into paths", () => {
		expect(
			routesOf([
				{
					path: "/",
					children: [{ path: "documents", children: [{ path: ":id" }] }, { path: "settings" }],
				},
			]),
		).toEqual([
			{ to: "/" },
			{ to: "/documents" },
			{ to: "/documents/:id", params: { id: "string" } },
			{ to: "/settings" },
		]);
	});

	it("keeps what is under a pathless layout, and drops the layout itself", () => {
		expect(routesOf([{ children: [{ path: "/inbox" }] }])).toEqual([{ to: "/inbox" }]);
	});

	it("takes an absolute child path as it is", () => {
		expect(routesOf([{ path: "/t", children: [{ path: "/documents" }] }])).toEqual([
			{ to: "/documents" },
			{ to: "/t" },
		]);
	});

	it("drops a splat, which is not a destination a model can name", () => {
		expect(routesOf([{ path: "/reports", children: [{ path: "*" }] }])).toEqual([{ to: "/reports" }]);
	});

	it("drops an optional segment, which is not a destination this binding builds", () => {
		expect(routesOf([{ path: "/docs", children: [{ path: ":id?" }] }])).toEqual([{ to: "/docs" }]);
	});

	it("covers an index route with its parent's path, and drops the index route itself", () => {
		expect(routesOf([{ path: "/dashboard", children: [{ index: true }] }])).toEqual([{ to: "/dashboard" }]);
	});
});
