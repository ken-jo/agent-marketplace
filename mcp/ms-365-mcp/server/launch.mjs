// Canonical bootstrap; tools/connector-pins.mjs copies it into each installable package.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, accessSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export class RuntimeRefusal extends Error {}
const controls = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function secretEnvironment(pin, input) {
  const raw = input[pin.secret.env];
  const valid = (v) => typeof v === "string" && v.trim().length > 0 && !controls.test(v);
  if (!valid(raw)) throw new RuntimeRefusal("Enter a nonempty credential without control characters in Ave's secret prompt.");
  const env = { ...input };
  if (pin.secret.fields) {
    let value;
    try { value = JSON.parse(raw); } catch { /* Never expose parser input/errors. */ }
    const fields = Object.keys(pin.secret.fields);
    if (!value || Array.isArray(value) || Object.keys(value).length !== fields.length || !fields.every((key) => valid(value[key]))) {
      throw new RuntimeRefusal("Enter the documented JSON credential fields without control characters in Ave's secret prompt.");
    }
    if (pin.secret.split) {
      delete env[pin.secret.env];
      for (const key of fields) env[pin.secret.fields[key]] = value[key];
    }
  }
  return env;
}

// Both synchronous throws and asynchronous launch errors get constant messages.
export function safeSpawn(command, args, options, start = spawn) {
  try { return start(command, args, options); }
  catch { throw new RuntimeRefusal("Connector process could not start. Check its runtime prerequisites; credential values are omitted."); }
}

export function findRuntime(name, env) {
  const explicit = name === "uv" ? env.AVE_CONNECTOR_UV : env.AVE_CONNECTOR_NPM;
  const candidates = explicit ? [explicit] : (env.PATH ?? "").split(":").filter(Boolean).map((dir) => join(dir, name));
  for (const path of candidates) {
    if (!isAbsolute(path) || controls.test(path)) continue;
    try { accessSync(path, constants.X_OK); return path; } catch { /* Try next PATH entry. */ }
  }
  throw new RuntimeRefusal(name === "uv"
    ? "This locked Python connector requires uv on Ave's PATH, or AVE_CONNECTOR_UV set to an absolute uv binary path (Ave's extracted bundled uv is supported). No ambient uvx fallback is used."
    : "This locked npm connector requires npm on Ave's PATH, or AVE_CONNECTOR_NPM set to an absolute npm executable path.");
}

export function readPin(serverDir) {
  const pin = JSON.parse(readFileSync(join(serverDir, "runtime.json"), "utf8"));
  if (!["npm", "python"].includes(pin.kind) || !pin.files || !pin.secret?.env) throw new RuntimeRefusal("Invalid connector runtime inventory.");
  for (const [path, hash] of Object.entries(pin.files)) {
    if (isAbsolute(path) || path.split("/").some((p) => p === ".." || p === "")) throw new RuntimeRefusal("Invalid connector inventory path.");
    if (!/^[a-f0-9]{64}$/u.test(hash) || digest(readFileSync(join(serverDir, path))) !== hash) {
      throw new RuntimeRefusal("Connector runtime bytes differ from their reviewed inventory. Reinstall the package.");
    }
  }
  if (pin.kind === "npm") validateNpmLock(serverDir, pin);
  return pin;
}

export function validateNpmLock(serverDir, pin) {
  const manifest = JSON.parse(readFileSync(join(serverDir, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(serverDir, "package-lock.json"), "utf8"));
  const top = lock.packages?.[`node_modules/${pin.artifact.name}`];
  if (lock.lockfileVersion !== 3 || manifest.dependencies?.[pin.artifact.name] !== pin.artifact.version
      || Object.keys(manifest.dependencies).length !== 1 || top?.version !== pin.artifact.version
      || top?.integrity !== pin.artifact.integrity || top?.resolved !== pin.artifact.url) {
    throw new RuntimeRefusal("The npm artifact does not match the reviewed version and SRI pin.");
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    if (entry.link || !entry.version || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(entry.integrity ?? "")
        || !entry.resolved?.startsWith("https://registry.npmjs.org/")) {
      throw new RuntimeRefusal("Every npm dependency must have a registry URL, exact version and SHA-512 integrity pin.");
    }
  }
}

export function installEnvironment(input, data) {
  const env = {};
  // Never provision credentials to package managers or installation scripts.
  for (const name of ["PATH", "HOME", "USERPROFILE", "APPDATA", "LANG", "TMPDIR", "TMP", "TEMP", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"]) {
    if (input[name] !== undefined) env[name] = input[name];
  }
  return { ...env, npm_config_cache: join(data, "npm-cache"), npm_config_update_notifier: "false",
    UV_CACHE_DIR: join(data, "uv-cache"), UV_PYTHON_INSTALL_DIR: join(data, "python"), UV_NO_PROGRESS: "1" };
}

export function runInstaller(command, args, cwd, env, execute = execFileSync) {
  try { execute(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 }); }
  catch { throw new RuntimeRefusal("Locked dependency installation failed. Check network access, artifact hashes and runtime prerequisites. Installer output is withheld because it may contain environment values."); }
}

function prepareRuntime(serverDir, pin, env) {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new RuntimeRefusal("This connector requires Node.js 24 or later on Ave's PATH.");
  const runtime = findRuntime(pin.kind === "npm" ? "npm" : "uv", env);
  const data = env.AVE_CONNECTOR_DATA_DIR;
  if (!data || !isAbsolute(data) || data.includes("$DATA_DIR") || controls.test(data)) throw new RuntimeRefusal("Ave must expand AVE_CONNECTOR_DATA_DIR to the connector's writable data directory.");
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(data, "run-"));
  process.once("exit", () => rmSync(work, { recursive: true, force: true }));
  for (const path of Object.keys(pin.files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    copyFileSync(join(serverDir, path), join(work, path));
  }
  const clean = installEnvironment(env, data);
  if (pin.kind === "npm") {
    const userConfig = join(work, "empty-user.npmrc");
    const globalConfig = join(work, "empty-global.npmrc");
    writeFileSync(userConfig, "");
    writeFileSync(globalConfig, "");
    runInstaller(runtime, ["ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--userconfig", userConfig, "--globalconfig", globalConfig], work, clean);
  } else {
    runInstaller(runtime, ["--no-config", "venv", "--python", pin.pythonVersion, join(work, "venv")], work, clean);
    // pip sync installs the complete locked set; unlike pip install, it does
    // not resolve additional transitive dependencies from package metadata.
    runInstaller(runtime, ["--no-config", "pip", "sync", "--python", join(work, "venv/bin/python"), "--require-hashes", "--only-binary", ":all:", "--reinstall", "requirements.lock"], work, clean);
  }
  // Same reviewed inputs must still be present after invoking an installer.
  readPin(serverDir);
  for (const [path, hash] of Object.entries(pin.files)) {
    if (digest(readFileSync(join(work, path))) !== hash) throw new RuntimeRefusal("Installer changed a reviewed runtime input.");
  }
  return work;
}

export async function main(serverDir = dirname(fileURLToPath(import.meta.url))) {
  const pin = readPin(serverDir);
  const env = secretEnvironment(pin, process.env);
  // Explicit opt-ins are checked, never interpreted as truthy strings.
  for (const key of ["AVE_CONNECTOR_ALLOW_WRITES", "AVE_CONNECTOR_ALLOW_LOCAL_WRITES"]) {
    if (env[key] !== undefined && !["true", "false"].includes(env[key])) throw new RuntimeRefusal("Connector write opt-ins must be exactly true or false.");
  }
  const work = prepareRuntime(serverDir, pin, env);
  if (pin.id === "ms-365-mcp") {
    env.MS365_MCP_AUTH_CACHE_COMMAND = join(work, "no-cache.mjs");
    env.MS365_MCP_REDACT_PII = "true";
  }
  if (pin.kind === "npm") {
    const packageDir = join(work, "node_modules", pin.artifact.name);
    if (pin.artifact.rebuilt) {
      // The original Trello tarball bundles its own SDK. Use the committed,
      // inventoried build from the reviewed source with external dependencies.
      copyFileSync(join(work, pin.artifact.rebuilt.file), join(packageDir, pin.entry));
    }
    if (pin.tools) {
      // Copy this reviewed adapter beside the native entry so ESM resolves the
      // very same SDK instance that the pinned upstream imports.
      const hook = join(packageDir, "ave-policy.mjs");
      copyFileSync(join(work, "policy.mjs"), hook);
      const { installPolicy } = await import(pathToFileURL(hook).href);
      await installPolicy(pin.tools, env);
    }
    const entry = join(packageDir, pin.entry);
    const args = [...pin.args];
    if (pin.id === "figma-context-mcp" && env.AVE_CONNECTOR_ALLOW_LOCAL_WRITES !== "true") args.push("--skip-image-downloads");
    process.argv = [process.execPath, entry, ...args];
    Object.assign(process.env, env);
    if (pin.secret.split) delete process.env[pin.secret.env];
    process.chdir(work);
    await import(pathToFileURL(entry).href);
  } else {
    const args = pin.entry ? ["-B", join(work, pin.entry)] : ["-B", ...pin.args];
    const child = safeSpawn(join(work, "venv/bin/python"), args, { cwd: work, env, stdio: "inherit", shell: false });
    child.once("error", () => { console.error("Connector process could not start; credential values are omitted."); process.exitCode = 1; });
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
    child.once("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143); });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof RuntimeRefusal ? error.message : "Connector startup failed; credential values and raw errors are omitted.");
    process.exitCode = 1;
  });
}
