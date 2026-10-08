import { useTool } from "@subako-ai/react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { useAgent } from "../agent";
import { isTab, type Tab, TABS, useApp } from "../app";
import { AddTodoModal } from "../components/add-todo-modal";
import { TodoRow } from "../components/todo-row";

/** The list and its three tabs, the add-todo modal, and the two tools that drive them. */
export function TodosPage(): ReactNode {
	const app = useApp();
	const { client } = useAgent();
	const search = useSearch({ from: "/" });
	const navigate = useNavigate();

	// The tab and the modal are this page's state, which is why their tools are declared here.
	const [tab, setTab] = useState<Tab>(search.tab ?? "active");
	const [adding, setAdding] = useState(false);

	// The url carries the tab too, so a `navigate` to /?tab=completed lands on it.
	useEffect(() => {
		if (search.tab !== undefined && search.tab !== tab) {
			setTab(search.tab);
		}
	}, [search.tab, tab]);

	const show = useCallback(
		(next: Tab) => {
			setTab(next);
			void navigate({ to: "/", search: { tab: next } });
		},
		[navigate],
	);

	// Both tools are built on every render and handed straight to `useTool`: the client swaps
	// the handler behind the name and tells the server nothing when the declaration is the same.
	useTool(client, "switch_tab", {
		description: "Show one tab of this todo list.",
		parameters: {
			type: "object",
			properties: { tab: { type: "string", enum: [...TABS], description: "Which todos to show." } },
			required: ["tab"],
			additionalProperties: false,
		},
		parse: (args) => {
			const wanted: unknown = args["tab"];
			if (!isTab(wanted)) {
				throw new TypeError("tab must be active, completed, or all");
			}
			return wanted;
		},
		execute: (wanted: Tab) => {
			show(wanted);
			return `Showing the ${wanted} todos.`;
		},
	});

	useTool(client, "open_add_todo", {
		description: "Open the add-todo modal. fill_todo_form comes into being with it, so call this first.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		execute: () => {
			// The modal declares fill_todo_form in an effect, so the open is committed before this answers.
			flushSync(() => setAdding(true));
			return "The add-todo modal is open.";
		},
	});

	const shown = tab === "all" ? app.todos : app.todos.filter((todo) => todo.completed === (tab === "completed"));

	return (
		<section>
			<div className="head">
				<h1>Todos</h1>
				<button type="button" className="primary" onClick={() => setAdding(true)}>
					Add todo
				</button>
			</div>

			<div className="tabs" role="tablist">
				{TABS.map((name) => (
					<button
						key={name}
						type="button"
						role="tab"
						aria-selected={name === tab}
						className={name === tab ? "tab current" : "tab"}
						onClick={() => show(name)}
					>
						{name}
					</button>
				))}
			</div>

			{app.error === null ? null : <p className="error">{app.error}</p>}

			<ul className="todos">
				{shown.map((todo) => (
					<TodoRow key={todo.id} todo={todo}>
						<Link to="/todos/$todoId" params={{ todoId: todo.id }} className="title">
							{todo.title}
						</Link>
					</TodoRow>
				))}
			</ul>
			{shown.length === 0 ? <p className="empty">Nothing here.</p> : null}

			{adding ? <AddTodoModal onClose={() => setAdding(false)} /> : null}
		</section>
	);
}
