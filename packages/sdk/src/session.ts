import { type Core, isFinalRefusal, type RequestOptions, sleep } from "./core.js";
import { SubakoConnectionError, SubakoError } from "./errors.js";
import {
	EMPTY_LIVE,
	EMPTY_TRANSCRIPT,
	foldDelta,
	foldTranscript,
	isRunning,
	type LiveMessage,
	type LiveState,
	type PendingApproval,
	pendingApprovals,
	pendingInputs,
	settleLive,
	type TranscriptFold,
	type TranscriptMessage,
} from "./events.js";
import * as api from "./generated/index.js";
import type { InputAnswer, PendingInput } from "./input.js";
import type { SessionApi } from "./resources/sessions.js";
import { notify, Store } from "./store.js";
import { LEAVE, REJOIN, ToolClient, type ToolClientOptions } from "./tool-client.js";

/** What a person may answer an approval with. */
export type ApprovalDecision = "allow" | "deny";

/**
 * The newest part of the log a connection reads first: at least `latest`
 * events, and back to the start of the latest run, so what the readings say
 * about the run under way holds. `loadEarlier` reads further back.
 */
export interface HistoryWindow {
	readonly latest: number;
}

/** Where a connection starts, and how it behaves when the stream drops. */
export interface ConnectOptions {
	/**
	 * Read the log to its end first, the whole of it or only its newest window;
	 * the stream then starts at the last seq read.
	 */
	readonly history?: boolean | HistoryWindow;
	/** Otherwise: where the stream starts; omit to start at the live head, or pass `0` to replay the whole log. */
	readonly afterSeq?: number;
	readonly signal?: AbortSignal;
	/** Retries of the request that opens the stream, as for any call. */
	readonly maxRetries?: number;
	/** Consecutive failed reconnects tolerated after the stream dropped; defaults to 5. */
	readonly maxReconnects?: number;
	readonly headers?: Record<string, string>;
	/** `Kikuvi-Workspace` for the connection and for the clients attached to it. */
	readonly workspaceId?: string;
	/**
	 * Also follow output still being produced, which `state.live` holds until the
	 * log commits it. A preview only: it may miss frames, and the transcript never
	 * depends on it.
	 */
	readonly deltas?: boolean;
}

/** connecting -> open -> (reconnecting -> open)* -> closed | failed. */
export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed" | "failed";

const STREAM_URL: api.StreamSessionEventsData["url"] = "/v1/sessions/{session_id}/events/stream";
const DEFAULT_RECONNECT_MS = 3_000;
/**
 * How long delta frames gather before `live` moves, so a reader draws a
 * growing message at most this often. An event moves it at once.
 */
export const LIVE_REDRAW_MS = 100;
const MAX_RECONNECT_MS = 30_000;
const DEFAULT_MAX_RECONNECTS = 5;
/** How many earlier events `loadEarlier` reads when it is not told. */
const DEFAULT_EARLIER = 100;
/** The most one page of the log holds. */
// CODESYNC(page-limit)
const WINDOW_PAGE = 200;
const LINE = /\r\n|\r|\n/;
/** The SSE event name a delta frame carries. */
// CODESYNC(delta-event-name)
const DELTA_EVENT = "delta";

type Frame =
	| { readonly kind: "event"; readonly data: string }
	/** Output still being produced, which no seq orders. */
	| { readonly kind: "delta"; readonly data: string }
	/** An `id` with no `data`: the stream's own cursor, which the server opens with. */
	| { readonly kind: "cursor"; readonly seq: number }
	| { readonly kind: "retry"; readonly ms: number };

/** Parses `text/event-stream` framing: comments, multi-line data, `id:`, and `retry:`. */
async function* readFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<Frame> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let data: string[] = [];
	let id: string | undefined;
	let name: string | undefined;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
			for (;;) {
				const match = LINE.exec(buffer);
				if (match === null) {
					break;
				}
				// A trailing CR may be the first half of a CRLF still in flight.
				if (match[0] === "\r" && match.index === buffer.length - 1 && !done) {
					break;
				}
				const line = buffer.slice(0, match.index);
				buffer = buffer.slice(match.index + match[0].length);
				if (line === "") {
					if (data.length > 0) {
						yield { kind: name === DELTA_EVENT ? "delta" : "event", data: data.join("\n") };
					} else if (id !== undefined && /^\d+$/.test(id)) {
						yield { kind: "cursor", seq: Number(id) };
					}
					data = [];
					id = undefined;
					name = undefined;
					continue;
				}
				if (line.startsWith(":")) {
					continue;
				}
				const colon = line.indexOf(":");
				const field = colon === -1 ? line : line.slice(0, colon);
				const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
				if (field === "data") {
					data.push(value);
				} else if (field === "event") {
					name = value;
				} else if (field === "id") {
					id = value;
				} else if (field === "retry" && /^\d+$/.test(value)) {
					yield { kind: "retry", ms: Number(value) };
				}
			}
			if (done) {
				return;
			}
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}

/** One frame's payload. A frame that is not JSON is the server's fault, and no reconnect mends it. */
function parseFrame<T extends api.SessionStreamData>(data: string): T {
	try {
		return JSON.parse(data) as T;
	} catch (error) {
		throw new SubakoError("the session event stream carried a frame that is not JSON", { cause: error });
	}
}

/** What the store holds: the connection's own fields, and the events as the raw wire bodies. */
interface Following {
	readonly status: ConnectionStatus;
	/** The failure that ended the connection, set when the status is `failed`. */
	readonly error: unknown;
	readonly lastSeq: number | undefined;
	/** The history, then the live events, in seq order. */
	readonly events: readonly api.SessionEventBody[];
	/** Whether the log holds events before the first of `events`, which `loadEarlier` reads. */
	readonly hasEarlier: boolean;
	/** Messages still being produced, oldest first; empty unless the connection follows `deltas`. */
	readonly live: readonly LiveMessage[];
}

/** The three readings of one events array, derived together because they change together. */
interface Readings {
	readonly transcript: readonly TranscriptMessage[];
	readonly approvals: readonly PendingApproval[];
	/** The forms `builtin:ask_user` put that no answer has settled. */
	readonly inputs: readonly PendingInput[];
	readonly isRunning: boolean;
}

/**
 * One connection as it stands, with the readings of its events joined on: every
 * change replaces the whole snapshot, so a snapshot is the whole of what the
 * connection reads and nothing has to be read off the connection to render it.
 * The readings are getters, so an event nobody reads costs nothing to derive.
 */
export interface SessionState extends Following, Readings {}

/** One session, followed live: every close is answered by a wait and a fresh connection carrying the last seq. */
export class SessionConnection implements AsyncIterable<api.SessionEventBody> {
	readonly sessionId: string;

	readonly #core: Core;
	readonly #sessions: SessionApi;
	readonly #options: ConnectOptions;
	/** Per-event delivery, for the clients attached here. */
	readonly #events = new Set<(event: api.SessionEventBody) => void>();
	readonly #clients = new Set<ToolClient>();
	/** The clients a failure sent away, kept so a `reconnect` can put them back. */
	readonly #sentAway = new Set<ToolClient>();
	readonly #store: Store<Following>;
	#stop = new AbortController();
	#ready: Promise<void>;
	/** The readings of the events array they were derived from, so a re-read costs nothing. */
	#readings: Readings = { transcript: [], approvals: [], inputs: [], isRunning: false };
	#readFrom: readonly api.SessionEventBody[] | undefined;
	/** The snapshot of the store state it was composed from, so an unchanged connection reads as the same object. */
	#snapshot: SessionState | undefined;
	#snapshotFrom: Following | undefined;
	/** The transcript so far, so a new event folds into it rather than rebuilding every message. */
	#folded: TranscriptFold = EMPTY_TRANSCRIPT;
	/** The first event the fold read, so events put before it start the fold over. */
	#foldedFirst: api.SessionEventBody | undefined;
	/** The read of earlier events under way, which a second call joins. */
	#earlier: Promise<void> | undefined;
	/** What `live` is read from, with what the log settled under it; ahead of `live` while frames gather. */
	#live: LiveState = EMPTY_LIVE;
	/** Set while frames gather, until `live` catches up with `#live`. */
	#redraw: ReturnType<typeof setTimeout> | undefined;
	#open: (() => void) | undefined;
	#give: ((error: unknown) => void) | undefined;
	#release: (() => void) | undefined;
	#reconnectMs = DEFAULT_RECONNECT_MS;
	#reconnects = 0;

	constructor(core: Core, sessions: SessionApi, sessionId: string, options: ConnectOptions = {}) {
		this.#core = core;
		this.#sessions = sessions;
		this.#options = options;
		this.sessionId = sessionId;
		this.#store = new Store<Following>({
			status: "connecting",
			error: undefined,
			lastSeq: options.afterSeq,
			events: [],
			hasEarlier: (options.afterSeq ?? 0) > 0,
			live: [],
		});
		this.#ready = this.#promise();
		if (options.signal?.aborted === true) {
			// A signal already aborted opens nothing: the connection starts closed.
			this.close();
			return;
		}
		this.#watch();
		this.#run();
	}

	/** Resolves once the history is read and the stream is open; rejects with the failure. */
	get ready(): Promise<void> {
		return this.#ready;
	}

	/** A fresh `ready`, which a failure nobody awaits settles through the state rather than as a crash. */
	#promise(): Promise<void> {
		const ready = new Promise<void>((resolve, reject) => {
			this.#open = resolve;
			this.#give = reject;
		});
		ready.catch(() => undefined);
		return ready;
	}

	/** A long-lived signal outlives the connection, so the listener leaves with the one it ended. */
	#watch(): void {
		const signal = this.#options.signal;
		const stop = (): void => this.close();
		signal?.addEventListener("abort", stop, { once: true });
		this.#release = () => signal?.removeEventListener("abort", stop);
	}

	/** The stream, from the history to whatever ends it. */
	#run(): void {
		void this.#follow().then(
			() => this.#settle("closed", undefined),
			(error: unknown) => this.#settle(this.#stop.signal.aborted ? "closed" : "failed", error),
		);
	}

	/**
	 * This connection as it stands: a new snapshot on every event and every status
	 * change, and the same object for as long as nothing changes — which is what
	 * `useSyncExternalStore` and every other subscriber compare against.
	 */
	get state(): SessionState {
		const following = this.#store.state;
		if (this.#snapshot === undefined || following !== this.#snapshotFrom) {
			this.#snapshotFrom = following;
			// Derived on the first read and kept, so a snapshot nobody reads derives nothing and a
			// snapshot a render still holds keeps answering with the readings of its own events.
			const events = following.events;
			let readings: Readings | undefined;
			const read = (): Readings => (readings ??= this.#readingsOf(events));
			this.#snapshot = {
				...following,
				get transcript() {
					return read().transcript;
				},
				get approvals() {
					return read().approvals;
				},
				get inputs() {
					return read().inputs;
				},
				get isRunning() {
					return read().isRunning;
				},
			};
		}
		return this.#snapshot;
	}

	/**
	 * The messages of the log, with each call joined to its result and approval.
	 * The same reading as `state.transcript`, taken off the connection rather than
	 * off a snapshot: what a caller outside a React render wants.
	 */
	get transcript(): readonly TranscriptMessage[] {
		return this.#read().transcript;
	}

	/** The approvals no decision has settled. */
	get approvals(): readonly PendingApproval[] {
		return this.#read().approvals;
	}

	/** The forms no answer has settled. */
	get inputs(): readonly PendingInput[] {
		return this.#read().inputs;
	}

	/** Whether a run is queued or under way. */
	get isRunning(): boolean {
		return this.#read().isRunning;
	}

	/** Messages still being produced; see `ConnectOptions.deltas`. */
	get live(): readonly LiveMessage[] {
		return this.#store.state.live;
	}

	/** Calls `listener` with the state after every change; returns an unsubscribe. */
	readonly subscribe = (listener: (state: SessionState) => void): (() => void) =>
		// The store holds the fields; what a subscriber hears is the snapshot, readings and all.
		this.#store.subscribe(() => listener(this.state));

	/** Posts a user turn, which queues a run or steers the active one. */
	readonly send = async (text: string): Promise<void> => {
		await this.#sessions.postEvent(this.sessionId, { type: "input", text }, this.#callOptions);
	};

	/** Cancels the active run, which stops at its next checkpoint. */
	readonly cancel = async (): Promise<void> => {
		await this.#sessions.cancelRun(this.sessionId, this.#callOptions);
	};

	/** Decides a pending approval; a deny may carry the reason the model reads. */
	readonly resolveApproval = async (callId: string, decision: ApprovalDecision, message?: string): Promise<void> => {
		await this.#sessions.resolveApproval(
			this.sessionId,
			callId,
			decision === "allow" ? { decision: "allow" } : { decision: "deny", message },
			this.#callOptions,
		);
	};

	/**
	 * Answers a pending form: submitted with one outcome per question, or
	 * declined. A question this client cannot draw is answered `unsupported`,
	 * so the agent can ask it another way.
	 */
	readonly answerInput = async (callId: string, answer: InputAnswer): Promise<void> => {
		await this.#sessions.resolveInput(this.sessionId, callId, answer, this.#callOptions);
	};

	/** Registers a client serving tools as `client__<name>__<tool>` (`[a-z0-9-]{1,32}`); it starts empty. */
	createToolClient(name: string, options: ToolClientOptions = {}): ToolClient {
		const client = new ToolClient(
			{
				connection: this,
				sessions: this.#sessions,
				events: (listener) => {
					this.#events.add(listener);
					return () => this.#events.delete(listener);
				},
				request: this.#callOptions,
				detach: (left) => this.#clients.delete(left),
			},
			name,
			options,
		);
		// A connection that has ended registers nothing, so it keeps nothing either.
		if (!this.#ended) {
			this.#clients.add(client);
		}
		return client;
	}

	/** Deletes a client: it stops serving at once, and a delete the server refused is worth asking for again. */
	async deleteToolClient(client: ToolClient): Promise<void> {
		this.#clients.delete(client);
		this.#sentAway.delete(client);
		await client[LEAVE](true);
	}

	/**
	 * Opens the stream again after it failed, on this same connection: the log,
	 * the subscribers and the clients are kept, the reconnect budget starts over,
	 * and the clients the failure sent away register again once the stream is
	 * open. Nothing happens in any other status, a closed connection included.
	 */
	reconnect(): void {
		if (this.#store.state.status !== "failed" || this.#options.signal?.aborted === true) {
			return;
		}
		this.#stop = new AbortController();
		this.#reconnects = 0;
		this.#reconnectMs = DEFAULT_RECONNECT_MS;
		this.#ready = this.#promise();
		this.#store.update({ status: "connecting", error: undefined });
		this.#watch();
		// The clients go back on the stream that carries their dispatches, and not before.
		void this.#ready.then(
			() => this.#rejoin(),
			() => undefined,
		);
		this.#run();
	}

	/** Puts the clients a failure sent away back on the stream, each with a registration of its own. */
	#rejoin(): void {
		for (const client of this.#sentAway) {
			this.#sentAway.delete(client);
			if (this.#ended) {
				return;
			}
			this.#clients.add(client);
			// A registration the server refuses is the client's own failure: it settles its `ready` and its state.
			void client[REJOIN]().catch(() => undefined);
		}
	}

	/**
	 * Reads up to `count` events from before the first one held, and puts them
	 * in front of it: the events, and every reading of them, then start further
	 * back. A call while one is under way joins it.
	 */
	loadEarlier(count = DEFAULT_EARLIER): Promise<void> {
		this.#earlier ??= this.#readEarlier(count).finally(() => {
			this.#earlier = undefined;
		});
		return this.#earlier;
	}

	async #readEarlier(count: number): Promise<void> {
		const { events, lastSeq, hasEarlier } = this.#store.state;
		const first = events[0]?.seq ?? (lastSeq === undefined ? undefined : lastSeq + 1);
		if (this.#ended || !hasEarlier || first === undefined) {
			return;
		}
		const page = await this.#sessions.listEvents(
			this.sessionId,
			{ order: "desc", before_seq: first, limit: count },
			this.#callOptions,
		);
		const earlier = [...page.items].reverse();
		if (this.#ended || earlier.length === 0) {
			return;
		}
		const now = this.#store.state;
		this.#store.update({
			events: [...earlier, ...now.events],
			hasEarlier: (earlier[0]?.seq ?? 1) > 1,
			lastSeq: now.lastSeq ?? earlier.at(-1)?.seq,
		});
	}

	/** Ends the stream; the clients attached to it are deleted. */
	close(): void {
		this.#settle("closed", undefined);
	}

	/** The events so far, then live ones, until the connection closes or fails. */
	async *[Symbol.asyncIterator](): AsyncGenerator<api.SessionEventBody> {
		let read = 0;
		let wake: (() => void) | undefined;
		const unwatch = this.#store.subscribe(() => {
			wake?.();
			wake = undefined;
		});
		try {
			for (;;) {
				const events = this.#store.state.events;
				if (read < events.length) {
					const pending = events.slice(read);
					read = events.length;
					yield* pending;
					continue;
				}
				const { status, error } = this.#store.state;
				if (status === "failed") {
					throw error;
				}
				if (status === "closed") {
					return;
				}
				// A yield is an await, so an event may land before the wait even begins.
				await new Promise<void>((resolve) => {
					if (read === this.#store.state.events.length && !this.#ended) {
						wake = resolve;
					} else {
						resolve();
					}
				});
			}
		} finally {
			unwatch();
		}
	}

	/** The connection's whole life: the history, the stream, and every reconnect after it. */
	async #follow(): Promise<void> {
		const history = this.#options.history;
		if (history === true) {
			await this.#readHistory();
		} else if (history !== undefined && history !== false) {
			await this.#readWindow(history.latest);
		}
		let stream = await this.#openStream(false);
		this.#enter("open");

		for (;;) {
			// A close while the stream was opening leaves a body nobody will ever read.
			if (this.#ended) {
				await stream.cancel().catch(() => undefined);
				return;
			}
			let failure: unknown;
			try {
				for await (const frame of readFrames(stream)) {
					if (this.#ended) {
						return;
					}
					switch (frame.kind) {
						case "retry":
							this.#reconnectMs = frame.ms;
							break;
						// The cursor frame opens every stream, so it says nothing about whether this
						// one will deliver: it moves the reconnect position and leaves the budget alone.
						case "cursor":
							this.#mark(frame.seq);
							break;
						case "delta":
							this.#reconnects = 0;
							this.#preview(parseFrame<api.SessionDeltaBody>(frame.data));
							break;
						case "event":
							this.#reconnects = 0;
							this.#deliver(parseFrame<api.SessionEventBody>(frame.data));
							break;
						// COVERAGE(never): a frame has no other kind, which `satisfies never` proves.
						default:
							frame satisfies never;
					}
				}
			} catch (error) {
				// A frame that is not an event is a server bug; reconnecting would only meet it again.
				if (error instanceof SubakoError) {
					throw error;
				}
				failure = error;
			}
			if (this.#stop.signal.aborted) {
				return;
			}
			this.#enter("reconnecting");
			stream = await this.#reconnect(failure);
		}
	}

	/** The reconnect budget is spent across the whole run: one that delivers nothing counts as another failure. */
	async #reconnect(cause: unknown): Promise<ReadableStream<Uint8Array>> {
		const maxReconnects = this.#options.maxReconnects ?? DEFAULT_MAX_RECONNECTS;
		let failure = cause;
		for (;;) {
			if (this.#reconnects >= maxReconnects) {
				throw failure instanceof SubakoError
					? failure
					: new SubakoConnectionError(
							`the session event stream was lost after ${this.#reconnects} reconnects`,
							failure,
						);
			}
			this.#reconnects += 1;
			await sleep(Math.min(this.#reconnectMs * 2 ** (this.#reconnects - 1), MAX_RECONNECT_MS), this.#stop.signal);
			if (this.#stop.signal.aborted) {
				throw new SubakoConnectionError("the session connection was closed");
			}
			try {
				const stream = await this.#openStream(true);
				this.#enter("open");
				return stream;
			} catch (error) {
				if (this.#stop.signal.aborted) {
					throw new SubakoConnectionError("the session connection was closed", error);
				}
				if (isFinalRefusal(error)) {
					throw error;
				}
				failure = error;
			}
		}
	}

	/** Walks the log to its end, oldest first, so the stream can start where the reading stopped. */
	async #readHistory(): Promise<void> {
		const lastSeq = this.#store.state.lastSeq;
		const query = { order: "asc", ...(lastSeq === undefined ? {} : { after_seq: lastSeq }) } as const;
		const page = await this.#sessions.listEvents(this.sessionId, query, this.#streamOptions());
		for await (const event of page) {
			this.#deliver(event);
		}
	}

	/**
	 * Reads the log newest first until it holds `latest` events and the start of
	 * the latest run, then delivers them oldest first, so the stream starts
	 * where the reading stopped. A run is under way only after its own
	 * `run_queued`, so a window that holds it reads the run as the log does.
	 */
	async #readWindow(latest: number): Promise<void> {
		const page = await this.#sessions.listEvents(
			this.sessionId,
			{ order: "desc", limit: Math.min(Math.max(latest, 1), WINDOW_PAGE) },
			this.#streamOptions(),
		);
		const newest: api.SessionEventBody[] = [];
		let runStart = false;
		for await (const event of page) {
			newest.push(event);
			runStart ||= event.type === "run_queued";
			if (newest.length >= latest && runStart) {
				break;
			}
		}
		for (const event of newest.reverse()) {
			this.#deliver(event);
		}
	}

	/** The first connection is retried like any request; a reconnect gets one attempt, the loop being its retry. */
	#openStream(reconnect: boolean): Promise<ReadableStream<Uint8Array>> {
		const lastSeq = this.#store.state.lastSeq;
		const base = this.#streamOptions();
		const request: RequestOptions = {
			...base,
			maxRetries: reconnect ? 0 : base.maxRetries,
			headers: {
				...base.headers,
				...(lastSeq === undefined ? {} : { "Last-Event-ID": String(lastSeq) }),
			},
		};
		return this.#core.stream(
			STREAM_URL,
			{
				path: { session_id: this.sessionId },
				query: {
					...(lastSeq === undefined ? {} : { after_seq: lastSeq }),
					...(this.#options.deltas === true ? { deltas: true } : {}),
				},
			},
			request,
		);
	}

	/** What every request made through this connection carries. */
	get #callOptions(): RequestOptions {
		return { workspaceId: this.#options.workspaceId, headers: this.#options.headers };
	}

	/** The stream's own requests, which end with the connection and take its retry budget. */
	#streamOptions(): RequestOptions {
		return { ...this.#callOptions, signal: this.#stop.signal, maxRetries: this.#options.maxRetries };
	}

	/** Closed and failed are final: nothing after `#settle` moves the status or delivers an event. */
	get #ended(): boolean {
		const status = this.#store.state.status;
		return status === "closed" || status === "failed";
	}

	/** The readings of one snapshot's events: the live array folds onto the last, an older one is read on its own. */
	#readingsOf(events: readonly api.SessionEventBody[]): Readings {
		if (events === this.#store.state.events) {
			return this.#read();
		}
		// A snapshot the connection has moved past: the fold is forward-only, so this one starts over.
		return {
			transcript: foldTranscript(EMPTY_TRANSCRIPT, events).messages,
			approvals: pendingApprovals(events),
			inputs: pendingInputs(events),
			isRunning: isRunning(events),
		};
	}

	/** The events array changes only when an event arrives or earlier ones are read, so it is the whole cache key. */
	#read(): Readings {
		const events = this.#store.state.events;
		if (events !== this.#readFrom) {
			this.#readFrom = events;
			// The live events only ever add to the end, so the transcript folds the new ones onto the
			// messages it has; earlier events put in front start it over.
			const from = events[0] === this.#foldedFirst ? this.#folded : EMPTY_TRANSCRIPT;
			this.#foldedFirst = events[0];
			this.#folded = foldTranscript(from, events);
			this.#readings = {
				transcript: this.#folded.messages,
				approvals: pendingApprovals(events),
				inputs: pendingInputs(events),
				isRunning: isRunning(events),
			};
		}
		return this.#readings;
	}

	/** The cursor the stream opened at, which moves the reconnect position without delivering an event. */
	#mark(seq: number): void {
		const { lastSeq, events, hasEarlier } = this.#store.state;
		if (this.#ended || (lastSeq !== undefined && seq <= lastSeq)) {
			return;
		}
		this.#store.update({ lastSeq: seq, hasEarlier: events.length === 0 ? seq > 0 : hasEarlier });
	}

	#deliver(event: api.SessionEventBody): void {
		// A frame already buffered when the connection ended reaches nobody, so the
		// state, the subscribers, and the iterator agree on where it stopped.
		if (this.#ended) {
			return;
		}
		const { lastSeq, events, hasEarlier } = this.#store.state;
		// A reconnect replays from the last seq the server saw, and the history read
		// may have gone further, so the events only ever move forward.
		if (lastSeq !== undefined && event.seq <= lastSeq) {
			return;
		}
		this.#live = settleLive(this.#live, event);
		// The event carries every frame gathered so far with it.
		clearTimeout(this.#redraw);
		this.#redraw = undefined;
		this.#store.update({
			lastSeq: event.seq,
			events: [...events, event],
			// The log starts at seq 1, so the first event held says whether any came before it.
			hasEarlier: events.length === 0 ? event.seq > 1 : hasEarlier,
			live: this.#live.messages,
		});
		notify(this.#events, event);
	}

	/**
	 * Folds one delta frame into `#live`, unless the log already settled what it
	 * previews, and moves `live` once frames have gathered for `LIVE_REDRAW_MS`.
	 */
	#preview(frame: api.SessionDeltaBody): void {
		if (this.#ended) {
			return;
		}
		const next = foldDelta(this.#live, frame);
		if (next === this.#live) {
			return;
		}
		this.#live = next;
		// `#settle` clears a pending redraw, so none fires once the connection has ended.
		this.#redraw ??= setTimeout(() => {
			this.#redraw = undefined;
			this.#store.update({ live: this.#live.messages });
		}, LIVE_REDRAW_MS);
	}

	#enter(status: ConnectionStatus): void {
		if (this.#ended || this.#store.state.status === status) {
			return;
		}
		this.#store.update({ status });
		if (status === "open") {
			this.#open?.();
		}
	}

	/** The one way this connection ends: the stream stops, ready settles, and the clients leave. */
	#settle(status: "closed" | "failed", error: unknown): void {
		if (this.#ended) {
			return;
		}
		this.#stop.abort();
		clearTimeout(this.#redraw);
		this.#redraw = undefined;
		this.#release?.();
		this.#release = undefined;
		this.#give?.(status === "failed" ? error : new SubakoConnectionError("the session connection was closed"));
		this.#store.update({ status, error: status === "failed" ? error : undefined });
		// A failed connection may be opened again, and the clients it had belong on the new stream.
		if (status === "failed") {
			for (const client of this.#clients) {
				this.#sentAway.add(client);
			}
		}
		// A client that stays registered keeps its tools in front of the model, so it goes either way.
		// The delete is best effort here: a failure reaches the client's own `onError`.
		for (const client of this.#clients) {
			void client[LEAVE]().catch(() => undefined);
		}
	}
}
