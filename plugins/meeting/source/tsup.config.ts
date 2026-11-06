import { readFileSync } from "node:fs";
import { defineAvePluginConfig } from "@ave/plugin-build";

const { version } = JSON.parse(readFileSync(new URL("./plugin.json", import.meta.url), "utf8")) as { version: string };

export default defineAvePluginConfig([
  { entry: ["src/index.ts", "src/hostPlugin.ts"], format: ["esm", "cjs"], target: "node18" },
  {
    entry: { "ui/meeting-control": "src/ui/meeting-control.mjs", "ui/recorder-card": "src/ui/recorder-card.js" },
    define: { __MEETING_APP_VERSION__: JSON.stringify(version) },
    platform: "browser", target: "chrome120", format: ["esm"], clean: false,
  },
]);
