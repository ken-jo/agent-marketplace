import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
function launch(name, secretEnv, secret, stub = 'console.log(JSON.stringify({ args: process.argv.slice(2), env: process.env }));') {
  const dir = mkdtempSync(join(tmpdir(), "ave-connectors-"));
  try {
    writeFileSync(join(dir, "npx"), `#!${process.execPath}\n${stub}\n`, { mode: 0o755 });
    // No developer credentials enter the stub's environment.
    return spawnSync(process.execPath, [join(root, "mcp", name, "server/launch.mjs")], {
      env: { PATH: `${dir}:${process.env.PATH}`, [secretEnv]: secret }, encoding: "utf8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Trello splits the host secret only into the child environment", () => {
  const result = launch("trello-mcp", "TRELLO_CREDENTIALS", JSON.stringify({ apiKey: "test-key", token: "test-token" }));
  assert.equal(result.status, 0, result.stderr);
  const child = JSON.parse(result.stdout);
  assert.equal(child.env.TRELLO_API_KEY, "test-key");
  assert.equal(child.env.TRELLO_TOKEN, "test-token");
  assert.equal(child.env.TRELLO_CREDENTIALS, undefined);
  assert.doesNotMatch(JSON.stringify(child.args), /test-key|test-token/);
});

test("Trello rejects malformed or incomplete secrets without echoing them or launching", () => {
  for (const secret of ['private-invalid-json', 'null', '[]', '{"apiKey":"private-test-key"}', '{"apiKey":" ","token":"private-test-token"}']) {
    const result = launch("trello-mcp", "TRELLO_CREDENTIALS", secret);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /private-/);
  }
});

test("Microsoft requires a host token and enforces read-only scopes and external cache storage", () => {
  assert.equal(launch("ms-365-mcp", "MS365_MCP_OAUTH_TOKEN", "").status, 1);
  const result = launch("ms-365-mcp", "MS365_MCP_OAUTH_TOKEN", "test-graph-token");
  assert.equal(result.status, 0, result.stderr);
  const child = JSON.parse(result.stdout);
  assert.equal(child.env.MS365_MCP_OAUTH_TOKEN, "test-graph-token");
  assert.equal(child.env.MS365_MCP_AUTH_CACHE_COMMAND, join(root, "mcp/ms-365-mcp/server/no-cache.mjs"));
  assert.ok(child.args.includes("--read-only"));
  assert.doesNotMatch(JSON.stringify(child.args), /test-graph-token|\.ReadWrite/);
});

test("the Microsoft auth-cache command never accepts a credential write", () => {
  const command = join(root, "mcp/ms-365-mcp/server/no-cache.mjs");
  for (const key of ["token-cache", "selected-account"]) {
    const load = spawnSync(command, ["load", key], { encoding: "utf8" });
    assert.equal(load.status, 0, load.stderr);
    assert.deepEqual(JSON.parse(load.stdout), { found: false });
    const save = spawnSync(command, ["save", key], { input: '{"value":"private-cache-value"}', encoding: "utf8" });
    assert.equal(save.status, 1);
    assert.doesNotMatch(save.stdout + save.stderr, /private-cache-value/);
    assert.equal(spawnSync(command, ["delete", key]).status, 0);
  }
  assert.equal(spawnSync(command, ["load", "unknown"]).status, 1);
});

test("launchers preserve upstream failure status", () => {
  const result = launch("trello-mcp", "TRELLO_CREDENTIALS", '{"apiKey":"test","token":"test"}', "process.exit(42);");
  assert.equal(result.status, 42);
});
