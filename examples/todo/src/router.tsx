import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { isTab, type Tab } from "./app";
import { RootLayout } from "./routes/root";
import { SettingsPage } from "./routes/settings";
import { TodoPage } from "./routes/todo";
import { TodosPage } from "./routes/todos";

const rootRoute = createRootRoute({ component: RootLayout });

const todosRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	component: TodosPage,
	// The tab is React state, and the url carries it too, so `navigate` can land on one.
	validateSearch: (search: Record<string, unknown>): { tab?: Tab } => {
		const tab = search["tab"];
		return isTab(tab) ? { tab } : {};
	},
});

const todoRoute = createRoute({ getParentRoute: () => rootRoute, path: "/todos/$todoId", component: TodoPage });

const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage });

export const router = createRouter({
	routeTree: rootRoute.addChildren([todosRoute, todoRoute, settingsRoute]),
	defaultPreload: false,
});

/** What `fromTanStackRouter` and `switch_tab` are handed, spelled once so nothing imports the router for its type. */
export type DemoRouter = typeof router;

declare module "@tanstack/react-router" {
	interface Register {
		router: DemoRouter;
	}
}
