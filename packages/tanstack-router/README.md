# @subako-ai/tanstack-router

[TanStack Router](https://tanstack.com/router) as a `navigateTool` spec for
`@subako-ai/tools`: the route tree is the allowlist, `router.navigate` is the
move, and the current pathname is the answer.

Requires **`@tanstack/react-router` 1.100 or newer** and **Node 22 or newer**
for the build. The package is **ESM only**.

```sh
pnpm add @subako-ai/tanstack-router @subako-ai/tools
```

## `fromTanStackRouter`

```tsx
import { useTool } from "@subako-ai/react";
import { fromTanStackRouter } from "@subako-ai/tanstack-router";
import { navigateTool } from "@subako-ai/tools";

useTool(client, "navigate", navigateTool(fromTanStackRouter(router)));
```

`fromTanStackRouter(router)` answers with `routes`, `navigate` and `read`, which
is everything `navigateTool` takes; spread it and add a `description` when the
default one is not enough.

It walks `routesById`, skipping the root and any pathless layout route, and
carries every `$param` as a string parameter. Its `navigate` awaits
`router.navigate(...)`, so the tool answers once the route has actually
changed: the adapter owns the wait for the transition, so nothing in the app
has to. `read` reports `router.state.location.pathname`.
