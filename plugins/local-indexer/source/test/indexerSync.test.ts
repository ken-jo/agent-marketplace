import { afterEach, describe, expect, it, vi } from "vitest";
import { runIndexerSync, syncHostContext, waitForRetry } from "../src/ui/indexer-sync.js";

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function view({ failCursor = false, status = "idle" } = {}) {
  const controller = new AbortController();
  const pending: Array<{ args: any; resolve: (value: any) => void }> = [];
  let scanStatus = status;
  const signal = controller.signal;
  const callTool = vi.fn((_name, args) => {
    if (args.waitMs === 0) return failCursor ? Promise.reject(new Error("cursor unavailable")) : Promise.resolve({ cursor: "old:0" });
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error("unmounted"));
      signal.addEventListener("abort", abort, { once: true });
      pending.push({ args, resolve: value => { signal.removeEventListener("abort", abort); resolve(value); } });
    });
  });
  const callbacks = {
    loadSettings: vi.fn(async () => {}),
    loadFolders: vi.fn(async () => {}),
    readScanStatus: vi.fn(async () => {}),
    refreshDocuments: vi.fn(async () => {}),
    onError: vi.fn(),
  };
  const done = runIndexerSync({ ...callbacks, callTool, signal, getScanStatus: () => scanStatus });
  return {
    ...callbacks, callTool, pending, signal, done,
    setStatus: (value: string) => { scanStatus = value; },
    async update(value: any) { expect(pending.length).toBe(1); pending.shift()!.resolve(value); await flush(); },
    async unmount() { controller.abort(); await done; },
  };
}
const update = (cursor: string, kinds: string[] = []) => ({ cursor, changes: kinds.map(kind => ({ kind })), reset: false, closed: false });
afterEach(() => vi.useRealTimers());

describe("the view's production wait loop", () => {
  it("re-reads status, folders and documents after a cursor reset", async () => {
    const panel = view(); await flush();
    try {
      await panel.update({ ...update("new:0"), reset: true });
      expect(panel.readScanStatus).toHaveBeenCalledTimes(2);
      expect(panel.loadSettings).toHaveBeenCalledTimes(2);
      expect(panel.loadFolders).toHaveBeenCalledTimes(2);
      expect(panel.refreshDocuments).toHaveBeenCalledTimes(2);
      expect(panel.pending[0].args.cursor).toBe("new:0");
    } finally { await panel.unmount(); }
  });

  it("defers 100 document invalidations during a scan and reloads once on completion", async () => {
    const panel = view({ status: "running" }); await flush();
    try {
      for (let i = 1; i <= 100; i++) await panel.update(update(`old:${i}`, ["index.document.updated", "index.scan.progress"]));
      expect(panel.refreshDocuments).toHaveBeenCalledTimes(1); // initial snapshot only
      expect(panel.loadFolders).toHaveBeenCalledTimes(1);
      expect(panel.readScanStatus).toHaveBeenCalledTimes(101);
      // Status can finish before the separate completion invalidation arrives.
      panel.setStatus("done");
      await panel.update(update("old:101", ["index.scan.progress"]));
      expect(panel.refreshDocuments).toHaveBeenCalledTimes(1);
      await panel.update(update("old:102", ["index.scan.completed", "index.document.updated"]));
      expect(panel.refreshDocuments).toHaveBeenCalledTimes(2);
      expect(panel.loadFolders).toHaveBeenCalledTimes(2);
      await panel.update(update("old:102"));
      expect(panel.refreshDocuments).toHaveBeenCalledTimes(2);
    } finally { await panel.unmount(); }
  });

  it("refreshes idle document changes and canceled scans", async () => {
    const panel = view(); await flush();
    try {
      await panel.update(update("old:1", ["index.document.updated"]));
      expect(panel.refreshDocuments).toHaveBeenCalledTimes(2);
      panel.setStatus("running");
      await panel.update(update("old:2", ["index.scan.progress"]));
      panel.setStatus("canceled");
      await panel.update(update("old:3", ["index.scan.progress"]));
      expect(panel.refreshDocuments).toHaveBeenCalledTimes(3);
    } finally { await panel.unmount(); }
  });

  it("retries closed processes with backoff, then applies the new process's reset", async () => {
    vi.useFakeTimers();
    const panel = view(); await flush();
    try {
      await panel.update({ ...update("old:0"), closed: true });
      expect(panel.pending).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(999);
      expect(panel.pending).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(panel.pending[0].args.cursor).toBe("old:0");
      await panel.update({ ...update("old:0"), closed: true });
      await vi.advanceTimersByTimeAsync(1999);
      expect(panel.pending).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await panel.update({ ...update("new:0"), reset: true });
      expect(panel.loadFolders).toHaveBeenCalledTimes(2);
      expect(panel.refreshDocuments).toHaveBeenCalledTimes(2);
      expect(panel.pending[0].args.cursor).toBe("new:0");
    } finally { await panel.unmount(); }
  });

  it("loads snapshots despite failure to acquire the initial cursor", async () => {
    const panel = view({ failCursor: true }); await flush();
    try {
      expect(panel.loadSettings).toHaveBeenCalledTimes(1);
      expect(panel.loadFolders).toHaveBeenCalledTimes(1);
      expect(panel.readScanStatus).toHaveBeenCalledTimes(1);
      expect(panel.refreshDocuments).toHaveBeenCalledTimes(1);
      expect(panel.pending[0].args).toEqual({ cursor: "", waitMs: 10000 });
    } finally { await panel.unmount(); }
  });

  it("replays an invalidation after a snapshot fails instead of losing its cursor", async () => {
    vi.useFakeTimers();
    const panel = view(); await flush();
    try {
      panel.readScanStatus.mockRejectedValueOnce(new Error("snapshot unavailable"));
      await panel.update(update("old:1", ["index.document.updated"]));
      expect(panel.onError).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(panel.pending[0].args.cursor).toBe("old:0");
      await panel.update(update("old:1", ["index.document.updated"]));
      expect(panel.refreshDocuments).toHaveBeenCalledTimes(2);
      expect(panel.pending[0].args.cursor).toBe("old:1");
    } finally { await panel.unmount(); }
  });

  it("attempts the remaining initial snapshots if one loader fails", async () => {
    const panel = view();
    panel.loadSettings.mockRejectedValueOnce(new Error("settings unavailable"));
    await flush();
    try {
      expect(panel.loadFolders).toHaveBeenCalledTimes(1);
      expect(panel.readScanStatus).toHaveBeenCalledTimes(1);
      expect(panel.refreshDocuments).toHaveBeenCalledTimes(1);
      expect(panel.pending[0].args.cursor).toBe("");
      await panel.update({ ...update("new:0"), reset: true });
      expect(panel.loadSettings).toHaveBeenCalledTimes(2);
    } finally { await panel.unmount(); }
  });

  it("aborts an in-flight wait on view cleanup and schedules no further calls", async () => {
    const panel = view(); await flush();
    const calls = panel.callTool.mock.calls.length;
    await panel.unmount();
    expect(panel.signal.aborted).toBe(true);
    await flush();
    expect(panel.callTool).toHaveBeenCalledTimes(calls);
    expect(panel.onError).not.toHaveBeenCalled();
  });

  it("unmount interrupts a closed-process retry without waiting for its timer", async () => {
    vi.useFakeTimers();
    const panel = view(); await flush();
    await panel.update({ ...update("old:0"), closed: true });
    expect(vi.getTimerCount()).toBe(1);
    await panel.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(panel.callTool).toHaveBeenCalledTimes(2);
  });
});

describe("retry cleanup", () => {
  it("removes the abort listener after an elapsed retry", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = waitForRetry(1000, controller.signal);
    await vi.advanceTimersByTimeAsync(1000); await pending;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("indexer host context", () => {
  it.each([{ locale: "ko" }, { styles: { variables: { "--color-text-primary": "white" } } }])("keeps a dark shell for the partial update %j", delta => {
    let context = { theme: "dark" };
    const app = { getHostContext: () => context, onhostcontextchanged: undefined as any };
    const scope = { dataset: {} as Record<string, string> };
    const documentRoot = { style: { setProperty: vi.fn(), colorScheme: "" } };
    const dispose = syncHostContext(app, scope, documentRoot);
    context = { ...context, ...delta };
    app.onhostcontextchanged(delta);
    expect(scope.dataset.shell).toBe("dark");
    expect(documentRoot.style.colorScheme).toBe("dark");
    dispose();
    expect(app.onhostcontextchanged).toBeUndefined();
  });
});
