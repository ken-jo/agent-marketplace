# Extension template

Starting point for an Ave code extension using the protocol 5 contract in [`contract/`](../../contract). Protocol 5 is unreleased and changes in place; test against an Ave build from the ref recorded in [`contract/sources.json`](../../contract/sources.json) before publishing.

## Create an extension

Copy this directory to `plugins/<name>/source/`. In `package.json`, change `@ave/plugin-build` to `file:../../../tools/plugin-build` and `@ave/plugin-contract` to `file:../../../contract`. Replace `__PLUGIN_NAME__`, `__DESCRIPTION__`, `your-plugin-id`, and the display name with your extension's values.

From the repository root, run:

```sh
node tools/plugin-check.mjs plugins/<name>/source
```

The runner installs frozen dependencies, typechecks, builds, runs tests, and validates the manifest against the shared schema. These checks cover the empty starter; add tests for your tool handlers, input validation and resource behavior. To check the template itself, use `node tools/plugin-check.mjs templates/extension`.

Keep the package and manifest versions equal. The marketplace uses `kind: "plugin"` and `plugins/` paths for code extensions; `agent-plugin` packages have no Ave runtime entry. Publishing is owner-operated; see the [repository README](../../README.md#publishing) for release pins and descriptors.

## Implement tools

Declare complete MCP Tool objects in `plugin.json` under `extensions["ai.agent-connector.ave"].tools`. Each tool needs its name, description and input schema:

```json
{
  "name": "my_tool",
  "description": "Explain when to call this tool and what it returns.",
  "inputSchema": {
    "type": "object",
    "properties": { "sourcePath": { "type": "string" } },
    "required": ["sourcePath"],
    "additionalProperties": false
  },
  "_meta": { "ai.agent-connector.ave/pathFields": ["sourcePath"] }
}
```

Add a matching handler in `src/hostPlugin.ts`. Validate runtime inputs before using them. The host derives tool risk; the manifest does not declare a `category`.

```ts
const handlers: Record<string, PluginToolHandler> = {
  my_tool: async (payload) => {
    const args = payload as { sourcePath: string };
    return { sourcePath: args.sourcePath };
  },
};
```

Use only members declared by `PluginHostApi`. Saved settings use `context.hostApi.config.get`, `set`, and `onChange`. Secret access uses the asynchronous `getSecret` API and the manifest's `hostSecrets` grants. The contract no longer exposes keyword registration, the event bus, task/note creation, or host logging methods.

Send diagnostics to stderr with `console.error`; stdout carries the host protocol. Keep `start` limited to preparation. Work that becomes externally visible after activation belongs in `onPublished`. Dispose resources in `stop`.

## Build and package

`tsup.config.ts` uses `defineAvePluginConfig` from the shared `@ave/plugin-build` helper. Every dependency except the host-provided Electron module is bundled. Published archives exclude `node_modules`, so runtime imports must resolve inside the extension.

The manifest's entry is `dist/index.js`. The build emits ESM, CommonJS and declarations. The `files` list in `package.json` controls which built paths ship.

## Add an MCP App surface

The starter is headless. A UI extension uses a declared MCP App resource, served by the extension's `readUiResource(uri)` hook:

```json
{
  "uiResources": [{ "uri": "ui://your-plugin-id/panel" }],
  "ui": [{
    "id": "your-plugin-id.sidebar",
    "slot": "sidebar",
    "kind": "mcp-app",
    "title": "My Panel",
    "resourceUri": "ui://your-plugin-id/panel"
  }]
}
```

These fields belong inside `extensions["ai.agent-connector.ave"]`. Return HTML only for your declared resource URI. Declare required CSP domains and permissions in `uiResources`; runtime HTML cannot widen them. Use the standard MCP Apps bridge for host context, tool calls and theme updates. The host no longer imports React exports or extension-declared page paths.

## Update the shared contract

Changes belong in Ave. Sync from a local checkout, then review and commit the generated files:

```sh
node tools/vendor.mjs sync --ref <40-hex-commit-or-tag> --app <Ave-checkout>
node tools/vendor.mjs check
```

See [Ave contract](../../README.md#ave-contract) for provenance and build behavior. Declare `requires.hostProtocol: "5"` and `minAppVersion: "0.15.0"`, the first released app with protocol 5. Raise the app floor if you use a later contract member.

The validation workflow checks every extension and this template. Protocol changes and their extension migrations land through `integration/protocol5`; integration merges to main once the complete validation is green.
