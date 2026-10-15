/**
 * The recorder's slot in the host's floating dock.
 *
 * What this is really testing is a REDUCTION. The recorder used to build its
 * own frameless, transparent, always-on-top `BrowserWindow` through a
 * variable-held `require("electron")`, and drive it over twelve private
 * `ipcMain` channels. The suite's fake for that was a `Module._load` stub — it
 * had to reproduce Electron to reach the feature at all.
 *
 * A fake host API is enough now, and that is the argument: everything the
 * plugin can no longer reach is everything it no longer has to be handed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DetachReason } from "@ave/plugin-contract";
import createPlugin from "../src/hostPlugin.js";

type EventHandler = (data: unknown) => void;
type DetachListener = (reason: DetachReason) => void;

/** One attached slot, as the host would hand it back. */
function makeFakeDock() {
  const attached: Array<{ extensionId: string; height?: number }> = [];
  const detached: string[] = [];
  let listener: DetachListener | null = null;
  let panelId = 0;
  const attachFloatingPanel = vi.fn(async (request: { extensionId: string; height?: number }) => {
    attached.push(request);
    panelId += 1;
    const id = `panel-${panelId}`;
    return {
      panelId: id,
      // Deliberately NOT the requested height: the dock clamps, and a caller
      // that assumed its request was honoured would read the wrong number.
      height: 180,
      resize: vi.fn(async (h: number) => Math.min(h, 300)),
      detach: vi.fn(async () => { detached.push(id); }),
      onDetached: (fn: DetachListener) => { listener = fn; },
    };
  });
  return {
    attachFloatingPanel,
    attached,
    detached,
    /** Drive the host's side of a teardown the plugin did not ask for. */
    fireDetached: (reason: DetachReason) => listener?.(reason),
  };
}

/** A host capture that opens and produces nothing. */
function makeFakeCapture() {
  return vi.fn(async () => ({
    captureId: "capture-1",
    opened: { microphone: true, systemAudio: false },
    onFrame: (_l: unknown) => () => { /* no frames — the transcript stays empty */ },
    onEnd: (_l: unknown) => () => { /* never ends on its own */ },
    stop: vi.fn(async () => { /* no-op */ }),
  }));
}

function makeContext(dock: ReturnType<typeof makeFakeDock>, extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "ave-meeting-test-dock-"));
  mkdirSync(join(root, "sessions"), { recursive: true });
  const events: Array<{ type: string; data: unknown }> = [];
  return {
    events,
    context: {
      pluginId: "meeting",
      pluginRoot: root,
      hostRoot: root,
      pluginDataDir: root,
      log: (_msg: string) => { /* no-op */ },
      hostApi: {
        emitEvent: (type: string, data?: unknown) => { events.push({ type, data }); },
        onEvent: (_type: string, _handler: EventHandler) => () => { /* no-op */ },
        getSecret: (_key: string): string | null => null,
        logEvent: vi.fn(),
        onShutdown: (_h: () => void | Promise<void>) => { /* no-op */ },
        attachFloatingPanel: dock.attachFloatingPanel,
        startAudioCapture: makeFakeCapture(),
        ...extra,
      },
    },
  };
}

describe("meeting_start attaches a dock slot", () => {
  let dock: ReturnType<typeof makeFakeDock>;
  beforeEach(() => { dock = makeFakeDock(); });

  it("asks for its own declared floating surface by id", async () => {
    const { context } = makeContext(dock);
    const plugin = await createPlugin(context);
    await plugin.handlers.meeting_start({ sessionId: "dock-a" });

    expect(dock.attachFloatingPanel).toHaveBeenCalledTimes(1);
    // The id has to match plugin.json's `ui` entry or the host refuses. It is
    // a NAME, not a path — nothing here chooses what gets loaded.
    expect(dock.attached[0]?.extensionId).toBe("meeting-recorder-card");
    expect(dock.attached[0]?.height).toBeGreaterThan(0);
  });

  it("is idempotent for the same session", async () => {
    const { context } = makeContext(dock);
    const plugin = await createPlugin(context);
    await plugin.handlers.meeting_start({ sessionId: "dock-a" });
    const again = await plugin.handlers.meeting_start({ sessionId: "dock-a" });

    expect(again).toEqual({ ok: true, reused: true });
    expect(dock.attachFloatingPanel).toHaveBeenCalledTimes(1);
  });

  it("refuses a second session rather than replacing the first", async () => {
    // The host permits one audio capture at a time, so the second card would
    // watch a recording that cannot start — and it would do so with the first
    // meeting's card gone from the screen. Ending that recording is a
    // decision, and it is not this function's to make.
    const { context } = makeContext(dock);
    const plugin = await createPlugin(context);
    await plugin.handlers.meeting_start({ sessionId: "dock-a" });

    await expect(plugin.handlers.meeting_start({ sessionId: "dock-b" }))
      .rejects.toThrow(/already open for session dock-a/);
    expect(dock.attachFloatingPanel).toHaveBeenCalledTimes(1);
  });

  it("refuses loudly on a host with no dock", async () => {
    // No fallback: a sidebar-only degradation would leave a recording running
    // with nothing on screen driving it, which is the failure the user cannot
    // see and cannot act on.
    const root = mkdtempSync(join(tmpdir(), "ave-meeting-test-nodock-"));
    mkdirSync(join(root, "sessions"), { recursive: true });
    const plugin = await createPlugin({
      pluginId: "meeting",
      pluginRoot: root,
      hostRoot: root,
      pluginDataDir: root,
      log: () => { /* no-op */ },
      hostApi: {
        emitEvent: () => { /* no-op */ },
        onEvent: () => () => { /* no-op */ },
        getSecret: (): string | null => null,
        logEvent: vi.fn(),
        onShutdown: () => { /* no-op */ },
      },
    });

    await expect(plugin.handlers.meeting_start({ sessionId: "dock-a" }))
      .rejects.toThrow(/attachFloatingPanel/);
  });
});

describe("the recorder's tools act on the attached slot, not on their arguments", () => {
  let dock: ReturnType<typeof makeFakeDock>;
  beforeEach(() => { dock = makeFakeDock(); });

  it("reports the attached session and refuses when nothing is attached", async () => {
    const { context } = makeContext(dock);
    const plugin = await createPlugin(context);

    expect(await plugin.handlers.meeting_recorder_state()).toBeNull();
    await plugin.handlers.meeting_start({ sessionId: "dock-a", context: { title: "주간 회의" } });

    expect(await plugin.handlers.meeting_recorder_state())
      .toEqual({ sessionId: "dock-a", context: { title: "주간 회의" } });
  });

  it("refuses every recorder tool while no slot is attached", async () => {
    // The old handlers resolved the caller from the sender's webContents id
    // and returned "unauthorized" when it matched no window. A tool call has
    // no sender, so the same refusal has to come from there being no panel —
    // otherwise these would act on whatever session was named.
    const { context } = makeContext(dock);
    const plugin = await createPlugin(context);

    expect(await plugin.handlers.meeting_recorder_levels()).toEqual({ peaks: [] });
    expect(await plugin.handlers.meeting_recorder_microphones()).toEqual({ devices: [] });
    expect(await plugin.handlers.meeting_recorder_set_paused({ paused: true }))
      .toEqual({ ok: false, error: "unauthorized" });
    expect(await plugin.handlers.meeting_recorder_restart_capture({}))
      .toEqual({ ok: false, error: "unauthorized" });
    expect(await plugin.handlers.meeting_recorder_resize({ height: 300 }))
      .toEqual({ ok: false, error: "unauthorized" });
  });

  it("pauses the attached session even when told a different one", async () => {
    // The ACL, stated where it could be broken. Honouring a sessionId argument
    // is exactly what the sender-keyed handlers refused to do.
    const { context } = makeContext(dock);
    const plugin = await createPlugin(context);
    await plugin.handlers.meeting_start({ sessionId: "dock-a" });

    expect(await plugin.handlers.meeting_recorder_set_paused({
      paused: true,
      sessionId: "somebody-elses-meeting",
    })).toEqual({ ok: true, paused: true });
  });

  it("returns the height the dock applied, not the one requested", async () => {
    const { context } = makeContext(dock);
    const plugin = await createPlugin(context);
    await plugin.handlers.meeting_start({ sessionId: "dock-a" });

    expect(await plugin.handlers.meeting_recorder_resize({ height: 900 }))
      .toEqual({ ok: true, height: 300 });
  });

  it("refuses a non-finite height rather than defaulting", async () => {
    const { context } = makeContext(dock);
    const plugin = await createPlugin(context);
    await plugin.handlers.meeting_start({ sessionId: "dock-a" });

    expect(await plugin.handlers.meeting_recorder_resize({ height: "tall" }))
      .toEqual({ ok: false, error: "invalid-height" });
  });
});

describe("detach reason decides whether the recording was orphaned", () => {
  let dock: ReturnType<typeof makeFakeDock>;
  beforeEach(() => { dock = makeFakeDock(); });

  it("treats a close the plugin asked for as deliberate", async () => {
    const { context, events } = makeContext(dock);
    const plugin = await createPlugin(context);
    await plugin.handlers.meeting_start({ sessionId: "dock-a" });

    expect(await plugin.handlers.meeting_recorder_close()).toEqual({ ok: true });
    dock.fireDetached("requested");

    expect(events.filter((e) => e.type === "meeting.ended")).toHaveLength(0);
    // And the slot is free again, which the refusal test above proves is the
    // difference between one recording and none.
    await expect(plugin.handlers.meeting_start({ sessionId: "dock-b" })).resolves.toBeTruthy();
  });

  it("cancels the session when the user closes the dock", async () => {
    const { context, events } = makeContext(dock);
    const plugin = await createPlugin(context);
    await plugin.handlers.meeting_start({ sessionId: "dock-a" });
    // ACTUALLY recording. `cancelOrphanedSession` returns early for a session
    // that is not active, so without this the assertion would pass on a
    // recording that never started — and keep passing if the orphan path broke.
    await plugin.handlers.meeting_recorder_begin_capture({});

    dock.fireDetached("user-closed");

    const ended = events.filter((e) => e.type === "meeting.ended");
    expect(ended).toHaveLength(1);
    expect(ended[0]?.data).toMatchObject({ sessionId: "dock-a", cancelled: true, reason: "user-closed" });
  });

  it("cancels the session when the card's renderer dies", async () => {
    const { context, events } = makeContext(dock);
    const plugin = await createPlugin(context);
    await plugin.handlers.meeting_start({ sessionId: "dock-a" });
    await plugin.handlers.meeting_recorder_begin_capture({});

    dock.fireDetached("renderer-gone");

    expect(events.filter((e) => e.type === "meeting.ended")[0]?.data)
      .toMatchObject({ cancelled: true, reason: "renderer-gone" });
  });

  it("leaves plugin-stopped and host-shutdown to the runtime teardown", async () => {
    // Those paths choose between finalizing an active recording and cancelling
    // it, with context this handler does not have. Cancelling here as well
    // would throw away a meeting that was about to be summarised.
    const { context, events } = makeContext(dock);
    const plugin = await createPlugin(context);
    await plugin.handlers.meeting_start({ sessionId: "dock-a" });
    await plugin.handlers.meeting_recorder_begin_capture({});

    dock.fireDetached("host-shutdown");

    expect(events.filter((e) => e.type === "meeting.ended")).toHaveLength(0);
    // The control: `meeting.started` DID fire, so an empty `meeting.ended`
    // filter means "not cancelled" rather than "no events were recorded".
    expect(events.filter((e) => e.type === "meeting.started")).toHaveLength(1);
  });
});
