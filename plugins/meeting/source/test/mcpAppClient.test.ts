import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function load() {
  const source = readFileSync(new URL("../src/ui/mcp-app.mjs", import.meta.url), "utf8")
    .replace(/^import .*\n/, "").replaceAll("export ", "");
  const window = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const close = vi.fn(async () => {});
  class App { async connect() {} close = close; }
  return { window, close, api: runInNewContext(source + "\n({connectView,applyHostContext,watchChanges})", { App, window, AbortController, setTimeout }) };
}

describe("MCP Apps client lifecycle", () => {
  it("closes its SDK connection once on page disposal", async () => {
    const { api, window, close } = load();
    const client = await api.connectView("meeting-control");
    const dispose = window.addEventListener.mock.calls.find(([event]) => event === "pagehide")?.[1] as () => void;
    dispose();
    client.dispose();
    expect(close).toHaveBeenCalledTimes(1);
    expect(window.removeEventListener).toHaveBeenCalledWith("pagehide", dispose);
  });
  it("removes stale host variables and reads the merged context after a change", () => {
    const { api } = load();
    let context = { theme: "dark", styles: { variables: { "--color-text-primary": "white" } } };
    const app = { getHostContext: () => context, onhostcontextchanged: () => {} };
    const style = { setProperty: vi.fn(), removeProperty: vi.fn(), colorScheme: "" };
    api.applyHostContext(app, { style });
    expect(style.setProperty).toHaveBeenCalledWith("--color-text-primary", "white");
    context = { theme: "light", styles: { variables: {} as typeof context.styles.variables } };
    app.onhostcontextchanged();
    expect(style.removeProperty).toHaveBeenCalledWith("--color-text-primary");
    expect(style.colorScheme).toBe("light");
  });

  it("retries a failed snapshot before committing its cursor and stops on disposal", async () => {
    vi.useFakeTimers();
    try {
      const { api, window } = load();
      const callTool = vi.fn().mockResolvedValueOnce({ cursor: "epoch:1", reset: true, changes: [] })
        .mockResolvedValueOnce({ cursor: "epoch:2", reset: true, changes: [] })
        .mockImplementationOnce((_name, _args, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")))));
      const refresh = vi.fn().mockRejectedValueOnce(new Error("snapshot failed")).mockResolvedValueOnce(undefined);
      const error = vi.fn();
      const stop = api.watchChanges({ callTool }, refresh, error);
      await vi.advanceTimersByTimeAsync(1500);
      expect(callTool.mock.calls[1]?.[1].cursor).toBe("");
      expect(callTool.mock.calls[2]?.[1].cursor).toBe("epoch:2");
      expect(error).toHaveBeenCalledTimes(1);
      stop();
      await vi.advanceTimersByTimeAsync(20000);
      expect(callTool).toHaveBeenCalledTimes(3);
      expect(window.removeEventListener).toHaveBeenCalledWith("pagehide", stop);
    } finally { vi.useRealTimers(); }
  });
});
