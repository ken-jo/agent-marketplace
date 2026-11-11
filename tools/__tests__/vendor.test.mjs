import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

test("sync reads and builds the requested commit or tag independently of HEAD and dirty files", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vendor-ref-")));
  try {
    const app = join(root, "ave");
    mkdirSync(app);
    const git = (...args) => execFileSync("git", ["-C", app, ...args], { encoding: "utf8" }).trim();
    const write = (path, text) => { mkdirSync(dirname(join(app, path)), { recursive: true }); writeFileSync(join(app, path), text); };
    git("init", "-q");
    git("config", "user.name", "test");
    git("config", "user.email", "test@example.com");
    git("config", "commit.gpgsign", "false");
    write("package.json", '{"name":"vendor-fixture","private":true}\n');
    execFileSync("bun", ["install", "--ignore-scripts"], { cwd: app, stdio: "pipe" });
    write("src/plugins/public-contract.ts", 'export const protocol = "original";\n');
    write("schemas/plugin-manifest.schema.json", '{}\n');
    write("schemas/plugin-host-protocol/5/protocol.schema.json", '{}\n');
    write("src/marketplace/content/value.ts", 'export const value = "original";\n');
    write("src/marketplace/content/agent-plugin-components.ts", 'export { value } from "./value.ts";\n');
    write("src/marketplace/repository-check.ts", 'export const check = "original";\n');
    git("add", ".");
    write("executable.sh", "#!/bin/sh\nexit 0\n");
    git("add", "executable.sh");
    git("update-index", "--chmod=+x", "executable.sh");
    git("commit", "-qm", "Original sources");
    const ref = git("rev-parse", "HEAD");
    git("tag", "test-release");
    write("src/marketplace/content/value.ts", 'export const value = "new HEAD";\n');
    git("add", ".");
    git("commit", "-qm", "Change HEAD");
    write("src/plugins/public-contract.ts", 'export const protocol = "dirty";\n');
    write("src/marketplace/content/value.ts", 'export const value = "dirty";\n');
    const tools = join(root, "tools");
    mkdirSync(tools);
    for (const name of ["vendor.mjs", "bundle-app-marketplace.mjs"]) cpSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), join(tools, name));
    const run = (...args) => spawnSync("node", [join(tools, "vendor.mjs"), ...args], { encoding: "utf8" });
    const sync = (ref) => { const result = run("sync", "--ref", ref, "--app", app); assert.equal(result.status, 0, result.stderr); };
    sync(ref);
    assert.match(readFileSync(join(root, "contract/public-contract.ts"), "utf8"), /original/);
    const built = readFileSync(join(root, "tools/vendor/agent-plugin-components.js"), "utf8");
    assert.match(built, /original/);
    assert.doesNotMatch(built, /dirty|new HEAD/);
    const before = readFileSync(join(root, "tools/vendor/sources.json"), "utf8");
    sync(ref);
    assert.equal(readFileSync(join(root, "tools/vendor/sources.json"), "utf8"), before);
    assert.equal(readFileSync(join(root, "tools/vendor/agent-plugin-components.js"), "utf8"), built);
    sync("test-release");
    const sources = JSON.parse(readFileSync(join(root, "contract/sources.json"), "utf8"));
    assert.deepEqual(Object.keys(sources), ["repository", "ref", "commit", "files"]);
    assert.equal(sources.ref, "test-release");
    assert.equal(sources.commit, ref);
    assert.equal(run("check").status, 0);
    writeFileSync(join(tools, "ave-release.json"), JSON.stringify({ ref: "test-release" }));
    const configured = run("sync", "--app", app);
    assert.equal(configured.status, 0, configured.stderr);
    assert.equal(run("check").status, 0);
    writeFileSync(join(tools, "ave-release.json"), JSON.stringify({ ref: "different-release" }));
    assert.match(run("check").stderr, /ref differs from tools\/ave-release\.json/u);
    rmSync(join(tools, "ave-release.json"));
    assert.notEqual(run("sync", "--ref", "missing-tag", "--app", app).status, 0);
    git("rm", "-q", "src/marketplace/repository-check.ts");
    git("commit", "-qm", "Remove checker");
    const missing = run("sync", "--ref", git("rev-parse", "HEAD"), "--app", app);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /repository-check/u);

    symlinkSync("package.json", join(app, "linked-package.json"));
    git("add", "linked-package.json");
    git("commit", "-qm", "Symlink entry");
    const linked = run("sync", "--ref", git("rev-parse", "HEAD"), "--app", app);
    assert.notEqual(linked.status, 0);
    assert.match(linked.stderr, /symlink 120000 linked-package/u);
    git("rm", "-q", "linked-package.json");
    git("update-index", "--add", "--cacheinfo", `160000,${ref},linked-repository`);
    git("commit", "-qm", "Gitlink entry");
    const gitlink = run("sync", "--ref", git("rev-parse", "HEAD"), "--app", app);
    assert.notEqual(gitlink.status, 0);
    assert.match(gitlink.stderr, /gitlink 160000 linked-repository/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("every tool CLI runs through a symlink instead of silently succeeding", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tool-cli-")));
  try {
    writeFileSync(join(root, "marketplace.json"), "invalid JSON");
    for (const [name, args] of [
      ["vendor", ["bogus"]], ["plugin-check", []], ["index", ["--check"]],
      ["check", []], ["release", ["bogus"]], ["connector-pins", ["bogus"]],
      ["connector-runtime", []],
    ]) {
      const link = join(root, `${name}.mjs`);
      symlinkSync(fileURLToPath(new URL(`../${name}.mjs`, import.meta.url)), link);
      const result = spawnSync("node", [link, ...args], { encoding: "utf8", env: { ...process.env, MARKETPLACE_ROOT: root } });
      assert.notEqual(result.status, 0, `${name}: silently skipped CLI`);
      assert.ok(result.stderr.length > 0, `${name}: missing diagnostic`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
