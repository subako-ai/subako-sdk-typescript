import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";

/**
 * The SDK's own surface is camelCase; the wire's snake_case stops at the generated
 * types and at the code that shapes a request or reads a response. oxlint has no
 * `naming-convention` rule to say so, and a text search cannot: `session_id` is
 * right in `{ path: { session_id } }` and wrong in an interface. The distinction is
 * exact in the AST, though — a declared member is a TSPropertySignature or a
 * TSMethodSignature, and a literal's field is a Property — so this reads it there
 * rather than guessing.
 *
 * Only exported declarations are held to it. An internal type that matches the wire
 * structurally has to spell the wire's names to match anything at all: `PageCursor`
 * in `core.ts` reads `next_cursor` off a response body, and renaming it would leave
 * it matching nothing.
 */
const packages = fileURLToPath(new URL("../../", import.meta.url));

/** Every hand-written source file: the generated clients are the wire's, and keep its names. */
function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = `${dir}/${entry.name}`;
		if (entry.isDirectory()) {
			return entry.name === "generated" || entry.name === "node_modules" ? [] : sources(path);
		}
		return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [path] : [];
	});
}

const files = readdirSync(packages, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.flatMap((entry) => sources(`${packages}${entry.name}/src`));

/** A node of oxc's ESTree-shaped AST: every node is an object with a `type`. */
type AstNode = { type: string; [field: string]: unknown };

const isNode = (value: unknown): value is AstNode =>
	typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";

const children = (node: AstNode): AstNode[] =>
	Object.values(node).flatMap((value) => (Array.isArray(value) ? value.filter(isNode) : isNode(value) ? [value] : []));

/** The members one exported declaration declares whose names carry an underscore. */
function snakeCased(path: string): string[] {
	const text = readFileSync(path, "utf8");
	const { program } = parseSync(path, text);
	const found: string[] = [];
	const visit = (node: AstNode): void => {
		// A body is implementation, not surface: the cast that reads `next_cursor` off a
		// response lives in one, and has to spell the wire's name.
		if (node.type === "BlockStatement") {
			return;
		}
		if (node.type === "TSPropertySignature" || node.type === "TSMethodSignature") {
			const key = node.key as AstNode & { start: number; end: number };
			const name =
				key.type === "Identifier"
					? String(key.name)
					: key.type === "Literal"
						? String(key.value)
						: text.slice(key.start, key.end);
			if (name.includes("_")) {
				found.push(name);
			}
		}
		children(node).forEach(visit);
	};
	for (const statement of program.body) {
		if (
			(statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration") &&
			statement.declaration
		) {
			visit(statement.declaration as unknown as AstNode);
		}
	}
	return found;
}

describe("the exported types", () => {
	it("cover every package", () => {
		expect(files.length).toBeGreaterThan(20);
	});

	for (const path of files) {
		const name = path.slice(packages.length);
		it(`${name}: declares no snake_case member`, () => {
			expect(snakeCased(path)).toEqual([]);
		});
	}
});
