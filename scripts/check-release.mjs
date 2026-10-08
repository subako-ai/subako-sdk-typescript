// A release tag names the one version every package goes out at: `v0.1.3` means
// each of them is 0.1.3. `pnpm -r publish` skips a version the registry already
// has and exits 0, so a tag pushed before the bump would release nothing and pass,
// and a package left out of the bump would ship the others without it.
//
// A prerelease is refused: published without a dist-tag, it would become `latest`.
//
// The SDK's VERSION constant is held to its package.json by a test, which the
// release runs before it gets here.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const tag = process.argv[2] ?? "";
const expected = /^v(\d+\.\d+\.\d+)$/.exec(tag)?.[1];
if (!expected) {
	console.error(`${JSON.stringify(tag)} is not a release tag; expected one like v0.1.3.`);
	process.exit(1);
}

const root = fileURLToPath(new URL("../packages/", import.meta.url));
const behind = readdirSync(root)
	.map((directory) => JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8")))
	.filter((manifest) => !manifest.private && manifest.version !== expected);

if (behind.length > 0) {
	for (const { name, version } of behind) console.error(`${name} is ${version}, not ${expected}.`);
	process.exit(1);
}
console.log(`Every package is ${expected}.`);
