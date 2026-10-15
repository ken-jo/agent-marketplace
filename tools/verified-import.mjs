#!/usr/bin/env node
/** Verify the installation's vendored bytes before evaluating any of them. */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isReleaseTag, readVerifiedVendored } from "./vendor.mjs";

const INSTALL_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const INVENTORIES = ["contract/sources.json", "tools/vendor/sources.json"];
const MODULES = ["tools/vendor/marketplace-check.js", "tools/vendor/agent-plugin-components.js"];

function publicationInvocation() {
  return process.argv[1] && existsSync(resolve(process.argv[1]))
    && realpathSync(resolve(process.argv[1])) === join(INSTALL_ROOT, "tools/release.mjs")
    && (process.argv.includes("--publish") || ["pin", "build"].includes(process.argv[2]));
}

/**
 * Function arguments are the only test dependency injection surface. Neither
 * the CLI nor an environment variable can replace the fetcher or verifier.
 * MARKETPLACE_ROOT redirects repository data, never executable tool bytes.
 */
export async function importVerifiedVendored(options = {}) {
  const strict = publicationInvocation();
  if (strict && process.env.MARKETPLACE_ROOT !== undefined) {
    throw new Error("publication requires this checked-out marketplace; MARKETPLACE_ROOT is for tests only");
  }
  const root = resolve(options.root ?? INSTALL_ROOT);
  const inventories = new Map(INVENTORIES.map((path) => [path, readFileSync(join(root, path))]));
  const ref = JSON.parse(inventories.get(INVENTORIES[0]).toString("utf8")).ref;
  const allowDevelopment = !strict && options.allowDevelopment !== false;
  if (!allowDevelopment && !isReleaseTag(ref)) {
    throw new Error("publication requires an Ave release tag with a signed contract bundle; development inventory trust is not allowed");
  }
  const verified = await readVerifiedVendored({ ...options, root, allowDevelopment });
  // Own the buffers: callers or a test transport must not be able to mutate
  // verified bytes while an asynchronous module import is in flight.
  const files = new Map([...verified].map(([path, bytes]) => [path, Buffer.from(bytes)]));
  const expected = new Map([...inventories, ...files]);
  const assertUnchanged = () => {
    for (const [path, bytes] of expected) {
      if (!existsSync(join(root, path)) || !readFileSync(join(root, path)).equals(bytes)) {
        throw new Error(`${path}: changed after vendored verification; refusing to execute or pack`);
      }
    }
  };
  assertUnchanged();
  const work = mkdtempSync(join(tmpdir(), "marketplace-verified-"));
  try {
    const modules = new Map();
    // Use file URLs rather than data URLs: the bundled CommonJS interop
    // calls createRequire(import.meta.url), which requires an absolute file.
    for (const path of MODULES) {
      const destination = join(work, `${path.split("/").at(-1)}.mjs`);
      const bytes = files.get(path);
      if (!bytes) throw new Error(`${path}: verified bundle omitted an executable module`);
      writeFileSync(destination, bytes, { flag: "wx", mode: 0o400 });
      modules.set(path, await import(pathToFileURL(destination).href));
    }
    return Object.freeze({
      root,
      signed: isReleaseTag(ref),
      marketplace: modules.get(MODULES[0]),
      components: modules.get(MODULES[1]),
      assertUnchanged,
      contractFiles: () => new Map([...files].filter(([path]) => path.startsWith("contract/")).map(([path, bytes]) => [path, Buffer.from(bytes)])),
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

let runtime;
/** One verified evaluation per process, initialized before repository APIs are exported. */
export function verifiedRuntime(options) {
  runtime ??= importVerifiedVendored(options);
  return runtime;
}

/** Install a separate package containing only the already-verified contract bytes. */
function contractSnapshot(state) {
  const directory = mkdtempSync(join(tmpdir(), "marketplace-contract-"));
  for (const [path, bytes] of state.contractFiles()) writeFileSync(join(directory, path.slice("contract/".length)), bytes, { mode: 0o400 });
  writeFileSync(join(directory, "package.json"), JSON.stringify({
    name: "@ave/plugin-contract", type: "module", exports: {
      ".": "./public-contract.ts",
      "./plugin-manifest.schema.json": "./plugin-manifest.schema.json",
      "./protocol.schema.json": "./protocol.schema.json",
    },
  }), { mode: 0o400 });
  return directory;
}

/**
 * The supervisor stays resident across third-party scripts. Before each
 * command it checks the installation, contract snapshot and dependency links.
 * Contract imports resolve to the captured bytes, outside the checkout.
 */
export async function runPluginChecks(directory, { allowDevelopment = false, helperOnly = false, execute = execFileSync } = {}) {
  const state = await verifiedRuntime({ allowDevelopment });
  if (!allowDevelopment && !state.signed) throw new Error("plugin publication requires a signed release bundle");
  const root = state.root;
  const source = resolve(root, directory);
  const path = relative(root, source);
  if (path === "" || path === ".." || path.startsWith(`..${sep}`) || path.includes(`${sep}node_modules${sep}`)) throw new Error("plugin directory must be inside this marketplace");
  const helper = join(root, "tools/plugin-build");
  if (helperOnly && source !== helper) throw new Error("--helper requires the tools/plugin-build directory");
  const snapshot = contractSnapshot(state);
  const snapshotExpected = new Map(["public-contract.ts", "plugin-manifest.schema.json", "protocol.schema.json", "package.json"].map((name) => [name, readFileSync(join(snapshot, name))]));
  const links = [];
  const linkContract = (directory) => {
    const dependency = join(directory, "node_modules/@ave/plugin-contract");
    mkdirSync(dirname(dependency), { recursive: true });
    const backup = `${dependency}.marketplace-backup-${process.pid}`;
    let present = false;
    try { lstatSync(dependency); present = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (present) renameSync(dependency, backup);
    links.push({ dependency, backup, present });
    symlinkSync(snapshot, dependency, "dir");
  };
  const assertBuildInputs = () => {
    state.assertUnchanged();
    for (const [name, bytes] of snapshotExpected) {
      if (!existsSync(join(snapshot, name)) || !readFileSync(join(snapshot, name)).equals(bytes)) throw new Error(`verified contract snapshot ${name}: changed by a build script`);
    }
    for (const { dependency } of links) {
      if (!existsSync(dependency) || realpathSync(dependency) !== realpathSync(snapshot)) throw new Error(`${dependency}: verified contract dependency link changed by a build script`);
    }
  };
  const command = (args, cwd) => {
    assertBuildInputs();
    // Build's stdout is the artifact hash consumed by the workflow. Keep
    // install/compiler/test output on stderr even under command substitution.
    execute("bun", args, { cwd, stdio: ["inherit", 2, 2] });
    assertBuildInputs();
  };
  try {
    command(["install", "--frozen-lockfile"], helper);
    linkContract(helper);
    if (!helperOnly) {
      command(["install", "--frozen-lockfile"], source);
      linkContract(source);
    }
    for (const script of helperOnly ? ["typecheck", "test"] : ["typecheck", "build", "test"]) {
      command(["run", script], source);
    }
    if (!helperOnly) {
      const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
      for (const script of ["validate:events", "validate:hostapi"]) if (pkg.scripts?.[script]) command(["run", script], source);
    }
  } finally {
    for (const { dependency, backup, present } of links.reverse()) {
      rmSync(dependency, { recursive: true, force: true });
      if (present) renameSync(backup, dependency);
    }
    rmSync(snapshot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const allowDevelopment = args.includes("--allow-development");
  try {
    if (command === "check" && args.every((arg) => arg === "--allow-development") && args.length <= 1) {
      await readVerifiedVendored({ root: INSTALL_ROOT, allowDevelopment });
      console.log(`vendored execution bytes: OK${allowDevelopment ? " (development inventory integrity allowed)" : " (signed release bundle)"}`);
    } else if (command === "plugin" && args[0] && args.slice(1).every((arg) => ["--allow-development", "--helper"].includes(arg))) {
      await runPluginChecks(args[0], { allowDevelopment, helperOnly: args.includes("--helper") });
    } else {
      throw new Error("usage: verified-import.mjs check [--allow-development] | plugin <directory> [--allow-development] [--helper]");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
