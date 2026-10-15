#!/usr/bin/env node
// validate-events.mjs — F4 event drift guard.
//
// Cross-checks that every event the plugin actually emits/subscribes at the
// TypeScript level is declared in plugin.json, and vice versa. Also rejects
// events outside the shared event catalog (unless marked as internal).
//
// Exit code 0 → OK, 1 → drift detected.
//
// Usage: node scripts/validate-events.mjs
//
// This script has NO runtime deps (pure fs + regex scan), so it runs in any
// CI environment without installing the plugin.
//
// Maintenance:
//  - Known events are defined in KNOWN_EVENTS below. Keep in sync with
//    shared event catalog (KNOWN_EVENTS below).
//  - To allow an emit that is NOT catalog-listed, add it to LOCAL_ALLOWLIST.
//  - UI plugins may subscribe through `bridge.onEvent(...)` or the SDK
//    `primeTheme(bridge, ...)` helper, not only `hostApi.onEvent(...)`.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { flattenAgentPluginsManifest } from "@ave/plugin-contract";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ─── Shared event catalog (the same list in every official plugin) ───────────
const KNOWN_EVENTS = new Set([
  // email plugin emits
  "email.new",
  "email.analyzed",
  "email.action.needed",
  "email.invite.detected",
  // meeting plugin emits
  "meeting.started",
  "meeting.ended",
  "meeting.transcript.updated",
  "meeting.summary.created",
  "meeting.error",
  // local-indexer plugin emits
  "index.document.updated",
  "index.folders.changed",
  "index.scan.progress",
  "index.scan.completed",
  // host broadcasts
  "host.theme.changed",
  // calendar plugin emits
  "calendar.link.created",
  "calendar.link.failed",
  "calendar.link.pending",
  "calendar.from_email.suggested",
  "calendar.pattern.detected",
]);

// Per-plugin local additions allowed even if not in catalog (escape hatch).
const LOCAL_ALLOWLIST = new Set([
  // Local Indexer surfaces actionable per-file warnings to its own webview.
  "index.warning",
]);

// ─── helpers ────────────────────────────────────────────────────────────────
function walkSource(dir, out = []) {
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
      walkSource(p, out);
    } else if (
      (e.endsWith(".ts") && !e.endsWith(".d.ts")) ||
      e.endsWith(".js")
    ) {
      out.push(p);
    }
  }
  return out;
}

function scanEmitsAndSubscribes(srcDir) {
  const emits = new Set();
  const subscribes = new Set();
  const emitRe = /(?:hostApi\.|this\.)emitEvent\(\s*["']([^"']+)["']/g;
  const subRe = /(?:hostApi|bridge)\.onEvent\(\s*["']([^"']+)["']/g;
  const primeThemeImportRe = /from\s+["']\.\/prime-theme(?:\.js)?["']/;
  const primeThemeCallRe = /\bprimeTheme\s*\(/;
  for (const f of walkSource(srcDir)) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(emitRe)) emits.add(m[1]);
    for (const m of src.matchAll(subRe)) subscribes.add(m[1]);
    // `primeTheme(bridge, ...)` internally subscribes to the host theme
    // sticky broadcast, so treat it as an explicit `host.theme.changed`
    // dependency for manifest drift validation.
    if (primeThemeImportRe.test(src) && primeThemeCallRe.test(src)) {
      subscribes.add("host.theme.changed");
    }
  }
  return { emits, subscribes };
}

function loadManifest() {
  const raw = readFileSync(join(ROOT, "plugin.json"), "utf8");
  return flattenAgentPluginsManifest(JSON.parse(raw));
}

// ─── main ───────────────────────────────────────────────────────────────────
function main() {
  const manifest = loadManifest();
  const { emits, subscribes } = scanEmitsAndSubscribes(join(ROOT, "src"));

  const declaredPublishes = new Set(manifest.emittedEvents ?? []);
  // eventSubscriptions supports both string[] and {type,hint?}[] forms
  const declaredSubscribes = new Set(
    (manifest.eventSubscriptions ?? []).map((s) => (typeof s === "string" ? s : s.type)),
  );
  const notificationEvents = new Set(
    (manifest.notificationEvents ?? []).map((n) => n.event),
  );

  const errors = [];
  const warnings = [];

  // 1) Every runtime emit must be declared in eventPublishes.
  for (const ev of emits) {
    if (!declaredPublishes.has(ev)) {
      errors.push(
        `emit "${ev}" found in src/ but missing from plugin.json "emittedEvents"`,
      );
    }
  }
  // 2) Every declared publish must actually be emitted (no stale manifest entries).
  for (const ev of declaredPublishes) {
    if (!emits.has(ev)) {
      errors.push(
        `plugin.json "emittedEvents" declares "${ev}" but no emitEvent("${ev}") call found in src/`,
      );
    }
  }
  // 3) Every runtime onEvent subscription must be declared in eventSubscriptions.
  //
  // Except a subscription to an event this plugin itself publishes. Those two
  // manifest fields address different delivery paths: `eventSubscriptions`
  // tells the host which OTHER sources' events to collect for this plugin,
  // while the renderer bridge that feeds a webview's `bridge.onEvent` is
  // driven by `emittedEvents`. A panel listening for its own backend's
  // progress is therefore already declared, and listing it as a subscription
  // too would make the host register a collector that echoes the plugin's
  // events back at it.
  for (const ev of subscribes) {
    if (!declaredSubscribes.has(ev) && !declaredPublishes.has(ev)) {
      errors.push(
        `hostApi.onEvent("${ev}") found in src/ but missing from plugin.json "eventSubscriptions"`,
      );
    }
  }
  // 4) Every declared subscription should have a runtime handler.
  for (const ev of declaredSubscribes) {
    if (!subscribes.has(ev)) {
      warnings.push(
        `plugin.json "eventSubscriptions" declares "${ev}" but no hostApi.onEvent("${ev}") / bridge.onEvent("${ev}") handler found`,
      );
    }
  }
  // 5) notificationEvents must point at something this plugin publishes.
  for (const ev of notificationEvents) {
    if (!declaredPublishes.has(ev)) {
      errors.push(
        `notificationEvents references "${ev}" which is not declared in eventPublishes`,
      );
    }
  }
  // 6) All referenced events must be in the shared catalog or local allowlist.
  const all = new Set([
    ...emits,
    ...subscribes,
    ...declaredPublishes,
    ...declaredSubscribes,
  ]);
  for (const ev of all) {
    if (!KNOWN_EVENTS.has(ev) && !LOCAL_ALLOWLIST.has(ev)) {
      errors.push(
        `event "${ev}" is not in the shared event catalog (KNOWN_EVENTS). Add it to KNOWN_EVENTS in every official plugin, or to LOCAL_ALLOWLIST.`,
      );
    }
  }

  if (warnings.length) {
    console.log("validate:events — warnings:");
    for (const w of warnings) console.log(`  ! ${w}`);
  }
  if (errors.length) {
    console.error("validate:events — FAILED:");
    for (const e of errors) console.error(`  ✗ ${e}`);
    console.error(
      `\nDrift detected: ${errors.length} error(s). Update plugin.json or src/ to align.`,
    );
    process.exit(1);
  }

  const summary = {
    emits: [...emits].sort(),
    subscribes: [...subscribes].sort(),
    publishes: [...declaredPublishes].sort(),
    subscriptions: [...declaredSubscribes].sort(),
  };
  console.log("validate:events — OK");
  console.log(JSON.stringify(summary, null, 2));
}

main();
