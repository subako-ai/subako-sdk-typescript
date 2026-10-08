/** Hands `value` to every listener; one that throws does not stop the rest. */
export function notify<T>(listeners: ReadonlySet<(value: T) => void>, value: T): void {
	for (const listener of listeners) {
		try {
			listener(value);
		} catch (error) {
			// A listener's failure is its own: it is reported, and the rest still hear the value.
			console.error(error);
		}
	}
}

/** One immutable snapshot and the listeners watching it. */
export class Store<T extends object> {
	readonly #listeners = new Set<(state: T) => void>();
	#state: T;

	constructor(initial: T) {
		this.#state = initial;
	}

	get state(): T {
		return this.#state;
	}

	/** Calls `listener` after every change; returns an unsubscribe. */
	subscribe(listener: (state: T) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Replaces the snapshot with the fields given, then notifies. */
	update(next: Partial<T>): void {
		this.#state = { ...this.#state, ...next };
		notify(this.#listeners, this.#state);
	}
}
