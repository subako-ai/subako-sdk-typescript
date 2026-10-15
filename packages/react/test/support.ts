import { LIVE_REDRAW_MS, SubakoSessionClient } from "@subako-ai/sdk";

export type Handler = (request: Request) => Response | Promise<Response>;

/** The client id every registration in these tests answers with. */
export const CLIENT_ID = "cl1";

export const SESSION_ID = "s1";

export interface FetchStub {
	readonly fetch: typeof fetch;
	readonly calls: readonly Request[];
}

/** A fetch stub: it records every request and answers from one handler. */
export function stubFetch(handler: Handler): FetchStub {
	const calls: Request[] = [];
	const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const request = input instanceof Request ? input : new Request(input, init);
		calls.push(request.clone());
		return await handler(request);
	};
	return { fetch: impl as unknown as typeof fetch, calls };
}

export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function empty(status: number): Response {
	return new Response(null, { status });
}

/** One SSE frame in the shape the server sends. */
export const frame = (seq: number, payload: Record<string, unknown>): string =>
	`id: ${seq}\nevent: ${String(payload["type"])}\ndata: ${JSON.stringify({ seq, ...payload })}\n\n`;

/** One dispatch, as the server puts it on the log. */
export const dispatched = (callId: string, tool: string, args: Record<string, unknown> = {}) => ({
	type: "client_tool_dispatched",
	client_id: CLIENT_ID,
	call_id: callId,
	tool,
	arguments: args,
});

export interface Backend {
	readonly http: FetchStub;
	readonly client: SubakoSessionClient;
	/** Sends one event down every stream this backend has opened. */
	readonly push: (seq: number, payload: Record<string, unknown>) => void;
	/** The requests that went to a path ending in `suffix`. */
	readonly sent: (method: string, suffix: string) => readonly Request[];
	/** How many event streams were opened, which is how many connections there are. */
	readonly streams: () => number;
	/** Sends a delta frame on every open stream. */
	readonly pushDelta: (body: Record<string, unknown>) => void;
}

/** Every session route a connection, a tool client and the hooks touch, in one handler. */
export function backend(overrides: Readonly<Record<string, Handler>> = {}): Backend {
	const encoder = new TextEncoder();
	const sinks: ReadableStreamDefaultController<Uint8Array>[] = [];
	let streams = 0;

	const openStream = (): Response => {
		streams += 1;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				sinks.push(controller);
			},
		});
		return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
	};

	const handler: Handler = (request) => {
		const { pathname } = new URL(request.url);
		const override = Object.entries(overrides).find(([suffix]) => pathname.endsWith(suffix));
		if (override !== undefined) {
			return override[1](request);
		}
		if (pathname.endsWith("/events/stream")) {
			return openStream();
		}
		if (pathname.endsWith("/events")) {
			return request.method === "GET" ? json({ items: [], next_cursor: null }) : json({ run_id: "r1", queued: true });
		}
		if (pathname.endsWith("/cancel")) {
			return json({ run_id: "r1" });
		}
		if (pathname.includes("/approvals/")) {
			return json({ seq: 0, type: "approval_resolved", call_id: "c1", decision: "allow" });
		}
		if (pathname.endsWith("/ping")) {
			return json({ expires_at: null });
		}
		if (pathname.endsWith("/ack")) {
			return json({ seq: 0, type: "client_tool_acked", client_id: CLIENT_ID, call_id: "x" });
		}
		if (pathname.endsWith("/result")) {
			return empty(204);
		}
		if (pathname.endsWith("/tools")) {
			return json({ seq: 0, type: "client_tools_updated", client_id: CLIENT_ID, tools: [] });
		}
		if (request.method === "POST" && pathname.endsWith("/clients")) {
			return json({ id: CLIENT_ID, name: "web", expires_at: null }, 201);
		}
		if (request.method === "DELETE") {
			return empty(204);
		}
		throw new Error(`no route for ${request.method} ${pathname}`);
	};

	const http = stubFetch(handler);
	return {
		http,
		client: new SubakoSessionClient({
			baseUrl: "https://api.test",
			fetch: http.fetch,
			getToken: (sessionId) => `sbk_st_${sessionId}`,
		}),
		push: (seq, payload) => {
			const chunk = encoder.encode(frame(seq, payload));
			for (const sink of sinks) {
				sink.enqueue(chunk);
			}
		},
		pushDelta: (body) => {
			const chunk = encoder.encode(`event: delta\ndata: ${JSON.stringify(body)}\n\n`);
			for (const sink of sinks) {
				sink.enqueue(chunk);
			}
		},
		sent: (method, suffix) =>
			http.calls.filter((call) => call.method === method && new URL(call.url).pathname.endsWith(suffix)),
		streams: () => streams,
	};
}

/** Lets every pending microtask and answer settle; nothing here waits on a timer. */
/** Long enough for delta frames to have moved `live`. */
export const redrawn = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, LIVE_REDRAW_MS));

export const settle = async (turns = 6): Promise<void> => {
	for (let turn = 0; turn < turns; turn += 1) {
		await Promise.resolve();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
};
