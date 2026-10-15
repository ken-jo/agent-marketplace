import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { ARTIFACTS, BASE, COMMIT, INVENTORIES, LIMITS, TAG, fetchBundle, fixture, hash, loadVendor, modulePath, requestWithBaseline, verifyWithFetch } from "./vendor-security-fixture.mjs";

const isLimit = /(?:limit|too large|exceed|maximum|size|bytes)/iu;
const isRedirect = /(?:redirect|origin|https|host|URL|downloads\.agent-connector\.ai)/iu;
const allDestinations = ARTIFACTS.map(([, destination]) => destination);
const installedDestinations = [...allDestinations, ...INVENTORIES];
const readFixture = async (t, options) => {
  const f = fixture(t, options);
  return { f, vendor: await loadVendor(f.root) };
};
const syncFault = (mode) => JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL("./vendor-security-fixture.mjs", import.meta.url)), mode], {
  env: { ...process.env, VENDOR_SECURITY_MODULE: modulePath }, encoding: "utf8",
}));

describe("fixed contract bundle coverage", () => {
  it("accepts the independent five-artifact inventory and signed bundle", async (t) => {
    const { f, vendor } = await readFixture(t);
    assert.deepEqual(vendor.checkVendored({ root: f.root }), []);
    assert.deepEqual(await vendor.verifyVendored(f.options(f.publish())), []);
  });

  for (const [description, change] of [
    ["an omitted checker", (f) => {
      const inventory = f.readInventory("tools/vendor/sources.json");
      delete inventory.files["marketplace-check.js"];
      f.writeInventory("tools/vendor/sources.json", inventory);
    }],
    ["an extra inventory name", (f) => {
      const inventory = f.readInventory("tools/vendor/sources.json");
      const bytes = Buffer.from("// extra\n");
      writeFileSync(join(f.root, "tools/vendor/extra.js"), bytes);
      inventory.files["extra.js"] = { sha256: hash(bytes) };
      f.writeInventory("tools/vendor/sources.json", inventory);
    }],
    ["a checker relocated to the contract inventory", (f) => {
      const from = f.readInventory("tools/vendor/sources.json");
      const to = f.readInventory("contract/sources.json");
      to.files["marketplace-check.js"] = from.files["marketplace-check.js"];
      delete from.files["marketplace-check.js"];
      writeFileSync(join(f.root, "contract/marketplace-check.js"), readFileSync(join(f.root, "tools/vendor/marketplace-check.js")));
      f.writeInventory("contract/sources.json", to);
      f.writeInventory("tools/vendor/sources.json", from);
    }],
    ["a traversal name replacing the checker destination", (f) => {
      const inventory = f.readInventory("tools/vendor/sources.json");
      inventory.files["../marketplace-check.js"] = inventory.files["marketplace-check.js"];
      delete inventory.files["marketplace-check.js"];
      writeFileSync(join(f.root, "tools/marketplace-check.js"), readFileSync(join(f.root, "tools/vendor/marketplace-check.js")));
      f.writeInventory("tools/vendor/sources.json", inventory);
    }],
  ]) {
    it(`rejects ${description} in the offline check`, async (t) => {
      const { f, vendor } = await readFixture(t);
      change(f);
      const problems = vendor.checkVendored({ root: f.root });
      assert.ok(problems.length > 0, `${description} escaped the fixed artifact set`);
      assert.match(problems.join("\n"), /(?:files|inventory|marketplace-check|expected|unexpected|extra)/iu);
    });
  }

  for (const digest of [null, 123, "a".repeat(63), "A".repeat(64)]) {
    it(`rejects an invalid inventory sha256 ${JSON.stringify(digest)}`, async (t) => {
      const { f, vendor } = await readFixture(t);
      const inventory = f.readInventory("contract/sources.json");
      inventory.files["public-contract.ts"].sha256 = digest;
      f.writeInventory("contract/sources.json", inventory);
      assert.ok(vendor.checkVendored({ root: f.root }).length > 0);
    });
  }

  it("refuses a fully signed superset even when every inventory file verifies", async (t) => {
    const { f, vendor } = await readFixture(t);
    const bundle = f.publish({ add: { "unrequested.js": "export const injected = true;\n" } });
    assert.deepEqual(vendor.checkVendored({ root: f.root }), []);
    const problems = await vendor.verifyVendored(f.options(bundle));
    assert.ok(problems.length > 0, "the signed set must equal the code-owned artifact set");
    assert.match(problems.join("\n"), /(?:unrequested|unexpected|exact|files)/iu);
  });

  it("refuses signed verification when an omitted checker entry hides poisoned local bytes", async (t) => {
    const { f, vendor } = await readFixture(t);
    const bundle = f.publish();
    const inventory = f.readInventory("tools/vendor/sources.json");
    delete inventory.files["marketplace-check.js"];
    f.writeInventory("tools/vendor/sources.json", inventory);
    writeFileSync(join(f.root, "tools/vendor/marketplace-check.js"), 'throw new Error("unverified checker marker");\n');
    const problems = await vendor.verifyVendored(f.options(bundle));
    assert.ok(problems.length > 0, "a valid full signed bundle must not authorize unchecked local checker bytes");
    assert.match(problems.join("\n"), /marketplace-check\.js/u);
  });

  it("rejects a signed omission before requesting any artifact payload", async (t) => {
    const { f, vendor } = await readFixture(t);
    const calls = [];
    const problems = await vendor.verifyVendored(f.options(f.publish({ omit: ["marketplace-check.js"] }), calls));
    assert.ok(problems.length > 0);
    assert.match(problems.join("\n"), /marketplace-check\.js/u);
    const payloadCalls = calls.filter(({ url }) => ARTIFACTS.some(([name]) => url === `${BASE}${name}`));
    assert.deepEqual(payloadCalls, [], "coverage is decided before downloading the listed subset");
  });

  it("does not let a matching inventory omission shrink sync coverage", async (t) => {
    const { f, vendor } = await readFixture(t);
    const inventory = f.readInventory("tools/vendor/sources.json");
    delete inventory.files["marketplace-check.js"];
    f.writeInventory("tools/vendor/sources.json", inventory);
    const calls = [];
    const before = f.snapshot();
    await assert.rejects(() => vendor.syncFromBundle(TAG, f.options(f.publish({ omit: ["marketplace-check.js"] }), calls)), /(?:marketplace-check|files|inventory)/iu);
    assert.deepEqual(calls, [], "invalid inventories are refused before network access");
    assert.deepEqual(f.snapshot(), before);
  });

  it("returns only verified bytes keyed by the fixed destinations", async (t) => {
    const { f, vendor } = await readFixture(t);
    const bundle = f.publish();
    const verified = await vendor.readVerifiedVendored(f.options(bundle));
    assert.ok(verified instanceof Map);
    assert.deepEqual([...verified.keys()].sort(), [...allDestinations].sort());
    for (const [name, destination] of ARTIFACTS) assert.deepEqual(verified.get(destination), bundle.get(name));
    writeFileSync(join(f.root, ARTIFACTS[0][1]), "changed after verification\n");
    assert.deepEqual(verified.get(ARTIFACTS[0][1]), bundle.get(ARTIFACTS[0][0]));
  });

  it("allows explicit commit-pin development integrity but keeps tag signature verification mandatory", async (t) => {
    const { f, vendor } = await readFixture(t, { ref: COMMIT });
    await assert.rejects(() => vendor.readVerifiedVendored({ root: f.root }), /(?:development|commit|release|tag)/iu);
    const bytes = await vendor.readVerifiedVendored({ root: f.root, allowDevelopment: true });
    assert.deepEqual([...bytes.keys()].sort(), [...allDestinations].sort());
    for (const path of INVENTORIES) {
      const inventory = f.readInventory(path);
      inventory.ref = TAG;
      inventory.bundle = BASE;
      f.writeInventory(path, inventory);
    }
    let attempts = 0;
    await assert.rejects(() => vendor.readVerifiedVendored({ ...f.options(f.publish()), allowDevelopment: true, verifySignature: () => { attempts++; throw new Error("signature refused"); } }), /signature/iu);
    assert.equal(attempts, 1);
  });
});

describe("bounded contract bundle transport", () => {
  it("rejects excessive Content-Length before reading a body", async (t) => {
    const { f, vendor } = await readFixture(t);
    f.bundle = f.publish();
    const url = `${BASE}public-contract.ts`;
    const server = fetchBundle(f.bundle, { responseOptions: new Map([[url, { headers: { "content-length": String(LIMITS.fileBytes + 1) } }]]) });
    await assert.rejects(() => requestWithBaseline(vendor, f, server, url), isLimit);
    const served = server.responses.find((entry) => entry.url === url).response.observed;
    assert.equal(served.reads, 0);
    assert.equal(served.arrayBuffers, 0);
  });

  it("stops an oversized stream before concatenating response chunks", async (t) => {
    const { f, vendor } = await readFixture(t);
    const oversized = Buffer.alloc(LIMITS.fileBytes + 1024 * 1024, 120);
    f.bundle = f.publish({ replace: { "public-contract.ts": oversized } });
    f.setFile("public-contract.ts", oversized);
    const url = `${BASE}public-contract.ts`;
    const server = fetchBundle(f.bundle);
    const original = Buffer.concat;
    let concatenations = 0;
    Buffer.concat = (...args) => { concatenations++; return original(...args); };
    try { await assert.rejects(() => requestWithBaseline(vendor, f, server, url), isLimit); }
    finally { Buffer.concat = original; }
    const served = server.responses.find((entry) => entry.url === url).response.observed;
    assert.ok(served.streamedBytes < oversized.length, "the unread stream tail must remain unread");
    assert.equal(served.arrayBuffers, 0);
    assert.equal(served.cancelled, true);
    assert.equal(concatenations, 0, "a rejected stream is never concatenated");
  });

  for (const [name, bytes, option] of [
    ["bundle.json", LIMITS.metadataBytes, "manifestPadding"],
    ["SHA256SUMS.sigstore.json", LIMITS.signatureBytes, "signaturePadding"],
  ]) {
    it(`applies the smaller ${name} byte cap while streaming`, async (t) => {
      const { f, vendor } = await readFixture(t);
      f.bundle = f.publish({ [option]: bytes + 1 });
      const url = `${BASE}${name}`;
      const server = fetchBundle(f.bundle);
      await assert.rejects(() => requestWithBaseline(vendor, f, server, url, { maxBytes: bytes }), isLimit);
      const served = server.responses.find((entry) => entry.url === url).response.observed;
      assert.equal(served.arrayBuffers, 0);
      assert.equal(served.cancelled, true);
      const problems = await verifyWithFetch(vendor, f, fetchBundle(f.bundle));
      assert.ok(problems.length > 0, "the bundle reader must select the metadata-specific cap");
      assert.match(problems.join("\n"), isLimit);
    });
  }

  it("applies the 64 KiB SHA256SUMS cap before parsing or signature verification", async (t) => {
    const { f, vendor } = await readFixture(t);
    const extra = Object.fromEntries(Array.from({ length: 900 }, (_, index) => [`extra-${String(index).padStart(4, "0")}.js`, "// signed extra\n"]));
    f.bundle = f.publish({ add: extra });
    assert.ok(f.bundle.get("SHA256SUMS").length > LIMITS.metadataBytes);
    const url = `${BASE}SHA256SUMS`;
    const server = fetchBundle(f.bundle);
    await assert.rejects(() => requestWithBaseline(vendor, f, server, url, { maxBytes: LIMITS.metadataBytes }), isLimit);
    assert.equal(server.responses.find((entry) => entry.url === url).response.observed.arrayBuffers, 0);
    let signatures = 0;
    const options = f.options(f.bundle);
    options.verifySignature = () => { signatures++; };
    const problems = await vendor.verifyVendored(options);
    assert.ok(problems.length > 0);
    assert.match(problems.join("\n"), isLimit);
    assert.equal(signatures, 0);
  });

  it("rejects the remaining aggregate budget before concatenating the next file", async (t) => {
    const { f, vendor } = await readFixture(t);
    const payload = Buffer.alloc(3 * 1024 * 1024, 120);
    f.bundle = f.publish({ replace: { "public-contract.ts": payload } });
    f.setFile("public-contract.ts", payload);
    const url = `${BASE}public-contract.ts`;
    const server = fetchBundle(f.bundle);
    const original = Buffer.concat;
    let concatenations = 0;
    Buffer.concat = (...args) => { concatenations++; return original(...args); };
    try { await assert.rejects(() => requestWithBaseline(vendor, f, server, url, { remainingBytes: 2 * 1024 * 1024 }), isLimit); }
    finally { Buffer.concat = original; }
    assert.equal(concatenations, 0);
    const observed = server.responses.find((entry) => entry.url === url).response.observed;
    assert.ok(observed.streamedBytes < payload.length);
    assert.equal(observed.cancelled, true);
  });

  it("counts metadata against the 20 MiB aggregate budget", async (t) => {
    const { f, vendor } = await readFixture(t);
    for (const [name] of ARTIFACTS) f.setFile(name, Buffer.alloc(LIMITS.totalBytes / ARTIFACTS.length, 120));
    const bundle = f.publish();
    const server = fetchBundle(bundle);
    const problems = await verifyWithFetch(vendor, f, server);
    assert.ok(problems.length > 0, "20 MiB of payload plus metadata must exceed the total cap");
    assert.match(problems.join("\n"), isLimit);
    assert.ok(server.responses.some(({ response: served }) => served.observed.cancelled), "the body that crosses the remaining total budget is cancelled");
    assert.ok(server.responses.every(({ response: served }) => served.observed.arrayBuffers === 0));
  });

  for (const location of [
    "http://downloads.agent-connector.ai/contract/v0.14.0/mirror-sums",
    "https://attacker.example/SHA256SUMS",
    "https://downloads.agent-connector.ai:444/SHA256SUMS",
    "//attacker.example/SHA256SUMS",
  ]) {
    it(`refuses a redirect to ${location} without fetching its target`, async (t) => {
      const { f, vendor } = await readFixture(t);
      f.bundle = f.publish();
      const url = `${BASE}SHA256SUMS`;
      const target = new URL(location, url).href;
      const server = fetchBundle(f.bundle, { routes: new Map([[url, { location }], [target, { bytes: f.bundle.get("SHA256SUMS") }]]) });
      await assert.rejects(() => requestWithBaseline(vendor, f, server, url), isRedirect);
      assert.deepEqual(server.calls.map(({ url: called }) => called), [url]);
    });
  }

  it("accepts exactly three HTTPS redirects on the permitted origin using manual fetch", async (t) => {
    const { f, vendor } = await readFixture(t);
    f.bundle = f.publish();
    const url = `${BASE}SHA256SUMS`;
    const routes = new Map([
      [url, { location: "redirect-1" }],
      [`${BASE}redirect-1`, { location: `${BASE}redirect-2`, status: 307 }],
      [`${BASE}redirect-2`, { location: "/contract/v0.14.0/redirect-3", status: 308 }],
      [`${BASE}redirect-3`, { bytes: f.bundle.get("SHA256SUMS") }],
    ]);
    const server = fetchBundle(f.bundle, { routes });
    const result = await requestWithBaseline(vendor, f, server, url);
    assert.ok(server.calls.every(({ redirect }) => redirect === "manual"), "native fetch must not follow an unvalidated redirect");
    assert.deepEqual(result.bytes, f.bundle.get("SHA256SUMS"));
    assert.equal(server.calls.length, LIMITS.redirects + 1);
  });

  it("refuses a fourth redirect before requesting a fifth URL", async (t) => {
    const { f, vendor } = await readFixture(t);
    f.bundle = f.publish();
    const url = `${BASE}SHA256SUMS`;
    const urls = [url, ...Array.from({ length: 4 }, (_, index) => `${BASE}redirect-${index + 1}`)];
    const routes = new Map(urls.slice(0, -1).map((from, index) => [from, { location: urls[index + 1] }]));
    routes.set(urls.at(-1), { bytes: f.bundle.get("SHA256SUMS") });
    const server = fetchBundle(f.bundle, { routes });
    await assert.rejects(() => requestWithBaseline(vendor, f, server, url), isRedirect);
    assert.equal(server.calls.length, LIMITS.redirects + 1);
  });

  it("refuses an invalid starting origin before calling fetch", async (t) => {
    const { vendor } = await readFixture(t);
    assert.equal(typeof vendor.httpGet, "function", "production transport must expose its function-only fetch seam");
    let calls = 0;
    for (const url of ["http://downloads.agent-connector.ai/file", "https://attacker.example/file"]) {
      await assert.rejects(() => vendor.httpGet(url, { fetch: async () => { calls++; throw new Error("fetch must not be reached"); } }), isRedirect);
    }
    assert.equal(calls, 0);
  });
});

describe("transactional contract bundle sync", () => {
  it("stages every artifact and installs both inventories last", async (t) => {
    const { f, vendor } = await readFixture(t);
    const bundle = f.publish({ replace: Object.fromEntries(ARTIFACTS.map(([name]) => [name, `// synced ${name}\n`])) });
    const destinations = [];
    const options = f.options(bundle);
    options.rename = (source, destination) => {
      assert.ok(source.startsWith(`${f.root}/.vendor-stage-`), "install source belongs to the destination filesystem staging directory");
      destinations.push(destination.slice(f.root.length + 1));
      renameSync(source, destination);
    };
    await vendor.syncFromBundle(TAG, options);
    assert.equal(destinations.length, installedDestinations.length);
    assert.deepEqual(destinations.slice(0, ARTIFACTS.length).sort(), [...allDestinations].sort());
    assert.deepEqual(destinations.slice(ARTIFACTS.length).sort(), [...INVENTORIES].sort());
    for (const [name, destination] of ARTIFACTS) assert.deepEqual(readFileSync(join(f.root, destination)), bundle.get(name));
    assert.deepEqual(vendor.checkVendored({ root: f.root }), []);
    assert.ok(Object.keys(f.snapshot()).every((path) => !path.startsWith(".vendor-stage-")));
  });

  for (const failedDestination of [ARTIFACTS[0][1], ARTIFACTS[2][1], ...INVENTORIES]) {
    it(`restores original bytes after replacement of ${failedDestination} fails`, async (t) => {
      const { f, vendor } = await readFixture(t);
      const bundle = f.publish({ replace: Object.fromEntries(ARTIFACTS.map(([name]) => [name, `// replacement ${name}\n`])) });
      const before = f.snapshot();
      const attempted = [];
      const options = f.options(bundle);
      options.rename = (source, destination) => {
        const path = destination.slice(f.root.length + 1);
        attempted.push(path);
        if (path === failedDestination) throw new Error(`injected rename failure: ${path}`);
        renameSync(source, destination);
      };
      await assert.rejects(() => vendor.syncFromBundle(TAG, options), /injected rename failure/u);
      assert.ok(attempted.includes(failedDestination));
      assert.deepEqual(f.snapshot(), before, "artifacts, inventory bytes, and directory contents all roll back");
    });
  }

  it("removes originally missing destinations when the final inventory replacement fails", async (t) => {
    const { f, vendor } = await readFixture(t);
    const bundle = f.publish({ replace: Object.fromEntries(ARTIFACTS.map(([name]) => [name, `// replacement ${name}\n`])) });
    const missing = [ARTIFACTS[1][1], ARTIFACTS[3][1]];
    for (const path of missing) rmSync(join(f.root, path));
    const before = f.snapshot();
    const options = f.options(bundle);
    options.rename = (source, destination) => {
      if (destination === join(f.root, INVENTORIES[1])) {
        for (const path of missing) assert.equal(existsSync(join(f.root, path)), true, "missing destinations were installed before inventory replacement");
        throw new Error("injected final inventory rename failure");
      }
      renameSync(source, destination);
    };
    await assert.rejects(() => vendor.syncFromBundle(TAG, options), /injected final inventory rename failure/u);
    assert.deepEqual(f.snapshot(), before);
    for (const path of missing) assert.equal(existsSync(join(f.root, path)), false);
  });

  it("preserves a dangling destination symlink by refusing sync before any replacement", async (t) => {
    const { f, vendor } = await readFixture(t);
    const bundle = f.publish({ replace: Object.fromEntries(ARTIFACTS.map(([name]) => [name, `// replacement ${name}\n`])) });
    const path = join(f.root, "contract/public-contract.ts");
    const target = "missing-public-contract.ts";
    const otherFiles = installedDestinations.filter((destination) => join(f.root, destination) !== path)
      .map((destination) => [destination, readFileSync(join(f.root, destination))]);
    rmSync(path);
    symlinkSync(target, path);
    const originalLink = lstatSync(path);
    assert.equal(existsSync(path), false, "the link exists but its target is absent");
    const replacements = [];
    const options = f.options(bundle);
    options.rename = (source, destination) => {
      replacements.push(destination);
      if (destination === join(f.root, "contract/plugin-manifest.schema.json")) throw new Error("injected later replacement failure");
      renameSync(source, destination);
    };
    let error;
    try { await vendor.syncFromBundle(TAG, options); }
    catch (caught) { error = caught; }
    const retained = lstatSync(path, { throwIfNoEntry: false });
    assert.ok(retained?.isSymbolicLink(), "the original dangling symlink must survive refusal");
    assert.equal(retained.ino, originalLink.ino, "the existing link itself is retained");
    assert.equal(readlinkSync(path), target);
    assert.match(error?.message ?? "sync unexpectedly succeeded", /destination must be a regular file/u);
    assert.deepEqual(replacements, [], "all present nonregular destinations are refused before replacement");
    for (const [destination, bytes] of otherFiles) assert.deepEqual(readFileSync(join(f.root, destination)), bytes);
    assert.ok(readdirSync(f.root).every((name) => !name.startsWith(".vendor-stage-")));
  });

  it("preserves the checkout and removes staging after a stage write failure", () => {
    const result = syncFault("write-fault");
    assert.equal(result.injected, true);
    assert.match(result.error, /injected sync write failure/u);
    assert.deepEqual(result.after, result.before, "a later write failure must not leave an earlier payload replaced");
    assert.match(result.writePaths[1], /^\.vendor-stage-/u, "the failing production write belongs to staging");
  });

  it("validates staged bytes before installing any artifact", () => {
    const result = syncFault("corrupt-stage");
    assert.equal(result.injected, true, "staged write was observed");
    assert.match(result.error, /(?:staged|sha256|bytes|integrity|changed|mismatch|differ)/iu);
    assert.deepEqual(result.installed, [], "staged integrity is checked before the first destination replacement");
    assert.deepEqual(result.after, result.before);
  });

  it("restores successfully installed destinations in reverse order", () => {
    const result = syncFault("rollback-order");
    assert.equal(result.injected, true);
    assert.match(result.error, /injected final inventory replacement failure/u);
    assert.equal(result.installed.length, installedDestinations.length - 1);
    assert.deepEqual(result.restored, [...result.installed].reverse());
    assert.deepEqual(result.after, result.before);
  });

  it("writes nothing from a bundle with invalid artifact bytes", async (t) => {
    const { f, vendor } = await readFixture(t);
    const bundle = f.publish();
    bundle.set("marketplace-check.js", Buffer.from("// changed after signing\n"));
    const before = f.snapshot();
    await assert.rejects(() => vendor.syncFromBundle(TAG, f.options(bundle)), /sha256/u);
    assert.deepEqual(f.snapshot(), before);
  });
});
