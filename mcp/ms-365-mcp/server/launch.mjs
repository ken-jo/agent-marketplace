#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.env.MS365_MCP_OAUTH_TOKEN?.trim()) {
  console.error("Enter a delegated Microsoft Graph access token in Ave’s secret prompt.");
  process.exit(1);
}
// The pinned upstream fails closed with command storage: no keytar/file fallback.
const env = {
  ...process.env,
  MS365_MCP_AUTH_CACHE_COMMAND: fileURLToPath(new URL("./no-cache.mjs", import.meta.url)),
  MS365_MCP_REDACT_PII: "true",
};
const child = spawn("npx", [
  "-y", "@softeria/ms-365-mcp-server@0.172.0", "--read-only",
  "--allowed-scopes", "User.Read Mail.Read Calendars.Read Contacts.Read Files.Read Tasks.Read MailboxSettings.Read Notes.Read",
], { env, stdio: "inherit", shell: false });
child.on("error", () => { console.error("Could not start the Microsoft 365 server; check that npx is installed."); process.exitCode = 1; });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143); });
