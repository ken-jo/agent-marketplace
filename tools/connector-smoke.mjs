#!/usr/bin/env node
// Credential-free checks of the actual locked servers, not mock registrations.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectors, checkPins } from "./connector-pins.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const optIn = process.argv.includes("--opt-in");
const ids = process.argv.slice(2).filter((arg) => arg !== "--opt-in");
if (ids.some((id) => !connectors.includes(id))) throw new Error("Use connector package names, optionally with --opt-in");
checkPins();
const dataRoot = mkdtempSync(join(tmpdir(), "ave-connector-smoke-"));

async function check(id) {
  const descriptor = JSON.parse(readFileSync(join(root, "mcp", id, "ave-package.json")));
  const pin = JSON.parse(readFileSync(join(root, "mcp", id, "server/runtime.json")));
  const data = join(dataRoot, id); mkdirSync(data, { recursive: true });
  const env = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "APPDATA", "LANG", "TMPDIR", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "AVE_CONNECTOR_UV", "AVE_CONNECTOR_NPM"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(descriptor.payload.server.env)) env[key] = value.replaceAll("$DATA_DIR", data);
  env[pin.secret.env] = pin.secret.fields
    ? JSON.stringify(Object.fromEntries(Object.keys(pin.secret.fields).map((key) => [key, key === "email" ? "smoke@example.invalid" : "synthetic-connector-placeholder"])))
    : "synthetic-connector-placeholder";
  env.AVE_CONNECTOR_ALLOW_WRITES = optIn ? "true" : "false";
  env.AVE_CONNECTOR_ALLOW_LOCAL_WRITES = optIn ? "true" : "false";
  if (id === "jira-mcp") Object.assign(env, { JIRA_URL: "http://127.0.0.1:9", JIRA_USERNAME: "smoke@example.invalid" });
  if (id === "confluence-mcp") Object.assign(env, { CONFLUENCE_URL: "http://127.0.0.1:9", CONFLUENCE_USERNAME: "smoke@example.invalid" });
  const child = spawn(join(root, "mcp", id, descriptor.payload.server.command), [], { env, cwd: data, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let pending = "", stderr = "", serial = 0, stopped = false;
  const replies = new Map();
  const fail = (error) => { for (const { reject } of replies.values()) reject(error); replies.clear(); };
  child.on("error", fail);
  child.on("exit", (code) => { if (!stopped) fail(new Error(`Server exited ${code}: ${stderr.slice(-1500)}`)); });
  child.stderr.on("data", (bytes) => { stderr = (stderr + bytes).slice(-16_000); });
  child.stdin.on("error", () => {});
  child.stdout.on("data", (bytes) => {
    pending += bytes;
    if (pending.length > 8 * 1024 * 1024) return fail(new Error("Protocol output exceeded the check limit"));
    for (;;) {
      const index = pending.indexOf("\n"); if (index < 0) break;
      const line = pending.slice(0, index); pending = pending.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { fail(new Error("Server wrote non-protocol stdout")); continue; }
      const receiver = replies.get(message.id);
      if (receiver) { replies.delete(message.id); receiver.resolve(message); }
    }
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timeout = setTimeout(() => { replies.delete(id); reject(new Error(`Timed out at ${method}: ${stderr.slice(-1500)}`)); }, 180_000);
    replies.set(id, { resolve: (message) => { clearTimeout(timeout); resolve(message); }, reject: (error) => { clearTimeout(timeout); reject(error); } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    const initialized = await request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "ave-locked-connector-check", version: "1.0.0" } });
    assert(!initialized.error, JSON.stringify(initialized.error));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const result = await request("tools/list"); assert(!result.error, JSON.stringify(result.error));
    const names = result.result.tools.map((tool) => tool.name);
    assert(names.length > 0, "No tools registered");
    const blocked = [];
    if (pin.tools) {
      const expected = [...pin.tools.read, ...(optIn ? pin.tools.write : []), ...(optIn ? pin.tools.local : [])];
      assert.deepEqual([...names].sort(), expected.sort(), "Actual registration differs from the reviewed allowlist");
      blocked.push(...pin.tools.never, ...(!optIn ? [...pin.tools.write, ...pin.tools.local] : []));
    } else if (id === "obsidian-mcp") {
      assert.equal(names.length, optIn ? 15 : 11);
      if (!optIn) blocked.push("obsidian_append_content", "obsidian_patch_content", "obsidian_put_content", "obsidian_delete_file");
    } else if (id === "google-workspace-mcp") {
      assert.equal(names.length, optIn ? 11 : 9);
      blocked.push("start_google_auth");
      if (!optIn) blocked.push("get_gmail_message_content", "get_drive_file_download_url");
    } else blocked.push(id === "jira-mcp" ? "jira_create_issue" : "confluence_create_page");
    // Exercise direct calls as well as discovery: hiding a tool is insufficient.
    for (const name of blocked) {
      assert(!names.includes(name), `Blocked tool listed: ${name}`);
      const reply = await request("tools/call", { name, arguments: name === "login" ? { force: true } : {} });
      assert(reply.error || reply.result?.isError, `Blocked tool call succeeded: ${name}`);
      assert.match(JSON.stringify(reply), /unknown tool|not found|not enabled|disabled|read.only|not available|not permitted|not allowed|does not exist/iu, `Call did not reject at the tool boundary: ${name}`);
    }
    console.log(JSON.stringify({ connector: id, mode: optIn ? "explicit-write-opt-ins" : "default", tools: names.length, blockedCalls: blocked.length, result: "PASS" }));
    return true;
  } catch (error) {
    console.error(JSON.stringify({ connector: id, result: "FAIL", error: error.message }));
    return false;
  } finally {
    stopped = true; fail(new Error("Check closed"));
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already stopped. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* Gracefully stopped. */ }
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
  }
}

const queue = [...(ids.length ? ids : connectors)];
const results = [];
try {
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (queue.length) results.push(await check(queue.shift()));
  }));
} finally { rmSync(dataRoot, { recursive: true, force: true }); }
if (results.some((passed) => !passed)) process.exitCode = 1;
