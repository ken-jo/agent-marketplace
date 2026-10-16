/**
 * The manifest drift guards see the bundled UI.
 *
 * scripts/validate-hostapi.mjs and scripts/validate-events.mjs used to walk
 * TypeScript only, so a `bridge.callTool("…")` or `bridge.onEvent("…")` in
 * src/ui/*.js could name something plugin.json no longer declares and both
 * guards would stay green. The host does not stay green: a tool without "app"
 * visibility is rejected at the IPC boundary, and an event no manifest emits
 * is never forwarded to the webview. Neither failure has a message in this
 * repo, which is what the guards exist to provide.
 *
 * Each case builds a self-consistent plugin root in a temp dir — the real
 * manifest, a host file that emits and subscribes exactly what it declares —
 * and varies one thing: the manifest, or the UI file. The guards run as
 * subprocesses with `--root`, exactly as CI runs them, so what is asserted is
 * their exit code and message, not an internal function.
 */
import { describe, it, expect, onTestFinished } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { flattenAgentPluginsManifest } from "@ave/plugin-contract";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(__dirname, "..", "plugin.json");
const GUARDS = {
  hostapi: join(__dirname, "..", "scripts", "validate-hostapi.mjs"),
  events: join(__dirname, "..", "scripts", "validate-events.mjs"),
};

type Json = Record<string, unknown>;
type Tool = { name: string; _meta?: { ui?: { visibility?: string[] } } };
type ExtensionBlock = { tools: Tool[]; emittedEvents: string[]; eventSubscriptions: Array<string | { type: string }> };

/**
 * The manifest is Agent Plugins 1.0.0, so the Ave fields sit under an
 * extension key. Find the object that owns `tools` rather than spelling the
 * path, so the fixture survives the key being renamed.
 */
function extensionBlock(node: unknown): ExtensionBlock | null {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  if ("tools" in node && "emittedEvents" in node) return node as ExtensionBlock;
  for (const child of Object.values(node as Json)) {
    const found = extensionBlock(child);
    if (found) return found;
  }
  return null;
}

/** A plugin root whose TypeScript side agrees with the manifest it is given. */
function pluginRoot(mutate: (block: ExtensionBlock) => void, uiSource: string, uiFile = "panel.js"): string {
  const raw = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Json;
  const block = extensionBlock(raw);
  if (!block) throw new Error("plugin.json has no block owning tools + emittedEvents");
  mutate(block);
  const flat = flattenAgentPluginsManifest(raw as never) as unknown as {
    emittedEvents?: string[];
    eventSubscriptions?: Array<string | { type: string }>;
  };
  const hostTs = [
    ...(flat.emittedEvents ?? []).map((ev) => `hostApi.emitEvent("${ev}", {});`),
    ...(flat.eventSubscriptions ?? []).map((s) => `hostApi.onEvent("${typeof s === "string" ? s : s.type}", () => {});`),
  ].join("\n");

  const root = mkdtempSync(join(tmpdir(), "meeting-ui-bridge-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src", "ui"), { recursive: true });
  writeFileSync(join(root, "plugin.json"), JSON.stringify(raw));
  writeFileSync(join(root, "src", "host.ts"), hostTs);
  writeFileSync(join(root, "src", "ui", uiFile), uiSource);
  return root;
}

function run(guard: keyof typeof GUARDS, ...args: string[]) {
  const r = spawnSync(process.execPath, [GUARDS[guard], ...args], { encoding: "utf8" });
  return { status: r.status, out: r.stdout + r.stderr };
}

const UI_HAPPY = `
  const themeHandle = primeTheme(bridge, { target: shell });
  bridge.onEvent("host.theme.changed", (data) => paint(data));
  bridge.onEvent("meeting.ended", () => refresh());
  await bridge.callTool("meeting_start", { context });
`;
const keep = () => {};

describe("validate-hostapi / validate-events see src/ui", () => {
  it("passes on a root whose UI references only what the manifest declares", () => {
    const root = pluginRoot(keep, UI_HAPPY);
    for (const guard of ["hostapi", "events"] as const) {
      const r = run(guard, "--root", root);
      expect(r.status, `${guard}: ${r.out}`).toBe(0);
    }
  });

  it("fails when a UI-called tool loses app visibility", () => {
    const root = pluginRoot((block) => {
      const tool = block.tools.find((t) => t.name === "meeting_start");
      if (!tool?._meta?.ui?.visibility) throw new Error("meeting_start must carry ui visibility in the real manifest");
      tool._meta.ui.visibility = tool._meta.ui.visibility.filter((v) => v !== "app");
    }, UI_HAPPY);
    const r = run("hostapi", "--root", root);
    expect(r.status).toBe(1);
    expect(r.out).toContain('bridge.callTool("meeting_start") in src/ui/panel.js');
  });

  it("fails when a UI-subscribed event is no longer emitted", () => {
    const root = pluginRoot((block) => {
      block.emittedEvents = block.emittedEvents.filter((ev) => ev !== "meeting.ended");
    }, UI_HAPPY);
    for (const guard of ["hostapi", "events"] as const) {
      const r = run(guard, "--root", root);
      expect(r.status, guard).toBe(1);
      expect(r.out, guard).toContain('bridge.onEvent("meeting.ended") in src/ui/panel.js');
    }
  });

  it("accepts the theme broadcast without a subscription and checks optional-chained literals", () => {
    // host.theme.changed reaches every plugin webview from the host itself;
    // the manifest does not subscribe to it and must not have to. An
    // optional-chained call is still a call, so its literal is checked.
    const root = pluginRoot(keep, `
      primeTheme(bridge, { target: shell });
      bridge?.onEvent?.("host.theme.changed", (data) => paint(data));
      bridge?.callTool?.("meeting_absent_tool", {});
    `);
    const r = run("hostapi", "--root", root);
    expect(r.status).toBe(1);
    expect(r.out).toContain('bridge.callTool("meeting_absent_tool")');
    expect(r.out).not.toContain("host.theme.changed");
  });

  it("ignores names that are not string literals", () => {
    const root = pluginRoot(keep, `
      const name = pick();
      if (typeof bridge.callTool === "function") await bridge.callTool(name, {});
      bridge.onEvent(eventType, handler);
      bridge.callTool(\`meeting_\${kind}\`, {});
    `);
    for (const guard of ["hostapi", "events"] as const) {
      expect(run(guard, "--root", root).status, guard).toBe(0);
    }
  });

  it("ignores calls inside comments", () => {
    // src/ui/meeting-control.js carries a `bridge.callTool("meeting_upload_file", …)`
    // in a comment today; a commented-out call is not a call the host sees.
    const root = pluginRoot(keep, `
      // bridge.callTool("meeting_commented_out", {});
      /* bridge.onEvent("meeting.commented.out", () => {});
         bridge.callTool("meeting_also_commented", {}); */
      await bridge.callTool("meeting_start", {});
    `);
    for (const guard of ["hostapi", "events"] as const) {
      const r = run(guard, "--root", root);
      expect(r.status, `${guard}: ${r.out}`).toBe(0);
      expect(r.out, guard).not.toContain("commented");
    }
  });

  it("scans .mjs and .cjs UI files too", () => {
    for (const uiFile of ["panel.mjs", "panel.cjs"]) {
      const root = pluginRoot(keep, `bridge.callTool("meeting_absent_tool", {});`, uiFile);
      const r = run("hostapi", "--root", root);
      expect(r.status, uiFile).toBe(1);
      expect(r.out, uiFile).toContain(`in src/ui/${uiFile}`);
    }
  });

  it("refuses an explicit --root that is not a plugin, and --root without a value", () => {
    const empty = mkdtempSync(join(tmpdir(), "meeting-not-a-plugin-"));
    onTestFinished(() => rmSync(empty, { recursive: true, force: true }));
    for (const guard of ["hostapi", "events"] as const) {
      const bare = run(guard, "--root");
      expect(bare.status, `${guard} bare: ${bare.out}`).toBe(2);
      expect(bare.out, guard).toContain("--root needs a plugin directory");
      const notPlugin = run(guard, "--root", empty);
      expect(notPlugin.status, `${guard} empty: ${notPlugin.out}`).toBe(2);
      expect(notPlugin.out, guard).toContain("missing plugin.json, src");
    }
  });
});
