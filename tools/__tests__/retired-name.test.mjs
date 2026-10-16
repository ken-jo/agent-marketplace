/**
 * Self-test for the retired-name gate. A gate nobody has watched fail is a
 * gate nobody can trust, so each outcome is pinned against throwaway Git
 * repositories. Like the gate, it never spells the name: every positive
 * control is built from RETIRED_NAME.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ALLOWLIST, RETIRED_NAME, RETIRED_NAME_PATTERN, scanRetiredName } from "../check-retired-name.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const GATE = join(REPO_ROOT, "tools/check-retired-name.mjs");
const lower = RETIRED_NAME;
const upper = RETIRED_NAME.toUpperCase();

/** Git with no inherited GIT_* context, so a fixture never touches the enclosing repository. */
function gitEnv(root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  return { ...env, GIT_CEILING_DIRECTORIES: dirname(root), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
}

/** A repository whose index tracks `tracked`; `untracked` files are written but never added. */
function fixture(tracked, untracked = {}) {
  const root = mkdtempSync(join(tmpdir(), "marketplace-retired-name-"));
  const env = gitEnv(root);
  execFileSync("git", ["-C", root, "init", "-q"], { env });
  const write = (files) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
  };
  write(tracked);
  if (Object.keys(tracked).length > 0) execFileSync("git", ["-C", root, "add", "--", ...Object.keys(tracked)], { env });
  write(untracked);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// The name itself, pinned without spelling it: a changed code point fails here
// even though every other test builds its controls from the constant.
test("pins the retired name by its sha256 and length", () => {
  assert.equal(RETIRED_NAME.length, 4);
  assert.equal(createHash("sha256").update(RETIRED_NAME).digest("hex"), "7899e2167ac27be58f7f4ed7adc44d7e2502353cc470275c3ad031f61145acb0");
});

test("flags the name in any tracked file's content, with its lines", () => {
  const f = fixture({
    "plugins/a/source/src/a.ts": `const x = 1;\nconst home = process.env.${upper}_HOME;\n`,
    "skills/b/NOTICE": `This ${upper} package.\n`,
    "mcp/c/ave-package.json": `{ "args": ["$DATA_DIR/${lower}.sqlite"] }\n`,
  });
  try {
    assert.deepEqual(scanRetiredName(f.root, []), {
      offenders: [
        { path: "mcp/c/ave-package.json", inPath: false, lines: [1] },
        { path: "plugins/a/source/src/a.ts", inPath: false, lines: [2] },
        { path: "skills/b/NOTICE", inPath: false, lines: [1] },
      ],
      stale: [],
    });
  } finally {
    f.cleanup();
  }
});

test("flags the name in a tracked path even when the content is clean, binary files included", () => {
  const f = fixture({
    [`plugins/a/${lower}-package.json`]: "{}\n",
    [`assets/${upper}.bin`]: Buffer.from([0x00, 0x01]),
  });
  try {
    assert.deepEqual(scanRetiredName(f.root, []), {
      offenders: [
        { path: `assets/${upper}.bin`, inPath: true, lines: [] },
        { path: `plugins/a/${lower}-package.json`, inPath: true, lines: [] },
      ],
      stale: [],
    });
  } finally {
    f.cleanup();
  }
});

test("does not match words that only contain the letters", () => {
  const f = fixture({ "src/b.ts": "const modelVisible = true; // Vision, devisable, ELVISH, callVisitor\n" });
  try {
    assert.deepEqual(scanRetiredName(f.root, []), { offenders: [], stale: [] });
  } finally {
    f.cleanup();
  }
  for (const word of ["modelVisible", "Vision", "ELVIS", "callVisitor"]) assert.equal(RETIRED_NAME_PATTERN.test(word), false, word);
  for (const word of [upper, `${lower}-app`, `@${lower}/plugin`, `.${lower}-meeting-ui`, `_${upper}_HOME`]) assert.equal(RETIRED_NAME_PATTERN.test(word), true, word);
});

test("ignores untracked files and binary content", () => {
  const f = fixture(
    { "assets/blob.bin": Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.from(upper)]) },
    { "notes/scratch.md": `${upper}\n` },
  );
  try {
    assert.deepEqual(scanRetiredName(f.root, []), { offenders: [], stale: [] });
  } finally {
    f.cleanup();
  }
});

test("exempts exact allowlisted paths only, and reports an entry once nothing needs it", () => {
  const allowlist = [
    ["contract/public-contract.ts", "vendored"],
    ["tools/vendor/old.js", "vendored, synced since"],
  ];
  const f = fixture({
    "contract/public-contract.ts": `export const X = "xyz.${lower}ai";\n`,
    "contract/other.ts": `export const Y = "${lower}";\n`,
    "tools/vendor/old.js": "clean after the sync\n",
  });
  try {
    assert.deepEqual(scanRetiredName(f.root, allowlist), {
      offenders: [{ path: "contract/other.ts", inPath: false, lines: [1] }],
      stale: ["tools/vendor/old.js"],
    });
  } finally {
    f.cleanup();
  }
});

test("allowlists exactly the three signed vendored contract files", () => {
  assert.deepEqual(ALLOWLIST, [
    ["contract/public-contract.ts", "signed vendored bundle until the next ave tag sync"],
    ["tools/vendor/agent-plugin-components.js", "signed vendored bundle until the next ave tag sync"],
    ["tools/vendor/marketplace-check.js", "signed vendored bundle until the next ave tag sync"],
  ]);
});

test("the repository passes the gate, with no stale allowlist entry", () => {
  assert.deepEqual(scanRetiredName(REPO_ROOT), { offenders: [], stale: [] });
});

test("the command fails closed on an offender and on a stale entry", () => {
  // The real gate, copied untracked into a fixture, scans the fixture it sits in.
  const run = (f) => {
    mkdirSync(join(f.root, "tools"), { recursive: true });
    copyFileSync(GATE, join(f.root, "tools/check-retired-name.mjs"));
    return spawnSync("node", [join(f.root, "tools/check-retired-name.mjs")], { encoding: "utf8", env: gitEnv(f.root) });
  };
  const vendored = Object.fromEntries(ALLOWLIST.map(([path]) => [path, `"xyz.${lower}ai"\n`]));
  const offending = fixture({ ...vendored, "README.md": `${upper}\n` });
  try {
    const result = run(offending);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /README\.md:1/u);
    assert.doesNotMatch(result.stderr, /no longer match/u);
  } finally {
    offending.cleanup();
  }
  // After the sync the vendored files are clean: every entry is stale.
  const synced = fixture({ ...Object.fromEntries(ALLOWLIST.map(([path]) => [path, "clean\n"])), "README.md": "Ave\n" });
  try {
    const result = run(synced);
    assert.equal(result.status, 1);
    for (const [path] of ALLOWLIST) assert.match(result.stderr, new RegExp(`^  ${path.replaceAll(".", "\\.")}$`, "mu"));
  } finally {
    synced.cleanup();
  }
  const clean = fixture(vendored);
  try {
    const result = run(clean);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[retired-name\] OK/u);
  } finally {
    clean.cleanup();
  }
});
