import { describeCause, SubakoConnectionError, SubakoError, SubakoTimeoutError, toSubakoError } from "./errors.js";
import type { Auth, Client } from "./generated/client/index.js";
import { createClient, createConfig } from "./generated/client/index.js";
import { IDEMPOTENT_OPERATIONS } from "./generated/idempotency.js";
import { Page } from "./pagination.js";
import { VERSION } from "./version.js";

/** Header naming the workspace a request acts in. */
const WORKSPACE_HEADER = "Kikuvi-Workspace";
/** Header carrying the key the server dedupes a repeated request by. */
const IDEMPOTENCY_HEADER = "Idempotency-Key";
/** The header naming this client to the server, which gates versions by it. */
const CLIENT_HEADER = "Subako-User-Agent";
const CLIENT = `subako-sdk-js/${VERSION}`;
const DEFAULT_BASE_URL = "https://api.us.cloud.subako.ai";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;
const MAX_RETRY_AFTER_MS = 60_000;
const BEARER: readonly Auth[] = [{ scheme: "bearer", type: "http" }];

/** A bearer credential, or a function the SDK calls for one when it needs a token. */
export type TokenSource = string | (() => string | Promise<string>);

/**
 * Exactly one of the two credentials that reach the whole API, both sent as bearer tokens, or
 * `credential: "external"` when something outside the SDK attaches the credential: a
 * backend-for-frontend holding the user's session, a gateway or sidecar that injects the key, or
 * a `fetch` that authenticates on its own. Such a client sends no `Authorization` header and holds
 * nothing it could refresh, so a `401` reaches the caller as an `UnauthorizedError`.
 */
export type Credential =
	| { readonly apiKey: TokenSource; readonly accessToken?: never; readonly credential?: never }
	| { readonly accessToken: TokenSource; readonly apiKey?: never; readonly credential?: never }
	| { readonly credential: "external"; readonly apiKey?: never; readonly accessToken?: never };

/** Where the API is and how requests reach it; both clients take these. */
export interface ClientOptions {
	/** API endpoint; defaults to `https://api.us.cloud.subako.ai`. */
	readonly baseUrl?: string;
	/** Fetch implementation; defaults to `globalThis.fetch`. */
	readonly fetch?: typeof fetch;
	/** Headers merged into every request. */
	readonly headers?: Record<string, string>;
	/** Milliseconds one attempt may take; defaults to 60000. */
	readonly timeout?: number;
	/** Retries after a failed attempt; defaults to 2. */
	readonly maxRetries?: number;
}

export type SubakoClientOptions = Credential &
	ClientOptions & {
		/** `Kikuvi-Workspace` for every request; a call may name another. */
		readonly workspaceId?: string;
	};

/** How a client gets its tokens: one credential for everything, or one per session. */
export type CoreCredential =
	| { readonly kind: "client"; readonly token: TokenSource }
	| { readonly kind: "session"; readonly token: (sessionId: string) => string | Promise<string> }
	| { readonly kind: "external" };

/** What a client hands `Core`: its transport, its default workspace, and its credential. */
export interface CoreOptions extends ClientOptions {
	/** `Kikuvi-Workspace` for every request; a call may name another. */
	readonly workspaceId?: string;
	readonly credential: CoreCredential;
}

/** Per-call overrides every method accepts. */
export interface RequestOptions {
	readonly signal?: AbortSignal;
	/** Milliseconds this call's attempts may take. */
	readonly timeout?: number;
	/** Retries after a failed attempt of this call. */
	readonly maxRetries?: number;
	readonly headers?: Record<string, string>;
	/** `Kikuvi-Workspace` for this call. */
	readonly workspaceId?: string;
	/** The key this call is deduped by, where the operation takes one; the SDK generates one otherwise. */
	readonly idempotencyKey?: string;
}

/** A gzipped tar of a skill bundle. */
export type SkillArchive = Uint8Array | Blob | ReadableStream<Uint8Array>;

/** A generated operation function. */
type Operation = (options: never) => unknown;

type OperationParams<F extends Operation> = NonNullable<Parameters<F>[0]>;

/** The path, query, and body one operation takes, as the generator declares them. */
type OperationData<F extends Operation> = Pick<
	OperationParams<F>,
	Extract<keyof OperationParams<F>, "body" | "path" | "query">
>;

/** The parsed body of one operation's success response. */
type OperationSuccess<F extends Operation> =
	Extract<Awaited<ReturnType<F>>, { error: undefined }> extends { data: infer D } ? D : never;

type OperationQuery<F extends Operation> = NonNullable<OperationData<F> extends { query?: infer Q } ? Q : never>;

/** A query key a listing pages by, of those this API uses. */
type CursorKey<F extends Operation> = Extract<keyof OperationQuery<F>, "after" | "before" | "after_seq" | "before_seq">;

/**
 * The query keys a listing pages by: the one that reads the page after a
 * cursor, and the one that reads the page before it where the listing can.
 */
export interface CursorKeys<F extends Operation> {
	readonly next: CursorKey<F>;
	readonly previous?: CursorKey<F>;
}

/** How every id-keyed listing pages: `after` a page's last item, `before` its first. */
export const BY_ID = { next: "after", previous: "before" } as const;

/** The path and query of an operation whose body the caller passes separately. */
type UploadData<F extends Operation> = Pick<OperationParams<F>, Extract<keyof OperationParams<F>, "path" | "query">>;

type PageItem<F extends Operation> = OperationSuccess<F> extends { items: ReadonlyArray<infer T> } ? T : never;

type PageCursor<F extends Operation> =
	OperationSuccess<F> extends { next_cursor?: infer C } ? (NonNullable<C> extends number ? number : string) : string;

/** The result shape the generated client answers with. */
interface Fields {
	readonly data?: unknown;
	readonly error?: unknown;
	readonly request?: Request;
	readonly response?: Response;
}

interface RawData {
	readonly body?: unknown;
	readonly path?: Record<string, unknown>;
	readonly query?: Record<string, unknown>;
}

/** Transport settings the pipeline adds to an operation's own data. */
interface Transport {
	readonly bodySerializer?: null;
	readonly duplex?: "half";
	readonly parseAs?: "stream";
}

type RawInput = RawData &
	Transport & {
		/** The bearer token this attempt carries, resolved before the attempt began; none when external. */
		readonly auth: string | undefined;
		readonly client: Client;
		readonly headers: Record<string, string>;
		readonly signal: AbortSignal;
	};

type RawOperation = (input: RawInput) => Promise<Fields>;

/** The request data in the untyped shape the pipeline works with. */
const raw = (data: unknown): RawData => data as RawData;

/**
 * `query` reading past `cursor` under `key`. `drop` names the other
 * direction's key: a walk that turns around reads one way only, so its first
 * query's cursor that way goes.
 */
function cursorQuery(
	query: Record<string, unknown> | undefined,
	key: string,
	cursor: string | number,
	drop: string | undefined,
): Record<string, unknown> {
	return Object.fromEntries(Object.entries({ ...query, [key]: cursor }).filter(([name]) => name !== drop));
}

/** Waits, or returns early when `signal` aborts; every backoff in the SDK goes through here. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted === true) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", wake);
			resolve();
		}, ms);
		function wake(): void {
			clearTimeout(timer);
			resolve();
		}
		signal?.addEventListener("abort", wake, { once: true });
	});
}

/** Statuses worth another attempt. A 409 is not among them: the server settles a repeated key under its own lock. */
const isRetryableStatus = (status: number): boolean => status >= 500 || status === 408 || status === 429;

/** A refusal no repeat will change: the resource is gone, or the credential no longer reaches it. */
export const isFinalRefusal = (error: unknown): boolean =>
	error instanceof SubakoError && error.status !== undefined && !isRetryableStatus(error.status);

/** The server's Retry-After when it sent one, else exponential backoff with jitter. */
function retryDelay(response: Response | undefined, attempt: number): number {
	const header = response?.headers.get("retry-after");
	if (header !== null && header !== undefined && header.trim() !== "") {
		const seconds = Number(header);
		const after = Number.isFinite(seconds) ? Math.max(seconds, 0) * 1000 : Math.max(Date.parse(header) - Date.now(), 0);
		if (!Number.isNaN(after)) {
			return Math.min(after, MAX_RETRY_AFTER_MS);
		}
	}
	return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS) * (1 + Math.random() * 0.25);
}

/** What one failed attempt met: the server's refusal, or the transport's own failure. */
function attemptFailure(
	error: unknown,
	response: Response | undefined,
	timedOut: boolean,
	timeout: number,
): SubakoError {
	if (timedOut) {
		return new SubakoTimeoutError(`request timed out after ${timeout}ms`, error);
	}
	if (response !== undefined) {
		return toSubakoError(error, response.status);
	}
	return new SubakoConnectionError(`request failed before a response arrived: ${describeCause(error)}`, error);
}

/** The one credential a `SubakoClient` was built with, as `Core` takes it. */
export function clientCredential(options: SubakoClientOptions): CoreCredential {
	const given = [options.apiKey, options.accessToken].filter((source): source is TokenSource => source !== undefined);
	const external = options.credential === "external";
	const [token] = given;
	if (external && given.length === 0) {
		return { kind: "external" };
	}
	if (external || given.length !== 1 || token === undefined) {
		throw new TypeError('SubakoClient takes exactly one of apiKey, accessToken, or credential: "external"');
	}
	if (token === "") {
		throw new TypeError("the credential given to SubakoClient is empty");
	}
	return { kind: "client", token };
}

/** One client, one credential, one workspace: every request goes from here, with the retries they share. */
export class Core {
	readonly client: Client;
	readonly #timeout: number;
	readonly #maxRetries: number;
	readonly #credential: CoreCredential;
	/** The token every request under one key carries, until a `401` refuses it. */
	readonly #tokens = new Map<string, string>();
	/** The resolution the first requests under one key share, so a function is called once for all of them. */
	readonly #resolving = new Map<string, Promise<string>>();

	constructor(options: CoreOptions) {
		const baseUrl = options.baseUrl === undefined ? DEFAULT_BASE_URL : options.baseUrl;
		if (typeof baseUrl !== "string" || baseUrl === "") {
			throw new TypeError("baseUrl must be a non-empty string");
		}
		this.#credential = options.credential;
		this.#timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
		this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
		this.client = createClient(
			createConfig({
				baseUrl,
				headers: {
					[CLIENT_HEADER]: CLIENT,
					...options.headers,
					...(options.workspaceId === undefined ? {} : { [WORKSPACE_HEADER]: options.workspaceId }),
				},
				...(options.fetch === undefined ? {} : { fetch: options.fetch }),
			}),
		);
	}

	/** Sends one operation and answers with its parsed body. */
	async call<F extends Operation>(
		fn: F,
		data: OperationData<F>,
		options?: RequestOptions,
	): Promise<OperationSuccess<F>> {
		const result = await this.#send(fn, raw(data), options);
		return (result.response?.status === 204 ? undefined : result.data) as OperationSuccess<F>;
	}

	/** Sends one operation whose body is a binary archive rather than JSON. */
	async upload<F extends Operation>(
		fn: F,
		data: UploadData<F>,
		archive: SkillArchive,
		options?: RequestOptions,
	): Promise<OperationSuccess<F>> {
		const transport: Transport =
			archive instanceof ReadableStream ? { bodySerializer: null, duplex: "half" } : { bodySerializer: null };
		const result = await this.#send(fn, { ...raw(data), body: archive }, options, transport);
		return result.data as OperationSuccess<F>;
	}

	/** Reads the first page of a listing and follows its cursors under `keys` either way. */
	page<F extends Operation>(
		fn: F,
		data: OperationData<F>,
		keys: CursorKeys<F>,
		options?: RequestOptions,
	): Promise<Page<PageItem<F>, PageCursor<F>>> {
		const first = raw(data);
		return this.#loadPage(fn, first, keys, options, first.query) as unknown as Promise<
			Page<PageItem<F>, PageCursor<F>>
		>;
	}

	/** Opens a response body as a stream: the timeout bounds reaching the server, never the reading of the body. */
	async stream(url: string, data: RawData, options: RequestOptions): Promise<ReadableStream<Uint8Array>> {
		const operation: RawOperation = (input) => input.client.get({ ...input, security: BEARER, url });
		const result = await this.#send(operation, data, options, { parseAs: "stream" });
		if (!(result.data instanceof ReadableStream)) {
			throw new SubakoConnectionError("the event stream response carried no body");
		}
		return result.data as ReadableStream<Uint8Array>;
	}

	async #loadPage(
		fn: Operation,
		data: RawData,
		keys: { readonly next: string; readonly previous?: string },
		options: RequestOptions | undefined,
		query: Record<string, unknown> | undefined,
	): Promise<Page<unknown, string | number>> {
		const result = await this.#send(fn, { ...data, query }, options);
		const body = result.data as {
			items: readonly unknown[];
			next_cursor?: string | number | null;
			prev_cursor?: string | number | null;
		};
		const previousKey = keys.previous;
		const load = (key: string, drop: string | undefined) => (cursor: string | number) =>
			this.#loadPage(fn, data, keys, options, cursorQuery(data.query, key, cursor, drop));
		return new Page(
			body.items,
			body.next_cursor ?? null,
			load(keys.next, previousKey),
			previousKey === undefined ? undefined : { cursor: body.prev_cursor ?? null, load: load(previousKey, keys.next) },
		);
	}

	async #send(
		fn: Operation,
		data: RawData,
		options: RequestOptions | undefined,
		transport?: Transport,
	): Promise<Fields> {
		const operation = fn as unknown as RawOperation;
		const maxRetries = options?.maxRetries ?? this.#maxRetries;
		const timeout = options?.timeout ?? this.#timeout;
		// The credential this call spends: the session's own, or the client's one.
		const credentialKey = this.#credentialKey(data);
		// One key for the whole logical call, so every attempt asks the server for the same answer.
		const headers = requestHeaders(fn, options);
		// A stream body can be read once, so a request carrying one is never resent.
		const resendable = !(data.body instanceof ReadableStream);
		// A call spends one fresh token at most: a second refusal is the credential's own.
		let refreshed = false;
		let attempt = 0;

		for (;;) {
			// A credential that throws is the caller's own failure, and travels unwrapped.
			const auth = await this.#authorize(credentialKey);
			const input = { ...data, ...transport, auth, headers };
			const { fields, timedOut } = await this.#attempt(operation, input, timeout, options?.signal);
			if (fields.error === undefined) {
				return fields;
			}
			// The caller's own abort is theirs to see, unwrapped.
			options?.signal?.throwIfAborted();
			const { request, response } = fields;
			// No request was built, so the failure is the caller's own: a url that is not one, say.
			if (request === undefined && response === undefined && !timedOut) {
				throw fields.error;
			}
			const failure = attemptFailure(fields.error, response, timedOut, timeout);
			// A token the server refused is worth replacing once, and the replacement costs
			// no retry: the same request goes again under the same key, with a fresh token.
			if (response?.status === 401 && !refreshed && resendable && this.#expire(credentialKey, auth)) {
				refreshed = true;
				continue;
			}
			// One policy for every operation: what the server may already have acted on it dedupes by the key.
			const again =
				resendable &&
				attempt < maxRetries &&
				(timedOut || response === undefined || isRetryableStatus(response.status));
			if (!again) {
				throw failure;
			}
			await sleep(retryDelay(response, attempt), options?.signal);
			options?.signal?.throwIfAborted();
			attempt += 1;
		}
	}

	/** One attempt under the caller's signal and its own deadline; `timedOut` says which ended it. */
	async #attempt(
		operation: RawOperation,
		input: Omit<RawInput, "client" | "signal">,
		timeout: number,
		signal: AbortSignal | undefined,
	): Promise<{ fields: Fields; timedOut: boolean }> {
		const deadline = new AbortController();
		const timer = Number.isFinite(timeout) && timeout > 0 ? setTimeout(() => deadline.abort(), timeout) : undefined;
		try {
			const fields = await operation({
				...input,
				client: this.client,
				signal: signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal]),
			});
			return { fields, timedOut: deadline.signal.aborted };
		} finally {
			clearTimeout(timer);
		}
	}

	/** The key a request's token is cached under: the session it names, or the client's one credential. */
	#credentialKey(data: RawData): string {
		switch (this.#credential.kind) {
			case "client":
			case "external":
				return "";
			case "session":
				break;
			default:
				return unreachable(this.#credential);
		}
		const sessionId = data.path?.["session_id"];
		if (typeof sessionId !== "string" || sessionId === "") {
			throw new TypeError("this client holds a token per session, and this request names no session");
		}
		return sessionId;
	}

	/**
	 * The token this attempt carries: the cached one, or the one the first requests wait together
	 * for. An external credential is none of the SDK's, and the request goes without an
	 * `Authorization` header.
	 */
	async #authorize(key: string): Promise<string | undefined> {
		const credential = this.#credential;
		if (credential.kind === "external") {
			return undefined;
		}
		const token = this.#tokens.get(key);
		if (token !== undefined) {
			return token;
		}
		const resolving = this.#resolving.get(key) ?? this.#resolve(credential, key);
		this.#resolving.set(key, resolving);
		try {
			return await resolving;
		} finally {
			// The slot is freed either way, so a later request resolves again rather than
			// reading back a token a `401` has since spent, or one the credential threw over.
			if (this.#resolving.get(key) === resolving) {
				this.#resolving.delete(key);
			}
		}
	}

	async #resolve(credential: TokenCredential, key: string): Promise<string> {
		const answer = tokenFor(credential, key);
		const token = await answer;
		// An empty token would travel as no `Authorization` header at all, so it is refused here.
		if (token === "") {
			throw new TypeError("the credential resolved to an empty string");
		}
		this.#tokens.set(key, token);
		return token;
	}

	/** Drops the token a `401` refused, under that key alone, and answers whether the request should go again. */
	#expire(key: string, refused: string | undefined): boolean {
		const credential = this.#credential;
		switch (credential.kind) {
			// Whatever holds the credential is the only thing that can renew it, so the refusal is the caller's to see.
			case "external":
				return false;
			case "client":
				if (typeof credential.token !== "function") {
					return false;
				}
				break;
			case "session":
				break;
			default:
				return unreachable(credential);
		}
		// Another request may have replaced it already; then this one simply takes theirs.
		if (this.#tokens.get(key) === refused) {
			this.#tokens.delete(key);
		}
		return true;
	}
}

/** A credential that hands the SDK tokens to send. */
type TokenCredential = Exclude<CoreCredential, { kind: "external" }>;

/** What a credential answers for the token under `key`: a session credential is asked for that session. */
function tokenFor(credential: TokenCredential, key: string): string | Promise<string> {
	switch (credential.kind) {
		case "session":
			return credential.token(key);
		case "client":
			return typeof credential.token === "function" ? credential.token() : credential.token;
		default:
			return unreachable(credential);
	}
}

function unreachable(value: never): never {
	throw new Error(`unreachable: ${JSON.stringify(value)}`);
}

/** What one call adds to the client's own headers, its idempotency key among them. */
function requestHeaders(fn: Operation, options: RequestOptions | undefined): Record<string, string> {
	const workspaceId = options?.workspaceId;
	// By reference, not by name: a minifier renames the function but not the module's binding.
	const keyed = IDEMPOTENT_OPERATIONS.has(fn);
	return {
		...(keyed ? { [IDEMPOTENCY_HEADER]: options?.idempotencyKey ?? crypto.randomUUID() } : {}),
		...options?.headers,
		...(workspaceId === undefined ? {} : { [WORKSPACE_HEADER]: workspaceId }),
	};
}
