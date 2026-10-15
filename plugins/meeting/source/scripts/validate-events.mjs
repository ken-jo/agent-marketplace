#!/usr/bin/env node
// validate-events.mjs — F4 event drift guard.
//
// Cross-checks that every event the plugin actually emits/subscribes — at the
// TypeScript level and through `bridge.onEvent` in the bundled UI — is
// declared in plugin.json, and vice versa. Also rejects events outside the
// shared event catalog (unless marked as internal).
//
// Exit code 0 → OK, 1 → drift detected.
//
// Usage: node scripts/validate-events.mjs [--root <plugin dir>]
//
// This script has NO runtime deps (pure fs + regex scan), so it runs in any
// CI environment without installing the plugin.
//
// Maintenance:
//  - Known events are defined in KNOWN_EVENTS below. Keep in sync with
//    shared event catalog (KNOWN_EVENTS below).
//  - To allow an emit that is NOT catalog-listed, add it to LOCAL_ALLOWLIST.

import { existsSync, readFileSync } from "node:fs";
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
  console.error(`%s — %s`, "validate:events", err.message);
  process.exit(2);
}

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
  "calendar.events.loaded",
  "calendar.event.added",
  "calendar.event.upcoming",
  "calendar.event.starting",
  "meeting.calendar.snapshot.requested",
  // Other shared coordination events
  "work_assistant.snapshot.requested",
  "ms-graph.snapshot.ready",
  // pageindex plugin emits
  "index.document.updated",
  "index.folders.changed",
  // calendar plugin emits
  "calendar.link.created",
  "calendar.link.failed",
  "calendar.link.pending",
  "calendar.from_email.suggested",
  "calendar.pattern.detected",
]);

// Per-plugin local additions allowed even if not in catalog (escape hatch).
const LOCAL_ALLOWLIST = new Set([
  // Pre-meeting prep open signal — pure UI cue, not yet in shared SDK
  // catalog. Promote when calendar/agent-hub plugins start subscribing.
  "meeting.prep.opened",
  // Background prep registration signal used to refresh the Meeting UI after
  // scheduled meetings are imported or manually registered. Keep local until
  // the shared SDK event catalog is updated.
  "meeting.prep.registered",
  // host.theme.changed is emitted by the host and fanned out to every plugin
  // webview; the bundled UI (prime-theme.js) receives it through the bridge
  // and the host plugin itself does not subscribe (test/themePropagate.test.ts
  // forbids that). Not in the shared catalog because no plugin emits it.
  "host.theme.changed",
  // ralph round-2 — emitted when summary path falls back to Mock because
  // host.callLlm is unavailable. Surfaces degraded UX via OS notification
  // (notificationEvents) + proactive engine. Promote to the shared catalog
  // catalog in a follow-up PR; LOCAL_ALLOWLIST keeps the CI gate green.
  "meeting.summary.degraded",
]);

// ─── helpers ────────────────────────────────────────────────────────────────
function scanEmitsAndSubscribes(srcDir) {
  const emits = new Set();
  const subscribes = new Set();
  // Match both direct `hostApi.emitEvent("ev"` and optional-chain
  // `hostApi.emitEvent?.("ev"` forms — round-2 fix introduced the latter
  // for back-compat with older hosts that omit the method.
  const emitRe = /(?:hostApi\.|this\.)emitEvent\??\.?\(\s*["']([^"']+)["']/g;
  const subRe = /hostApi\.onEvent\??\.?\(\s*["']([^"']+)["']/g;
  for (const f of walkSources(srcDir, isTsSource)) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(emitRe)) emits.add(m[1]);
    for (const m of src.matchAll(subRe)) subscribes.add(m[1]);
  }
  // The bundled UI subscribes through the webview bridge, not hostApi. Kept
  // apart from `subscribes` because the host serves the two differently.
  const uiSubscribes = new Map();
  for (const { file, onEvent } of scanUiBridgeUsage(join(srcDir, "ui"))) {
    for (const ev of onEvent) uiSubscribes.set(ev, relative(ROOT, file));
  }
  return { emits, subscribes, uiSubscribes };
}

function loadManifest() {
  const raw = readFileSync(join(ROOT, "plugin.json"), "utf8");
  return flattenAgentPluginsManifest(JSON.parse(raw));
}

// ─── main ───────────────────────────────────────────────────────────────────
function main() {
  const manifest = loadManifest();
  const { emits, subscribes, uiSubscribes } = scanEmitsAndSubscribes(join(ROOT, "src"));

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
  const declaredAlerts = new Set((manifest.alerts?.kinds ?? []).map((kind) => kind.id));
  const hostPath = join(ROOT, "src", "hostPlugin.ts");
  const hostSource = existsSync(hostPath) ? readFileSync(hostPath, "utf8") : "";
  const summaryPath = join(ROOT, "src", "alerts", "meeting-summary-detector.ts");
  const summarySource = existsSync(summaryPath) ? readFileSync(summaryPath, "utf8") : "";
  const raisedAlerts = new Set([...`${hostSource}\n${summarySource}`.matchAll(/\bkind:\s*["']([a-z][a-z0-9-]*)["']/g)].map((match) => match[1]));
  if (existsSync(hostPath)) {
    for (const kind of declaredAlerts) {
      if (!raisedAlerts.has(kind)) errors.push(`alerts.kinds declares "${kind}" without a runtime raise path`);
    }
    for (const kind of raisedAlerts) {
      if (!declaredAlerts.has(kind)) errors.push(`runtime raises "${kind}" without an alerts.kinds declaration`);
    }
  }
  if (manifest.alerts && manifest.notificationEvents?.length) {
    errors.push("alerts and notificationEvents cannot coexist after the alerts release");
  }

  // 1) Every runtime emit must be declared in emittedEvents.
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
  for (const ev of subscribes) {
    if (!declaredSubscribes.has(ev)) {
      errors.push(
        `hostApi.onEvent("${ev}") found in src/ but missing from plugin.json "eventSubscriptions"`,
      );
    }
  }
  // 3b) Every UI bridge.onEvent must name an event the host forwards to the
  //     webview: this plugin's own emittedEvents, a foreign event it declares
  //     in eventSubscriptions, or a host broadcast (host.theme.changed reaches
  //     every plugin webview without a declaration).
  for (const [ev, file] of uiSubscribes) {
    if (!declaredPublishes.has(ev) && !declaredSubscribes.has(ev) && !HOST_BROADCAST_EVENTS.has(ev)) {
      errors.push(
        `bridge.onEvent("${ev}") in ${file} but plugin.json neither emits nor subscribes to "${ev}" — the host never forwards it to the UI`,
      );
    }
  }
  // 4) Every declared subscription should have a runtime handler, host-side
  //    or in the UI.
  for (const ev of declaredSubscribes) {
    if (!subscribes.has(ev) && !uiSubscribes.has(ev)) {
      warnings.push(
        `plugin.json "eventSubscriptions" declares "${ev}" but no hostApi.onEvent("${ev}") handler found`,
      );
    }
  }
  // 5) notificationEvents must point at something this plugin publishes.
  for (const ev of notificationEvents) {
    if (!declaredPublishes.has(ev)) {
      errors.push(
        `notificationEvents references "${ev}" which is not declared in emittedEvents`,
      );
    }
  }
  // 6) All referenced events must be in the shared catalog or local allowlist.
  const all = new Set([
    ...emits,
    ...subscribes,
    ...uiSubscribes.keys(),
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
    uiSubscribes: [...uiSubscribes.keys()].sort(),
    publishes: [...declaredPublishes].sort(),
    subscriptions: [...declaredSubscribes].sort(),
  };
  console.log("validate:events — OK");
  console.log(JSON.stringify(summary, null, 2));
}

main();
