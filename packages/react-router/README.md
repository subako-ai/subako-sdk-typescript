# @subako-ai/react-router

[React Router](https://reactrouter.com) as a `navigateTool` spec for
`@subako-ai/tools`: the app names the routes, `useNavigate()` is the move, and
`useLocation()` is the read back.

Requires **React Router 6.4 or newer** and **Node 22 or newer** for the build.
The package is **ESM only**.

```sh
pnpm add @subako-ai/react-router @subako-ai/tools
```

## `fromReactRouter`

```tsx
import { useTool } from "@subako-ai/react";
import { fromReactRouter } from "@subako-ai/react-router";
import { navigateTool } from "@subako-ai/tools";
import { useRef } from "react";
import { useLocation, useNavigate } from "react-router";

function App() {
	const navigate = useNavigate();
	const { pathname } = useLocation();

	// Where the app is now, read when the model asks rather than when the tool was built.
	const here = useRef(pathname);
	here.current = pathname;

	useTool(
		client,
		"navigate",
		navigateTool(
			fromReactRouter({
				navigate,
				location: () => here.current,
				routes: [
					{ to: "/documents", description: "Every document" },
					{ to: "/documents/:id", description: "One document" },
				],
			}),
		),
	);

	return null;
}
```

**The app names its own routes.** Neither the `<Routes>` style nor the
file-based one keeps a registry to read at runtime, so there is nothing to
enumerate — and naming them is worth doing anyway, because it is the allowlist:
the model can only reach a page you listed, with the description you gave it.

A route's path parameters come from its path, so `/documents/:id` needs no
`params` of its own. Declare them only to say one is a number.

The binding builds the path it navigates to: React Router's `navigate()` takes
`/documents/7`, not `/documents/:id` and `{ id: "7" }`. Values are escaped on the
way in. A splat is not a destination a model can name, and neither is an
optional segment (`:id?`) — the binding does not elide it, so both are refused
when the binding is built; list the concrete variants as separate routes
instead.

`location` is optional. Without it the answer is the path the binding just
built, which is still a place — unlike the pattern `navigateTool` would
otherwise report.

**Read it live.** `location` is called when the model asks, which can be many
renders after the tool was built, and `useLocation()` answers with a new object
every render. Close over one — `location: () => location.pathname` — and the
binding reports the page the app was on when the tool was declared: the model
navigates, is told it is still where it started, and navigates again. The ref
above always holds the current render's path, so the read is live whether or not
the tool is memoized. `window.location.pathname` works too, minus the router's
`basename` if it has one.

## `routesOf`

For a data router, where the route objects do exist:

```ts
import { createBrowserRouter } from "react-router";
import { fromReactRouter, routesOf } from "@subako-ai/react-router";

const router = createBrowserRouter(routeObjects);
fromReactRouter({
	navigate: (to) => router.navigate(to),
	routes: routesOf(routeObjects),
});
```

It flattens the tree, joining a child's path onto its parent's unless the child
opens with a slash. A pathless layout route is not a destination, and neither
is a splat or an optional segment: all three are dropped, and what sits under
them is kept. An `index: true` route has no path of its own either, and needs
none — the parent's path already reaches it. Descriptions are yours to add
afterwards — the route objects carry none.
