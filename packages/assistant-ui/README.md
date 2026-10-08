# @subako-ai/assistant-ui

[assistant-ui](https://www.assistant-ui.com) over a Subako session: one hook
that turns the session into an assistant-ui runtime, and one component that
renders a working chat with no setup at all.

Requires **React 19**, **`@assistant-ui/react` 0.15** with
**`@assistant-ui/react-markdown` 0.14**, and **Node 22 or newer** for the
build. The package is **ESM only**.

```sh
pnpm add @subako-ai/assistant-ui @subako-ai/react @subako-ai/sdk @assistant-ui/react @assistant-ui/react-markdown
```

## Getting started

The provider and the session are `@subako-ai/react`'s; this package is what
draws them.

```tsx
import { SubakoSessionClient } from "@subako-ai/sdk";
import { SubakoProvider, useSession } from "@subako-ai/react";
import { SubakoChat } from "@subako-ai/assistant-ui";

const subako = new SubakoSessionClient({
	getToken: (sessionId) => fetch(`/api/subako/token/${sessionId}`).then((r) => r.text()),
});

function Assistant({ sessionId }: { sessionId: string }) {
	// The app opens the session and hands it down, so the chat opens no second connection.
	return <SubakoChat session={useSession(sessionId)} />;
}

export function App({ sessionId }: { sessionId: string }) {
	return (
		<SubakoProvider client={subako}>
			<Assistant sessionId={sessionId} />
		</SubakoProvider>
	);
}
```

That is the whole chat: the transcript, the tool calls with their results, the
approval prompt, a composer, and a stop button while a run is under way. The
assistant's text is drawn as markdown, tables and all, with links that open in
a new tab; what the person typed is shown as typed. The
`session` is the one the app opened — `useSession` hands back `null` until its
effect has connected, which the chat renders as an empty thread with a disabled
composer — so the tools the app declares and the thread share one connection. It
brings its own small stylesheet, so it renders acceptably with nothing else
installed — no CSS framework, no shadcn registry, no `@assistant-ui/styles`.
`className` lands on the root element for an app that wants to style it, and
the class names below are stable:

| Class                                      | What it is                                    |
| ------------------------------------------ | --------------------------------------------- |
| `.subako-chat`                             | The root.                                     |
| `.subako-viewport`                         | The scrolling message list.                   |
| `.subako-message`, `-user`, `-assistant`   | One bubble.                                   |
| `.subako-markdown`                         | The assistant's body, as markdown.            |
| `.subako-thinking`                         | A `thinking` block.                           |
| `.subako-tool`                             | One tool call, folded to its name and status. |
| `.subako-tool-args`, `.subako-tool-result` | The input and the output behind the fold.     |
| `.subako-approval`                         | The allow / deny prompt.                      |
| `.subako-composer`, `.subako-input`        | The composer.                                 |

### Overriding the styles

Every rule of the stylesheet sits in a cascade layer named `subako`. A rule
of the app's own that names one of the classes above wins over it, at any
specificity and from anywhere in the page:

```css
.subako-user {
	border-radius: 4px;
}
```

A rule that names no class — a reset's `*` and `button`, the app's own `pre` —
does not reach the chat's own elements. Each of them carries a guard, in no
layer, that turns unlayered element rules away and takes the layered ones
instead, so Tailwind v3's preflight, a `normalize.css`, and the app's global
`button` all leave the chat as it is. The one rule of a reset's that still
reaches a button is `[type="button"]`, which names an attribute; it takes the
background only, and the buttons are the color of the bar they sit on. A tool
UI the app draws itself is not guarded: that is the app's own markup.

An app whose CSS is layered itself — Tailwind v4 is one — says where `subako`
goes by naming it in its layer order, ahead of anything else that declares a
layer. After `base`, so preflight does not strip the chat's own buttons;
before `components` and `utilities`, so a class the app puts on the root, and
an override the app writes inside a layer of its own, both win:

```css
@layer theme, base, subako, components, utilities;
@import "tailwindcss";
```

Left unnamed, `subako` lands last and the chat's own rules beat the app's
layered ones.

### A page with a Content Security Policy

The stylesheet above is an inline `<style>`, so a page whose `style-src-elem`
names a nonce drops it and the thread renders unstyled. Hand the chat the same
nonce the page puts on its own tags:

```tsx
<SubakoChat session={session} nonce={cspNonce} />
```

A page with no such policy needs nothing: left out, the attribute is not
written at all.

### Colors

Every surface names its own color and its own background, so the chat is
legible on a page of any color instead of inheriting half of one. They come
from eight custom properties, light by default and dark under
`prefers-color-scheme: dark`; the root also carries `color-scheme: light dark`
so form controls follow. Set the properties on `.subako-chat` itself to theme
the chat with the app's own palette — a value set above it is shadowed by the
chat's own defaults — which is how an app
whose dark mode is a class or a `data-theme`, rather than the OS setting, keeps
the chat in step:

```css
.subako-chat {
	--subako-bg: var(--card);
	--subako-fg: var(--ink);
	--subako-muted: var(--dim);
	--subako-accent: var(--accent);
	--subako-accent-fg: #fff;
	--subako-border: var(--line);
	--subako-surface: var(--bg);
	--subako-error: var(--danger);
	color-scheme: inherit;
}
```

`--subako-bg` is the panel, the composer and its controls; `--subako-surface`
is the raised one — the assistant bubble, the tool call's arguments and result,
the approval bar; `--subako-accent` with `--subako-accent-fg` is the user
bubble; `--subako-muted` is the reasoning block and the placeholder;
`--subako-error` is a failed tool result.

## `useSubakoRuntime`

```tsx
const session = useSession(sessionId);
const runtime = useSubakoRuntime(session);
```

`useExternalStoreRuntime` over the session. The log stays the only store: the
runtime keeps no messages of its own, so a send that fails leaves the thread as
the server has it. A `null` session — the one `useSession` has yet to open — is
a thread with no messages and a composer that cannot be typed into.

The runtime subscribes to the session itself, with `@subako-ai/react`'s
`useSessionState`, so the thread follows the log wherever it is mounted. That
matters because `useSession` only acquires: hand the session to a `<SubakoChat>`
sitting in some provider's `children` and its props never change, so React would
never redraw it. Nothing above the chat has to re-render for a new message to
appear.

| assistant-ui              | Subako                                                         |
| ------------------------- | -------------------------------------------------------------- |
| `messages`                | `state.transcript`, through `convertMessage`                   |
| `isRunning`               | `state.isRunning`                                              |
| `onNew`                   | `send(text)`, over the text parts of the appended message      |
| `onCancel`                | `cancel()`                                                     |
| `onRespondToToolApproval` | `resolveApproval(callId, approved ? "allow" : "deny", reason)` |

The argument is anything carrying those members, or `null`, which is what
`useSession` hands back.

### `convertMessage`

The pure half, exported so an app can convert a transcript without a runtime:

| Log                | assistant-ui                                                |
| ------------------ | ----------------------------------------------------------- |
| `text` block       | a text part                                                 |
| `thinking` block   | a reasoning part                                            |
| `tool_call` block  | a tool-call part, with the joined `tool_result` as its text |
| a pending approval | an approval with no decision, which is what shows a prompt  |
| a settled approval | the same approval, carrying the decision                    |
| the event's `seq`  | the message id                                              |

The conversion is cached on the identity of the message object, not on the id,
and the connection's `transcript` folds a new event into the messages it already
made — replacing only the ones that event touched — so every other message is
converted once and stays converted. A user message carries where it came from as
`metadata.custom.source`.

## Your own thread

`<SubakoChat>` exists for the first ten minutes. A real app keeps the runtime
and builds the thread from assistant-ui's primitives, or from the components
its shadcn registry installs:

```tsx
function Chat({ sessionId }: { sessionId: string }) {
	const session = useSession(sessionId);
	const runtime = useSubakoRuntime(session);

	return (
		<AssistantRuntimeProvider runtime={runtime}>
			<ThreadPrimitive.Root>
				<ThreadPrimitive.Viewport>
					<ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
				</ThreadPrimitive.Viewport>
				<ComposerPrimitive.Root>
					<ComposerPrimitive.Input />
					<ComposerPrimitive.Send>Send</ComposerPrimitive.Send>
				</ComposerPrimitive.Root>
			</ThreadPrimitive.Root>
		</AssistantRuntimeProvider>
	);
}
```

The approval prompt is a tool-call part with an `approval` that carries no
decision; answer it with the part's own `respondToApproval({ approved })`, which
is what reaches `resolveApproval`. The stop button is
`<ComposerPrimitive.Cancel>`, which the runtime wires to `cancel()`.

## Tool UI

A tool call renders as a row folded to its name and its status — running,
done, failed, needs approval, denied. Opening the row shows the input and the
output, laid out as JSON when they are JSON. The approval prompt sits outside
the fold, so a closed row still asks. To draw one of your tools yourself,
register a tool UI the ordinary assistant-ui way; it wins over the default row.
`<SubakoChat>` renders its children inside the runtime, which is where the
registration has to happen:

```tsx
import { makeAssistantToolUI } from "@assistant-ui/react";

const FillForm = makeAssistantToolUI<{ email?: string }, string>({
	toolName: "client__chat__fill_contact_form",
	render: ({ args, result }) => (result === undefined ? <p>Filling…</p> : <p>Filled {args.email}</p>),
});

<SubakoChat session={session}>
	<FillForm />
</SubakoChat>;
```

The name is what the model sees the tool under, which for a client tool is
`client__<client name>__<tool>`.

### `components`

The same renderers go on `<SubakoChat>` as `components`, which takes what
`MessagePrimitive.Parts` takes: `tools.by_name` for the tools named,
`tools.Fallback` for every other one in place of the chat's own row, and
`Text` for the body in place of the chat's own markdown — for a renderer with
a syntax highlighter, say, built on `MarkdownTextPrimitive` the way the chat's
is. The chat's body, its reasoning block and its tool row stay wherever nothing
is named.

```tsx
function FilledForm({ args, result }: ToolCallMessagePartProps) {
	return result === undefined ? <p>Filling…</p> : <p>Filled {String(args.email)}</p>;
}

<SubakoChat session={session} components={{ tools: { by_name: { client__chat__fill_contact_form: FilledForm } } }} />;
```

### `SubakoToolApproval`

A tool that needs approval has to ask for it from whatever draws it: a row of
the app's own gets `approval` and `respondToApproval` like any tool-call part,
and the run waits until something answers. `SubakoToolApproval` is the chat's
own prompt, for dropping in — Allow and Deny while the server waits on the
person, nothing once there is an answer or the run was canceled:

```tsx
import { SubakoToolApproval } from "@subako-ai/assistant-ui";

function Terse(props: ToolCallMessagePartProps) {
	return (
		<div>
			{props.toolName}
			<SubakoToolApproval {...props} />
		</div>
	);
}

<SubakoChat session={session} components={{ tools: { Fallback: Terse } }} />;
```

## What it does not do

No thread list, no branching, no editing, no attachments, no speech: the
session is one conversation, its log is append-only, and the runtime declares
only what the session can actually do.
