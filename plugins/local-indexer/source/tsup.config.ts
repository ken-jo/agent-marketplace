import { defineAvePluginConfig } from "@ave/plugin-build";

// Two build targets (mirrors the meeting plugin's pattern):
//   1. Node host plugin (src/hostPlugin.ts + src/index.ts) — runs in the
//      plugin's own confined child process.
//   2. Browser UI bundle (src/ui/indexer-control.js) — loaded via
//      `<script type="module">` from indexer-control.html inside the
//      plugin webview. Bundled (not just copied) so its local imports
//      (./prime-theme.js, the style modules) resolve into one file. With
//      `platform: "browser"` the build helper externalises react/react-dom.
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
    // Entry-object form keeps the dist/ui/ path structure that
    // indexer-control.html references via ./indexer-control.js.
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
