/**
 * Copy locally installed FFmpeg runtimes into dist/vendor when present.
 *
 * Marketplace installs now bootstrap the current OS runtime at plugin boot
 * into pluginDataDir/vendor/ffmpeg/<platform-arch>. This script remains a
 * development/release helper for explicitly vendored runtimes, but absence is
 * not a build failure.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = process.cwd();
const SRC_ROOT = resolve(ROOT, "vendor", "ffmpeg");
const DEST_ROOT = resolve(ROOT, "dist", "vendor", "ffmpeg");

function executableName(platform, name) {
  return platform.startsWith("win32-") ? `${name}.exe` : name;
}

function assertRuntime(platform, src) {
  const binRoot = resolve(src, "bin");
  for (const name of ["ffmpeg", "ffprobe"]) {
    const path = resolve(binRoot, executableName(platform, name));
    if (!existsSync(path)) {
      throw new Error(`[copy-ffmpeg-vendor] missing required FFmpeg binary: ${path}`);
    }
  }
}

if (!existsSync(SRC_ROOT)) {
  console.warn(`[copy-ffmpeg-vendor] skipped; no local FFmpeg vendor at ${SRC_ROOT}`);
  process.exit(0);
}

const platforms = readdirSync(SRC_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^(win32|linux|darwin)-/.test(entry.name))
  .map((entry) => entry.name)
  .sort();

if (platforms.length === 0) {
  console.warn(`[copy-ffmpeg-vendor] skipped; no platform runtime directories at ${SRC_ROOT}`);
  process.exit(0);
}

for (const platform of platforms) {
  const src = resolve(SRC_ROOT, platform);
  assertRuntime(platform, src);

  const dest = resolve(DEST_ROOT, platform);
  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });

  for (const top of ["bin", "lib"]) {
    const topSrc = resolve(src, top);
    if (existsSync(topSrc)) cpSync(topSrc, resolve(dest, top), { recursive: true, dereference: false });
  }

  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const lower = entry.name.toLowerCase();
    if (lower.startsWith("license") || lower.startsWith("copying") || lower.startsWith("notice") || lower.startsWith("readme") || lower.endsWith(".json") || lower.endsWith(".txt") || lower.endsWith(".md")) {
      cpSync(resolve(src, entry.name), resolve(dest, entry.name));
    }
  }

  console.log(`[copy-ffmpeg-vendor] copied ${platform} -> ${join("dist", "vendor", "ffmpeg", platform)}`);
}
