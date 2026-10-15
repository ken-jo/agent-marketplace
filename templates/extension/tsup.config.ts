import { defineAvePluginConfig } from "@ave/plugin-build";

// Ave marketplace extensions must be self-contained. The protocol-2 entry
// declared in plugin.json is dist/index.js, built from src/index.ts here.
// The marketplace
// zip excludes node_modules/ and the host loader uses strict
// pluginRoot containment (no sibling-repo escape since 2026-05).
//
// The defineAvePluginConfig helper from @ave/plugin-build
// encodes this contract:
//   - external: ["electron"] (host runtime, never bundled)
//   - noExternal: [match-everything regex] (every other dep bundled)
//
// Override defaults if your extension needs different entry/format/target.
// See the helper's JSDoc for the full contract.
export default defineAvePluginConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
});
