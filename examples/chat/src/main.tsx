import { SubakoProvider } from "@subako-ai/react";
import { SubakoSessionClient } from "@subako-ai/sdk";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Chat } from "./chat";
import "./chat.css";

const baseUrl = import.meta.env.VITE_SUBAKO_BASE_URL ?? "http://localhost:8080";

// The page holds session tokens and nothing else; the example's server keeps the api key.
const subako = new SubakoSessionClient({
	baseUrl,
	getToken: async (sessionId) => await (await fetch(`/api/session/${sessionId}/token`)).text(),
});

const container = document.getElementById("root");
if (container === null) {
	throw new Error("the page has no #root to render into");
}
const root = createRoot(container);

/** One session per page load, created before anything renders. */
async function start(): Promise<string> {
	const response = await fetch("/api/session", { method: "POST" });
	if (!response.ok) {
		throw new Error(`POST /api/session answered ${response.status}`);
	}
	const created = (await response.json()) as { sessionId: string };
	return created.sessionId;
}

try {
	const sessionId = await start();
	// StrictMode's dev-only remount closes the connection and opens another; the hooks are built for it.
	root.render(
		<StrictMode>
			<SubakoProvider client={subako}>
				<Chat sessionId={sessionId} />
			</SubakoProvider>
		</StrictMode>,
	);
} catch (error) {
	root.render(
		<p className="boot-error">
			The example's server is not answering ({String(error)}). Start it with <code>pnpm example chat</code>.
		</p>,
	);
}
