import { defineAvePluginConfig } from "@ave/plugin-build";

// The host entry (plugin.json `entry`) and the sidebar panel (`ui[].entry`).
export default defineAvePluginConfig([
  { entry: { hostPlugin: "src/hostPlugin.ts" }, sourcemap: false },
  { entry: { "ui/hello-control": "src/ui/hello-control.ts" }, platform: "browser", target: "es2022", clean: false, sourcemap: false },
]);
