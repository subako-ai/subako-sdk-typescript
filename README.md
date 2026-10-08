# Subako SDK workspace

The TypeScript SDKs for the Subako API, as a pnpm workspace.

The SDK is developed in Subako's own repository, beside the API it is a client
of, and each Subako release exports it here as one commit and publishes it to
npm at that release's version.

| Package                                                          | What it is                                                              |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`packages/sdk`](packages/sdk/README.md)                         | `@subako-ai/sdk`: the client, session connections, client tools.        |
| [`packages/tools`](packages/tools/README.md)                     | `@subako-ai/tools`: `formTool`, `navigateTool`, and the form reader.    |
| [`packages/react`](packages/react/README.md)                     | `@subako-ai/react`: the provider and the hooks.                         |
| [`packages/tanstack-router`](packages/tanstack-router/README.md) | `@subako-ai/tanstack-router`: TanStack Router as a navigate tool.       |
| [`packages/react-router`](packages/react-router/README.md)       | `@subako-ai/react-router`: React Router as a navigate tool.             |
| [`packages/react-hook-form`](packages/react-hook-form/README.md) | `@subako-ai/react-hook-form`: react-hook-form as a form tool.           |
| [`packages/assistant-ui`](packages/assistant-ui/README.md)       | `@subako-ai/assistant-ui`: the assistant-ui runtime and `<SubakoChat>`. |

Design notes live in [`docs/design`](docs/design); the demo used to run the SDK
for real, against the deployment the `subako` CLI is signed in to, is under
[`testbed`](testbed/README.md).

## Development

`packages/sdk` holds the SDK, `packages/tools` the tools an agent drives a page
with, `packages/react` the React bindings, one package per library adapter, and
`packages/assistant-ui` the chat drawn over them; the spec, the scripts, the
testbed, and the docs stay at the root, shared by every package.

```
openapi/public.json          the spec every generated artifact derives from
packages/sdk/src/generated   produced from it, never edited by hand
packages/sdk/src             the SDK
packages/sdk/test            its tests
packages/tools/src           formTool, navigateTool, the fields DSL, fromFormElement
packages/tools/test          its tests, under a DOM environment
packages/react/src           the React provider and hooks
packages/react/test          its tests, under a DOM environment
packages/tanstack-router     fromTanStackRouter, with its tests
packages/react-router        fromReactRouter and routesOf, with its tests
packages/react-hook-form     fromReactHookForm, with its tests
packages/assistant-ui/src    the assistant-ui runtime and <SubakoChat>
packages/assistant-ui/test   its tests, under a DOM environment
examples/chat                a chat and nothing else
examples/todo                a todo app the agent drives, over every package
scripts/ testbed/ docs/      shared by the workspace
```

Every script runs from this directory. In Subako's repository, lint and format
run over the whole repository, from its root: `mise run lint` and `mise run fmt`.

| Script                         | What it does                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `pnpm run sync`                | Copy the spec out of Subako's repository.                                              |
| `pnpm run gen`                 | Regenerate `packages/sdk/src/generated` from the spec.                                 |
| `pnpm run gen:check`           | Fail if the committed output is stale.                                                 |
| `pnpm run build`               | `tsc -b` over every package.                                                           |
| `pnpm run pack:check`          | Pack every package from a clean build and import the tarballs in an isolated consumer. |
| `pnpm run typecheck`           | Build, then check the tests and their type assertions.                                 |
| `pnpm run test`                | `vitest run` over every project; no network, no waits.                                 |
| `pnpm run testbed`             | Mint SDK credentials with the CLI (see `testbed/README.md`).                           |
| `pnpm run testbed:smoke`       | Build, then run `testbed/smoke.mjs` against it.                                        |
| `pnpm example <name>`          | One of `examples/*` on that deployment, on :5173 (see `examples/README.md`).           |
| `pnpm run example:todo:verify` | Assert the todo example's paths end to end, with no browser.                           |

In Subako's repository, `mise run gen` does both: it syncs the spec from Core
and regenerates the client, and `mise run gen:check` fails when either is stale.

## Publishing

A release is a tag on Subako's repository. Its version is the workspace's, and
every package and `packages/sdk/src/version.ts` carry it; `scripts/bump-version.sh`
there bumps them together. The tag's `release-sdk-typescript.yml` writes this
directory to this repository's `main` as one commit and pushes the same tag
here.

[`release.yml`](.github/workflows/release.yml) then runs CI, checks that the tag
is on `main` and that every package is at the version it names, and publishes
with `pnpm -r publish`, which rewrites `workspace:` dependencies and attaches
provenance. A version the registry already has is skipped, so re-running a
release that failed partway publishes only what is missing.

Each package's `prepack` hook cleans and builds its output, and CI's
`pnpm run pack:check` verifies the tarballs' exports and imports and confirms
that workspace dependency ranges were replaced with publishable versions.

### Trusted publishing

No npm token is stored anywhere. npm trusts `release.yml` in this repository,
running in the `npm` environment, and the job trades its OIDC token for a token
that lasts one publish. Each package holds that trust separately, and a package
has to exist on the registry before it can hold it. Signed in to npm as an
owner, with two-factor auth and npm 11.15 or later:

```sh
for name in sdk tools react tanstack-router react-router react-hook-form assistant-ui; do
	npx npm@latest trust github "@subako-ai/$name" --repo subako-ai/subako-sdk-typescript \
		--file release.yml --env npm --allow-publish --yes
done
npx npm@latest trust list @subako-ai/sdk
```

or enter the same values under each package's Settings → Trusted publishing on
npmjs.com. They are case-sensitive. A package without the trust fails to publish,
usually with a 404, after pnpm warns `Skipped OIDC`.

npm checks the workflow's file name and environment, not the ref it ran on, so
the `npm` environment is what keeps a copy of `release.yml` pushed to a branch
from publishing. Under Settings → Environments → npm → Deployment branches and
tags, allow only tags matching `v*`.

With the trust in place, each package's Settings → Publishing access on npmjs.com
can be set to "Require two-factor authentication and disallow tokens": the
workflow still publishes, and nothing else can without an owner's second factor.

npm accepts provenance only when each package's `repository.url` names the
repository that built it, so every package.json names this one.

A new package's first version is published by hand, from a clean `main`:

```sh
pnpm run pack:check
pnpm --filter <name> publish --access public
```
