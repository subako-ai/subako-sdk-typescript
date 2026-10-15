import type { Core, RequestOptions } from "../core.js";
import { BY_ID } from "../core.js";
import * as api from "../generated/index.js";
import type { IdPaged } from "../pagination.js";
import { type ConnectOptions, SessionConnection } from "../session.js";
import type { VolumePath } from "../volume.js";

export type ListSessionsParams = IdPaged<NonNullable<api.ListSessionsData["query"]>>;
export type ListVolumeFilesParams = NonNullable<api.ListVolumeFilesData["query"]>;

/** The bytes of a volume file; text goes up as UTF-8. */
export type VolumeFileContent = Blob | ArrayBuffer | Uint8Array | string;

/** The route's path parameters: the area, and the path in it, which the client encodes whole. */
const volumeRoute = (sessionId: string, { area, path }: VolumePath) => ({ session_id: sessionId, area, path });

const volumeBytes = (content: VolumeFileContent): Blob | Uint8Array =>
	content instanceof Blob || content instanceof Uint8Array ? content : new Blob([content]);

export type ListSessionEventsParams = NonNullable<api.ListSessionEventsData["query"]>;

/** The routes a session token reaches, which `SubakoClient.sessions` and `SubakoSessionClient` both bind. */
export class SessionApi {
	constructor(protected readonly core: Core) {}

	/** Reads one session. */
	get(sessionId: string, options?: RequestOptions) {
		return this.core.call(api.getSession, { path: { session_id: sessionId } }, options);
	}

	/**
	 * Renames a session. The name becomes the caller's, so an agent granted
	 * `until_user_edits` stops renaming it; an empty name hands it back to the agent.
	 */
	rename(sessionId: string, params: api.RenameSessionBody, options?: RequestOptions) {
		return this.core.call(api.renameSession, { path: { session_id: sessionId }, body: params }, options);
	}

	/**
	 * Reads the event log a page at a time, keyed by seq: newest first, or oldest
	 * first under `order: "asc"`. The cursor follows the direction of travel, so a
	 * descending walk continues under `before_seq` and an ascending one under
	 * `after_seq`; `Page` carries whichever this listing asked for.
	 */
	listEvents(sessionId: string, params?: ListSessionEventsParams, options?: RequestOptions) {
		return this.core.page(
			api.listSessionEvents,
			{ path: { session_id: sessionId }, query: params },
			{ next: params?.order === "asc" ? "after_seq" : "before_seq" },
			options,
		);
	}

	/** Posts input, which queues a run or steers the active one. */
	postEvent(sessionId: string, params: api.PostSessionEventBody, options?: RequestOptions) {
		return this.core.call(api.postSessionEvent, { path: { session_id: sessionId }, body: params }, options);
	}

	/** Cancels the active run, which stops at its next checkpoint. */
	cancelRun(sessionId: string, options?: RequestOptions) {
		return this.core.call(api.cancelSessionRun, { path: { session_id: sessionId } }, options);
	}

	/** Decides a pending approval; the broker holding the call reads it on its next tick. */
	resolveApproval(sessionId: string, callId: string, params: api.ApprovalDecisionForm, options?: RequestOptions) {
		return this.core.call(
			api.resolveApproval,
			{ path: { session_id: sessionId, call_id: callId }, body: params },
			options,
		);
	}

	/**
	 * Lists the sandboxes the session's agent grants, in name order. A grant list is
	 * bounded, so the whole set travels at once: this answers with `items` and offers
	 * no cursor, where the paged listings answer with a `Page`.
	 */
	listSandboxes(sessionId: string, options?: RequestOptions) {
		return this.core.call(api.listSessionSandboxes, { path: { session_id: sessionId } }, options);
	}

	/** Reads a retired sandbox's archive: where to fetch it, how large it is, and when that URL lapses. */
	getSandboxArchive(sessionId: string, name: string, options?: RequestOptions) {
		return this.core.call(api.sessionSandboxArchive, { path: { session_id: sessionId, name } }, options);
	}

	/** Deletes a retired sandbox's archive, which stops the storage it is billed for. */
	deleteSandboxArchive(sessionId: string, name: string, options?: RequestOptions) {
		return this.core.call(api.deleteSessionSandboxArchive, { path: { session_id: sessionId, name } }, options);
	}

	/** Downloads an image the session's events name: an `image` content block's `sha256`. Its bytes never change, so a caller may keep them. */
	readImage(sessionId: string, sha256: string, options?: RequestOptions) {
		return this.core.download(api.getSessionImage, { path: { session_id: sessionId, sha256 } }, options);
	}

	/**
	 * Lists one page of the files in one area of the session tree's volume, beneath `prefix`,
	 * the area itself when omitted: every entry beneath it, or with `depth: "children"` only
	 * those directly in it. Each entry's `path` is its path in the area. Pass a page's
	 * `next_cursor` back as `after` for the page that follows.
	 */
	listVolumeFiles(
		sessionId: string,
		area: api.VolumeAreaParam,
		params?: ListVolumeFilesParams,
		options?: RequestOptions,
	) {
		return this.core.call(api.listVolumeFiles, { path: { session_id: sessionId, area }, query: params }, options);
	}

	/** Downloads a volume file, such as `{ area: "tmp", path: "notes/a.txt" }`. */
	readVolumeFile(sessionId: string, file: VolumePath, options?: RequestOptions) {
		return this.core.download(api.getVolumeFile, { path: volumeRoute(sessionId, file) }, options);
	}

	/** Creates or replaces a volume file, and its parent directories. */
	writeVolumeFile(sessionId: string, file: VolumePath, content: VolumeFileContent, options?: RequestOptions) {
		return this.core.upload(api.putVolumeFile, { path: volumeRoute(sessionId, file) }, volumeBytes(content), options);
	}

	/** Removes a volume file, or a directory and everything beneath it. */
	deleteVolumeFile(sessionId: string, file: VolumePath, options?: RequestOptions) {
		return this.core.call(api.deleteVolumeFile, { path: volumeRoute(sessionId, file) }, options);
	}

	/** Removes every file in the session tree's volume. */
	deleteVolume(sessionId: string, options?: RequestOptions) {
		return this.core.call(api.deleteVolume, { path: { session_id: sessionId } }, options);
	}

	/** Registers a tool-serving client and the tools it serves for the rest of the session. */
	registerClient(sessionId: string, params: api.RegisterClientBody, options?: RequestOptions) {
		return this.core.call(api.registerClient, { path: { session_id: sessionId }, body: params }, options);
	}

	/** Leaves the session, freeing the name and failing the calls still owed an answer. */
	leaveClient(sessionId: string, clientId: string, options?: RequestOptions) {
		return this.core.call(api.leaveClient, { path: { session_id: sessionId, client_id: clientId } }, options);
	}

	/** Acknowledges a call, which buys the longer answer deadline. */
	ackCall(sessionId: string, clientId: string, callId: string, options?: RequestOptions) {
		return this.core.call(
			api.ackClientCall,
			{ path: { session_id: sessionId, client_id: clientId, call_id: callId } },
			options,
		);
	}

	/** Answers a call; the result reaches the log as the call's tool result. */
	answerCall(
		sessionId: string,
		clientId: string,
		callId: string,
		params: api.ClientCallResultBody,
		options?: RequestOptions,
	) {
		return this.core.call(
			api.answerClientCall,
			{ path: { session_id: sessionId, client_id: clientId, call_id: callId }, body: params },
			options,
		);
	}

	/** Keeps a client live and reports when it would otherwise lapse. */
	pingClient(sessionId: string, clientId: string, options?: RequestOptions) {
		return this.core.call(api.pingClient, { path: { session_id: sessionId, client_id: clientId } }, options);
	}

	/** Replaces the tools a client serves; a dropped tool is refused at once. */
	updateClientTools(sessionId: string, clientId: string, params: api.UpdateClientToolsBody, options?: RequestOptions) {
		return this.core.call(
			api.updateClientTools,
			{ path: { session_id: sessionId, client_id: clientId }, body: params },
			options,
		);
	}

	/** Opens a live connection to the log: the events, the status, and the clients attached to it. */
	connect(sessionId: string, options?: ConnectOptions): SessionConnection {
		return new SessionConnection(this.core, this, sessionId, options);
	}
}

/** The session routes, and the workspace-scoped ones only a workspace credential reaches. */
export class Sessions extends SessionApi {
	/** Lists the workspace's sessions, newest first; `order: "asc"` walks the other way. */
	list(params?: ListSessionsParams, options?: RequestOptions) {
		return this.core.page(api.listSessions, { query: params }, BY_ID, options);
	}

	/**
	 * Creates a session on an agent's live version; the session token is returned
	 * once. A replayed attempt answers with the receipt alone, which carries no
	 * token: narrow on `session_token` before reading it, and mint a replacement
	 * with `mintToken` when it is not there.
	 */
	create(params: api.CreateSessionBody, options?: RequestOptions) {
		return this.core.call(api.createSession, { body: params }, options);
	}

	/** Deletes a session and everything on its log. */
	delete(sessionId: string, options?: RequestOptions) {
		return this.core.call(api.deleteSession, { path: { session_id: sessionId } }, options);
	}

	/** Mints a session token; tokens already issued stay live. A replay answers with the receipt alone. */
	mintToken(sessionId: string, options?: RequestOptions) {
		return this.core.call(api.mintSessionToken, { path: { session_id: sessionId } }, options);
	}
}
