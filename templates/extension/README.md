# Extension template

Starting point for a new **Ave code extension** in the official marketplace
repository. It builds against the host's extension contract, vendored at the
repository root in `contract/` (`@ave/plugin-contract`), and the shared build
helper in `tools/plugin-build/` (`@ave/plugin-build`).

The marketplace keeps `kind: "plugin"`, the `plugins/` path, and `plugin.json`
for compatibility. Agent Plugins without an Ave runtime entry use the separate
`agent-plugin` kind.

---

## 1. Create a new extension from this template

Copy this directory to `plugins/<name>/source/` in the marketplace
repository. The `file:` paths in `package.json` assume that depth, so change
`../../` to `../../../` in both of them. From the repository root, install,
typecheck, build and test against a verified contract snapshot:

```bash
node tools/verified-import.mjs plugin plugins/<name>/source --allow-development
```

Development commit pins trust the reviewed inventory hashes. Release tags
always require signed bundle verification; omit `--allow-development` to
require a release tag. See the repository's [contract bundle guidance](https://github.com/ken-jo/agent-marketplace#contract-bundle).

Add `plugins/<name>/ave-package.json` beside `source/`. After the merge, the
release workflow builds the zip, uploads it as a release asset and opens the
pull request that pins it. See the repository README.

### Tool manifest contract

`tools[]` is an array of complete MCP Tool objects. Keep each tool's `name`,
`description`, and `inputSchema` together in that object; do not add a separate
legacy `toolSchemas` map. For a filesystem argument, list its input-schema name
in the same tool's `_meta["ave/pathFields"]` so the host can route
out-of-scope directory access through the permission UI.

```json
{
  "tools": [
    {
      "name": "my_tool",
      "description": "Explain what this tool does and when it should be used.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "sourcePath": { "type": "string" }
        },
        "required": ["sourcePath"],
        "additionalProperties": false
      },
      "_meta": {
        "ave/pathFields": ["sourcePath"]
      }
    }
  ]
}
```

> **Note:** `category` is not declared by extensions. The host derives effective
> tool risk itself (read / write / network / shell), so omit `category`.

---

## 2. Project layout

```
.
├── plugin.json              # Agent Plugins 1.0.0 document (Ave fields under extensions["ai.agent-connector.ave"])
├── package.json             # npm/bun package metadata
├── tsconfig.json            # TS config
├── tsup.config.ts           # Bundler config — uses defineAvePluginConfig
├── vitest.config.ts         # Test runner config
├── src/
│   ├── index.ts             # Entry — re-exports createPlugin as default
│   └── hostPlugin.ts        # RuntimePluginFactory implementation
├── test/
│   └── smoke.test.ts        # Replace / extend with your tests
└── scripts/                 # Manifest and HostApi drift checks
```

---

## 3. Build

`tsup.config.ts` uses the `defineAvePluginConfig` helper from `@ave/plugin-build`:

```ts
import { defineAvePluginConfig } from "@ave/plugin-build";

export default defineAvePluginConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
});
```

Run the supervised command in [Create a new extension](#1-create-a-new-extension-from-this-template)
from the repository root.

The helper wraps `tsup.defineConfig` and enforces the self-containment contract
described below. You only need to specify what differs from the defaults.

---

## 4. Self-contained dist

**Every dependency your extension uses must be bundled into `dist/`.**

The Ave marketplace distributes extensions as zip archives that **exclude
`node_modules/`**. When the host app installs an extension it loads the zip
contents directly — there is no post-install step that resolves packages.
Additionally, the host loader enforces strict `pluginRoot` containment
(no path escapes outside the extension directory, enforced since 2026-05).

`defineAvePluginConfig` encodes this contract automatically:

| Setting | Value | Reason |
|---|---|---|
| `external` | `["electron"]` | Provided by the host runtime — must never be bundled |
| `noExternal` | `/./` (match everything) | All other deps bundled into `dist/` |
| `clean` | `true` | Stale artifacts cause silent breakage |
| `sourcemap` | `true` | Required for host-side stack trace symbolication |

The contract itself is the host's `public-contract.ts` and manifest schema,
vendored at the ref in `contract/sources.json`. The supervisor supplies the
verified bytes as a separate package. The build helper and this README
describe what the host loader expects of the bundle.

---

## 5. Common overrides

Pass any `tsup` option to override the defaults:

```ts
// Different entry points
export default defineAvePluginConfig({
  entry: ["src/index.ts", "src/worker.ts"],
  format: ["esm", "cjs"],
});

// CJS-only extension
export default defineAvePluginConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
});

// Target older Node (host ships Node 20)
export default defineAvePluginConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  target: "node20",
});
```

See the `defineAvePluginConfig` JSDoc in `tools/plugin-build/tsup.ts` for the
full option surface.

---

## 6. Multi-target builds (extensions with browser UI panels)

Extensions that render a browser-side UI panel need a separate browser bundle
in addition to the Node entry. Use the array form:

```ts
import { defineAvePluginConfig } from "@ave/plugin-build";

export default [
  // Node entry (loaded by the host)
  defineAvePluginConfig({
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
  }),
  // Browser panel bundle
  defineAvePluginConfig({
    entry: ["src/panel/index.tsx"],
    format: ["esm"],
    platform: "browser",
    outDir: "dist/panel",
  }),
];
```

Refer to the `defineAvePluginConfig` JSDoc for the `platform` and `outDir`
options. The host discovers panel bundles via the `ui` array in `plugin.json`.
Each entry declares a UI extension slot:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "your-plugin-id",
  "extensions": {
    "ai.agent-connector.ave": {
      "ui": [
        {
          "id": "your-plugin-id.sidebar",
          "slot": "sidebar",
          "kind": "embedded-module",
          "title": "My Panel",
          "entry": "dist/panel/index.js",
          "exportName": "SidebarPanel"
        }
      ]
    }
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique identifier for this UI extension |
| `slot` | yes | Where to mount — currently only `"sidebar"` is supported |
| `kind` | yes | `"embedded-module"` (React component via `entry`+`exportName`), `"embedded-page"` (full page via `page`), or `"info-card"` |
| `title` | yes | Display label shown in the host UI |
| `entry` | yes (embedded-module) | Path to the panel bundle, e.g. `dist/panel/index.js` |
| `exportName` | yes (embedded-module) | Named export from the bundle that the host dynamically imports |

For `"embedded-page"`, replace `entry`+`exportName` with a `page` field (route path).
Optional `window` sub-object controls detachable-window defaults (width, height, defaultMode).

### UI primitives

There is no shared UI component package. The SDK's UI surface was removed in
SDK v7, and each official extension keeps the few pieces it uses in its own
source: `src/ui/prime-theme.js` in `meeting` and `local-indexer`. Copy from there.

### UI mount contract — `primeTheme` as the first await

Every extension panel's `mount()` (or React App's root `useTheme`) must
wire host theme synchronization on entry. The vendored `primeTheme` is a
single helper that subsumes the three paths the host runs — `getTheme()` pull,
`host.theme.changed` subscribe, and validated token paint:

```ts
// Vanilla / detached BrowserWindow / scoped sidebar
import { primeTheme } from "./prime-theme.js"; // copied from an official extension

export function mount(host: PluginHost): PluginInstance {
  // First await — before any DOM build / React render.
  const handle = primeTheme(host.bridge, {
    target: host.targetDocument ?? document,  // scope to detached doc / scoped root
  });
  // … extension UI build …
  return { unmount: () => handle.dispose() };
}

// React — useTheme wraps primeTheme
import { useTheme } from "./vendor/useTheme"; // copied from an official extension

function App({ bridge, rootEl }: Props) {
  useTheme(bridge, {
    target: rootEl,                                // optional: scoped root
    onPayload: (e) => mapSidebarTokens(e),         // optional: custom mapping
  });
  // …
}
```

**Anti-pattern** (don't do this — drift class observed in 2026-05 audit):
subscribing to `host.theme.changed` a *second* time alongside `useTheme`
to handle custom token mapping. Use `opts.onPayload` instead so the
single `useTheme`/`primeTheme` call is the only `onEvent` registration.

Background, decision rationale, and the full migration sequence for
existing extensions are in
[`ave/docs/architecture/proposals/2026-05-12-plugin-theme-unification.md`](https://github.com/ken-jo/ave/blob/main/docs/architecture/proposals/2026-05-12-plugin-theme-unification.md).
The host-side contract is documented at
[`docs/references/plugin-tool-schema-design.md` §2.6](https://github.com/ken-jo/ave/blob/main/docs/references/plugin-tool-schema-design.md)
rule 4.

---

## 7. Implementing your extension

1. **Rename placeholders.** Search-and-replace `__PLUGIN_NAME__`,
   `__DESCRIPTION__`, and `Your Extension Display Name` in `package.json`,
   `plugin.json`, and `src/hostPlugin.ts`. In `plugin.json`, the top-level
   `name` is your extension id and `extensions["ai.agent-connector.ave"].displayName` is the
   label a person reads.

2. **Declare your tools** under `extensions["ai.agent-connector.ave"]` in `plugin.json`:
   - `tools[]` — complete MCP Tool objects. Each object contains an
     underscore-form `name` (`^[a-zA-Z_][a-zA-Z0-9_]*$`), a descriptive
     `description`, and an object-shaped `inputSchema`.
   - For filesystem inputs, add `_meta["ave/pathFields"]` to that same Tool
     object. Do not add a legacy `toolSchemas` map or declare `category`.

3. **Implement handlers** in `src/hostPlugin.ts`. Each tool name declared in
   `plugin.json` must have a matching key in the `handlers` map on the
   returned `RuntimePlugin`:

   ```ts
   const handlers: Record<string, PluginToolHandler> = {
     my_tool: async (payload) => {
       const args = payload as { query: string };
       return { ok: true, echo: args.query };
     },
   };
   return { handlers, async start() {}, async stop() {} };
   ```

4. **Declare events** under `extensions["ai.agent-connector.ave"]` (optional):
   - `emittedEvents[]` — event type names this extension publishes (e.g. `"my-plugin.item.created"`).
   - `eventSubscriptions[]` — events this extension subscribes to. Each entry is either a plain
     string (`"other-plugin.item.completed"`) or an object `{ type, hint? }` with structured metadata
     the host surfaces in its UI.

5. **Self-register via HostApi** inside `createPlugin`:
   - `context.hostApi.registerKeywords(...)`
   - `context.hostApi.onEvent(...)` / `emitEvent(...)`
   - `context.hostApi.addTask(...)`, `saveNote(...)`, `getSecret(...)`

   The host app must never contain extension-specific code — all integration
   flows through HostApi.

---

## 8. Updating the contract

The contract follows Ave releases. From the repository root, sync both
vendored directories from the signed contract bundle of an Ave release tag:

```bash
node tools/vendor.mjs sync --ref <ave tag>
```

An extension that uses a member first shipped in release X sets
`requires.minAppVersion` in `plugin.json` to X or later, and the descriptor's
`minAppVersion` to the same value. Declare `requires.hostProtocol` for the
oldest supported app release, following the repository's [manifest rules](https://github.com/ken-jo/agent-marketplace#contract-bundle).
This template targets protocol `"3"`, which Ave 0.14.0 and later serve.

---

## 9. CI

The repository's `validate` workflow builds, typechecks and tests every
extension that a pull request touches, and runs the marketplace validation.
Branch protection on `main` requires it.

---

## 10. Conventions (see `ave/docs/architecture/architecture.md`)

- **Tool names:** underscore-only (`meeting_start`, not `meeting.start`).
- **Extension ids:** the document's top-level `name`. `lowercase-with-dashes` only (e.g., `my-plugin`, `agent-hub`). Dot-form (e.g., `com.example.foo`) is allowed by the Agent Plugins spec but NOT by the Ave schema, which keeps the narrower of the two rules.
- **Manifest validation:** the host validates the `plugin.json` document via AJV on load
  and rejects on failure. Runtime payload validation is the extension's
  responsibility.
- **Process execution:** the host starts the extension in a separate process
  and checks `requires.hostProtocol` before activation. Handle failures and
  surface structured errors from tool handlers.
