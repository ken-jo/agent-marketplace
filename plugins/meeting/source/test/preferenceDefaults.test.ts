import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const sidebar = readFileSync(new URL("../src/ui/meeting-control.mjs", import.meta.url), "utf8");
const recorder = readFileSync(new URL("../src/ui/recorder-card.js", import.meta.url), "utf8");
const slice = (source: string, from: string, to: string) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  if (start < 0 || end < 0) throw Error("UI handler not found");
  return source.slice(start, end);
};

describe("run-local preference defaults", () => {
  it("initializes documented defaults when storage is empty or throws", () => {
    for (const getItem of [() => null, () => { throw Error("unavailable"); }]) {
      const localStorage = { getItem };
      const length = runInNewContext(slice(sidebar, '  const LENGTH_TIER_KEY', '  function setPickedLengthTier') + '\npickedLengthTier', { localStorage });
      const capture = runInNewContext(slice(recorder, 'const PREF_MIC_KEY', 'const micControls') + '\n({ preferredMicId, captureMode })', { localStorage });
      expect(length).toBe("medium");
      expect(capture).toEqual({ preferredMicId: "", captureMode: "mix" });
    }
  });

  it("Done sends an explicit medium tier when the init context has none", async () => {
    for (const context of [undefined, {}, { lengthTier: "invalid" }, { lengthTier: "long" }]) {
      let click: () => Promise<void> = async () => {};
      const stop = vi.fn(async () => {});
      runInNewContext(slice(recorder, 'doneBtn.addEventListener', '// ─── Mic device picker'), {
        context, sessionId: "fixture", started: false, levelsPollInterval: null,
        doneBtn: { addEventListener: (_name: string, callback: typeof click) => { click = callback; }, replaceChildren: () => {} },
        setBusy: () => {}, document: { createTextNode: (text: string) => text },
        host: { stop, close: async () => {} }, console,
      });
      await click();
      expect(stop).toHaveBeenCalledWith("fixture", { lengthTier: context?.lengthTier === "long" ? "long" : "medium" });
    }
  });

  it("regeneration explicitly sends the selected, displayed or default tier", async () => {
    for (const [stored, selected, expected] of [[undefined, undefined, "medium"], ["invalid", undefined, "medium"], ["long", undefined, "long"], ["long", "short", "short"]]) {
      const callTool = vi.fn(async () => ({}));
      const regenerate = runInNewContext(slice(sidebar, '  async function doRegenerate(', '  function renderBusy()') + '\ndoRegenerate', {
        snapshot: stored ? { lengthTier: stored } : {}, busyText: "", mode: "read", render: () => {},
        sessionId: "fixture", bridge: { callTool }, onChanged: undefined, showErrorToast: () => {},
      });
      await regenerate(selected);
      expect(callTool).toHaveBeenCalledWith("meeting_regenerate_summary", { sessionId: "fixture", lengthTier: expected });
    }
  });

  it("missing-minutes generation sends the view's explicit default tier", async () => {
    let click: () => Promise<void> = async () => {};
    const callTool = vi.fn(async () => ({}));
    const start = sidebar.indexOf('regenBtn.textContent = "🔄 지금 회의록 생성"');
    runInNewContext(slice(sidebar.slice(start), 'regenBtn.addEventListener', '          body.appendChild(regenBtn);'), {
      regenBtn: { disabled: false, textContent: "", addEventListener: (_name: string, callback: typeof click) => { click = callback; } },
      sessionId: "fixture", pickedLengthTier: "medium", bridge: { callTool }, snapshot: {}, renderSubTab: () => {}, showErrorToast: () => {},
    });
    await click();
    expect(callTool).toHaveBeenCalledWith("meeting_regenerate_summary", { sessionId: "fixture", lengthTier: "medium" });
  });
});
