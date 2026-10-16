/*
 * Copy build assets src->dest pairs.
 *
 * Bundled UI JavaScript vendors its own theme helper locally
 * (src/ui/prime-theme.js) since SDK v7.0.0 removed the whole
 * plugin-sdk/ui/* surface. This script only copies non-bundled static
 * assets such as HTML and preload files, and intentionally does not rewrite
 * JavaScript sentinels.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);

if (args.length === 0 || args.length % 2 !== 0) {
  throw new Error("Usage: copy-build-assets.mjs <src1> <dest1> [<src2> <dest2> ...]");
}

for (let i = 0; i < args.length; i += 2) {
  const src = resolve(process.cwd(), args[i]);
  const dest = resolve(process.cwd(), args[i + 1]);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}
