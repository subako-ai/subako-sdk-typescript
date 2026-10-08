import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";
import { fromTanStackRouter } from "../src/index.js";

describe("fromTanStackRouter", () => {
	const root = createRootRoute();
	const index = createRoute({ getParentRoute: () => root, path: "/" });
	const users = createRoute({ getParentRoute: () => root, path: "/users/$userId" });
	const layout = createRoute({ getParentRoute: () => root, id: "_layout" });
	const settings = createRoute({ getParentRoute: () => layout, path: "/settings" });
	const routeTree = root.addChildren([index, users, layout.addChildren([settings])]);

	it("enumerates the route tree, skipping the root and the pathless layout", () => {
		const router = createRouter({ routeTree });

		expect(fromTanStackRouter(router).routes).toEqual([
			{ to: "/" },
			{ to: "/settings" },
			{ to: "/users/$userId", params: { userId: "string" } },
		]);
	});

	it("navigates through the router, and reads the current pathname", async () => {
		const router = createRouter({ routeTree });
		const moved = vi.spyOn(router, "navigate").mockResolvedValue(undefined);
		const source = fromTanStackRouter(router);

		await source.navigate("/users/$userId", { userId: "7" });

		expect(moved).toHaveBeenCalledWith({ to: "/users/$userId", params: { userId: "7" } });
		expect(source.read?.()).toEqual({ location: router.state.location.pathname });
	});
});
