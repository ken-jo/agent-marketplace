import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import createPlugin from "../src/hostPlugin.js";
import type { PluginRuntimeContext } from "@ave/plugin-contract";

it("serves only its declared resource from the installed root", async () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), "hello-resource-"));
  try {
    mkdirSync(join(pluginRoot, "dist/ui"), { recursive: true });
    writeFileSync(join(pluginRoot, "dist/ui/hello-control.html"), "<!doctype html><title>Hello</title>");
    const plugin = await createPlugin({ pluginRoot } as PluginRuntimeContext);
    expect(plugin.readUiResource?.("ui://hello-world/control")).toContain("<title>Hello</title>");
    expect(() => plugin.readUiResource?.("ui://other/control")).toThrow("Unknown");
  } finally { rmSync(pluginRoot, { recursive: true }); }
});
