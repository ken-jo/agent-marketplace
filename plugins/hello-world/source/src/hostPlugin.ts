/**
 * Hello World — the smallest complete Ave plugin: one tool handler and one
 * sidebar panel (`src/ui/hello-control.ts`) that calls it. It exists to check
 * install, uninstall and the renderer's dynamic UI load end to end.
 */
import type { PluginToolHandler, RuntimePlugin, RuntimePluginFactory } from "@ave/plugin-contract";

export const helloWorld: PluginToolHandler = async (input) => {
  const name = typeof (input as { name?: unknown } | undefined)?.name === "string" && (input as { name: string }).name.trim() !== ""
    ? (input as { name: string }).name
    : "World";
  return { content: [{ type: "text", text: `Hello, ${name}!` }] };
};

const createPlugin: RuntimePluginFactory = async (): Promise<RuntimePlugin> => ({
  handlers: { hello_world: helloWorld },
});

export default createPlugin;
