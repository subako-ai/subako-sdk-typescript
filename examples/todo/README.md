# The todo example

A todo list with a floating assistant, run against the Subako deployment the
`subako` CLI is signed in to. `pnpm example todo` from the repo root brings up
everything and serves it on <http://localhost:5173>.

```
server.mjs   the example's backend: todos, an MCP server, and the agent it publishes; the session routes are ../shared/server.mjs's
verify.mjs   the end-to-end proof, for a machine with no browser
index.html   the Vite entry
src/
  main.tsx             creates the session, then mounts the providers and the router under StrictMode
  agent.tsx            useSession + useToolClient("app") + the app-wide tools; hands the client down
  app.tsx              the todos and the settings, held at the root
  api.ts               the todo REST calls
  router.tsx           the three routes, code based
  app.css              all of the styling
  routes/root.tsx      the nav bar, the outlet, and the floating panel
  routes/todos.tsx     the list, its tabs and modal flag, `switch_tab` and `open_add_todo`
  routes/todo.tsx      one todo
  routes/settings.tsx  the settings form and `fill_settings`, applied with `flushSync`
  components/add-todo-modal.tsx  the modal, its form, `fill_todo_form` and `submit_add_todo`
  components/todo-row.tsx        one line of the list, its checkbox and its Delete
```

Try, in the panel: _summarize my todos_, _mark the oat milk one as done_,
_delete the dentist todo_, _add a todo to buy milk tomorrow_ (it fills the form
and submits it), _open the add todo form for eggs but do not submit it_, _go to
settings and set my display name to Ada Lovelace_, _show the completed tab_.

## Where each layer is used

| Layer                                 | Where                                                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `SubakoClient` (api key)              | `server.mjs`, through `../shared/server.mjs`: creates sessions, mints tokens, publishes the agent, sets CORS         |
| `SubakoSessionClient` (session token) | `src/main.tsx`, built once outside React and handed to `SubakoProvider`                                              |
| `useSession`, `useToolClient`         | `src/agent.tsx`, once, at the root                                                                                   |
| `useTool` + `navigateTool`            | `src/agent.tsx`, with `fromTanStackRouter`                                                                           |
| `useTool` with a hand-written tool    | `src/agent.tsx`: `list_todos`, `set_todo_done`, `delete_todo`; `src/routes/todos.tsx`: `switch_tab`, `open_add_todo` |
| `useTool` + `formTool`                | `src/components/add-todo-modal.tsx` (`fromReactHookForm` + zod) and `routes/settings.tsx` (`fromFormElement`)        |
| `useTool` + `submitTool`              | `src/components/add-todo-modal.tsx`: `submit_add_todo`, over react-hook-form's `handleSubmit`                        |
| `SubakoChat`                          | `src/routes/root.tsx`, over the session from `useAgent()`, inside the floating panel                                 |
| MCP                                   | `server.mjs` `/mcp`: `list_todos` and `get_todo`, granted only when `EXAMPLE_MCP_URL` is set                         |

## The tools the agent is offered

Four belong to the app, so they are there wherever the person is — the todos are
the app's, not a page's, and `list_todos` is the only way the model sees them:

| Tool            | What it does                                  |
| --------------- | --------------------------------------------- |
| `list_todos`    | Reads the list, and the ids the next two take |
| `set_todo_done` | Completes one todo, or puts it back           |
| `delete_todo`   | Deletes one for good                          |
| `navigate`      | Goes to one of the router's routes            |

Five are declared by the part of the app they drive, so the tools the model is
offered say what is on screen: `switch_tab` and `open_add_todo` only on the
list, `fill_todo_form` and `submit_add_todo` only while the modal is mounted,
`fill_settings` only on `/settings`. Creating a todo goes through the modal on
purpose — `open_add_todo`, `fill_todo_form`, `submit_add_todo` — so there is no
tool that creates one outright.

Submitting is its own tool, and only the modal has one. The settings form does
not, which is how the model can tell that form is the person's to send: a form
with no submit tool cannot be submitted, and it can see that. When the modal's
form refuses a submit, the tool answers with the field messages
`fromReactHookForm` read back, and the model fills those in and submits again.

A tool is declared, inline and unmemoized, by the component that owns the state
it writes to, so the tools the model is offered say what is on screen: `switch_tab` and
`open_add_todo` exist only on the list, `fill_todo_form` only while the modal is
mounted, `fill_settings` only on `/settings`. `open_add_todo` opens the modal
with `flushSync`, so `fill_todo_form` is declared — and sent — before its answer
reaches the model; the tool set the model sees is refreshed between its calls
within one turn, which is what makes navigate-then-fill work in a single reply. `data-subako-tool="running"` marks the form a call is
filling, and `app.css` gives that an outline.

## The todos are read through a client tool, not MCP

The server still serves MCP on its own `/mcp`, but the grant is off unless
`EXAMPLE_MCP_URL` names an https endpoint the broker can reach. **A plaintext
MCP url is refused outright, and that failure kills the whole run** — every
request comes back as `MCP error -32000: endpoint URL must be https` and the
model is never called. A loopback server cannot be granted, so `list_todos` is a
client tool on the page instead. Point `EXAMPLE_MCP_URL` at a tunnel to see the
MCP layer as well.

## verify.mjs

The end-to-end proof: it plays the part of the page — the same session routes,
the same client name, the same five tools — and checks that the agent drives it.
It starts nothing: the stack and this server have to be up already.

```sh
pnpm testbed          # the credentials, once
node server.mjs &     # the example's own backend, on EXAMPLE_PORT (9800 by default)
pnpm example:todo:verify
```

It runs against a real model, so it asserts what each turn had to do — which
tool was dispatched, with which arguments, and what the page holds afterwards —
rather than an exact transcript.
