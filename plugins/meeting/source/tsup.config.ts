import { defineAvePluginConfig } from "@ave/plugin-build";

export default defineAvePluginConfig([
  { entry: ["src/index.ts", "src/hostPlugin.ts"], format: ["esm", "cjs"], target: "node18" },
  {
    entry: { "ui/meeting-control": "src/ui/meeting-control.mjs", "ui/recorder-card": "src/ui/recorder-card.js" },
    platform: "browser", target: "chrome120", format: ["esm"], clean: false,
  },
]);
