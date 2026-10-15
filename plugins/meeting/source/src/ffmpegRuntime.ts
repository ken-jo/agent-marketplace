import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { PluginWorkerSpec, SpawnedPluginWorker } from "@ave/plugin-contract";

export const FFMPEG_VENDOR_PLATFORM = `${process.platform}-${process.arch}`;

export function ffmpegExecutableName(name: "ffmpeg" | "ffprobe", platform: string = process.platform): string {
  return platform === "win32" || platform.startsWith("win32-") ? `${name}.exe` : name;
}

export function managedFfmpegPlatformDir(pluginDataDir: string, platform = FFMPEG_VENDOR_PLATFORM): string {
  return resolve(pluginDataDir, "vendor", "ffmpeg", platform);
}

type RuntimeSpec = {
  platform: string;
  archive: "zip" | "tar.xz";
  artifactUrl: string;
  /** What `artifactUrl` must hash to. See {@link SPECS} for where it comes from. */
  sha256: string;
  /** Its length in bytes, checked from the first Content-Range before a byte is written. */
  size: number;
  source: string;
  sourceUrl: string;
  licenseIntent: string;
};

/**
 * Host-mediated egress. Required, not optional: acquiring the runtime means
 * pulling an archive off the internet, and a plugin child has no direct egress
 * at all. A fallback to Node’s own HTTPS client would be reach this module exists to give
 * up, taken on exactly the hosts least able to contain it.
 */
export type MediatedFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Host-mediated process start. Required for the same reason {@link MediatedFetch}
 * is: installing a runtime means running `tar`, `unzip`, `otool` and the new
 * binaries themselves, and a confined plugin child has no `child_process` of
 * its own.
 *
 * The mediation is not a formality. Axis 3 has NO RUNTIME SIGNAL — ASRT's
 * generated Seatbelt profile carries `(allow process-exec)`, so a reintroduced
 * `spawn` would not fail, it would run inside the same jail with no grants
 * declared and nothing to notice it. What the host adds is the declaration:
 * every path these tools may read or write is named up front, by this module,
 * rather than inferred from argv by whatever the tool decides to open.
 */
export type MediatedSpawn = (spec: PluginWorkerSpec) => Promise<SpawnedPluginWorker>;

/**
 * Thrown when the host could not START the process — as opposed to the process
 * having started and failed.
 *
 * The two are different diagnoses and a caller acts differently on each: a
 * missing runtime is a "start" failure and reads as "please install", while a
 * non-zero exit is the tool's own verdict on its arguments. Collapsing them
 * would report a corrupt archive as a missing FFmpeg.
 */
export class MediatedSpawnStartError extends Error {
  constructor(command: string, cause: unknown) {
    super(`${command} failed to start: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "MediatedSpawnStartError";
  }
}

/** One mediated run: what to start, what it may touch, and how long it gets. */
export interface MediatedCommandRun {
  readonly spawnWorker: MediatedSpawn;
  /** Unique among RUNNING workers — the host refuses a duplicate id. */
  readonly workerId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /** Paths the child may read. The host grants nothing from argv. */
  readonly readPaths?: readonly string[];
  /** Paths the child may write. Same rule. */
  readonly writePaths?: readonly string[];
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Name used in errors; defaults to the command. */
  readonly label?: string;
}

/**
 * Run one command through the host and collect its output.
 *
 * THE single place this plugin starts a process. Both callers reach it — the
 * runtime installer here and the FFmpeg/ffprobe runs in `hostPlugin` — so the
 * timeout, the abort handling, the "stop it rather than leak it" rule and the
 * exit-code reporting have one implementation and cannot drift into two
 * opinions about what a failed run means.
 */
export async function runMediatedCommand(
  run: MediatedCommandRun,
): Promise<{ stdout: string; stderr: string }> {
  const label = run.label ?? run.command;
  if (run.signal?.aborted) throw new Error(`${label} aborted`);

  let handle: SpawnedPluginWorker;
  try {
    handle = await run.spawnWorker({
      workerId: run.workerId,
      command: run.command,
      args: [...run.args],
      env: run.env as Record<string, string | undefined> | undefined,
      allowReadPaths: [...(run.readPaths ?? [])],
      allowWritePaths: [...(run.writePaths ?? [])],
    });
  } catch (err) {
    throw new MediatedSpawnStartError(label, err);
  }

  return await new Promise<{ stdout: string; stderr: string }>((settle, fail) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run.signal?.removeEventListener("abort", abort);
      if (err) {
        // Stopped rather than left running: a rejection that leaves the
        // process alive turns a timeout into a leak the caller cannot see.
        try { handle.stop(); } catch { /* already gone */ }
        fail(err);
        return;
      }
      settle({ stdout, stderr });
    };
    const abort = () => finish(new Error(`${label} aborted`));
    const timer = setTimeout(
      () => finish(new Error(`${label} timed out after ${run.timeoutMs}ms`)),
      run.timeoutMs,
    );
    run.signal?.addEventListener("abort", abort, { once: true });
    handle.onStdout((chunk) => { stdout = `${stdout}${chunk}`.slice(-10_000); });
    handle.onStderr((chunk) => { stderr = `${stderr}${chunk}`.slice(-10_000); });
    handle.onExit(({ code }) => {
      if (code === 0) finish();
      else finish(new Error(`${label} exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
    });
  });
}

/**
 * Worker ids have to be unique among RUNNING workers, and the installer runs
 * `otool`/`install_name_tool` once per file. A per-purpose constant would
 * collide with its own previous iteration if deregistration has not caught up,
 * so each run takes a fresh number.
 */
let mediatedRunSeq = 0;
function installWorkerId(purpose: string): string {
  mediatedRunSeq += 1;
  return `meeting-install-${purpose}-${mediatedRunSeq}`;
}

type EnsureFfmpegRuntimeOptions = {
  pluginDataDir: string;
  pluginDistDir: string;
  hostFetch: MediatedFetch;
  spawnWorker: MediatedSpawn;
  log?: (message: string) => void;
  logEvent?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
};

type EnsureFfmpegRuntimeResult = {
  ok: true;
  source: "explicit" | "managed" | "bundled" | "path" | "downloaded";
  platform: string;
  binDir?: string;
};

/**
 * One archive per platform, each pinned to a release that holds still and to
 * the sha256 that archive must hash to.
 *
 * PINNED, not `latest`. BtbN re-uploads `latest` daily, so a sum written here
 * could match it for a day at most, and the only sum left to check against
 * would be one fetched from the same release as the archive — which vouches
 * for the transfer, not for the build. A sum in this source is reviewed with
 * the plugin and travels in its release zip, so the archive is held to what
 * was reviewed. BtbN keeps the last build of each month for two years
 * (README, "Releases"); the September 2026 one is pinned, and it stays
 * downloadable until about September 2028. Bump it, with its sums, before
 * then. The BtbN sums are the tag's own `checksums.sha256` entries, which
 * equal GitHub's recorded asset digests; ColorsWind publishes neither, so its
 * two were computed from the downloaded assets. `size` is each asset's length
 * as GitHub records it, so a server announcing any other length is refused
 * before the download starts rather than after it fills the disk.
 */
const SPECS: Record<string, RuntimeSpec> = {
  "win32-x64": {
    platform: "win32-x64",
    archive: "zip",
    artifactUrl: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/ffmpeg-N-127021-ge0c94b2d1c-win64-lgpl-shared.zip",
    sha256: "2cc3dd0baf74ebd68a3fceaf771df8351a7a6d69694d05f43b16bb0c966ec909",
    size: 78636802,
    source: "BtbN/FFmpeg-Builds",
    sourceUrl: "https://github.com/BtbN/FFmpeg-Builds",
    licenseIntent: "LGPL-only shared Windows x64 build; do not replace with GPL or nonfree variants",
  },
  "win32-arm64": {
    platform: "win32-arm64",
    archive: "zip",
    artifactUrl: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/ffmpeg-N-127021-ge0c94b2d1c-winarm64-lgpl-shared.zip",
    sha256: "60a4863501134269e4797b3bd4f7eda7b9271b71b35231bd6dfe46699887a638",
    size: 54676833,
    source: "BtbN/FFmpeg-Builds",
    sourceUrl: "https://github.com/BtbN/FFmpeg-Builds",
    licenseIntent: "LGPL-only shared Windows arm64 build; do not replace with GPL or nonfree variants",
  },
  "linux-x64": {
    platform: "linux-x64",
    archive: "tar.xz",
    artifactUrl: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/ffmpeg-N-127021-ge0c94b2d1c-linux64-lgpl-shared.tar.xz",
    sha256: "39ecc3f340e77511cfaa587e57f83dd6e339fa4cf73eeee87bf192e62eb7496b",
    size: 64310788,
    source: "BtbN/FFmpeg-Builds",
    sourceUrl: "https://github.com/BtbN/FFmpeg-Builds",
    licenseIntent: "LGPL-only shared Linux x64 build; do not replace with GPL or nonfree variants",
  },
  "linux-arm64": {
    platform: "linux-arm64",
    archive: "tar.xz",
    artifactUrl: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/ffmpeg-N-127032-g6ae491a26c-linuxarm64-lgpl-shared.tar.xz",
    sha256: "46b35484a803333bdf5babb00f4ae337a153a3109e984edd0464d540f0e76614",
    size: 54592476,
    source: "BtbN/FFmpeg-Builds",
    sourceUrl: "https://github.com/BtbN/FFmpeg-Builds",
    licenseIntent: "LGPL-only shared Linux arm64 build; do not replace with GPL or nonfree variants",
  },
  "darwin-x64": {
    platform: "darwin-x64",
    archive: "zip",
    artifactUrl: "https://github.com/ColorsWind/FFmpeg-macOS/releases/download/n5.0.1-patch3/FFmpeg_shared-n5.0.1-OSX-x86_64.zip",
    sha256: "3ac3fb7c79227f9cfcf2db947a5a0e6081c939d56f13e65eb6b5dcf59742e836",
    size: 30977001,
    source: "ColorsWind/FFmpeg-macOS",
    sourceUrl: "https://github.com/ColorsWind/FFmpeg-macOS",
    licenseIntent: "LGPL shared macOS x64 build; do not replace with GPL or nonfree variants",
  },
  "darwin-arm64": {
    platform: "darwin-arm64",
    archive: "zip",
    artifactUrl: "https://github.com/ColorsWind/FFmpeg-macOS/releases/download/n5.0.1-patch3/FFmpeg-shared-n5.0.1-OSX-arm64.zip",
    sha256: "0555a3218069e6c9d6ebb40e0124bd4516f004208c825d29c67a146b776b64bc",
    size: 27383185,
    source: "ColorsWind/FFmpeg-macOS",
    sourceUrl: "https://github.com/ColorsWind/FFmpeg-macOS",
    licenseIntent: "LGPL shared macOS arm64 build; do not replace with GPL or nonfree variants",
  },
};

export function supportedFfmpegRuntimePlatforms(): string[] {
  return Object.keys(SPECS);
}

/** The pinned archive of every platform. */
export function pinnedFfmpegArtifacts(): Array<{ platform: string; artifactUrl: string; sha256: string; size: number }> {
  return Object.values(SPECS).map(({ platform, artifactUrl, sha256, size }) => ({ platform, artifactUrl, sha256, size }));
}

export function ffmpegRuntimeLibraryEnv(executablePath: string): NodeJS.ProcessEnv | undefined {
  if (!executablePath.includes("/") && !executablePath.includes("\\")) return undefined;
  const binDir = dirname(executablePath);
  if (basename(binDir) !== "bin") return undefined;
  const platformDir = dirname(binDir);
  const libDir = join(platformDir, "lib");
  if (!existsSync(libDir)) return undefined;

  if (process.platform === "linux") {
    return { ...process.env, LD_LIBRARY_PATH: prependPath(libDir, process.env.LD_LIBRARY_PATH) };
  }
  if (process.platform === "darwin") {
    return { ...process.env, DYLD_LIBRARY_PATH: prependPath(libDir, process.env.DYLD_LIBRARY_PATH) };
  }
  return undefined;
}

/** The check running for each managed runtime directory (by its canonical path), while it runs. */
const runtimeChecksInFlight = new Map<string, Promise<EnsureFfmpegRuntimeResult>>();

/**
 * Find or install the runtime. Concurrent callers for one data directory share
 * ONE check: two installs would download to the same `_downloads/<archive>`,
 * appending to one `.part` or deleting the archive the other is verifying.
 * A settled check is forgotten, so a later call after a failure tries again.
 *
 * Keyed by the data directory's REAL path, not `path.resolve`: a directory
 * and a symlink to it are one `_downloads`, and two keys would run two
 * installs on it. `async` so a failure to create or resolve the directory is
 * a rejection, which callers' `.catch` sees, not a synchronous throw. Nothing
 * is awaited before the map is read and written, so coalescing still holds.
 */
export async function ensureFfmpegRuntime(opts: EnsureFfmpegRuntimeOptions): Promise<EnsureFfmpegRuntimeResult> {
  mkdirSync(opts.pluginDataDir, { recursive: true });
  const key = managedFfmpegPlatformDir(realpathSync(opts.pluginDataDir));
  const running = runtimeChecksInFlight.get(key);
  if (running) return running;
  const check = checkFfmpegRuntime(opts).finally(() => runtimeChecksInFlight.delete(key));
  runtimeChecksInFlight.set(key, check);
  return check;
}

async function checkFfmpegRuntime(opts: EnsureFfmpegRuntimeOptions): Promise<EnsureFfmpegRuntimeResult> {
  const spec = SPECS[FFMPEG_VENDOR_PLATFORM];
  if (!spec) {
    throw new Error(`unsupported FFmpeg runtime platform: ${FFMPEG_VENDOR_PLATFORM}`);
  }

  const managedDir = managedFfmpegPlatformDir(opts.pluginDataDir);
  const bundledDir = resolve(opts.pluginDistDir, "vendor", "ffmpeg", FFMPEG_VENDOR_PLATFORM);

  if (explicitRuntimeAvailable(spec)) {
    return { ok: true, source: "explicit", platform: spec.platform };
  }
  if (runtimeExists(managedDir, spec)) {
    opts.logEvent?.("info", "meeting_ffmpeg_runtime.ready", { source: "managed", platform: spec.platform });
    return { ok: true, source: "managed", platform: spec.platform, binDir: join(managedDir, "bin") };
  }
  if (runtimeExists(bundledDir, spec)) {
    opts.logEvent?.("info", "meeting_ffmpeg_runtime.ready", { source: "bundled", platform: spec.platform });
    return { ok: true, source: "bundled", platform: spec.platform, binDir: join(bundledDir, "bin") };
  }
  if (await pathRuntimeAvailable(opts.spawnWorker)) {
    opts.logEvent?.("info", "meeting_ffmpeg_runtime.ready", { source: "path", platform: spec.platform });
    return { ok: true, source: "path", platform: spec.platform };
  }

  if (/^(0|false|off|no)$/i.test(process.env.AVE_MEETING_FFMPEG_AUTO_INSTALL ?? "")) {
    throw new Error("FFmpeg runtime is missing and AVE_MEETING_FFMPEG_AUTO_INSTALL disables plugin-managed download");
  }

  const artifactUrl = runtimeArtifactUrl(spec);
  opts.log?.(`[meeting] installing FFmpeg runtime for ${spec.platform}`);
  opts.logEvent?.("info", "meeting_ffmpeg_runtime.download_start", {
    platform: spec.platform,
    source: spec.source,
  });

  await installRuntime(opts, spec, artifactUrl, managedDir);

  opts.logEvent?.("info", "meeting_ffmpeg_runtime.download_done", {
    platform: spec.platform,
    source: spec.source,
    binDir: join(managedDir, "bin"),
  });
  return { ok: true, source: "downloaded", platform: spec.platform, binDir: join(managedDir, "bin") };
}

function runtimeArtifactUrl(spec: RuntimeSpec): string {
  const specific = `AVE_MEETING_FFMPEG_VENDOR_${spec.platform.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_URL`;
  const value = process.env[specific] || process.env.AVE_MEETING_FFMPEG_VENDOR_URL || spec.artifactUrl;
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") {
    throw new Error(`FFmpeg runtime URL must use https: ${value}`);
  }
  return value;
}

function explicitRuntimeAvailable(spec: RuntimeSpec): boolean {
  const ffmpeg = process.env.AVE_MEETING_FFMPEG_PATH;
  const ffprobe = process.env.AVE_MEETING_FFPROBE_PATH;
  if (ffmpeg && ffprobe && existsSync(ffmpeg) && existsSync(ffprobe)) return true;

  const dir = process.env.AVE_MEETING_FFMPEG_DIR;
  if (!dir) return false;
  return runtimeExists(dir, spec) || runtimeExists(join(dir, "bin"), spec, { dirIsBin: true });
}

function runtimeExists(platformDir: string, spec: RuntimeSpec, opts: { dirIsBin?: boolean } = {}): boolean {
  const binDir = opts.dirIsBin ? platformDir : join(platformDir, "bin");
  return existsSync(join(binDir, ffmpegExecutableName("ffmpeg", spec.platform))) &&
    existsSync(join(binDir, ffmpegExecutableName("ffprobe", spec.platform)));
}

async function pathRuntimeAvailable(spawnWorker: MediatedSpawn): Promise<boolean> {
  try {
    for (const tool of ["ffmpeg", "ffprobe"] as const) {
      await runMediatedCommand({
        spawnWorker,
        workerId: installWorkerId(`probe-${tool}`),
        command: tool,
        args: ["-version"],
        // No grants. This asks PATH whether the tool exists at all; a
        // `-version` reads nothing but the binary the host resolved, and
        // naming paths here would grant reach for a question that needs none.
        timeoutMs: 5_000,
      });
    }
    return true;
  } catch {
    return false;
  }
}

async function installRuntime(
  opts: Pick<EnsureFfmpegRuntimeOptions, "hostFetch" | "spawnWorker">,
  spec: RuntimeSpec,
  artifactUrl: string,
  finalDir: string,
): Promise<void> {
  const cacheDir = resolve(dirname(dirname(finalDir)), "_downloads");
  // Beside the cache and the final directory, NOT in `tmpdir()`. A confined
  // plugin child is handed a substituted temp root that the sandbox creates
  // nothing at, so staging an install there fails on the `mkdirSync` — and the
  // install is the step that makes the feature work at all. `finalDir` is
  // already under `pluginDataDir`, so deriving from it keeps all three
  // directories in one place and keeps the rename below on one filesystem.
  const workDir = resolve(dirname(dirname(finalDir)), "_staging", `${spec.platform}-${randomUUID()}`);
  const archivePath = resolve(cacheDir, archiveName(artifactUrl, spec));
  const extractDir = resolve(workDir, "extract");
  const nextDir = resolve(workDir, "runtime");

  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(extractDir, { recursive: true });

  try {
    // Before the download, so an archive nothing vouches for is never fetched.
    const expectedSha256 = await resolveArchiveSha256(opts.hostFetch, artifactUrl, spec);
    // The pinned archive must be exactly its pinned size; an override, which
    // has no pin, is capped. Either is decided from the first answer.
    const sizeLimit: ArchiveSizeLimit = artifactUrl === spec.artifactUrl
      ? { exactBytes: spec.size }
      : { maxBytes: OVERRIDE_ARCHIVE_MAX_BYTES };
    await downloadFile(opts.hostFetch, artifactUrl, archivePath, DOWNLOAD_SLICE_BYTES, sizeLimit);
    // Before extraction: the extractor is the first thing that would act on
    // the archive's contents, and verifyRuntime below runs what it unpacked.
    await verifyArchiveSha256(archivePath, expectedSha256);
    await extractArchive(opts.spawnWorker, spec, archivePath, extractDir);
    const runtimeRoot = findRuntimeRoot(extractDir, spec);
    if (!runtimeRoot) {
      throw new Error(`downloaded FFmpeg archive does not contain bin/${ffmpegExecutableName("ffmpeg", spec.platform)} and bin/${ffmpegExecutableName("ffprobe", spec.platform)}`);
    }

    copyRuntime(runtimeRoot, nextDir, spec);
    if (process.platform === "darwin") {
      await repairDarwinInstallNames(opts.spawnWorker, nextDir);
    }
    chmodRuntimeBins(nextDir, spec);
    await verifyRuntime(opts.spawnWorker, nextDir, spec);
    await writeRuntimeNotices(opts.spawnWorker, nextDir, spec, artifactUrl, expectedSha256);

    mkdirSync(dirname(finalDir), { recursive: true });
    rmSync(finalDir, { recursive: true, force: true });
    renameSync(nextDir, finalDir);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    // Gone on every path. After a failure, the archive is what failed — a
    // mismatched sum or an archive the extractor choked on — and keeping it
    // only parks up to 80 MB beside a retry that downloads it afresh. After a
    // success, the runtime is installed and the archive has nothing left to do.
    rmSync(archivePath, { force: true });
  }
}

/**
 * The sha256 `artifactUrl` must hash to.
 *
 * The pinned artifact's comes from this source ({@link SPECS}) and nothing is
 * asked of the network. An operator override (`AVE_MEETING_FFMPEG_VENDOR_URL`)
 * has no pin, so its release has to publish one: the `checksums.sha256` beside
 * the archive, fetched through the host like the archive itself and therefore
 * held to the same allow-list. No entry, two disagreeing entries, or no file
 * at all is a refusal, never an unverified install.
 */
export async function resolveArchiveSha256(
  fetchThroughHost: MediatedFetch,
  artifactUrl: string,
  pinned: { artifactUrl: string; sha256: string },
): Promise<string> {
  if (artifactUrl === pinned.artifactUrl) return pinned.sha256;

  const checksumsUrl = new URL("checksums.sha256", artifactUrl).toString();
  const name = decodeURIComponent(basename(new URL(artifactUrl).pathname));
  const response = await fetchThroughHost(checksumsUrl, {
    // Same policy as the archive: the release URL answers 302 to the asset host.
    redirect: "follow",
    headers: { "user-agent": "ave-plugin-meeting" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`FFmpeg runtime checksums.sha256 could not be read (${response.status}) from ${checksumsUrl}`);
  }
  const sums = new Set<string>();
  for (const line of (await response.text()).split(/\r?\n/u)) {
    // `sha256sum` output: the digest, then " " or " *" (binary mode), then the name.
    const match = /^([0-9a-f]{64}) [ *](.+)$/iu.exec(line.trim());
    if (match && match[2] === name) sums.add(match[1]!.toLowerCase());
  }
  if (sums.size === 0) {
    throw new Error(`FFmpeg runtime release lists no sha256 for ${name} in ${checksumsUrl}; refusing an archive nothing vouches for`);
  }
  if (sums.size > 1) {
    throw new Error(`FFmpeg runtime release lists more than one sha256 for ${name} in ${checksumsUrl}`);
  }
  return [...sums][0]!;
}

/** Hash the archive on disk and refuse it unless it is the one `expected` names. */
export async function verifyArchiveSha256(archivePath: string, expected: string): Promise<void> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archivePath)) hash.update(chunk as Buffer);
  const actual = hash.digest("hex");
  if (actual !== expected.toLowerCase()) {
    throw new Error(`FFmpeg runtime archive ${basename(archivePath)} does not match its sha256 (expected ${expected.toLowerCase()}, got ${actual})`);
  }
}

function archiveName(artifactUrl: string, spec: RuntimeSpec): string {
  const name = basename(new URL(artifactUrl).pathname);
  if (name && name.includes(".")) return name;
  return `ffmpeg-${spec.platform}.${spec.archive === "zip" ? "zip" : "tar.xz"}`;
}

/**
 * The most bytes one mediated response is asked to carry.
 *
 * The host buffers every `hostFetch` response across the plugin boundary and
 * refuses one above 16 MiB with `payload-too-large` (`WIRE_BYTES_MAX`; HostApi
 * protocol design §8: "A plugin that needs more streams ... in chunks. No
 * chunked body streaming in protocol 1 or 2"). The runtime archives are 27-80
 * MB, so they come down as HTTP Range slices well under that ceiling. Half of
 * it, so a slice is never the request that finds the boundary.
 */
export const DOWNLOAD_SLICE_BYTES = 8 * 1024 * 1024;

/**
 * The largest archive an operator URL override may download. It has no pinned
 * size, and an allowed host serves assets of up to 2 GiB that would otherwise
 * fill the disk before the sha256 check could refuse them. 200 MB is over
 * twice the largest pinned archive (about 79 MB).
 */
export const OVERRIDE_ARCHIVE_MAX_BYTES = 200 * 1024 * 1024;

/** How long the archive may be: exactly its pin, or at most a cap. */
export type ArchiveSizeLimit = { exactBytes: number } | { maxBytes: number };

function archiveSizeProblem(total: number, limit: ArchiveSizeLimit, url: string): string | null {
  if ("exactBytes" in limit) {
    return total === limit.exactBytes ? null : `FFmpeg runtime archive at ${url} is ${total} bytes; its pin says ${limit.exactBytes}`;
  }
  return total <= limit.maxBytes ? null : `FFmpeg runtime archive at ${url} is ${total} bytes, above the ${limit.maxBytes}-byte cap`;
}

/** `Content-Range: bytes <start>-<end>/<total>`, or null when it is not that. */
function parseContentRange(value: string | null): { start: number; end: number; total: number } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(value?.trim() ?? "");
  if (!match) return null;
  const [start, end, total] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return start <= end && end < total ? { start, end, total } : null;
}

/**
 * Fetch `url` to `outPath` using the host's mediated fetch and nothing else.
 *
 * Exported for the boundary tests: this function is where the plugin's only
 * outbound reach lives, so "which URL, under which redirect policy, and what
 * happens when the answer is not 200" has to be assertable directly rather
 * than inferred from a runtime that also extracts and verifies an archive.
 */
export async function downloadFile(
  fetchThroughHost: MediatedFetch,
  url: string,
  outPath: string,
  sliceBytes: number = DOWNLOAD_SLICE_BYTES,
  sizeLimit: ArchiveSizeLimit = { maxBytes: OVERRIDE_ARCHIVE_MAX_BYTES },
): Promise<void> {
  if (existsSync(outPath) && statSync(outPath).size > 0) return;

  const tmpPath = `${outPath}.part`;
  rmSync(tmpPath, { force: true });
  mkdirSync(dirname(outPath), { recursive: true });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15 * 60_000);
  try {
    let offset = 0;
    let total: number | undefined;
    let validator: string | undefined;
    let restarted = false;
    for (;;) {
      const response = await fetchThroughHost(url, {
        // NO REDIRECT LOOP HERE. The host follows redirects itself, and it
        // re-scopes its egress policy on EVERY hop — which is the point of
        // routing through it. EXPLICIT, and it has to be: the host treats an
        // unspecified redirect policy as `"error"`, and the release URL answers
        // 302 on its first hop. Both hosts are declared in
        // `networkAccess.allowedDomains`. `Range` is an ordinary header the
        // host carries onto every hop.
        redirect: "follow",
        headers: {
          "user-agent": "ave-plugin-meeting",
          range: `bytes=${offset}-${offset + sliceBytes - 1}`,
        },
        signal: controller.signal,
      });
      if (response.status === 200) {
        // The server ignores Range and sent the whole body. Only a body within
        // the host's ceiling reaches here at all; a larger one was refused
        // host-side with `payload-too-large`.
        if (offset !== 0) {
          throw new Error(`FFmpeg runtime download restarted mid-transfer from ${url}`);
        }
        const whole = new Uint8Array(await response.arrayBuffer());
        const tooBig = archiveSizeProblem(whole.byteLength, sizeLimit, url);
        if (tooBig) throw new Error(tooBig);
        writeFileSync(tmpPath, whole);
        break;
      }
      if (response.status !== 206) {
        throw new Error(`FFmpeg runtime download failed (${response.status}) from ${url}`);
      }
      const range = parseContentRange(response.headers.get("content-range"));
      if (!range || range.start !== offset) {
        throw new Error(`FFmpeg runtime download answered an unexpected range from ${url}`);
      }
      const tag = response.headers.get("etag") ?? undefined;
      if (offset === 0) {
        // The size limit, from the total the server announces: before the body
        // is read, so an oversized or wrong archive puts nothing on disk.
        const wrongSize = archiveSizeProblem(range.total, sizeLimit, url);
        if (wrongSize) throw new Error(wrongSize);
        // Slices may be spliced only when each provably comes from the same
        // representation, and HTTP's one proof is a shared STRONG validator
        // (RFC 9110 §15.3.7.3). Without it the Content-Range total is all that
        // is left, and two builds of one size pass that. An archive that fits
        // in this one slice splices nothing and needs no validator; anything
        // longer without a strong ETag is refused here, before a second slice
        // is asked for. GitHub's release-asset host sends one on every slice.
        if (range.end + 1 < range.total && (tag === undefined || tag.startsWith("W/"))) {
          throw new Error(`FFmpeg runtime download from ${url} needs a strong ETag to combine its Range slices and the server sent no strong one`);
        }
        total = range.total;
        validator = tag;
      } else if (tag !== validator || range.total !== total) {
        // A release asset re-uploaded mid-download ("latest" is, daily) would
        // otherwise splice two builds into one archive. Start over from zero
        // once, so a replacement that lands mid-transfer costs a retry rather
        // than the install; a second change means the asset is not holding
        // still, and that is refused.
        if (restarted) {
          throw new Error(`FFmpeg runtime artifact changed during download from ${url}, again after starting over`);
        }
        restarted = true;
        rmSync(tmpPath, { force: true });
        offset = 0;
        total = undefined;
        validator = undefined;
        continue;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength !== range.end - range.start + 1) {
        throw new Error(`FFmpeg runtime download returned a short slice from ${url}`);
      }
      appendFileSync(tmpPath, bytes);
      offset = range.end + 1;
      if (offset >= range.total) break;
    }
    // Renamed only after the last slice landed. A `.part` left by an
    // interrupted download must not be mistaken for the archive on the next
    // run — the `existsSync` above tests `outPath`, and this is what keeps that
    // test meaningful.
    renameSync(tmpPath, outPath);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    if (controller.signal.aborted) throw new Error("FFmpeg runtime download timed out");
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function extractArchive(
  spawnWorker: MediatedSpawn,
  spec: RuntimeSpec,
  archivePath: string,
  destDir: string,
): Promise<void> {
  // The same two grants for every extractor below, named once. The archive is
  // the only thing read and the destination the only thing written — an
  // extractor that reached anywhere else would be doing something this install
  // never asked for, and now it cannot.
  const grants = { readPaths: [archivePath], writePaths: [destDir] } as const;
  const EXTRACT_TIMEOUT_MS = 10 * 60_000;

  if (spec.archive === "tar.xz") {
    await runMediatedCommand({
      spawnWorker,
      workerId: installWorkerId("tar"),
      command: "tar",
      args: ["-xf", archivePath, "-C", destDir],
      ...grants,
      timeoutMs: EXTRACT_TIMEOUT_MS,
    });
    return;
  }

  const errors: string[] = [];
  if (process.platform === "win32") {
    for (const shell of ["powershell.exe", "pwsh"]) {
      try {
        await runMediatedCommand({
          spawnWorker,
          workerId: installWorkerId(shell.replace(/\W+/gu, "")),
          command: shell,
          args: [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            `Expand-Archive -LiteralPath ${psQuote(archivePath)} -DestinationPath ${psQuote(destDir)} -Force`,
          ],
          ...grants,
          timeoutMs: EXTRACT_TIMEOUT_MS,
        });
        return;
      } catch (err) {
        errors.push(`${shell}: ${(err as Error).message}`);
      }
    }
  }

  try {
    await runMediatedCommand({
      spawnWorker,
      workerId: installWorkerId("unzip"),
      command: "unzip",
      args: ["-q", archivePath, "-d", destDir],
      ...grants,
      timeoutMs: EXTRACT_TIMEOUT_MS,
    });
    return;
  } catch (err) {
    errors.push(`unzip: ${(err as Error).message}`);
  }
  throw new Error(`could not extract FFmpeg zip archive (${errors.join("; ")})`);
}

function findRuntimeRoot(root: string, spec: RuntimeSpec): string | null {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() ?? root;
    if (runtimeExists(current, spec)) return current;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> = [];
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(join(current, entry.name));
    }
  }
  return null;
}

function copyRuntime(runtimeRoot: string, destDir: string, spec: RuntimeSpec): void {
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
  if (!runtimeExists(destDir, spec)) {
    throw new Error(`copied FFmpeg runtime is missing required binaries for ${spec.platform}`);
  }
}

/**
 * Rewrite the copied dylibs' install names to where they now live.
 *
 * Async, where it used to be `spawnSync`. That is not a style change: the host
 * supervises the child and reports it over events, so there is no synchronous
 * form to have. Every caller was already inside an `async` function.
 *
 * A single file's repair failing is not fatal — `install_name_tool` refuses
 * signed or already-correct binaries and the runtime still verifies afterwards
 * — so those are swallowed, exactly as the `stdio: "ignore"` calls before them
 * were. `otool` failing IS reported, because a file whose dependencies could
 * not be read has not been examined, and treating "we did not look" as "there
 * was nothing to fix" is how a broken install reaches `verifyRuntime` looking
 * clean.
 */
async function repairDarwinInstallNames(
  spawnWorker: MediatedSpawn,
  platformDir: string,
): Promise<void> {
  const files = listFiles(platformDir).filter((file) => {
    const name = basename(file);
    return name === "ffmpeg" || name === "ffprobe" || name.endsWith(".dylib") || name.endsWith(".a");
  });

  /** The tool rewrites the file in place, so it reads and writes exactly it. */
  const rewrite = async (args: readonly string[], file: string): Promise<void> => {
    try {
      await runMediatedCommand({
        spawnWorker,
        workerId: installWorkerId("install-name-tool"),
        command: "install_name_tool",
        args,
        readPaths: [file],
        writePaths: [file],
        timeoutMs: 30_000,
      });
    } catch { /* best-effort, as before: verifyRuntime is the real check */ }
  };

  for (const file of files) {
    const { stdout } = await runMediatedCommand({
      spawnWorker,
      workerId: installWorkerId("otool"),
      command: "otool",
      args: ["-L", file],
      readPaths: [file],
      timeoutMs: 30_000,
    });
    const lines = stdout.split(/\r?\n/);
    if (file.endsWith(".dylib")) {
      await rewrite(["-id", file, file], file);
    }
    for (const line of lines) {
      const dep = line.trim().split(/\s+/)[0] ?? "";
      for (const prefix of ["install_arm64", "install_x86_64", "install_universal"]) {
        const idx = dep.indexOf(prefix);
        if (idx < 0) continue;
        const rel = dep.slice(idx + prefix.length + 1);
        if (!rel) continue;
        await rewrite(["-change", dep, resolve(platformDir, rel), file], file);
      }
    }
  }
}

function chmodRuntimeBins(platformDir: string, spec: RuntimeSpec): void {
  if (spec.platform.startsWith("win32-")) return;
  for (const name of ["ffmpeg", "ffprobe"] as const) {
    try { chmodSync(join(platformDir, "bin", ffmpegExecutableName(name, spec.platform)), 0o755); } catch { /* best-effort */ }
  }
}

async function verifyRuntime(
  spawnWorker: MediatedSpawn,
  platformDir: string,
  spec: RuntimeSpec,
): Promise<void> {
  for (const name of ["ffmpeg", "ffprobe"] as const) {
    const exe = join(platformDir, "bin", ffmpegExecutableName(name, spec.platform));
    await runMediatedCommand({
      spawnWorker,
      workerId: installWorkerId(`verify-${name}`),
      command: exe,
      args: ["-version"],
      // The whole platform directory, not just the executable: a shared build
      // loads its sibling dylibs, and granting only the binary would fail the
      // verification for a runtime that is in fact fine.
      readPaths: [platformDir],
      env: ffmpegRuntimeLibraryEnv(exe),
      timeoutMs: 10_000,
    });
  }
}

async function writeRuntimeNotices(
  spawnWorker: MediatedSpawn,
  platformDir: string,
  spec: RuntimeSpec,
  artifactUrl: string,
  archiveSha256: string,
): Promise<void> {
  const ffmpegExe = join(platformDir, "bin", ffmpegExecutableName("ffmpeg", spec.platform));
  // Both streams, as before: FFmpeg writes its banner to stderr and the
  // notices exist to record what was actually installed, so dropping stderr
  // here would leave the license file describing a build nobody can identify.
  const ask = async (args: readonly string[], purpose: string): Promise<string> => {
    const { stdout, stderr } = await runMediatedCommand({
      spawnWorker,
      workerId: installWorkerId(purpose),
      command: ffmpegExe,
      args,
      readPaths: [platformDir],
      env: ffmpegRuntimeLibraryEnv(ffmpegExe),
      timeoutMs: 10_000,
    });
    return `${stdout}${stderr}`.trim();
  };
  const versionText = await ask(["-version"], "notice-version");
  const licenseText = await ask(["-L"], "notice-license");

  writeFileSync(
    join(platformDir, "FFMPEG_BUILD.json"),
    `${JSON.stringify({
      source: spec.source,
      sourceUrl: spec.sourceUrl,
      artifactUrl,
      archiveSha256,
      platform: spec.platform,
      licenseIntent: spec.licenseIntent,
      ffmpegVersion: versionText ? versionText.split(/\r?\n/).slice(0, 3) : null,
      configureLine: versionText.split(/\r?\n/).find((line) => line.startsWith("configuration: ")) ?? null,
      installedAt: new Date().toISOString(),
    }, null, 2)}\n`,
  );

  writeFileSync(
    join(platformDir, "LICENSE.FFmpeg.txt"),
    `${licenseText || [
      `This runtime was downloaded from ${spec.source}.`,
      spec.licenseIntent,
      "FFmpeg license information: https://www.ffmpeg.org/legal.html",
      "FFmpeg source: https://github.com/FFmpeg/FFmpeg",
    ].join("\n")}\n`,
  );

  writeFileSync(
    join(platformDir, "NOTICE.md"),
    [
      "# FFmpeg Runtime Notice",
      "",
      `- Runtime source: ${spec.source}`,
      `- Runtime artifact: ${artifactUrl}`,
      `- Runtime artifact sha256: ${archiveSha256}`,
      `- Source/build project: ${spec.sourceUrl}`,
      "- License intent: LGPL-compatible shared runtime. Do not replace with GPL or nonfree variants without legal review.",
      "- FFmpeg legal information: https://www.ffmpeg.org/legal.html",
      "",
    ].join("\n"),
  );
}

function listFiles(root: string): string[] {
  const result: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() ?? root;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> = [];
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile()) result.push(path);
    }
  }
  return result;
}

function prependPath(value: string, current?: string): string {
  return current && current.length > 0 ? `${value}${process.platform === "win32" ? ";" : ":"}${current}` : value;
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
