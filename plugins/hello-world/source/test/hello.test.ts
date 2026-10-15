import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flattenAgentPluginsManifest, type PluginRuntimeContext } from "@ave/plugin-contract";
import createPlugin, { helloWorld } from "../src/hostPlugin";

const manifest = flattenAgentPluginsManifest(JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8")));

describe("hello-world", () => {
  it("greets the given name, and the world by default", async () => {
    expect(await helloWorld({ name: "Ave" })).toEqual({ content: [{ type: "text", text: "Hello, Ave!" }] });
    expect(await helloWorld({})).toEqual({ content: [{ type: "text", text: "Hello, World!" }] });
    expect(await helloWorld({ name: "  " })).toEqual({ content: [{ type: "text", text: "Hello, World!" }] });
  });

  it("has a handler for every tool the manifest declares, and no other", async () => {
    const plugin = await createPlugin({} as PluginRuntimeContext);
    expect(Object.keys(plugin.handlers ?? {}).sort()).toEqual(manifest.tools.map((tool) => tool.name).sort());
  });

  it("declares the entries the build writes", () => {
    expect(manifest.entry).toBe("dist/hostPlugin.js");
    expect(manifest.ui?.map((ui) => ui.entry)).toEqual(["dist/ui/hello-control.js"]);
  });
});
