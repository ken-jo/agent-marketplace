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
 * Release verification never reads the Ave source itself.
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
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ROOT = resolve(process.env.MARKETPLACE_ROOT ?? SCRIPT_ROOT);
// Coverage and destinations are part of the consumer's contract, never an
// unsigned inventory's choice. Keep this aligned with Ave's public bundle.
export const VENDORED_ARTIFACTS = Object.freeze([
  { name: "public-contract.ts", dir: "contract", built: false },
  { name: "plugin-manifest.schema.json", dir: "contract", built: false },
  { name: "protocol.schema.json", dir: "contract", built: false },
  { name: "marketplace-check.js", dir: "tools/vendor", built: true },
  { name: "agent-plugin-components.js", dir: "tools/vendor", built: true },
].map((artifact) => Object.freeze({ ...artifact, destination: `${artifact.dir}/${artifact.name}` })));
export const VENDORED_DIRS = Object.freeze([...new Set(VENDORED_ARTIFACTS.map(({ dir }) => dir))]);
export const BUNDLE_LIMITS = Object.freeze({
  fileBytes: 8 * 1024 * 1024,
  metadataBytes: 64 * 1024,
  signatureBytes: 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
  redirects: 3,
});

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

function readSources(dir, root = ROOT) {
  if (!VENDORED_DIRS.includes(dir)) throw new Error(`unsupported vendored directory: ${dir}`);
  const path = join(root, dir, "sources.json");
  if (!existsSync(path)) throw new Error(`${dir}/sources.json is missing`);
  const sources = JSON.parse(readFileSync(path, "utf8"));
  if (typeof sources?.repository !== "string" || typeof sources.ref !== "string" || typeof sources.files !== "object" || sources.files === null || Array.isArray(sources.files) || !Object.hasOwn(sources, "bundle")) {
    throw new Error(`${dir}/sources.json needs repository, ref, bundle and files`);
  }
  const expected = VENDORED_ARTIFACTS.filter((artifact) => artifact.dir === dir).map(({ name }) => name).sort();
  const listed = Object.keys(sources.files).sort();
  if (JSON.stringify(listed) !== JSON.stringify(expected)) {
    throw new Error(`${dir}/sources.json: files must contain exactly ${expected.join(", ")}; found ${listed.join(", ")}`);
  }
  for (const name of expected) {
    if (!/^[0-9a-f]{64}$/u.test(sources.files[name]?.sha256 ?? "")) throw new Error(`${dir}/sources.json: ${name} needs a sha256`);
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
function readVendoredSources(root = ROOT) {
  const sources = VENDORED_DIRS.map((dir) => [dir, readSources(dir, root)]);
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
  const byDir = new Map(inventories);
  for (const { dir, name, destination, built } of VENDORED_ARTIFACTS) {
    const entry = byDir.get(dir).files[name];
    const path = join(ROOT, destination);
    if (!existsSync(path)) {
      problems.push(`${dir}/${name}: missing`);
      continue;
    }
    const bytes = readFileSync(path);
    if (sha256(bytes) !== entry.sha256) {
      problems.push(`${dir}/${name}: bytes differ from sources.json; the copy was edited (sync a new ref instead)`);
    }
    if (built) for (const kind of embeddedBuildPaths(bytes)) problems.push(`${dir}/${name}: embedded absolute build path (${kind})`);
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

class BundleRefusal extends Error {}

/** The production transport buffers only bounded, same-origin HTTPS streams.
 * `fetch` is a function-only test seam; no CLI or environment selects it. */
export async function httpGet(url, { maxBytes = BUNDLE_LIMITS.fileBytes, remainingBytes = BUNDLE_LIMITS.totalBytes, fetch: request = globalThis.fetch } = {}) {
  const origin = new URL(BUNDLE_BASE).origin;
  const allowed = (value) => {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.origin !== origin || parsed.username || parsed.password) {
      throw new Error(`redirect/download URL must use HTTPS at ${origin}: ${value}`);
    }
    return parsed.href;
  };
  let current = allowed(url);
  const signal = AbortSignal.timeout(120_000);
  for (let redirects = 0; ; redirects += 1) {
    const response = await request(current, { signal, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      if (redirects >= BUNDLE_LIMITS.redirects) throw new Error(`redirect limit (${BUNDLE_LIMITS.redirects}) exceeded`);
      const location = response.headers.get("location");
      if (!location) throw new Error("redirect has no Location");
      current = allowed(new URL(location, current).href);
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      return { status: response.status };
    }
    try {
      if (response.redirected) throw new Error("automatic redirects are forbidden");
      if (response.url) allowed(response.url);
      const length = response.headers.get("content-length");
      if (length !== null) {
        if (!/^\d+$/u.test(length)) throw new Error("invalid Content-Length");
        if (BigInt(length) > BigInt(maxBytes)) throw new Error(`file byte limit (${maxBytes}) exceeded by Content-Length`);
        if (BigInt(length) > BigInt(remainingBytes)) throw new Error(`total byte limit (${BUNDLE_LIMITS.totalBytes}) exceeded by Content-Length`);
      }
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    const reader = response.body?.getReader();
    if (!reader) return { status: 200, bytes: Buffer.alloc(0) };
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error(`file byte limit (${maxBytes}) exceeded`);
        if (size > remainingBytes) throw new Error(`total byte limit (${BUNDLE_LIMITS.totalBytes}) exceeded`);
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    return { status: 200, bytes: Buffer.concat(chunks, size) };
  }
}

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
 * Download the bundle of `tag` and return the fixed artifact set, every one
 * held to the signed SHA256SUMS. Throws a BundleRefusal on the first failure.
 * `get` and `verifySignature` are injectable for the test harness only; the
 * command line always uses HTTPS and cosign.
 */
async function readBundle(tag, { get = httpGet, verifySignature = cosignVerify } = {}) {
  const base = bundleUrl(tag);
  let downloaded = 0;
  const download = async (name) => {
    const url = new URL(name, base).href;
    const maxBytes = name === SIGNATURE ? BUNDLE_LIMITS.signatureBytes
      : [SUMS, MANIFEST].includes(name) ? BUNDLE_LIMITS.metadataBytes : BUNDLE_LIMITS.fileBytes;
    let response;
    try {
      response = await get(url, { maxBytes, remainingBytes: BUNDLE_LIMITS.totalBytes - downloaded });
    } catch (error) {
      throw new BundleRefusal(`${url}: download failed (${error instanceof Error ? error.message : String(error)}); the contract bundle for ${tag} must be published before it can be verified`);
    }
    if (response?.status !== 200 || !response.bytes) {
      throw new BundleRefusal(`${url}: HTTP ${response?.status}; the contract bundle for ${tag} is missing or incomplete`);
    }
    if (response.bytes.length > maxBytes) throw new BundleRefusal(`${url}: file byte limit (${maxBytes}) exceeded`);
    downloaded += response.bytes.length;
    if (downloaded > BUNDLE_LIMITS.totalBytes) throw new BundleRefusal(`${url}: total byte limit (${BUNDLE_LIMITS.totalBytes}) exceeded`);
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
  const names = VENDORED_ARTIFACTS.map(({ name }) => name);
  const expected = [...names, MANIFEST].sort();
  if (JSON.stringify([...sums.keys()].sort()) !== JSON.stringify(expected)) {
    throw new BundleRefusal(`${tag}/${SUMS}: must list exactly ${expected.join(", ")}; found ${[...sums.keys()].sort().join(", ")}`);
  }

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
  if (manifest?.schemaVersion !== 1 || manifest.app !== "ave" || manifest.tag !== tag || !isCommitPin(manifest.commit) || typeof manifest.files !== "object" || manifest.files === null || Array.isArray(manifest.files)) {
    throw new BundleRefusal(`${tag}/${MANIFEST}: expected { schemaVersion: 1, app: "ave", tag: "${tag}", commit: <40-hex>, files }`);
  }
  const listed = [...sums.keys()].filter((name) => name !== MANIFEST).sort();
  const described = Object.keys(manifest.files).sort();
  if (JSON.stringify(listed) !== JSON.stringify(described)) {
    throw new BundleRefusal(`${tag}: ${SUMS} lists ${listed.join(", ")} but ${MANIFEST} describes ${described.join(", ")}`);
  }
  for (const name of described) {
    const entry = manifest.files[name];
    if (entry?.sha256 !== sums.get(name) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > BUNDLE_LIMITS.fileBytes) {
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

async function inspectVendored({ root = ROOT, allowDevelopment = false, ...options } = {}) {
  const inventories = readVendoredSources(root);
  const { ref } = inventories[0][1];
  if (!isReleaseTag(ref) && !allowDevelopment) {
    throw new BundleRefusal(`vendored sources pin ${ref}, a development commit; only an Ave release tag has a signed contract bundle to verify against`);
  }
  const bundle = isReleaseTag(ref) ? await readBundle(ref, options) : null;
  const byDir = new Map(inventories);
  const files = new Map();
  const problems = [];
  for (const { dir, name, destination, built } of VENDORED_ARTIFACTS) {
    const entry = byDir.get(dir).files[name];
    const path = join(root, destination);
    const expected = bundle?.files.get(name);
    if (!existsSync(path)) {
      problems.push(`${destination}: missing`);
    } else {
      // These exact buffers are what the runtime loader may later evaluate;
      // it must never re-read the mutable checkout after verification.
      const bytes = readFileSync(path);
      files.set(destination, bytes);
      if (expected && !bytes.equals(expected)) problems.push(`${destination}: bytes differ from ${name} in the signed ${ref} bundle`);
      else if (!expected && sha256(bytes) !== entry.sha256) problems.push(`${destination}: bytes differ from sources.json; the copy was edited (sync a new ref instead)`);
      if (built) for (const kind of embeddedBuildPaths(expected ?? bytes)) problems.push(`${destination}: embedded absolute build path (${kind})${bundle ? ` in the ${ref} bundle` : ""}`);
    }
    if (expected && entry.sha256 !== sha256(expected)) problems.push(`${dir}/sources.json: ${name} sha256 differs from the signed ${ref} bundle`);
  }
  return { problems, files };
}

/** Problems between the committed copies and the signed bundle of their tag. */
export async function verifyVendored(options = {}) {
  try {
    return (await inspectVendored({ ...options, allowDevelopment: false })).problems;
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

/** Verified artifact buffers for execution. Development integrity trusts the
 * reviewed committed inventory hashes; it provides no upstream signature. */
export async function readVerifiedVendored(options = {}) {
  const { problems, files } = await inspectVendored(options);
  if (problems.length > 0) throw new BundleRefusal(problems.join("\n"));
  return files;
}

/** Stage and validate every replacement on the destination filesystem.
 * Individual renames are atomic; caught failures restore the previous set.
 * This is not a crash-atomic multi-file filesystem transaction. */
function installVendored(replacements, { root = ROOT, rename = renameSync } = {}) {
  const stage = mkdtempSync(join(root, ".vendor-stage-"));
  const installed = [];
  let retainBackups = false;
  try {
    mkdirSync(join(stage, "new"));
    mkdirSync(join(stage, "original"));
    const rootPath = realpathSync(root);
    const records = [...replacements].map(([destination, bytes], index) => {
      const target = join(root, destination);
      const parent = realpathSync(dirname(target));
      if (!parent.startsWith(`${rootPath}${sep}`)) throw new Error(`${destination}: destination is outside the marketplace`);
      const staged = join(stage, "new", String(index));
      const backup = join(stage, "original", String(index));
      let stat;
      try {
        stat = lstatSync(target);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const existed = stat !== undefined;
      if (existed) {
        if (!stat.isFile()) throw new Error(`${destination}: destination must be a regular file`);
        copyFileSync(target, backup);
        chmodSync(backup, stat.mode & 0o777);
      }
      writeFileSync(staged, bytes);
      chmodSync(staged, existed ? stat.mode & 0o777 : 0o644);
      return { target, staged, backup, existed, bytes };
    });
    for (const { staged, bytes } of records) {
      if (!readFileSync(staged).equals(bytes)) throw new Error("staged vendored bytes failed verification");
    }
    // The caller orders all artifacts before the inventories, so a partial
    // observation fails integrity checks until the new inventories land.
    for (const record of records) {
      rename(record.staged, record.target);
      installed.push(record);
    }
  } catch (error) {
    const failures = [];
    for (const { target, backup, existed } of installed.reverse()) {
      try {
        if (existed) renameSync(backup, target);
        else rmSync(target);
      } catch (rollbackError) {
        failures.push(`${target}: ${rollbackError.message}`);
      }
    }
    if (failures.length > 0) {
      retainBackups = true;
      throw new Error(`vendored sync failed: ${error.message}; rollback incomplete: ${failures.join("; ")}; backups retained at ${stage}`);
    }
    throw error;
  } finally {
    if (!retainBackups) rmSync(stage, { recursive: true, force: true });
  }
}

/** Write both vendored directories from a complete verified bundle, with
 * staged replacements and rollback; inventories are installed last. */
export async function syncFromBundle(tag, options = {}) {
  if (!isReleaseTag(tag)) throw new Error(`sync --ref ${tag}: only an Ave release tag (vX.Y.Z) has a contract bundle; a commit pin syncs from a checkout with --app`);
  const root = options.root ?? ROOT;
  const inventories = readVendoredSources(root);
  const { files } = await readBundle(tag, options);
  const replacements = new Map();
  for (const { name, destination, built } of VENDORED_ARTIFACTS) {
    const bytes = files.get(name);
    if (built && embeddedBuildPaths(bytes).length > 0) throw new Error(`${tag}/${name}: embedded absolute build path`);
    replacements.set(destination, bytes);
  }
  for (const [dir, sources] of inventories) {
    sources.comment = `Ave ${tag}, from its signed contract bundle. Never edit a copy: \`node tools/vendor.mjs verify\` holds every byte to the bundle, and a new tag arrives with \`node tools/vendor.mjs sync --ref <tag>\`.`;
    sources.ref = tag;
    sources.bundle = bundleUrl(tag);
    for (const [name, entry] of Object.entries(sources.files)) {
      entry.sha256 = sha256(files.get(name));
    }
    replacements.set(`${dir}/sources.json`, Buffer.from(`${JSON.stringify(sources, null, 2)}\n`));
  }
  installVendored(replacements, options);
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
  const replacements = new Map();
  for (const [name, entry] of Object.entries(sources.files)) {
    const bytes = entry.build
      ? buildAtRef(entry, app, ref)
      : execFileSync("git", ["-C", app, "show", `${ref}:${entry.from}`], { maxBuffer: 64 * 1024 * 1024 });
    if (entry.build && embeddedBuildPaths(bytes).length > 0) throw new Error(`${dir}/${name}: embedded absolute build path`);
    replacements.set(`${dir}/${name}`, bytes);
    entry.sha256 = sha256(bytes);
  }
  replacements.set(`${dir}/sources.json`, Buffer.from(`${JSON.stringify(sources, null, 2)}\n`));
  installVendored(replacements);
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
