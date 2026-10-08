type PageLoader<T, C extends string | number> = (cursor: C) => Promise<Page<T, C>>;

/** Where a page of an id-keyed listing starts: past one cursor or just before one, never both. */
export type IdCursor = { after?: string; before?: never } | { before?: string; after?: never };

/** An id-keyed listing's query, its two cursors exclusive. */
export type IdPaged<Query> = Omit<Query, "after" | "before"> & IdCursor;

/** The way back from a page: the cursor for the page before it, and how to read that page. */
export interface PreviousPage<T, C extends string | number> {
	readonly cursor: C | null;
	readonly load: PageLoader<T, C>;
}

/** One page of a collection, and a way to walk the rest of it. */
export class Page<T, C extends string | number = string> implements AsyncIterable<T> {
	readonly items: readonly T[];
	readonly nextCursor: C | null;
	/** `null` on the first page, and on a listing that pages forward only. */
	readonly previousCursor: C | null;
	readonly #load: PageLoader<T, C>;
	readonly #loadPrevious: PageLoader<T, C> | undefined;

	constructor(items: readonly T[], nextCursor: C | null, load: PageLoader<T, C>, previous?: PreviousPage<T, C>) {
		this.items = items;
		this.nextCursor = nextCursor;
		this.previousCursor = previous?.cursor ?? null;
		this.#load = load;
		this.#loadPrevious = previous?.load;
	}

	async nextPage(): Promise<Page<T, C> | null> {
		return this.nextCursor === null ? null : this.#load(this.nextCursor);
	}

	/** The page before this one, its items in the same order; `null` on the first page. */
	async previousPage(): Promise<Page<T, C> | null> {
		return this.previousCursor === null || this.#loadPrevious === undefined
			? null
			: this.#loadPrevious(this.previousCursor);
	}

	/** Every item from this page onward, following the cursor to the end. */
	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		yield* this.items;
		let page = await this.nextPage();
		while (page !== null) {
			yield* page.items;
			page = await page.nextPage();
		}
	}
}
