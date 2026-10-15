/**
 * Copy `worker/` Python (+ schema) files into `dist/worker/` so the
 * marketplace artifact (which only ships `dist/` + `plugin.json`)
 * carries the worker scripts. Pre-fix, the artifact was missing
 * `worker/local_indexer_worker.py` entirely → spawn failed with
 *
 *   Errno 2: No such file or directory
 *   .../local-indexer/worker/local_indexer_worker.py
 *
 * which surfaced to the host as
 * "Local Indexer worker exited before becoming healthy" because
 * the Python process died at exec(). With the worker bundled into
 * `dist/`, the install layout is self-contained.
 *
 * Layout assumptions (kept narrow on purpose):
 *   - `worker/` is FLAT (no subdirectories used today). If a future
 *     refactor nests Python files (e.g. `worker/lib/foo.py`) update
 *     the recursion logic here BEFORE shipping or the new files will
 *     silently drop from the marketplace artifact.
 *   - Allowed extensions: `.py` (modules) + `.sql` (`schema.sql` is
 *     read by `local_indexer.py` via `Path(__file__).with_name`,
 *     so it must travel alongside).
 *   - `__pycache__` is filtered out via the `entry.isFile()` gate
 *     (it's a directory) — no special-case logic needed.
 *   - REQUIRED_FILES are asserted at the end so a misconfigured run
 *     fails the build LOUDLY rather than silently shipping a broken
 *     artifact (which is exactly the regression class we're fixing).
 *
 * Path resolution uses `import.meta.url` rather than `process.cwd()`
 * so the script behaves the same regardless of where it's invoked
 * from (matches `scripts/clean.mjs` convention).
 */
import { mkdirSync, readdirSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { resolve, join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(ROOT, "worker");
const dst = resolve(ROOT, "dist", "worker");

if (!existsSync(src)) {
  console.error(`copy-worker: FATAL — worker source missing at ${src}`);
  process.exit(1);
}

// Reset destination so files removed from `worker/` don't linger in
// `dist/worker/` across incremental builds.
rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });

const KEEP_EXTS = new Set([".py", ".sql"]);
// All sibling modules `local_indexer_worker.py` reaches at runtime — directly
// (`local_indexer`, `local_indexer_search`) or via lazy imports inside
// indexer/search (`korean_tokenizer`, `embedding_client`, `user_dict_loader`
// via korean_tokenizer). Plus `schema.sql` consumed by `local_indexer.py`
// via `Path(__file__).with_name`.
//
// If any of these is missing post-copy, Python `ImportError` ships green
// from this script and surfaces to the host as
// "Local Indexer worker exited before becoming healthy" — same regression
// class the surrounding fix protects against. Keep this list in sync with
// `worker/` actual contents whenever a module is added/renamed.
const REQUIRED_FILES = [
  "local_indexer_worker.py",
  "local_indexer.py",
  "local_indexer_search.py",
  "korean_tokenizer.py",
  "embedding_client.py",
  "user_dict_loader.py",
  "schema.sql",
];
const copied = [];

for (const entry of readdirSync(src, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  if (entry.name.startsWith(".")) continue;
  if (!KEEP_EXTS.has(extname(entry.name))) continue;
  copyFileSync(join(src, entry.name), join(dst, entry.name));
  copied.push(entry.name);
}

const copiedSet = new Set(copied);
const missing = REQUIRED_FILES.filter((f) => !copiedSet.has(f));
if (missing.length > 0) {
  console.error(
    `copy-worker: FATAL — required worker file(s) missing from copy: ${missing.join(", ")}`,
  );
  console.error(`copy-worker: scanned ${src}, copied ${copied.length} file(s): ${copied.join(", ") || "(none)"}`);
  process.exit(1);
}

console.log(`copy-worker: ${copied.length} file(s) → dist/worker/ (${copied.join(", ")})`);
