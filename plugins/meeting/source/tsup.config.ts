import { defineAvePluginConfig } from "@ave/plugin-build";

// Two build targets:
//   1. Node host plugin (src/hostPlugin.ts + src/index.ts) — runs in
//      ave's main process.
//   2. Browser UI bundles (src/ui/meeting-control.js + src/ui/recorder-card.js)
//      — loaded by the host's plugin UI shell: the sidebar panel and the
//      recorder's slot in the host's floating dock. Bundled because they import
//      the vendored ./prime-theme.js helper (SDK v7.0.0 removed
//      @ave/plugin-sdk/ui/hooks/primeTheme); with `platform: "browser"` tsup
//      auto-marks react/react-dom external, which is harmless since neither
//      UI file uses React.
export default defineAvePluginConfig([
  {
    entry: ["src/index.ts", "src/hostPlugin.ts"],
    format: ["esm", "cjs"],
    target: "node18",
    // `electron-audio-loopback` is shipped via the post-build vendor copy
    // (scripts/copy-loopback-vendor.mjs → dist/vendor/...) and loaded
    // through `require(path.join(__dirname, "vendor/..."))` in
    // hostPlugin.ts. The wrapper's top-level `require("electron")` would
    // break plugin-ci.yml's artifact-load smoke (Node-only env, no
    // Electron binary) if it were bundled and evaluated at module load.
    // No `external` entry is needed: there is no literal
    // `require("electron-audio-loopback")` in source for esbuild to
    // analyze — the call uses a runtime-computed `vendorPath` string.
  },
  {
    // Browser UI bundles. Entry-object form keeps the dist/ui/ path
    // structure that plugin.json's `ui` entries point at.
    entry: {
      "ui/meeting-control": "src/ui/meeting-control.js",
      "ui/recorder-card": "src/ui/recorder-card.js",
    },
    platform: "browser",
    // `chrome*` target signals browser to the SDK helper so it auto-externalises
    // react/react-dom. Electron ships Chromium 120+, and the host's plugin UI
    // shell serves both bundles same-origin under its own CSP.
    target: "chrome120",
    format: ["esm"],
    // Critical: don't wipe the host build (host config runs first with clean:true,
    // then this entry inherits clean:true from baseDefaults and would nuke dist/).
    clean: false,
  },
]);
