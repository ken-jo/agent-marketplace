// ui-bridge-usage.mjs — what the bundled UI asks of the host bridge.
//
// The renderer reaches the host only through `bridge.callTool("…")` and
// `bridge.onEvent("…")` in src/ui/**/*.{js,mjs,cjs}, and the host answers
// both from the manifest: a tool call is accepted only when that tool carries
// "app" visibility, and an event reaches a plugin webview only when a manifest
// bridges it (the emitting plugin's `emittedEvents`) or the host broadcasts it
// itself. validate-hostapi.mjs, validate-events.mjs and test/manifest.test.ts
// all read this one scan so no two of them can disagree about what the UI
// references.
//
// What is matched: a `.callTool(` / `.onEvent(` member call — optional
// chaining included, since `bridge?.callTool?.("x")` is still a call — whose
// first argument is a string literal, after comments are stripped.
//
// Known false negatives (a name the scan cannot see, so the guards stay
// silent): a destructured method (`const { callTool } = bridge; callTool("x")`),
// an indirect call (`bridge.callTool.call(bridge, "x")`), bracket access
// (`bridge["callTool"]("x")`), and any runtime-built name (a variable, a
// template literal). Checking those would mean guessing at a value, and a
// guess would only invent drift; keep call sites literal instead, as
// src/ui/recorder-card.js already does on purpose.
//
// Comment stripping is deliberately conservative: block comments, and `//`
// only where it begins a line. A `//` after code on the same line is left in
// place because `"https://…"` looks the same to a regex.
//
// This module is a leaf on purpose: both validators run `main()` at import,
// so neither can lend the scanner to the other.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// mirrors Ave src/plugins/capabilities.ts PUBLIC_HOST_EVENT_TYPES
/**
 * Events the host sends to every registered plugin webview without any
 * manifest declaration. `host.theme.changed` is fanned out by main on webview
 * registration and on every theme change; a plugin does not subscribe to it,
 * it simply receives it.
 */
export const HOST_BROADCAST_EVENTS = new Set(["host.theme.changed"]);

export const isTsSource = (name) => name.endsWith(".ts") && !name.endsWith(".d.ts");
export const isUiScript = (name) => /\.(js|mjs|cjs)$/.test(name);

export function walkSources(dir, isSource, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
      walkSources(p, isSource, out);
    } else if (isSource(e)) {
      out.push(p);
    }
  }
  return out;
}

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /^[ \t]*\/\/.*$/gm;
export const stripComments = (src) => src.replace(BLOCK_COMMENT, "").replace(LINE_COMMENT, "");

const CALL_TOOL = /\.callTool\??\.?\(\s*["']([^"']+)["']/g;
const ON_EVENT = /\.onEvent\??\.?\(\s*["']([^"']+)["']/g;

const literals = (src, re) => new Set([...src.matchAll(re)].map((m) => m[1]));

/** Per UI file: the tool names it calls and the event types it subscribes to. */
export function scanUiBridgeUsage(uiDir) {
  return walkSources(uiDir, isUiScript).map((file) => {
    const src = stripComments(readFileSync(file, "utf8"));
    return { file, callTool: literals(src, CALL_TOOL), onEvent: literals(src, ON_EVENT) };
  });
}

/**
 * The plugin root a validator checks. Without `--root` it is the repo the
 * script lives in and a missing src/ or plugin.json is that repo's own
 * business. With `--root` the caller named a directory on purpose, so a
 * directory that is not a plugin is a mistake to report, not an empty result.
 */
export function resolvePluginRoot(argv, defaultRoot) {
  const i = argv.indexOf("--root");
  if (i === -1) return { root: defaultRoot, explicit: false };
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error("--root needs a plugin directory");
  }
  const root = resolve(value);
  const missing = ["plugin.json", "src"].filter((p) => !existsSync(join(root, p)));
  if (missing.length) {
    throw new Error(`--root ${root} is not a plugin root: missing ${missing.join(", ")}`);
  }
  return { root, explicit: true };
}
