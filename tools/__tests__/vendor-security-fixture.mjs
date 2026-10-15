/** Test-owned bundle contents: never derive verification coverage from sources.json. */
import { generateKeyPairSync, createHash, sign, verify } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ARTIFACTS = Object.freeze([
  ["public-contract.ts", "contract/public-contract.ts"],
  ["plugin-manifest.schema.json", "contract/plugin-manifest.schema.json"],
  ["protocol.schema.json", "contract/protocol.schema.json"],
  ["marketplace-check.js", "tools/vendor/marketplace-check.js"],
  ["agent-plugin-components.js", "tools/vendor/agent-plugin-components.js"],
]);
export const INVENTORIES = ["contract/sources.json", "tools/vendor/sources.json"];
export const TAG = "v0.14.0";
export const COMMIT = "c".repeat(40);
export const BASE = `https://downloads.agent-connector.ai/contract/${TAG}/`;
export const IDENTITY = `https://github.com/ken-jo/ave/.github/workflows/build-installers.yml@refs/tags/${TAG}`;
export const ISSUER = "https://token.actions.githubusercontent.com";
export const LIMITS = Object.freeze({ fileBytes: 8 * 1024 * 1024, metadataBytes: 64 * 1024, signatureBytes: 1024 * 1024, totalBytes: 20 * 1024 * 1024, redirects: 3 });
// Only this test harness reads the override, to replay the suite on a git-show baseline copy.
export const modulePath = resolve(process.env.VENDOR_SECURITY_MODULE ?? fileURLToPath(new URL("../vendor.mjs", import.meta.url)));
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let importSequence = 0;

/** Give old ROOT-only APIs and the new explicit-root APIs the same isolated fixture. */
export async function loadVendor(root) {
  const original = process.env.MARKETPLACE_ROOT;
  process.env.MARKETPLACE_ROOT = root;
  try {
    return await import(`${pathToFileURL(modulePath).href}?security=${++importSequence}`);
  } finally {
    if (original === undefined) delete process.env.MARKETPLACE_ROOT;
    else process.env.MARKETPLACE_ROOT = original;
  }
}

export function snapshot(root) {
  const found = {};
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      const name = relative(root, path);
      if (entry.isDirectory()) {
        found[`${name}/`] = "directory";
        visit(path);
      } else found[name] = fs.readFileSync(path).toString("base64");
    }
  };
  visit(root);
  return found;
}

export function fixture(t, { ref = TAG } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), "vendor-security-"));
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  t?.after(cleanup);
  const inventories = new Map(INVENTORIES.map((path) => [path, {
    repository: "ken-jo/ave", ref, bundle: ref === TAG ? BASE : null, files: {},
  }]));
  for (const [name, destination] of ARTIFACTS) {
    const bytes = Buffer.from(`// fixture ${name}\n`);
    fs.mkdirSync(dirname(join(root, destination)), { recursive: true });
    fs.writeFileSync(join(root, destination), bytes);
    inventories.get(`${dirname(destination)}/sources.json`).files[name] = { from: `fixture/${name}`, sha256: hash(bytes) };
  }
  const writeInventory = (path, value) => fs.writeFileSync(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
  for (const [path, value] of inventories) writeInventory(path, value);
  const keys = generateKeyPairSync("ed25519");
  const verifier = ({ artifact, bundle, identity, issuer }) => {
    const parsed = JSON.parse(bundle.toString("utf8"));
    if (identity !== IDENTITY || issuer !== ISSUER || parsed.identity !== identity || parsed.issuer !== issuer) throw new Error("unexpected signature identity or issuer");
    if (!verify(null, artifact, keys.publicKey, Buffer.from(parsed.signature, "base64"))) throw new Error("signature does not match SHA256SUMS");
  };
  const publish = ({ omit = [], add = {}, replace = {}, manifestPadding = 0, signaturePadding = 0 } = {}) => {
    const files = new Map(ARTIFACTS.filter(([name]) => !omit.includes(name)).map(([name, destination]) => [name, Buffer.from(replace[name] ?? fs.readFileSync(join(root, destination)))]));
    for (const [name, bytes] of Object.entries(add)) files.set(name, Buffer.from(bytes));
    const entries = Object.fromEntries([...files].map(([name, bytes]) => [name, { sha256: hash(bytes), bytes: bytes.length }]));
    const manifest = Buffer.from(`${JSON.stringify({ schemaVersion: 1, app: "ave", tag: TAG, commit: COMMIT, files: entries })}\n${" ".repeat(manifestPadding)}`);
    files.set("bundle.json", manifest);
    const sums = Buffer.from([...files].map(([name, bytes]) => `${hash(bytes)}  ${name}\n`).join(""));
    const signature = Buffer.from(`${JSON.stringify({ identity: IDENTITY, issuer: ISSUER, signature: sign(null, sums, keys.privateKey).toString("base64") })}${" ".repeat(signaturePadding)}`);
    files.set("SHA256SUMS", sums);
    files.set("SHA256SUMS.sigstore.json", signature);
    return files;
  };
  const options = (bundle, calls = []) => ({
    root,
    verifySignature: verifier,
    get: async (url, limits) => {
      calls.push({ url, limits });
      const bytes = url.startsWith(BASE) ? bundle.get(url.slice(BASE.length)) : undefined;
      return bytes ? { status: 200, bytes } : { status: 404 };
    },
  });
  const setFile = (name, bytes) => {
    const destination = ARTIFACTS.find(([artifact]) => artifact === name)[1];
    fs.writeFileSync(join(root, destination), bytes);
    const inventoryPath = `${dirname(destination)}/sources.json`;
    const inventory = JSON.parse(fs.readFileSync(join(root, inventoryPath), "utf8"));
    inventory.files[name].sha256 = hash(bytes);
    writeInventory(inventoryPath, inventory);
  };
  return { root, cleanup, publish, verifier, options, setFile, writeInventory, snapshot: () => snapshot(root), readInventory: (path) => JSON.parse(fs.readFileSync(join(root, path), "utf8")) };
}

/** A body with no prefetch: read/cancel telemetry measures exactly what the transport consumed. */
export function response(bytes, { status = 200, headers = {}, chunkBytes = 256 * 1024 } = {}) {
  const data = Buffer.from(bytes);
  const observed = { reads: 0, streamedBytes: 0, arrayBuffers: 0, cancelled: false };
  let offset = 0;
  const reader = {
    async read() {
      observed.reads++;
      if (offset >= data.length) return { done: true };
      const value = data.subarray(offset, Math.min(offset + chunkBytes, data.length));
      offset += value.length;
      observed.streamedBytes += value.length;
      return { done: false, value };
    },
    async cancel() { observed.cancelled = true; },
    releaseLock() {},
  };
  const body = {
    getReader: () => reader,
    cancel: () => reader.cancel(),
    async *[Symbol.asyncIterator]() {
      try {
        while (true) {
          const value = await reader.read();
          if (value.done) return;
          yield value.value;
        }
      } finally { if (offset < data.length) await reader.cancel(); }
    },
  };
  return {
    status, ok: status >= 200 && status < 300, headers: new Headers(headers), body, observed,
    async arrayBuffer() { observed.arrayBuffers++; return data; },
  };
}

/** Model native fetch's automatic redirect behavior so the original transport is exercised too. */
export function fetchBundle(bundle, { routes = new Map(), responseOptions = new Map() } = {}) {
  const calls = [];
  const responses = [];
  const request = async (input, init = {}, hops = 0) => {
    const url = String(input);
    calls.push({ url, redirect: init.redirect });
    const route = routes.get(url);
    if (route?.location) {
      const redirect = response("", { status: route.status ?? 302, headers: { location: route.location } });
      responses.push({ url, response: redirect });
      if (init.redirect !== "manual" && hops < 20) return request(new URL(route.location, url).href, init, hops + 1);
      return redirect;
    }
    const name = url.startsWith(BASE) ? url.slice(BASE.length) : undefined;
    const bytes = route?.bytes ?? bundle.get(name);
    const served = response(bytes ?? "", { status: bytes === undefined ? 404 : 200, ...(responseOptions.get(url) ?? {}) });
    responses.push({ url, response: served });
    return served;
  };
  return { request, calls, responses };
}

/** Baseline-only control: without httpGet, exercise the old full-bundle transport.
 * The old API cannot receive an individual request's URL/limits. A successful
 * full verification is reported as such, never fabricated as a direct HTTP response. */
export async function requestWithBaseline(vendor, f, server, url, limits = {}) {
  if (typeof vendor.httpGet === "function") return vendor.httpGet(url, { ...limits, fetch: server.request });
  const original = globalThis.fetch;
  globalThis.fetch = server.request;
  try {
    const problems = await vendor.verifyVendored({ root: f.root, verifySignature: f.verifier });
    if (problems.length) throw new Error(problems.join("\n"));
    return { baselineWholeBundleVerified: true };
  } finally { globalThis.fetch = original; }
}

export async function verifyWithFetch(vendor, f, server) {
  if (typeof vendor.httpGet === "function") return vendor.verifyVendored({ root: f.root, verifySignature: f.verifier, get: (url, limits) => vendor.httpGet(url, { ...limits, fetch: server.request }) });
  const original = globalThis.fetch;
  globalThis.fetch = server.request;
  try { return await vendor.verifyVendored({ root: f.root, verifySignature: f.verifier }); }
  finally { globalThis.fetch = original; }
}

/** Filesystem fault injection is confined to a child process, never a CLI/environment API. */
async function syncFault(mode) {
  const f = fixture();
  const vendor = await loadVendor(f.root);
  const bundle = f.publish({ replace: Object.fromEntries(ARTIFACTS.map(([name]) => [name, `// replacement ${name}\n`])) });
  const before = f.snapshot();
  const original = fs.writeFileSync;
  const originalRename = fs.renameSync;
  const installed = [];
  const restored = [];
  const writePaths = [];
  let writes = 0;
  let injected = false;
  let error;
  fs.writeFileSync = (path, bytes, ...args) => {
    if (String(path).startsWith(`${f.root}/`)) {
      writes++;
      writePaths.push(relative(f.root, String(path)));
      if (mode === "write-fault" && writes === 2) {
        injected = true;
        throw new Error("injected sync write failure");
      }
      if (mode === "corrupt-stage" && String(path).includes("/.vendor-stage-") && !injected) {
        injected = true;
        return original(path, Buffer.from("corrupted staged bytes\n"), ...args);
      }
    }
    return original(path, bytes, ...args);
  };
  if (mode === "rollback-order") fs.renameSync = (source, destination) => {
    restored.push(relative(f.root, destination));
    originalRename(source, destination);
  };
  syncBuiltinESMExports();
  const options = f.options(bundle);
  if (mode === "corrupt-stage") options.rename = (source, destination) => {
    installed.push(relative(f.root, destination));
    originalRename(source, destination);
  };
  if (mode === "rollback-order") options.rename = (source, destination) => {
    if (destination === join(f.root, INVENTORIES[1])) {
      injected = true;
      throw new Error("injected final inventory replacement failure");
    }
    originalRename(source, destination);
    installed.push(relative(f.root, destination));
  };
  try { await vendor.syncFromBundle(TAG, options); }
  catch (caught) { error = caught.message; }
  finally { fs.writeFileSync = original; fs.renameSync = originalRename; syncBuiltinESMExports(); }
  const result = { before, after: f.snapshot(), writes, writePaths, injected, error, installed, restored };
  f.cleanup();
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await syncFault(process.argv[2]))); }
  catch (error) { console.error(error.stack); process.exitCode = 1; }
}
