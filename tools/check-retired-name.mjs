#!/usr/bin/env node
/**
 * check-retired-name.mjs — the app's retired product name never comes back.
 *
 * The name is retired; it may not appear in any tracked file's content or
 * path. The pattern is assembled from code points below so that this gate
 * does not spell it either; tools/__tests__/retired-name.test.mjs pins it by
 * sha256.
 *
 * Every tracked file is scanned (binary content excepted, paths always). The
 * match needs a non-letter before the name, so words that merely contain the
 * letters never match. An ALLOWLIST entry that no longer matches any file is
 * stale and fails as well, so the list can only shrink, to empty.
 *
 *   node tools/check-retired-name.mjs
 */
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The retired product name, lower case. */
export const RETIRED_NAME = String.fromCodePoint(0x6c, 0x76, 0x69, 0x73);

export const RETIRED_NAME_PATTERN = new RegExp(`(?<![A-Za-z])${RETIRED_NAME}`, "i");

const VENDORED = "signed vendored bundle until the next ave tag sync";

/**
 * Where the name may stay: `[path, reason]`, each one exact path. The three
 * files are byte-pinned to the signed Ave contract bundle (contract/sources.json,
 * tools/vendor/sources.json) and cannot be edited; `node tools/vendor.mjs sync
 * --ref <tag>` from an Ave release without the name clears them, and the stale
 * check then forces their removal here.
 */
export const ALLOWLIST = Object.freeze([
  ["contract/public-contract.ts", VENDORED],
  ["tools/vendor/agent-plugin-components.js", VENDORED],
  ["tools/vendor/marketplace-check.js", VENDORED],
]);

const BINARY_PROBE_BYTES = 8000;

/** The environment without the GIT_* variables a hook or caller may set, so `-C` decides the repository. */
function gitEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
}

function trackedFiles(repoRoot) {
  const result = spawnSync("git", ["-C", repoRoot, "ls-files", "-z"], {
    encoding: "buffer", env: gitEnvironment(), maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`[retired-name] git ls-files failed: ${result.stderr.toString("utf8").trim()}`);
  }
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

/** Lines (1-based) of `text` that carry the name. */
function matchingLines(text) {
  const lines = [];
  text.split("\n").forEach((line, index) => {
    if (RETIRED_NAME_PATTERN.test(line)) lines.push(index + 1);
  });
  return lines;
}

/**
 * Scan the tracked files of `repoRoot`. `offenders` are files outside the
 * allowlist whose path or content carries the name: `lines` lists the content
 * lines, and `inPath` says whether the path itself does. `stale` are allowlist
 * entries that no tracked file needs any more.
 */
export function scanRetiredName(repoRoot, allowlist = ALLOWLIST) {
  const offenders = [];
  const used = new Set();
  for (const path of trackedFiles(repoRoot)) {
    const inPath = RETIRED_NAME_PATTERN.test(path);
    let lines = [];
    let bytes = null;
    try {
      bytes = readFileSync(resolve(repoRoot, path));
    } catch (error) {
      // A tracked path deleted in the working tree carries no content to check.
      if (error?.code !== "ENOENT") throw error;
    }
    if (bytes && !bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) lines = matchingLines(bytes.toString("utf8"));
    if (!inPath && lines.length === 0) continue;
    const entry = allowlist.find(([allowed]) => allowed === path);
    if (entry) {
      used.add(entry[0]);
      continue;
    }
    offenders.push({ path, inPath, lines });
  }
  const stale = allowlist.map(([entry]) => entry).filter((entry) => !used.has(entry));
  return { offenders, stale };
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const { offenders, stale } = scanRetiredName(resolve(fileURLToPath(new URL("..", import.meta.url))));
  if (stale.length > 0) {
    console.error(
      "[retired-name] FAIL — these ALLOWLIST entries no longer match any file and\n"
        + "must be removed from tools/check-retired-name.mjs:\n"
        + stale.map((entry) => `  ${entry}`).join("\n"),
    );
  }
  if (offenders.length > 0) {
    console.error(
      "[retired-name] FAIL — the retired product name appears in these tracked files.\n"
        + "Use the current name (Ave).\n"
        + offenders.map(({ path, inPath, lines }) =>
          `  ${path}${inPath ? " (path)" : ""}${lines.length > 0 ? `:${lines.slice(0, 8).join(",")}` : ""}`).join("\n"),
    );
  }
  if (stale.length > 0 || offenders.length > 0) process.exit(1);
  console.log("[retired-name] OK");
}
