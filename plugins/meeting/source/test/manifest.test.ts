/**
 * Manifest regression test — plugin.json UI-callable allowlist.
 *
 * The host (Ave) gates renderer → plugin IPC through
 * PluginRuntime.callFromUi(), which rejects any tool call whose
 * `_meta.ui.visibility` does not include "app" (pure v6 manifest: tools[]
 * is Tool[] with per-tool visibility, no more separate uiActions[] map).
 * When the meeting UI (sidebar slot) calls any meeting-control.js
 * bridge.callTool("...") method, any tool missing "app" visibility
 * surfaces as a silent IPC rejection — the renderer updates local state,
 * but the host never receives the call.
 *
 * This test locks the invariant: every UI-invoked method must carry "app"
 * visibility, otherwise the sidebar UI breaks silently.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CUSTOM_PROMPT_MAX_BYTES } from "../src/adapters/summaryPrompts.js";
import { flattenAgentPluginsManifest } from "@ave/plugin-contract";
import { scanUiBridgeUsage } from "../scripts/ui-bridge-usage.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MANIFEST_PATH = join(__dirname, "..", "plugin.json");
const HOST_PLUGIN_PATH = join(__dirname, "..", "src", "hostPlugin.ts");
const HOST_API_VALIDATOR_PATH = join(__dirname, "..", "scripts", "validate-hostapi.mjs");
const UI_DIR = join(__dirname, "..", "src", "ui");

type Tool = {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { type?: unknown; items?: unknown }>;
  } & Record<string, unknown>;
  _meta?: { ui?: { visibility?: string[] } };
};

type Manifest = {
  tools?: Tool[];
  ui?: Array<{ id?: string; slot: string; entry?: string; window?: unknown }>;
  configSchema?: { properties?: Record<string, { maxLength?: number }> };
  pluginAccess?: { plugins?: Array<{ pluginId: string }> };
  eventSubscriptions?: Array<string | { type: string }>;
  configInherits?: Array<{ pluginId: string; to: string; value: unknown }>;
  alerts?: { kinds?: Array<{ id: string; inherits?: Array<{ pluginId: string }> }> };
};

describe("plugin.json manifest", () => {
  const manifest = flattenAgentPluginsManifest(
    JSON.parse(readFileSync(MANIFEST_PATH, "utf8")),
  ) as unknown as Manifest;
  const tools = manifest.tools ?? [];
  const toolByName = new Map(tools.map((t) => [t.name, t]));
  const uiActions = tools.filter((t) => t._meta?.ui?.visibility?.includes("app")).map((t) => t.name);
  const llmTools = tools.filter((t) => t._meta?.ui?.visibility?.includes("model")).map((t) => t.name);

  it("does not revive retired keyword-to-tool dispatch", () => {
    expect(manifest).not.toHaveProperty("keywords");
    for (const path of [HOST_PLUGIN_PATH, HOST_API_VALIDATOR_PATH]) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(/\bregisterKeywords\b|manifest\.keywords/);
    }
  });

  it("does not declare retired host-owned auxiliary window metadata", () => {
    for (const extension of manifest.ui ?? []) {
      expect(
        extension,
        `ui extension "${extension.id ?? "unknown"}" must render inline`,
      ).not.toHaveProperty("window");
    }
  });

  it("retires work-assistant event access while retaining its config migration", () => {
    expect(manifest.pluginAccess?.plugins?.map((grant) => grant.pluginId)).not.toContain("work-assistant");
    const subscriptions = (manifest.eventSubscriptions ?? []).map((event) => typeof event === "string" ? event : event.type);
    expect(subscriptions.filter((event) => event.startsWith("work_assistant."))).toEqual([]);
    expect(manifest.configInherits).toContainEqual({
      pluginId: "work-assistant", to: "calendarAutomationEnabled", value: true,
    });
    expect(manifest.alerts?.kinds?.find((kind) => kind.id === "summary-ready")?.inherits)
      .toContainEqual(expect.objectContaining({ pluginId: "work-assistant" }));
  });

  it("declares all UI-invoked tools with app visibility", () => {
    // Every UI file that calls tools, through the same scan the validators
    // use. The sidebar panel and the recorder card both call tools; a tool
    // either calls without app visibility is rejected by the host with
    // nothing in this repo to say so, which is the failure this prevents.
    const scanned = scanUiBridgeUsage(UI_DIR);
    const callers = scanned.filter((f) => f.callTool.size > 0).map((f) => basename(f.file)).sort();
    expect(callers, "the scan stopped seeing the UI bundles").toEqual(["meeting-control.js", "recorder-card.js"]);
    for (const { file, callTool } of scanned) {
      for (const tool of [...callTool].sort()) {
        expect(uiActions, `no tool named "${tool}" has app visibility — the UI call in ${file} will be silently rejected by host`).toContain(tool);
      }
    }
  });

  it("keeps staged upload transfer methods off the LLM tool surface", () => {
    for (const name of [
      "meeting_stage_upload_begin",
      "meeting_stage_upload_chunk",
      "meeting_stage_upload_finish",
      "meeting_stage_upload_cancel",
    ]) {
      expect(uiActions, `"${name}" must have app visibility`).toContain(name);
      expect(llmTools, `${name} is an internal UI transfer method, not an LLM tool`).not.toContain(name);
      expect(toolByName.get(name)?.description, `${name} must not have an LLM tool description`).toBeUndefined();
    }
  });

  it("does not expose custom summary prompt mutation as a plugin tool", () => {
    const toolNames = tools.map((t) => t.name);
    for (const tool of toolNames) {
      expect(
        /prompt|meeting_update_ui_config|summary_prompt/i.test(tool),
        `Prompt mutation must stay on the UI-only bridge.config surface, not tools[]: ${tool}`,
      ).toBe(false);
    }
  });

  it("does not expose internal UI/theme relay tools", () => {
    const forbidden = ["meeting_get_ui_config", "meeting_propagate_theme"];
    for (const tool of forbidden) {
      expect(toolByName.has(tool), `${tool} must not be declared as a tool at all`).toBe(false);
    }
  });

  it("keeps custom prompt schema caps aligned with runtime sanitizer", () => {
    const properties = manifest.configSchema?.properties ?? {};
    expect(properties.customSummaryFinalPrompt?.maxLength).toBe(CUSTOM_PROMPT_MAX_BYTES);
    expect(properties.customSummaryIntermediatePrompt?.maxLength).toBe(CUSTOM_PROMPT_MAX_BYTES);
  });

  it("has a sidebar UI extension that justifies the app-visibility allowlist", () => {
    const hasSidebar = (manifest.ui ?? []).some((u) => u.slot === "sidebar");
    expect(hasSidebar).toBe(true);
  });

  // Regression lock: briefing → prep rename (2026-05-19)
  it("declares the 5 prep tool names (not the old briefing names)", () => {
    const toolNames = tools.map((t) => t.name);
    const prepTools = ["meeting_open_prep", "meeting_get_prep", "meeting_bulk_upsert_preps", "meeting_list_preps", "meeting_delete_prep"];
    const oldTools = ["meeting_open_briefing", "meeting_get_briefing", "meeting_bulk_upsert_briefings", "meeting_list_briefings", "meeting_delete_briefing"];
    for (const t of prepTools) {
      expect(toolNames, `tools[] must contain "${t}"`).toContain(t);
    }
    for (const t of oldTools) {
      expect(toolNames, `tools[] must NOT contain old name "${t}" (hard rename — no compat alias)`).not.toContain(t);
    }
  });

  it("declares meeting registration tools as LLM-only tools", () => {
    for (const tool of [
      "meeting_register_manual_meeting",
      "meeting_register_scheduled_meeting",
      "meeting_register_scheduled_meetings",
    ]) {
      expect(llmTools, `"${tool}" must have model visibility`).toContain(tool);
      expect(uiActions, `${tool} should be automation-facing, not UI-invoked`).not.toContain(tool);
    }
  });

  it("emits meeting.prep.opened (not the old meeting.briefing.opened)", () => {
    const manifest2 = flattenAgentPluginsManifest(
      JSON.parse(readFileSync(MANIFEST_PATH, "utf8")),
    ) as unknown as { emittedEvents?: string[] };
    const events = manifest2.emittedEvents ?? [];
    expect(events).toContain("meeting.prep.opened");
    expect(events).not.toContain("meeting.briefing.opened");
  });

  it("emits meeting.prep.registered for background scheduled-meeting sync", () => {
    const manifest2 = flattenAgentPluginsManifest(
      JSON.parse(readFileSync(MANIFEST_PATH, "utf8")),
    ) as unknown as { emittedEvents?: string[] };
    const events = manifest2.emittedEvents ?? [];
    expect(events).toContain("meeting.prep.registered");
  });

  it("documents registration tools for both manual and automatic meeting creation", () => {
    const manual = toolByName.get("meeting_register_manual_meeting");
    const single = toolByName.get("meeting_register_scheduled_meeting");
    const bulk = toolByName.get("meeting_register_scheduled_meetings");
    expect(manual?.description ?? "").toMatch(/채팅에서 직접 말한 예정 미팅 1건|title\/time\/participants/);
    expect(manual?.description ?? "").toMatch(/meeting_register_scheduled_meeting|meeting_register_scheduled_meetings/);
    expect(single?.description ?? "").toMatch(/이미 외부에서 만들어진 예정 회의 1건|회의실 예약|화상회의 생성|캘린더 이벤트/);
    expect(single?.description ?? "").toMatch(/원본 일정 생성도 녹음 시작도 하지 않습니다/);
    expect(single?.description ?? "").toMatch(/top-level 회의 필드|사용자에게 먼저 물어보세요/);
    expect(single?.description ?? "").toMatch(/회의 관련 메일이 있다는 이유만으로 자동 호출하지 마세요/);
    expect(single?.description ?? "").toMatch(/회의 안건|needsAgenda/);
    expect(single?.description ?? "").toMatch(/Webex 회의.*webexUrl|conference\.joinUrl/);
    expect(single?.description ?? "").toContain("해당 미팅에 대해 녹음을 진행하실 거라면, 미팅 익스텐션에도 일정을 등록해두겠습니다.");
    expect(bulk?.description ?? "").toMatch(/예정 회의 여러 건|bulk|캘린더 동기화/);
    expect(bulk?.description ?? "").toMatch(/meeting_register_manual_meeting|meeting_register_scheduled_meeting|meeting_open_prep/);
    expect(bulk?.description ?? "").toMatch(/회의 관련 메일이 있다는 이유만으로 자동 호출하지 마세요/);
    expect(bulk?.description ?? "").toMatch(/둘 다 없으면 이 tool 을 호출하지 말고|사용자에게 먼저 물어보세요/);
  });

  it("declares the intended input shapes for manual and scheduled meeting registration", () => {
    const manualProps = toolByName.get("meeting_register_manual_meeting")?.inputSchema?.properties ?? {};
    const singleProps = toolByName.get("meeting_register_scheduled_meeting")?.inputSchema?.properties ?? {};
    const bulkProps = toolByName.get("meeting_register_scheduled_meetings")?.inputSchema?.properties ?? {};
    expect(manualProps).toHaveProperty("title");
    expect(manualProps).toHaveProperty("scheduledStart");
    expect(manualProps).toHaveProperty("focusInUi");
    expect(singleProps).toHaveProperty("event");
    expect(singleProps).toHaveProperty("title");
    expect(singleProps).toHaveProperty("scheduledStart");
    expect(singleProps).toHaveProperty("joinUrl");
    expect(singleProps).toHaveProperty("agenda");
    expect(singleProps).toHaveProperty("agendaText");
    expect(singleProps).toHaveProperty("todayAgenda");
    expect(bulkProps).toHaveProperty("events");
  });

  it("keeps scheduled meeting agenda aliases strict-schema compatible", () => {
    const singleProps = toolByName.get("meeting_register_scheduled_meeting")?.inputSchema?.properties ?? {};
    expect(singleProps.meetingAgenda?.type).toBe("string");
    expect(singleProps.todayAgenda?.type).toBe("string");
  });

  it("keeps tool input schemas compatible with OpenAI-compatible function calling", () => {
    const forbiddenTopLevelKeywords = ["oneOf", "anyOf", "allOf", "enum", "not"];
    for (const name of llmTools) {
      const schema = toolByName.get(name)?.inputSchema;
      expect(schema?.type, `${name} inputSchema must be a top-level object`).toBe("object");
      for (const keyword of forbiddenTopLevelKeywords) {
        expect(schema ?? {}, `${name} inputSchema must not use top-level ${keyword}`).not.toHaveProperty(keyword);
      }
    }
  });

  it("all prep tool schemas carry the disambiguation negative anchor", () => {
    const prepTools = ["meeting_open_prep", "meeting_get_prep", "meeting_bulk_upsert_preps", "meeting_list_preps", "meeting_delete_prep"];
    for (const t of prepTools) {
      const desc = toolByName.get(t)?.description ?? "";
      expect(desc, `${t} description must contain negative anchor`).toContain("회의실(공간/시설 단위 자원) 예약·조회와 무관");
    }
  });

  it("every documented tool carries the disambiguation negative anchor", () => {
    for (const t of tools) {
      if (t.description === undefined) continue;
      expect(t.description, `${t.name} description must contain negative anchor`).toContain("회의실(공간/시설 단위 자원) 예약·조회와 무관");
    }
  });

  it("destructive tools not called by UI are excluded from app visibility", () => {
    expect(uiActions, "meeting_delete_prep is not UI-invoked — must not have app visibility").not.toContain("meeting_delete_prep");
  });
});
