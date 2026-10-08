#!/usr/bin/env node
// Writes the set of operations that declare the Idempotency-Key header, read from the spec.
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SPEC = new URL("../openapi/public.json", import.meta.url);
const OUTPUT = new URL("../packages/sdk/src/generated/idempotency.ts", import.meta.url);
const HEADER = "Idempotency-Key";
const METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

/** The name `@hey-api/openapi-ts` gives an operationId in `sdk.gen.ts`. */
const camel = (id) => id.replace(/_(.)/g, (_match, letter) => letter.toUpperCase());

const document = JSON.parse(await readFile(fileURLToPath(SPEC), "utf8"));

const names = Object.values(document.paths ?? {})
	.flatMap((item) => Object.entries(item).filter(([method]) => METHODS.has(method)))
	.filter(([, operation]) =>
		(operation.parameters ?? []).some((parameter) => parameter.in === "header" && parameter.name === HEADER),
	)
	.map(([, operation]) => camel(operation.operationId))
	.sort((a, b) => a.localeCompare(b));

// The same list twice: the functions are imported by name, and the set holds them by reference.
const lines = names.map((name) => `\t${name},`).join("\n");
const file = `// This file is generated from openapi/public.json by scripts/gen-idempotency.mjs
import {
${lines}
} from "./sdk.gen.js";

/** The generated operations that declare the \`${HEADER}\` header, as the functions themselves. */
export const IDEMPOTENT_OPERATIONS: ReadonlySet<unknown> = new Set([
${lines}
]);
`;

writeFileSync(fileURLToPath(OUTPUT), file);
console.log(`wrote ${names.length} idempotent operations to src/generated/idempotency.ts`);
