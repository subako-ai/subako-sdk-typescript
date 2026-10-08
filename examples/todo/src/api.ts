/** One todo, exactly as the demo server keeps it. */
export interface Todo {
	readonly id: string;
	readonly title: string;
	readonly notes: string;
	readonly due: string | null;
	readonly completed: boolean;
	readonly created_at: string;
}

/** What the add-todo form sends. */
export interface NewTodo {
	readonly title: string;
	readonly notes?: string;
	readonly due?: string | null;
}

/** What the detail page and the checkbox change. */
export type TodoPatch = Partial<Omit<Todo, "id" | "created_at">>;

async function send<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, init);
	if (!response.ok) {
		throw new Error(`${init?.method ?? "GET"} ${path} answered ${response.status}`);
	}
	return (await response.json()) as T;
}

const asJson = (body: unknown): RequestInit => ({
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body),
});

export async function listTodos(): Promise<Todo[]> {
	const page = await send<{ items: Todo[] }>("/api/todos");
	return page.items;
}

export const createTodo = (todo: NewTodo): Promise<Todo> =>
	send<Todo>("/api/todos", { method: "POST", ...asJson(todo) });

export const patchTodo = (id: string, patch: TodoPatch): Promise<Todo> =>
	send<Todo>(`/api/todos/${id}`, { method: "PATCH", ...asJson(patch) });

export const deleteTodo = (id: string): Promise<Todo> => send<Todo>(`/api/todos/${id}`, { method: "DELETE" });
