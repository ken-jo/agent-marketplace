import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import createPlugin from "../src/hostPlugin.js";
import { diagnostic } from "../src/diagnostic.js";
import { flattenAgentPluginsManifest } from "@ave/plugin-contract";

const source = new URL("../", import.meta.url).pathname;
const manifest = flattenAgentPluginsManifest(JSON.parse(readFileSync(join(source, "plugin.json"), "utf8")));

describe("meeting MCP Apps contract", () => {
  it("serves both self-contained resources and bounds app-only polling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meeting-apps-"));
    const effects = vi.fn();
    const config: Record<string, unknown> = {};
    const plugin = await createPlugin({ pluginId: "meeting", pluginRoot: source, pluginDataDir: dir, hostRoot: dir,
      hostApi: { getSecret: () => null, callLlm: async () => "{}", hostFetch: effects,
        config: { get: key => config[key], set: async (key, value) => { config[key] = value; } } } });
    try {
      for (const resource of manifest.uiResources ?? []) {
        const html = plugin.readUiResource(resource.uri);
        expect(html).toContain('<main id="app">');
        expect(html).not.toMatch(/<script[^>]*\bsrc=/);
        expect(html).toContain('ui/initialize');
      }
      expect(() => plugin.readUiResource("ui://another/control")).toThrow();
      const state = await plugin.handlers.meeting_view_state();
      expect(state.recorder).toBeNull();
      expect(effects).not.toHaveBeenCalled();
      const reset = await plugin.handlers.meeting_wait_changes({ cursor: "", waitMs: 0 });
      const pending = plugin.handlers.meeting_wait_changes({ cursor: reset.cursor, waitMs: 10000 });
      await plugin.handlers.meeting_set_prompt({ key: "customSummaryFinalPrompt", value: "Be concise" });
      const changed = await pending;
      expect(changed.reset).toBe(false);
      expect(changed.changes).toContainEqual({ kind: "settings" });
      expect((await plugin.handlers.meeting_view_state()).config.customSummaryFinalPrompt).toBe("Be concise");
      await expect(plugin.handlers.meeting_set_prompt({ key: "sttApiKey", value: "bad" })).rejects.toThrow();
      const closing = plugin.handlers.meeting_wait_changes({ cursor: changed.cursor, waitMs: 10000 });
      await plugin.stop();
      expect((await closing).closed).toBe(true);
    } finally { await plugin.stop(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("declares only audited reads and keeps every UI tool app-visible", () => {
    const reads = ["meeting_transcript", "meeting_sessions", "meeting_previous_sessions", "meeting_sessions_by_category", "meeting_categories", "meeting_session_detail", "meeting_related_sessions", "meeting_list_preps", "meeting_get_prep", "meeting_recorder_state", "meeting_recorder_levels", "meeting_view_state", "meeting_wait_changes"];
    expect(manifest.tools.filter(t => t.annotations?.readOnlyHint).map(t => t.name).sort()).toEqual(reads.sort());
    for (const file of readdirSync(join(source, "src/ui"))) {
      if (!/\.(mjs|js)$/.test(file)) continue;
      const text = readFileSync(join(source, "src/ui", file), "utf8");
      for (const match of text.matchAll(/callTool\(["']([a-z_]+)["']/g)) {
        const tool = manifest.tools.find(t => t.name === match[1]);
        expect(tool?._meta?.ui?.visibility, match[1]).toContain("app");
      }
    }
  });

  it("writes only diagnostic codes to stderr", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      diagnostic("warn", "capture_failed", { transcript: "private words", attendee: "Someone", email: "person@example.com" });
      diagnostic("error", "Someone private words");
      expect(write.mock.calls.map(([s]) => s).join("")).toBe('{"plugin":"meeting","level":"warn","code":"capture_failed"}\n{"plugin":"meeting","level":"error","code":"runtime_diagnostic"}\n');
    } finally { write.mockRestore(); }
  });
});
