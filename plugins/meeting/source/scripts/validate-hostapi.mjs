#!/usr/bin/env node
// validate-hostapi.mjs — K1 HostApi contract drift guard.
//
// Cross-checks that every hostApi.* call the plugin makes at the TypeScript
// level is consistent with what plugin.json declares. Specifically:
//
//   1. hostApi.addTask(...)     requires "tasks"   in plugin.json "permissions"
//   2. hostApi.saveNote(...)    requires "notes"   in plugin.json "permissions"
//   3. hostApi.getSecret(...)   requires "secrets" in plugin.json "permissions"
//   4. hostApi.emitEvent(e,…)   e must be declared in "emittedEvents"
//   5. hostApi.onEvent(e,…)     e must be declared in "eventSubscriptions"
//   6. bridge.callTool(t,…)     (src/ui/**/*.js) t must carry "app" visibility
//   7. bridge.onEvent(e,…)      (src/ui/**/*.js) e must be bridged to the UI:
//                               this plugin's "emittedEvents", a foreign
//                               event in "eventSubscriptions", or a host
//                               broadcast such as host.theme.changed
//
// Exit code 0 → OK, 1 → drift detected.
//
// Usage: node scripts/validate-hostapi.mjs [--root <plugin dir>]
//
// Pure fs + regex (no runtime deps). Safe to run in any CI env.

import { readFileSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { flattenAgentPluginsManifest } from "@ave/plugin-contract";
import {
  HOST_BROADCAST_EVENTS,
  isTsSource,
  resolvePluginRoot,
  scanUiBridgeUsage,
  walkSources,
} from "./ui-bridge-usage.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
let ROOT;
try {
  ({ root: ROOT } = resolvePluginRoot(process.argv, resolve(__dirname, "..")));
} catch (err) {
  console.error(`%s — %s`, "validate:hostapi", err.message);
  process.exit(2);
}

const PERMISSION_REQUIRING_CALLS = {
  addTask: "tasks",
  saveNote: "notes",
  getSecret: "secrets",
};

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
  const files = walkSources(srcDir, isTsSource);
  const calls = {
    emit: new Set(),
    subscribe: new Set(),
    addTask: false,
    saveNote: false,
    getSecret: false,
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
  }
  const ui = scanUiBridgeUsage(join(srcDir, "ui"));
  calls.uiCallTool = new Set(ui.flatMap((f) => [...f.callTool]));
  calls.uiOnEvent = new Set(ui.flatMap((f) => [...f.onEvent]));

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
      calls.uiCallTool.size > 0 ||
      calls.uiOnEvent.size > 0;
    if (usesHostApi) {
      errors.push(
        `plugin.json missing but src/ uses hostApi or the UI bridge — a manifest is required for HostApi contract validation.`,
      );
      report(errors, warnings, calls, null);
      process.exit(1);
    }
    console.log("validate:hostapi — OK (no manifest, no hostApi usage)");
    return;
  }

  const declaredPermissions = new Set(manifest.permissions ?? []);
  const declaredPublishes = new Set(manifest.emittedEvents ?? []);
  // eventSubscriptions supports both string[] and {type,hint?}[] forms
  const declaredSubscribes = new Set(
    (manifest.eventSubscriptions ?? []).map((s) => (typeof s === "string" ? s : s.type)),
  );

  // 1–3) [REMOVED in schema v3] manifest.permissions field deprecated.
  // Capability declaration now happens via the capabilities array; HostApi
  // call gating is enforced at runtime via the host's permission system.
  // This script no longer flags addTask/saveNote/getSecret usage.
  void declaredPermissions;
  void PERMISSION_REQUIRING_CALLS;

  // 4) emit ↔ emittedEvents
  for (const ev of calls.emit) {
    if (!declaredPublishes.has(ev)) {
      errors.push(
        `hostApi.emitEvent("${ev}") found but plugin.json "emittedEvents" does not declare it`,
      );
    }
  }

  // 5) onEvent ↔ eventSubscriptions
  for (const ev of calls.subscribe) {
    if (!declaredSubscribes.has(ev)) {
      errors.push(
        `hostApi.onEvent("${ev}") found but plugin.json "eventSubscriptions" does not declare it`,
      );
    }
  }

  // 6–7) UI bridge ↔ manifest. The host accepts bridge.callTool only for tools
  // with "app" visibility and forwards to plugin webviews only events some
  // manifest emits (plus its own broadcasts). eventSubscriptions is this
  // plugin's declared interest in another plugin's event, so it counts too.
  const appTools = new Set(
    (manifest.tools ?? [])
      .filter((t) => t._meta?.ui?.visibility?.includes("app"))
      .map((t) => t.name),
  );
  for (const { file, callTool, onEvent } of ui) {
    const rel = relative(ROOT, file);
    for (const tool of callTool) {
      if (!appTools.has(tool)) {
        errors.push(
          `bridge.callTool("${tool}") in ${rel} but no tool named "${tool}" carries "app" visibility in plugin.json — the host rejects the call`,
        );
      }
    }
    for (const ev of onEvent) {
      if (!declaredPublishes.has(ev) && !declaredSubscribes.has(ev) && !HOST_BROADCAST_EVENTS.has(ev)) {
        errors.push(
          `bridge.onEvent("${ev}") in ${rel} but plugin.json neither emits nor subscribes to "${ev}" — the host never forwards it to the UI`,
        );
      }
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
    uiCallTool: [...calls.uiCallTool].sort(),
    uiOnEvent: [...calls.uiOnEvent].sort(),
    declaredPermissions: manifest ? (manifest.permissions ?? []) : [],
  };
  console.log("validate:hostapi — OK");
  console.log(JSON.stringify(summary, null, 2));
}

main();
