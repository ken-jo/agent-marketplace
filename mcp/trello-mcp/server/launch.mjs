#!/usr/bin/env node
import { spawn } from "node:child_process";

// Ave injects one secret. Split it in memory, never into arguments or files.
let credentials;
try {
  credentials = JSON.parse(process.env.TRELLO_CREDENTIALS ?? "");
  if (!credentials || ![credentials.apiKey, credentials.token].every((v) => typeof v === "string" && v.trim())) throw new Error();
} catch {
  console.error('Enter JSON with nonempty "apiKey" and "token" in Ave’s secret prompt.');
  process.exit(1);
}
const env = { ...process.env, TRELLO_API_KEY: credentials.apiKey, TRELLO_TOKEN: credentials.token };
delete env.TRELLO_CREDENTIALS;
const child = spawn("npx", ["-y", "@delorenj/mcp-server-trello@1.8.1"], { env, stdio: "inherit", shell: false });
child.on("error", () => { console.error("Could not start the Trello server; check that npx is installed."); process.exitCode = 1; });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143); });
