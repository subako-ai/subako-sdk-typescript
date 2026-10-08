import type { ReactNode } from "react";
import type { Todo } from "../api";
import { useApp } from "../app";

export interface TodoRowProps {
	readonly todo: Todo;
	/** What the title reads as: a link on the list, plain text on the detail page. */
	readonly children: ReactNode;
}

/** One line of the list: the checkbox, the title, and when it is due. */
export function TodoRow({ todo, children }: TodoRowProps): ReactNode {
	const app = useApp();
	return (
		<li className={todo.completed ? "todo done" : "todo"}>
			<input
				type="checkbox"
				checked={todo.completed}
				aria-label={`completed: ${todo.title}`}
				onChange={(event) => void app.editTodo(todo.id, { completed: event.target.checked })}
			/>
			{children}
			{todo.due === null ? null : <span className="due">{todo.due}</span>}
			<button
				type="button"
				className="delete"
				aria-label={`delete: ${todo.title}`}
				onClick={() => void app.removeTodo(todo.id)}
			>
				Delete
			</button>
		</li>
	);
}
