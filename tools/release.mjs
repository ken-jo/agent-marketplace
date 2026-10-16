#!/usr/bin/env node
/**
 * Official plugin releases (design §6.3).
 *
 *   node tools/release.mjs plan [--publish]
 *       JSON list of plugins whose source version has no <name>-v<version>
 *       tag yet. --publish requires the contract, checker and protocol schema
 *       to pin an Ave release tag (never a commit) before the workflow builds
 *       any release; `vendor.mjs verify` holds their bytes to its signed bundle.
 *   node tools/release.mjs pack <name> <out.zip>
 *       Zip a built plugin: plugin.json and the paths its package.json
 *       `files` lists, never node_modules, source maps or credential files.
 *   node tools/release.mjs build <name> <out.zip> --publish
 *       Verify a signed tag and retain trusted modules while installing,
 *       typechecking, building and testing, then pack in the same process.
 *   node tools/release.mjs pin <name> <zip>
 *       Point the descriptor at a released zip: version, minAppVersion,
 *       authority and display fields from the zip's plugin.json, and the
 *       release pin (this repository, the tag, the asset, its sha256).
 *   node tools/release.mjs verify [--base <ref>] [--publish]
 *       Download the release of every plugin version the index lists and
 *       <ref> did not (all of them without --base), check its sha256, hold
 *       its plugin.json to the committed source at the release tag and to
 *       that index version, then run the repository check. The check also
 *       needs the released plugin.json of each plugin's current version at
 *       or above the alerts release, so those are downloaded and re-hashed
 *       too, new or not.
 *
 * Packing reads only what the build wrote; it never runs plugin code. The
 * workflow builds in a job with read-only permissions and publishes from
 * another that never executes the candidate. The build job runs plugin
 * code, so nothing it hands over is trusted: `verify` holds the released
 * plugin.json to the source committed at the tag, which the build cannot
 * change, so a build that widens the manifest fails the pin pull request.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRepository, releasedManifestsNeeded } from "./check.mjs";
import { checkVendored, isCommitPin, isReleaseTag } from "./vendor.mjs";
import { runPluginChecks, verifiedRuntime } from "./verified-import.mjs";
import { AVE_EXTENSION, DESCRIPTOR, INDEX_PATH, REPOSITORY, ROOT, baseIndexes, canonicalJson, git, hasCommit, isAncestor, pluginAuthority, readJson } from "./repo.mjs";

const TRUSTED_RUNTIME = await verifiedRuntime();

const GLOB = /[*?[\]]/u;
const SENSITIVE = [
  /(^|\/)\.env($|\.|\/)/u,
  /(^|\/)id_rsa($|\.)/u,
  /(^|\/)\.git\//u,
  /(^|\/)\.github\//u,
  /(^|\/)\.npmrc$/u,
  /(^|\/)\.netrc$/u,
  /(^|\/)secrets($|\.|\/)/iu,
  /\.pem$/u,
  /\.key$/u,
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** The host protocol the vendored contract must describe; the release tag itself is `ref` in sources.json. */
const HOST_PROTOCOL = 3;
const PROTOCOL_SCHEMA_SOURCE = `schemas/plugin-host-protocol/${HOST_PROTOCOL}/protocol.schema.json`;
const protocolSchemaId = (tag) => `https://ave.agent-connector.ai/schemas/plugin-host-protocol/${HOST_PROTOCOL}/${tag}/protocol.schema.json`;
const PROTOCOL_SCHEMA_TITLE = `Ave plugin host protocol ${HOST_PROTOCOL}`;

/**
 * Publication metadata prerequisites. The runtime loader also holds every
 * executed vendored byte to the signed bundle, before any module evaluation.
 */
export function publicationProblems() {
  if (process.env.MARKETPLACE_ROOT !== undefined) {
    return ["publication requires this checked-out marketplace; MARKETPLACE_ROOT is for tests only"];
  }
  const problems = [];
  const contract = readJson("contract/sources.json");
  const checker = readJson("tools/vendor/sources.json");
  for (const [path, sources] of [["contract/sources.json", contract], ["tools/vendor/sources.json", checker]]) {
    if (!isReleaseTag(sources.ref)) {
      const kind = isCommitPin(sources.ref) ? "a development commit pin, which has no contract bundle" : "not an Ave release tag";
      problems.push(`${path}: publication requires an Ave release tag with a signed contract bundle; ${sources.ref} is ${kind}`);
    }
  }
  const tag = contract.ref;
  const source = contract.files?.["protocol.schema.json"];
  const manifestSchema = readJson("contract/plugin-manifest.schema.json");
  const extension = manifestSchema.properties?.extensions?.properties?.[AVE_EXTENSION];
  if (!Object.hasOwn(extension?.properties?.requires?.properties ?? {}, "hostProtocol")) {
    problems.push("contract/plugin-manifest.schema.json: publication requires requires.hostProtocol in the vendored manifest schema");
  }
  if (!Object.hasOwn(extension?.properties ?? {}, "sandbox")) {
    problems.push("contract/plugin-manifest.schema.json: publication requires sandbox in the vendored manifest schema");
  }
  if (source?.from !== PROTOCOL_SCHEMA_SOURCE || typeof source.sha256 !== "string") {
    problems.push(`contract/sources.json: publication requires ${PROTOCOL_SCHEMA_SOURCE} with its sha256`);
  } else {
    const path = join(ROOT, "contract", "protocol.schema.json");
    if (!existsSync(path)) problems.push("contract/protocol.schema.json: missing");
    else {
      const bytes = readFileSync(path);
      if (sha256(bytes) !== source.sha256) problems.push("contract/protocol.schema.json: bytes differ from sources.json");
      try {
        const schema = JSON.parse(bytes.toString("utf8"));
        if (schema.$id !== protocolSchemaId(tag) || schema.title !== PROTOCOL_SCHEMA_TITLE) {
          problems.push(`contract/protocol.schema.json: expected the protocol ${HOST_PROTOCOL} schema for ${tag} ($id ${protocolSchemaId(tag)}, title "${PROTOCOL_SCHEMA_TITLE}"), not ${JSON.stringify(schema.$id)}`);
        }
      } catch {
        problems.push("contract/protocol.schema.json: invalid JSON");
      }
    }
  }
  problems.push(...checkVendored());
  return problems;
}

function requirePublicationReady() {
  const problems = publicationProblems();
  if (!TRUSTED_RUNTIME.signed) problems.push("publication requires the runtime to have loaded a signed release bundle");
  if (problems.length > 0) throw new Error(problems.join("\n"));
  TRUSTED_RUNTIME.assertUnchanged();
}
export const tagOf = (name, version) => `${name}-v${version}`;
export const assetOf = (name, version) => `${name}-${version}.zip`;

function sourceDir(name) {
  const dir = join(ROOT, "plugins", name, "source");
  if (!existsSync(join(dir, "plugin.json"))) throw new Error(`plugins/${name}/source/plugin.json is missing`);
  return dir;
}

function pluginNames() {
  return git(["ls-files", "plugins/*/source/plugin.json"])
    .split("\n")
    .filter(Boolean)
    .map((path) => path.split("/")[1])
    .sort();
}

export function plan() {
  const tags = new Set(git(["tag", "--list"]).split("\n").filter(Boolean));
  return pluginNames()
    .map((name) => ({ name, version: JSON.parse(readFileSync(join(sourceDir(name), "plugin.json"), "utf8")).version }))
    .filter(({ name, version }) => !tags.has(tagOf(name, version)))
    .map(({ name, version }) => ({ name, version, tag: tagOf(name, version), asset: assetOf(name, version) }));
}

/** The paths to zip, relative to the plugin directory. Throws on anything that must not ship. */
export function shippable(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const entries = new Set(Array.isArray(pkg.files) ? pkg.files : []);
  entries.add("plugin.json");
  const root = realpathSync(dir);
  const problems = [];
  const present = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || entry === "") problems.push(`files[] entry ${JSON.stringify(entry)} is not a path`);
    else if (entry.split(/[/\\]/u).includes("..") || isAbsolute(entry)) problems.push(`${entry} escapes the plugin directory`);
    else if (GLOB.test(entry)) problems.push(`${entry}: files[] takes paths, not globs`);
    else if (SENSITIVE.some((re) => re.test(entry))) problems.push(`${entry} matches a credential file pattern`);
    else if (!existsSync(join(dir, entry))) problems.push(`${entry} is declared but missing; build first`);
    else {
      const real = realpathSync(join(dir, entry));
      if (real !== root && !real.startsWith(root + sep)) problems.push(`${entry} resolves outside the plugin directory`);
      else present.push(entry);
    }
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return present.sort();
}

export function pack(name, out) {
  const dir = sourceDir(name);
  const manifest = `plugins/${name}/source/plugin.json`;
  if (git(["status", "--porcelain", "--", manifest]).trim() !== "") {
    throw new Error(`${manifest} differs from the commit; a build step changed it, and the release must carry the committed manifest`);
  }
  const list = shippable(dir);
  rmSync(out, { force: true });
  execFileSync(
    "zip",
    ["-q", "-r", "-X", "--symlinks", out, "-@", "-x", "*.map", "node_modules/*", "*/node_modules/*", "*.env*", "*.pem", "*.key", "id_rsa*", ".git/*", ".github/*", "*.npmrc", "*.netrc", "secrets*"],
    { cwd: dir, input: `${list.join("\n")}\n` },
  );
  for (const path of execFileSync("unzip", ["-Z1", out], { encoding: "utf8" }).split("\n").filter(Boolean)) {
    if (lstatSync(join(dir, path)).isSymbolicLink()) throw new Error(`${path} is a symbolic link; the app refuses links in a plugin`);
  }
  return sha256(readFileSync(out));
}

/** Verify and load trusted tools once, then retain them across plugin scripts. */
export async function build(name, out, { execute } = {}) {
  requirePublicationReady();
  const trusted = await verifiedRuntime({ allowDevelopment: false });
  if (!trusted.signed) throw new Error("publication requires a signed release bundle");
  await runPluginChecks(`plugins/${name}/source`, { execute });
  // Neither a rewritten release/checker module nor a changed development
  // inventory can affect this resident process. Refuse even unused changes.
  trusted.assertUnchanged();
  requirePublicationReady();
  return pack(name, out);
}

function manifestIn(zip) {
  return JSON.parse(execFileSync("unzip", ["-p", zip, "plugin.json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
}

export function pin(name, zip) {
  requirePublicationReady();
  const manifest = manifestIn(zip);
  if (manifest.name !== name) throw new Error(`${zip} does not hold plugin ${name}`);
  const { authority, minAppVersion, hostProtocol, problems } = pluginAuthority(manifest);
  if (problems) throw new Error(`${name}: ${problems.join("; ")}`);
  const ave = manifest.extensions[AVE_EXTENSION];
  const path = join("plugins", name, DESCRIPTOR);
  const previous = existsSync(join(ROOT, path)) ? readJson(path) : {};
  const descriptor = {
    schemaVersion: 2,
    kind: "plugin",
    name,
    version: manifest.version,
    minAppVersion,
    ...(hostProtocol ? { hostProtocol } : {}),
    ...(ave.displayName ? { displayName: ave.displayName } : {}),
    ...(typeof manifest.description === "string" ? { description: manifest.description.slice(0, 1000) } : {}),
    ...(previous.author ? { author: previous.author } : {}),
    ...(previous.license ? { license: previous.license } : {}),
    ...(previous.homepage ? { homepage: previous.homepage } : {}),
    ...(previous.icon ? { icon: previous.icon } : {}),
    ...(previous.platforms ? { platforms: previous.platforms } : {}),
    payload: {
      authority,
      artifact: {
        release: {
          repo: REPOSITORY,
          tag: tagOf(name, manifest.version),
          asset: assetOf(name, manifest.version),
          sha256: sha256(readFileSync(zip)),
        },
      },
    },
  };
  writeFileSync(join(ROOT, path), `${JSON.stringify(descriptor, null, 2)}\n`);
  return descriptor;
}

/**
 * How the released manifest of `name@version` differs from the source
 * committed where `tag` points. The tag is the commit the release was built
 * from, and it has to be in HEAD's history: a release built from another
 * branch is not this repository's.
 */
export function sourceMismatches(name, version, tag, manifest) {
  let commit;
  try {
    commit = git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]).trim();
  } catch {
    return [`the tag ${tag} is not in this clone`];
  }
  if (!isAncestor(commit)) return [`${tag} points at ${commit}, which is not in this branch's history`];
  let source;
  try {
    source = JSON.parse(git(["show", `${commit}:plugins/${name}/source/plugin.json`], { stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return [`${tag} has no plugins/${name}/source/plugin.json`];
  }
  const problems = [];
  if (source.name !== name || source.version !== version) problems.push(`the source at ${tag} is ${source.name}@${source.version}`);
  const released = pluginAuthority(manifest);
  const committed = pluginAuthority(source);
  if (released.problems || committed.problems) return [...problems, ...(released.problems ?? []), ...(committed.problems ?? [])];
  if (canonicalJson(released) !== canonicalJson(committed)) problems.push(`its authority or minAppVersion differs from the source committed at ${tag}`);
  return problems;
}

/** Every plugin version the index lists now and did not list at `base` (every one without a base). */
export function newPluginVersions(base) {
  let before = new Set();
  if (base) {
    // A base this clone lacks is an error, not "no index yet": reading it as
    // the latter would hold every version as new and hide the missing base.
    if (!hasCommit(base)) throw new Error(`base ${base} is not a commit in this clone`);
    // A base with no catalog yet lists nothing: everything is new.
    before = new Set(baseIndexes(base).flatMap(({ index }) =>
      index.packages.filter((p) => p.kind === "plugin").flatMap((p) => p.versions.map((v) => `${p.name}@${v.version}`))));
  }
  return readJson(INDEX_PATH)
    .packages.filter((p) => p.kind === "plugin")
    .flatMap((p) => p.versions.map((v) => ({ name: p.name, version: v.version, release: v.artifact.release })))
    .filter((v) => !before.has(`${v.name}@${v.version}`));
}

/** Put `release`'s asset at `<dir>/<asset>`. */
function ghReleaseDownload(release, dir) {
  execFileSync("gh", ["release", "download", release.tag, "--repo", release.repo, "--pattern", release.asset, "--dir", dir], { stdio: ["ignore", "inherit", "pipe"] });
}

/**
 * Waits between download attempts. verify now downloads the current releases
 * on every pull request, so a brief GitHub release-download outage would fail
 * unrelated pull requests without a retry; three attempts over about seven
 * seconds ride out a blip and still fail fast on a real outage.
 */
const RETRY_DELAYS_MS = [2_000, 5_000];

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** `download` with bounded retries; the last error, naming the asset, if every attempt fails. */
function downloadWithRetry(download, release, dir, delays) {
  let lastError;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    if (attempt > 0) sleepSync(delays[attempt - 1]);
    // A partial file from a failed attempt must not be taken for the asset.
    rmSync(dir, { recursive: true, force: true });
    try {
      download(release, dir);
      return null;
    } catch (error) {
      const stderr = error?.stderr ? String(error.stderr).trim() : "";
      lastError = stderr || (error instanceof Error ? error.message : String(error));
    }
  }
  return `could not download ${release.repo} ${release.tag}/${release.asset} after ${delays.length + 1} attempts: ${lastError}`;
}

/**
 * The released plugin.json files the repository check is handed: every
 * version new against `base`, held to the source at its tag as well, and the
 * current version of every plugin whose plugin.json the check can read only
 * from its release asset. The second set is not optional: a pull request that
 * adds no version still has to supply them, or the check refuses it.
 */
export function verify(base, { publish = false, download = ghReleaseDownload, retryDelaysMs = RETRY_DELAYS_MS } = {}) {
  if (publish) requirePublicationReady();
  const problems = [];
  const released = new Map();
  const fresh = newPluginVersions(base).map((entry) => ({ ...entry, fresh: true }));
  const freshKeys = new Set(fresh.map(({ name, version }) => `${name}@${version}`));
  const current = releasedManifestsNeeded()
    .filter(({ name, version }) => !freshKeys.has(`${name}@${version}`))
    .map((entry) => ({ ...entry, fresh: false }));
  const work = mkdtempSync(join(tmpdir(), "release-verify-"));
  try {
    for (const { name, version, release, fresh: isNew } of [...fresh, ...current]) {
      if (!release) {
        problems.push(`plugin/${name}@${version}: no release pin to read its released plugin.json from`);
        continue;
      }
      const out = join(work, `${name}@${version}`);
      const failed = downloadWithRetry(download, release, out, retryDelaysMs);
      if (failed) {
        problems.push(`plugin/${name}@${version}: ${failed}`);
        continue;
      }
      // The pinned sha256 first: nothing else reads a zip that does not hash to it.
      const zip = join(out, release.asset);
      if (sha256(readFileSync(zip)) !== release.sha256) {
        problems.push(`plugin/${name}@${version}: ${release.tag}/${release.asset} does not hash to the pinned sha256`);
        continue;
      }
      const manifest = manifestIn(zip);
      // A current version that is not new was held to its tagged source by
      // the pull request that pinned it; here it is re-hashed and handed on.
      if (isNew) {
        for (const mismatch of sourceMismatches(name, version, release.tag, manifest)) problems.push(`plugin/${name}@${version}: ${mismatch}`);
      }
      released.set(`${name}@${version}`, manifest);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return [...problems, ...checkRepository({ base, releasedManifests: released })];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "plan") {
    if (args.includes("--publish")) {
      const problems = publicationProblems();
      for (const problem of problems) console.error(problem);
      if (problems.length > 0) process.exit(1);
    }
    console.log(JSON.stringify(plan()));
  }
  else if (command === "build" && args.length === 3 && args[2] === "--publish") console.log(await build(args[0], resolve(args[1])));
  else if (command === "pack") console.log(pack(args[0], resolve(args[1])));
  else if (command === "pin") console.log(JSON.stringify(pin(args[0], resolve(args[1])), null, 2));
  else if (command === "verify") {
    const at = args.indexOf("--base");
    const problems = verify(at >= 0 ? args[at + 1] : undefined, { publish: args.includes("--publish") });
    for (const problem of problems) console.error(problem);
    if (problems.length > 0) process.exit(1);
    console.log("release pins: OK");
  } else {
    console.error("usage: release.mjs plan [--publish] | build <name> <out.zip> --publish | pack <name> <out.zip> | pin <name> <zip> | verify [--base <ref>] [--publish]");
    process.exit(2);
  }
}
