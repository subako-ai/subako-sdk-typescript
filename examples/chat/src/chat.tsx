import { SubakoChat } from "@subako-ai/assistant-ui";
import { useSession } from "@subako-ai/react";
import type { ReactNode } from "react";

/** The whole page: a title, and the chat over the session the page opened. */
export function Chat({ sessionId }: { readonly sessionId: string }): ReactNode {
	// `useSession` opens the connection and hands back null until it has; the chat renders either.
	const session = useSession(sessionId);
	return (
		<main className="page">
			<h1 className="title">Subako Chat</h1>
			<SubakoChat session={session} className="thread" />
		</main>
	);
}
