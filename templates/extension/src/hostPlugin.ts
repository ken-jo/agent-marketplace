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
 *   3. Register keywords / events via `context.hostApi` as needed.
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
  // TODO: initialize extension state, open stores, subscribe to events.
  context.log("plugin:boot", { id: "__PLUGIN_NAME__" });

  // §9.2 Track B: read configSchema-declared values via `hostApi.config.get`.
  // 호스트 SDK 의 canonical accessor 는 `hostApi.config.{get,set,onChange}`.
  // 과거 가이드의 `hostApi.getConfig` extension cast 는 호스트가 노출한 적
  // 없는 가짜 이름이라 silently undefined 반환 — 답습 금지.
  // Example:
  //   const getConfig = context.hostApi.config?.get
  //     ? context.hostApi.config.get.bind(context.hostApi.config)
  //     : undefined;
  //   const mySetting = (getConfig?.("exampleSetting") as string | undefined) ?? "default";

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
      // TODO: wire timers, subscriptions, watchers here.
    },
    async stop() {
      // TODO: release resources, unsubscribe from events.
    },
  };
};
