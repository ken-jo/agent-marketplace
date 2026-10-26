import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkPins, connectors } from "../connector-pins.mjs";
import { findRuntime, installEnvironment, readPin, runInstaller, safeSpawn, secretEnvironment, validateNpmLock } from "../connector-runtime.mjs";
import { installPolicy } from "../connector-policy.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const server = (id) => join(root, "mcp", id, "server");
const pin = (id) => JSON.parse(readFileSync(join(server(id), "runtime.json"), "utf8"));
const secretFor = (p, marker = "synthetic-private-token") => p.secret.fields
  ? JSON.stringify(Object.fromEntries(Object.keys(p.secret.fields).map((k) => [k, marker]))) : marker;
const temporary = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "ave-connector-test-"));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test("all ten packages enforce reviewed inventories and complete hash locks", checkPins);

test("every secret boundary rejects controls, including JSON-escaped NUL", () => {
  for (const id of connectors) {
    const p = pin(id);
    for (const c of ["\0", "\t", "\n", "\r", "\x1b", "\x7f", "\u0085", "\u202e", "\u2028"]) {
      assert.throws(() => secretEnvironment(p, { [p.secret.env]: secretFor(p, "synthetic-private-token" + c) }),
        (e) => !e.message.includes("synthetic-private-token"), id);
    }
  }
});

test("Trello's escaped-NUL reproducer exits without printing the synthetic token", () => {
  const p = pin("trello-mcp");
  const result = spawnSync(process.execPath, [join(server(p.id), "launch.mjs")], {
    env: { PATH: "", [p.secret.env]: secretFor(p, "synthetic-private-token\0suffix") }, encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /without control characters/);
  assert.doesNotMatch(result.stderr + result.stdout, /synthetic-private-token|ERR_INVALID_ARG_VALUE|at spawn/);
});

test("Trello splits only validated secret fields into the runtime environment", () => {
  const p = pin("trello-mcp");
  const env = secretEnvironment(p, { TRELLO_CREDENTIALS: '{"apiKey":"test-key","token":"test-token"}' });
  assert.equal(env.TRELLO_API_KEY, "test-key");
  assert.equal(env.TRELLO_TOKEN, "test-token");
  assert.equal(env.TRELLO_CREDENTIALS, undefined);
  for (const value of ['null', '[]', 'private-invalid-json', '{"apiKey":"test"}', '{"apiKey":"test","token":"test","extra":"test"}']) {
    assert.throws(() => secretEnvironment(p, { TRELLO_CREDENTIALS: value }), (e) => !e.message.includes("private-"));
  }
});

test("synchronous spawn and installer failures never echo raw errors or secrets", () => {
  const raw = new TypeError("ERR_INVALID_ARG_VALUE env TOKEN synthetic-private-token");
  assert.throws(() => safeSpawn("ignored", [], {}, () => { throw raw; }), (e) => !/synthetic-private-token|ERR_INVALID_ARG_VALUE/.test(e.message));
  assert.throws(() => runInstaller("ignored", [], "/tmp", {}, () => { throw raw; }), (e) => !/synthetic-private-token|ERR_INVALID_ARG_VALUE/.test(e.message));
});

test("package managers receive no host credentials, ambient injection flags, or auth config", () => {
  const input = { PATH: "/bin", HOME: "/test-home", NODE_OPTIONS: "--inspect", npm_config_registry: "https://invalid.example", GOOGLE_WORKSPACE_CREDENTIALS: "private-google", TRELLO_TOKEN: "private-trello", MS365_MCP_OAUTH_TOKEN: "private-ms" };
  const env = installEnvironment(input, "/tmp/connector-data");
  assert.equal(env.HOME, input.HOME);
  assert.equal(env.PATH, input.PATH);
  assert.doesNotMatch(JSON.stringify(env), /private-|NODE_OPTIONS|invalid\.example/);
});

test("minimal PATH reports checked Node/uv prerequisites instead of exit 127", () => temporary((dir) => {
  symlinkSync(process.execPath, join(dir, "node"));
  for (const id of ["google-workspace-mcp", "obsidian-mcp", "jira-mcp", "confluence-mcp"]) {
    const p = pin(id);
    const result = spawnSync("/bin/sh", [join(server(id), "launch.sh")], {
      env: { PATH: dir, [p.secret.env]: secretFor(p) }, encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /requires uv.*AVE_CONNECTOR_UV/);
    assert.doesNotMatch(result.stderr, /not found|synthetic-private-token|ReferenceError|TypeError/);
  }
  const missingNode = spawnSync("/bin/sh", [join(server("obsidian-mcp"), "launch.sh")], { env: { PATH: "" }, encoding: "utf8" });
  assert.equal(missingNode.status, 1);
  assert.match(missingNode.stderr, /requires Node\.js 24/);
  assert.throws(() => findRuntime("uv", { PATH: dir, AVE_CONNECTOR_UV: "/missing/uv" }), /requires uv/);
}));

test("tampered inputs and unpinned transitive dependencies fail before installation", () => temporary((dir) => {
  const p = pin("trello-mcp");
  for (const file of ["runtime.json", "package.json", "package-lock.json", "policy.mjs"]) cpSync(join(server(p.id), file), join(dir, file));
  writeFileSync(join(dir, "policy.mjs"), "tampered");
  assert.throws(() => readPin(dir), /differ from their reviewed inventory/);
  cpSync(join(server(p.id), "policy.mjs"), join(dir, "policy.mjs"));
  const lock = JSON.parse(readFileSync(join(dir, "package-lock.json")));
  const transitive = Object.keys(lock.packages).find((k) => k && k !== 'node_modules/' + p.artifact.name);
  delete lock.packages[transitive].integrity;
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify(lock));
  assert.throws(() => validateNpmLock(dir, p), /Every npm dependency/);
  const changedTop = structuredClone(p); changedTop.artifact.integrity = "sha512-AAAA";
  assert.throws(() => validateNpmLock(server(p.id), changedTop), /version and SRI pin/);
}));

test("registration filters make writes opt-in and Microsoft auth tools permanently absent", async () => {
  const sdk = 'data:text/javascript,' + encodeURIComponent('export class McpServer { constructor(){this.calls=new Map()} registerTool(n,c,fn){this.calls.set(n,fn)} tool(n,c,fn){return this.registerTool(n,c,fn)} }');
  const { McpServer } = await import(sdk);
  await installPolicy({ sdk, read: ["lookup"], write: ["edit"], local: ["download"], never: ["login", "logout", "select-account", "remove-account"] }, {});
  const first = new McpServer();
  for (const name of ["lookup", "edit", "download", "login", "future-unreviewed-tool"]) first.registerTool(name, {}, () => { throw new Error("callback must not run"); });
  assert.deepEqual([...first.calls.keys()], ["lookup"]);
  // A fresh SDK module avoids stacking policies in this same test process.
  const sdk2 = sdk + '%0A'; const { McpServer: Second } = await import(sdk2);
  await installPolicy({ sdk: sdk2, read: ["lookup"], write: ["edit", "login"], local: ["download"], never: ["login", "logout", "select-account", "remove-account"] }, { AVE_CONNECTOR_ALLOW_WRITES: "true", AVE_CONNECTOR_ALLOW_LOCAL_WRITES: "true" });
  const second = new Second();
  for (const name of ["lookup", "edit", "download", "login", "logout", "select-account", "remove-account"]) second.tool(name, {}, () => {});
  assert.deepEqual([...second.calls.keys()], ["lookup", "edit", "download"]);
  const ms = pin("ms-365-mcp");
  for (const name of ["login", "logout", "select-account", "remove-account"]) {
    assert(ms.tools.never.includes(name)); assert(!ms.tools.read.includes(name));
  }
});

test("the Microsoft auth-cache command never accepts a credential write", () => {
  const command = join(server("ms-365-mcp"), "no-cache.mjs");
  for (const key of ["token-cache", "selected-account"]) {
    const load = spawnSync(process.execPath, [command, "load", key], { encoding: "utf8" });
    assert.equal(load.status, 0, load.stderr); assert.deepEqual(JSON.parse(load.stdout), { found: false });
    const save = spawnSync(process.execPath, [command, "save", key], { input: '{"value":"synthetic-private-cache"}', encoding: "utf8" });
    assert.equal(save.status, 1); assert.doesNotMatch(save.stdout + save.stderr, /synthetic-private-cache/);
    assert.equal(spawnSync(process.execPath, [command, "delete", key]).status, 0);
  }
});

test("npm ci rejects changed transitive tarball bytes and never runs install scripts", () => temporary((dir) => {
  const leaf = join(dir, "leaf.tgz");
  const parent = join(dir, "parent.tgz");
  function tarball(name, dependencies, value) {
    const source = join(dir, name); mkdirSync(join(source, "package"), { recursive: true });
    writeFileSync(join(source, "package/package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js", dependencies,
      scripts: { install: "node -e \"require('fs').writeFileSync('install-script-ran','unsafe')\"" } }));
    writeFileSync(join(source, "package/index.js"), value);
    const target = name === "locked-leaf" ? leaf : parent;
    execFileSync("tar", ["-czf", target, "-C", source, "package"]);
  }
  tarball("locked-leaf", {}, "module.exports = 'reviewed';");
  tarball("locked-parent", { "locked-leaf": `file:${leaf}` }, "module.exports = require('locked-leaf');");
  const project = join(dir, "project"); mkdirSync(project);
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { "locked-parent": `file:${parent}` } }));
  const user = join(dir, "user.npmrc"), global = join(dir, "global.npmrc"); writeFileSync(user, ""); writeFileSync(global, "");
  const env = installEnvironment(process.env, dir);
  const npm = findRuntime("npm", env);
  const options = ["--ignore-scripts", "--no-audit", "--no-fund", "--offline", "--userconfig", user, "--globalconfig", global];
  execFileSync(npm, ["install", "--package-lock-only", ...options], { cwd: project, env, stdio: "pipe" });
  execFileSync(npm, ["ci", ...options], { cwd: project, env, stdio: "pipe" });
  assert.equal(readFileSync(join(project, "node_modules/locked-leaf/index.js"), "utf8"), "module.exports = 'reviewed';");
  assert(!existsSync(join(project, "node_modules/locked-leaf/install-script-ran")));
  const originalLock = readFileSync(join(project, "package-lock.json"));
  // Same dependency name and version, different artifact bytes, empty cache.
  tarball("locked-leaf", {}, "module.exports = 'unreviewed replacement';");
  const changed = spawnSync(npm, ["ci", ...options, "--cache", join(dir, "fresh-cache")], { cwd: project, env, encoding: "utf8" });
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /EINTEGRITY|integrity checksum/);
  assert(readFileSync(join(project, "package-lock.json")).equals(originalLock));
}));
