import { useSession, useTool, useToolClient } from "@subako-ai/react";
import type { SessionConnection, ToolClient } from "@subako-ai/sdk";
import { fromTanStackRouter } from "@subako-ai/tanstack-router";
import { navigateTool } from "@subako-ai/tools";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useApp } from "./app";
import type { DemoRouter } from "./router";

/** The one session and the one tool client; each page declares its own tools on the client. */
export interface Agent {
	readonly sessionId: string;
	/** Null until the hook's effect has connected, which is the first render only. */
	readonly session: SessionConnection | null;
	/** The client is named `app`, so the model sees `client__app__<tool>`; null until the session is open. */
	readonly client: ToolClient | null;
}

const Context = createContext<Agent | undefined>(undefined);

export interface AgentProviderProps {
	readonly sessionId: string;
	readonly router: DemoRouter;
	readonly children: ReactNode;
}

const STATUSES = ["active", "completed", "all"] as const;

type Status = (typeof STATUSES)[number];

const isStatus = (value: unknown): value is Status => STATUSES.includes(value as Status);

/** The one argument the two todo tools take, checked before either of them runs. */
function idOf(args: Record<string, unknown>): string {
	const id = args["id"];
	if (typeof id !== "string" || id === "") {
		throw new TypeError("id must be the id of a todo, as list_todos reports it");
	}
	return id;
}

/**
 * One `useSession`, one `useToolClient`, and the tools that belong to the whole app rather than
 * to a page: the router, and the todos themselves. A page's own tools are declared by the page.
 */
export function AgentProvider({ sessionId, router, children }: AgentProviderProps): ReactNode {
	const session = useSession(sessionId);
	const client = useToolClient(session, "app");
	const app = useApp();

	// The router is app-wide, and it enumerates its own routes, so the model can only name a
	// page this app has. Every form tool is declared by the page that owns what it writes to.
	useTool(client, "navigate", navigateTool(fromTanStackRouter(router)));

	// The todos are the app's, not a page's, so these three are offered wherever the person is.
	// They are also the only way the model sees the list: the page's state is not in the
	// conversation, and the demo's MCP server is not reachable from the broker.
	useTool(client, "list_todos", {
		description:
			"Read this app's todo list. It is the only way to see the todos, so call it before answering " +
			"anything about them, and to learn the id that set_todo_done and delete_todo take.",
		parameters: {
			type: "object",
			properties: {
				status: { type: "string", enum: [...STATUSES], description: "Which todos to read." },
			},
			required: ["status"],
			additionalProperties: false,
		},
		parse: (args) => {
			const wanted: unknown = args["status"];
			return isStatus(wanted) ? wanted : "all";
		},
		execute: (status: Status) => {
			const shown =
				status === "all" ? app.todos : app.todos.filter((todo) => todo.completed === (status === "completed"));
			return JSON.stringify(shown);
		},
	});

	useTool(client, "set_todo_done", {
		description: "Mark one todo done, or put it back on the list. list_todos reports the id.",
		parameters: {
			type: "object",
			properties: {
				id: { type: "string", description: "The todo's id, as list_todos reports it." },
				done: { type: "boolean", description: "True to complete it, false to reopen it." },
			},
			required: ["id", "done"],
			additionalProperties: false,
		},
		parse: (args) => ({ id: idOf(args), done: args["done"] === true }),
		execute: async ({ id, done }: { id: string; done: boolean }) => {
			const todo = app.todos.find((candidate) => candidate.id === id);
			if (todo === undefined) {
				return { text: `no todo ${id}; call list_todos for the ids`, is_error: true };
			}
			await app.editTodo(id, { completed: done });
			return `${todo.title} is now ${done ? "done" : "back on the list"}.`;
		},
	});

	useTool(client, "delete_todo", {
		description: "Delete one todo for good. list_todos reports the id; there is no undo.",
		parameters: {
			type: "object",
			properties: { id: { type: "string", description: "The todo's id, as list_todos reports it." } },
			required: ["id"],
			additionalProperties: false,
		},
		parse: (args) => idOf(args),
		execute: async (id: string) => {
			const todo = app.todos.find((candidate) => candidate.id === id);
			if (todo === undefined) {
				return { text: `no todo ${id}; call list_todos for the ids`, is_error: true };
			}
			await app.removeTodo(id);
			return `Deleted ${todo.title}.`;
		},
	});

	const value = useMemo<Agent>(() => ({ sessionId, session, client }), [sessionId, session, client]);
	return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The session and the client, for a page about to declare a tool on it. */
export function useAgent(): Agent {
	const agent = useContext(Context);
	if (agent === undefined) {
		throw new Error("useAgent needs an <AgentProvider> above it");
	}
	return agent;
}
