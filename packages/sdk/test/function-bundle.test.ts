import { describe, expect, it } from "vitest";
import {
	FUNCTION_ASSET_PATH_MAX_BYTES,
	FUNCTION_ASSETS_MAX_FILES,
	FUNCTION_BUNDLE_MAX_BYTES,
	FUNCTION_DESCRIPTION_MAX_CHARS,
	FUNCTION_MANIFEST_MAX_BYTES,
	FUNCTION_SCHEMA_MAX_BYTES,
	checkFunctionFiles,
	FunctionBundleError,
	type FunctionFiles,
	packFunction,
	unpackSkill,
} from "../src/index.js";

const fn = (name: string) => ({
	name,
	description: "",
	input_schema: { type: "object" },
	output_schema: {},
});
const manifest = (...names: string[]): FunctionFiles["manifest"] => ({
	name: "csv-tools",
	description: "CSV helpers",
	functions: names.map(fn),
});
const module = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

/** Bytes gzip cannot shrink, so the packed archive outgrows them. */
const noise = (length: number) => {
	const bytes = new Uint8Array(length);
	let state = 0x9e3779b9;
	for (let i = 0; i < length; i++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		bytes[i] = state & 0xff;
	}
	return bytes;
};

/** A schema `{"d":"x…x","type":"object"}` of exactly `bytes` bytes. */
const schemaOf = (bytes: number) => ({ d: "x".repeat(bytes - 24), type: "object" });

const problems = async (files: FunctionFiles) => {
	const error = await packFunction(files).catch((e: unknown) => e);
	expect(error).toBeInstanceOf(FunctionBundleError);
	return (error as FunctionBundleError).problems;
};

describe("packFunction", () => {
	it("packs the manifest and module at the root", async () => {
		const archive = await packFunction({ manifest: manifest("parse", "count"), module });

		const files = await unpackSkill(archive);
		expect(files.map((file) => file.path)).toEqual(["module.wasm", "subako-package.json"]);
		expect(files[0]!.content).toEqual(module);
		expect(JSON.parse(new TextDecoder().decode(files[1]!.content))).toEqual(manifest("parse", "count"));
	});

	it("packs assets under assets/", async () => {
		const words = new TextEncoder().encode("alpha beta");
		const archive = await packFunction({
			manifest: manifest("parse"),
			module,
			assets: { "data/words.txt": words, "b.bin": new Uint8Array([1, 2]) },
		});

		const files = await unpackSkill(archive);
		expect(files.map((file) => file.path)).toEqual([
			"assets/b.bin",
			"assets/data/words.txt",
			"module.wasm",
			"subako-package.json",
		]);
		expect(files[1]!.content).toEqual(words);
	});

	it("refuses an asset path outside assets/ or over its limit", async () => {
		const long = "a".repeat(FUNCTION_ASSET_PATH_MAX_BYTES + 1);
		const fits = "a".repeat(FUNCTION_ASSET_PATH_MAX_BYTES);
		const content = new Uint8Array();
		expect(
			await problems({
				manifest: manifest("parse"),
				module,
				assets: { "../x": content, "/abs": content, "a//b": content, [long]: content, [fits]: content },
			}),
		).toEqual([
			{ kind: "invalidAssetPath", path: "../x" },
			{ kind: "invalidAssetPath", path: "/abs" },
			{ kind: "invalidAssetPath", path: "a//b" },
			{ kind: "assetPathTooLong", path: long, bytes: FUNCTION_ASSET_PATH_MAX_BYTES + 1 },
		]);
	});

	it("refuses an asset that is another's directory", async () => {
		const content = new Uint8Array();
		expect(await problems({ manifest: manifest("parse"), module, assets: { a: content, "a/b": content } })).toEqual([
			{ kind: "assetPathConflict", path: "a" },
		]);
	});

	it("bounds how many assets a package holds", async () => {
		const content = new Uint8Array();
		const assets = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${i}`, content]));
		expect(
			checkFunctionFiles({ manifest: manifest("parse"), module, assets: assets(FUNCTION_ASSETS_MAX_FILES) }, 0),
		).toEqual([]);
		expect(
			checkFunctionFiles({ manifest: manifest("parse"), module, assets: assets(FUNCTION_ASSETS_MAX_FILES + 1) }, 0),
		).toEqual([{ kind: "tooManyAssets", count: FUNCTION_ASSETS_MAX_FILES + 1 }]);
	});

	it("counts assets toward the bundle limit", async () => {
		const half = new Uint8Array(FUNCTION_BUNDLE_MAX_BYTES / 2);
		expect(
			checkFunctionFiles({ manifest: manifest("parse"), module: new Uint8Array(), assets: { a: half, b: half } }, 1),
		).toEqual([{ kind: "tooLarge", bytes: FUNCTION_BUNDLE_MAX_BYTES + 1 }]);
	});

	it("packs the same inputs to the same bytes", async () => {
		const files = { manifest: manifest("parse"), module };
		expect(await packFunction(files)).toEqual(await packFunction(files));
	});

	it("refuses a manifest with no functions", async () => {
		expect(await problems({ manifest: manifest(), module })).toEqual([{ kind: "noFunctions" }]);
	});

	it("refuses a repeated function name", async () => {
		expect(await problems({ manifest: manifest("parse", "count", "parse"), module })).toEqual([
			{ kind: "duplicateFunction", name: "parse" },
		]);
	});

	it("accepts files up to the limit and refuses past it", async () => {
		const m = manifest("parse");
		const manifestBytes = new TextEncoder().encode(JSON.stringify(m)).byteLength;
		const fits = new Uint8Array(FUNCTION_BUNDLE_MAX_BYTES - manifestBytes);
		await expect(packFunction({ manifest: m, module: fits })).resolves.toBeInstanceOf(Uint8Array);

		const over = new Uint8Array(fits.byteLength + 1);
		expect(await problems({ manifest: m, module: over })).toEqual([
			{ kind: "tooLarge", bytes: FUNCTION_BUNDLE_MAX_BYTES + 1 },
		]);
	});

	it("refuses an archive whose packed size passes the limit though its files fit", async () => {
		const m = manifest("parse");
		const manifestBytes = new TextEncoder().encode(JSON.stringify(m)).byteLength;
		const module = noise(FUNCTION_BUNDLE_MAX_BYTES - manifestBytes);
		const found = await problems({ manifest: m, module });
		expect(found).toHaveLength(1);
		expect(found[0]!.kind).toBe("packedTooLarge");

		const packed = await packFunction({ manifest: m, module: noise(FUNCTION_BUNDLE_MAX_BYTES - 64 * 1024) });
		expect(packed.byteLength).toBeLessThanOrEqual(FUNCTION_BUNDLE_MAX_BYTES);
	});

	it("bounds each description in characters", async () => {
		const atCap = "é".repeat(FUNCTION_DESCRIPTION_MAX_CHARS);
		const fits: FunctionFiles["manifest"] = {
			...manifest(),
			description: atCap,
			functions: [{ ...fn("parse"), description: atCap }],
		};
		await expect(packFunction({ manifest: fits, module })).resolves.toBeInstanceOf(Uint8Array);

		const long = `${atCap}x`;
		expect(
			await problems({
				manifest: { ...fits, description: long, functions: [{ ...fn("parse"), description: long }] },
				module,
			}),
		).toEqual([
			{ kind: "descriptionTooLong", function: null, chars: FUNCTION_DESCRIPTION_MAX_CHARS + 1 },
			{ kind: "descriptionTooLong", function: "parse", chars: FUNCTION_DESCRIPTION_MAX_CHARS + 1 },
		]);
	});

	it("bounds each schema as JSON", async () => {
		const fits = schemaOf(FUNCTION_SCHEMA_MAX_BYTES);
		expect(new TextEncoder().encode(JSON.stringify(fits)).byteLength).toBe(FUNCTION_SCHEMA_MAX_BYTES);
		const ok = { ...manifest(), functions: [{ ...fn("parse"), input_schema: fits, output_schema: fits }] };
		await expect(packFunction({ manifest: ok, module })).resolves.toBeInstanceOf(Uint8Array);

		const over = schemaOf(FUNCTION_SCHEMA_MAX_BYTES + 1);
		expect(
			await problems({
				manifest: { ...manifest(), functions: [{ ...fn("parse"), input_schema: over, output_schema: over }] },
				module,
			}),
		).toEqual([
			{ kind: "schemaTooLarge", function: "parse", schema: "input_schema", bytes: FUNCTION_SCHEMA_MAX_BYTES + 1 },
			{ kind: "schemaTooLarge", function: "parse", schema: "output_schema", bytes: FUNCTION_SCHEMA_MAX_BYTES + 1 },
		]);
	});

	it("bounds the manifest file", async () => {
		const schema = schemaOf(FUNCTION_SCHEMA_MAX_BYTES);
		const names = ["a", "b", "c", "d"];
		const m = {
			...manifest(),
			functions: names.map((name) => ({ ...fn(name), input_schema: schema, output_schema: schema })),
		};
		const bytes = new TextEncoder().encode(JSON.stringify(m)).byteLength;
		expect(bytes).toBeGreaterThan(FUNCTION_MANIFEST_MAX_BYTES);
		expect(await problems({ manifest: m, module })).toEqual([{ kind: "manifestTooLarge", bytes }]);
	});
});
