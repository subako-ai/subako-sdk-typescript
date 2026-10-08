import type { NavigateSource, RouteParamType, RouteSpec } from "@subako-ai/tools";

/** React Router spells a path parameter `:name`, and every one of them is a string. */
const PARAM = /:([A-Za-z0-9_]+)/g;

/** What a path says it takes; a route that declared its own parameters keeps them. */
function paramsOf(path: string): Readonly<Record<string, RouteParamType>> | undefined {
	const params: Record<string, RouteParamType> = {};
	for (const match of path.matchAll(PARAM)) {
		const name = match[1];
		if (name !== undefined) {
			params[name] = "string";
		}
	}
	return Object.keys(params).length === 0 ? undefined : params;
}

/** `/documents/:id` and `{ id: "7" }` make `/documents/7`; React Router navigates to a built path. */
function pathOf(to: string, params: Record<string, string | number>): string {
	return to.replace(PARAM, (whole, name: string) => {
		const value = params[name];
		return value === undefined ? whole : encodeURIComponent(String(value));
	});
}

/** The shape of a data router's route objects, as much of it as this needs. */
export interface RouteObjectLike {
	readonly path?: string;
	readonly index?: boolean;
	readonly children?: readonly RouteObjectLike[];
}

/** What an app hands the binding: how to go, where it may go, and where it is. */
export interface ReactRouterSource {
	/** What `useNavigate()` answers with. */
	navigate(to: string): void | Promise<unknown>;
	/** The routes the model may name, as the app spells them: `/documents/:id`. */
	readonly routes: readonly RouteSpec[];
	/**
	 * Where the app is now. It is called when the model asks, not when the tool is
	 * built, so it has to read the live value: `useLocation()` answers with a new
	 * object every render, and closing over one leaves the binding reporting the
	 * page the app was on when the tool was declared.
	 */
	location?(): string;
}

/**
 * React Router as a `navigateTool` spec. Neither the `<Routes>` style nor the file-based one
 * keeps a route registry to read at runtime, so the routes are the ones the app names here.
 */
export function fromReactRouter(source: ReactRouterSource): NavigateSource {
	for (const route of source.routes) {
		if (route.to.includes("*")) {
			throw new TypeError(`fromReactRouter: ${route.to} is a splat, which is not a destination a model can name`);
		}
		if (route.to.includes("?")) {
			throw new TypeError(
				`fromReactRouter: ${route.to} has an optional segment, which is not a destination this binding builds; list the concrete variants instead`,
			);
		}
	}
	const routes = source.routes.map((route) => {
		if (route.params !== undefined) {
			return route;
		}
		const params = paramsOf(route.to);
		return params === undefined ? route : { ...route, params };
	});
	// Where the last navigation went, so the answer is a path even when the app reads nothing back.
	let went = "";
	return {
		routes,
		navigate: async (to, params) => {
			went = pathOf(to, params ?? {});
			await source.navigate(went);
		},
		read: () => ({ location: source.location?.() ?? went }),
	};
}

/** A child's path is relative unless it opens with a slash, which is React Router's own rule. */
const join = (base: string, path: string): string =>
	path.startsWith("/") ? path : `${base.endsWith("/") ? base.slice(0, -1) : base}/${path}`;

/**
 * A `createBrowserRouter` route tree, flattened into the specs `navigateTool` takes. A pathless
 * layout is not a destination, and neither is a splat or an optional segment, so all three are
 * dropped and what is under them is kept. An `index: true` route has no `path` of its own
 * either, and needs none: the parent's path already reaches it.
 */
export function routesOf(routes: readonly RouteObjectLike[]): RouteSpec[] {
	const found = new Map<string, RouteSpec>();
	const walk = (list: readonly RouteObjectLike[], base: string): void => {
		for (const route of list) {
			const here = route.path === undefined ? base : join(base, route.path);
			if (route.path !== undefined && !here.includes("*") && !here.includes("?")) {
				const params = paramsOf(here);
				found.set(here, params === undefined ? { to: here } : { to: here, params });
			}
			if (route.children !== undefined) {
				walk(route.children, here);
			}
		}
	};
	walk(routes, "");
	return [...found.values()].sort((left, right) => left.to.localeCompare(right.to));
}
