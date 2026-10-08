import { SubakoProvider } from "@subako-ai/react";
import { SubakoSessionClient } from "@subako-ai/sdk";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AgentProvider } from "./agent";
import { AppProvider } from "./app";
import { router } from "./router";
import "./app.css";

const baseUrl = import.meta.env.VITE_SUBAKO_BASE_URL ?? "http://localhost:8080";

// The page holds session tokens and nothing else; the demo server keeps the api key.
const subako = new SubakoSessionClient({
	baseUrl,
	getToken: async (sessionId) => await (await fetch(`/api/session/${sessionId}/token`)).text(),
});

const container = document.getElementById("root");
if (container === null) {
	throw new Error("the page has no #root to render into");
}
const root = createRoot(container);

/** The session belongs to the app rather than to a page, so it is created before anything renders. */
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
				<AppProvider>
					<AgentProvider sessionId={sessionId} router={router}>
						<RouterProvider router={router} />
					</AgentProvider>
				</AppProvider>
			</SubakoProvider>
		</StrictMode>,
	);
} catch (error) {
	root.render(
		<p className="boot-error">
			The example's server is not answering ({String(error)}). Start it with <code>pnpm example todo</code>.
		</p>,
	);
}
