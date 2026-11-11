/**
 * Ave extension — __PLUGIN_NAME__
 *
 * Runtime entry point. The host starts this extension in a child process,
 * invokes `createPlugin(context)`, and wires its RuntimePlugin to the Tool
 * Registry and HostApi over the host protocol.
 *
 * `plugin.json` is an Agent Plugins 1.0.0 document: the top level is the
 * portable half the spec owns, and everything Ave-specific lives under
 * `extensions["ai.agent-connector.ave"]`. The host projects it back to a flat manifest
 * before `createPlugin` ever runs, so nothing below has to know that.
 *
 * TODO (extension author):
 *   1. Replace __PLUGIN_NAME__; set the top-level `name` (your extension id) and
 *      `extensions["ai.agent-connector.ave"].displayName` (what a person reads).
 *   2. Add one PluginToolHandler per tool name declared under
 *      `extensions["ai.agent-connector.ave"].tools[]` in the `handlers` map below.
 *   3. Read settings and call the APIs declared by `context.hostApi` as needed.
 *   4. Author each tool's JSON Schema directly in its `tools[]` entry;
 *      filesystem inputs use `_meta["ave/pathFields"]`.
 */

import type {
  RuntimePluginFactory,
  RuntimePlugin,
  PluginRuntimeContext,
  PluginToolHandler,
} from "@ave/plugin-contract";

export const createPlugin: RuntimePluginFactory = async (
  context: PluginRuntimeContext,
): Promise<RuntimePlugin> => {
  // TODO: prepare extension state without starting external work.
  // stdout is reserved for the host protocol. Send diagnostics to stderr.
  console.error("plugin:boot", { id: "__PLUGIN_NAME__" });

  // Read configSchema-declared values through the typed host API:
  // const mySetting = context.hostApi.config.get<string>("exampleSetting") ?? "default";

  const handlers: Record<string, PluginToolHandler> = {
    // TODO: implement tool handlers. Names MUST match plugin.json `tools[]`.
    // Example:
    //   example_tool: async (payload) => {
    //     const args = payload as { query: string };
    //     return { ok: true, echo: args.query };
    //   },
  };

  return {
    handlers,
    async start() {
      // TODO: prepare in-memory state; start externally visible work in onPublished.
    },
    async onPublished() {
      // TODO: start timers, workers, or watchers after activation.
    },
    async stop() {
      // TODO: release resources, unsubscribe from events.
    },
  };
};
