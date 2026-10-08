import { SubakoClient, SubakoSessionClient, type TokenSource } from "../src/index.js";

export type Handler = (request: Request) => Response | Promise<Response>;

/** A fetch stub: it records every request and answers from a queue of handlers. */
export interface FetchStub {
	readonly fetch: typeof fetch;
	readonly calls: readonly Request[];
}

export function stubFetch(...handlers: readonly Handler[]): FetchStub {
	const calls: Request[] = [];
	const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const request = input instanceof Request ? input : new Request(input, init);
		calls.push(request.clone());
		const handler = handlers[Math.min(calls.length - 1, handlers.length - 1)];
		if (handler === undefined) {
			throw new Error("fetch stub has no handler");
		}
		return handler(request);
	};
	return { fetch: impl as unknown as typeof fetch, calls };
}

export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function text(body: string, status: number, contentType = "text/plain"): Response {
	return new Response(body, { status, headers: { "content-type": contentType } });
}

export function empty(status: number, headers: Record<string, string> = {}): Response {
	return new Response(null, { status, headers });
}

/** Fails with the reason the request was aborted with, and never otherwise. */
export const hang: Handler = (request) =>
	new Promise<Response>((_resolve, reject) => {
		const fail = (): void => {
			reject(request.signal.reason);
		};
		if (request.signal.aborted) {
			fail();
			return;
		}
		request.signal.addEventListener("abort", fail);
	});

export interface SseOptions {
	/** Close the body once the frames are out; otherwise it stays open. */
	readonly close?: boolean;
	/** Errors the body when the request is aborted, as fetch does. */
	readonly signal?: AbortSignal;
}

/** A `text/event-stream` response carrying `frames`, then closed by the server. */
export function sse(frames: readonly string[]): Response {
	return openSse(frames).response;
}

/** A `text/event-stream` response, and whether its reader has let go. */
export function openSse(
	frames: readonly string[],
	options: SseOptions = {},
): { response: Response; canceled: () => boolean } {
	let canceled = false;
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const frame of frames) {
				controller.enqueue(encoder.encode(frame));
			}
			if (options.close !== false) {
				controller.close();
				return;
			}
			options.signal?.addEventListener("abort", () => {
				controller.error(options.signal?.reason);
			});
		},
		cancel() {
			canceled = true;
		},
	});
	return {
		response: new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
		canceled: () => canceled,
	};
}

/** An event stream the test feeds one frame at a time. */
export interface LiveSse {
	readonly response: Response;
	readonly push: (frame: string) => void;
	readonly close: () => void;
}

export function liveSse(): LiveSse {
	const encoder = new TextEncoder();
	let sink: ReadableStreamDefaultController<Uint8Array> | undefined;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			sink = controller;
		},
	});
	return {
		response: new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
		push: (chunk) => sink?.enqueue(encoder.encode(chunk)),
		close: () => sink?.close(),
	};
}

/** One SSE frame in the shape the server sends. */
export const frame = (seq: number, payload: Record<string, unknown>): string =>
	`id: ${seq}\nevent: ${String(payload["type"])}\ndata: ${JSON.stringify({ seq, ...payload })}\n\n`;

export const userEvent = (seq: number): string =>
	frame(seq, { type: "message_user", source: "client", message: { role: "user", content: [] } });

export interface TestClientOptions {
	readonly fetch: typeof fetch;
	readonly apiKey?: TokenSource;
	readonly workspaceId?: string;
	readonly headers?: Record<string, string>;
	readonly timeout?: number;
	readonly maxRetries?: number;
}

export function testClient(options: TestClientOptions): SubakoClient {
	return new SubakoClient({ baseUrl: "https://api.test", apiKey: "sbk_ak_test", ...options });
}

export interface TestSessionClientOptions {
	readonly fetch: typeof fetch;
	readonly getToken?: (sessionId: string) => string | Promise<string>;
	readonly headers?: Record<string, string>;
	readonly timeout?: number;
	readonly maxRetries?: number;
}

export function testSessionClient(options: TestSessionClientOptions): SubakoSessionClient {
	return new SubakoSessionClient({
		baseUrl: "https://api.test",
		getToken: (sessionId) => `sbk_st_${sessionId}`,
		...options,
	});
}
