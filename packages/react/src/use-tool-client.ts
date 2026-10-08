"use client";

import type { ClientLifetimeForm, SessionConnection, ToolClient } from "@subako-ai/sdk";
import { useEffect, useState } from "react";
import { useSubako } from "./provider.js";

export interface UseToolClientOptions {
	/** Defaults to a 60 second ttl, pinged at half of it. */
	readonly lifetime?: ClientLifetimeForm;
	/** Background failures of this client: a ping, an ack, an answer, a delete; the provider's by default. */
	readonly onError?: (error: unknown) => void;
}

/**
 * Creates one tool client on the session for the component's lifetime, and
 * deletes it on unmount. The client is created by an effect on a session that
 * exists, so it is `null` until `useSession` has one to give.
 */
export function useToolClient(
	session: SessionConnection | null,
	name: string,
	options: UseToolClientOptions = {},
): ToolClient | null {
	const subako = useSubako();
	const [client, setClient] = useState<ToolClient | null>(null);

	useEffect(() => {
		if (session === null) {
			return undefined;
		}
		const live = session.createToolClient(name, {
			lifetime: options.lifetime,
			onError: options.onError ?? subako.onError,
		});
		setClient(live);
		return () => {
			// A delete the server refuses leaves the client to its ttl; nothing here can retry it.
			void session.deleteToolClient(live).catch(() => undefined);
			setClient(null);
		};
	}, [session, name]);

	return client;
}
