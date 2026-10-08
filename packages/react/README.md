# @subako-ai/react

React bindings for Subako sessions: one provider and four hooks that open a
session and declare, for as long as a component is mounted, the tools that let an
agent drive the page the person is already on. The events are the source of
truth — everything here reads `@subako-ai/sdk`'s session connection and derives
the rest. The tools themselves are `@subako-ai/tools`'s.

Requires **React 19** and **Node 22 or newer** for the build. The package is
**ESM only**.

```sh
pnpm add @subako-ai/react @subako-ai/sdk
```

## Getting started

Your backend creates the session and mints its token; the browser does the rest.
Build the client once, outside React, and hand it to the provider:

```tsx
import { SubakoSessionClient } from "@subako-ai/sdk";
import { SubakoProvider } from "@subako-ai/react";

const subako = new SubakoSessionClient({
	getToken: (sessionId) => fetch(`/api/subako/token/${sessionId}`).then((r) => r.text()),
});

export function App({ sessionId }: { sessionId: string }) {
	return (
		<SubakoProvider client={subako}>
			<Assistant sessionId={sessionId} />
		</SubakoProvider>
	);
}
```

Three of the four hooks mirror the SDK's three layers, and the common case is
one of each:

```tsx
const session = useSession(sessionId); // one SessionConnection, opened with the history
const client = useToolClient(session, "chat"); // one client on it, named to the model
useTool(client, "navigate", navigateTool(fromTanStackRouter(router)));
```

The fourth is the read. **`useSession` acquires; `useSessionState` reads.**
Opening a connection and following it are separate things, the way valtio splits
`proxy` from `useSnapshot`: `useSession` hands back a connection and re-renders
its caller once, when there is one, and every component that draws what the
session carries calls `useSessionState(session)` and draws the snapshot it
answers with. So a session handed down as a prop or through a context re-renders
the component that shows it, not the one that opened it.

```tsx
function Transcript({ session }: { session: SessionConnection | null }) {
	const state = useSessionState(session); // without this, the props never change and this never redraws
	return (
		<>
			{state?.transcript.map((message) => (
				<Message key={message.seq} message={message} />
			))}
		</>
	);
}
```

The provider holds nothing but the client and an `onError`: there is no registry
of open sessions. Each hook opens what it owns in an effect and closes it in the
cleanup, so it hands back `null` until that effect has run — the first render —
and each hook takes the `null` the one above it may still be handing back. That
is also what makes them safe under `<StrictMode>`: its dev-only remount closes
the connection and the effect that follows opens another.

## `useSession`

```tsx
import { useSession, useSessionState } from "@subako-ai/react";

function Assistant({ sessionId }: { sessionId: string }) {
	const session = useSession(sessionId);
	const state = useSessionState(session); // this component draws the session, so it subscribes
	if (session === null || state === null) {
		return <p>Connecting…</p>;
	}

	return (
		<>
			{state.transcript.map((message) => (
				<Message key={message.seq} message={message} />
			))}
			{state.approvals.map((approval) => (
				<button key={approval.call_id} onClick={() => session.resolveApproval(approval.call_id, "allow")}>
					Allow {approval.tool}
				</button>
			))}
			<Composer onSend={(text) => session.send(text)} disabled={state.isRunning} />
		</>
	);
}
```

It hands back the SDK's own `SessionConnection`, opened with `history: true` so
the log is read to its end before the stream starts, and closed on unmount. The
connection is the same one for as long as the hook is mounted, and everything on
it — `state`, `transcript`, `approvals`, `isRunning`, `send`, `cancel`,
`resolveApproval`, `createToolClient` — is the SDK's; the hook adds nothing to
it. A second argument passes the SDK's connect options through
(`maxReconnects`, `headers`, ...).

The hook acquires and does not subscribe: the only re-render it causes is the
`null` becoming the connection. A component that renders what the session
carries — this one, or one that was handed the session as a prop — subscribes
with `useSessionState`.

Connecting is an effect, so the return type is `SessionConnection | null`: the
first render — and the renders after the `sessionId` changed — read `null`, and
the one after the effect reads the connection. Handle it with an early return,
as above, or with `?.`.

An id of `null` opens nothing and hands back `null`, so a page that learns
which session it may follow only once a lookup answers still calls the hook on
every render, with `null` until then. Naming none again closes the connection
the hook had.

The hook does not reconnect on its own. The SDK's connection reconnects while it
can, and after `maxReconnects` consecutive failures its status is `failed` and it
stays there; what puts it back is `session.reconnect()`, which opens the stream
again on the same connection, keeping the log, the subscribers and the tool
clients. So an app that renders `state.status === "failed"` gives it a button —
the "reconnect" a chat app shows — rather than expecting the hook to try again:

```tsx
const state = useSessionState(session);
if (state?.status === "failed") {
	return <button onClick={() => session?.reconnect()}>Reconnect</button>;
}
```

The hook owns the connection, so `useSession(id)` in two components opens two
connections. That is not a mistake — the server's event log is the source of
truth, so both read the same session and behave alike — but it is work nobody
asked for. Read one session in several places by calling `useSession` once and
passing the connection down, or through an app-level context of your own; each
of those places subscribes for itself with `useSessionState`.

## `useSessionState`

```tsx
const state = useSessionState(session); // SessionState | null
```

`useSyncExternalStore` over the session: it re-renders the calling component
whenever the connection changes and hands back the snapshot that render was
woken for — `status`, `error`, `lastSeq`, `events`, and the `transcript`,
`approvals` and `isRunning` joined onto them — or `null` while the session is
`null`. The snapshot is everything a render needs, so a component draws what
this returns rather than reading the connection. The same three readings are
getters on the connection too, and those answer with the latest: what an event
handler or an effect wants, not a render.

Call it in every component that renders the session, and only there:

- **The component that renders is the one that subscribes.** `useSession` in a
  provider and `<Chat session={session} />` in its `children` is the shape that
  catches people out: the provider re-renders, the chat's props never change,
  and React skips it. Subscribing inside the chat is what fixes it.
- A component that only passes the session along — to `useToolClient`, or down
  as a prop — needs nothing, and neither does one that only calls `send`,
  `cancel` or `resolveApproval`.

It takes anything carrying the connection's `state` and `subscribe`, so it works
on a session from `useSession`, on one the app built with the SDK directly, and
on the `null` either may still be.

## `useToolClient`

```tsx
const client = useToolClient(session, "chat", { lifetime, onError });
```

Creates one client on the session for the component's lifetime, and deletes it
on unmount. It takes the session `useSession` gives, `null` and all, and answers
with `ToolClient | null` in turn: there is no client until there is a session to
create it on. `name` is what the model sees the tools under — every tool reaches
it as `client__<name>__<tool>` — and the server's rule for it is
`[a-z0-9-]{1,32}`. The client starts empty; `useTool` declares what it serves.

Several `useToolClient` calls on one session are fine: each is its own named
client on the one connection, which is how a session serves tools from more than
one place (`chat` next to `contact-form`). Most apps want one, beside their
`useSession`. `lifetime` defaults to a 60 second ttl, pinged at half of it, and
`onError` to the provider's. A tab that goes away without unmounting sends no
delete; the client's ttl collects it instead.

`lifetime` and `onError` are read when the client is created — by the effect the
session and the name drive — and a later change to either is ignored: the
lifetime is the server's, fixed at the registration, and `onError` is the
callback the client kept. Only a new session or a new name makes another client.
So an `onError` that has to see fresh state reads it out of a ref, or is the
provider's, which every client falls back to.

## `useTool`

```tsx
import { useTool, useToolClient } from "@subako-ai/react";
import { fromReactHookForm } from "@subako-ai/react-hook-form";
import type { ToolClient } from "@subako-ai/sdk";
import { fromTanStackRouter } from "@subako-ai/tanstack-router";
import { formTool, navigateTool } from "@subako-ai/tools";

function ContactPage({ client }: { client: ToolClient }) {
	const form = useForm({ defaultValues: { email: "", message: "" } });
	const formRef = useRef<HTMLFormElement>(null);

	useTool(client, "navigate", navigateTool(fromTanStackRouter(router)));
	useTool(client, "fill_contact_form", formTool({ ...fromReactHookForm(form), description: "The contact form." }), {
		target: formRef,
	});

	return <form ref={formRef}>{/* ... */}</form>;
}
```

The tool is offered for as long as the component is mounted: the mounted
components are the set, and the client reconciles it with the server, one update
per tick, so a page that swaps a screenful of tools sends one request. A
re-render that builds a fresh definition swaps the handler and tells the server
nothing, unless the description or the parameters changed. So there is nothing to
memoize: build the definition inline on every render and its `execute` closes over
what the component holds right now. A client with no tools stays registered: it
belongs to the session, not to the tools.

`tool` is an SDK `ToolDefinition` — `description`, `parameters`, an optional
`parse`, and `execute` — so anything the SDK serves works here; `formTool` and
`navigateTool` in `@subako-ai/tools` are functions that return one. A `null`
client — the one `useToolClient` has yet to create — declares nothing, so the
call reads the same whether the session is open or not.

### When a tool must commit synchronously

React batches state updates and runs effects after the paint, so a handler that
calls `setState` and returns has answered before anything its update caused has
happened: the tools an effect would declare are not declared yet, and a `read()`
of the DOM still sees what was there before. `flushSync(() => setState(...))`
renders, commits, and flushes that commit's effects before it returns, so the
answer follows them.

| What the tool changes                                  | Commit before it answers?                       |
| ------------------------------------------------------ | ----------------------------------------------- |
| State its answer only describes (`switch_tab`)         | No: saying what it did is the whole of it.      |
| State that mounts other tools (`open_add_todo`)        | Yes: their declarations go out with the answer. |
| State its own `read()` then inspects (`fill_settings`) | Yes: the read must see the filled controls.     |
| The route (`navigate`)                                 | No: `await router.navigate()` already waits.    |

The SDK sends the tool list a call changed before it sends that call's answer,
so a set committed here reaches the model with the answer that brought it into
being. These packages never call `flushSync` themselves: the handler that
changes the state is the only place that knows which update has to be visible
before the answer. `flushSync` cannot be called while React is rendering — a tool's
`execute` runs outside rendering, which is where it is safe — and waiting a
`setTimeout` instead is a guess at how long a commit takes, which these docs do
not recommend.

### `data-subako-tool`

Pass `target` and the element carries `data-subako-tool="running"` while a call
to that tool is in flight. The hook never touches styles; the app decides what
that looks like.

```css
[data-subako-tool="running"] {
	outline: 2px solid var(--accent);
}
```

## Tools and adapters

The hooks declare tools; they do not build them. `formTool` and `navigateTool`
are `@subako-ai/tools`'s, with `fromFormElement` for a form that is already on
the page, and each library adapter is its own package that answers with the
spec a tool takes:

| Package                      | Gives                                                                       |
| ---------------------------- | --------------------------------------------------------------------------- |
| `@subako-ai/tools`           | `formTool`, `navigateTool`, `fromFormElement(refOrForm)`.                   |
| `@subako-ai/tanstack-router` | `fromTanStackRouter(router)`: `routes`, `navigate`, `read`.                 |
| `@subako-ai/react-hook-form` | `fromReactHookForm(form, { schema? })`: `fields`/`schema`, `apply`, `read`. |

## What it does not do

No tool constructors: those are `@subako-ai/tools`'s. No message rendering, no
styling, no chat layout, and no confirmation UI: those belong to the app, or to
`@subako-ai/assistant-ui`.
