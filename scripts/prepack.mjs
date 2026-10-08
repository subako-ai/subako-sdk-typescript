// Each package builds itself before npm/pnpm packs or publishes it. Clean only
// this package: another package may be packing its own output at the same time.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
rmSync(resolve("dist"), { recursive: true, force: true });
rmSync(resolve(".tsbuildinfo"), { force: true });
const tsc = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
execFileSync(process.execPath, [tsc, "-b"], { stdio: "inherit" });
