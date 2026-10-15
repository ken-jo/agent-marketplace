#!/usr/bin/env node
/**
 * Vendored copies of ave files (design §5.6).
 *
 * `contract/` and `tools/vendor/` hold ave files at one ref. Each
 * directory's `sources.json` records the repository, the ref and every file's
 * sha256. A file is either a copy (`from`: its path in ave) or a bundle
 * (`build`: an ave entry built with the recorded bun version and the
 * checked-in recipe, which is byte-reproducible). The copies have no authority of
 * their own: a change belongs in ave, and reaches this repository by
 * syncing a new ref.
 *
 *   node tools/vendor.mjs check                      offline: source pins agree and bytes match sources.json
 *   node tools/vendor.mjs verify [--app <checkout>] [--release-tag <tag>]
 *       the ref still produces these bytes; --release-tag requires a matching
 *       annotated app tag and reads every file from its peeled commit
 *   node tools/vendor.mjs sync <dir> --ref <ref> --app <checkout>
 *
 * `verify` reads copies from a local checkout when `--app` is given, else
 * from the GitHub contents API (with GH_TOKEN or GITHUB_TOKEN when set).
 * Bundles are rebuilt, so they need `--app`: a checkout whose HEAD is the
 * ref, with its dependencies installed.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ROOT = resolve(process.env.MARKETPLACE_ROOT ?? SCRIPT_ROOT);
export const VENDORED_DIRS = ["contract", "tools/vendor"];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A bundle must not expose or depend on the checkout used to build it. */
export function embeddedBuildPaths(bytes) {
  const source = bytes.toString();
  const paths = [];
  if (/\/(?:private|Users|home|tmp|var|workspace|workspaces|root|opt|mnt|builds|repo)\//u.test(source)) paths.push("Unix checkout path");
  if (/(?:^|[\s"'`(=])[A-Za-z]:[\\/]/mu.test(source)) paths.push("Windows drive path");
  return paths;
}

function readSources(dir) {
  const path = join(ROOT, dir, "sources.json");
  if (!existsSync(path)) throw new Error(`${dir}/sources.json is missing`);
  const sources = JSON.parse(readFileSync(path, "utf8"));
  if (typeof sources.repository !== "string" || typeof sources.ref !== "string" || typeof sources.files !== "object") {
    throw new Error(`${dir}/sources.json needs repository, ref and files`);
  }
  return sources;
}

/** Read all inventories together so every check uses one upstream pin. */
function readVendoredSources() {
  const sources = VENDORED_DIRS.map((dir) => [dir, readSources(dir)]);
  for (const field of ["repository", "ref"]) {
    if (new Set(sources.map(([, source]) => source[field])).size > 1) {
      const values = sources.map(([dir, source]) => `${dir}/sources.json ${field}=${JSON.stringify(source[field])}`);
      throw new Error(`vendored sources disagree on ${field}: ${values.join(", ")}`);
    }
  }
  return sources;
}

/** Problems with the committed copies, offline. */
export function checkVendored() {
  const problems = [];
  for (const [dir, sources] of readVendoredSources()) {
    for (const [name, entry] of Object.entries(sources.files)) {
      const path = join(ROOT, dir, name);
      if (!existsSync(path)) {
        problems.push(`${dir}/${name}: missing`);
        continue;
      }
      const bytes = readFileSync(path);
      if (sha256(bytes) !== entry.sha256) {
        problems.push(`${dir}/${name}: bytes differ from sources.json; the copy was edited (sync a new ref instead)`);
      }
      if (entry.build) for (const kind of embeddedBuildPaths(bytes)) problems.push(`${dir}/${name}: embedded absolute build path (${kind})`);
    }
  }
  return problems;
}

async function fetchAtRef(sources, from, app, ref = sources.ref) {
  if (app) {
    return execFileSync("git", ["-C", app, "show", `${ref}:${from}`], { maxBuffer: 64 * 1024 * 1024 });
  }
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const url = `https://api.github.com/repos/${sources.repository}/contents/${from}?ref=${encodeURIComponent(sources.ref)}`;
  const response = await fetch(url, {
    headers: { Accept: "application/vnd.github.raw", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!response.ok) throw new Error(`${sources.repository}@${sources.ref}:${from}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Build `entry.build.entry` from the checkout `app`, which must be at `ref` and clean. */
function buildAtRef(sources, entry, app, ref = sources.ref) {
  if (!app) throw new Error(`rebuilding ${entry.build.entry} needs --app <ave checkout at ${sources.ref}>`);
  if (entry.build.logger !== "stub-app-logger") throw new Error(`unsupported checker bundle logger recipe: ${entry.build.logger}`);
  const head = execFileSync("git", ["-C", app, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const commit = execFileSync("git", ["-C", app, "rev-parse", `${ref}^{commit}`], { encoding: "utf8" }).trim();
  if (head !== commit) throw new Error(`${app} is at ${head}, not ${sources.ref} (${commit})`);
  if (execFileSync("git", ["-C", app, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim() !== "") {
    throw new Error(`${app} has uncommitted changes`);
  }
  const bun = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
  if (bun !== entry.build.bun) throw new Error(`the bundle is built with bun ${entry.build.bun}; this is bun ${bun}`);
  // Evaluate from the app checkout so Bun's source labels are relative to it,
  // regardless of the marketplace checkout's own directory.
  const recipe = readFileSync(join(SCRIPT_ROOT, "tools/bundle-app-marketplace.mjs"), "utf8");
  return execFileSync("bun", ["-e", recipe, app, entry.build.entry], {
    cwd: app, maxBuffer: 64 * 1024 * 1024,
  });
}

/** A publication reads a protected annotated tag, never a same-named branch. */
function releaseCommit(app, tag) {
  if (process.env.MARKETPLACE_ROOT !== undefined) throw new Error("release-tag verification requires this checked-out marketplace; MARKETPLACE_ROOT is for tests only");
  if (!app) throw new Error("release-tag verification needs --app <checkout>");
  const ref = `refs/tags/${tag}`;
  try {
    execFileSync("git", ["-C", app, "show-ref", "--verify", "--quiet", ref]);
  } catch {
    throw new Error(`${app}: ${ref} is missing; a same-named branch is not a release tag`);
  }
  const type = execFileSync("git", ["-C", app, "cat-file", "-t", ref], { encoding: "utf8" }).trim();
  const object = execFileSync("git", ["-C", app, "cat-file", "-p", ref], { encoding: "utf8" });
  const header = object.split("\n\n", 1)[0];
  if (type !== "tag" || !/^type commit$/mu.test(header)) throw new Error(`${app}: ${ref} must be an annotated tag pointing directly to a commit`);
  const commit = execFileSync("git", ["-C", app, "rev-parse", "--verify", `${ref}^{commit}`], { encoding: "utf8" }).trim();
  const head = execFileSync("git", ["-C", app, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== commit) throw new Error(`${app}: checkout HEAD ${head} differs from ${ref} commit ${commit}`);
  return commit;
}

async function verify(app, releaseTag) {
  const inventories = readVendoredSources();
  const problems = [];
  const taggedCommit = releaseTag ? releaseCommit(app, releaseTag) : undefined;
  for (const [dir, sources] of inventories) {
    if (releaseTag && sources.ref !== releaseTag) {
      problems.push(`${dir}/sources.json: expected ${releaseTag}, not ${sources.ref}`);
      continue;
    }
    for (const [name, entry] of Object.entries(sources.files)) {
      const bytes = entry.build ? buildAtRef(sources, entry, app, taggedCommit) : await fetchAtRef(sources, entry.from, app, taggedCommit);
      if (entry.build) for (const kind of embeddedBuildPaths(bytes)) problems.push(`${dir}/${name}: embedded absolute build path (${kind})`);
      if (sha256(bytes) !== entry.sha256) {
        problems.push(`${dir}/${name}: ${sources.repository}@${sources.ref}:${entry.from ?? entry.build.entry} does not produce the recorded bytes`);
      }
    }
  }
  return problems;
}

function sync(dir, ref, app) {
  if (!app) throw new Error("sync needs --app <ave checkout>");
  const sources = readSources(dir);
  sources.ref = ref;
  for (const [name, entry] of Object.entries(sources.files)) {
    const bytes = entry.build
      ? buildAtRef(sources, entry, app)
      : execFileSync("git", ["-C", app, "show", `${ref}:${entry.from}`], { maxBuffer: 64 * 1024 * 1024 });
    if (entry.build && embeddedBuildPaths(bytes).length > 0) throw new Error(`${dir}/${name}: embedded absolute build path`);
    writeFileSync(join(ROOT, dir, name), bytes);
    entry.sha256 = sha256(bytes);
  }
  writeFileSync(join(ROOT, dir, "sources.json"), `${JSON.stringify(sources, null, 2)}\n`);
}

function option(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const app = option(args, "--app");
  const releaseTag = option(args, "--release-tag");
  let problems = [];
  if (command === "check") problems = checkVendored();
  else if (command === "verify") problems = await verify(app, releaseTag);
  else if (command === "sync") sync(args[0], option(args, "--ref"), app);
  else {
    console.error("usage: vendor.mjs check | verify [--app <checkout>] [--release-tag <tag>] | sync <dir> --ref <ref> --app <checkout>");
    process.exit(2);
  }
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exit(1);
}
