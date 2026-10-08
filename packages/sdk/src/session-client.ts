import { type ClientOptions, Core } from "./core.js";
import { SessionApi } from "./resources/sessions.js";

export interface SubakoSessionClientOptions extends ClientOptions {
	/** Answers with one session's token; asked at first need and again after a `401`, and cached in between. */
	readonly getToken: (sessionId: string) => string | Promise<string>;
}

/** The session-scoped API, one token per session: a session token implies its workspace and creates no sessions. */
export class SubakoSessionClient extends SessionApi {
	constructor(options: SubakoSessionClientOptions) {
		if (typeof options.getToken !== "function") {
			throw new TypeError("SubakoSessionClient takes a getToken that answers with one session's token");
		}
		super(new Core({ ...options, credential: { kind: "session", token: options.getToken } }));
	}
}
