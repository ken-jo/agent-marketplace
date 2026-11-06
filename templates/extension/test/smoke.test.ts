import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { describe, it, expect, vi } from "vitest";
import type { PluginRuntimeContext } from "@ave/plugin-contract";
import { createPlugin } from "../src/hostPlugin";

const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));
const schema = JSON.parse(readFileSync(new URL(import.meta.resolve("@ave/plugin-contract/plugin-manifest.schema.json")), "utf8"));
const validate = new Ajv({ strict: false }).compile(schema);

describe("extension starter", () => {
  it("boots without host calls and sends diagnostics to stderr", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      // The starter needs no host services until the author adds handlers.
      const plugin = await createPlugin({} as PluginRuntimeContext);
      await plugin.start?.();
      await plugin.onPublished?.();
      await plugin.stop?.();
      expect(plugin.handlers).toEqual({});
      expect(stderr).toHaveBeenCalledWith("plugin:boot", { id: "__PLUGIN_NAME__" });
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("declares protocol 5 in a manifest accepted by the vendored schema", () => {
    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    expect(manifest.extensions["ai.agent-connector.ave"].requires.hostProtocol).toBe("5");
  });

  it("refuses the removed embedded-module UI shape", () => {
    const legacy = structuredClone(manifest);
    legacy.extensions["ai.agent-connector.ave"].ui = [{
      id: "starter.sidebar", slot: "sidebar", kind: "embedded-module",
      title: "Starter", entry: "dist/panel.js", exportName: "Panel",
    }];
    expect(validate(legacy)).toBe(false);
  });
});
