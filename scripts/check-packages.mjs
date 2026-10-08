// Pack the real artifacts, then import them in a consumer outside the workspace.
// Only third-party dependencies use the installed copies; every Subako package
// must resolve to an extracted tarball. No registry access is needed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const packages = readdirSync(join(root, "packages"))
	.map((directory) => {
		const path = join(root, "packages", directory);
		return { path, manifest: JSON.parse(readFileSync(join(path, "package.json"), "utf8")) };
	})
	.filter(({ manifest }) => !manifest.private);
const names = new Set(packages.map(({ manifest }) => manifest.name));
const temporary = mkdtempSync(join(tmpdir(), "subako-pack-"));
const consumer = join(temporary, "consumer");

try {
	mkdirSync(consumer);
	writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
	for (const [index, { path, manifest }] of packages.entries()) {
		// A removed source file must not survive in the published dist either.
		mkdirSync(join(path, "dist"), { recursive: true });
		writeFileSync(join(path, "dist", "__stale_pack_check__.js"), "throw new Error('stale output');");
		const archive = join(temporary, `${index}.tgz`);
		execFileSync("pnpm", ["pack", "--out", archive], { cwd: path, stdio: ["ignore", "pipe", "inherit"] });
		const installed = join(consumer, "node_modules", manifest.name);
		mkdirSync(installed, { recursive: true });
		execFileSync("tar", ["-xzf", archive, "-C", installed, "--strip-components=1"]);
		const packed = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
		assert(!existsSync(join(installed, "dist", "__stale_pack_check__.js")), `${manifest.name}: stale output shipped`);
		for (const entry of Object.values(packed.exports)) {
			for (const target of typeof entry === "string" ? [entry] : Object.values(entry)) {
				assert(existsSync(join(installed, target)), `${manifest.name}: missing export ${target}`);
			}
		}
		const dependencies = { ...packed.dependencies, ...packed.peerDependencies };
		for (const [name, range] of Object.entries(dependencies)) {
			assert(!range.startsWith("workspace:"), `${manifest.name}: unpublished dependency ${name}`);
			if (names.has(name)) continue;
			const destination = join(consumer, "node_modules", name);
			if (existsSync(destination)) continue;
			mkdirSync(dirname(destination), { recursive: true });
			symlinkSync(realpathSync(join(path, "node_modules", name)), destination, "dir");
		}
	}
	const imports = [...names].map((name) => `await import(${JSON.stringify(name)});`).join("\n");
	writeFileSync(join(consumer, "smoke.mjs"), imports);
	execFileSync(process.execPath, ["smoke.mjs"], { cwd: consumer, stdio: "inherit" });
	console.log(`Verified exports and imports from ${names.size} packed packages.`);
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
