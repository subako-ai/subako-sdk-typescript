# @subako-ai/sdk

The TypeScript client for the Subako API: two clients that split by what their
credential reaches, one namespace per resource, typed errors, cursor pagination,
a session connection that reconnects on its own, and a client that serves this
process's tools to a session.

Requires **Node 22 or newer**. The package is **ESM only** and ships no runtime
dependencies.

```sh
pnpm add @subako-ai/sdk
```

## Getting started

Both clients default to `https://api.us.cloud.subako.ai`. Pass `baseUrl` to use
a different API endpoint, such as `http://localhost:8080` for local development.

The backend holds the API key, creates the session, and hands the browser the
session token that comes back with it:

```ts
// server
import { type CreatedSessionBody, type CreatedSessionReceiptBody, SubakoClient } from "@subako-ai/sdk";

const subako = new SubakoClient({
	apiKey: process.env["SUBAKO_API_KEY"]!,
});

app.post("/api/subako/session", async (req, res) => {
	const created = await subako.sessions.create({
		agent_id: agentId,
		display_name: "support",
	});
	res.json({ sessionId: created.id, token: await tokenFor(created) });
});

// A create the SDK had to retry answers with a receipt instead: the session is
// there, its token is never sent twice, so mint a fresh one. See "Receipts".
async function tokenFor(created: CreatedSessionBody | CreatedSessionReceiptBody): Promise<string> {
	if ("session_token" in created) {
		return created.session_token;
	}
	const minted = await subako.sessions.mintToken(created.id);
	if ("session_token" in minted) {
		return minted.session_token;
	}
	throw new Error(`no token in hand for session ${created.id}`);
}
```

The browser holds only session tokens, one per session, and drives the session
from there:

```ts
// browser
import { SubakoSessionClient } from "@subako-ai/sdk";

const subako = new SubakoSessionClient({
	getToken: async (sessionId) => await mintToken(sessionId),
});

// One connection follows the log; the client on it serves the tools this page offers.
const session = subako.connect(sessionId);
const client = session.createToolClient("web");
client.addTool("open_contact_form", {
	description: "Navigate to the contact page and prefill the form.",
	parameters: {
		type: "object",
		properties: { text: { type: "string" } },
		required: ["text"],
	},
	execute: async (args: { text: string }) => await openContactForm(args.text),
});
await client.ready;

await subako.postEvent(sessionId, {
	type: "input",
	text: "I want to send an inquiry.",
});

for await (const event of session) {
	if (event.type === "message_assistant") {
		console.log(event.message);
	}
	if (event.type === "run_completed") {
		break;
	}
}

session.close();
```

A backend that serves the tools itself needs no second client: `SubakoClient`
reaches every session route too, so `subako.sessions.connect(...)` and
`createToolClient` work there exactly as they do above.

## The two clients

Two credentials reach different parts of the API, so there are two clients and
the type says which is which.

| Client                | Credential                                           | Reaches                                                                            |
| --------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `SubakoClient`        | `apiKey`, `accessToken`, or `credential: "external"` | Everything: agents, skills, vaults, workspaces, and the session routes among them. |
| `SubakoSessionClient` | one token per session                                | Only the session routes, and only for the sessions it holds a token for.           |

`SubakoClient` belongs on a backend, where the API key can be kept secret. It is
the only client that creates, lists, and deletes sessions, and the only one that
mints session tokens.

`SubakoSessionClient` belongs in a browser, or in any process handed session
tokens rather than a key. It has no namespaces and no `workspaceId` — a session
token implies its workspace — and binds the session-scoped methods at the top
level:

```ts
const subako = new SubakoSessionClient({
	getToken: (sessionId) => fetch(`/api/subako/token/${sessionId}`).then((r) => r.text()),
});

await subako.get(sessionId);
await subako.listEvents(sessionId, { after_seq: 41 });
await subako.postEvent(sessionId, { type: "input", text });
await subako.cancelRun(sessionId);
await subako.resolveApproval(sessionId, callId, { decision: "allow" });
await subako.listSandboxes(sessionId);
const session = subako.connect(sessionId);
await subako.registerClient(sessionId, { name: "web", lifetime, tools });
```

A browser reaches those routes cross-origin, and an agent answers no origin
until it is told to. Name the page's origin once, from the backend:

```ts
await subako.agents.setSecurity(agentId, { allowed_origins: ["https://app.example.com"] });
```

An entry is exactly what a browser puts in `Origin` — scheme, host, and an
optional port, with no trailing slash and no path — and `setSecurity` replaces
the whole document, so `{}` returns the agent to refusing every browser.

`getToken` is asked for a session's token when that session's first request
needs one, and its answer is cached under that session. So one client serves
many sessions at once, each carrying its own token, and a `401` on one session
refreshes only that session's token — the others keep the tokens they hold. The
token your backend hands back is `session_token` from `sessions.create`, or a
fresh one from `sessions.mintToken`; tokens already issued stay live. Both
answer with a receipt rather than a secret when the attempt was a replay, which
[Receipts](#receipts) covers.

## Authentication

Exactly one credential per `SubakoClient`, sent as `Authorization: Bearer`.

| Option        | Secret       | Reaches                                                                   |
| ------------- | ------------ | ------------------------------------------------------------------------- |
| `apiKey`      | `sbk_ak_...` | One workspace, with the permissions the key was minted with.              |
| `accessToken` | `sbk_at_...` | Whatever the signed-in user may reach; workspace routes need a workspace. |

A session token (`sbk_st_...`) reaches one session's own routes and nothing
else, so it is not an option here: it goes to `SubakoSessionClient` as
`getToken`, which answers with one per session.

Either option takes a string or a function, sync or async:

```ts
const subako = new SubakoClient({
	accessToken: () => auth.currentAccessToken(),
	workspaceId,
});
```

A function is called when a token is first needed, not on every request. What it
answers with is cached and carried by every request after it, including the
event stream, and requests that start together share one call rather than each
making their own. It is called again only when the server answers `401`: the
refused request then goes once more with the fresh token, under the same
`Idempotency-Key` and without spending a retry, and a second `401` throws
`UnauthorizedError`. So a caller can fetch a token from wherever it lives and
leave it to the SDK to decide when that is worth doing again. A string
credential has nothing to refresh, so its `401` throws at once, and a function
that throws surfaces its own error, with the next request calling it again.

`SubakoSessionClient.getToken` is the same contract, keyed by session: one call
per session, one cached token per session, one refresh per session.

### A credential attached outside the SDK

When something other than the SDK attaches the credential, build the client
with `credential: "external"` in place of `apiKey` or `accessToken`:

- a browser app whose own backend-for-frontend holds the user's session, with
  `baseUrl` pointing at that backend's same-origin proxy;
- a service behind a gateway or sidecar that injects the key on the way out;
- a `fetch`, passed as `fetch`, that authenticates each request itself.

```ts
const subako = new SubakoClient({
	baseUrl: `${location.origin}/api/core`,
	credential: "external",
});
```

Such a client sends no `Authorization` header. It holds nothing it could
refresh, so a `401` throws `UnauthorizedError` at once, for the app to answer,
for example by sending the user to its sign-in page.

Missing or duplicated credentials throw a `TypeError` from the constructor.
An omitted or `undefined` `baseUrl` uses Subako Cloud; an explicitly empty
or non-string value throws a `TypeError`.

## Workspaces

`workspaceId` rides every `SubakoClient` request as `Kikuvi-Workspace`. A user
credential needs it for workspace-scoped routes; an API key implies its own
workspace and refuses a header naming another, and so does a session token,
which is why `SubakoSessionClient` has no such option. Any call may name a
different workspace:

```ts
await subako.agents.list({ limit: 50 }, { workspaceId: other });
```

## Calling convention

Path parameters are positional, in url order. Everything else is one `params`
object under the field names the API itself uses. A trailing `options` object
carries `signal`, `timeout`, `maxRetries`, `headers`, `workspaceId`, and
`idempotencyKey`.

```ts
await subako.agents.get(agentId);
await subako.agents.publishVersion(agentId, config);
await subako.sessions.resolveApproval(sessionId, callId, { decision: "allow" }, { timeout: 5_000 });
```

Methods answer with the parsed response body, or `undefined` where the API
answers `204`. Failures throw.

## Pagination

Listings answer with a `Page`. Iterate it to walk every item from that page
onward, or follow the cursor by hand.

```ts
for await (const agent of await subako.agents.list({ limit: 100 })) {
	console.log(agent.name);
}

const page = await subako.sessions.listEvents(sessionId, { after_seq: 41 });
console.log(page.items, page.nextCursor);
const next = await page.nextPage(); // Page | null
```

Every listing answers newest first, and `order: "asc"` walks the other way. The
cursor follows the direction of travel, so a walk continues past its last item
whichever way it runs.

```ts
const oldest = await subako.agents.list({ order: "asc", limit: 100 });
```

A page from an id-keyed listing also knows the page before it:
`previousPage()` reads it under `before`, in the same order as any page, and
answers `null` on the first page. `previousCursor` is that cursor, to hand back
as `before` by hand. The event log pages forward only.

```ts
const page = await subako.workspaces.list({ limit: 25, after: cursor });
const previous = await page.previousPage(); // Page | null
```

Cursors are plain values: a string id for most listings, a `number` seq for the
session event log. The event log is the one listing whose cursor changes name
with the direction — `before_seq` descending, `after_seq` ascending — and the
`Page` sends back whichever the listing asked for. Both bounds are exclusive, so
a window is `{ after_seq, before_seq }`.

`listSandboxes` is the exception, and says so in its type: an agent's config
names the sandboxes it grants, so the set is bounded and the whole of it travels
at once. It answers with `{ items }` and no cursor, not a `Page`.

## The session connection

`connect` opens one connection to a session and keeps it: one snapshot of
everything that has arrived, one subscription, and the clients attached to it.

```ts
const session = subako.sessions.connect(sessionId, { history: true }); // subako.connect on a session client

await session.ready; // the history is read and the stream is open

session.state.status; // "connecting" | "open" | "reconnecting" | "closed" | "failed"
session.state.error; // the failure, set when the status is "failed"
session.state.lastSeq; // number | undefined
session.state.events; // every event seen, in seq order
session.state.transcript; // the messages of the log, each call joined to its result and approval
session.state.approvals; // the approvals no decision has settled
session.state.isRunning; // a run queued or under way

const stop = session.subscribe((state) => render(state)); // returns an unsubscribe

for await (const event of session) {
	// The events so far, then live ones. `break` stops iterating, not the connection.
}

session.close(); // ends the stream; the clients on it are deleted
session.reconnect(); // only after a failure: opens the stream again on this same connection
```

The connection is also how the session is driven and read, so a UI holds nothing
else:

```ts
await session.send("book me a room"); // posts a user turn
await session.cancel(); // stops the active run at its next checkpoint
await session.resolveApproval(callId, "deny", "not this one"); // "allow" | "deny"

session.transcript; // the same three readings, taken off the connection
session.approvals;
session.isRunning;
```

The readings sit on the snapshot and on the connection, and they are one
reading: derived from `state.events` when they are first read, and again only
when that array is a different one. Take them off `state` where a snapshot is
what you hold — a render, a `subscribe` listener — and off the connection
anywhere else, where the latest is what you want.

`state` is immutable: a new object on every event and every status change, the
same object while nothing changes, with `events` a new array when an event
arrives and the same one otherwise, and the events in it never copied. So a UI
subscribes once and renders the snapshot:

```ts
const state = useSyncExternalStore(session.subscribe, () => session.state);
state.transcript; // what this render draws
```

`state.events` is this client's copy of the session's event log, which is the
source of truth: raw wire bodies in seq order. The connection interprets none of
it — no message joining, no strings — so what the events mean is yours to decide.

The three readings above are these pure helpers, which are exported too, for a
log that is not a connection's. `transcript` answers with the user and assistant
messages in seq order, each assistant one carrying its `tool_call` blocks joined
to the `tool_result` and the approval that followed them; `pendingApprovals`
answers with the `approval_requested` events no decision has settled;
`isRunning` says whether a run is queued or under way. All three take
`readonly SessionEventBody[]`, keep no state of their own, hand back the events'
own message objects, and stringify nothing:

```ts
import { isRunning, pendingApprovals, transcript } from "@subako-ai/sdk";

const messages = transcript(events);
const waiting = pendingApprovals(events);
const busy = isRunning(events);
```

| Option          | What it does                                                                               |
| --------------- | ------------------------------------------------------------------------------------------ |
| `history`       | Reads the log to its end first, oldest first; the stream then starts at the last seq.      |
| `afterSeq`      | Otherwise: where the stream starts. Omit for the live head, or pass `0` to replay the log. |
| `signal`        | Aborting closes the connection, as `close()` does.                                         |
| `maxRetries`    | Retries of the request that opens the stream, as for any call.                             |
| `maxReconnects` | Consecutive failed reconnects tolerated; defaults to 5.                                    |

A connection with neither option starts at the live head: it carries what happens
from now on, and nothing that happened before. `history: true` is what a chat
that draws the conversation so far wants.

The server tails the log forever, so the connection ends only when you end it:

- **Opening the stream is a request like any other**: it is retried under
  `maxRetries` on the same terms, and a refusal such as a `404` fails the
  connection right away, with `ready` rejecting and `state.error` set.
- Once open, **every close is followed by a wait and a fresh connection**
  carrying `Last-Event-ID`, whether the server closed cleanly or the connection
  dropped. The server opens every stream with a cursor frame naming where it
  starts, so a reconnect resumes from there even when the connection carried no
  event at all. The wait is the server's own `retry:` value when it sends one, else
  3 seconds, doubling up to 30 seconds while reconnects keep failing and
  resetting as soon as an event arrives. After `maxReconnects` consecutive
  failed reconnects the status is `failed` and `state.error` holds the last
  failure. A reconnect the server refuses outright fails at once: a `404`, or a
  `401` that a freshly resolved token did not settle.
- **A connection that failed can be opened again**: `reconnect()` starts the
  stream over from `lastSeq` on the same connection object — the same
  subscribers, the same log, the same clients — with the reconnect budget reset
  and `ready` a fresh promise that resolves when the stream is open. The tool
  clients the failure sent away register again once it is, as they would on a
  connection opened from scratch. In any other status, a closed connection
  included, it does nothing. Nothing calls it for you: it is what a "reconnect"
  button in a chat is wired to.
- Subscribers are called synchronously after every change, in seq order, with
  the states that follow their subscription; a listener that throws is reported
  with `console.error` and delivery carries on.

## Client tools

A client is this process offering tools to one session. The connection creates
it and the connection deletes it; in between it registers, keeps itself alive,
and answers every dispatch.

```ts
const client = session.createToolClient("web", {
	// the model sees `client__web__open_contact_form`
	lifetime: { type: "ttl", data: { seconds: 60 } }, // the default; pinged at half the ttl
	onError: (error) => console.error(error), // a ping, an ack, an answer, a delete
});

client.addTool("open_contact_form", {
	description: "Navigate to the contact page and prefill the form.",
	schema: z.object({ text: z.string() }), // any Standard Schema: zod, valibot, arktype
	execute: async ({ text }, call) => `Navigated to /contact with ${text.length} characters.`,
});

await client.ready; // registered; `client.state.id` and `client.state.name` are set

client.removeTool("open_contact_form"); // stops offering it; a call already running still answers
await session.deleteToolClient(client); // also run on session.close() and on the connection's abort
```

A tool says what it takes in one of two ways. A **`schema`** — any
[Standard Schema](https://github.com/standard-schema/standard-schema) value — is
both at once: the parameters the model reads and the validation of what it
sends. Or write the **`parameters`** yourself, with an optional `parse` beside
them:

```ts
client.addTool("open_contact_form", {
	description: "Navigate to the contact page and prefill the form.",
	parameters: {
		type: "object",
		properties: { text: { type: "string" } },
		required: ["text"],
	},
	parse: (args) => ContactArgs.parse(args), // optional; the arguments stay unknown without it
	execute: async (args, call) => `Navigated to /contact.`,
});
```

Either way `execute` takes what the tool said it takes: the schema's output, or
whatever `parse` answered with, typed at the call site with nothing to annotate.

The two spellings are exclusive — a `schema` next to a `parse` is two
validations for one call — and a tool carrying neither has not said what it
takes. A schema that cannot write itself as JSON Schema, which zod 4 can, takes
a `parameters` beside it; one that can neither describe itself nor carry them is
refused by `addTool` rather than at the next update to the server.
`parametersOf(tool)` answers with what the client publishes, whichever spelling
was used.

Arguments the schema refuses never reach `execute`. The model is answered with
every issue it raised, each under the path it was at, which is what lets it
correct the call rather than only learn that it failed.

A client starts empty, and the tools added to it are the whole declaration. A
tool added before the registration goes out with it; after it, every `addTool`
and `removeTool` made in one tick reaches the server as a single update. A
definition whose description and parameters are unchanged tells the server
nothing and only swaps the handler behind the name, so a UI that rebuilds its
tools on every render costs no requests.

A client is a store too, in the same shape as the connection: one immutable
snapshot, replaced on every transition, and one subscription.

```ts
client.state.status; // "joining" | "serving" | "leaving" | "left" | "failed"
client.state.error; // the registration's failure, set when the status is "failed"
client.state.id; // and `name`: what the server called this client
client.state.tools; // the tool names served right now
client.state.calls; // the calls in flight, and the last 50 settled

const stop = client.subscribe((state) => render(state));
```

Each call carries `callId`, `tool`, the `arguments` as dispatched, a `phase` —
`acked`, `running`, then `answered` or `failed` — and, once it has one, the
`answer` that was sent. `answered` means the server took the answer,
error or not (`answer.is_error` says which); `failed` means it never got one. Nothing here is interpreted either: a UI shows
what the client did, and the session's events remain the source of truth.

Await `ready`: a registration the server refused is reported there, and only
there, with the status at `failed` and `state.error` set. The status walks
`joining`, `serving`, `leaving`, `left`. Once a client has left, `addTool` and
`removeTool` reach the server no more. `deleteToolClient` also ends the ping
timer, which is what keeps a Node process alive for a client nobody deletes; it
sends the `DELETE`, aborts the calls in flight, and rejects if the server
refuses, so a delete that failed is worth asking for again.

Registration waits for the stream, so no dispatch can arrive before the client
is listening. Per dispatch, in order: the call is acked at once, the handler is
looked up, `parse`, then `execute(args, call)`. Calls run concurrently.

`execute` answers with a `string`, or with `{ text, is_error }`. Every path
answers, so the model always hears back: an unknown tool, a `parse` that threw,
and an `execute` that threw all settle the call with `is_error: true` and a
short reason. Asking a person first is `execute`'s own business: await the
answer there, and return what they decided.

The SDK ships no schema library, so `parse` is a hook rather than a schema
system. Raw arguments are `unknown`; a handler that wants them typed annotates
its own parameter and lets `parse` make the annotation true.

`call.signal` aborts when the client is deleted and shortly before the server's
five-minute result deadline, so a long tool can stop rather than time out.
`lifetime: { type: "never" }` sends no ping, for a process whose supervisor
guarantees the delete; the ttl is the default everywhere else, because the ping
is the server's only way to learn that a client is gone.

## Errors

Every failure is a `SubakoError`: `status`, `code`, `body`, and a message. The
seven codes the API declares have a class each, and a code this version has not
heard of still arrives with its code and message intact.

```ts
import { ConflictError, NotFoundError, SubakoError } from "@subako-ai/sdk";

try {
	await subako.sessions.postEvent(sessionId, { type: "input", text });
} catch (error) {
	if (error instanceof NotFoundError) {
		// ...
	} else if (error instanceof ConflictError) {
		// ...
	} else if (error instanceof SubakoError) {
		console.error(error.status, error.code, error.message);
	}
}
```

`UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `InvalidRequestError`,
`ConflictError`, `ClientOutdatedError`, and `InternalError` cover the codes. `SubakoConnectionError` means no response
arrived, and `SubakoTimeoutError` is the attempt that outlived its timeout. An
`AbortSignal` you abort yourself is rethrown untouched, never wrapped.

## Timeouts and retries

One attempt may take `timeout` milliseconds (default 60000). A failed attempt is
retried up to `maxRetries` times (default 2, so three attempts), on the same
terms for every call. Every operation that creates or consumes something carries
an `Idempotency-Key` the SDK generates for it, so a repeated attempt is deduped
by the server rather than acting twice; the rest are idempotent already.

Retried:

- A connection failure, or a timeout, including while reading a response body.
- A `5xx`, a `429`, or a `408`.

Not retried:

- Any `4xx`, a `409` among them: the request itself needs changing. A repeat the
  server is still executing under the same key waits on its own lock rather than
  answering, so there is nothing here for a retry to pick up.
- A request whose body is a `ReadableStream`, which cannot be read twice.

A `401` is the one refusal handled outside this budget: with a function
credential the token is resolved again and the request goes once more, spending
no retry, as [Authentication](#authentication) describes.

The wait honours `Retry-After` when the server sends one, and is otherwise
exponential with jitter. Both settings can be set on the client and overridden
per call.

```ts
const subako = new SubakoClient({
	baseUrl,
	apiKey,
	timeout: 10_000,
	maxRetries: 4,
});
await subako.agents.list(undefined, { maxRetries: 0 });
```

### Idempotency keys

The generated key covers the SDK's own retries. Pass `idempotencyKey` to dedupe
across your retries too, or across processes: the same key with the same request
returns the first attempt's receipt instead of acting again, for at least seven
days after it completed.

```ts
await subako.sessions.create({ agent_id: agentId }, { idempotencyKey: `nightly-${date}` });
```

A key is sent only where the operation takes one, and is ignored elsewhere.
Reusing one key for a _different_ request is a `409`, so a `ConflictError` no
retry will settle.

### Receipts

Five operations answer with a secret shown once: `sessions.create`,
`sessions.mintToken`, `apiKeys.mint`, `vaults.startOAuth`, and `vaults.reconnectOAuth`. A replay never carries that secret
again, so each of them answers with either the fresh body or a receipt, and the
type says so:

| Operation               | Fresh (`201`)        | Replayed (`200`)            |
| ----------------------- | -------------------- | --------------------------- |
| `sessions.create`       | `CreatedSessionBody` | `CreatedSessionReceiptBody` |
| `sessions.mintToken`    | `SessionTokenBody`   | `SessionTokenReceiptBody`   |
| `apiKeys.mint`          | `MintedApiKeyBody`   | `ApiKeyReceiptBody`         |
| `vaults.startOAuth`     | `OAuthStarted`       | `OAuthStartReceiptBody`     |
| `vaults.reconnectOAuth` | `OAuthStarted`       | `OAuthStartReceiptBody`     |

The receipt confirms what the first attempt committed — the session and its id,
the key and its prefix, the OAuth connection's expiry — and drops the field carrying the secret, which is what
narrows the union:

```ts
const created = await subako.sessions.create({ agent_id: agentId });
if ("session_token" in created) {
	use(created.session_token);
} else {
	// The first attempt committed and its answer was lost: the session is there
	// under `created.id`, and a fresh mint gives it a token.
	const minted = await subako.sessions.mintToken(created.id);
	if ("session_token" in minted) {
		use(minted.session_token);
	}
}
```

A receipt reaches you only where a key was spent twice: the SDK's own retry of a
lost response, or an `idempotencyKey` you repeated yourself. A first attempt
under a fresh key always answers with the secret.

## Uploading skills

A skill archive is a gzipped tar of the bundle directory, with `SKILL.md` at its
root. Pass bytes, a `Blob`, or a `ReadableStream`.

```ts
import { openAsBlob } from "node:fs";

const skill = await subako.skills.create(await openAsBlob("./skill.tar.gz"));
await subako.skills.pushVersion(skill.skill_id, new Uint8Array(archive));
```

`packSkill` packs files you hold in memory into such an archive, and
`unpackSkill` reads the files back out of one, such as a version's archive from
`subako.skills.download(skillId, version)`.

```ts
import { packSkill, unpackSkill } from "@subako-ai/sdk";

const archive = await packSkill([{ path: "SKILL.md", content: skillMd }]);
const files = await unpackSkill(await subako.skills.download(skill.skill_id, 1));
```
