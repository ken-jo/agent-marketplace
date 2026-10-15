#!/usr/bin/env node
/**
 * Install an LGPL-compatible FFmpeg runtime for local development.
 *
 * Runtime installs for end users happen inside src/ffmpegRuntime.ts on plugin
 * boot. This script is only a repo-local helper for developers who want to
 * pre-vendor one or more platforms before running a build.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
// The pins live in the runtime the plugin ships, and only there: this helper
// downloads the same archives and must hold them to the same sums. Node strips
// the types on import (>= 22.18, the repository's engine floor).
import { pinnedFfmpegArtifacts, resolveArchiveSha256, verifyArchiveSha256 } from "../src/ffmpegRuntime.ts";

const ROOT = process.cwd();
const VENDOR_ROOT = resolve(ROOT, "vendor", "ffmpeg");
const CURRENT_PLATFORM = `${process.platform}-${process.arch}`;

const PINNED = new Map(pinnedFfmpegArtifacts().map((artifact) => [artifact.platform, artifact]));

const SPECS = {
  "win32-x64": {
    archive: "zip",
    source: "BtbN/FFmpeg-Builds",
    sourceUrl: "https://github.com/BtbN/FFmpeg-Builds",
    licenseIntent: "LGPL-only shared Windows x64 build; do not replace with GPL or nonfree variants",
  },
  "win32-arm64": {
    archive: "zip",
    source: "BtbN/FFmpeg-Builds",
    sourceUrl: "https://github.com/BtbN/FFmpeg-Builds",
    licenseIntent: "LGPL-only shared Windows arm64 build; do not replace with GPL or nonfree variants",
  },
  "linux-x64": {
    archive: "tar.xz",
    source: "BtbN/FFmpeg-Builds",
    sourceUrl: "https://github.com/BtbN/FFmpeg-Builds",
    licenseIntent: "LGPL-only shared Linux x64 build; do not replace with GPL or nonfree variants",
  },
  "linux-arm64": {
    archive: "tar.xz",
    source: "BtbN/FFmpeg-Builds",
    sourceUrl: "https://github.com/BtbN/FFmpeg-Builds",
    licenseIntent: "LGPL-only shared Linux arm64 build; do not replace with GPL or nonfree variants",
  },
  "darwin-x64": {
    archive: "zip",
    source: "ColorsWind/FFmpeg-macOS",
    sourceUrl: "https://github.com/ColorsWind/FFmpeg-macOS",
    licenseIntent: "LGPL shared macOS x64 build; do not replace with GPL or nonfree variants",
  },
  "darwin-arm64": {
    archive: "zip",
    source: "ColorsWind/FFmpeg-macOS",
    sourceUrl: "https://github.com/ColorsWind/FFmpeg-macOS",
    licenseIntent: "LGPL shared macOS arm64 build; do not replace with GPL or nonfree variants",
  },
};

const args = process.argv.slice(2);
const force = args.includes("--force");
const all = args.includes("--all");
const platforms = all ? Object.keys(SPECS) : parsePlatforms(args);

for (const platform of platforms) {
  if (!SPECS[platform]) {
    console.error(`[install-ffmpeg-vendor] unsupported platform: ${platform}`);
    console.error(`[install-ffmpeg-vendor] supported: ${Object.keys(SPECS).join(", ")}`);
    process.exit(1);
  }
}

for (const platform of platforms) {
  await installPlatform(platform, SPECS[platform]);
}

function parsePlatforms(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--platform") {
      out.push(...String(argv[++i] ?? "").split(",").filter(Boolean));
    } else if (arg.startsWith("--platform=")) {
      out.push(...arg.slice("--platform=".length).split(",").filter(Boolean));
    }
  }
  return out.length ? out : [CURRENT_PLATFORM];
}

function executableName(platform, name) {
  return platform.startsWith("win32-") ? `${name}.exe` : name;
}

function runtimeExists(platformDir, platform) {
  return existsSync(join(platformDir, "bin", executableName(platform, "ffmpeg"))) &&
    existsSync(join(platformDir, "bin", executableName(platform, "ffprobe")));
}

async function installPlatform(platform, spec) {
  const finalDir = resolve(VENDOR_ROOT, platform);
  if (!force && runtimeExists(finalDir, platform)) {
    console.log(`[install-ffmpeg-vendor] already installed ${platform} -> ${finalDir}`);
    return;
  }

  const pinned = PINNED.get(platform);
  if (!pinned) throw new Error(`no pinned FFmpeg artifact for ${platform}`);
  const artifactUrl = artifactFor(platform, pinned);
  const cacheDir = resolve(VENDOR_ROOT, "_downloads");
  const workDir = resolve(tmpdir(), `ave-meeting-ffmpeg-${platform}-${randomUUID()}`);
  const archivePath = resolve(cacheDir, archiveName(artifactUrl, spec));
  const extractDir = resolve(workDir, "extract");
  const nextDir = resolve(workDir, "runtime");

  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(extractDir, { recursive: true });

  try {
    const expectedSha256 = await resolveArchiveSha256(fetch, artifactUrl, pinned);
    console.log(`[install-ffmpeg-vendor] downloading ${platform} from ${spec.source}`);
    await downloadFile(artifactUrl, archivePath);
    await verifyArchiveSha256(archivePath, expectedSha256);
    await extractArchive(spec, archivePath, extractDir);
    const runtimeRoot = findRuntimeRoot(extractDir, platform);
    if (!runtimeRoot) throw new Error(`archive does not contain bin/${executableName(platform, "ffmpeg")} and bin/${executableName(platform, "ffprobe")}`);
    copyRuntime(runtimeRoot, nextDir, platform);
    if (platform.startsWith("darwin-") && process.platform === "darwin") repairDarwinInstallNames(nextDir);
    chmodRuntimeBins(nextDir, platform);
    if (platform === CURRENT_PLATFORM) await verifyRuntime(nextDir, platform);
    writeNotices(nextDir, platform, spec, artifactUrl);

    mkdirSync(dirname(finalDir), { recursive: true });
    rmSync(finalDir, { recursive: true, force: true });
    renameSync(nextDir, finalDir);
    console.log(`[install-ffmpeg-vendor] installed ${platform} -> ${finalDir}`);
  } catch (err) {
    // A cached archive that failed its sum or its extraction must not be
    // reused by the next run's cache check.
    rmSync(archivePath, { force: true });
    throw err;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function artifactFor(platform, pinned) {
  const envName = `AVE_MEETING_FFMPEG_VENDOR_${platform.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_URL`;
  const value = process.env[envName] || process.env.AVE_MEETING_FFMPEG_VENDOR_URL || pinned.artifactUrl;
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") throw new Error(`FFmpeg runtime URL must use https: ${value}`);
  return value;
}

function archiveName(url, spec) {
  const name = basename(new URL(url).pathname);
  if (name && name.includes(".")) return name;
  return `ffmpeg.${spec.archive === "zip" ? "zip" : "tar.xz"}`;
}

async function downloadFile(url, outPath, redirectCount = 0) {
  if (!force && existsSync(outPath) && statSync(outPath).size > 0) {
    console.log(`[install-ffmpeg-vendor] using cached ${outPath}`);
    return;
  }
  if (redirectCount > 5) throw new Error(`too many redirects while downloading ${url}`);

  const tmpPath = `${outPath}.part`;
  rmSync(tmpPath, { force: true });
  await new Promise((resolvePromise, rejectPromise) => {
    const req = httpsGet(url, { headers: { "user-agent": "ave-plugin-meeting" } }, async (res) => {
      try {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          await downloadFile(new URL(res.headers.location, url).toString(), outPath, redirectCount + 1);
          resolvePromise();
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          rejectPromise(new Error(`download failed (${status}) from ${url}`));
          return;
        }
        mkdirSync(dirname(outPath), { recursive: true });
        await pipeline(res, createWriteStream(tmpPath));
        renameSync(tmpPath, outPath);
        resolvePromise();
      } catch (err) {
        rejectPromise(err);
      }
    });
    req.setTimeout(15 * 60_000, () => req.destroy(new Error("download timed out")));
    req.on("error", rejectPromise);
  });
}

async function extractArchive(spec, archivePath, destDir) {
  if (spec.archive === "tar.xz") {
    await runCommand("tar", ["-xf", archivePath, "-C", destDir], 10 * 60_000);
    return;
  }

  const errors = [];
  if (process.platform === "win32") {
    for (const shell of ["powershell.exe", "pwsh"]) {
      try {
        await runCommand(shell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `Expand-Archive -LiteralPath ${psQuote(archivePath)} -DestinationPath ${psQuote(destDir)} -Force`], 10 * 60_000);
        return;
      } catch (err) {
        errors.push(`${shell}: ${err.message}`);
      }
    }
  }

  try {
    await runCommand("unzip", ["-q", archivePath, "-d", destDir], 10 * 60_000);
    return;
  } catch (err) {
    errors.push(`unzip: ${err.message}`);
  }
  throw new Error(`could not extract zip archive (${errors.join("; ")})`);
}

function findRuntimeRoot(root, platform) {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (runtimeExists(current, platform)) return current;
    let entries = [];
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) if (entry.isDirectory()) stack.push(join(current, entry.name));
  }
  return null;
}

function copyRuntime(runtimeRoot, destDir, platform) {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  for (const top of ["bin", "lib"]) {
    const src = join(runtimeRoot, top);
    if (existsSync(src)) cpSync(src, join(destDir, top), { recursive: true, dereference: false });
  }
  for (const entry of readdirSync(runtimeRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const lower = entry.name.toLowerCase();
    if (lower.startsWith("license") || lower.startsWith("copying") || lower.startsWith("readme") || lower.endsWith(".txt")) {
      cpSync(join(runtimeRoot, entry.name), join(destDir, entry.name));
    }
  }
  if (!runtimeExists(destDir, platform)) throw new Error(`copied runtime is missing required binaries for ${platform}`);
}

function repairDarwinInstallNames(platformDir) {
  for (const file of listFiles(platformDir)) {
    const name = basename(file);
    if (name !== "ffmpeg" && name !== "ffprobe" && !name.endsWith(".dylib") && !name.endsWith(".a")) continue;
    const otool = spawnSync("otool", ["-L", file], { encoding: "utf8" });
    if (file.endsWith(".dylib")) spawnSync("install_name_tool", ["-id", file, file], { stdio: "ignore" });
    for (const line of `${otool.stdout ?? ""}`.split(/\r?\n/)) {
      const dep = line.trim().split(/\s+/)[0] ?? "";
      for (const prefix of ["install_arm64", "install_x86_64", "install_universal"]) {
        const idx = dep.indexOf(prefix);
        if (idx < 0) continue;
        const rel = dep.slice(idx + prefix.length + 1);
        if (rel) spawnSync("install_name_tool", ["-change", dep, resolve(platformDir, rel), file], { stdio: "ignore" });
      }
    }
  }
}

function chmodRuntimeBins(platformDir, platform) {
  if (platform.startsWith("win32-")) return;
  for (const name of ["ffmpeg", "ffprobe"]) {
    try { chmodSync(join(platformDir, "bin", executableName(platform, name)), 0o755); } catch { /* best effort */ }
  }
}

async function verifyRuntime(platformDir, platform) {
  for (const name of ["ffmpeg", "ffprobe"]) {
    const exe = join(platformDir, "bin", executableName(platform, name));
    await runCommand(exe, ["-version"], 10_000, runtimeLibraryEnv(exe));
  }
}

function runtimeLibraryEnv(executablePath) {
  const binDir = dirname(executablePath);
  if (basename(binDir) !== "bin") return undefined;
  const libDir = join(dirname(binDir), "lib");
  if (!existsSync(libDir)) return undefined;
  if (process.platform === "linux") return { ...process.env, LD_LIBRARY_PATH: prependPath(libDir, process.env.LD_LIBRARY_PATH) };
  if (process.platform === "darwin") return { ...process.env, DYLD_LIBRARY_PATH: prependPath(libDir, process.env.DYLD_LIBRARY_PATH) };
  return undefined;
}

function writeNotices(platformDir, platform, spec, artifactUrl) {
  writeFileSync(resolve(platformDir, "FFMPEG_BUILD.json"), `${JSON.stringify({
    source: spec.source,
    sourceUrl: spec.sourceUrl,
    artifactUrl,
    platform,
    licenseIntent: spec.licenseIntent,
    installedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  writeFileSync(resolve(platformDir, "LICENSE.FFmpeg.txt"), [
    `This runtime was downloaded from ${spec.source}.`,
    spec.licenseIntent,
    "FFmpeg license information: https://www.ffmpeg.org/legal.html",
    "FFmpeg source: https://github.com/FFmpeg/FFmpeg",
    "",
  ].join("\n"));
  writeFileSync(resolve(platformDir, "NOTICE.md"), [
    "# FFmpeg Runtime Notice",
    "",
    `- Runtime source: ${spec.source}`,
    `- Runtime artifact: ${artifactUrl}`,
    `- Source/build project: ${spec.sourceUrl}`,
    "- License intent: LGPL-compatible shared runtime. Do not replace with GPL or nonfree variants without legal review.",
    "- FFmpeg legal information: https://www.ffmpeg.org/legal.html",
    "",
  ].join("\n"));
}

function listFiles(root) {
  const result = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile()) result.push(path);
    }
  }
  return result;
}

async function runCommand(command, args, timeoutMs, env) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-1000); });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

function prependPath(value, current) {
  return current && current.length > 0 ? `${value}${process.platform === "win32" ? ";" : ":"}${current}` : value;
}

function psQuote(value) {
  return `'${value.replace(/'/g, "''")}'`;
}
