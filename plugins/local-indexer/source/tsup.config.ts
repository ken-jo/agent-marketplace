import { defineAvePluginConfig } from "@ave/plugin-build";

// Self-contained Node server and MCP Apps view bundle.
export default defineAvePluginConfig([
  {
    entry: ["src/index.ts", "src/hostPlugin.ts"],
    // ESM only — `package.json#exports` declares "import" entries exclusively
    // and `hostPlugin.ts` uses `import.meta.url` (which CJS can't honour and
    // produces an esbuild warning under dual-format).
    format: ["esm"],
    target: "node18",
  },
  {
    entry: {
      "ui/indexer-control": "src/ui/indexer-control.js",
    },
    platform: "browser",
    target: "chrome120",
    format: ["esm"],
    // Don't wipe the host build (first config runs with clean:true).
    clean: false,
  },
]);
