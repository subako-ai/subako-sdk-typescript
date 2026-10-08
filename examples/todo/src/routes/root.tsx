import { SubakoChat } from "@subako-ai/assistant-ui";
import { Link, Outlet } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { useAgent } from "../agent";
import { useApp } from "../app";

/** The nav bar, the routed page, and the assistant that floats over both. */
export function RootLayout(): ReactNode {
	const { session } = useAgent();
	const { settings } = useApp();
	const [open, setOpen] = useState(false);

	return (
		<div className={open ? "app with-panel" : "app"}>
			<header className="topbar">
				<span className="brand">Subako Todos</span>
				<nav className="links">
					<Link to="/" activeOptions={{ exact: true }} activeProps={{ className: "current" }}>
						Todos
					</Link>
					<Link to="/settings" activeProps={{ className: "current" }}>
						Settings
					</Link>
				</nav>
				<span className="who">{settings.display_name === "" ? "not signed in" : settings.display_name}</span>
			</header>

			<main className="main">
				<Outlet />
			</main>

			<button type="button" className="fab" aria-expanded={open} onClick={() => setOpen(!open)}>
				{open ? "Close" : "Ask"}
			</button>

			{open ? (
				<aside className="panel">
					<header className="panel-head">Assistant</header>
					{/* The app's own session, so the chat and the client tools share one connection. */}
					<SubakoChat session={session} />
				</aside>
			) : null}
		</div>
	);
}
