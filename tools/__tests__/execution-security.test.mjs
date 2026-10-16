/** Execution and workflow trust regressions. Set MARKETPLACE_BASELINE_REF to
 * exercise the original entry points/workflows from a git revision. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { testKeys, testSignature } from "./fake-sigstore.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const BASELINE = process.env.MARKETPLACE_BASELINE_REF;
const scratch = [];
after(() => scratch.forEach((path) => rmSync(path, { recursive: true, force: true })));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ARTIFACTS = ["contract/public-contract.ts", "contract/plugin-manifest.schema.json", "contract/protocol.schema.json", "tools/vendor/marketplace-check.js", "tools/vendor/agent-plugin-components.js"];
const INVENTORIES = ["contract/sources.json", "tools/vendor/sources.json"];
const TAG = "v0.14.0";
const BUNDLE = `https://downloads.agent-connector.ai/contract/${TAG}/`;
const IDENTITY = `https://github.com/ken-jo/ave/.github/workflows/build-installers.yml@refs/tags/${TAG}`;
const ISSUER = "https://token.actions.githubusercontent.com";
const source = (path) => BASELINE
  ? execFileSync("git", ["-C", ROOT, "show", `${BASELINE}:${path}`], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 8 * 1024 * 1024 })
  : readFileSync(join(ROOT, path));
const poison = '\nimport { writeFileSync as __poisonWrite } from "node:fs"; __poisonWrite(process.env.MARKETPLACE_POISON_MARKER, "executed");\n';
function write(root, path, bytes) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
}
function fixture() {
  // Module imports canonicalize paths, including macOS's /var symlink.
  // Match that spelling so CLI guards behave the same here and on Linux.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "marketplace-execution-")));
  scratch.push(root);
  for (const path of [...ARTIFACTS, ...INVENTORIES, "tools/check.mjs", "tools/repo.mjs", "tools/release.mjs", "tools/vendor.mjs"]) write(root, path, source(path));
  if (!BASELINE) write(root, "tools/verified-import.mjs", source("tools/verified-import.mjs"));
  // The fixture is a development-pinned checkout whatever the repository itself pins;
  // signedBundle() turns it into a tag-pinned one when a test needs the signed path.
  for (const path of INVENTORIES) {
    const inventory = JSON.parse(readFileSync(join(root, path), "utf8"));
    inventory.ref = "a".repeat(40);
    inventory.bundle = null;
    write(root, path, JSON.stringify(inventory));
  }
  write(root, "package.json", '{"type":"module"}\n');
  write(root, "marketplace.json", '{"schemaVersion":2,"name":"ave","packages":[]}\n');
  return root;
}
function child(root, script, args = [], env = {}) {
  const environment = { ...process.env, ...env };
  delete environment.MARKETPLACE_ROOT;
  return spawnSync(process.execPath, [join(root, "tools", script), ...args], { cwd: root, env: environment, encoding: "utf8", timeout: 20_000 });
}
function signedBundle(root) {
  const served = mkdtempSync(join(tmpdir(), "marketplace-execution-bundle-"));
  scratch.push(served);
  const keys = testKeys();
  const schema = JSON.parse(readFileSync(join(root, "contract/protocol.schema.json"), "utf8"));
  schema.$id = `https://ave.agent-connector.ai/schemas/plugin-host-protocol/3/${TAG}/protocol.schema.json`;
  schema.title = "Ave plugin host protocol 3";
  write(root, "contract/protocol.schema.json", JSON.stringify(schema));
  for (const path of INVENTORIES) {
    const inventory = JSON.parse(readFileSync(join(root, path), "utf8"));
    inventory.ref = TAG;
    inventory.bundle = BUNDLE;
    for (const [name, entry] of Object.entries(inventory.files)) entry.sha256 = hash(readFileSync(join(root, dirname(path), name)));
    write(root, path, JSON.stringify(inventory));
  }
  const files = {};
  for (const path of ARTIFACTS) {
    const bytes = readFileSync(join(root, path));
    const name = path.split("/").at(-1);
    write(served, `${TAG}/${name}`, bytes);
    files[name] = { sha256: hash(bytes), bytes: bytes.length };
  }
  const manifest = JSON.stringify({ schemaVersion: 1, app: "ave", tag: TAG, commit: "a".repeat(40), files });
  write(served, `${TAG}/bundle.json`, manifest);
  const sums = [["bundle.json", hash(manifest)], ...Object.entries(files).map(([name, entry]) => [name, entry.sha256])].map(([name, digest]) => `${digest}  ${name}\n`).join("");
  write(served, `${TAG}/SHA256SUMS`, sums);
  write(served, `${TAG}/SHA256SUMS.sigstore.json`, testSignature(keys.privateKey, Buffer.from(sums), IDENTITY, ISSUER));
  return { served, keys };
}
function initialization(root, bundle) {
  return `const t = await import(${JSON.stringify(join(ROOT, "tools/__tests__/fake-sigstore.mjs"))});
    const loader = await import(${JSON.stringify(join(root, "tools/verified-import.mjs"))});
    const state = await loader.verifiedRuntime({ allowDevelopment: false,
      get: t.servedFrom(${JSON.stringify(bundle.served)}, []), verifySignature: t.testVerifier(${JSON.stringify(bundle.keys.publicKey)}) });`;
}
function jobs(name) {
  const workflow = source(`.github/workflows/${name}.yml`).toString();
  return new Map([...workflow.matchAll(/^  ([a-z][a-z-]*):\n((?:(?!^  [a-z][a-z-]*:)[\s\S])*)/gmu)].map((match) => [match[1], match[2]]));
}
function steps(job) {
  return job.split(/^      - /mu).slice(1).map((text) => ({
    text,
    name: /^name: (.*)$/mu.exec(text)?.[1],
    condition: /^        if: (.*)$/mu.exec(text)?.[1],
    cwd: /^        working-directory: (.*)$/mu.exec(text)?.[1],
    run: /^        run: \|\n((?:          [^\n]*\n?)+)/mu.exec(text)?.[1]?.replace(/^          /gmu, "") ?? /^        run: (.*)$/mu.exec(text)?.[1],
  }));
}
function allowedAfterFailure(condition) {
  if (!condition) return false; // Actions defaults to success().
  const expression = condition.replace(/^\$\{\{\s*|\s*\}\}$/gu, "").trim();
  if (expression === "success()") return false;
  if (expression === "!cancelled()" || expression === "always()") return true;
  throw new Error(`unreviewed workflow trust condition: ${condition}`);
}

describe("vendored execution trust", () => {
  for (const [script, artifact] of [
    ["check.mjs", "tools/vendor/marketplace-check.js"],
    ["repo.mjs", "tools/vendor/agent-plugin-components.js"],
    ["release.mjs", "tools/vendor/marketplace-check.js"],
  ]) {
    it(`${script} rejects edited executable bytes before a poisoned module runs`, () => {
      const root = fixture();
      const marker = join(root, "poisoned");
      write(root, artifact, Buffer.concat([readFileSync(join(root, artifact)), Buffer.from(poison)]));
      const result = child(root, script, script === "release.mjs" ? ["plan"] : [], { MARKETPLACE_POISON_MARKER: marker });
      assert.equal(existsSync(marker), false, `${script} evaluated rejected vendored code`);
      assert.notEqual(result.status, 0, result.stderr);
      assert.match(result.stderr, /bytes differ from sources\.json/u);
    });
  }

  it("rejects a poisoned extractor before the checker can evaluate, including on repository import", () => {
    const root = fixture();
    const marker = join(root, "poisoned");
    write(root, "tools/vendor/agent-plugin-components.js", Buffer.concat([readFileSync(join(root, "tools/vendor/agent-plugin-components.js")), Buffer.from(poison)]));
    const result = child(root, "check.mjs", [], { MARKETPLACE_POISON_MARKER: marker });
    assert.equal(existsSync(marker), false, "a rejected dependency evaluated before the check");
    assert.notEqual(result.status, 0);
  });

  it("has no direct vendored JavaScript imports in tools or their tests", () => {
    for (const path of ["tools/check.mjs", "tools/repo.mjs", "tools/release.mjs", "tools/__tests__/tools.test.mjs"]) {
      assert.doesNotMatch(source(path).toString(), /(?:from\s*|import\s*\()["'][^"']*vendor\/(?:marketplace-check|agent-plugin-components)\.js["']/u, path);
    }
  });

  it("publication rejects development trust before even a matching-hash poison module evaluates", () => {
    const root = fixture();
    const marker = join(root, "poisoned");
    const path = "tools/vendor/marketplace-check.js";
    const bytes = Buffer.concat([readFileSync(join(root, path)), Buffer.from(poison)]);
    write(root, path, bytes);
    const inventory = JSON.parse(readFileSync(join(root, "tools/vendor/sources.json"), "utf8"));
    inventory.files["marketplace-check.js"].sha256 = hash(bytes);
    write(root, "tools/vendor/sources.json", JSON.stringify(inventory));
    const result = child(root, "release.mjs", ["plan", "--publish"], { MARKETPLACE_POISON_MARKER: marker });
    assert.equal(existsSync(marker), false, "release evaluated development code before refusing publication");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /publication requires an Ave release tag/u);
  });
});

describe("workflow trust dependencies", () => {
  it("a failed signed verification prevents published release verification", () => {
    const published = steps(jobs("validate").get("published"));
    const trust = published.findIndex((step) => /node tools\/vendor\.mjs verify(?:\n|$)/u.test(step.run ?? ""));
    const consumer = published.findIndex((step) => /node tools\/release\.mjs verify --publish/u.test(step.run ?? ""));
    assert.ok(trust >= 0 && consumer > trust, "published must verify its own checkout first");
    assert.equal(allowedAfterFailure(published[consumer].condition), false, "published consumer runs after failed signed verification");
  });

  it("every consuming checkout verifies locally before running tools or plugin contract imports", () => {
    for (const [workflow, name, development] of [
      ["validate", "marketplace", true], ["validate", "plugin", true], ["validate", "published", false],
      ["release", "plan", false], ["release", "build", false], ["release", "publish", false],
    ]) {
      const list = steps(jobs(workflow).get(name));
      const trust = list.findIndex((step) => development
        ? /node tools\/verified-import\.mjs check --allow-development(?:\n|$)/u.test(step.run ?? "")
        : /node tools\/vendor\.mjs verify(?:\n|$)/u.test(step.run ?? ""));
      assert.ok(trust >= 0, `${workflow}/${name} lacks a local ${development ? "explicit development" : "signed"} trust gate`);
      assert.equal(allowedAfterFailure(list[trust].condition), false, `${workflow}/${name} trust step may run after a previous failure`);
      const consumer = list.findIndex((step) => /release\.mjs|index\.mjs|verified-import\.mjs plugin|bun (?:install|run)|gh release create/u.test(step.run ?? ""));
      assert.ok(consumer > trust, `${workflow}/${name} consumes vendored bytes before verification`);
      for (const step of list.slice(trust + 1).filter((step) => step.run)) assert.equal(allowedAfterFailure(step.condition), false, `${workflow}/${name}/${step.name} bypasses a failed trust gate`);
    }
  });

  it("build scripts cannot replace the checker or downgrade inventory trust before packing", () => {
    const root = fixture();
    const marker = join(root, "poisoned");
    const bundle = signedBundle(root);
    write(root, "plugins/alpha/source/plugin.json", JSON.stringify({ name: "alpha", version: "1.0.0", extensions: { "ai.agent-connector.ave": { entry: "dist/index.js", capabilities: [], requires: { minAppVersion: "0.10.0" } } } }));
    write(root, "plugins/alpha/source/package.json", '{"name":"alpha","version":"1.0.0","files":["dist"]}\n');
    write(root, "plugins/alpha/source/dist/index.js", "export default {};\n");
    write(root, "tools/plugin-build/package.json", '{"name":"helper"}\n');
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
    const bin = join(root, "bin");
    mkdirSync(bin);
    const mutation = `
      import { existsSync, readFileSync, writeFileSync } from "node:fs";
      import { createHash } from "node:crypto";
      import { join } from "node:path";
      const root = ${JSON.stringify(root)};
      if (!existsSync(join(root, "mutated"))) {
        writeFileSync(join(root, "mutated"), "yes");
        const path = join(root, "tools/vendor/marketplace-check.js");
        const bytes = readFileSync(path, "utf8") + ${JSON.stringify(poison)};
        writeFileSync(path, bytes);
        for (const name of ${JSON.stringify(INVENTORIES)}) {
          const path = join(root, name); const sources = JSON.parse(readFileSync(path, "utf8"));
          sources.ref = "d".repeat(40); sources.bundle = null;
          if (sources.files["marketplace-check.js"]) sources.files["marketplace-check.js"].sha256 = createHash("sha256").update(bytes).digest("hex");
          writeFileSync(path, JSON.stringify(sources));
        }
        writeFileSync(join(root, "tools/release.mjs"), readFileSync(join(root, "tools/release.mjs"), "utf8") + ${JSON.stringify(poison)});
      }`;
    write(root, "bin/mutate.mjs", mutation);
    write(root, "bin/bun", `#!${process.execPath}\nawait import(${JSON.stringify(join(bin, "mutate.mjs"))});\n`);
    write(root, "bin/node", `#!${process.execPath}\nconst target = process.argv[2]; process.argv = [process.execPath, target, ...process.argv.slice(3)];\n${BASELINE ? "" : initialization(root, bundle)}\nawait import(target.startsWith("/") ? target : ${JSON.stringify(root + "/")} + target);\n`);
    execFileSync("chmod", ["+x", join(bin, "bun"), join(bin, "node")]);
    const build = steps(jobs("release").get("build")).filter((step) => /Build and test|^Pack$|Build, test and pack/u.test(step.name ?? ""));
    assert.ok(build.length > 0);
    let result;
    for (const step of build) {
      const cwd = step.cwd?.replaceAll("${{ matrix.release.name }}", "alpha");
      result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run], { cwd: cwd ? join(root, cwd) : root,
        env: { ...process.env, MARKETPLACE_ROOT: undefined, PATH: `${bin}:${process.env.PATH}`, NAME: "alpha", ASSET: "alpha-1.0.0.zip", GITHUB_OUTPUT: join(root, "output"), MARKETPLACE_POISON_MARKER: marker }, encoding: "utf8", timeout: 20_000 });
      if (result.status !== 0) break;
    }
    assert.equal(existsSync(marker), false, "separate pack process evaluated a checker/build script that replaced trusted code");
    assert.notEqual(result.status, 0, "a changed checker/inventory was accepted for packing");
    assert.match(result.stderr, /changed after vendored verification/u);
    assert.equal(existsSync(join(root, "out/alpha-1.0.0.zip")), false);
  });
});

it("a successful resident build prints only its hash while child logs remain on stderr", () => {
  const root = fixture();
  const bundle = signedBundle(root);
  write(root, "plugins/alpha/source/plugin.json", JSON.stringify({ name: "alpha", version: "1.0.0", extensions: { "ai.agent-connector.ave": { entry: "dist/index.js", capabilities: [], requires: { minAppVersion: "0.10.0" } } } }));
  write(root, "plugins/alpha/source/package.json", '{"name":"alpha","version":"1.0.0","files":["dist"]}\n');
  write(root, "plugins/alpha/source/dist/index.js", "export default {};\n");
  write(root, "tools/plugin-build/package.json", '{"name":"helper"}\n');
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
  const code = `
    import assert from "node:assert/strict";
    import { execFileSync } from "node:child_process";
    import { readFileSync, realpathSync, statSync } from "node:fs";
    // Exercise the function API with its signed runtime and injected executor.
    // CLI argv would execute a second build during the module import below.
    ${initialization(root, bundle)}
    const m = await import(${JSON.stringify(join(root, "tools/release.mjs"))});
    let checkedContract = false;
    const result = await m.build("alpha", ${JSON.stringify(join(root, "alpha.zip"))}, { execute: (program, args, options) => {
      execFileSync(process.execPath, ["-e", "console.log('third-party build log')"], options);
      if (args[0] === "run") {
        const path = realpathSync(options.cwd + "/node_modules/@ave/plugin-contract/public-contract.ts");
        assert.ok(!path.startsWith(${JSON.stringify(root + "/")}));
        assert.equal(statSync(path).mode & 0o222, 0);
        assert.deepEqual(readFileSync(path), readFileSync(${JSON.stringify(join(root, "contract/public-contract.ts"))}));
        checkedContract = true;
      }
    } });
    assert.equal(checkedContract, true, "build must exercise the verified contract snapshot");
    console.log(result);`;
  const env = { ...process.env }; delete env.MARKETPLACE_ROOT;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^[0-9a-f]{64}\n$/u);
  assert.match(result.stderr, /third-party build log/u);
});

for (const target of ["dependency link", "snapshot bytes"]) {
  it(`rejects ${target} replaced by a plugin script, including after the final command`, () => {
    const root = fixture();
    const bundle = signedBundle(root);
    const marker = join(root, "poisoned");
    write(root, "tools/plugin-build/package.json", '{"name":"helper"}\n');
    write(root, "poison-contract/public-contract.ts", poison);
    const code = `
      import { execFileSync } from "node:child_process";
      import { chmodSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
      ${initialization(root, bundle)}
      const commands = [];
      let error;
      try {
        await loader.runPluginChecks("tools/plugin-build", { helperOnly: true, execute(program, args, options) {
          commands.push(args.join(" "));
          const link = options.cwd + "/node_modules/@ave/plugin-contract";
          if (${JSON.stringify(target)} === "dependency link" && args[1] === "typecheck") {
            rmSync(link);
            symlinkSync(${JSON.stringify(join(root, "poison-contract"))}, link, "dir");
          } else if (${JSON.stringify(target)} === "snapshot bytes" && args[1] === "test") {
            const file = realpathSync(link) + "/public-contract.ts";
            chmodSync(file, 0o600);
            writeFileSync(file, "// replaced after the final command");
          } else if (args[1] === "test") {
            execFileSync(process.execPath, ["--input-type=module", "-e", "await import(" + JSON.stringify(link + "/public-contract.ts") + ")"]);
          }
        } });
      } catch (e) { error = e.message; }
      console.log(JSON.stringify({ error, commands }));`;
    const env = { ...process.env, MARKETPLACE_POISON_MARKER: marker }; delete env.MARKETPLACE_ROOT;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.match(output.error, target === "dependency link" ? /verified contract dependency link changed/u : /verified contract snapshot public-contract\.ts: changed/u);
    assert.equal(existsSync(marker), false, "a replacement contract package was evaluated");
    assert.equal(output.commands.includes("run test"), target === "snapshot bytes");
  });
}

it("rejects helper mode on a plugin before its unchecked contract dependency can run", () => {
  const root = fixture();
  const bundle = signedBundle(root);
  const marker = join(root, "poisoned");
  write(root, "tools/plugin-build/package.json", '{"name":"helper"}\n');
  write(root, "plugins/alpha/source/package.json", '{"name":"alpha"}\n');
  const dependency = "plugins/alpha/source/node_modules/@ave/plugin-contract/public-contract.mjs";
  write(root, dependency, poison);
  const code = `
    import { execFileSync } from "node:child_process";
    ${initialization(root, bundle)}
    const commands = [];
    let error;
    try {
      await loader.runPluginChecks("plugins/alpha/source", { helperOnly: true, execute(program, args, options) {
        commands.push(args.join(" "));
        if (args[0] === "run") execFileSync(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(`await import(${JSON.stringify(join(root, dependency))});`)}], options);
      } });
    } catch (e) { error = e.message; }
    console.log(JSON.stringify({ error, commands }));`;
  const env = { ...process.env, MARKETPLACE_POISON_MARKER: marker }; delete env.MARKETPLACE_ROOT;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(existsSync(marker), false, "helper mode evaluated the plugin's unchecked contract dependency");
  assert.match(output.error, /--helper requires the tools\/plugin-build directory/u);
  assert.deepEqual(output.commands, [], "invalid helper mode must be rejected before any install or script");
});
