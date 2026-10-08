"use client";

import type { SubakoSessionClient } from "@subako-ai/sdk";
import { createContext, type ReactNode, useContext, useMemo } from "react";

/** What the provider hands the hooks: the client the app built, and where background failures go. */
export interface SubakoContext {
	readonly client: SubakoSessionClient;
	readonly onError: (error: unknown) => void;
}

const Context = createContext<SubakoContext | undefined>(undefined);

/** The alternative is swallowing a ping or an answer that failed in the background. */
const report = (error: unknown): void => {
	console.error(error);
};

export interface SubakoProviderProps {
	/** The client the app built once, outside React; it is read on the first render only. */
	readonly client: SubakoSessionClient;
	/** Background failures of the tool clients: a ping, an ack, an answer, a delete. */
	readonly onError?: (error: unknown) => void;
	readonly children?: ReactNode;
}

/** Hands the session client down to the hooks, and nothing else: it keeps no registry of open sessions. */
export function SubakoProvider({ client, onError, children }: SubakoProviderProps): ReactNode {
	const value = useMemo<SubakoContext>(() => ({ client, onError: onError ?? report }), [client, onError]);
	return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The provider's client and error sink, which is what every hook here works through. */
export function useSubako(): SubakoContext {
	const context = useContext(Context);
	if (context === undefined) {
		throw new Error("the Subako hooks need a <SubakoProvider client={...}> above them");
	}
	return context;
}
