# Examples

Each directory is one app over the packages, run against the Subako deployment
the `subako` CLI is signed in to. From the repo root:

```sh
pnpm example chat     # then open http://localhost:5173
pnpm example todo
pnpm testbed:down     # stop whichever is running
```

| Example        | What it shows                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| [`chat`](chat) | A chat and nothing else: `<SubakoChat>` over a session, the smallest page the packages make.                                      |
| [`todo`](todo) | A todo app the agent drives: client tools, form tools, the router, and the chat in a panel. `pnpm example:todo:verify` proves it. |

`testbed/README.md` says which deployment they talk to, and how the credentials
and the model config get there.

## What an example is

- `server.mjs` is the example's backend. It holds the workspace api key,
  publishes the example's own agent, and serves the two routes the page needs:
  `POST /api/session` creates a session, `GET /api/session/:id/token` mints a
  token for it. That part is `shared/server.mjs`; the example's own file says
  which agent it wants and adds any routes of its own.
- `src/` is the page, served by Vite, which proxies `/api` to the server. The
  page holds session tokens and nothing else.
- `README.md` says what the example shows, and where each package is used.

## Adding one

Copy `chat`, rename the package in `package.json`, give the agent in
`server.mjs` a name and a prompt of its own, and add the directory to the
`typecheck` script in the root `package.json`. `pnpm install` links the
workspace packages, and `pnpm example <name>` runs it.
