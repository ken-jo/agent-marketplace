#!/usr/bin/env node
// Implements the upstream auth-cache command protocol without storing credentials.
const [operation, key] = process.argv.slice(2);
if (!["token-cache", "selected-account"].includes(key)) process.exit(1);
if (operation === "load") console.log(JSON.stringify({ found: false }));
else if (operation !== "delete") {
  console.error("Local login persistence is disabled. Update the Graph token in Ave’s secret prompt.");
  process.exitCode = 1;
}
// Discard a save payload without echoing it or causing a broken pipe upstream.
process.stdin.resume();
