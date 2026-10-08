import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { createTodo, deleteTodo, listTodos, type NewTodo, patchTodo, type Todo, type TodoPatch } from "./api";

/** Which slice of the list the todos page shows. */
export type Tab = "active" | "completed" | "all";

export const TABS: readonly Tab[] = ["active", "completed", "all"];

export const isTab = (value: unknown): value is Tab => TABS.includes(value as Tab);

export type Theme = "light" | "dark" | "system";

export interface Settings {
	readonly display_name: string;
	readonly theme: Theme;
}

/** The data the whole app reads; what a single page owns stays on that page. */
export interface App {
	readonly todos: readonly Todo[];
	readonly error: string | null;
	readonly addTodo: (todo: NewTodo) => Promise<void>;
	readonly editTodo: (id: string, patch: TodoPatch) => Promise<void>;
	readonly removeTodo: (id: string) => Promise<void>;
	readonly settings: Settings;
	readonly updateSettings: (values: Partial<Settings>) => void;
}

const Context = createContext<App | undefined>(undefined);

/** The todos and the settings, held at the root and fetched from the demo server. */
export function AppProvider({ children }: { readonly children: ReactNode }): ReactNode {
	const [todos, setTodos] = useState<readonly Todo[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [settings, setSettings] = useState<Settings>({ display_name: "", theme: "system" });

	useEffect(() => {
		listTodos().then(setTodos, (cause: unknown) => setError(String(cause)));
	}, []);

	const addTodo = useCallback(async (todo: NewTodo) => {
		const created = await createTodo(todo);
		setTodos((current) => [...current, created]);
	}, []);

	const editTodo = useCallback(async (id: string, patch: TodoPatch) => {
		const updated = await patchTodo(id, patch);
		setTodos((current) => current.map((todo) => (todo.id === id ? updated : todo)));
	}, []);

	const removeTodo = useCallback(async (id: string) => {
		await deleteTodo(id);
		setTodos((current) => current.filter((todo) => todo.id !== id));
	}, []);

	const updateSettings = useCallback((values: Partial<Settings>) => {
		setSettings((current) => ({ ...current, ...values }));
	}, []);

	// The theme is the one setting with something to show for itself.
	useEffect(() => {
		document.documentElement.dataset["theme"] = settings.theme;
	}, [settings.theme]);

	const value = useMemo<App>(
		() => ({ todos, error, addTodo, editTodo, removeTodo, settings, updateSettings }),
		[todos, error, addTodo, editTodo, removeTodo, settings, updateSettings],
	);
	return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useApp(): App {
	const app = useContext(Context);
	if (app === undefined) {
		throw new Error("useApp needs an <AppProvider> above it");
	}
	return app;
}
