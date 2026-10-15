#!/usr/bin/env node
/**
 * Vendored copies of Ave files (design §5.6).
 *
 * `contract/` and `tools/vendor/` hold Ave files at one ref. Each directory's
 * `sources.json` records the ref, the contract bundle URL and every file's
 * sha256; `repository`, `from` and `build` only say where Ave keeps each file.
 * The copies have no authority of their own: a change belongs in Ave, and
 * reaches this repository by syncing a new ref.
 *
 * The ref is either an Ave release tag (`vX.Y.Z`) or, during development, a
 * 40-hex commit of Ave main. Only a release tag has a contract bundle: the
 * files Ave's tag build publishes under `BUNDLE_BASE<tag>/`, with a
 * `SHA256SUMS` signed by Sigstore under the tag's build workflow identity.
 * This repository never reads the Ave source itself.
 *
 *   node tools/vendor.mjs check            offline: the inventories agree and the bytes match them
 *   node tools/vendor.mjs verify           the signed bundle of the pinned tag holds these exact bytes
 *   node tools/vendor.mjs sync --ref <tag> write both directories from the signed bundle of <tag>
 *   node tools/vendor.mjs sync <dir> --ref <commit> --app <checkout>
 *       development pin: copy and rebuild from a local Ave checkout at <commit>;
 *       publication refuses a commit pin
 *
 * `verify` and `sync --ref <tag>` need `cosign` on PATH. They fail closed: a
 * missing file, a signature that does not name exactly the expected workflow
 * identity, a hash that differs from SHA256SUMS, or a vendored byte that
 * differs from the bundle is a refusal.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ROOT = resolve(process.env.MARKETPLACE_ROOT ?? SCRIPT_ROOT);
export const VENDORED_DIRS = ["contract", "tools/vendor"];

/** Where Ave's tag build publishes the contract bundle; `<tag>/` follows. */
export const BUNDLE_BASE = "https://downloads.agent-connector.ai/contract/";
/** The only workflow whose Sigstore certificate may sign a bundle; `@refs/tags/<tag>` follows. */
export const SIGNER_WORKFLOW = "https://github.com/ken-jo/ave/.github/workflows/build-installers.yml";
export const SIGNER_ISSUER = "https://token.actions.githubusercontent.com";
const SUMS = "SHA256SUMS";
const SIGNATURE = "SHA256SUMS.sigstore.json";
const MANIFEST = "bundle.json";

const RELEASE_TAG = /^v\d+\.\d+\.\d+$/u;
const COMMIT_PIN = /^[0-9a-f]{40}$/u;
export const isReleaseTag = (ref) => typeof ref === "string" && RELEASE_TAG.test(ref);
export const isCommitPin = (ref) => typeof ref === "string" && COMMIT_PIN.test(ref);
export const bundleUrl = (tag) => `${BUNDLE_BASE}${tag}/`;
export const signerIdentity = (tag) => `${SIGNER_WORKFLOW}@refs/tags/${tag}`;

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
  if (typeof sources.repository !== "string" || typeof sources.ref !== "string" || typeof sources.files !== "object" || !Object.hasOwn(sources, "bundle")) {
    throw new Error(`${dir}/sources.json needs repository, ref, bundle and files`);
  }
  if (isReleaseTag(sources.ref)) {
    if (sources.bundle !== bundleUrl(sources.ref)) {
      throw new Error(`${dir}/sources.json: bundle must be ${bundleUrl(sources.ref)} for ${sources.ref}, not ${JSON.stringify(sources.bundle)}`);
    }
  } else if (isCommitPin(sources.ref)) {
    if (sources.bundle !== null) throw new Error(`${dir}/sources.json: a development commit pin has no bundle; bundle must be null, not ${JSON.stringify(sources.bundle)}`);
  } else {
    throw new Error(`${dir}/sources.json: ref ${JSON.stringify(sources.ref)} is neither an Ave release tag (vX.Y.Z) nor a 40-hex commit pin`);
  }
  return sources;
}

/** Read all inventories together so every check uses one upstream pin. */
function readVendoredSources() {
  const sources = VENDORED_DIRS.map((dir) => [dir, readSources(dir)]);
  for (const field of ["repository", "ref", "bundle"]) {
    if (new Set(sources.map(([, source]) => source[field])).size > 1) {
      const values = sources.map(([dir, source]) => `${dir}/sources.json ${field}=${JSON.stringify(source[field])}`);
      throw new Error(`vendored sources disagree on ${field}: ${values.join(", ")}`);
    }
  }
  return sources;
}

/** Problems with the committed copies, offline. */
export function checkVendored() {
  let inventories;
  try {
    inventories = readVendoredSources();
  } catch (error) {
    return [error.message];
  }
  const problems = [];
  for (const [dir, sources] of inventories) {
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

/** `cosign verify-blob` with an exact identity and issuer, never a pattern. */
export function cosignArgs({ artifactPath, bundlePath, identity, issuer }) {
  return ["verify-blob", "--bundle", bundlePath, "--certificate-identity", identity, "--certificate-oidc-issuer", issuer, artifactPath];
}

/** The production signature check. Throws unless cosign accepts the bundle for exactly `identity` and `issuer`. */
function cosignVerify({ artifact, bundle, identity, issuer }) {
  const work = mkdtempSync(join(tmpdir(), "contract-bundle-"));
  try {
    const artifactPath = join(work, SUMS);
    const bundlePath = join(work, SIGNATURE);
    writeFileSync(artifactPath, artifact);
    writeFileSync(bundlePath, bundle);
    execFileSync("cosign", cosignArgs({ artifactPath, bundlePath, identity, issuer }), { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr).trim() : "";
    throw new Error(stderr || (error instanceof Error ? error.message : String(error)));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function httpGet(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  return { status: response.status, bytes: response.ok ? Buffer.from(await response.arrayBuffer()) : undefined };
}

class BundleRefusal extends Error {}

function parseSums(bytes, tag) {
  const sums = new Map();
  const lines = bytes.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9][A-Za-z0-9._-]*)$/u.exec(line);
    if (!match) throw new BundleRefusal(`${tag}/${SUMS}: malformed line ${JSON.stringify(line)}`);
    if (sums.has(match[2])) throw new BundleRefusal(`${tag}/${SUMS}: lists ${match[2]} twice`);
    sums.set(match[2], match[1]);
  }
  if (!sums.has(MANIFEST)) throw new BundleRefusal(`${tag}/${SUMS}: does not list ${MANIFEST}`);
  return sums;
}

/**
 * Download the bundle of `tag` and return the bytes of `names`, every one
 * held to the signed SHA256SUMS. Throws a BundleRefusal on the first failure.
 * `get` and `verifySignature` are injectable for the test harness only; the
 * command line always uses HTTPS and cosign.
 */
async function readBundle(tag, names, { get = httpGet, verifySignature = cosignVerify } = {}) {
  const base = bundleUrl(tag);
  const download = async (name) => {
    const url = new URL(name, base).href;
    let response;
    try {
      response = await get(url);
    } catch (error) {
      throw new BundleRefusal(`${url}: download failed (${error instanceof Error ? error.message : String(error)}); the contract bundle for ${tag} must be published before it can be verified`);
    }
    if (response?.status !== 200 || !response.bytes) {
      throw new BundleRefusal(`${url}: HTTP ${response?.status}; the contract bundle for ${tag} is missing or incomplete`);
    }
    return Buffer.from(response.bytes);
  };

  const sumsBytes = await download(SUMS);
  const signature = await download(SIGNATURE);
  const identity = signerIdentity(tag);
  try {
    await verifySignature({ artifact: sumsBytes, bundle: signature, identity, issuer: SIGNER_ISSUER });
  } catch (error) {
    throw new BundleRefusal(`${tag}/${SIGNATURE}: the signature over ${SUMS} does not verify for identity ${identity} issued by ${SIGNER_ISSUER}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const sums = parseSums(sumsBytes, tag);

  const verified = async (name) => {
    const bytes = await download(name);
    if (sha256(bytes) !== sums.get(name)) throw new BundleRefusal(`${tag}/${name}: sha256 ${sha256(bytes)} differs from the signed ${SUMS} (${sums.get(name)})`);
    return bytes;
  };
  const manifestBytes = await verified(MANIFEST);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new BundleRefusal(`${tag}/${MANIFEST}: invalid JSON`);
  }
  if (manifest?.schemaVersion !== 1 || manifest.app !== "ave" || manifest.tag !== tag || !isCommitPin(manifest.commit) || typeof manifest.files !== "object" || manifest.files === null) {
    throw new BundleRefusal(`${tag}/${MANIFEST}: expected { schemaVersion: 1, app: "ave", tag: "${tag}", commit: <40-hex>, files }`);
  }
  const listed = [...sums.keys()].filter((name) => name !== MANIFEST).sort();
  const described = Object.keys(manifest.files).sort();
  if (JSON.stringify(listed) !== JSON.stringify(described)) {
    throw new BundleRefusal(`${tag}: ${SUMS} lists ${listed.join(", ")} but ${MANIFEST} describes ${described.join(", ")}`);
  }
  for (const name of described) {
    const entry = manifest.files[name];
    if (entry?.sha256 !== sums.get(name) || !Number.isSafeInteger(entry.bytes)) {
      throw new BundleRefusal(`${tag}/${MANIFEST}: ${name} disagrees with the signed ${SUMS}`);
    }
  }
  const files = new Map();
  for (const name of names) {
    if (!sums.has(name)) throw new BundleRefusal(`${tag}: the bundle has no ${name}`);
    const bytes = await verified(name);
    if (bytes.length !== manifest.files[name].bytes) throw new BundleRefusal(`${tag}/${name}: ${bytes.length} bytes, ${MANIFEST} says ${manifest.files[name].bytes}`);
    files.set(name, bytes);
  }
  return { commit: manifest.commit, files };
}

const vendoredNames = (inventories) => inventories.flatMap(([, sources]) => Object.keys(sources.files));

/** Problems between the committed copies and the signed bundle of their tag. */
export async function verifyVendored(options = {}) {
  let inventories;
  try {
    inventories = readVendoredSources();
  } catch (error) {
    return [error.message];
  }
  const { ref } = inventories[0][1];
  if (!isReleaseTag(ref)) {
    return [`vendored sources pin ${ref}, a development commit; only an Ave release tag has a signed contract bundle to verify against`];
  }
  let bundle;
  try {
    bundle = await readBundle(ref, vendoredNames(inventories), options);
  } catch (error) {
    if (error instanceof BundleRefusal) return [error.message];
    throw error;
  }
  const problems = [];
  for (const [dir, sources] of inventories) {
    for (const [name, entry] of Object.entries(sources.files)) {
      const expected = bundle.files.get(name);
      const path = join(ROOT, dir, name);
      if (!existsSync(path)) problems.push(`${dir}/${name}: missing`);
      else if (!readFileSync(path).equals(expected)) problems.push(`${dir}/${name}: bytes differ from ${name} in the signed ${ref} bundle`);
      if (entry.sha256 !== sha256(expected)) problems.push(`${dir}/sources.json: ${name} sha256 differs from the signed ${ref} bundle`);
      if (entry.build) for (const kind of embeddedBuildPaths(expected)) problems.push(`${dir}/${name}: embedded absolute build path (${kind}) in the ${ref} bundle`);
    }
  }
  return problems;
}

/** Write both vendored directories from the signed bundle of `tag`; nothing is written unless all of it verifies. */
export async function syncFromBundle(tag, options = {}) {
  if (!isReleaseTag(tag)) throw new Error(`sync --ref ${tag}: only an Ave release tag (vX.Y.Z) has a contract bundle; a commit pin syncs from a checkout with --app`);
  const inventories = VENDORED_DIRS.map((dir) => {
    const path = join(ROOT, dir, "sources.json");
    if (!existsSync(path)) throw new Error(`${dir}/sources.json is missing`);
    return [dir, JSON.parse(readFileSync(path, "utf8"))];
  });
  const { files } = await readBundle(tag, vendoredNames(inventories), options);
  for (const [, sources] of inventories) {
    for (const name of Object.keys(sources.files)) {
      if (sources.files[name].build && embeddedBuildPaths(files.get(name)).length > 0) throw new Error(`${tag}/${name}: embedded absolute build path`);
    }
  }
  for (const [dir, sources] of inventories) {
    sources.comment = `Ave ${tag}, from its signed contract bundle. Never edit a copy: \`node tools/vendor.mjs verify\` holds every byte to the bundle, and a new tag arrives with \`node tools/vendor.mjs sync --ref <tag>\`.`;
    sources.ref = tag;
    sources.bundle = bundleUrl(tag);
    for (const [name, entry] of Object.entries(sources.files)) {
      writeFileSync(join(ROOT, dir, name), files.get(name));
      entry.sha256 = sha256(files.get(name));
    }
  }
  for (const [dir, sources] of inventories) writeFileSync(join(ROOT, dir, "sources.json"), `${JSON.stringify(sources, null, 2)}\n`);
}

/** Build `entry.build.entry` from the checkout `app`, which must be at `ref` and clean. */
function buildAtRef(entry, app, ref) {
  if (entry.build.logger !== "stub-app-logger") throw new Error(`unsupported checker bundle logger recipe: ${entry.build.logger}`);
  const head = execFileSync("git", ["-C", app, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== ref) throw new Error(`${app} is at ${head}, not ${ref}`);
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

/** Development pin: copy and rebuild `dir` from a local Ave checkout at the commit `ref`. */
function syncFromCheckout(dir, ref, app) {
  if (!isCommitPin(ref)) throw new Error(`sync ${dir} --app takes a 40-hex commit; a release tag syncs from its signed bundle with \`sync --ref ${ref}\``);
  const sources = readSources(dir);
  sources.ref = ref;
  sources.bundle = null;
  for (const [name, entry] of Object.entries(sources.files)) {
    const bytes = entry.build
      ? buildAtRef(entry, app, ref)
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
  const ref = option(args, "--ref");
  const app = option(args, "--app");
  let problems = [];
  try {
    if (command === "check") problems = checkVendored();
    else if (command === "verify" && args.length === 0) problems = await verifyVendored();
    else if (command === "sync" && ref && app && args.length === 5 && !args[0].startsWith("--")) syncFromCheckout(args[0], ref, app);
    else if (command === "sync" && ref && !app && args.length === 2) await syncFromBundle(ref);
    else {
      console.error("usage: vendor.mjs check | verify | sync --ref <tag> | sync <dir> --ref <commit> --app <checkout>");
      process.exit(2);
    }
  } catch (error) {
    problems = [error instanceof Error ? error.message : String(error)];
  }
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exit(1);
  if (command === "verify") console.log("contract bundle: OK");
}
