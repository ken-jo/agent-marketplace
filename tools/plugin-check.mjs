#!/usr/bin/env node
/** Run the package's declared checks using the shared vendored contract. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export async function runPluginChecks(directory, { helperOnly = false, execute = execFileSync } = {}) {
  const source = resolve(ROOT, directory);
  const path = relative(ROOT, source);
  if (!path || path === ".." || path.startsWith(`..${sep}`) || path.includes(`${sep}node_modules${sep}`)) throw new Error("plugin directory must be inside this marketplace");
  const helper = join(ROOT, "tools/plugin-build");
  if (helperOnly && source !== helper) throw new Error("--helper requires the tools/plugin-build directory");
  const command = (args, cwd) => execute("bun", args, { cwd, stdio: ["inherit", 2, 2] });
  command(["install", "--frozen-lockfile"], helper);
  if (!helperOnly) command(["install", "--frozen-lockfile"], source);
  for (const script of helperOnly ? ["typecheck", "test"] : ["typecheck", "build", "test"]) command(["run", script], source);
  if (!helperOnly) {
    const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    for (const script of ["validate:events", "validate:hostapi"]) if (pkg.scripts?.[script]) command(["run", script], source);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, ...args] = process.argv.slice(2);
  try {
    if (!directory || args.some((arg) => arg !== "--helper")) throw new Error("usage: plugin-check.mjs <directory> [--helper]");
    await runPluginChecks(directory, { helperOnly: args.includes("--helper") });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
