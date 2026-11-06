/**
 * Hello World — the smallest complete Ave plugin: one tool handler and one
 * served MCP Apps sidebar that calls it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginToolHandler, RuntimePlugin, RuntimePluginFactory } from "@ave/plugin-contract";

export const helloWorld: PluginToolHandler = async (input) => {
  const name = typeof (input as { name?: unknown } | undefined)?.name === "string" && (input as { name: string }).name.trim() !== ""
    ? (input as { name: string }).name
    : "World";
  return { content: [{ type: "text", text: `Hello, ${name}!` }] };
};

const createPlugin: RuntimePluginFactory = async (context): Promise<RuntimePlugin> => ({
  readUiResource(uri) {
    if (uri !== "ui://hello-world/control") throw new Error(`Unknown UI resource: ${uri}`);
    return readFileSync(join(context.pluginRoot, "dist/ui/hello-control.html"), "utf8");
  },
  handlers: { hello_world: helloWorld },
});

export default createPlugin;
