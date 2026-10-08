import { Link, useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useApp } from "../app";
import { TodoRow } from "../components/todo-row";

/** One todo, with the notes the list has no room for. */
export function TodoPage(): ReactNode {
	const { todoId } = useParams({ from: "/todos/$todoId" });
	const app = useApp();
	const todo = app.todos.find((candidate) => candidate.id === todoId);

	if (todo === undefined) {
		return (
			<section>
				<p className="empty">No todo {todoId}.</p>
				<Link to="/">Back to the list</Link>
			</section>
		);
	}

	return (
		<section>
			<div className="head">
				<h1>{todo.title}</h1>
				<Link to="/">Back</Link>
			</div>
			<ul className="todos">
				<TodoRow todo={todo}>
					<span className="title">{todo.completed ? "completed" : "still to do"}</span>
				</TodoRow>
			</ul>
			<p className="notes">{todo.notes === "" ? "No notes." : todo.notes}</p>
			<p className="hint">Added {new Date(todo.created_at).toLocaleString()}</p>
		</section>
	);
}
