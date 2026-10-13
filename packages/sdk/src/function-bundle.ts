/**
 * A function package as its manifest, its module, and the assets its module
 * reads at `/package`: packing them into the gzipped tar the push routes take. Core decodes every upload itself, so what it makes of the
 * module (valid WebAssembly, the imports it may name) is its to judge.
 */
import type { FunctionManifestBody } from "./generated/index.js";
import { ancestors, isBundlePath, packTar } from "./skill-bundle.js";

/**
 * The most a bundle may hold in bytes, measured twice: its files together,
 * and the packed archive Core receives.
 */
// CODESYNC(function-bundle-max-bytes)
export const FUNCTION_BUNDLE_MAX_BYTES = 64 * 1024 * 1024;

/** The most files a package's assets may hold. */
// CODESYNC(function-assets-max-files)
export const FUNCTION_ASSETS_MAX_FILES = 10_000;

/** The longest path an asset may have, in UTF-8 bytes, not counting `assets/`. */
// CODESYNC(function-asset-path-max-bytes)
export const FUNCTION_ASSET_PATH_MAX_BYTES = 1024;

/** The longest description a package or one of its functions may carry, in characters. */
// CODESYNC(function-description-len)
export const FUNCTION_DESCRIPTION_MAX_CHARS = 1024;

/** The most one input or output schema may hold as JSON, in bytes. */
// CODESYNC(function-schema-max-bytes)
export const FUNCTION_SCHEMA_MAX_BYTES = 64 * 1024;

/** The most `subako-package.json` may hold, in bytes. */
// CODESYNC(function-manifest-max-bytes)
export const FUNCTION_MANIFEST_MAX_BYTES = 256 * 1024;

/** The manifest file at a bundle's root. */
export const FUNCTION_MANIFEST_FILE = "subako-package.json";
/** The module file at a bundle's root. */
export const FUNCTION_MODULE_FILE = "module.wasm";
/** The directory at a bundle's root holding its assets. */
export const FUNCTION_ASSETS_DIR = "assets";

/**
 * What {@link packFunction} packs: the manifest to write, the compiled module,
 * and the files its module reads, read-only, under `/package`, keyed by their
 * path there (`data/words.txt` is `/package/data/words.txt`).
 */
export interface FunctionFiles {
	readonly manifest: FunctionManifestBody;
	readonly module: Uint8Array;
	readonly assets?: Readonly<Record<string, Uint8Array>>;
}

/** Why a manifest and module cannot be packed as a bundle. */
export type FunctionBundleProblem =
	| { readonly kind: "noFunctions" }
	| { readonly kind: "duplicateFunction"; readonly name: string }
	/** `function` is null for the package's own description. */
	| { readonly kind: "descriptionTooLong"; readonly function: string | null; readonly chars: number }
	| {
			readonly kind: "schemaTooLarge";
			readonly function: string;
			readonly schema: "input_schema" | "output_schema";
			readonly bytes: number;
	  }
	| { readonly kind: "manifestTooLarge"; readonly bytes: number }
	/** Empty, absolute, or carrying an empty, `.` or `..` segment. */
	| { readonly kind: "invalidAssetPath"; readonly path: string }
	| { readonly kind: "assetPathTooLong"; readonly path: string; readonly bytes: number }
	/** An asset whose path is another asset's directory. */
	| { readonly kind: "assetPathConflict"; readonly path: string }
	| { readonly kind: "tooManyAssets"; readonly count: number }
	| { readonly kind: "tooLarge"; readonly bytes: number }
	| { readonly kind: "packedTooLarge"; readonly bytes: number };

/** Files that break a bundle rule were handed to {@link packFunction}. */
export class FunctionBundleError extends Error {
	readonly problems: readonly FunctionBundleProblem[];

	constructor(problems: readonly FunctionBundleProblem[]) {
		super(`not a function bundle: ${problems.map(describeProblem).join("; ")}`);
		this.name = new.target.name;
		this.problems = problems;
	}
}

/**
 * Every bundle rule `files` breaks before packing; none for a packable set.
 * `manifestBytes` is the manifest's size as written into the bundle.
 */
export function checkFunctionFiles(files: FunctionFiles, manifestBytes: number): FunctionBundleProblem[] {
	const problems: FunctionBundleProblem[] = [];
	const { manifest } = files;
	if (manifest.functions.length === 0) {
		problems.push({ kind: "noFunctions" });
	}
	const packageChars = chars(manifest.description);
	if (packageChars > FUNCTION_DESCRIPTION_MAX_CHARS) {
		problems.push({ kind: "descriptionTooLong", function: null, chars: packageChars });
	}
	const names = new Set<string>();
	for (const fn of manifest.functions) {
		if (names.has(fn.name)) {
			problems.push({ kind: "duplicateFunction", name: fn.name });
		}
		names.add(fn.name);
		const fnChars = chars(fn.description);
		if (fnChars > FUNCTION_DESCRIPTION_MAX_CHARS) {
			problems.push({ kind: "descriptionTooLong", function: fn.name, chars: fnChars });
		}
		for (const schema of ["input_schema", "output_schema"] as const) {
			const bytes = jsonBytes(fn[schema]);
			if (bytes > FUNCTION_SCHEMA_MAX_BYTES) {
				problems.push({ kind: "schemaTooLarge", function: fn.name, schema, bytes });
			}
		}
	}
	if (manifestBytes > FUNCTION_MANIFEST_MAX_BYTES) {
		problems.push({ kind: "manifestTooLarge", bytes: manifestBytes });
	}
	const assets = Object.entries(files.assets ?? {});
	for (const [path] of assets) {
		const pathBytes = new TextEncoder().encode(path).byteLength;
		if (!isBundlePath(path)) {
			problems.push({ kind: "invalidAssetPath", path });
		} else if (pathBytes > FUNCTION_ASSET_PATH_MAX_BYTES) {
			problems.push({ kind: "assetPathTooLong", path, bytes: pathBytes });
		}
	}
	const paths = new Set(assets.map(([path]) => path));
	for (const path of new Set([...paths].flatMap(ancestors).filter((ancestor) => paths.has(ancestor)))) {
		problems.push({ kind: "assetPathConflict", path });
	}
	if (assets.length > FUNCTION_ASSETS_MAX_FILES) {
		problems.push({ kind: "tooManyAssets", count: assets.length });
	}
	const bytes = assets.reduce((sum, [, content]) => sum + content.byteLength, manifestBytes + files.module.byteLength);
	if (bytes > FUNCTION_BUNDLE_MAX_BYTES) {
		problems.push({ kind: "tooLarge", bytes });
	}
	return problems;
}

/**
 * Packs a manifest and a compiled module into an archive `functions.create`
 * and `functions.pushVersion` take. The same inputs always pack to the same
 * bytes.
 *
 * @throws {FunctionBundleError} when they break a bundle rule.
 */
export async function packFunction(files: FunctionFiles): Promise<Uint8Array<ArrayBuffer>> {
	const manifest = new TextEncoder().encode(JSON.stringify(files.manifest));
	const problems = checkFunctionFiles(files, manifest.byteLength);
	if (problems.length > 0) {
		throw new FunctionBundleError(problems);
	}
	const archive = await packTar([
		{ path: FUNCTION_MANIFEST_FILE, content: manifest },
		{ path: FUNCTION_MODULE_FILE, content: files.module },
		...Object.entries(files.assets ?? {}).map(([path, content]) => ({
			path: `${FUNCTION_ASSETS_DIR}/${path}`,
			content,
		})),
	]);
	if (archive.byteLength > FUNCTION_BUNDLE_MAX_BYTES) {
		throw new FunctionBundleError([{ kind: "packedTooLarge", bytes: archive.byteLength }]);
	}
	return archive;
}

/** Characters as Core counts them: code points, not UTF-16 units. */
function chars(text: string): number {
	return Array.from(text).length;
}

function jsonBytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function describeProblem(problem: FunctionBundleProblem): string {
	switch (problem.kind) {
		case "noFunctions":
			return "the manifest lists no functions";
		case "duplicateFunction":
			return `the function ${problem.name} appears more than once`;
		case "descriptionTooLong":
			return `${problem.function === null ? "the package's description" : `the function ${problem.function}'s description`} holds ${problem.chars} characters, over the ${FUNCTION_DESCRIPTION_MAX_CHARS}-character limit`;
		case "schemaTooLarge":
			return `the function ${problem.function}'s ${problem.schema} holds ${problem.bytes} bytes, over the ${FUNCTION_SCHEMA_MAX_BYTES}-byte limit`;
		case "manifestTooLarge":
			return `${FUNCTION_MANIFEST_FILE} holds ${problem.bytes} bytes, over the ${FUNCTION_MANIFEST_MAX_BYTES}-byte limit`;
		case "invalidAssetPath":
			return `${JSON.stringify(problem.path)} is not a path inside ${FUNCTION_ASSETS_DIR}/`;
		case "assetPathTooLong":
			return `the asset path ${problem.path} holds ${problem.bytes} bytes, over the ${FUNCTION_ASSET_PATH_MAX_BYTES}-byte limit`;
		case "assetPathConflict":
			return `the asset ${problem.path} is both a file and a directory`;
		case "tooManyAssets":
			return `${problem.count} assets, over the ${FUNCTION_ASSETS_MAX_FILES}-file limit`;
		case "tooLarge":
			return `the files hold ${problem.bytes} bytes, over the ${FUNCTION_BUNDLE_MAX_BYTES}-byte bundle limit`;
		case "packedTooLarge":
			return `the packed archive holds ${problem.bytes} bytes, over the ${FUNCTION_BUNDLE_MAX_BYTES}-byte bundle limit`;
		default:
			return problem satisfies never;
	}
}
