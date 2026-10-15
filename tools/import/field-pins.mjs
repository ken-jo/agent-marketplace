#!/usr/bin/env node
/**
 * One-time field pins for the granted plugins (blueprint 0.7, design §16.3).
 * Kept as the record of how those index entries were made; not run again.
 *
 * An install keeps its host-secret grant across the switch when its receipt's
 * sha256 equals the official index's pin for the installed version. So every
 * version still installed in the field gets an index entry pinned to the
 * exact zip the server marketplace served, for every version the app can
 * load: the Agent Plugins manifest line (minAppVersion 0.7.0), meeting
 * 0.8.0–0.8.4 and local-indexer 0.6.0–0.6.6. The server still serves older
 * granted versions, but each of those has a flat plugin.json with no
 * extensions["ai.agent-connector.ave"] (meeting 0.7.0, the newest of them, checked on
 * 2026-09-24), which the app's parsePluginJson refuses before and after the
 * switch. An install of one has no working grant to keep; it loads again
 * only by updating (design §16.3).
 *
 * Each version is released unchanged on its imported tag, pinned by its
 * descriptor in its own commit, and listed as yanked: its manifest carries
 * the installPolicy of its era, so nothing installs it.
 *
 *   node tools/import/field-pins.mjs download   fetch the zips and check them against the server's sha256
 *   node tools/import/field-pins.mjs release    push the tags and create the releases (writes to GitHub)
 *   node tools/import/field-pins.mjs pin        commit each pin and its index entry, in version order
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assetOf, pin, tagOf } from "../release.mjs";
import { INDEX_PATH, REPOSITORY, ROOT, git, readJson } from "../repo.mjs";

const SERVER = "https://marketplace.former-site.invalid/api/v1";
const LINE = "0.7.0";
const PLUGINS = ["meeting", "local-indexer"];
const WORK = join(process.env.TMPDIR ?? "/tmp", "field-pins");
const YANK_REASON = "Field pin: the zip the server marketplace served, listed so installs of it keep their grant. Not installable.";

const TRAILERS = "\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01QnxgKn3FVopKbP7Q2YKBFE";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const compare = (a, b) => a.split(".").map(Number).reduce((d, n, i) => d || n - Number(b.split(".")[i]), 0);

async function fieldVersions() {
  const out = [];
  for (const name of PLUGINS) {
    const detail = await (await fetch(`${SERVER}/plugins/${name}`)).json();
    const versions = detail.versions.filter((v) => !v.yanked && v.min_app_version === LINE).sort((a, b) => compare(a.version, b.version));
    for (const v of versions) out.push({ name, version: v.version, sha256: v.artifact_sha256, zip: join(WORK, assetOf(name, v.version)) });
  }
  return out;
}

async function download() {
  mkdirSync(WORK, { recursive: true });
  const versions = await fieldVersions();
  for (const v of versions) {
    if (!existsSync(v.zip)) {
      const response = await fetch(`${SERVER}/plugins/${v.name}/versions/${v.version}/download`);
      if (!response.ok) throw new Error(`${v.name}@${v.version}: download answered ${response.status}`);
      writeFileSync(v.zip, Buffer.from(await response.arrayBuffer()));
    }
    const actual = sha256(readFileSync(v.zip));
    if (actual !== v.sha256) throw new Error(`${v.name}@${v.version}: ${actual} is not the server's ${v.sha256}`);
    const manifest = JSON.parse(execFileSync("unzip", ["-p", v.zip, "plugin.json"], { encoding: "utf8" }));
    if (manifest.name !== v.name || manifest.version !== v.version) throw new Error(`${v.zip} holds ${manifest.name}@${manifest.version}`);
  }
  writeFileSync(join(WORK, "plan.json"), `${JSON.stringify(versions, null, 2)}\n`);
  return versions;
}

function plan() {
  return JSON.parse(readFileSync(join(WORK, "plan.json"), "utf8"));
}

function release() {
  const versions = plan();
  git(["push", "origin", ...versions.map((v) => `refs/tags/${tagOf(v.name, v.version)}`)]);
  for (const v of versions) {
    execFileSync(
      "gh",
      ["release", "create", tagOf(v.name, v.version), v.zip, "--repo", REPOSITORY, "--verify-tag", "--title", `${v.name} ${v.version} (field pin)`, "--notes", YANK_REASON],
      { stdio: "inherit" },
    );
  }
}

function pinAll() {
  for (const v of plan()) {
    pin(v.name, v.zip);
    git(["add", `plugins/${v.name}/ave-package.json`]);
    git(["commit", "-q", "-m", `Pin ${v.name} ${v.version}, a field pin (blueprint 0.7)${TRAILERS}`]);
    execFileSync("node", [join(ROOT, "tools/index.mjs")], { stdio: "inherit", env: { ...process.env, MARKETPLACE_ROOT: ROOT } });
    const index = readJson(INDEX_PATH);
    const entry = index.packages.find((p) => p.kind === "plugin" && p.name === v.name).versions.find((e) => e.version === v.version);
    entry.yanked = { reason: YANK_REASON, at: entry.publishedAt };
    writeFileSync(join(ROOT, INDEX_PATH), `${JSON.stringify(index, null, 2)}\n`);
    // The generator keeps a hand-set yanked and recomputes `latest` without it.
    execFileSync("node", [join(ROOT, "tools/index.mjs")], { stdio: "inherit", env: { ...process.env, MARKETPLACE_ROOT: ROOT } });
    git(["add", INDEX_PATH]);
    git(["commit", "-q", "-m", `Index ${v.name} ${v.version} as a yanked field pin${TRAILERS}`]);
  }
}

const command = process.argv[2];
if (command === "download") console.log(JSON.stringify((await download()).map((v) => `${v.name}@${v.version}`)));
else if (command === "release") release();
else if (command === "pin") pinAll();
else {
  console.error("usage: field-pins.mjs download | release | pin");
  process.exit(2);
}
