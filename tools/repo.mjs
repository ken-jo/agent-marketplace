/**
 * Shared reading of this repository for the tools: tracked files, package
 * directories, descriptors, git history and version order.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveAgentPluginComponents } from "./vendor/agent-plugin-components.js";

/** The repository the tools read; MARKETPLACE_ROOT points them at another checkout (the tools' tests use it). */
export const ROOT = resolve(process.env.MARKETPLACE_ROOT ?? fileURLToPath(new URL("..", import.meta.url)));
/** This repository on GitHub: where official plugin releases live. */
export const REPOSITORY = "ken-jo/agent-marketplace";
/** The one catalog file; its format is the `schemaVersion` inside it. */
export const INDEX_PATH = "marketplace.json";
/**
 * Where the format-2 catalog lived before it moved to INDEX_PATH. Read only
 * from a base commit (baseIndexes); remove once no compared base predates the move.
 */
const RETIRED_INDEX_PATH = "marketplace.2.json";
export const DESCRIPTOR = "ave-package.json";
/**
 * The descriptor's name before Ave, at every commit up to the rename. Read
 * only from history (descriptorPathAt), where versions published under it
 * stay listed; never from the working tree. Remove once no listed version's
 * commit predates the rename.
 */
export const LEGACY_DESCRIPTOR = "retiredname-package.json";
/** Packages deliberately taken out of the catalog, published versions included, and why. */
export const WITHDRAWN_PATH = "tools/withdrawn.json";
export const RETIREDNAME = "xyz.retiredname-namespace";
/** First stable app release with the full alerts contract. */
export const ALERTS_RELEASE_VERSION = "0.11.0";
/** The manifest fields a descriptor copies as the plugin's authority (design §5.2). */
export const AUTHORITY_FIELDS = ["capabilities", "networkAccess", "hostSecrets", "pluginAccess", "auth", "requires", "dependencies", "sandbox"];

/** Top-level package directories and the kind each holds (design §3.1, §3.3). */
export const KIND_DIRS = new Map([
  ["plugins", "plugin"],
  ["agent-plugins", "agent-plugin"],
  ["mcp", "mcp"],
  ["skills", "skill"],
  ["agents", "agent"],
  ["themes", "theme"],
  ["fonts", "font"],
  ["languages", "language"],
  ["providers", "provider"],
  ["messaging", "messaging-connection"],
]);

export function git(args, options = {}) {
  return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options });
}

/**
 * Every catalog `base` holds, parsed. A base from before the move holds the
 * format-2 catalog at RETIRED_INDEX_PATH beside the frozen format-1 one at
 * INDEX_PATH, whose versions are unchanged copies of format-2 entries; every
 * version either lists is published, so callers read them all. A base with
 * no catalog yields none.
 */
export function baseIndexes(base) {
  return [INDEX_PATH, RETIRED_INDEX_PATH]
    // Asked before `git show`, which answers a missing path with "fatal: ..." on stderr.
    .filter((path) => git(["ls-tree", "--name-only", base, "--", path]).trim() !== "")
    .map((path) => ({ path, index: JSON.parse(git(["show", `${base}:${path}`])) }));
}

/** Every tracked file, repository-relative with `/` separators. */
export function trackedFiles() {
  return git(["ls-files", "-z"]).split("\0").filter(Boolean).sort();
}

/**
 * The tree the app would read: tracked files, with the bytes on disk. On CI
 * the checkout is the commit under test, so the two are the same.
 */
export function workingTree() {
  const files = trackedFiles().filter((path) => existsSync(join(ROOT, path)));
  const set = new Set(files);
  return {
    read: (path) => (set.has(path) ? readFileSync(join(ROOT, path)) : null),
    list: (dir) => (dir === "" ? files : files.filter((path) => path.startsWith(`${dir}/`))),
  };
}

/** `plugins/alpha` for every `<kind dir>/<name>/ave-package.json`, one level deep. */
export function packageDirs() {
  return trackedFiles()
    .map((path) => path.split("/"))
    .filter((parts) => parts.length === 3 && parts[2] === DESCRIPTOR && KIND_DIRS.has(parts[0]))
    .map((parts) => `${parts[0]}/${parts[1]}`);
}

export function readJson(path) {
  return JSON.parse(readFileSync(join(ROOT, path), "utf8"));
}

/**
 * `kind/name` of every package withdrawn from the catalog. A withdrawn
 * package leaves the index with all its versions; any other published
 * package that disappears is an error.
 */
export function withdrawnPackages() {
  // A repository without the file has withdrawn nothing.
  if (!existsSync(join(ROOT, WITHDRAWN_PATH))) return new Set();
  const { withdrawn } = readJson(WITHDRAWN_PATH);
  return new Set(withdrawn.map((entry) => {
    if (![entry.kind, entry.name, entry.reason].every((field) => typeof field === "string" && field !== "")) {
      throw new Error(`${WITHDRAWN_PATH}: every entry needs kind, name and reason`);
    }
    return `${entry.kind}/${entry.name}`;
  }));
}

/** The descriptor `dir` holds at `rev`, under the name it carried then; undefined when it holds none. */
export function descriptorPathAt(dir, rev) {
  const names = [`${dir}/${DESCRIPTOR}`, `${dir}/${LEGACY_DESCRIPTOR}`];
  const present = git(["ls-tree", "--name-only", rev, "--", ...names]).split("\n").filter(Boolean);
  return names.find((name) => present.includes(name));
}

/**
 * The paths whose content a version of this package is: a plugin's is its
 * descriptor, since its code ships as a release asset. Both descriptor names,
 * so history before the rename is found.
 */
export function contentPaths(dir, kind) {
  return kind === "plugin" ? [`${dir}/${DESCRIPTOR}`, `${dir}/${LEGACY_DESCRIPTOR}`] : [dir];
}

/** Derive Agent Plugins component authority from exactly the package files at a tree or commit. */
export function agentPluginComponents(dir, descriptor, rev) {
  const prefix = `${dir}/`;
  const paths = rev === undefined
    ? trackedFiles().filter((path) => path.startsWith(prefix) && existsSync(join(ROOT, path)))
    : git(["ls-tree", "-r", "--name-only", rev, "--", dir]).split("\n").filter(Boolean);
  const descriptors = new Set([`${dir}/${DESCRIPTOR}`, `${dir}/${LEGACY_DESCRIPTOR}`]);
  const files = paths.filter((path) => !descriptors.has(path)).map((path) => ({
    path: path.slice(prefix.length),
    data: rev === undefined ? readFileSync(join(ROOT, path)) : Buffer.from(git(["show", `${rev}:${path}`], { encoding: "buffer" })),
  }));
  return deriveAgentPluginComponents(files, {
    name: descriptor.name,
    version: descriptor.version,
    minAppVersion: descriptor.minAppVersion,
  });
}

/** Whether the working tree differs from HEAD, or has untracked files, under any of `paths`. */
export function uncommitted(paths) {
  return git(["status", "--porcelain", "--", ...paths]).trim() !== "";
}

/** JSON with object keys sorted at every depth, so equal values compare equal. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Version fields an index entry may change after publication (design §4.3). */
export const MUTABLE_VERSION_FIELDS = new Set(["yanked", "rollout"]);

/** The last commit up to `rev` that changed any of `paths`, and its committer time in UTC. */
export function lastCommit(paths, rev = "HEAD") {
  const out = git(["log", "-1", "--format=%H %ct", rev, "--", ...paths]).trim();
  if (!out) return null;
  const [commit, seconds] = out.split(" ");
  return { commit, publishedAt: new Date(Number(seconds) * 1000).toISOString().replace(/\.\d{3}Z$/u, "Z") };
}

/** Whether `commit` exists and is in the history of `rev`. */
export function isAncestor(commit, rev = "HEAD") {
  try {
    git(["merge-base", "--is-ancestor", commit, rev], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Whether `rev` names a commit this clone has. */
export function hasCommit(rev) {
  try {
    git(["cat-file", "-e", `${rev}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Whether `paths` are byte-identical at `a` and `b`. */
export function sameAt(a, b, paths) {
  try {
    git(["diff", "--quiet", a, b, "--", ...paths]);
    return true;
  } catch {
    return false;
  }
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;

/** Semver 2.0.0 precedence; throws on a string that is not a version. */
export function compareVersions(a, b) {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) throw new Error(`not a semantic version: ${pa ? b : a}`);
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return Math.sign(d);
  }
  if (!pa[4] && !pb[4]) return 0;
  if (!pa[4]) return 1;
  if (!pb[4]) return -1;
  const xa = pa[4].split(".");
  const xb = pb[4].split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i += 1) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^\d+$/u.test(xa[i]);
    const nb = /^\d+$/u.test(xb[i]);
    if (na && nb && Number(xa[i]) !== Number(xb[i])) return Math.sign(Number(xa[i]) - Number(xb[i]));
    if (na !== nb) return na ? -1 : 1;
    if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

export function isPrerelease(version) {
  return SEMVER.exec(version)?.[4] !== undefined;
}

/**
 * The host protocol an app line serves, newest first: 0.12.x and 0.13.x serve
 * protocol 2, Ave 0.14.0 and later serve protocol 3 only (the app's
 * `HOST_PROTOCOL_FIRST_APP_VERSION`). A plugin's `minAppVersion` picks the one
 * protocol it must declare; below 0.12.0 there was none.
 */
export const HOST_PROTOCOL_FLOORS = Object.freeze([["0.14.0", "3"], ["0.12.0", "2"]]);

export function requiredHostProtocol(minAppVersion) {
  if (typeof minAppVersion !== "string") return undefined;
  return HOST_PROTOCOL_FLOORS.find(([floor]) => compareVersions(minAppVersion, floor) >= 0)?.[1];
}

/**
 * The authority a descriptor pins for a plugin manifest: its authority fields
 * as written. Returns the problems instead when the manifest cannot be
 * pinned; the app requires `capabilities` and `requires.minAppVersion`.
 */
export function pluginAuthority(manifest) {
  const retiredname = manifest?.extensions?.[RETIREDNAME];
  if (!retiredname || typeof retiredname !== "object") return { problems: [`extensions["${RETIREDNAME}"] is missing`] };
  const problems = [];
  if (!Array.isArray(retiredname.capabilities)) problems.push("capabilities must be declared, [] when the plugin needs none");
  if (typeof retiredname.requires?.minAppVersion !== "string") problems.push("requires.minAppVersion must be declared");
  else {
    const required = requiredHostProtocol(retiredname.requires.minAppVersion);
    if (required && retiredname.requires.hostProtocol !== required) {
      problems.push(`requires.hostProtocol must be ${required} for minAppVersion ${retiredname.requires.minAppVersion}`);
    }
  }
  const authority = {};
  for (const field of AUTHORITY_FIELDS) if (retiredname[field] !== undefined) authority[field] = retiredname[field];
  return problems.length > 0 ? { problems } : { authority, minAppVersion: retiredname.requires.minAppVersion, hostProtocol: retiredname.requires.hostProtocol };
}
