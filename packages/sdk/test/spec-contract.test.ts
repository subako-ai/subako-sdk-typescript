import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IDEMPOTENT_OPERATIONS } from "../src/generated/idempotency.js";
import * as api from "../src/generated/index.js";
import * as publicApi from "../src/index.js";
import { VERSION } from "../src/index.js";

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const document = JSON.parse(read("../../../openapi/public.json")) as {
	paths: Record<string, Record<string, Operation>>;
};

interface Operation {
	readonly operationId?: string;
	readonly parameters?: ReadonlyArray<{ readonly name: string; readonly in: string }>;
}

const METHODS: ReadonlySet<string> = new Set(["get", "post", "put", "patch", "delete"]);

const operations = Object.values(document.paths).flatMap((item) =>
	Object.entries(item)
		.filter(([method]) => METHODS.has(method))
		.map(([, operation]) => operation),
);

const operationIds = operations.map((operation) => operation.operationId ?? "");

const resourcesDir = fileURLToPath(new URL("../src/resources/", import.meta.url));
const resources = readdirSync(resourcesDir)
	.map((file) => readFileSync(resourcesDir + file, "utf8"))
	.join("\n");
const connection = read("../src/session.ts");

const camel = (id: string): string => id.replace(/_(.)/g, (_match, letter: string) => letter.toUpperCase());
const pascal = (id: string): string => {
	const name = camel(id);
	return name.charAt(0).toUpperCase() + name.slice(1);
};

const references = (source: string, symbol: string): number =>
	source.match(new RegExp(`\\bapi\\.${symbol}(?![A-Za-z0-9_])`, "g"))?.length ?? 0;

/** The one operation answered by hand, and so referenced by its type rather than its function. */
const HAND_WRITTEN: ReadonlySet<string> = new Set(["stream_session_events"]);

describe("the resources cover the spec", () => {
	it("names every operation just once", () => {
		expect(operationIds).toHaveLength(98);
		expect(new Set(operationIds).size).toBe(operationIds.length);
	});

	for (const id of operationIds) {
		it(`${id}: one resource method calls it`, () => {
			if (HAND_WRITTEN.has(id)) {
				expect(references(resources, camel(id))).toBe(0);
				expect(references(connection, `${pascal(id)}Data`)).toBe(1);
				return;
			}
			expect(references(resources, camel(id))).toBe(1);
		});
	}
});

/** The generated function of that name, as the module exports it. */
const generated = (name: string): unknown => (api as unknown as Record<string, unknown>)[name];

describe("the idempotent operations", () => {
	// The generated set holds the operations whose `*Data` type carries `headers['Idempotency-Key']`.
	const declared = operations
		.filter((operation) => (operation.parameters ?? []).some((p) => p.in === "header" && p.name === "Idempotency-Key"))
		.map((operation) => camel(operation.operationId ?? ""));

	it("are the ones the spec gives the header to, and no others", () => {
		expect(declared).not.toHaveLength(0);
		expect(IDEMPOTENT_OPERATIONS.size).toBe(declared.length);
		expect(new Set(declared.map(generated))).toEqual(new Set(IDEMPOTENT_OPERATIONS));
	});

	for (const name of declared) {
		it(`${name}: the set holds the generated function itself`, () => {
			const fn = generated(name);
			expect(typeof fn).toBe("function");
			// By reference: a minified build renames the function and the set still finds it.
			expect(IDEMPOTENT_OPERATIONS.has(fn)).toBe(true);
		});
	}
});

describe("the package version", () => {
	it("matches the one the SDK reports", () => {
		const manifest = JSON.parse(read("../package.json")) as { version: string };
		expect(VERSION).toBe(manifest.version);
	});
});

describe("the generated enums", () => {
	// The generated module exports two kinds of value and no third: an enum is an
	// object, an operation is a function. So the enums can be counted without a list
	// to keep, and the hand-written re-export in `index.ts` can be held to all of them.
	const enums = Object.keys(api).filter((name) => typeof generated(name) === "object");

	it("are all re-exported by the public entry point", () => {
		expect(enums).not.toHaveLength(0);
		const missing = enums.filter((name) => !(name in publicApi));
		expect(missing).toEqual([]);
	});
});
