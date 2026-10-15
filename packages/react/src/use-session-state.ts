"use client";

import type { SessionState } from "@subako-ai/sdk";
import { useSyncExternalStore } from "react";

/**
 * What the hook subscribes to: the snapshot and the `subscribe` a
 * `SessionConnection` carries. It is spelled structurally, so a connection fits
 * and so does anything else that exposes the same store.
 */
export interface SessionStore {
	/** The connection as it stands; every change replaces the whole snapshot. */
	readonly state: SessionState;
	/** Calls `listener` with the state after every change; returns an unsubscribe. */
	readonly subscribe: (listener: (state: SessionState) => void) => () => void;
}

/** Nothing is connected yet, so the store the component reads is empty and never changes. */
const idle = (): (() => void) => () => undefined;

/**
 * The session as this render sees it — the status, the events, and the
 * `transcript`, `approvals` and `isRunning` joined onto them, and the `live`
 * messages a connection following `deltas` holds — and `null` while
 * there is no session. A component draws what this hands back, rather than
 * reading the connection: a session is a value, and React re-renders for props
 * and state, not for values, so the component that draws the session is the one
 * that has to subscribe, wherever the session reached it from.
 */
export function useSessionState(session: SessionStore | null): SessionState | null {
	const read = (): SessionState | null => session?.state ?? null;
	return useSyncExternalStore(session?.subscribe ?? idle, read, read);
}
