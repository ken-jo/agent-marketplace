#!/usr/bin/env node
// free-worker-port.mjs — Best-effort cleanup of orphan processes holding the
// Local Indexer worker port (default 43129). Dev/operator convenience only:
// the host's runtime path (src/localIndexerPlugin.ts → ensurePortAvailableForWorker)
// now auto-recovers from TIME_WAIT during plugin restart, so this script is
// only useful when a worker process is *genuinely stuck* (e.g. a hung
// Python interpreter after a hard host crash).
//
// Usage:
//   node scripts/free-worker-port.mjs          # default port 43129
//   node scripts/free-worker-port.mjs 43130    # override port
//
// Exit code 0 on success (port either free or freed). Exit 1 on lookup
// failure. Never throws.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const port = Number.parseInt(process.argv[2] ?? "43129", 10);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`invalid port: ${process.argv[2]}`);
  process.exit(1);
}

async function findPidsWin32(port) {
  const script = [
    `$conns = Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue`,
    "if ($conns) { $conns | ForEach-Object { [Console]::WriteLine($_.OwningProcess) } }",
  ].join("; ");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024 },
  );
  return [
    ...new Set(
      String(stdout)
        .split(/\s+/)
        .map((s) => Number.parseInt(s, 10))
        .filter((n) => Number.isInteger(n) && n > 0),
    ),
  ];
}

async function findPidsPosix(port) {
  const { stdout } = await execFileAsync(
    "lsof",
    ["-nP", `-tiTCP:${port}`],
    { timeout: 5_000, maxBuffer: 64 * 1024 },
  );
  return [
    ...new Set(
      String(stdout)
        .split(/\s+/)
        .map((s) => Number.parseInt(s, 10))
        .filter((n) => Number.isInteger(n) && n > 0),
    ),
  ];
}

async function killWin32(pid) {
  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`],
    { windowsHide: true, timeout: 5_000 },
  );
}

async function killPosix(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone — fine
  }
}

async function main() {
  const isWin = process.platform === "win32";
  let pids = [];
  try {
    pids = isWin ? await findPidsWin32(port) : await findPidsPosix(port);
  } catch (err) {
    console.error(`port lookup failed: ${err.message ?? err}`);
    process.exit(1);
  }

  if (pids.length === 0) {
    console.log(`port ${port}: no owner process found (already free or in TIME_WAIT)`);
    process.exit(0);
  }

  console.log(`port ${port}: killing ${pids.length} owner pid(s): ${pids.join(", ")}`);
  for (const pid of pids) {
    try {
      if (isWin) {
        await killWin32(pid);
      } else {
        await killPosix(pid);
      }
    } catch (err) {
      console.error(`  pid ${pid}: kill failed — ${err.message ?? err}`);
    }
  }
  console.log("done");
}

main();
