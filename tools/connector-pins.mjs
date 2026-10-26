#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readPin } from "./connector-runtime.mjs";

export const connectors = ["jira-mcp", "confluence-mcp", "trello-mcp", "todoist-mcp", "airtable-mcp", "obsidian-mcp", "figma-context-mcp", "youtube-mcp", "google-workspace-mcp", "ms-365-mcp"];
const root = fileURLToPath(new URL("../", import.meta.url));
const copies = { "launch.mjs": "connector-runtime.mjs", "launch.sh": "connector-launch.sh", "policy.mjs": "connector-policy.mjs" };
const hash = (b) => createHash("sha256").update(b).digest("hex");

export function checkPythonLock(server, pin) {
  const logical = readFileSync(join(server, "requirements.lock"), "utf8")
    .split("\n").filter((line) => line.trim() && !line.trimStart().startsWith("#")).join("\n").replace(/\\\n\s*/gu, " ").split("\n");
  for (const line of logical) {
    const requirement = line.split(/\s+--hash=/u)[0].trim();
    const localWheel = pin.artifact.wheel && requirement === `./${pin.artifact.wheel}`;
    assert(localWheel || /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9,._-]+\])?==[A-Za-z0-9][A-Za-z0-9.!+_-]*(?:\s*;.*)?$/u.test(requirement), "Python dependencies must be exact registry versions or the inventoried wheel");
    const hashes = [...line.matchAll(/--hash=sha256:([0-9a-f]{64})(?=\s|$)/gu)];
    assert(hashes.length > 0 && (line.match(/--hash=/gu)?.length ?? 0) === hashes.length, "Every Python artifact needs SHA-256 hashes");
    if (localWheel) assert(hashes.some((h) => h[1] === pin.artifact.sha256), "Reviewed wheel hash missing from lock");
  }
  assert(logical.length > 1, "Python runtime must include its dependency closure");
  if (!pin.artifact.wheel) assert(logical.some((line) => line.startsWith(`${pin.artifact.name}==${pin.artifact.version} `)), "Top-level Python package is not locked");
}

export function checkPins() {
  for (const id of connectors) {
    const server = join(root, "mcp", id, "server");
    const pin = readPin(server);
    assert.equal(pin.id, id);
    const expected = pin.kind === "npm" ? ["package.json", "package-lock.json", "policy.mjs"] : ["requirements.lock"];
    if (pin.entry && pin.kind === "python") expected.push(pin.entry);
    if (pin.artifact.wheel) expected.push(pin.artifact.wheel);
    if (pin.artifact.rebuilt) {
      expected.push(pin.artifact.rebuilt.file);
      expected.push(pin.artifact.rebuilt.license);
      assert.equal(pin.files[pin.artifact.rebuilt.file], pin.artifact.rebuilt.sha256);
      assert.equal(pin.artifact.rebuilt.sourceCommit, pin.source.commit);
    }
    if (id === "ms-365-mcp") expected.push("no-cache.mjs");
    assert.deepEqual(Object.keys(pin.files).sort(), expected.sort(), `${id}: inventory coverage differs`);
    for (const [dest, source] of Object.entries(copies)) {
      if (dest === "policy.mjs" && pin.kind !== "npm") continue;
      assert(readFileSync(join(server, dest)).equals(readFileSync(join(root, "tools", source))), `${id}/${dest}: generated runtime differs; run node tools/connector-pins.mjs sync`);
    }
    if (pin.kind === "python") checkPythonLock(server, pin);
    else {
      assert(/^[0-9a-f]{64}$/u.test(pin.artifact.sha256), "Top-level tarball SHA-256 missing");
      const all = [...pin.tools.read, ...pin.tools.write, ...pin.tools.local, ...pin.tools.never];
      assert.equal(new Set(all).size, all.length, "Tool policy categories overlap");
    }
    const descriptor = JSON.parse(readFileSync(join(server, "../ave-package.json"), "utf8"));
    assert.equal(descriptor.payload.server.command, "server/launch.sh");
    assert.deepEqual(descriptor.platforms, ["darwin", "linux"]);
    assert.equal(descriptor.payload.server.apiKeyEnv, pin.secret.env);
    assert.equal(descriptor.payload.server.env.AVE_CONNECTOR_ALLOW_WRITES, "false");
    assert.equal(descriptor.payload.server.env.AVE_CONNECTOR_ALLOW_LOCAL_WRITES, "false");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === "sync") {
    for (const id of connectors) {
      const server = join(root, "mcp", id, "server");
      const path = join(server, "runtime.json");
      const pin = JSON.parse(readFileSync(path, "utf8"));
      for (const [dest, source] of Object.entries(copies)) {
        if (dest === "policy.mjs" && pin.kind !== "npm") continue;
        copyFileSync(join(root, "tools", source), join(server, dest));
      }
      chmodSync(join(server, "launch.sh"), 0o755);
      for (const file of Object.keys(pin.files)) pin.files[file] = hash(readFileSync(join(server, file)));
      writeFileSync(path, `${JSON.stringify(pin, null, 2)}\n`);
    }
  } else if (process.argv.length > 2) throw new Error("usage: node tools/connector-pins.mjs [sync]");
  checkPins();
  console.log("connector runtime pins: OK");
}
