import { defineAvePluginConfig } from "@ave/plugin-build";

// Build the server and browser script; build-ui.mjs inlines the script into HTML.
export default defineAvePluginConfig([
  { entry: { hostPlugin: "src/hostPlugin.ts" }, sourcemap: false },
  { entry: { "ui/hello-control": "src/ui/hello-control.ts" }, platform: "browser", target: "es2022", clean: false, sourcemap: false },
]);
