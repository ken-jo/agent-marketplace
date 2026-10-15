#!/usr/bin/env node
// validate-hostapi.mjs — K1 HostApi contract drift guard.
//
// Cross-checks that every hostApi.* call the plugin makes at the TypeScript
// level is consistent with what plugin.json declares. Specifically:
//
//   1. Retired keyword-to-tool dispatch must be absent from source and manifest.
//   2. hostApi.emitEvent(e,…) e must be declared in "emittedEvents".
//   3. hostApi.onEvent(e,…)   e must be declared in "eventSubscriptions".
//
// Exit code 0 → OK, 1 → drift detected.
//
// Usage: node scripts/validate-hostapi.mjs
//
// Pure fs + regex (no runtime deps). Safe to run in any CI env.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { flattenAgentPluginsManifest } from "@ave/plugin-contract";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function walkTs(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
      walkTs(p, out);
    } else if (e.endsWith(".ts") && !e.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

function loadManifest() {
  const p = join(ROOT, "plugin.json");
  if (!existsSync(p)) return null;
  try {
    return flattenAgentPluginsManifest(JSON.parse(readFileSync(p, "utf8")));
  } catch (err) {
    console.error(`plugin.json parse error: ${err.message}`);
    process.exit(1);
  }
}

function main() {
  const srcDir = join(ROOT, "src");
  if (!existsSync(srcDir)) {
    console.log("validate:hostapi — no src/ directory, nothing to check.");
    return;
  }

  // Re-scan per-file to avoid regex state bleed.
  const files = walkTs(srcDir);
  const calls = {
    emit: new Set(),
    subscribe: new Set(),
    addTask: false,
    saveNote: false,
    getSecret: false,
    retiredKeywordDispatchFound: false,
  };
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/hostApi\.emitEvent\(\s*["']([^"']+)["']/g)) {
      calls.emit.add(m[1]);
    }
    for (const m of src.matchAll(/hostApi\.onEvent\(\s*["']([^"']+)["']/g)) {
      calls.subscribe.add(m[1]);
    }
    if (/hostApi\.addTask\s*\(/.test(src)) calls.addTask = true;
    if (/hostApi\.saveNote\s*\(/.test(src)) calls.saveNote = true;
    if (/hostApi\.getSecret\s*\(/.test(src)) calls.getSecret = true;
    if (/hostApi\.registerKeywords\s*\(/.test(src)) {
      calls.retiredKeywordDispatchFound = true;
    }
  }

  const manifest = loadManifest();
  const errors = [];
  const warnings = [];

  if (!manifest) {
    // No manifest → only complain if src actually calls hostApi.
    const usesHostApi =
      calls.emit.size > 0 ||
      calls.subscribe.size > 0 ||
      calls.addTask ||
      calls.saveNote ||
      calls.getSecret ||
      calls.retiredKeywordDispatchFound;
    if (usesHostApi) {
      errors.push(
        `plugin.json missing but src/ uses hostApi — a manifest is required for HostApi contract validation.`,
      );
      report(errors, warnings, calls, null);
      process.exit(1);
    }
    console.log("validate:hostapi — OK (no manifest, no hostApi usage)");
    return;
  }

  const declaredPublishes = new Set(manifest.emittedEvents ?? []);
  // eventSubscriptions supports both string[] and {type,hint?}[] forms
  const declaredSubscribes = new Set(
    (manifest.eventSubscriptions ?? []).map((s) => (typeof s === "string" ? s : s.type)),
  );

  // 1) The Host owns a closed manifest schema and no longer accepts keyword
  // dispatch. Keep both the declaration and runtime surface fail-closed.
  if (Object.prototype.hasOwnProperty.call(manifest, "keywords")) {
    errors.push(
      `plugin.json "keywords" is retired and rejected by the Host manifest schema`,
    );
  }
  if (calls.retiredKeywordDispatchFound) {
    errors.push(
      `hostApi.registerKeywords(...) is retired and absent from the current HostApi`,
    );
  }

  // 2) emit ↔ eventPublishes
  for (const ev of calls.emit) {
    if (!declaredPublishes.has(ev)) {
      errors.push(
        `hostApi.emitEvent("${ev}") found but plugin.json "emittedEvents" does not declare it`,
      );
    }
  }

  // 3) onEvent ↔ eventSubscriptions
  for (const ev of calls.subscribe) {
    if (!declaredSubscribes.has(ev)) {
      errors.push(
        `hostApi.onEvent("${ev}") found but plugin.json "eventSubscriptions" does not declare it`,
      );
    }
  }

  report(errors, warnings, calls, manifest);
  if (errors.length) process.exit(1);
}

function report(errors, warnings, calls, manifest) {
  if (warnings.length) {
    console.log("validate:hostapi — warnings:");
    for (const w of warnings) console.log(`  ! ${w}`);
  }
  if (errors.length) {
    console.error("validate:hostapi — FAILED:");
    for (const e of errors) console.error(`  ✗ ${e}`);
    console.error(
      `\nHostApi contract drift: ${errors.length} error(s). Align plugin.json or src/.`,
    );
    return;
  }
  const summary = {
    emit: [...calls.emit].sort(),
    subscribe: [...calls.subscribe].sort(),
    addTask: calls.addTask,
    saveNote: calls.saveNote,
    getSecret: calls.getSecret,
    retiredKeywordDispatchFound: calls.retiredKeywordDispatchFound,
  };
  console.log("validate:hostapi — OK");
  console.log(JSON.stringify(summary, null, 2));
}

main();
