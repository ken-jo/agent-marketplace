// Cross-platform clean — removes the repo's build output.
// Path is resolved relative to this script (`ROOT` = the parent of the `scripts/` dir),
// not the caller's cwd, so running `node path/to/clean.mjs` from anywhere is safe.
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
rmSync(resolve(ROOT, "dist"), { recursive: true, force: true });
