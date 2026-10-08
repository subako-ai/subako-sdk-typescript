import type { StandardSchemaV1 } from "@standard-schema/spec";
import { isFinalRefusal, type RequestOptions } from "./core.js";
import { SubakoError } from "./errors.js";
import * as api from "./generated/index.js";
import type { SessionApi } from "./resources/sessions.js";
import { describesItself, jsonSchemaOf, validateSchema } from "./schema.js";
import type { SessionConnection } from "./session.js";
import { Store } from "./store.js";

/** What a tool answers with: text, or text the model reads as a failure. */
export type ToolAnswer = string | api.ClientCallResultBody;

/** The call a handler runs under. */
export interface ToolCall {
	readonly callId: string;
	/** Aborts when the client leaves, and shortly before the server's result deadline. */
	readonly signal: AbortSignal;
}

/** A JSON Schema object describing what a tool takes, as the model reads it. */
export type ToolParameters = api.ClientToolBody["parameters"];

/**
 * The arguments one call arrived with, as they came off the wire. The same shape as
 * `ToolParameters` and not the same thing: that one is the schema, this one is an
 * instance of it, and a tool that confuses the two reads its own schema as input.
 */
export type ToolArguments = Readonly<Record<string, unknown>>;

/** A tool that writes its own JSON Schema, and narrows the raw arguments itself. */
export interface ParsedTool<A = unknown> {
	/** What the tool does, as the model reads it. */
	readonly description: string;
	/** JSON Schema object describing the tool's arguments. */
	readonly parameters: ToolParameters;
	/** Turns raw arguments into what the handler takes; a throw answers the call as a failure. */
	parse?(args: ToolArguments): A | Promise<A>;
	/** A tool validates one way or the other, never both. */
	readonly schema?: never;
	execute(args: A, call: ToolCall): ToolAnswer | Promise<ToolAnswer>;
}

/**
 * A tool described by a Standard Schema — zod, valibot, arktype. It is the parameters the
 * model reads and the validation of what it sends, and what `execute` takes comes from it.
 */
export interface SchemaTool<A = unknown> {
	/** What the tool does, as the model reads it. */
	readonly description: string;
	/** The schema, which the arguments are validated against before `execute` runs. */
	readonly schema: StandardSchemaV1<unknown, A>;
	/** Only for a schema that cannot write itself as JSON Schema; otherwise the schema says it. */
	readonly parameters?: ToolParameters;
	/** The schema is the validation, so there is nothing for a hook to do. */
	readonly parse?: never;
	execute(args: A, call: ToolCall): ToolAnswer | Promise<ToolAnswer>;
}

/**
 * One tool a client serves: a schema, or the parameters with a `parse` hook beside them.
 * The SDK ships no schema library and picks none — a Standard Schema is a protocol, and
 * `parse` stays for an app that would rather not bring one.
 */
export type ToolDefinition<A = unknown> = ParsedTool<A> | SchemaTool<A>;

/** The parameters the model is offered: the tool's own, or the ones its schema writes. */
export function parametersOf(tool: ToolDefinition): ToolParameters {
	if (tool.parameters !== undefined) {
		return tool.parameters;
	}
	if (tool.schema !== undefined && describesItself(tool.schema)) {
		return jsonSchemaOf(tool.schema);
	}
	throw new TypeError(
		"addTool: this schema cannot write itself as JSON Schema, so pass `parameters` next to it (zod 4: `z.toJSONSchema(schema)`)",
	);
}

export interface ToolClientOptions {
	/** Defaults to a 60 second ttl, pinged at half of it. */
	readonly lifetime?: api.ClientLifetimeForm;
	/** Background failures: a ping, an ack, an answer, a delete. */
	readonly onError?: (error: unknown) => void;
}

/** What `SessionConnection` hands a client it creates. */
interface ToolClientContext {
	readonly connection: SessionConnection;
	readonly sessions: SessionApi;
	/** The connection's per-event hook, which is how a dispatch reaches its client. */
	readonly events: (listener: (event: api.SessionEventBody) => void) => () => void;
	readonly request: RequestOptions;
	readonly detach: (client: ToolClient) => void;
}

/** One call this client took on, from the ack to the answer. */
export interface ToolCallState {
	readonly callId: string;
	readonly tool: string;
	/** The raw arguments, as dispatched. */
	readonly arguments: object;
	/** `answered` once the server took an answer, error or not; `failed` when it never got one. */
	readonly phase: "acked" | "running" | "answered" | "failed";
	readonly answer?: api.ClientCallResultBody;
}

/** One client, as it stands now: every transition replaces the whole snapshot. */
export interface ToolClientState {
	readonly status: ToolClientStatus;
	/** The registration's failure, set when the status is `failed`. */
	readonly error: unknown;
	readonly id: string | undefined;
	readonly name: string | undefined;
	/** The tool names served right now. */
	readonly tools: readonly string[];
	/** The calls in flight, and the last settled ones. */
	readonly calls: readonly ToolCallState[];
}

const DEFAULT_LIFETIME: api.ClientLifetimeForm = { type: "ttl", data: { seconds: 60 } };
/** The server fails an acked call 300s after the ack; the answer keeps the last 10s to reach it. */
const ANSWER_DEADLINE_MS = 290_000;
/** Settled calls kept, so a UI can show what just happened; older ones are dropped. */
const KEPT_CALLS = 50;
/** A lifetime that never lapses has no ping tick to retry a refused set on: it waits what a 60s ttl would. */
const RETRY_MS = 30_000;

type Dispatch = Extract<api.SessionEventBody, { type: "client_tool_dispatched" }>;

/** joining -> serving -> leaving -> left, or joining -> failed when the registration was refused. */
export type ToolClientStatus = "joining" | "serving" | "leaving" | "left" | "failed";

/** How `SessionConnection.deleteToolClient` reaches a client; not a name the SDK publishes. */
export const LEAVE: unique symbol = Symbol("subako.leave");

/** How `SessionConnection.reconnect` puts a client back on the stream that came back; not published either. */
export const REJOIN: unique symbol = Symbol("subako.rejoin");

const isDispatch = (event: api.SessionEventBody): event is Dispatch => event.type === "client_tool_dispatched";

const reason = (error: unknown): string =>
	error instanceof Error && error.message !== "" ? error.message : "the tool failed";

/** A call is settled once it has answered or failed, and never moves again. */
const isSettled = (call: ToolCallState): boolean => call.phase === "answered" || call.phase === "failed";

/** A call the client will never answer, because it stopped serving under it. */
const abandon = (call: ToolCallState): ToolCallState => (isSettled(call) ? call : { ...call, phase: "failed" });

/** Keeps every call still in flight, and the newest settled ones. */
function trimCalls(calls: readonly ToolCallState[]): ToolCallState[] {
	let drop = calls.filter(isSettled).length - KEPT_CALLS;
	if (drop <= 0) {
		return [...calls];
	}
	return calls.filter((call) => {
		if (drop > 0 && isSettled(call)) {
			drop -= 1;
			return false;
		}
		return true;
	});
}

/** A process offering tools to one session: it registers, stays alive, answers every dispatch, and goes. */
export class ToolClient {
	readonly #context: ToolClientContext;
	/** The name asked for; `state.name` is the one the server gave back. */
	readonly #name: string;
	readonly #options: ToolClientOptions;
	readonly #lifetime: api.ClientLifetimeForm;
	readonly #running = new Set<AbortController>();
	/** Dispatches that arrived before the registration's answer named this client. */
	readonly #early: Dispatch[] = [];
	readonly #store: Store<ToolClientState>;
	/** The tools wanted right now, in the order they were added. */
	readonly #tools = new Map<string, ToolDefinition>();
	/** What the server was last told, so a reconcile that would change nothing is skipped. */
	#published: string | undefined;
	/** A set the server refused, still owed: the next ping tick sends it again. */
	#owed = false;
	#scheduled = false;
	/** Updates run one after another, so the server sees the changes in the order they were made. */
	#queue: Promise<void> = Promise.resolve();
	#ping: ReturnType<typeof setInterval> | undefined;
	/** The one retry a client with no ping tick gets after a refused update. */
	#retry: ReturnType<typeof setTimeout> | undefined;
	#unsubscribe: (() => void) | undefined;
	/** The delete in flight, so a second ask joins it rather than sending another. */
	#leaving: Promise<void> | undefined;
	/** An owner's deletion is permanent, including while a reconnect waits for the previous DELETE. */
	#deleted = false;
	#ready: Promise<void>;

	constructor(context: ToolClientContext, name: string, options: ToolClientOptions) {
		this.#context = context;
		this.#name = name;
		this.#options = options;
		this.#lifetime = options.lifetime ?? DEFAULT_LIFETIME;
		this.#store = new Store<ToolClientState>({
			status: "joining",
			error: undefined,
			id: undefined,
			name: undefined,
			tools: [],
			calls: [],
		});
		this.#ready = this.#register();
	}

	/**
	 * Resolves once registered, with `state.id` and `state.name` set; rejects with
	 * the registration's failure. A connection that was reconnected hands out the
	 * new registration's promise.
	 */
	get ready(): Promise<void> {
		return this.#ready;
	}

	/** One registration; its failure belongs to whoever awaits `ready`, and crashes nothing on its own. */
	#register(): Promise<void> {
		const ready = this.#join();
		ready.catch(() => undefined);
		return ready;
	}

	/** This client as it stands: a new snapshot on every transition. */
	get state(): ToolClientState {
		return this.#store.state;
	}

	/** Calls `listener` with the state after every change; returns an unsubscribe. */
	readonly subscribe = (listener: (state: ToolClientState) => void): (() => void) => this.#store.subscribe(listener);

	/** Offers a tool, or a new definition behind a name already offered; one tick's changes go as one update. */
	addTool<A>(name: string, tool: ToolDefinition<A>): void {
		// One client carries the whole set, and the server takes the set or none of it. A nameless
		// tool is therefore not one tool missing — it is every tool on the page going quiet, which
		// is a long way from the typo that caused it.
		if (name.trim() === "") {
			throw new TypeError("addTool: a tool needs a name");
		}
		// Refused here rather than at the next reconcile: the set goes to the server in the
		// background, and a throw there would surface a long way from the tool that caused it.
		parametersOf(tool);
		const added = !this.#tools.has(name);
		this.#tools.set(name, tool);
		if (added) {
			this.#store.update({ tools: [...this.#tools.keys()] });
		}
		this.#schedule();
	}

	/** Stops offering a tool; a call already running under it still answers. */
	removeTool(name: string): void {
		if (!this.#tools.delete(name)) {
			return;
		}
		this.#store.update({ tools: [...this.#tools.keys()] });
		this.#schedule();
	}

	/** The connection's delete: the client stops serving at once but stays registered until the server is told. */
	async [LEAVE](permanent = false): Promise<void> {
		this.#deleted ||= permanent;
		if (this.#store.state.status === "left") {
			return;
		}
		// A delete already under way is the same delete: the client's owner and the
		// connection's close may both ask for it, and the server is told once.
		this.#leaving ??= this.#leave().finally(() => {
			this.#leaving = undefined;
		});
		await this.#leaving;
	}

	/** The connection's reconnect: the same client, registering again on the stream that came back. */
	async [REJOIN](): Promise<void> {
		// A delete the failure sent may still be in flight; the registration follows it.
		await this.#leaving?.catch(() => undefined);
		if (this.#deleted) {
			return;
		}
		const status = this.#store.state.status;
		if (status === "joining" || status === "serving") {
			return;
		}
		// The server has none of this client's tools, so the whole set goes with the registration.
		this.#published = undefined;
		this.#owed = false;
		this.#store.update({ status: "joining", error: undefined, id: undefined, name: undefined });
		this.#ready = this.#register();
		await this.#ready;
	}

	/** The delete itself: the client stops serving here, whatever the server makes of it. */
	async #leave(): Promise<void> {
		// A call the delete aborts never answers, so it settles here rather than hanging.
		this.#store.update({ status: "leaving", calls: trimCalls(this.#store.state.calls.map(abandon)) });
		this.#stopServing();
		for (const call of this.#running) {
			call.abort();
		}
		this.#running.clear();
		// A registration still in flight is waited out, so it cannot outlive the client.
		await this.ready.catch(() => undefined);
		const id = this.#store.state.id;
		if (id === undefined) {
			this.#store.update({ status: "left" });
			return;
		}
		try {
			await this.#context.sessions.leaveClient(this.#context.connection.sessionId, id, this.#context.request);
		} catch (error) {
			this.#report(error);
			throw error;
		}
		this.#store.update({ status: "left" });
	}

	/** Registration waits for the stream, so no dispatch can arrive before the subscription. */
	async #join(): Promise<void> {
		const connection = this.#context.connection;
		await connection.ready;
		// A connection that has ended delivers nothing, so there is nothing to serve.
		const status = connection.state.status;
		if (status === "closed" || status === "failed") {
			// The client fails where it stands rather than waiting in `joining` for a registration nobody will send.
			const ended = new SubakoError("the session connection ended before this client could register");
			this.#store.update({ status: "failed", error: ended });
			throw ended;
		}
		// A client deleted while the stream was opening never registers at all; the delete settles it as `left`.
		if (this.#store.state.status !== "joining") {
			throw new SubakoError("this client left before it registered");
		}
		this.#unsubscribe = this.#context.events((event) => this.#receive(event));
		// The set as it stands goes out with the registration, so a tool declared
		// while the stream was opening needs no update of its own.
		const bodies = this.#bodies();
		let registered: api.RegisteredClientBody;
		try {
			registered = await this.#context.sessions.registerClient(
				connection.sessionId,
				{ name: this.#name, lifetime: this.#lifetime, tools: bodies },
				this.#context.request,
			);
		} catch (error) {
			// A registration that failed serves nothing: the subscription and what it buffered go with it.
			this.#store.update({ status: "failed", error });
			this.#stopServing();
			throw error;
		}
		this.#published = JSON.stringify(bodies);
		if (this.#store.state.status !== "joining") {
			this.#store.update({ id: registered.id, name: registered.name });
			return;
		}
		this.#store.update({
			status: "serving",
			id: registered.id,
			name: registered.name,
			tools: [...this.#tools.keys()],
		});
		this.#startPing();
		for (const event of this.#early.splice(0)) {
			this.#receive(event);
		}
		// A tool declared while the registration was in flight is still owed to the server.
		this.#schedule();
	}

	/** The registration is gone: the client stops serving at once, and the calls under it never answer. */
	#gone(): void {
		if (this.#store.state.status !== "serving") {
			return;
		}
		this.#store.update({ status: "left", calls: trimCalls(this.#store.state.calls.map(abandon)) });
		this.#stopServing();
		for (const call of this.#running) {
			call.abort();
		}
		this.#running.clear();
	}

	/** Everything the client was doing stops here; only the DELETE itself may still be owed. */
	#stopServing(): void {
		this.#stopPing();
		clearTimeout(this.#retry);
		this.#retry = undefined;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#early.length = 0;
		this.#context.detach(this);
	}

	#receive(event: api.SessionEventBody): void {
		// The server let this client go: it is not registered any more, whatever it was serving.
		if (event.type === "client_left" && event.client_id === this.#store.state.id) {
			this.#gone();
			return;
		}
		if (!isDispatch(event)) {
			return;
		}
		// Until the registration answers there is no id to filter on, so the dispatch waits.
		const { status, id } = this.#store.state;
		if (status === "joining") {
			this.#early.push(event);
			return;
		}
		if (status === "serving" && event.client_id === id) {
			void this.#serve(event);
		}
	}

	/** Ack at once, run the tool under its own deadline, then answer. Calls run concurrently. */
	async #serve(dispatch: Dispatch): Promise<void> {
		const sessionId = this.#context.connection.sessionId;
		const id = this.#store.state.id;
		if (id === undefined) {
			return;
		}
		const call = new AbortController();
		this.#running.add(call);
		const deadline = setTimeout(() => call.abort(), ANSWER_DEADLINE_MS);
		const clearDeadline = (): void => clearTimeout(deadline);
		call.signal.addEventListener("abort", clearDeadline, { once: true });
		try {
			try {
				await this.#context.sessions.ackCall(sessionId, id, dispatch.call_id, {
					...this.#context.request,
					signal: call.signal,
				});
				call.signal.throwIfAborted();
			} catch (error) {
				this.#track(dispatch, "failed");
				if (!call.signal.aborted) {
					this.#report(error);
				}
				return;
			}
			this.#track(dispatch, "acked");
			const answer = await this.#answer(dispatch, { callId: dispatch.call_id, signal: call.signal });
			clearDeadline();
			// The set this call changed goes out first, so the model's next turn can call what it declared.
			await this.#toolsSettled();
			// Leaving clears the running set. A later registration cannot answer an old call,
			// even if it is already serving again by the time the handler finishes.
			if (!this.#running.has(call) || this.#store.state.status !== "serving") {
				this.#patch(dispatch.call_id, { phase: "failed", answer });
				return;
			}
			try {
				await this.#context.sessions.answerCall(sessionId, id, dispatch.call_id, answer, this.#context.request);
				this.#patch(dispatch.call_id, { phase: "answered", answer });
			} catch (error) {
				this.#patch(dispatch.call_id, { phase: "failed", answer });
				this.#report(error);
			}
		} finally {
			clearDeadline();
			call.signal.removeEventListener("abort", clearDeadline);
			this.#running.delete(call);
		}
	}

	/** Every path answers: the model hears back even when nothing here could serve the call. */
	async #answer(dispatch: Dispatch, call: ToolCall): Promise<api.ClientCallResultBody> {
		const tool = this.#tools.get(dispatch.tool);
		if (tool === undefined) {
			return { text: `no tool named ${dispatch.tool} is served here`, is_error: true };
		}
		let args: unknown;
		try {
			call.signal.throwIfAborted();
			if (tool.schema !== undefined) {
				const validated = await validateSchema(tool.schema, dispatch.arguments);
				if (!validated.ok) {
					return { text: `the arguments were not valid: ${validated.message}`, is_error: true };
				}
				args = validated.value;
			} else {
				args = tool.parse === undefined ? dispatch.arguments : await tool.parse(dispatch.arguments);
			}
		} catch (error) {
			return { text: `the arguments were not valid: ${reason(error)}`, is_error: true };
		}
		try {
			call.signal.throwIfAborted();
			this.#patch(dispatch.call_id, { phase: "running" });
			// Validation and state subscribers may both have ended this call. No await
			// may separate this check from the handler's first side effect.
			call.signal.throwIfAborted();
			const result = await tool.execute(args, call);
			return typeof result === "string" ? { text: result } : result;
		} catch (error) {
			return { text: reason(error), is_error: true };
		}
	}

	/** A mount that declares several tools, and a remount that drops and re-adds one, settle into one update. */
	#schedule(): void {
		if (this.#scheduled) {
			return;
		}
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			// One update at a time; a rejection settles the queue without stopping the next,
			// and nobody awaits a reconcile the set asked for, so its failure is a background one.
			const next = this.#queue.then(
				() => this.#flush(),
				() => this.#flush(),
			);
			this.#queue = next.catch(() => undefined);
			void next.catch((error: unknown) => this.#report(error));
		});
	}

	/** Waits out an update the set is owed, so nothing answers a call ahead of the tools it changed. */
	async #toolsSettled(): Promise<void> {
		// `addTool` queues its update in a microtask, so a set changed inside `execute` reaches the queue first.
		while (this.#scheduled) {
			await Promise.resolve();
		}
		await this.#queue;
	}

	/** Tells the server the set it does not have yet, and nothing when it already has it. */
	async #flush(): Promise<void> {
		const { status, id } = this.#store.state;
		// Nothing is owed before the registration named this client, or after it stopped serving.
		if (id === undefined || status !== "serving") {
			return;
		}
		const bodies = this.#bodies();
		const signature = JSON.stringify(bodies);
		if (signature === this.#published) {
			return;
		}
		this.#published = signature;
		try {
			await this.#context.sessions.updateClientTools(
				this.#context.connection.sessionId,
				id,
				{ tools: bodies },
				this.#context.request,
			);
			this.#owed = false;
		} catch (error) {
			// The server still holds what it held, so the set stays owed and a later tick sends it again.
			this.#published = undefined;
			this.#owed = true;
			this.#scheduleRetry();
			throw error;
		}
	}

	/** A ttl client retries on its own ping tick; one that never lapses gets a single timer instead. */
	#scheduleRetry(): void {
		if (this.#lifetime.type === "ttl" || this.#retry !== undefined) {
			return;
		}
		const retry = setTimeout(() => {
			this.#retry = undefined;
			this.#retryOwed();
		}, RETRY_MS);
		// Node keeps a process alive for its timers; a retry should not. Browsers have no such notion.
		if (typeof retry === "object" && "unref" in retry) {
			retry.unref();
		}
		this.#retry = retry;
	}

	/** Sends the set the server refused again; the update reports its own failure, as any other does. */
	#retryOwed(): void {
		if (!this.#owed) {
			return;
		}
		this.#schedule();
	}

	/** The set as the wire carries it, in the order the tools were added. */
	#bodies(): api.ClientToolBody[] {
		return [...this.#tools].map(([name, tool]) => ({
			name,
			description: tool.description,
			parameters: parametersOf(tool),
		}));
	}

	/** A dispatch this client took on, from the ack that opened it. */
	#track(dispatch: Dispatch, phase: ToolCallState["phase"]): void {
		const call: ToolCallState = {
			callId: dispatch.call_id,
			tool: dispatch.tool,
			arguments: dispatch.arguments,
			phase,
		};
		this.#store.update({ calls: trimCalls([...this.#store.state.calls, call]) });
	}

	/** Moves one call along; a call that has settled stays where it is. */
	#patch(callId: string, patch: Partial<ToolCallState>): void {
		const calls = this.#store.state.calls;
		const index = calls.findIndex((call) => call.callId === callId);
		const current = calls[index];
		if (current === undefined || isSettled(current)) {
			return;
		}
		const next = [...calls];
		next[index] = { ...current, ...patch };
		this.#store.update({ calls: trimCalls(next) });
	}

	#startPing(): void {
		if (this.#lifetime.type !== "ttl") {
			return;
		}
		const every = Math.max((this.#lifetime.data.seconds * 1000) / 2, 1_000);
		const ping = setInterval(() => {
			void this.#sendPing();
			// The tick that keeps the client alive is also when a set the server refused goes again.
			this.#retryOwed();
		}, every);
		// Node keeps a process alive for its timers; a keep-alive ping should not. Browsers have no such notion.
		if (typeof ping === "object" && "unref" in ping) {
			ping.unref();
		}
		this.#ping = ping;
	}

	#stopPing(): void {
		clearInterval(this.#ping);
		this.#ping = undefined;
	}

	async #sendPing(): Promise<void> {
		const { status, id } = this.#store.state;
		if (id === undefined || status !== "serving") {
			return;
		}
		try {
			await this.#context.sessions.pingClient(this.#context.connection.sessionId, id, this.#context.request);
		} catch (error) {
			this.#report(error);
			// A refusal every later ping would meet again: the registration is gone, so the client is too.
			if (isFinalRefusal(error)) {
				this.#gone();
			}
		}
	}

	#report(error: unknown): void {
		this.#options.onError?.(error);
	}
}
