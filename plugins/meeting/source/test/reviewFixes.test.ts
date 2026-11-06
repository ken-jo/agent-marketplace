import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import createPlugin from "../src/hostPlugin.js";
import { MockSttProvider, MockSummaryProvider } from "../src/adapters/mockProviders.js";
import { MeetingPipeline } from "../src/pipeline/meetingPipeline.js";
import { createErrorConsumer } from "../src/ui/viewUpdates.js";

async function fixture(listAudioInputDevices?: () => Promise<readonly { deviceId: string; label: string }[]>) {
  const root = mkdtempSync(join(tmpdir(), "meeting-review-"));
  const config: Record<string, unknown> = { summaryLengthTier: "short" };
  const context = { pluginId: "meeting", pluginRoot: root, pluginDataDir: root, hostRoot: root,
    config: { summaryLengthTier: "long", transcriptBubbleMaxChars: 999 },
    hostApi: { getSecret: () => null, callLlm: async () => "{}", listAudioInputDevices,
      config: { get: (key: string) => config[key], set: async (key: string, value: unknown) => { config[key] = value; } },
      attachFloatingPanel: async () => ({ panelId: "fixture", height: 360, detach: async () => {}, onDetached: () => {} }),
    } };
  const plugin = await createPlugin(context);
  return { plugin, config, async dispose() { await plugin.stop(); rmSync(root, { recursive: true, force: true }); } };
}

describe("meeting review server fixes", () => {
  it("gives an STT failure a stable sequence that later writes cannot re-notify", async () => {
    const f = await fixture();
    try {
      await f.plugin.handlers.batch_processing_audio({ sessionId: "error-one" });
      const chunk = { pcm16leMono: Array.from({ length: 320 }, () => 0), sampleRate: 16000, startSec: 0, endSec: 0.02 };
      await expect(f.plugin.handlers.meeting_push_chunk({ sessionId: "error-one", chunk })).rejects.toThrow();
      const error = (await f.plugin.handlers.meeting_view_state()).lastError;
      expect(error?.sequence).toBeGreaterThan(0);
      const consume = createErrorConsumer();
      expect(consume(error)).toBe(true);
      await f.plugin.handlers.meeting_set_prompt({ key: "customSummaryFinalPrompt", value: "Concise" });
      expect(consume((await f.plugin.handlers.meeting_view_state()).lastError)).toBe(false);
      await f.plugin.handlers.batch_processing_audio({ sessionId: "error-two" });
      await expect(f.plugin.handlers.meeting_push_chunk({ sessionId: "error-two", chunk })).rejects.toThrow();
      expect(consume((await f.plugin.handlers.meeting_view_state()).lastError)).toBe(true);
    } finally { await f.dispose(); }
  });

  it("uses host configuration only, including when a key is absent", async () => {
    const f = await fixture();
    try {
      const state = await f.plugin.handlers.meeting_view_state();
      expect(state.config.summaryLengthTier).toBe("short");
      expect(state.config.transcriptBubbleMaxChars).toBeUndefined();
    } finally { await f.dispose(); }
  });

  it("reports missing and failed microphone enumeration explicitly", async () => {
    for (const list of [undefined, async () => { throw Error("private@example.com"); }]) {
      const f = await fixture(list);
      try {
        await f.plugin.handlers.meeting_start({ sessionId: "mic-test" });
        const result = await f.plugin.handlers.meeting_recorder_microphones();
        expect(result).toMatchObject({ ok: false, error: "microphone-list-unavailable" });
        expect(result).not.toHaveProperty("devices");
        expect(JSON.stringify(result)).not.toContain("private@example.com");
      } finally { await f.dispose(); }
    }
  });

  it("distinguishes a successful empty microphone list from unavailability", async () => {
    const f = await fixture(async () => []);
    try {
      await f.plugin.handlers.meeting_start({ sessionId: "mic-empty" });
      expect(await f.plugin.handlers.meeting_recorder_microphones()).toEqual({ ok: true, devices: [] });
    } finally { await f.dispose(); }
  });

  it("keeps pipeline persistence diagnostics specific, at warn, and free of PII", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const pipeline = new MeetingPipeline({ sttProvider: new MockSttProvider(), summaryProvider: new MockSummaryProvider(),
        onSessionUpdate: () => { throw Error("/private/person@example.com/transcript words"); } });
      pipeline.startSession("private-session");
      const text = write.mock.calls.map(([line]) => String(line)).join("");
      expect(text).toContain('"level":"warn","code":"meeting_pipeline.session_persist_failed"');
      expect(text).not.toMatch(/person@example|transcript words|private-session/);
    } finally { write.mockRestore(); }
  });
});


describe("recorder microphone availability UI", () => {
  async function render(result: unknown, rejects = false) {
    const source = readFileSync(new URL("../src/ui/recorder-card.js", import.meta.url), "utf8");
    const start = source.indexOf("async function populateMicList()");
    const end = source.indexOf("// Restart the audio chain", start);
    const select = { options: [] as Array<{value: string; textContent: string}>, disabled: false, value: "", label: "",
      replaceChildren(...items: Array<{value: string; textContent: string}>) { this.options = items; },
      appendChild(item: {value: string; textContent: string}) { this.options.push(item); },
      setAttribute(_key: string, value: string) { this.label = value; } };
    const populate = runInNewContext(source.slice(start, end) + "\npopulateMicList", {
      host: { listMicrophones: async () => { if (rejects) throw Error("denied"); return result; } },
      micSelect: select, preferredMicId: "", document: { createElement: () => ({value: "", textContent: ""}) },
    });
    await populate();
    return select;
  }
  it("shows an explicit unavailable label for a server failure or denied call", async () => {
    for (const rejects of [false, true]) {
      const select = await render({ ok: false, error: "microphone-list-unavailable" }, rejects);
      expect(select.disabled).toBe(true);
      expect(select.label).toBe("Microphone list unavailable");
      expect(select.options[0]?.textContent).toBe("Microphone list unavailable");
    }
  });
  it("distinguishes no devices and recovers the picker when enumeration succeeds", async () => {
    expect((await render({ ok: true, devices: [] })).label).toBe("No microphones found");
    const select = await render({ ok: true, devices: [{deviceId: "fixture", label: "Fixture mic"}] });
    expect(select.disabled).toBe(false);
    expect(select.options[1]?.textContent).toBe("Fixture mic");
  });
});
