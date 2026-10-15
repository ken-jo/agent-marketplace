import { describe, expect, it, vi } from "vitest";
import type { AlertResult, PluginHostApi } from "@ave/plugin-contract";
import { raiseWithDiagnostics } from "../src/alerts/alert-result.js";

describe("alert result diagnostics", () => {
  it.each(["invalid", "kind_not_granted", "kind_not_registered"])("logs %s without an identity or slot value", async (status) => {
    const result = { status, field: "title" } as AlertResult;
    const log = vi.fn();
    const raise = vi.fn(async () => result) as unknown as PluginHostApi["raiseAlert"];
    expect(await raiseWithDiagnostics(raise, { kind: "summary-ready", key: "private-key", slots: { title: "private-title" } }, log)).toBe(result);
    expect(log).toHaveBeenCalledWith({ kind: "summary-ready", status, field: "title" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-");
  });

  it("does not log normal host decisions", async () => {
    const log = vi.fn();
    const raise = vi.fn(async () => ({ status: "disabled_by_user" })) as unknown as PluginHostApi["raiseAlert"];
    await raiseWithDiagnostics(raise, { kind: "summary-ready", key: "id" }, log);
    expect(log).not.toHaveBeenCalled();
  });
});
