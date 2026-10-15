#!/usr/bin/env node
/**
 * Validate the repository (blueprint 0.2).
 *
 * The rules the app applies come from the app itself: `tools/vendor/` holds
 * Ave's `checkMarketplaceRepository`, bundled from the ref in its
 * sources.json, so this check and the app cannot disagree. What only this
 * repository knows is checked here:
 * - the vendored copies are unedited;
 * - every package sits in its kind's directory under its own name;
 * - official plugins ship as release assets of this repository only (no
 *   tree rung, design §3.1), and their source agrees with itself and with the
 *   descriptor about name and version;
 * - with `--base <ref>`: published versions are immutable, apart from
 *   `yanked` and `rollout`, and stay listed unless their package is
 *   withdrawn whole in tools/withdrawn.json;
 * - no tracked file carries a credential.
 *
 *   node tools/check.mjs [--base <ref>] [--released <plugin>@<version>=<plugin.json path>]…
 *
 * Offline: a plugin version whose plugin.json lives only in its release asset
 * (see releasedManifestsNeeded) needs --released, or `release.mjs verify`,
 * which downloads each asset and runs this check with it. Without either the
 * check fails and names the versions; it never passes without them.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkMarketplaceRepository } from "./vendor/marketplace-check.js";
import { checkVendored } from "./vendor.mjs";
import {
  ALERTS_RELEASE_VERSION,
  DESCRIPTOR,
  INDEX_PATH,
  KIND_DIRS,
  Ave,
  REPOSITORY,
  MUTABLE_VERSION_FIELDS,
  ROOT,
  baseIndexes,
  canonicalJson,
  compareVersions,
  requiredHostProtocol,
  hasCommit,
  packageDirs,
  pluginAuthority,
  readJson,
  trackedFiles,
  withdrawnPackages,
  workingTree,
} from "./repo.mjs";

/** Fields a version may change after it is published: withdrawing it, or widening its rollout. */
const CREDENTIALS = [
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/u, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}\b/u, "a GitHub token"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/u, "an Anthropic API key"],
  [/\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/u, "an OpenAI API key"],
  [/\bAKIA[0-9A-Z]{16}\b/u, "an AWS access key"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/u, "a Slack token"],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u, "a private key"],
];
function option(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function released() {
  const map = new Map();
  process.argv.forEach((arg, at) => {
    if (arg !== "--released") return;
    const [key, path] = process.argv[at + 1].split("=");
    map.set(key, JSON.parse(readFileSync(path, "utf8")));
  });
  return map;
}

function checkLayout(problems) {
  for (const dir of packageDirs()) {
    const [top, name] = dir.split("/");
    const descriptor = readJson(`${dir}/${DESCRIPTOR}`);
    if (descriptor.kind !== KIND_DIRS.get(top)) problems.push(`${dir}: a ${descriptor.kind} package does not belong in ${top}/`);
    if (descriptor.name !== name) problems.push(`${dir}: the descriptor names it ${descriptor.name}; the directory must carry the package name`);
  }
}

function checkOfficialPlugins(problems) {
  const tracked = new Set(trackedFiles());
  const described = new Set(packageDirs().filter((d) => d.startsWith("plugins/")));
  const built = new Set([...tracked].filter((p) => /^plugins\/[^/]+\/source\/plugin\.json$/u.test(p)).map((p) => p.split("/").slice(0, 2).join("/")));
  for (const dir of [...new Set([...described, ...built])].sort()) {
    const name = dir.split("/")[1];
    const subject = `plugin/${name}`;
    const descriptor = described.has(dir) ? readJson(`${dir}/${DESCRIPTOR}`) : undefined;
    if (descriptor) {
      const artifact = descriptor.payload.artifact;
      if (tracked.has(`${dir}/plugin.json`) || artifact.tree !== undefined || artifact.archive !== undefined) {
        problems.push(`${subject}: an official plugin ships as a release asset only (no tree or archive rung)`);
      }
      if (artifact.release?.repo !== REPOSITORY || artifact.release?.url !== undefined) {
        problems.push(`${subject}: artifact.release must name ${REPOSITORY}, where the release workflow uploads it`);
      }
    }
    const manifestPath = `${dir}/source/plugin.json`;
    if (!built.has(dir)) {
      problems.push(`${subject}: ${manifestPath} is missing; official plugins are built from this repository`);
      continue;
    }
    // A source without a descriptor is a plugin the release workflow has not published yet.
    const manifest = readJson(manifestPath);
    const pkg = readJson(`${dir}/source/package.json`);
    const ave = manifest.extensions?.[Ave] ?? {};
    if (manifest.name !== name) problems.push(`${subject}: ${manifestPath} names it ${manifest.name}; the directory must carry the plugin name`);
    if (manifest.version !== pkg.version) problems.push(`${subject}: plugin.json ${manifest.version} and package.json ${pkg.version} must carry one version`);
    if (descriptor && compareVersions(manifest.version, descriptor.version) < 0) {
      problems.push(`${subject}: the source (${manifest.version}) is older than the published descriptor (${descriptor.version})`);
    }
    for (const field of ["installPolicy", "publisher"]) {
      if (field in ave) problems.push(`${subject}: ${manifestPath} carries ${field}, which the app refuses (design §5.3)`);
    }
    if ("notificationEvents" in ave && typeof ave.requires?.minAppVersion === "string"
      && compareVersions(ave.requires.minAppVersion, ALERTS_RELEASE_VERSION) >= 0) {
      problems.push(`${subject}: ${manifestPath} carries notificationEvents at or above app ${ALERTS_RELEASE_VERSION}; declare alerts kinds instead`);
    }
    // What the release workflow will pin, so a manifest it cannot pin fails before the release.
    for (const problem of pluginAuthority(manifest).problems ?? []) problems.push(`${subject}: ${manifestPath}: ${problem}`);
  }
}

function checkPublishedVersions(base, problems) {
  // A base this clone lacks (a force-push's `before`, a shallow clone) would
  // skip the whole comparison, so it fails instead.
  if (!hasCommit(base)) {
    problems.push(`${base}: the base commit is not in this clone, so published versions cannot be compared with it`);
    return;
  }
  const now = new Map(readJson(INDEX_PATH).packages.map((entry) => [`${entry.kind}/${entry.name}`, entry]));
  const withdrawn = withdrawnPackages();
  for (const { index: previous } of baseIndexes(base)) {
    for (const entry of previous.packages) {
      const subject = `${entry.kind}/${entry.name}`;
      const current = now.get(subject);
      // A withdrawn package leaves whole; one it keeps listed stays immutable.
      if (current === undefined && withdrawn.has(subject)) continue;
      for (const version of entry.versions ?? []) {
        const kept = current?.versions?.find((v) => v.version === version.version);
        if (!kept) {
          problems.push(`${subject}@${version.version}: a published version cannot leave the index; yank it instead`);
          continue;
        }
        const fields = new Set([...Object.keys(version), ...Object.keys(kept)]);
        for (const field of fields) {
          if (MUTABLE_VERSION_FIELDS.has(field)) continue;
          // Canonical: a pre-move base's format-1 copy may order keys differently.
          if (canonicalJson(version[field]) !== canonicalJson(kept[field])) {
            problems.push(`${subject}@${version.version}: ${field} changed after publication`);
          }
        }
      }
    }
  }
}

function checkCredentials(problems) {
  for (const path of trackedFiles()) {
    let text;
    try {
      text = readFileSync(join(ROOT, path), "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue; // binary
    for (const [pattern, what] of CREDENTIALS) {
      if (pattern.test(text)) problems.push(`${path}: looks like it contains ${what}`);
    }
  }
}

/** The app reads one catalog format, named inside the file; a later format needs a new app reader first. */
function checkCatalogFormat(problems) {
  const { schemaVersion } = readJson(INDEX_PATH);
  if (schemaVersion !== 2) problems.push(`${INDEX_PATH}: schemaVersion ${JSON.stringify(schemaVersion)}; the app reads schemaVersion 2`);
}

function checkHostProtocolCatalog(problems, releasedManifests) {
  for (const entry of readJson(INDEX_PATH).packages) {
    if (entry.kind !== "plugin") continue;
    for (const version of entry.versions ?? []) {
      const required = requiredHostProtocol(version.minAppVersion);
      if (!required) continue;
      const subject = `plugin/${entry.name}@${version.version}`;
      if (version.hostProtocol !== required) problems.push(`${subject}: ${INDEX_PATH} requires hostProtocol ${required} for minAppVersion ${version.minAppVersion}`);
      const released = releasedManifests.get(`${entry.name}@${version.version}`);
      if (released && released.extensions?.[Ave]?.requires?.hostProtocol !== required) {
        problems.push(`${subject}: released plugin.json requires hostProtocol ${required} for minAppVersion ${version.minAppVersion}`);
      }
    }
  }
  for (const dir of packageDirs().filter((path) => path.startsWith("plugins/"))) {
    const descriptor = readJson(`${dir}/${DESCRIPTOR}`);
    const required = requiredHostProtocol(descriptor.minAppVersion);
    if (required && descriptor.hostProtocol !== required) {
      problems.push(`${dir}/${DESCRIPTOR}: hostProtocol ${required} is required for minAppVersion ${descriptor.minAppVersion}`);
    }
  }
}

/**
 * The plugin versions whose released plugin.json the check needs and cannot
 * read from this tree: the current version of each plugin with no plugin.json
 * beside its descriptor (official plugins ship as release assets) at or above
 * the alerts release, where the vendored checker holds the released manifest
 * to the notificationEvents rule. The same condition as the checker's, named
 * here so `release.mjs verify` downloads exactly these and the CLI below can
 * say what is missing.
 */
export function releasedManifestsNeeded() {
  return packageDirs()
    .filter((dir) => dir.startsWith("plugins/"))
    .map((dir) => ({ dir, descriptor: readJson(`${dir}/${DESCRIPTOR}`) }))
    .filter(({ dir, descriptor }) => descriptor.kind === "plugin"
      && !existsSync(join(ROOT, dir, "plugin.json"))
      && typeof descriptor.minAppVersion === "string"
      && compareVersions(descriptor.minAppVersion, ALERTS_RELEASE_VERSION) >= 0)
    .map(({ descriptor }) => ({ name: descriptor.name, version: descriptor.version, release: descriptor.payload?.artifact?.release }));
}

export function checkRepository({ base, releasedManifests = new Map() } = {}) {
  const problems = [...checkVendored()];
  checkCatalogFormat(problems);
  for (const problem of checkMarketplaceRepository(workingTree(), { sourceId: "ave", official: true, alertsReleaseVersion: ALERTS_RELEASE_VERSION, releasedManifests })) {
    problems.push(`${problem.subject}: ${problem.message}`);
  }
  checkLayout(problems);
  checkOfficialPlugins(problems);
  checkHostProtocolCatalog(problems, releasedManifests);
  if (base) checkPublishedVersions(base, problems);
  checkCredentials(problems);
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = option("--base");
  const releasedManifests = released();
  // Keep this entry point offline. Replace only the pinned checker's internal
  // releasedManifests diagnostic; still report every other validation error.
  const unheld = releasedManifestsNeeded()
    .filter(({ name, version }) => !releasedManifests.has(`${name}@${version}`));
  const missingManifestProblems = new Set(unheld.map(({ name, version }) =>
    `plugin/${name}: Supply releasedManifests for ${name}@${version} to check notificationEvents at or above the alerts release`));
  const problems = checkRepository({ base, releasedManifests })
    .filter((problem) => !missingManifestProblems.has(problem));
  if (unheld.length > 0) {
    const baseArg = base ? ` --base '${base.replaceAll("'", "'\\''")}'` : "";
    console.error(
      `${unheld.map(({ name, version }) => `${name}@${version}`).join(", ")}: tools/check.mjs is offline and needs the released plugin.json files. `
      + `Run \`node tools/release.mjs verify${baseArg}\`, which downloads and re-hashes the required releases and runs this check, `
      + "or pass --released <plugin>@<version>=<plugin.json path>.",
    );
  }
  for (const problem of problems) console.error(problem);
  if (problems.length > 0 || unheld.length > 0) process.exit(1);
  console.log("marketplace check: OK");
}
