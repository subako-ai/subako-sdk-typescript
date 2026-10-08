import type { NavigateSource, RouteParamType, RouteSpec } from "@subako-ai/tools";
import type { AnyRouter } from "@tanstack/react-router";

/** TanStack spells a path parameter `$name`, and every one of them is a string. */
const PARAM = /\$([A-Za-z0-9_]+)/g;

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

/** Every route with a path of its own; the root and a pathless layout route are not destinations. */
function routesOf(router: AnyRouter): RouteSpec[] {
	const found = new Map<string, RouteSpec>();
	for (const route of Object.values(router.routesById)) {
		if (route.isRoot === true || route.path === undefined) {
			continue;
		}
		const to: unknown = route.fullPath;
		if (typeof to !== "string" || to === "" || found.has(to)) {
			continue;
		}
		const params = paramsOf(to);
		found.set(to, params === undefined ? { to } : { to, params });
	}
	return [...found.values()].sort((left, right) => left.to.localeCompare(right.to));
}

/** A TanStack router as a `navigateTool` spec: the route tree, `router.navigate`, and the current pathname. */
export function fromTanStackRouter(router: AnyRouter): NavigateSource {
	return {
		routes: routesOf(router),
		navigate: async (to, params) => {
			await router.navigate({ to, params });
		},
		read: () => ({ location: router.state.location.pathname }),
	};
}
