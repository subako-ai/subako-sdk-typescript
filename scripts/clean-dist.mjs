#!/usr/bin/env node
// Empties every package's dist before a build, so a module that was deleted from
// src cannot ship: `tsc -b --clean` removes the outputs of the files it still
// sees, and knows nothing about the ones that are gone.
//
// The build info goes with it. It sits beside dist rather than inside it, so that
// the published tarball carries only the build's output and not its bookkeeping,
// and a dist removed without it would leave `tsc -b` reading a record of outputs
// that are no longer there and skipping the rebuild.
import { readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PACKAGES = new URL("../packages/", import.meta.url);

for (const name of readdirSync(fileURLToPath(PACKAGES))) {
	rmSync(fileURLToPath(new URL(`${name}/dist`, PACKAGES)), { recursive: true, force: true });
	rmSync(fileURLToPath(new URL(`${name}/.tsbuildinfo`, PACKAGES)), { force: true });
}
