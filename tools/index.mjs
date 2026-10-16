#!/usr/bin/env node
/**
 * Generate `marketplace.json` (design §6.4), the one catalog, at `schemaVersion: 2`.
 *
 * The index is the committed index plus what the descriptors say now:
 * - A version already in the index keeps its entry unchanged, including a
 *   hand-set `yanked` or `rollout`. Its package may not have changed since
 *   that version's commit. Every kept entry is held to its commit: the
 *   commit is in HEAD's history (pull requests merge with a merge commit),
 *   it changed the package, and the descriptor there generates the entry.
 * - A descriptor version not yet in the index gets an entry at the last
 *   commit that changed the package: for a plugin its descriptor, for any
 *   other kind its directory. It must exceed every version already listed.
 * - Package metadata (display name, description, icon) follows the
 *   descriptor.
 *
 *   node tools/index.mjs           write marketplace.json
 *   node tools/index.mjs --check   fail when the committed file differs
 *   node tools/index.mjs --pin-versions   also pin descriptor-resolved entries
 *
 * A non-plugin entry without `versions` is descriptor-resolved: the app reads
 * its descriptor at the fetched commit. The single-commit public import lists
 * every package that way, since no entry can name the commit that contains
 * it; --pin-versions, run after that commit exists, turns them into explicit
 * version pins. Plugins are always pinned to a released asset.
 * Commit a package change before generating: its entry records the commit
 * the app will read the package at, so an uncommitted package has none.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DESCRIPTOR,
  INDEX_PATH,
  KIND_DIRS,
  MUTABLE_VERSION_FIELDS,
  ROOT,
  agentPluginComponents,
  canonicalJson,
  compareVersions,
  contentPaths,
  git,
  isAncestor,
  isPrerelease,
  lastCommit,
  packageDirs,
  readJson,
  sameAt,
  uncommitted,
  WITHDRAWN_PATH,
  withdrawnPackages,
} from "./repo.mjs";

const KIND_ORDER = [...KIND_DIRS.values()];

function versionEntry(descriptor, at) {
  const entry = { version: descriptor.version, commit: at.commit, minAppVersion: descriptor.minAppVersion };
  if (descriptor.hostProtocol) entry.hostProtocol = descriptor.hostProtocol;
  if (descriptor.platforms) entry.platforms = descriptor.platforms;
  if (descriptor.kind === "plugin") {
    entry.authority = descriptor.payload.authority;
    entry.artifact = descriptor.payload.artifact;
  } else if (descriptor.kind === "agent-plugin") {
    entry.components = descriptor.payload.components;
  }
  entry.publishedAt = at.publishedAt;
  return entry;
}

function packageEntry(dir, descriptor, versions) {
  const entry = { kind: descriptor.kind, name: descriptor.name, path: dir };
  if (descriptor.displayName) entry.displayName = descriptor.displayName;
  if (descriptor.description) entry.description = descriptor.description;
  if (descriptor.icon) entry.icon = `${dir}/${descriptor.icon}`;
  if (versions === undefined) return entry;
  const latest = versions.find((v) => !v.yanked && !isPrerelease(v.version));
  if (latest) entry.latest = latest.version;
  entry.versions = versions;
  return entry;
}

/**
 * Why a kept entry is not what its own commit publishes. Without this, a
 * hand-edited entry (a lower version, another sha256, wider authority) would
 * pass every check while the app refuses the install.
 */
function keptEntryProblems(dir, kind, subject, version) {
  const at = `${subject}@${version.version}`;
  if (!isAncestor(version.commit)) {
    return [`${at}: ${version.commit} is not in this branch's history; merge pull requests with a merge commit`];
  }
  const paths = contentPaths(dir, kind);
  const published = lastCommit(paths, version.commit);
  if (published?.commit !== version.commit) return [`${at}: ${version.commit} did not change ${dir}; an entry names the commit that published it`];
  const descriptorPath = `${dir}/${DESCRIPTOR}`;
  let descriptor;
  try {
    descriptor = JSON.parse(git(["show", `${version.commit}:${descriptorPath}`], { stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return [`${at}: ${descriptorPath} does not parse at ${version.commit}`];
  }
  if (kind === "agent-plugin") {
    try {
      const components = agentPluginComponents(dir, descriptor, version.commit);
      if (canonicalJson(descriptor.payload?.components) !== canonicalJson(components)) {
        return [`${at}: ${descriptorPath} components differ from package files at ${version.commit}`];
      }
    } catch (error) {
      return [`${at}: ${dir}: ${error.message}`];
    }
  }
  const expected = versionEntry(descriptor, published);
  const fields = new Set([...Object.keys(expected), ...Object.keys(version)].filter((field) => !MUTABLE_VERSION_FIELDS.has(field)));
  const differs = [...fields].filter((field) => JSON.stringify(expected[field]) !== JSON.stringify(version[field]));
  return differs.length > 0 ? [`${at}: ${differs.join(", ")} ${differs.length === 1 ? "differs" : "differ"} from ${descriptorPath} at ${version.commit}`] : [];
}

/**
 * Whether only the descriptor changed since `from`, and only in form: the
 * schemaVersion 1 to 2 migration.
 */
function descriptorOnlyMigration(dir, kind, from) {
  const paths = contentPaths(dir, kind);
  const descriptorPath = `${dir}/${DESCRIPTOR}`;
  if (uncommitted(paths)) return false;
  const changed = git(["diff", "--name-only", from, "HEAD", "--", ...paths]).trim().split("\n").filter(Boolean);
  if (changed.some((path) => path !== descriptorPath)) return false;
  try {
    const old = JSON.parse(git(["show", `${from}:${descriptorPath}`], { stdio: ["ignore", "pipe", "ignore"] }));
    const now = readJson(descriptorPath);
    if (old.schemaVersion !== 1 || now.schemaVersion !== 2) return false;
    delete old.schemaVersion;
    delete now.schemaVersion;
    return canonicalJson(old) === canonicalJson(now);
  } catch {
    return false;
  }
}

/** The index the descriptors and `previous` imply, and why it could not be made. */
export function generateIndex(previous, { pinVersions = false } = {}) {
  const problems = [];
  const before = new Map(previous.packages.map((entry) => [`${entry.kind}/${entry.name}`, entry]));
  const found = new Set();
  const packages = [];
  for (const dir of packageDirs()) {
    const descriptor = readJson(`${dir}/${DESCRIPTOR}`);
    const subject = `${descriptor.kind}/${descriptor.name}`;
    found.add(subject);
    if (descriptor.kind === "agent-plugin") {
      try {
        const components = agentPluginComponents(dir, descriptor);
        if (canonicalJson(descriptor.payload?.components) !== canonicalJson(components)) {
          problems.push(`${subject}: ${dir}/${DESCRIPTOR} components differ from package files`);
        }
      } catch (error) {
        problems.push(`${subject}: ${dir}: ${error.message}`);
      }
    }
    const paths = contentPaths(dir, descriptor.kind);
    const prior = before.get(subject);
    // A descriptor-resolved entry (no versions) stays one until --pin-versions:
    // the app reads its descriptor at the fetched commit.
    if (prior && descriptor.kind !== "plugin" && prior.versions === undefined && !pinVersions) {
      packages.push(packageEntry(dir, descriptor));
      continue;
    }
    const versions = [...(prior?.versions ?? [])];
    for (const version of versions) problems.push(...keptEntryProblems(dir, descriptor.kind, subject, version));
    const listed = versions.find((v) => v.version === descriptor.version);
    if (listed) {
      if (uncommitted(paths) || (!sameAt(listed.commit, "HEAD", paths) && !descriptorOnlyMigration(dir, descriptor.kind, listed.commit))) {
        problems.push(`${subject}: ${dir} changed after ${descriptor.version} was published at ${listed.commit}; raise the version`);
      }
    } else {
      const newer = versions.filter((v) => compareVersions(v.version, descriptor.version) >= 0).map((v) => v.version);
      if (newer.length > 0) problems.push(`${subject}: ${descriptor.version} must exceed every listed version (${newer.join(", ")})`);
      const at = uncommitted(paths) ? null : lastCommit(paths);
      if (!at) problems.push(`${subject}: commit ${dir} before generating the index`);
      else versions.push(versionEntry(descriptor, at));
    }
    versions.sort((a, b) => compareVersions(b.version, a.version));
    packages.push(packageEntry(dir, descriptor, versions));
  }
  const withdrawn = withdrawnPackages();
  for (const subject of withdrawn) {
    if (found.has(subject)) problems.push(`${subject}: withdrawn in ${WITHDRAWN_PATH} but its package is still here`);
  }
  for (const [subject, entry] of before) {
    // A withdrawn package leaves the index with every version it had.
    if (!found.has(subject) && (entry.versions?.length ?? 0) > 0 && !withdrawn.has(subject)) {
      problems.push(`${subject}: published package is missing; withdraw it in ${WITHDRAWN_PATH}`);
    }
  }
  packages.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name));
  const { packages: _previousPackages, ...root } = previous;
  return { index: { ...root, schemaVersion: 2, packages }, problems };
}

export function serialize(index) {
  return `${JSON.stringify(index, null, 2)}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const committed = readFileSync(join(ROOT, INDEX_PATH), "utf8");
  const { index, problems } = generateIndex(JSON.parse(committed), { pinVersions: process.argv.includes("--pin-versions") });
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exit(1);
  const text = serialize(index);
  if (process.argv.includes("--check")) {
    if (text !== committed) {
      console.error(`${INDEX_PATH} is not what the descriptors generate; run \`bun run index\` and commit the result`);
      process.exit(1);
    }
  } else {
    writeFileSync(join(ROOT, INDEX_PATH), text);
  }
}
