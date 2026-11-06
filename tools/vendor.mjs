#!/usr/bin/env node
/** Copy Ave's public contract and build repository helpers from a git ref. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(process.env.MARKETPLACE_ROOT ?? fileURLToPath(new URL("..", import.meta.url)));
const SOURCES = {
  contract: {
    "public-contract.ts": { from: "src/plugins/public-contract.ts" },
    "plugin-manifest.schema.json": { from: "schemas/plugin-manifest.schema.json" },
    "protocol.schema.json": { from: "schemas/plugin-host-protocol/5/protocol.schema.json" },
  },
  "tools/vendor": {
    "agent-plugin-components.js": { build: { entry: "src/marketplace/content/agent-plugin-components.ts" } },
    "marketplace-check.js": { build: { entry: "src/marketplace/repository-check.ts" } },
  },
};

/** Offline existence check only; provenance is recorded for review. */
export function checkVendored() {
  const problems = [];
  for (const dir of Object.keys(SOURCES)) {
    try {
      const { files } = JSON.parse(readFileSync(join(ROOT, dir, "sources.json"), "utf8"));
      for (const name of Object.keys(files)) {
        if (!existsSync(join(ROOT, dir, name))) problems.push(`${dir}/${name}: missing`);
      }
    } catch (error) {
      problems.push(`${dir}/sources.json: ${error.message}`);
    }
  }
  return problems;
}

function sync(ref, app) {
  const git = (...args) => execFileSync("git", ["-C", app, ...args], { maxBuffer: 64 * 1024 * 1024 });
  const revision = /^[0-9a-f]{40}$/iu.test(ref) ? ref : `refs/tags/${ref}`;
  const commit = git("rev-parse", "--verify", `${revision}^{commit}`).toString().trim();
  // Materialize tracked files with git show so neither HEAD nor dirty working
  // tree files can affect the build. Dependencies come from this ref's lockfile.
  const work = mkdtempSync(join(tmpdir(), "ave-contract-"));
  try {
    for (const path of git("ls-tree", "-r", "--name-only", "-z", commit).toString().split("\0").filter(Boolean)) {
      const destination = join(work, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, git("show", `${commit}:${path}`));
    }
    // Bun 1.3 creates patch parent directories relative to cwd with file
    // permissions. Pre-create Ave's added sandbox files' parent as a directory.
    mkdirSync(join(work, "dist/sandbox"), { recursive: true });
    execFileSync("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: work, stdio: ["ignore", "ignore", "inherit"] });
    const replacements = new Map();
    for (const [dir, entries] of Object.entries(SOURCES)) {
      const files = {};
      for (const [name, entry] of Object.entries(entries)) {
        const path = entry.from ?? entry.build.entry;
        if (path === "src/marketplace/repository-check.ts" && !git("ls-tree", "--name-only", commit, "--", path).length) continue;
        const bytes = entry.build
          ? execFileSync("bun", ["-e", readFileSync(new URL("./bundle-app-marketplace.mjs", import.meta.url), "utf8"), work, path], { cwd: work, maxBuffer: 64 * 1024 * 1024 })
          : git("show", `${commit}:${path}`);
        files[name] = entry;
        replacements.set(`${dir}/${name}`, bytes);
      }
      replacements.set(`${dir}/sources.json`, `${JSON.stringify({ repository: "ken-jo/ave", ref, files }, null, 2)}\n`);
    }
    for (const [path, bytes] of replacements) {
      mkdirSync(dirname(join(ROOT, path)), { recursive: true });
      writeFileSync(join(ROOT, path), bytes);
    }
    if (!replacements.has("tools/vendor/marketplace-check.js")) rmSync(join(ROOT, "tools/vendor/marketplace-check.js"), { force: true });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "check" && args.length === 0) {
      const problems = checkVendored();
      if (problems.length) throw new Error(problems.join("\n"));
      console.log("vendored files: OK");
    } else if (command === "sync" && args.length === 4 && args[0] === "--ref" && args[2] === "--app") {
      sync(args[1], resolve(args[3]));
    } else {
      throw new Error("usage: vendor.mjs check | sync --ref <40-hex commit or tag> --app <Ave checkout>");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
