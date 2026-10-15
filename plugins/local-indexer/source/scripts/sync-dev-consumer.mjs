import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_PLUGINS_SCHEMA_URL, AVE_EXTENSION_NAMESPACE } from "@ave/plugin-contract";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const forceSync = process.argv.includes("--force");
const syncEnabled = forceSync || process.env.AVE_DEV_SYNC === "1";
const siblingAppRoot = resolve(repoRoot, "..", "ave");
const siblingConsumerRoot = resolve(
  siblingAppRoot,
  "node_modules",
  "@ave",
  "plugin-local-indexer",
);
const siblingManagedInstallRoot = resolve(
  siblingAppRoot,
  "plugins",
  "installed",
  "local-indexer",
);
const managedEntryPath = "../../../node_modules/@ave/plugin-local-indexer/dist/hostPlugin.js";
const managedUiEntryPath = "../../../node_modules/@ave/plugin-local-indexer/dist/ui/indexer-control.js";
// The dev-sync manifest is an Agent Plugins 1.0.0 document, same as the one in
// this repo, so the keys are split the way the document splits them: the
// spec owns the top level, everything Ave-specific sits in its namespace.
// `name` at the top level is the plugin's identity (the old `id`) and is
// carried across separately.
const MANAGED_PORTABLE_KEYS = [
  "version",
  "description",
];

// `deployment: "managed"` and `startupTools` used to be written here. Neither
// is a field of the plugin manifest -- no host code reads either one, and the
// schema (additionalProperties: false) refuses both -- so the manifest this
// script emitted was one the host would reject on sight.
const MANAGED_AVE_KEYS = [
  "displayName",
  "publisher",
  "startupTimeoutMs",
  "entry",
  "tools",
  "capabilities",
  "eventSubscriptions",
  // host 의 `registerPluginEventBridge` 가 manifest.emittedEvents 를 읽어
  // renderer 이벤트 브릿지를 등록한다. 누락 시 plugin 이 hostApi.emitEvent 를
  // 호출해도 webview 까지 도달 못 함 (예: `index.warning` UI 경고 배너).
  "emittedEvents",
  "config",
  "configSchema",
  "python",
  "notificationEvents",
  "ui",
];
async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function copyDirectory(relativePath) {
  const source = resolve(repoRoot, relativePath);
  const destination = resolve(siblingConsumerRoot, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true, force: true });
}

async function copyFile(relativePath) {
  const source = resolve(repoRoot, relativePath);
  const destination = resolve(siblingConsumerRoot, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { force: true });
}

async function syncManagedInstallManifest() {
  const sourceManifestPath = resolve(repoRoot, "plugin.json");
  const sourceDocument = JSON.parse(await readFile(sourceManifestPath, "utf-8"));
  const sourceAve = sourceDocument.extensions?.[AVE_EXTENSION_NAMESPACE] ?? {};
  const managedAve = Object.fromEntries(
    MANAGED_AVE_KEYS
      .filter((key) => sourceAve[key] !== undefined)
      .map((key) => [key, sourceAve[key]]),
  );
  const normalizedAve = {
    ...managedAve,
    entry: managedEntryPath,
    ui: Array.isArray(managedAve.ui)
      ? managedAve.ui.map((extension) => {
          if (!extension || typeof extension !== "object") return extension;
          if (extension.kind !== "embedded-module") return extension;
          return {
            ...extension,
            entry: managedUiEntryPath,
            exportName:
              typeof extension.exportName === "string" && extension.exportName.length > 0
                ? extension.exportName
                : "mount",
          };
        })
      : managedAve.ui,
  };
  const normalizedDocument = {
    $schema: AGENT_PLUGINS_SCHEMA_URL,
    name: sourceDocument.name,
    ...Object.fromEntries(
      MANAGED_PORTABLE_KEYS
        .filter((key) => sourceDocument[key] !== undefined)
        .map((key) => [key, sourceDocument[key]]),
    ),
    extensions: { [AVE_EXTENSION_NAMESPACE]: normalizedAve },
  };

  await mkdir(siblingManagedInstallRoot, { recursive: true });
  await writeFile(
    resolve(siblingManagedInstallRoot, "plugin.json"),
    `${JSON.stringify(normalizedDocument, null, 2)}\n`,
    "utf-8",
  );
}

if (!syncEnabled) {
  process.exit(0);
}

if (!(await pathExists(siblingAppRoot))) {
  console.warn(
    `[sync-dev-consumer] skipped: sibling app not found at ${siblingAppRoot}`,
  );
  process.exit(0);
}

await copyDirectory("dist");
await copyDirectory("worker");
await copyFile("package.json");
await copyFile("plugin.json");
await copyFile("python-requirements.lock");
await syncManagedInstallManifest();

if (existsSync(resolve(repoRoot, "README.md"))) {
  await copyFile("README.md");
}

console.log(
  `[sync-dev-consumer] synced build output to ${siblingConsumerRoot} and manifest to ${siblingManagedInstallRoot}`,
);
