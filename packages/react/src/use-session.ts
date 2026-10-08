"use client";

import type { ConnectOptions, SessionConnection, SubakoSessionClient } from "@subako-ai/sdk";
import { useEffect, useState } from "react";
import { useSubako } from "./provider.js";

/** The SDK's connect options, minus the two this hook decides: the history is always read, and unmounting is the close. */
export interface UseSessionOptions extends Omit<ConnectOptions, "history" | "signal"> {
	/**
	 * Read only the newest part of the log first: at least this many events,
	 * back to the start of the latest run. `loadEarlier` on the connection reads
	 * further back. Omitted, the whole log is read.
	 */
	readonly latest?: number;
}

/** A connection and what it was opened for, so a session the hook has yet to open is never read as the last one. */
interface Opened {
	readonly connection: SessionConnection;
	readonly client: SubakoSessionClient;
	readonly sessionId: string;
}

/**
 * Opens the SDK's connection for the component's lifetime, history first. It
 * acquires, and nothing more: the one re-render it causes is `null` becoming
 * the connection, once its effect has opened one. A component that renders what
 * the session carries subscribes with `useSessionState`, where it renders.
 *
 * A `null` id opens nothing, so a component that learns which session to follow
 * only later (once a lookup says it may) calls the hook unconditionally all the
 * same.
 */
export function useSession(sessionId: string | null, options: UseSessionOptions = {}): SessionConnection | null {
	const { client } = useSubako();
	const [opened, setOpened] = useState<Opened | null>(null);

	useEffect(() => {
		if (sessionId === null) {
			return;
		}
		const { latest, ...rest } = options;
		const live = client.connect(sessionId, { ...rest, history: latest === undefined ? true : { latest } });
		setOpened({ connection: live, client, sessionId });
		return () => {
			live.close();
			setOpened(null);
		};
	}, [client, sessionId]);

	// The renders after a change read `null`, never the connection the session before it opened.
	return opened !== null && opened.sessionId === sessionId && opened.client === client ? opened.connection : null;
}
