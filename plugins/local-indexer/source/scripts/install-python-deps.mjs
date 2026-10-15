#!/usr/bin/env node
/**
 * Auto-installs Python dependencies from python-requirements.lock.
 * Called by npm postinstall. Tries uv first, then pip, then warns.
 * Never fails the npm install — exits 0 in all cases.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const lockFile = resolve(__dirname, "../python-requirements.lock");

if (!existsSync(lockFile)) {
  console.warn("[local-indexer] python-requirements.lock not found, skipping Python dep install.");
  process.exit(0);
}

function tryRun(cmd) {
  try {
    execSync(cmd, { stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}

function hasCommand(cmd) {
  try {
    execSync(`${cmd} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

console.log("[local-indexer] Installing Python dependencies from python-requirements.lock...");

if (hasCommand("uv")) {
  if (tryRun(`uv pip sync "${lockFile}"`)) {
    console.log("[local-indexer] Python deps installed via uv.");
    process.exit(0);
  }
}

for (const py of ["python", "python3", "py"]) {
  if (hasCommand(py)) {
    if (tryRun(`${py} -m pip install -r "${lockFile}"`)) {
      console.log(`[local-indexer] Python deps installed via ${py} -m pip.`);
      process.exit(0);
    }
  }
}

console.warn(
  "[local-indexer] WARNING: Could not install Python dependencies (uv/python/pip not found or failed).\n" +
  "  Run manually: uv pip sync python-requirements.lock  OR  python -m pip install -r python-requirements.lock"
);
process.exit(0);
