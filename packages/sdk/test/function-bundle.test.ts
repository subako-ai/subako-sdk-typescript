import { describe, expect, it } from "vitest";
import {
	FUNCTION_ABI,
	FUNCTION_ASSET_PATH_MAX_BYTES,
	FUNCTION_ASSETS_MAX_FILES,
	FUNCTION_BUNDLE_MAX_BYTES,
	FUNCTION_DESCRIPTION_MAX_CHARS,
	FUNCTION_MANIFEST_MAX_BYTES,
	checkFunctionFiles,
	FunctionBundleError,
	type FunctionFiles,
	type FunctionManifestFile,
	packFunction,
	unpackSkill,
} from "../src/index.js";

const manifest: FunctionManifestFile = {
	abi: FUNCTION_ABI,
	name: "csv-tools",
	description: "CSV helpers",
};
const module = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

/** Bytes gzip cannot shrink, so the packed archive outgrows them. */
const noise = (length: number) => {
	const words = new Uint32Array(Math.ceil(length / 4));
	let state = 0x9e3779b9;
	for (let i = 0; i < words.length; i++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		words[i] = state;
	}
	return new Uint8Array(words.buffer, 0, length);
};

const problems = async (files: FunctionFiles) => {
	const error = await packFunction(files).catch((e: unknown) => e);
	expect(error).toBeInstanceOf(FunctionBundleError);
	return (error as FunctionBundleError).problems;
};

describe("packFunction", () => {
	it("packs the manifest and module at the root", async () => {
		const archive = await packFunction({ manifest, module });

		const files = await unpackSkill(archive);
		expect(files.map((file) => file.path)).toEqual(["module.wasm", "subako-package.json"]);
		expect(files[0]!.content).toEqual(module);
		expect(JSON.parse(new TextDecoder().decode(files[1]!.content))).toEqual(manifest);
	});

	it("packs assets under assets/", async () => {
		const words = new TextEncoder().encode("alpha beta");
		const archive = await packFunction({
			manifest,
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
				manifest,
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
		expect(await problems({ manifest, module, assets: { a: content, "a/b": content } })).toEqual([
			{ kind: "assetPathConflict", path: "a" },
		]);
	});

	it("bounds how many assets a package holds", async () => {
		const content = new Uint8Array();
		const assets = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${i}`, content]));
		expect(checkFunctionFiles({ manifest, module, assets: assets(FUNCTION_ASSETS_MAX_FILES) }, 0)).toEqual([]);
		expect(checkFunctionFiles({ manifest, module, assets: assets(FUNCTION_ASSETS_MAX_FILES + 1) }, 0)).toEqual([
			{ kind: "tooManyAssets", count: FUNCTION_ASSETS_MAX_FILES + 1 },
		]);
	});

	it("counts assets toward the bundle limit", async () => {
		const half = new Uint8Array(FUNCTION_BUNDLE_MAX_BYTES / 2);
		expect(checkFunctionFiles({ manifest, module: new Uint8Array(), assets: { a: half, b: half } }, 1)).toEqual([
			{ kind: "tooLarge", bytes: FUNCTION_BUNDLE_MAX_BYTES + 1 },
		]);
	});

	it("packs the same inputs to the same bytes", async () => {
		const files = { manifest, module };
		expect(await packFunction(files)).toEqual(await packFunction(files));
	});

	it("accepts files up to the limit and refuses past it", async () => {
		const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest)).byteLength;
		const fits = new Uint8Array(FUNCTION_BUNDLE_MAX_BYTES - manifestBytes);
		await expect(packFunction({ manifest, module: fits })).resolves.toBeInstanceOf(Uint8Array);

		const over = new Uint8Array(fits.byteLength + 1);
		expect(await problems({ manifest, module: over })).toEqual([
			{ kind: "tooLarge", bytes: FUNCTION_BUNDLE_MAX_BYTES + 1 },
		]);
	});

	// Two archives near the 64 MiB limit go through gzip, which a shared runner
	// can take longer than the default five seconds to do.
	it("refuses an archive whose packed size passes the limit though its files fit", async () => {
		const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest)).byteLength;
		const module = noise(FUNCTION_BUNDLE_MAX_BYTES - manifestBytes);
		const found = await problems({ manifest, module });
		expect(found).toHaveLength(1);
		expect(found[0]!.kind).toBe("packedTooLarge");

		const packed = await packFunction({ manifest, module: noise(FUNCTION_BUNDLE_MAX_BYTES - 64 * 1024) });
		expect(packed.byteLength).toBeLessThanOrEqual(FUNCTION_BUNDLE_MAX_BYTES);
	}, 60_000);

	it("bounds the description in characters", async () => {
		const atCap = "é".repeat(FUNCTION_DESCRIPTION_MAX_CHARS);
		await expect(packFunction({ manifest: { ...manifest, description: atCap }, module })).resolves.toBeInstanceOf(
			Uint8Array,
		);

		expect(await problems({ manifest: { ...manifest, description: `${atCap}x` }, module })).toEqual([
			{ kind: "descriptionTooLong", chars: FUNCTION_DESCRIPTION_MAX_CHARS + 1 },
		]);
	});

	it("bounds the manifest file", async () => {
		const bytes = (m: FunctionManifestFile) => new TextEncoder().encode(JSON.stringify(m)).byteLength;
		const padded = (total: number) => ({ ...manifest, name: "x".repeat(total - bytes({ ...manifest, name: "" })) });
		const fits = padded(FUNCTION_MANIFEST_MAX_BYTES);
		expect(bytes(fits)).toBe(FUNCTION_MANIFEST_MAX_BYTES);
		await expect(packFunction({ manifest: fits, module })).resolves.toBeInstanceOf(Uint8Array);

		const over = padded(FUNCTION_MANIFEST_MAX_BYTES + 1);
		expect(await problems({ manifest: over, module })).toEqual([
			{ kind: "manifestTooLarge", bytes: FUNCTION_MANIFEST_MAX_BYTES + 1 },
		]);
	});
});
