#!/usr/bin/env node
// Check committed builds against the reviewed source, without running server code.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installEnvironment, readPin } from "./connector-runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "ave-connector-build-check-"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
try {
  for (const id of ["trello-mcp", "google-workspace-mcp", "obsidian-mcp"]) {
    const server = join(root, "mcp", id, "server");
    const pin = readPin(server);
    const repository = pin.source.repository.replace(/^git\+/u, "").replace(/\.git$/u, "");
    assert.match(repository, /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
    assert.match(pin.source.commit, /^[a-f0-9]{40}$/u);
    const repo = new URL(repository).pathname.slice(1);
    const archive = join(work, `${id}.tgz`);
    writeFileSync(archive, execFileSync("gh", ["api", `repos/${repo}/tarball/${pin.source.commit}`], { maxBuffer: 64 * 1024 * 1024 }));
    const source = join(work, id); mkdirSync(source);
    execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", source]);
    if (id === "trello-mcp") {
      const clean = installEnvironment(process.env, work);
      assert.equal(execFileSync("bun", ["--version"], { env: clean, encoding: "utf8" }).trim(), "1.3.14");
      const out = join(work, "trello.mjs");
      execFileSync("bun", ["build", "src/index.ts", "--packages", "external", "--target", "node", "--format", "esm", "--outfile", out], { cwd: source, env: clean, stdio: "pipe" });
      assert.equal(hash(readFileSync(out)), pin.artifact.rebuilt.sha256, "Trello build differs from its committed reviewed artifact");
      assert(readFileSync(join(source, "LICENSE")).equals(readFileSync(join(server, pin.artifact.rebuilt.license))));
    } else {
      const wheel = join(server, pin.artifact.wheel);
      const names = execFileSync("unzip", ["-Z1", wheel], { encoding: "utf8" }).trim().split("\n");
      let checked = 0;
      for (const name of names) {
        if (name.includes(".dist-info/") && !name.endsWith("/licenses/LICENSE")) continue;
        const relative = name.endsWith("/licenses/LICENSE") ? "LICENSE" : (id === "obsidian-mcp" ? `src/${name}` : name);
        const bytes = execFileSync("unzip", ["-p", wheel, name], { maxBuffer: 8 * 1024 * 1024 });
        assert(bytes.equals(readFileSync(join(source, relative))), `${id}: wheel file differs from reviewed source: ${name}`);
        checked += 1;
      }
      assert(checked > 4, "No wheel source payload checked");
    }
    console.log(`${id}: committed artifact matches reviewed source`);
  }
} finally { rmSync(work, { recursive: true, force: true }); }
