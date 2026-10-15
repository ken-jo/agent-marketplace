import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "copy-build-assets.mjs");

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ave-copy-assets-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function copyAssets(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

describe("copy-build-assets.mjs", () => {
  it("copies HTML and preload assets byte-for-byte", () => {
    withTempDir((dir) => {
      const htmlSrc = join(dir, "src.html");
      const htmlDest = join(dir, "nested", "dest.html");
      const preloadSrc = join(dir, "preload.cjs");
      const preloadDest = join(dir, "nested", "preload.cjs");
      writeFileSync(htmlSrc, "<script type=\"module\" src=\"./meeting-control.js\"></script>", "utf8");
      writeFileSync(preloadSrc, "module.exports = { ok: true };\n", "utf8");

      const result = copyAssets(htmlSrc, htmlDest, preloadSrc, preloadDest);

      expect(result.status).toBe(0);
      expect(readFileSync(htmlDest, "utf8")).toBe(readFileSync(htmlSrc, "utf8"));
      expect(readFileSync(preloadDest, "utf8")).toBe(readFileSync(preloadSrc, "utf8"));
    });
  });

  it("does not rewrite obsolete SDK token sentinels in JavaScript", () => {
    withTempDir((dir) => {
      const jsSrc = join(dir, "window.js");
      const jsDest = join(dir, "out", "window.js");
      const source = "const css = `/* @sdk-tokens */`;\n";
      writeFileSync(jsSrc, source, "utf8");

      const result = copyAssets(jsSrc, jsDest);

      expect(result.status).toBe(0);
      expect(readFileSync(jsDest, "utf8")).toBe(source);
    });
  });
});
