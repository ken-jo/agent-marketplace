/**
 * Meeting Plugin Host — 자기 등록 패턴
 *
 * 호스트에 플러그인 특정 코드 없음.
 * 이 파일이 context.hostApi를 통해 키워드, 이벤트, 태스크, 메모를 직접 등록.
 * 플러그인 제거 시 호스트는 자동으로 정리.
 */
import {
  OpenAIWhisperSttProvider,
  HostLlmSummaryProvider,
  ElectronMeetingRecorder,
  MeetingPipeline,
  MockSummaryProvider,
  type MeetingContext,
} from "./index.js";
import { SessionStore, type PersistedSession } from "./persistence/sessionStore.js";
import { PrepStore } from "./persistence/prepStore.js";
import { CategoryStore } from "./persistence/categoryStore.js";
import {
  FFMPEG_VENDOR_PLATFORM,
  MediatedSpawnStartError,
  ensureFfmpegRuntime,
  ffmpegExecutableName,
  ffmpegRuntimeLibraryEnv,
  managedFfmpegPlatformDir,
  runMediatedCommand,
} from "./ffmpegRuntime.js";
import { normalizeSessionCategory, projectSessionMetadata } from "./persistence/sessionMetadata.js";
import {
  cloneBundledGuideSession,
  isGuideSessionId,
} from "./demo/guideSession.js";
import { randomUUID } from "node:crypto";
import type { AlertInput, ApiKeyLease, HostFetchInit, PluginHostApi } from "@ave/plugin-contract";
import { CalendarAutomation, CalendarClaims, type CalendarClaimStorage } from "./calendarAutomation.js";
import { raiseWithDiagnostics } from "./alerts/alert-result.js";
import { summaryReadyAlert } from "./alerts/meeting-summary-detector.js";
import { dirname, join } from "node:path";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  sanitizeCustomPrompt,
} from "./adapters/summaryPrompts.js";

/**
 * NOTHING IN THIS FILE RESOLVES `electron`.
 *
 * There used to be a lazily-cached `require("electron")` here, behind a
 * specifier held in a variable so a literal grep would not find it, handing
 * this plugin `BrowserWindow`, `ipcMain`, `screen` and `session`. That is
 * ambient axis 2 in the host's routing SOT, and it was the last thing keeping
 * this plugin in the host's own process.
 *
 * Both users are gone and both have host-mediated forms:
 *   - opening a link      → `hostApi.openExternalUrl`
 *   - the recorder window → `hostApi.attachFloatingPanel`
 *
 * `test/hostMediatedShell.test.ts` guards the RESOLUTION FORM rather than any
 * behaviour, because there is no runtime signal: a reintroduced require works
 * perfectly in an ordinary host and only fails once this plugin runs confined,
 * which is exactly the state it is meant to reach.
 */


import type {
  AttachFloatingPanelRequest,
  AudioCaptureDevice,
  AudioCaptureHandle,
  AudioCaptureRequest,
  FloatingPanelHandle,
  PluginWorkerSpec,
  SpawnedPluginWorker,
} from "@ave/plugin-contract";

/**
 * The manifest `ui` entry the recorder card is declared under.
 *
 * The host resolves this against THIS plugin's own manifest and refuses
 * anything that is not one of its `floating` surfaces, so the constant is a
 * name rather than a path — nothing here chooses what gets loaded.
 */
const RECORDER_PANEL_EXTENSION_ID = "meeting-recorder-card";

type HostPluginContext = {
  pluginId: string;
  pluginRoot: string;
  hostRoot: string;
  pluginDataDir: string;
  config?: Record<string, unknown>;
  log: (message: string, meta?: unknown) => void;
  hostApi: {
    emitEvent(type: string, data?: unknown): void;
    onEvent(type: string, handler: (data: unknown) => void): void | (() => void);
    raiseAlert?: PluginHostApi["raiseAlert"];
    /**
     * Sandboxed storage under `pluginDataDir`; holds the calendar automation
     * claims. Every host this plugin supports publishes it; calendar automation
     * refuses to start without it (see `CalendarClaims`).
     */
    storage?: CalendarClaimStorage;
    /**
     * Host keychain read. The result must always be awaited: the host resolves
     * the value off the main thread, so a caller that reads it directly sees a
     * pending Promise instead of the secret.
     */
    getSecret(key: string): string | null | Promise<string | null>;
    resolveApiKey?: PluginHostApi["resolveApiKey"];
    /**
     * §9.2 Track B — read configSchema-declared keys.
     * Real host surface (work-assistant 와 동일). 옛 `getConfig` 메서드는
     * 호스트가 노출한 적이 없는 가짜 이름이었다 — silently undefined 반환.
     */
    config?: {
      get(key: string): unknown;
      set?(key: string, value: unknown): Promise<void>;
      onChange?<T = unknown>(key: string, callback: (value: T | undefined) => void): () => void;
    };
    callLlm?(prompt: string, options?: { maxTokens?: number; systemPrompt?: string; signal?: AbortSignal }): Promise<string>;
    /**
     * Host-mediated process supervisor (Ave >= 0.4.0). The host starts the
     * process, wraps it in the SAME confinement this plugin runs under, and
     * refuses grants wider than the plugin already holds — so what the plugin
     * cannot reach itself it cannot obtain by delegation.
     *
     * OPTIONAL on the type because an older host does not publish it. The call
     * sites REFUSE when it is absent rather than reaching for
     * `child_process.spawn`: falling back would restore exactly the ambient
     * reach this member exists to remove, on the hosts least able to contain
     * it.
     */
    spawnWorker?(spec: PluginWorkerSpec): Promise<SpawnedPluginWorker>;
    /**
     * Host-owned audio capture (Ave >= 0.6.4). The host runs the renderer,
     * the worklet and the loopback wiring; this plugin supplies a sample rate,
     * a frame length and two booleans, and receives PCM.
     *
     * OPTIONAL for the same reason `spawnWorker` is — an older host does not
     * publish it — and the call site REFUSES when it is absent rather than
     * opening a renderer of its own. A recorder window that captures is a
     * renderer outside the sandbox, which is the one ambient axis this plugin
     * had left; falling back to it would give that axis straight back.
     */
    startAudioCapture?(request: AudioCaptureRequest): Promise<AudioCaptureHandle>;
    /**
     * Optional for the same reason every member above it is: this file states
     * the host surface it uses so it compiles against hosts that predate a
     * member, and each call site refuses loudly rather than degrading when one
     * is absent. See `attachRecorderPanel`.
     */
    attachFloatingPanel?(request: AttachFloatingPanelRequest): Promise<FloatingPanelHandle>;
    /** The microphones the user could pick, from the same host (Ave >= 0.6.4). */
    listAudioInputDevices?(): Promise<readonly AudioCaptureDevice[]>;
    /**
     * Open a link in the user's browser, through the host.
     *
     * Optional for the same reason the two above are, and the call site
     * refuses rather than reaching Electron's `shell` itself — that reach is
     * the axis this plugin is trying to give up.
     */
    openExternalUrl?(url: string): Promise<void>;

    /**
     * Host-mediated network egress (SDK v5.13+). The host routes the request
     * through its Electron `net` stack — applying corporate proxy/CA trust AND
     * demo/corporate Azure *private-endpoint* routing (a proxy-bypassing direct
     * session → host-resolver-rules → intranet IP). STT egresses through this
     * so its Azure transcription request reaches the private endpoint the same
     * way the chat LLM provider does; the default Electron `net` session goes
     * through the corporate forward proxy, which resolves the Azure host
     * publicly → 403 "public access disabled". Typed optional for host-version
     * compatibility, but meeting STT REQUIRES it: there is no direct-network
     * fallback — `sttFetch` fails closed (throws) when the host omits it.
     */
    hostFetch?(input: string | URL, init?: HostFetchInit): Promise<Response>;
    logEvent?(level: "info" | "warn" | "error", message: string, data?: unknown): void;
    onShutdown?(handler: () => void | Promise<void>): void;
  };
};

/**
 * Token-bucket rate limiter for meeting_push_chunk.
 * 30 calls per 10s window, plus a 10MB per-chunk size cap.
 */
const PUSH_CHUNK_WINDOW_MS = 10_000;
const PUSH_CHUNK_MAX_CALLS = 30;
const PUSH_CHUNK_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Whisper REST hard limit is 25MB. We mirror that here for meeting_upload_file
 * so callers get a clear, deterministic rejection instead of a remote 413.
 */
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const STT_AUDIO_MAX_BYTES = 15 * 1024 * 1024;

/**
 * Memory-bounded large upload path. The renderer streams encoded bytes in
 * small IPC calls; the host stages them to disk and uses ffmpeg to produce
 * small WAV segments that each stay well below Whisper's 25MB multipart cap.
 */
const STAGED_UPLOAD_MAX_BYTES = 500 * 1024 * 1024;
const STAGED_UPLOAD_CHUNK_MAX_BYTES = 2 * 1024 * 1024;
export const STAGED_UPLOAD_MAX_ACTIVE = 2;
const STAGED_UPLOAD_SEGMENT_SEC = 30;
const STAGED_UPLOAD_MAX_DURATION_SEC = 4 * 60 * 60;
export const STAGED_UPLOAD_TTL_MS = 30 * 60 * 1000;
const STAGED_UPLOAD_DIR_PREFIX = "upload-";
const STAGED_UPLOAD_FFPROBE_TIMEOUT_MS = 30_000;
const STAGED_UPLOAD_FFMPEG_TIMEOUT_MS = 45 * 60 * 1000;
let ffmpegManagedPlatformDir: string | null = null;

function resolveFfmpegExecutable(name: "ffmpeg" | "ffprobe"): string {
  const exe = ffmpegExecutableName(name);
  const explicitPath =
    name === "ffmpeg"
      ? process.env.AVE_MEETING_FFMPEG_PATH
      : process.env.AVE_MEETING_FFPROBE_PATH;
  const explicitDir = process.env.AVE_MEETING_FFMPEG_DIR;
  const candidates = [
    explicitPath,
    explicitDir ? join(explicitDir, exe) : undefined,
    explicitDir ? join(explicitDir, "bin", exe) : undefined,
    ffmpegManagedPlatformDir ? join(ffmpegManagedPlatformDir, "bin", exe) : undefined,
    ffmpegManagedPlatformDir ? join(ffmpegManagedPlatformDir, exe) : undefined,
    join(__dirname, "vendor", "ffmpeg", FFMPEG_VENDOR_PLATFORM, "bin", exe),
    join(__dirname, "vendor", "ffmpeg", FFMPEG_VENDOR_PLATFORM, exe),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

function missingFfmpegMessage(name: "ffmpeg" | "ffprobe"): string {
  const exe = ffmpegExecutableName(name);
  return (
    `${name} executable is required for >25MB uploads; ` +
    `expected plugin-managed binary at pluginDataDir/vendor/ffmpeg/${FFMPEG_VENDOR_PLATFORM}/bin/${exe}, ` +
    `bundled binary at dist/vendor/ffmpeg/${FFMPEG_VENDOR_PLATFORM}/bin/${exe}, ` +
    "or install FFmpeg on PATH"
  );
}
const STAGED_SEGMENT_MIME = "audio/wav";

/**
 * Capture audio format. The HOST's capture emits frames at this sample rate
 * and this process assembles them into PCM16LE chunks of CHUNK_SEC length.
 * 16kHz mono is what the STT pipeline expects.
 */
const LOOPBACK_SAMPLE_RATE = 16000;
const LOOPBACK_CHUNK_SEC = 3;

// ─── Hardening helpers ───────────────────────────────────────────────────
//
// Defensive guards applied at every untrusted entry point. Most of these
// were called out by the Sec/Code-Review pass — see the consolidated fix
// list. The point of pulling them up here (rather than inlining at each
// site) is that the rules are uniform: a sessionId from an LLM tool-call
// gets the same scrutiny as one from the floating window's IPC bridge.

/** Regex guard for sessionIds. Used as a filename in SessionStore so
 *  path-traversal-style values (../ , absolute paths, NUL, Windows
 *  reserved names) must be rejected at the boundary. */
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export function assertSessionId(sid: unknown): asserts sid is string {
  if (typeof sid !== "string" || !SESSION_ID_RE.test(sid)) {
    throw new Error("invalid sessionId (must match [A-Za-z0-9_-]{1,128})");
  }
}

/** The numeric fields carried on a pushed audio chunk, in the order they
 *  are reported. Every one of them feeds arithmetic downstream. */
export const CHUNK_NUMERIC_FIELDS = ["sampleRate", "startSec", "endSec"] as const;

/**
 * Guard for the numeric fields of a pushed audio chunk.
 *
 * These values do not merely get stored: `sampleRate` is written into the
 * WAV header handed to the STT provider, and `startSec` / `endSec` are added
 * to each returned segment's relative offset to place it on the meeting
 * timeline. A missing or non-finite value therefore produces a NaN timestamp
 * that is persisted on the transcript and stays invisible until a much later
 * `meeting_transcript` read is refused by the host's boundary check for
 * carrying a non-finite number — an error with no trace back to the push
 * that caused it. Rejecting here, naming the field, keeps the diagnosis at
 * the call site that can actually fix it.
 */
export function assertFiniteChunkNumbers(chunk: unknown): void {
  const fields = (chunk ?? {}) as Record<string, unknown>;
  for (const field of CHUNK_NUMERIC_FIELDS) {
    const value = fields[field];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      // Report the number itself (NaN, Infinity) but only the type for
      // non-numbers, so a hostile payload can't push arbitrary text into
      // the error string.
      const seen = typeof value === "number" ? String(value) : typeof value;
      throw new Error(`chunk.${field} must be a finite number (received ${seen})`);
    }
  }
}

/**
 * Narrow an unknown tier value (from a user/IPC payload) to a valid
 * SummaryLengthTier, or return undefined to let the caller fall back
 * to its own default. Defensive — payloads from the floating window's
 * IPC bridge or the `meeting_stop` tool surface aren't trusted.
 */
export function pickLengthTier(raw: unknown): import("./types.js").SummaryLengthTier | undefined {
  return raw === "short" || raw === "medium" || raw === "long" ? raw : undefined;
}

/** Defensive sanitiser for caller-supplied filenames. The cleaned name is
 *  forwarded to OpenAI's multipart parser AND written to host log entries
 *  — anything that survives both surfaces is fine here. */
export function safeFileName(raw: unknown): string {
  if (typeof raw !== "string") return "upload";
  // Strip CR/LF/NUL (header smuggling + log injection vectors), drop any
  // directory separators by taking the basename only, then narrow to a
  // friendly subset and cap length.
  const stripped = raw.replace(/[\r\n\0]/g, "");
  const basename = stripped.split(/[\\/]/).pop() ?? "upload";
  const cleaned = basename.replace(/[^\w.\- ]/g, "_").slice(0, 120);
  return cleaned.length > 0 ? cleaned : "upload";
}

/** Pre-decode size check for base64 uploads. base64 is 4 chars per 3
 *  bytes, plus padding — gate the string length first so we don't allocate
 *  a 100MB Buffer for a 25MB cap rejection. */
export function isBase64WithinCap(b64: string, byteCap: number): boolean {
  // 16-byte slop for newlines / non-canonical padding.
  return b64.length <= Math.ceil((byteCap * 4) / 3) + 16;
}

export interface UploadFilePayload {
  name: string;
  bytesBase64: string;
  mimeType?: string;
}

export function normaliseUploadFilePayload(raw: unknown): UploadFilePayload {
  if (!raw || typeof raw !== "object") {
    throw new Error("file.bytesBase64 and file.name are required");
  }
  const file = raw as Record<string, unknown>;
  if (
    typeof file.name !== "string" ||
    file.name.length === 0 ||
    typeof file.bytesBase64 !== "string" ||
    file.bytesBase64.length === 0
  ) {
    throw new Error("file.bytesBase64 and file.name are required");
  }
  return {
    name: file.name,
    bytesBase64: file.bytesBase64,
    mimeType: typeof file.mimeType === "string" ? file.mimeType : undefined,
  };
}

interface StagedUploadFilePayload {
  name: string;
  size: number;
  mimeType?: string;
}

interface StagedUploadState {
  uploadId: string;
  sessionId: string;
  context?: MeetingContext & { lengthTier?: unknown };
  lengthTier?: import("./types.js").SummaryLengthTier;
  fileName: string;
  mimeType?: string;
  declaredSize: number;
  receivedBytes: number;
  dir: string;
  inputPath: string;
  segmentDir: string;
  createdAt: number;
  lastActivityAt: number;
  status: "receiving" | "finishing";
  /**
   * Which pair of worker ids this upload's FFmpeg runs use. See
   * {@link takeFfmpegWorkerSlot} — it is a SLOT, held for the upload's
   * lifetime, not a value derived per run.
   */
  workerSlot: number;
  abortController?: AbortController;
}

/**
 * `spawnWorker` refuses a second worker with an id that is already running, and
 * two staged uploads run at once by design — so the id cannot be a constant.
 * Nor can it be fresh per run: the host's registry would then name runs that no
 * longer exist. A slot held for the upload's lifetime is both stable and
 * unique, and the pool is sized to the cap the uploads already have.
 *
 * The two tools get SEPARATE id families rather than sharing the slot's id.
 * They run one after the other, and the host releases a worker's reservation
 * when the process is definitively gone — which is not guaranteed to have
 * happened by the moment `onExit` resolves the first call. Distinct ids make
 * that ordering irrelevant instead of making it a race that only shows up on a
 * loaded machine.
 */
export function ffmpegWorkerId(tool: "ffmpeg" | "ffprobe", slot: number): string {
  return `meeting-${tool}-${slot}`;
}

export function takeFfmpegWorkerSlot(inUse: ReadonlySet<number>): number {
  for (let slot = 0; slot < STAGED_UPLOAD_MAX_ACTIVE; slot += 1) {
    if (!inUse.has(slot)) return slot;
  }
  // Unreachable while the active-upload cap and this pool are the same number.
  // A throw rather than a queue: if they have drifted apart, waiting would hide
  // the drift behind a hang.
  throw new Error(
    `no free FFmpeg worker slot (cap ${STAGED_UPLOAD_MAX_ACTIVE}); `
      + "the active-upload limit and the slot pool have drifted apart",
  );
}

function assertSafeByteCount(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return raw;
}

function normaliseStagedUploadFilePayload(raw: unknown): StagedUploadFilePayload {
  if (!raw || typeof raw !== "object") {
    throw new Error("file.name and file.size are required");
  }
  const file = raw as Record<string, unknown>;
  if (typeof file.name !== "string" || file.name.length === 0) {
    throw new Error("file.name and file.size are required");
  }
  const size = assertSafeByteCount(file.size, "file.size");
  if (size === 0) throw new Error("file is empty");
  if (size > STAGED_UPLOAD_MAX_BYTES) {
    throw new Error(`file-too-large: max ${STAGED_UPLOAD_MAX_BYTES} bytes`);
  }
  return {
    name: file.name,
    size,
    mimeType: typeof file.mimeType === "string" ? file.mimeType : undefined,
  };
}

function decodeStagedBase64Chunk(raw: unknown): Buffer {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("bytesBase64 is required");
  }
  if (!isBase64WithinCap(raw, STAGED_UPLOAD_CHUNK_MAX_BYTES)) {
    throw new Error(`chunk-too-large: max ${STAGED_UPLOAD_CHUNK_MAX_BYTES} bytes`);
  }
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length === 0) throw new Error("chunk is empty");
  if (bytes.length > STAGED_UPLOAD_CHUNK_MAX_BYTES) {
    throw new Error(`chunk-too-large: max ${STAGED_UPLOAD_CHUNK_MAX_BYTES} bytes`);
  }
  return bytes;
}

function segmentFileName(baseName: string, index: number): string {
  const stem = baseName.replace(/\.[^.]*$/, "") || "upload";
  return `${stem}.part-${String(index + 1).padStart(5, "0")}.wav`;
}

export function parsePcmWavDurationSec(bytes: Buffer): number {
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("invalid wav segment");
  }
  let channels = 1;
  let sampleRate = 16_000;
  let bitsPerSample = 16;
  let dataBytes: number | undefined;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const next = dataStart + size + (size % 2);
    if (next > bytes.length + 1) break;
    if (id === "fmt " && size >= 16 && dataStart + 16 <= bytes.length) {
      channels = bytes.readUInt16LE(dataStart + 2);
      sampleRate = bytes.readUInt32LE(dataStart + 4);
      bitsPerSample = bytes.readUInt16LE(dataStart + 14);
    } else if (id === "data") {
      dataBytes = Math.min(size, Math.max(0, bytes.length - dataStart));
      break;
    }
    offset = next;
  }
  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  if (!dataBytes || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    throw new Error("wav segment duration unavailable");
  }
  return dataBytes / bytesPerSecond;
}

/**
 * Where a staged upload's working files live.
 *
 * NOT `tmpdir()`, and the difference is not tidiness. A confined plugin child
 * is handed a substituted temp root that the sandbox CREATES NOTHING AT, so the
 * sweep below — which runs in the activation body — answered `ENOENT` and
 * stopped the plugin from LOADING. Not a degraded feature: a plugin that does
 * not start.
 *
 * Rooting it under `pluginDataDir` also gives the domain its own directory, so
 * "clear this feature's working files" is one `rm -rf` rather than a prefix
 * match against everything else in the machine's temp.
 */
export function stagedUploadRoot(pluginDataDir: string): string {
  return join(pluginDataDir, "staged-uploads");
}

export function cleanupStaleStagedUploadDirs(
  root: string,
  now = Date.now(),
  protectedDirs: ReadonlySet<string> = new Set(),
): number {
  let removed = 0;
  // CREATED before it is read, because on a fresh install it is not there yet
  // and "no root" and "an empty sweep" have to answer the same way. This
  // creates only the directory this function owns — it is not a guard around a
  // failure that could have another cause.
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(root)) {
    if (!name.startsWith(STAGED_UPLOAD_DIR_PREFIX)) continue;
    const dir = join(root, name);
    if (protectedDirs.has(dir)) continue;
    try {
      const stat = statSync(dir);
      const touchedAt = Math.max(stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs);
      if (now - touchedAt <= STAGED_UPLOAD_TTL_MS) continue;
      rmSync(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Best-effort temp cleanup only.
    }
  }
  return removed;
}

function throwIfStagedUploadAborted(state: StagedUploadState): void {
  if (state.abortController?.signal.aborted) {
    throw new Error("staged upload aborted");
  }
}

/**
 * One runner for both FFmpeg tools, through the host's worker supervisor.
 *
 * WHY NOT `spawn`. Starting a process is ambient axis 3, and a confined plugin
 * child is not supposed to have it. `hostApi.spawnWorker` is the mediated form:
 * the host starts the process, wraps it in the SAME confinement the child runs
 * under, and refuses grants wider than the child already holds — so what the
 * plugin cannot reach itself, it cannot obtain by delegation. The
 * `allowReadPaths` below are declared rather than inferred, because the host
 * deliberately does not read argv to decide filesystem grants.
 *
 * WHY ONE RUNNER. The two call sites were the same forty lines twice — timeout,
 * abort, stdout capture, exit code — differing only in which binary and which
 * error text. Two copies of a cancellation path drift into two different
 * answers about whether a killed process rejects.
 *
 * WORKER IDS ARE SLOTS, not per-run values. `spawnWorker` refuses a second
 * worker with an id that is already running, so a shared constant would make
 * two concurrent uploads collide; a fresh id per run would instead leave the
 * host's registry naming runs that no longer exist. The pool is sized to
 * `STAGED_UPLOAD_MAX_ACTIVE`, which is the same bound the uploads already have.
 */
interface FfmpegToolRun {
  readonly tool: "ffmpeg" | "ffprobe";
  readonly args: readonly string[];
  readonly workerId: string;
  readonly spawnWorker: NonNullable<HostPluginContext["hostApi"]["spawnWorker"]>;
  /** Extra paths the tool reads or writes; the host grants nothing from argv. */
  readonly readPaths?: readonly string[];
  readonly writePaths?: readonly string[];
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

async function runFfmpegTool(run: FfmpegToolRun): Promise<{ stdout: string; stderr: string }> {
  const executable = resolveFfmpegExecutable(run.tool);
  // `resolveFfmpegExecutable` answers with the BARE NAME when it found no
  // bundled or managed runtime, which means "let PATH decide" — a real source
  // (`ensureFfmpegRuntime` calls it `path`). Keeping the distinction lets a
  // failure to start be reported as the missing runtime it usually is, rather
  // than as a generic spawn error.
  const relyingOnPath = executable === run.tool || executable === `${run.tool}.exe`;

  try {
    return await runMediatedCommand({
      spawnWorker: run.spawnWorker,
      workerId: run.workerId,
      command: executable,
      args: run.args,
      env: ffmpegRuntimeLibraryEnv(executable),
      readPaths: [...(relyingOnPath ? [] : [executable]), ...(run.readPaths ?? [])],
      writePaths: run.writePaths,
      timeoutMs: run.timeoutMs,
      signal: run.signal,
      label: run.tool,
    });
  } catch (err) {
    // Only a START failure becomes "please install FFmpeg". A tool that ran
    // and exited non-zero has already given its own verdict, and overwriting
    // it here would report a corrupt input file as a missing runtime.
    if (err instanceof MediatedSpawnStartError && relyingOnPath) {
      throw new Error(missingFfmpegMessage(run.tool));
    }
    throw err;
  }
}

export async function runFfprobeDurationSec(
  inputPath: string,
  opts: {
    workerId: string;
    spawnWorker: NonNullable<HostPluginContext["hostApi"]["spawnWorker"]>;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<number> {
  const { stdout } = await runFfmpegTool({
    tool: "ffprobe",
    args: [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ],
    workerId: opts.workerId,
    spawnWorker: opts.spawnWorker,
    readPaths: [inputPath],
    timeoutMs: opts.timeoutMs ?? STAGED_UPLOAD_FFPROBE_TIMEOUT_MS,
    signal: opts.signal,
  });
  const duration = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("ffprobe could not determine audio duration; refusing unbounded large upload");
  }
  return duration;
}

export async function runFfmpegSegmenter(
  inputPath: string,
  outputPattern: string,
  opts: {
    workerId: string;
    spawnWorker: NonNullable<HostPluginContext["hostApi"]["spawnWorker"]>;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<void> {
  await runFfmpegTool({
    tool: "ffmpeg",
    args: [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputPath,
      "-map",
      "0:a:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-threads",
      "1",
      "-c:a",
      "pcm_s16le",
      "-f",
      "segment",
      "-segment_format",
      "wav",
      "-segment_time",
      String(STAGED_UPLOAD_SEGMENT_SEC),
      "-reset_timestamps",
      "1",
      outputPattern,
    ],
    workerId: opts.workerId,
    spawnWorker: opts.spawnWorker,
    readPaths: [inputPath],
    // The segmenter writes `segment-%05d.wav` into this directory, so the
    // DIRECTORY is the grant — the files do not exist yet to be named.
    writePaths: [dirname(outputPattern)],
    timeoutMs: opts.timeoutMs ?? STAGED_UPLOAD_FFMPEG_TIMEOUT_MS,
    signal: opts.signal,
  });
}


/** Global channel names registered by electron-audio-loopback initMain.
 *  They are not namespaced by this plugin, so hot-reload cleanup must
 *  remove them before a freshly loaded plugin calls initMain again. */

/** pythonExecutable allowlist — must be either the literal "python"/"python3"
 *  (lookup via PATH) or an absolute path that exists on disk. Refuses
 *  shell-metacharacters even though spawn(shell:false) is already safe —
 *  belt-and-suspenders against future config-injection vectors. */
/**
 * Validate a URL for `meeting_open_url` / `shell.openExternal`. Returns
 * the parsed URL on success, or an error tag explaining the rejection.
 * Pure function so the hardening behaviour (Webex host allowlist,
 * presence, no embedded credentials) is unit-testable without the host
 * runtime.
 */
export function validateOpenUrl(raw: unknown):
  | { ok: true; url: URL }
  | { ok: false; error: "missing-url" | "invalid-url" | "disallowed-protocol" | "missing-host" | "credentials-in-url" | "non-webex-url"; protocol?: string } {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, error: "missing-url" };
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return { ok: false, error: "invalid-url" }; }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: "disallowed-protocol", protocol: parsed.protocol };
  }
  if (!parsed.hostname || parsed.hostname.length === 0) {
    return { ok: false, error: "missing-host" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "credentials-in-url" };
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/u, "");
  if (hostname !== "webex.com" && !hostname.endsWith(".webex.com")) {
    return { ok: false, error: "non-webex-url" };
  }
  return { ok: true, url: parsed };
}

/**
 * Return true when `hostname` is a loopback, link-local, or RFC1918
 * private address. Used by `validateSttBaseUrl` to refuse a user-
 * configurable OpenAI-compat endpoint that would pivot the host's
 * Bearer token to a cloud metadata service (169.254.169.254) or an
 * internal SSRF target. Defensive — covers the common case (literal IP
 * or `localhost`), not exhaustive (DNS resolution to a private IP at
 * fetch time is not blocked here).
 */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.+$/u, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  // IPv6 — URL.hostname strips the surrounding brackets, but be defensive.
  const v6 = h.replace(/^\[|\]$/g, "");
  const mappedV4 = ipv4FromMappedIpv6(v6);
  if (mappedV4) return isPrivateOrLoopbackHost(mappedV4);
  if (v6 === "::1" || v6 === "::") return true;
  if (/^fc[0-9a-f]{2}:/.test(v6) || /^fd[0-9a-f]{2}:/.test(v6)) return true;
  if (v6.startsWith("fe80:")) return true;
  // IPv4 dotted-quad.
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 127) return true;          // 127.0.0.0/8 loopback
    if (a === 0) return true;            // 0.0.0.0/8 "this network"
    if (a === 10) return true;           // 10.0.0.0/8 private
    if (a === 169 && b === 254) return true;  // link-local + AWS metadata
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16/12 private
    if (a === 192 && b === 168) return true;  // 192.168.0.0/16 private
  }
  return false;
}

function ipv4FromMappedIpv6(hostname: string): string | null {
  const dotted = hostname.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted?.[1]) return dotted[1];

  // WHATWG URL normalizes ::ffff:127.0.0.1 to ::ffff:7f00:1.
  const hex = hostname.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex?.[1] || !hex[2]) return null;
  const hi = Number.parseInt(hex[1], 16);
  const lo = Number.parseInt(hex[2], 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi > 0xffff || lo > 0xffff) {
    return null;
  }
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/**
 * Validate a user-configured OpenAI-compatible STT endpoint URL. The
 * configSchema field `sttBaseUrl` only enforces `format: "uri"`, which
 * any string with a scheme satisfies — without this guard, a malicious
 * or mistyped value would direct every Whisper request (with the
 * `Authorization: Bearer <OpenAI key>` header verbatim) to an arbitrary
 * host, including cloud metadata services.
 *
 * Stricter than `validateOpenUrl`:
 *   - HTTPS only (no http: even for localhost dev — the key is too
 *     sensitive to ride plaintext).
 *   - No embedded credentials.
 *   - Refuses private / loopback / link-local hostnames so a config
 *     value can't pivot the bearer to a cloud-metadata service.
 *
 * DNS-time rebinding is not blocked here (we don't resolve before the
 * request); for that an outbound proxy is the right layer.
 */
export function validateSttBaseUrl(raw: unknown):
  | { ok: true; url: URL }
  | { ok: false; error: "missing-url" | "invalid-url" | "disallowed-protocol" | "missing-host" | "credentials-in-url" | "private-host"; protocol?: string; host?: string } {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, error: "missing-url" };
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return { ok: false, error: "invalid-url" }; }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: "disallowed-protocol", protocol: parsed.protocol };
  }
  if (!parsed.hostname || parsed.hostname.length === 0) {
    return { ok: false, error: "missing-host" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "credentials-in-url" };
  }
  if (isPrivateOrLoopbackHost(parsed.hostname)) {
    return { ok: false, error: "private-host", host: parsed.hostname };
  }
  return { ok: true, url: parsed };
}

const DEFAULT_AZURE_OPENAI_API_VERSION = "2025-01-01-preview";

function normalizeKnownSttEndpoint(baseUrl: URL, model: string): string {
  const hostname = baseUrl.hostname.toLowerCase();
  const normalizedModel = model.trim().length > 0 ? model.trim() : "gpt-4o-transcribe";
  const apiVersion = baseUrl.searchParams.get("api-version")?.trim()
    || DEFAULT_AZURE_OPENAI_API_VERSION;

  if (hostname === "api.openai.com") {
    return "https://api.openai.com/v1/audio/transcriptions";
  }

  if (hostname.endsWith(".openai.azure.com")) {
    const url = new URL(baseUrl.toString());
    url.pathname = `/openai/deployments/${encodeURIComponent(normalizedModel)}/audio/transcriptions`;
    url.search = "";
    url.searchParams.set("api-version", apiVersion);
    return url.toString();
  }

  // Azure AI Foundry model-inference roots often look like
  // `https://<resource>.services.ai.azure.com/models`. The STT provider in
  // this plugin speaks the Azure OpenAI-compatible transcriptions route, so
  // normalize the host + path into that shape using the configured STT model
  // as the deployment name.
  if (hostname.endsWith(".services.ai.azure.com")) {
    const azureOpenAiHost = hostname.replace(/\.services\.ai\.azure\.com$/u, ".openai.azure.com");
    const url = new URL(`https://${azureOpenAiHost}/openai/deployments/${encodeURIComponent(normalizedModel)}/audio/transcriptions`);
    url.searchParams.set("api-version", apiVersion);
    return url.toString();
  }

  return baseUrl.toString();
}

export function resolveSttConfiguration(
  rawApiKey: unknown,
  rawBaseUrl: unknown,
  rawModel?: unknown,
):
  | { ok: true; apiKey: string; baseUrl: string }
  | {
      ok: false;
      error: "missing-api-key" | "invalid-base-url";
      message: string;
    } {
  const apiKey = typeof rawApiKey === "string" ? rawApiKey.trim() : "";
  if (apiKey.length === 0) {
    return {
      ok: false,
      error: "missing-api-key",
      message: "STT API key is not configured. Save the plugin's STT API key in settings before recording.",
    };
  }

  const baseUrl = typeof rawBaseUrl === "string" ? rawBaseUrl.trim() : "";
  if (baseUrl.length === 0) {
    return { ok: true, apiKey, baseUrl: "https://api.openai.com/v1/audio/transcriptions" };
  }

  const validated = validateSttBaseUrl(baseUrl);
  if (!validated.ok) {
    return {
      ok: false,
      error: "invalid-base-url",
      message: "STT endpoint is invalid. Check the plugin's STT endpoint in settings before recording.",
    };
  }

  const model = typeof rawModel === "string" ? rawModel : "";
  return { ok: true, apiKey, baseUrl: normalizeKnownSttEndpoint(validated.url, model) };
}

/**
 * Validates a plugin bundleId. Accepts lowercase letters, digits, and
 * hyphens; must start with a letter; max 64 chars. This matches CSS-safe
 * identifiers and prevents DoS via oversized strings or injection via
 * malformed identifiers in the theme-propagation cache.
 */
export const BUNDLE_ID_REGEX = /^[a-z][a-z0-9-]{0,63}$/;

export function assertBundleId(raw: unknown): asserts raw is string {
  if (typeof raw !== "string" || !BUNDLE_ID_REGEX.test(raw)) {
    throw new Error(`Invalid bundleId format: ${sanitizePreview(raw)}`);
  }
}

/**
 * Sanitizes an arbitrary value for safe inclusion in log messages.
 * Strips all ASCII control characters (CR, LF, NUL, etc.) to prevent
 * log injection, then truncates to 64 chars.
 */
export function sanitizePreview(value: unknown): string {
  let str: string;
  try {
    str = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  } catch {
    str = String(value);
  }
  // Truncate FIRST to bound input size, then strip control chars.
  str = str.slice(0, 64);
  return str.replace(/[\x00-\x1f\x7f]/g, "?");
}

export function looksLikeEndpointUrlSecret(value: unknown): boolean {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}
/**
 * Build the lifecycle prefix of a meeting.summary.created event payload
 * (sessionId + startedAt/endedAt/durationMs/participants) from a persisted
 * session. The canonical emit at the recorder's final-summary listener has
 * these direct from the live event payload; replay-style re-emits
 * (idempotent stop, update_summary, regenerate_summary) must reconstruct
 * them from SessionStore so downstream consumers can still correlate the
 * event with the original meeting.
 *
 * Falls back to {sessionId} alone when persisted is null (session crashed
 * before persist).
 */
export function deriveSummaryEventBase(
  persisted: PersistedSession | null,
  sessionId: string,
): {
  sessionId: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  participants?: string[];
} {
  if (!persisted) return { sessionId };
  const startedAt = persisted.createdAt;
  const endedAt = persisted.updatedAt;
  let durationMs: number | undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    durationMs = end - start;
  }
  return {
    sessionId,
    startedAt,
    endedAt,
    durationMs,
    participants: persisted.context?.participants,
  };
}

/**
 * Compute per-window peak amplitudes from a PCM16LE mono Buffer. Each
 * window is `windowSamples` samples (each sample = 2 bytes), peak is the
 * absolute max divided by 32768 to land in [0, 1]. Returns floor(buffer
 * length / windowBytes) values; trailing partial windows are dropped (the
 * caller's accumulator keeps the remainder).
 */
/**
 * Chunking strategy for host-captured audio — the same one the recorder
 * renderer used to run, moved to where the audio now arrives.
 *
 * VAD-driven flush with a force-cut overlap fallback:
 *   - MIN_CHUNK_SEC — refuse to cut before this much audio is buffered, so
 *     ordinary speech rhythm does not produce chatty one-token chunks.
 *   - MAX_CHUNK_SEC — cut anyway once the buffer reaches this length. The
 *     safety valve for a long monologue with no pause in it.
 *   - SILENCE_TAIL_SEC — a run of trailing silence that triggers a cut. Half
 *     a second catches sentence-end pauses without slicing mid-word.
 *   - FORCE_OVERLAP_SEC — audio re-included in the NEXT chunk when the cut was
 *     forced rather than chosen. A forced cut lands mid-syllable by
 *     definition, and the pipeline's LCS-based `deduplicateAndMerge` stitches
 *     the two halves back together from the overlap. A silence cut needs none:
 *     the boundary is already clean.
 */
const MIN_CHUNK_SEC = 2.0;
const MAX_CHUNK_SEC = 6.0;
const SILENCE_TAIL_SEC = 0.5;
const FORCE_OVERLAP_SEC = 0.5;
/**
 * Amplitude floor for "this frame is silent", against the peak the host
 * reports per frame. Unchanged from the renderer: the number was tuned
 * against real rooms, and the only thing that moved is who measures it.
 */
const SILENCE_PEAK_THRESHOLD = 0.02;

/** One chunk, in exactly the shape `pipeline.ingestAudioChunk` takes. */
export interface CapturedAudioChunk {
  readonly pcm16leMono: Buffer;
  readonly sampleRate: number;
  readonly startSec: number;
  readonly endSec: number;
}

/** Accumulates host frames and cuts them into chunks. */
export interface AudioChunker {
  /**
   * Take one frame. Returns the chunks it completed — usually none, and more
   * than one only if a single frame were longer than a whole chunk, which the
   * host's frame bounds do not allow but the loop handles anyway rather than
   * silently dropping audio.
   */
  push(pcm: Uint8Array, peak: number): CapturedAudioChunk[];
  /** Everything still buffered, as a terminal chunk. `null` when empty. */
  final(): CapturedAudioChunk | null;
}

/**
 * Build a chunker for one recording.
 *
 * INT16 THROUGHOUT, where the renderer worked in float32. The renderer had no
 * choice — that is what an `AudioWorklet` hands you — but the host delivers
 * int16 already, and converting to float and back would be two lossy passes
 * for nothing.
 */
export function createAudioChunker(sampleRate: number = LOOPBACK_SAMPLE_RATE): AudioChunker {
  const minSamples = Math.round(sampleRate * MIN_CHUNK_SEC);
  const maxSamples = Math.round(sampleRate * MAX_CHUNK_SEC);
  const silenceTailSamples = Math.round(sampleRate * SILENCE_TAIL_SEC);
  const overlapSamples = Math.round(sampleRate * FORCE_OVERLAP_SEC);
  // One frame of slack past the force-cut point: a frame can arrive while the
  // buffer already sits at `maxSamples`, and growing is cheaper than deciding
  // mid-frame whether there is room.
  const capacity = maxSamples + Math.round(sampleRate * 1.0);
  const buffer = new Int16Array(capacity);
  let filled = 0;
  let silentRun = 0;
  let cursorSamples = 0;

  const emit = (cutAt: number, stride: number): CapturedAudioChunk => {
    // Copied out before the memmove below, which is what makes the copy
    // necessary rather than wasteful: the caller keeps this buffer while the
    // ring underneath it is being rewritten.
    const bytes = Buffer.alloc(cutAt * 2);
    for (let i = 0; i < cutAt; i += 1) bytes.writeInt16LE(buffer[i]!, i * 2);
    const chunk: CapturedAudioChunk = {
      pcm16leMono: bytes,
      sampleRate,
      startSec: cursorSamples / sampleRate,
      endSec: (cursorSamples + cutAt) / sampleRate,
    };
    if (stride < filled) buffer.copyWithin(0, stride, filled);
    filled -= stride;
    cursorSamples += stride;
    silentRun = 0;
    return chunk;
  };

  return {
    push(pcm, peak) {
      const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      const sampleCount = Math.floor(pcm.byteLength / 2);
      const out: CapturedAudioChunk[] = [];
      let read = 0;
      while (read < sampleCount) {
        const take = Math.min(sampleCount - read, capacity - filled);
        if (take <= 0) {
          // The ring is full and no cut was reachable. Dropping the rest of
          // this frame is the least-bad outcome — the alternative is writing
          // past the end and corrupting audio that is already buffered — and
          // it is unreachable while `capacity` exceeds `maxSamples`.
          break;
        }
        for (let i = 0; i < take; i += 1) {
          buffer[filled + i] = view.getInt16((read + i) * 2, true);
        }
        filled += take;
        read += take;
        // Silence is measured per FRAME, so the whole frame's samples count
        // toward the run or reset it. That is the granularity the host's
        // `frameMs` sets, and it is why the request asks for a short one.
        if (peak < SILENCE_PEAK_THRESHOLD) silentRun += take;
        else silentRun = 0;

        const silenceCut = filled >= minSamples && silentRun >= silenceTailSamples;
        const forceCut = filled >= maxSamples;
        if (silenceCut) {
          // Consume everything: a silence boundary is a clean break, so the
          // next chunk starts fresh with no overlap to deduplicate.
          out.push(emit(filled, filled));
        } else if (forceCut) {
          out.push(emit(maxSamples, maxSamples - overlapSamples));
        }
      }
      return out;
    },
    final() {
      if (filled === 0) return null;
      // No overlap on the terminal chunk — there is no next chunk to stitch to.
      return emit(filled, filled);
    },
  };
}

export function computePeaksFromPCM(buf: Buffer, windowSamples: number): number[] {
  if (!Number.isFinite(windowSamples) || windowSamples <= 0) return [];
  const winBytes = windowSamples * 2;
  const out: number[] = [];
  for (let off = 0; off + winBytes <= buf.length; off += winBytes) {
    let peak = 0;
    for (let i = off; i < off + winBytes; i += 2) {
      const v = Math.abs(buf.readInt16LE(i));
      if (v > peak) peak = v;
    }
    out.push(peak / 32768);
  }
  return out;
}

export function resolvePythonExecutable(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return "python";
  if (/[<>"'`|&;$()*?\r\n]/.test(raw)) {
    throw new Error("pythonExecutable contains shell metacharacters");
  }
  if (raw === "python" || raw === "python3" || raw === "py") return raw;
  // Accept absolute paths only. Existence check is best-effort: spawn
  // will surface a clearer error if the file isn't found at runtime.
  const isAbs = raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw);
  if (!isAbs) {
    throw new Error("pythonExecutable must be 'python' or an absolute path");
  }
  if (!existsSync(raw)) {
    throw new Error(`pythonExecutable not found: ${raw}`);
  }
  return raw;
}

/**
 * Per-session sliding-window rate limiter for `meeting_push_chunk`.
 * A previous version was process-wide, which meant two concurrent senders
 * could starve each other inside the same 30/10s budget. Each sessionId
 * keeps its own timestamp ring; `forget()` reclaims the entry on session
 * end so the map can't grow unbounded across very long-lived plugin
 * instances.
 */
export class PushChunkRateLimiter {
  private readonly buckets = new Map<string, number[]>();
  constructor(
    private readonly windowMs = PUSH_CHUNK_WINDOW_MS,
    private readonly maxCalls = PUSH_CHUNK_MAX_CALLS,
    private readonly now: () => number = () => Date.now(),
  ) {}
  tryAcquire(sessionId: string): boolean {
    const t = this.now();
    const filtered = (this.buckets.get(sessionId) ?? []).filter(
      (ts) => t - ts < this.windowMs,
    );
    if (filtered.length >= this.maxCalls) {
      this.buckets.set(sessionId, filtered);
      return false;
    }
    filtered.push(t);
    this.buckets.set(sessionId, filtered);
    return true;
  }
  /** Drop the per-session bucket. Call on session end to bound memory. */
  forget(sessionId: string): void {
    this.buckets.delete(sessionId);
  }
}

export const PUSH_CHUNK_LIMITS = {
  windowMs: PUSH_CHUNK_WINDOW_MS,
  maxCalls: PUSH_CHUNK_MAX_CALLS,
  maxBytes: PUSH_CHUNK_MAX_BYTES,
};

type MeetingChunk = {
  // The renderer ships Int16Array directly (saves ~4× over Array.from boxing
  // for large uploads); legacy callers may still send number[]. The handler
  // below only relies on `.length` and integer indexing, which both forms
  // satisfy.
  pcm16leMono: number[] | Int16Array;
  sampleRate: number;
  startSec: number;
  endSec: number;
};

export default async function createPlugin(context: HostPluginContext) {
  const { hostApi, log } = context;
  const raiseAlert = hostApi.raiseAlert
    ? (input: AlertInput) => raiseWithDiagnostics(hostApi.raiseAlert!.bind(hostApi), input, (diagnostic) => {
      if (hostApi.logEvent) hostApi.logEvent("warn", "meeting.alert.rejected", diagnostic);
      else log(`[meeting] alert ${diagnostic.kind} rejected: ${diagnostic.status}${diagnostic.field ? ` (${diagnostic.field})` : ""}`);
    })
    : undefined;
  const raiseSummaryAlert = (payload: unknown): void => {
    if (!raiseAlert) return;
    const alert = summaryReadyAlert(payload);
    if (!alert) return;
    void raiseAlert(alert).catch((error) => {
      hostApi.logEvent?.("warn", "meeting.summary.alert_failed", { error: error instanceof Error ? error.name : "unknown" });
    });
  };
  const emitSummary = (payload: unknown): void => {
    hostApi.emitEvent("meeting.summary.created", payload);
    raiseSummaryAlert(payload);
  };
  ffmpegManagedPlatformDir = managedFfmpegPlatformDir(context.pluginDataDir);

  // Unset until the first check is scheduled. NOT scheduled here: this factory
  // also runs for a replacement generation that is still preparing, and the
  // host refuses `spawnWorker` and `hostFetch` to that generation
  // (`plugin_hostapi_denied`, "unavailable while a replacement generation is
  // preparing") — every boot logged two WARN lines for a check that could not
  // run yet. The check starts from `onPublished`, or from the first use that
  // needs the runtime, whichever comes first.
  let ffmpegRuntimeReady: Promise<unknown> | undefined;
  const scheduleFfmpegRuntimeCheck = () => {
    ffmpegRuntimeReady = ensureFfmpegRuntime({
      pluginDataDir: context.pluginDataDir,
      pluginDistDir: __dirname,
      // The runtime archive comes off the internet, and a plugin child has no
      // direct egress. Bound here rather than read inside: one place decides
      // where the plugin's network goes.
      hostFetch: requireHostFetch(),
      // Same rule for processes. Installing the runtime runs `tar`/`unzip`/
      // `otool` and then the new binaries themselves; a confined child has no
      // `child_process`, and the host is what declares the grants each of
      // those runs gets.
      spawnWorker: requireSpawnWorker(),
      log,
      logEvent: hostApi.logEvent ? hostApi.logEvent.bind(hostApi) : undefined,
    }).catch((err) => {
      const message = (err as Error).message;
      log(`[meeting] FFmpeg runtime unavailable: ${message}`);
      hostApi.logEvent?.("warn", "meeting_ffmpeg_runtime.unavailable", {
        platform: FFMPEG_VENDOR_PLATFORM,
        error: message,
      });
      throw err;
    });
    void ffmpegRuntimeReady.catch(() => { /* reported through hostApi.logEvent */ });
  };
  const requireFfmpegRuntime = async () => {
    // A tool can be called after publication but before `onPublished` ran.
    if (!ffmpegRuntimeReady) scheduleFfmpegRuntimeCheck();
    const attempt = ffmpegRuntimeReady;
    try {
      await attempt;
    } catch {
      // One retry per failed attempt: the first caller to see the failure
      // schedules it, and a concurrent caller joins that retry rather than
      // starting a second install. (ensureFfmpegRuntime coalesces as well.)
      if (ffmpegRuntimeReady === attempt) scheduleFfmpegRuntimeCheck();
      await ffmpegRuntimeReady;
    }
  };
  if (process.env.VITEST === "true") {
    // Settled, so neither `onPublished` nor a first use schedules a check.
    ffmpegRuntimeReady = Promise.resolve();
    hostApi.logEvent?.("info", "meeting_ffmpeg_runtime.skipped", {
      reason: "vitest",
      platform: FFMPEG_VENDOR_PLATFORM,
    });
  }
  /** Start the check once the generation is live. Not awaited: it may download. */
  const warmFfmpegRuntime = () => {
    if (!ffmpegRuntimeReady) scheduleFfmpegRuntimeCheck();
  };

  // §9.2 Track B: configSchema-declared keys 는 호스트의 `hostApi.config.get`
  // accessor 로 읽는다. 과거 코드는 존재하지 않는 `hostApi.getConfig` 를
  // 가리키고 있어 (호스트 SDK 의 실제 surface 는 `hostApi.config.{get,set,onChange}`)
  // 항상 undefined 가 반환되어 모든 configSchema override 가 silently 무시됐음.
  const getConfig = hostApi.config?.get
    ? hostApi.config.get.bind(hostApi.config)
    : undefined;
  const clampIntegerConfig = (raw: unknown, min: number, max: number, fallback: number): number => {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(raw)));
  };
  const clampNumberConfig = (raw: unknown, min: number, max: number, fallback: number): number => {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
    return Math.min(max, Math.max(min, raw));
  };

  // Whisper STT 는 binary audio 입력이 필요해 callLlm surface 밖 — 직접 SDK 유지.
  // Summary 는 단발 텍스트 생성이라 hostApi.callLlm 으로 위임 (§1 원칙 1).
  //
  // STT key resolution — single source-of-truth contract:
  //   - apiKeySource="plugin": read only this plugin's own secret namespace,
  //     `plugin.<id>.sttApiKey`, which the host settings UI writes for the
  //     configSchema field `sttApiKey`. This path never calls
  //     hostApi.resolveApiKey, so local/user-installed plugins do not need
  //     marketplace host-secret whitelist grants for BYO STT keys.
  //   - apiKeySource="host": call hostApi.resolveApiKey({purpose:"stt"}).
  //     Vendor is intentionally omitted so the host defaults to the user's
  //     active LLM provider, preserving Azure users.
  //   - No sidecar or legacy `apiKey` fallback is used. Secret persistence
  //     belongs to the host keychain via pluginConfig.setSecret.
  //
  // The per-session AbortController owned by MeetingPipeline is fed to
  // resolveApiKey AND to Whisper's fetch() so meeting_stop releases the
  // host key lease and cancels any in-flight transcription request.

  const rawApiKeySource = getConfig?.("apiKeySource");
  const sttKeySource: "host" | "plugin" = rawApiKeySource === "plugin"
    ? "plugin"
    : "host";

  let sttModel: string = "gpt-4o-transcribe";
  const rawSttModel = getConfig?.("sttModel");
  if (typeof rawSttModel === "string" && rawSttModel.length > 0) {
    sttModel = rawSttModel;
  }

  const readPluginSttApiKey = async (): Promise<string | undefined> => {
    const value = await hostApi.getSecret?.(`plugin.${context.pluginId}.sttApiKey`);
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  };
  const pluginSttApiKey = await readPluginSttApiKey();

  // sttBaseUrl is user-editable via plugin settings and forwarded into
  // the Whisper REST call with the `Authorization: Bearer <OpenAI key>`
  // header attached verbatim. Validate strictly (https only, no
  // private/loopback/metadata IPs) so a malicious or mistyped value
  // can't pivot the bearer to an SSRF target. Rejecting a configured URL is
  // a hard start error; silently falling back could send an Azure/custom key
  // to OpenAI public.
  const rawSttBaseUrl = getConfig?.("sttBaseUrl");
  let sttBaseUrl: string | undefined;
  let sttBaseUrlInvalidReason: string | undefined;
  if (typeof rawSttBaseUrl === "string" && rawSttBaseUrl.trim().length > 0) {
    const validated = validateSttBaseUrl(rawSttBaseUrl);
    if (validated.ok) {
      sttBaseUrl = normalizeKnownSttEndpoint(validated.url, sttModel);
    } else {
      sttBaseUrlInvalidReason = validated.error;
      hostApi.logEvent?.("warn", "sttBaseUrl rejected", {
        error: validated.error,
        preview: sanitizePreview(rawSttBaseUrl),
      });
    }
  }
  // Default 6: balanced intermediate summary frequency. Earlier 2 was too
  // aggressive — most meetings hit the host callLlm rate limit before the
  // user finished speaking. Combined with the 90s wall-clock floor below
  // this caps live summaries to ~1 per minute even on fast-talking calls.
  const rawIntermediate = getConfig?.("intermediateEveryFinalSegments");
  const intermediateEveryFinalSegments = clampIntegerConfig(rawIntermediate, 1, 50, 6);
  // configSchema-driven: minimum wall-clock gap between intermediate
  // summaries. Default 90s — chosen as a compromise between live UX and
  // host callLlm rate-limit budget. User can override via plugin settings.
  const rawIntermediateInterval = getConfig?.("intermediateMinIntervalMs");
  const intermediateMinIntervalMs = clampIntegerConfig(rawIntermediateInterval, 0, 600_000, 90_000);
  // Uploads can process a whole recording in seconds, so the live wall-clock
  // throttle is intentionally not the SOT for file analysis. This budget caps
  // upload intermediates per session and leaves headroom for the final summary
  // inside the host callLlm rate window.
  const rawUploadIntermediateBudget = getConfig?.("uploadIntermediateSummaryBudget");
  const uploadIntermediateSummaryBudget = clampIntegerConfig(rawUploadIntermediateBudget, 0, 18, 8);
  // Master switch for intermediate summaries. configSchema default true.
  // Setting false bypasses the time/segment gates entirely — useful when
  // the live-update card adds noise more than signal.
  const rawIntermediateEnabled = getConfig?.("intermediateSummariesEnabled");
  const intermediateSummariesEnabled =
    typeof rawIntermediateEnabled === "boolean" ? rawIntermediateEnabled : true;
  // STT segment shaping (Whisper post-processing — see openaiWhisperSttProvider).
  // Defaults preserve current behaviour when user hasn't tuned.
  const rawNoSpeech = getConfig?.("sttNoSpeechThreshold");
  const sttNoSpeechThreshold = clampNumberConfig(rawNoSpeech, 0, 1, 0.7);
  const rawMinSeg = getConfig?.("sttMinSegmentSec");
  const sttMinSegmentSec = clampNumberConfig(rawMinSeg, 0, 30, 0);
  const rawMaxGap = getConfig?.("sttMaxGapSec");
  const sttMaxGapSec = clampNumberConfig(rawMaxGap, 0, 10, 0);
  // Final-summary verbosity. Per-call meeting_stop payload can override.
  const rawTier = getConfig?.("summaryLengthTier");
  const summaryLengthTier: import("./types.js").SummaryLengthTier =
    rawTier === "short" || rawTier === "long" ? rawTier : "medium";

  const sttFetch = async (input: string | URL, init?: HostFetchInit): Promise<Response> => {
    // Tier A — plugins egress ONLY through host-mediated fetch. The host routes
    // demo/corporate Azure private-endpoint URLs through its proxy-bypassing
    // direct session (host-resolver-rules → intranet IP), matching the chat LLM
    // path; the default Electron `net` session goes through the corporate
    // forward proxy, which resolves the Azure host publicly → 403 "public
    // access disabled". There is NO direct Electron-net / bare-fetch fallback:
    // independent plugin networking is not permitted (host-mediated egress is
    // the only path). Tests either inject the provider's `options.fetch` seam
    // (bypassing this) or supply a stub `hostApi.hostFetch` that this delegates
    // to — both reach STT without a live socket.
    if (typeof hostApi.hostFetch !== "function") {
      throw new Error(
        "STT egress unavailable: host does not provide hostApi.hostFetch (host-mediated egress is required for transcription)",
      );
    }
    const url = input instanceof URL
        ? input.toString()
        : input;
    return hostApi.hostFetch(url, init);
  };

  // Admin-set custom system prompts from configSchema. They are editable
  // through the host plugin settings panel, not through normal plugin
  // tools: exposing a prompt-write handler in tools[] would make it
  // callable by LLM/tool flows and allow persistent summarizer prompt
  // poisoning. Sanitize once here; resolve functions sanitize again at
  // use-time as defense in depth for legacy/unsanitized config values.
  const rawCustomFinal = getConfig?.("customSummaryFinalPrompt");
  let customSummaryFinalPrompt = sanitizeCustomPrompt(rawCustomFinal);
  const rawCustomIntermediate = getConfig?.("customSummaryIntermediatePrompt");
  let customSummaryIntermediatePrompt = sanitizeCustomPrompt(rawCustomIntermediate);

  // Visibility: customSummaryFinalPrompt is used verbatim, which means
  // FINAL_LENGTH_GUIDE tier instructions are NOT auto-injected. If an
  // admin has set the custom prompt AND configured a non-default tier
  // (or relies on per-call lengthTier overrides from the recorder UI),
  // they're effectively a no-op until the prompt itself contains length
  // instructions. Surface this once at plugin load so the mismatch
  // doesn't silently produce wrong-length summaries.
  if (customSummaryFinalPrompt.trim().length > 0) {
    hostApi.logEvent?.("warn", "customSummaryFinalPrompt overrides built-in tier guidance — short/medium/long settings will NOT affect output length unless the custom prompt itself encodes length instructions.", {
      tierConfigured: summaryLengthTier,
      customPromptBytes: new TextEncoder().encode(customSummaryFinalPrompt).length,
    });
  }

  // Plugin webviews have a UI-only config bridge (`bridge.config.get/set`)
  // that is not a normal plugin tool. Use hostApi.config.onChange so prompt
  // edits from the sidebar can take effect for the next regenerate call
  // without adding a LLM-visible prompt-write handler to tools[].
  hostApi.config?.onChange?.("customSummaryFinalPrompt", (value) => {
    customSummaryFinalPrompt = sanitizeCustomPrompt(value);
    hostApi.logEvent?.("info", "meeting_custom_summary_final_prompt_updated", {
      promptSet: customSummaryFinalPrompt.trim().length > 0,
      customPromptBytes: new TextEncoder().encode(customSummaryFinalPrompt).length,
    });
  });
  hostApi.config?.onChange?.("customSummaryIntermediatePrompt", (value) => {
    customSummaryIntermediatePrompt = sanitizeCustomPrompt(value);
    hostApi.logEvent?.("info", "meeting_custom_summary_intermediate_prompt_updated", {
      promptSet: customSummaryIntermediatePrompt.trim().length > 0,
      customPromptBytes: new TextEncoder().encode(customSummaryIntermediatePrompt).length,
    });
  });

  // Storage: <pluginDataDir>/sessions/ (SDK-provided, isolated per plugin).
  const sessionsDir: string = join(context.pluginDataDir, "sessions");

  // One-time migration: if the old host-root path has data and the new path is
  // empty, bring the contents over so existing sessions are not lost.
  //
  // COPY, NOT RENAME. `legacyDir` is under `context.hostRoot`, which a confined
  // plugin child may READ but not WRITE — `renameSync` out of it is refused
  // `EPERM`. This runs in the ACTIVATION body with nothing to catch it, so the
  // rename did not degrade the migration, it stopped the plugin from loading.
  // Reading still works (the child's read confinement is deny-only), so the
  // bytes cross even though the directory entry cannot be moved.
  const legacyDir = join(context.hostRoot, ".meeting-sessions");
  if (existsSync(legacyDir)) {
    mkdirSync(sessionsDir, { recursive: true });
    const newFiles = existsSync(sessionsDir) ? readdirSync(sessionsDir) : [];
    if (newFiles.length === 0) {
      const legacyFiles = readdirSync(legacyDir);
      const leftBehind: string[] = [];
      for (const file of legacyFiles) {
        copyFileSync(join(legacyDir, file), join(sessionsDir, file));
        // The unlink is attempted separately and its failure REPORTED rather
        // than swallowed. What stays behind is the user's meeting transcripts,
        // in a directory this plugin no longer reads — and a leftover nobody
        // names is a leftover nobody deletes.
        try {
          rmSync(join(legacyDir, file));
        } catch {
          leftBehind.push(file);
        }
      }
      log(`[meeting] migrated ${legacyFiles.length} session file(s) from ${legacyDir} to ${sessionsDir}`);
      if (leftBehind.length > 0) {
        log(
          `[meeting] WARNING: copied but could not delete ${leftBehind.length} file(s) under ${legacyDir}`
            + ` — they are duplicates of the migrated sessions and can be removed by hand: ${leftBehind.join(", ")}`,
        );
      }
    } else {
      log(`[meeting] WARNING: legacy session dir ${legacyDir} still exists but new dir is non-empty — skipping migration`);
    }
  }

  const sessionStore = new SessionStore(sessionsDir);

  function normalizeRelatedSessionIds(ids: unknown, selfId?: string): string[] {
    if (!Array.isArray(ids)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of ids) {
      if (typeof raw !== "string") continue;
      const id = raw.trim();
      if (!id || id === selfId || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out.slice(0, 50);
  }

  function projectRelatedSessions(ids: unknown, selfId?: string) {
    return normalizeRelatedSessionIds(ids, selfId)
      .map((id) => sessionStore.load(id))
      .filter((s): s is PersistedSession => Boolean(s))
      .map(projectSessionMetadata);
  }

  function withRelatedSessions(session: PersistedSession): PersistedSession & {
    relatedSessions: ReturnType<typeof projectSessionMetadata>[];
  } {
    const relatedSessionIds = normalizeRelatedSessionIds(
      session.relatedSessionIds,
      session.sessionId,
    );
    return {
      ...session,
      relatedSessionIds,
      relatedSessions: projectRelatedSessions(relatedSessionIds, session.sessionId),
    };
  }

  function listFinishedSessionMetadata(opts?: {
    category?: unknown;
    before?: unknown;
    excludeSessionId?: string;
    limit?: unknown;
  }) {
    const category = opts?.category !== undefined
      ? normalizeProvidedCategory(opts.category)
      : null;
    const beforeMs = typeof opts?.before === "string"
      ? Date.parse(opts.before)
      : Number.NaN;
    const limit = Number.isFinite(opts?.limit)
      ? Math.min(100, Math.max(1, Math.floor(opts?.limit as number)))
      : 20;
    return sessionStore.listFinished(500)
      .filter((s) => s.sessionId !== opts?.excludeSessionId)
      .filter((s) => !category || normalizeSessionCategory(s.category || s.context?.category) === category)
      .filter((s) => !Number.isFinite(beforeMs) || Date.parse(s.createdAt) < beforeMs)
      .map(projectSessionMetadata)
      .slice(0, limit);
  }

  function updateSessionCategory(sessionId: string, category: unknown) {
    const persisted = sessionStore.load(sessionId);
    if (!persisted) throw new Error(`session not found: ${sessionId}`);
    if (!persisted.finalized) {
      throw new Error("only finalized meeting sessions can be categorized");
    }
    const nextCategory = normalizeProvidedCategory(category);
    const known = listMeetingCategories();
    if (!nextCategory) {
      return {
        ok: false,
        needsCategorySelection: true,
        missing: ["category"],
        categories: known,
        message: "Meeting category is required. Ask the user to choose a category first.",
      };
    }
    if (!known.includes(nextCategory)) {
      return {
        ok: false,
        needsCategoryRegistration: true,
        unknownCategories: [nextCategory],
        categories: known,
        message:
          "새 회의 카테고리입니다. 먼저 meeting_categories 로 기존 카테고리를 조회한 뒤, 등록 여부를 확인하고 meeting_register_category 를 호출하세요.",
      };
    }
    const updated = {
      ...persisted,
      category: nextCategory,
      updatedAt: new Date().toISOString(),
    };
    sessionStore.save(updated);
    return {
      ok: true,
      sessionId,
      category: nextCategory,
    };
  }

  function categoryExtrasFromData(): string[] {
    return [
      ...sessionStore.listFinished(500).flatMap((session) => [
        session.category,
        session.context?.category,
      ]),
      ...prepStore.list().map((prep) => prep.category),
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  }

  function listMeetingCategories(): string[] {
    return categoryStore.list(categoryExtrasFromData());
  }

  function normalizeProvidedCategory(raw: unknown): string | null {
    if (typeof raw !== "string" || raw.trim().length === 0) return null;
    return normalizeSessionCategory(raw);
  }

  function inferCategoryFromContext(context: MeetingContext): string | null {
    const explicit = normalizeProvidedCategory(context.category);
    if (explicit) return explicit;
    const haystack = [
      context.title,
      context.description,
      context.contextHint,
      context.organizer,
      context.location,
      ...(Array.isArray(context.agenda) ? context.agenda : []),
    ].filter((value): value is string => typeof value === "string").join(" ").toLocaleLowerCase();
    const matched = listMeetingCategories()
      .filter((category) => category !== "일반")
      .find((category) => haystack.includes(category.toLocaleLowerCase()));
    return matched ?? null;
  }

  function latestSummaryForCategory(category: string, before?: string) {
    const beforeMs = typeof before === "string" ? Date.parse(before) : Number.NaN;
    return sessionStore.listFinished(500)
      .filter((session) => normalizeSessionCategory(session.category) === category)
      .filter((session) => Boolean(session.finalSummary))
      .filter((session) => !Number.isFinite(beforeMs) || Date.parse(session.createdAt) < beforeMs)
      .map(projectSessionMetadata)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }

  function hydratePrepContext(raw: MeetingContext): MeetingContext {
    const category = normalizeProvidedCategory(raw.category);
    if (!category) {
      throw new Error("category is required before registering a meeting prep");
    }
    const last = latestSummaryForCategory(category, raw.scheduledStart);
    return {
      ...raw,
      category,
      previousSummary: last
        ? {
            title: last.title,
            summary: sessionStore.load(last.sessionId)?.finalSummary?.summary ?? "",
          }
        : raw.previousSummary,
    };
  }

  function categoryRegistrationGate(contexts: MeetingContext[]) {
    const known = listMeetingCategories();
    const missing = contexts
      .map((ctx, index) => ({
        index,
        title: typeof ctx.title === "string" ? ctx.title : undefined,
        suggestedCategory: inferCategoryFromContext(ctx) ?? undefined,
      }))
      .filter((item) => !normalizeProvidedCategory(contexts[item.index]?.category));
    if (missing.length > 0) {
      return {
        ok: false,
        needsCategorySelection: true,
        missing: ["category"],
        count: missing.length,
        categories: known,
        suggestions: missing.slice(0, 20),
        message:
          "Meeting category is required. Ask the user to choose one of the existing categories before registering. If the user wants a new category, call meeting_categories, confirm creation, then call meeting_register_category and retry with category.",
      };
    }
    const unknown = contexts
      .map((ctx) => normalizeProvidedCategory(ctx.category))
      .filter((category): category is string => Boolean(category))
      .filter((category, index, arr) => arr.indexOf(category) === index)
      .filter((category) => !known.includes(category));
    if (unknown.length === 0) return null;
    return {
      ok: false,
      needsCategoryRegistration: true,
      unknownCategories: unknown,
      categories: known,
      message:
        "새 회의 카테고리가 감지되었습니다. 먼저 meeting_categories 로 기존 카테고리를 조회한 뒤, 새 카테고리로 등록할지 사용자 확인 후 meeting_register_category 를 호출하세요.",
    };
  }

  function updateLinkedSessions(sessionId: string, targetSessionId: string, linked: boolean) {
    if (sessionId === targetSessionId) {
      throw new Error("cannot link a meeting to itself");
    }
    const left = sessionStore.load(sessionId);
    const right = sessionStore.load(targetSessionId);
    if (!left) throw new Error(`session not found: ${sessionId}`);
    if (!right) throw new Error(`session not found: ${targetSessionId}`);
    if (!left.finalized || !right.finalized) {
      throw new Error("only finalized meeting sessions can be linked");
    }
    const now = new Date().toISOString();
    const merge = (session: PersistedSession, otherId: string) => {
      const current = normalizeRelatedSessionIds(session.relatedSessionIds, session.sessionId);
      const next = linked
        ? normalizeRelatedSessionIds([...current, otherId], session.sessionId)
        : current.filter((id) => id !== otherId);
      return { ...session, relatedSessionIds: next, updatedAt: now };
    };
    const nextLeft = merge(left, targetSessionId);
    const nextRight = merge(right, sessionId);
    sessionStore.save(nextLeft);
    sessionStore.save(nextRight);
    return {
      ok: true,
      sessionId,
      targetSessionId,
      linked,
      relatedSessionIds: nextLeft.relatedSessionIds,
      targetRelatedSessionIds: nextRight.relatedSessionIds,
    };
  }

  // Prep store lives directly under pluginDataDir (single JSON file).
  // Distinct from SessionStore (per-session JSON files for completed
  // recordings) — preps are upcoming-meeting metadata.
  const prepStore = new PrepStore(
    context.pluginDataDir,
    hostApi.logEvent ? hostApi.logEvent.bind(hostApi) : undefined,
  );
  const categoryStore = new CategoryStore(context.pluginDataDir);

  // Pass getters so provider construction stays uniform if the host later
  // gains a safe config refresh path. This plugin intentionally does not
  // expose a normal tool that mutates persistent system prompts.
  const getFinalPrompt = () => customSummaryFinalPrompt;
  const getIntermediatePrompt = () => customSummaryIntermediatePrompt;
  // Summary provider — prefer hostApi.callLlm (host LLM lease, no plugin
  // key needed). When the host doesn't expose callLlm we fall back to a Mock
  // summary so the pipeline stays runnable without LLM access. We deliberately
  // do NOT reuse the plugin-local STT key for summarization: the manifest declares
  // `llmKeySource: "host"`, meaning users opting plugin-local STT (BYO STT
  // key) have not consented to that key being used for summary calls against
  // OpenAI public — host inheritance (e.g. Azure AI Foundry) is the only
  // sanctioned summary path.
  const hostCallLlmAvailable = typeof hostApi.callLlm === "function";
  const summaryProvider = hostCallLlmAvailable
    ? new HostLlmSummaryProvider({
        callLlm: hostApi.callLlm!.bind(hostApi),
        logEvent: hostApi.logEvent ? hostApi.logEvent.bind(hostApi) : undefined,
        defaultLengthTier: summaryLengthTier,
        customFinalSystem: getFinalPrompt,
        customIntermediateSystem: getIntermediatePrompt,
      })
    : new MockSummaryProvider();

  if (hostCallLlmAvailable) {
    log("[meeting] summary via host callLlm");
  } else {
    // ralph round-1 (architect + critic Major): Mock summary fallback was a
    // silent UX degradation — users finished a meeting and received a mock
    // (placeholder) summary without realising real LLM access was missing.
    // Surface this via a warn-level log AND a structured event so the host UI
    // / proactive engine can flag the degraded state.
    log(
      "[meeting] summary via Mock — WARNING: host callLlm not exposed; real summaries unavailable until host LLM is configured",
    );
    hostApi.logEvent?.("warn", "meeting_summary_degraded", {
      reason: "host-callLlm-unavailable",
    });
    // ralph round-2 (architect Minor + NIT): optional chain on emitEvent
    // back-compat with older hosts that omit the method, plus a
    // human-readable title/body so the host's OS notification surface
    // (driven by plugin.json notificationEvents) actually renders a
    // meaningful banner instead of relying on raw {reason, at}.
    hostApi.emitEvent?.("meeting.summary.degraded", {
      title: "회의 요약 — placeholder",
      body: "호스트 LLM 미노출로 실제 요약 생성 불가. host upgrade 또는 설정 확인 필요.",
      reason: "host-callLlm-unavailable",
      at: new Date().toISOString(),
    });
    void raiseAlert?.({ kind: "summary-degraded", key: "host-callLlm-unavailable" }).catch((error) => {
      hostApi.logEvent?.("warn", "meeting.summary.degraded_alert_failed", { error: error instanceof Error ? error.name : "unknown" });
    });
  }

  // Redacted STT diagnostic — no key material, no slot paths.
  const sttDiagnostic = {
    sttKeySource,
    pluginSttKeyPresent: Boolean(pluginSttApiKey),
    pluginSttKeyLooksLikeEndpointUrl: looksLikeEndpointUrlSecret(pluginSttApiKey),
    resolveApiKeyAvailable: typeof hostApi.resolveApiKey === "function",
    sttBaseUrlConfigured: Boolean(sttBaseUrl),
    sttModel,
  };
  hostApi.logEvent?.("info", "meeting_stt_provider_selection", sttDiagnostic);
  log(`[meeting] STT diagnostic: ${JSON.stringify(sttDiagnostic)}`);

  // Per-session STT provider factory.
  // apiKeySource is the SOT:
  //   - plugin -> `plugin.<id>.sttApiKey` from the host keychain
  //   - host   -> hostApi.resolveApiKey({purpose:"stt", signal}) lease,
  //      gated by manifest llmKeySource + hostSecrets and marketplace
  //      whitelist. Vendor is intentionally omitted so the host defaults to
  //      the user's active LLM provider: an Azure-only user
  //      will resolve to Azure, never silently forced onto OpenAI public.
  // Hard-fails without test-provider fallback when the selected source is unavailable; the
  // pipeline surfaces the error and hostPlugin emits meeting.error to the UI.
  //
  // The session AbortSignal is passed to BOTH resolveApiKey (cancels the
  // resolution promise + auto-releases on abort) and OpenAIWhisperSttProvider
  // (cancels in-flight Whisper fetch). meeting_stop → pipeline.abortSession
  // fires the signal, completing the resolveApiKey lease lifecycle.
  const pendingSttLeaseReleases = new Map<string, Set<Promise<void>>>();
  const waitForSttLeaseRelease = async (sessionId: string): Promise<void> => {
    await Promise.all(pendingSttLeaseReleases.get(sessionId) ?? []);
  };
  async function sttProviderFactory(
    { sessionId, signal }: { sessionId: string; signal: AbortSignal },
  ): Promise<import("./providers.js").SttProvider> {
    if (sttBaseUrlInvalidReason) {
      hostApi.emitEvent("meeting.error", {
        sessionId,
        reason: `stt-base-url-invalid:${sttBaseUrlInvalidReason}`,
      });
      throw new Error(`Cannot start meeting: STT endpoint invalid (${sttBaseUrlInvalidReason})`);
    }

    const makeProvider = (credential: { apiKey: string } | { lease: ApiKeyLease }, baseUrl: string | undefined, source: "host" | "plugin") => {
      let endpointHost: string | undefined;
      if (baseUrl) {
        try { endpointHost = new URL(baseUrl).hostname; } catch { endpointHost = "invalid-url"; }
      }
      hostApi.logEvent?.("info", "meeting_stt_provider_resolved", {
        sessionId,
        source,
        endpointHost: endpointHost ?? "default",
        sttModel,
      });
      return new OpenAIWhisperSttProvider({
        ...credential,
        model: sttModel,
        baseUrl,
        noSpeechThreshold: sttNoSpeechThreshold,
        minSegmentSec: sttMinSegmentSec,
        maxGapSec: sttMaxGapSec,
        fetch: sttFetch,
        signal,
      });
    };

    if (sttKeySource === "plugin") {
      const currentPluginSttApiKey = await readPluginSttApiKey();
      if (!currentPluginSttApiKey) {
        hostApi.emitEvent("meeting.error", {
          sessionId,
          reason: "stt-key-unavailable:plugin-stt-key-missing",
        });
        throw new Error("Cannot start meeting: STT key unavailable (plugin sttApiKey is not configured)");
      }
      if (looksLikeEndpointUrlSecret(currentPluginSttApiKey)) {
        hostApi.emitEvent("meeting.error", {
          sessionId,
          reason: "stt-key-unavailable:plugin-stt-key-is-url",
        });
        hostApi.logEvent?.("warn", "plugin sttApiKey rejected because it looks like an endpoint URL", {
          sessionId,
          sttKeySource,
        });
        throw new Error("Cannot start meeting: STT key unavailable (plugin sttApiKey contains an endpoint URL; save the URL in sttBaseUrl and re-enter the API key)");
      }
      return makeProvider({ apiKey: currentPluginSttApiKey }, sttBaseUrl, "plugin");
    }

    const resolver = hostApi.resolveApiKey;

    if (typeof resolver !== "function") {
      hostApi.emitEvent("meeting.error", {
        sessionId,
        reason: "stt-key-unavailable:no-host-resolveApiKey",
      });
      throw new Error("Cannot start meeting: STT key unavailable (host does not implement resolveApiKey and apiKeySource=host)");
    }

    // vendor is omitted — host maps to user's active LLM provider (#955).
    const handle = await resolver({ purpose: "stt", exposure: "lease", signal });
    if (!handle.ok) {
      hostApi.emitEvent("meeting.error", {
        sessionId,
        reason: `stt-key-unavailable:${handle.reason}`,
      });
      throw new Error(`Cannot start meeting: STT key unavailable (${handle.reason})`);
    }
    if (handle.exposure !== "lease") {
      await handle.release();
      throw new Error("Cannot start meeting: host returned raw credential for lease request");
    }

    // Auto-release: when the session signal fires, release the host lease.
    // release() is idempotent and a session abort ends this lease's lifetime.
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      const task = Promise.resolve().then(() => handle.release())
        .catch(() => { /* cleanup cannot recover an aborted session */ });
      let pending = pendingSttLeaseReleases.get(sessionId);
      if (!pending) {
        pending = new Set();
        pendingSttLeaseReleases.set(sessionId, pending);
      }
      pending.add(task);
      void task.then(() => {
        pending!.delete(task);
        if (pending!.size === 0 && pendingSttLeaseReleases.get(sessionId) === pending) {
          pendingSttLeaseReleases.delete(sessionId);
        }
      });
    };
    if (signal.aborted) {
      releaseOnce();
      await waitForSttLeaseRelease(sessionId);
      throw new Error("Meeting STT session aborted");
    }
    signal.addEventListener("abort", releaseOnce, { once: true });

    // Host inherit: when the host resolveApiKey handle exposes a baseUrl
    // (for example an Azure AI Foundry private endpoint), prefer that endpoint
    // over plugin-configured sttBaseUrl. The host key and endpoint are a pair;
    // mixing a host key with a stale plugin endpoint can fail against private resources.
    let effectiveBaseUrl = sttBaseUrl;
    if (handle.baseUrl) {
      const validated = validateSttBaseUrl(handle.baseUrl);
      if (validated.ok) {
        effectiveBaseUrl = normalizeKnownSttEndpoint(validated.url, sttModel);
      } else {
        hostApi.logEvent?.("warn", "meeting_stt_handle_base_url_rejected", {
          error: validated.error,
          preview: sanitizePreview(handle.baseUrl),
        });
        releaseOnce();
        await waitForSttLeaseRelease(sessionId);
        throw new Error(`Cannot start meeting: host STT endpoint invalid (${validated.error})`);
      }
    }

    try {
      return makeProvider({ lease: handle }, effectiveBaseUrl, "host");
    } catch (err) {
      releaseOnce();
      await waitForSttLeaseRelease(sessionId);
      throw err;
    }
  }

  const pipeline = new MeetingPipeline({
    // Per-session factory: resolves the STT key + provider at first ingest,
    // wires AbortController into Whisper fetch, releases on stop.
    sttProviderFactory,
    summaryProvider,
    intermediateEveryFinalSegments,
    intermediateMinIntervalMs,
    uploadIntermediateSummaryBudget,
    intermediateSummariesEnabled,
    defaultLengthTier: summaryLengthTier,
    sttRetryAttempts: 3,
    summaryRetryAttempts: 2,
    log,
    onSessionUpdate: (session) => {
      sessionStore.save({
        sessionId: session.sessionId,
        context: session.context,
        transcript: session.transcript,
        intermediateSummaries: session.intermediateSummaries,
        finalized: session.finalized,
        category: normalizeProvidedCategory(session.context?.category) ?? undefined,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      });
    },
  });

  async function releaseSessionStt(sessionId: string): Promise<void> {
    await pipeline.abortSessionAndWait(sessionId);
    await waitForSttLeaseRelease(sessionId);
  }

  // Crash recovery. Cap at ORPHAN_RECOVERY_LIMIT most-recent unfinished
  // sessions so a user who has accumulated many never-finished orphans
  // (e.g. repeated app kills, abandoned recordings) doesn't pay the full
  // transcript-in-RAM cost for every one on every plugin startup. Excess
  // orphans remain on disk untouched — they're skipped, not deleted, so
  // the user can still hand-recover one if needed by clearing newer
  // entries. The recency sort lives in SessionStore.listUnfinished.
  const ORPHAN_RECOVERY_LIMIT = 50;
  const unfinished = sessionStore.listUnfinished();
  const toRecover = unfinished.slice(0, ORPHAN_RECOVERY_LIMIT);
  if (unfinished.length > toRecover.length) {
    log(
      `crash-recovery cap: ${unfinished.length - toRecover.length} older orphan(s) skipped (limit=${ORPHAN_RECOVERY_LIMIT})`,
    );
  }
  for (const session of toRecover) {
    pipeline.restoreSession(session);
    log(`recovered session: ${session.sessionId} (${session.transcript.length} segments)`);
  }

  const recorder = new ElectronMeetingRecorder(pipeline);
  const pushChunkLimiter = new PushChunkRateLimiter();
  const activeSessions = new Set<string>();
  const stagedUploads = new Map<string, StagedUploadState>();
  /**
   * The mediated spawn, or a refusal.
   *
   * Read at the CALL SITE rather than captured once at activation, so a host
   * that publishes the member gets it and one that does not gets a message
   * naming the version rather than a `TypeError`. There is no other branch on
   * purpose: reaching for `child_process.spawn` here would restore the ambient
   * reach the member exists to remove, on exactly the hosts least able to
   * contain it.
   */
  /**
   * The mediated egress, or a refusal — the same shape as
   * {@link requireSpawnWorker} and for the same reason. A direct-socket branch
   * here would be direct egress, which is the whole of ambient axis 1.
   */
  function requireHostFetch(): NonNullable<HostPluginContext["hostApi"]["hostFetch"]> {
    const hostFetch = hostApi.hostFetch;
    if (!hostFetch) {
      throw new Error(
        "[meeting] requires a host with hostApi.hostFetch to install the FFmpeg runtime; host-mediated egress is not optional.",
      );
    }
    return hostFetch.bind(hostApi);
  }

  /**
   * Opening a link in the user's browser, through the host.
   *
   * The plugin used to reach `shell.openExternal` by resolving the `electron`
   * specifier at runtime, which is ambient axis 2 — Electron's main-process
   * API by any resolution path — and the axis that keeps this plugin from
   * being confined. `hostApi.openExternalUrl` has been the mediated form all
   * along; this plugin simply was not using it.
   */
  function requireOpenExternalUrl(): NonNullable<HostPluginContext["hostApi"]["openExternalUrl"]> {
    const openExternalUrl = hostApi.openExternalUrl;
    if (!openExternalUrl) {
      throw new Error(
        "[meeting] requires a host with hostApi.openExternalUrl to open a link; reaching Electron's shell directly is not an option.",
      );
    }
    return openExternalUrl.bind(hostApi);
  }

  function requireSpawnWorker(): NonNullable<HostPluginContext["hostApi"]["spawnWorker"]> {
    const spawnWorker = hostApi.spawnWorker;
    if (!spawnWorker) {
      throw new Error(
        "[meeting] requires a host with the spawnWorker capability to run FFmpeg. Please update Ave.",
      );
    }
    return spawnWorker.bind(hostApi);
  }

  const stagedUploadsDir = stagedUploadRoot(context.pluginDataDir);
  cleanupStaleStagedUploadDirs(stagedUploadsDir);
  const stagedUploadTtlTimer = setInterval(() => cleanupStaleStagedUploads(), Math.min(5 * 60 * 1000, STAGED_UPLOAD_TTL_MS));
  stagedUploadTtlTimer.unref?.();
  const finalBySession = new Map<
    string,
    { title: string; summary: string; highlights: string[]; actionItems: string[]; createdAt: string; lengthTier?: import("./types.js").SummaryLengthTier }
  >();
  // Per-session lengthTier override carried from the recorder card's initial
  // context (or the meeting_start / batch_processing_audio payload). Used by
  // meeting_stop to thread the tier through to recorder.stop when the caller
  // didn't supply one.
  const sessionLengthTier = new Map<string, import("./types.js").SummaryLengthTier>();

  // In-flight stop dedup. The floating window's Done button and an LLM
  // tool call (meeting_stop) can both fire within milliseconds. Without
  // this guard the second caller's recorder.stop() hits
  // pipeline.assertNotFinalized() and throws, surfacing as
  // {ok:false,error:...} even though the stop is in fact succeeding. By
  // sharing a deferred Promise, the second caller waits for the first
  // to complete and then enters the idempotency replay path with a
  // populated finalBySession / persisted finalSummary.
  const stopInflight = new Map<string, Promise<void>>();
  // Last prep context pushed via meeting_open_prep — kept as an
  // in-memory "last opened" pointer so the UI can prefer that exact context
  // on view entry. The prep records themselves are persisted through
  // PrepStore and meeting_get_prep falls back to the nearest stored
  // prep when this pointer is empty.
  let lastPrep: MeetingContext | null = null;

  /**
   * The recorder's slot in the host's floating dock, or null when none is up.
   *
   * ONE, not a map. It replaces a `Map<sessionId, BrowserWindow>` that could
   * never have held two useful entries: the host permits a single audio
   * capture at a time, so a second recorder would be a card watching a
   * recording that could not start. Singular here is not a narrowing — it is
   * the constraint the audio layer already enforced, finally stated.
   *
   * It is also the ACL. The old IPC handlers resolved the caller's session
   * from the sender's `webContents.id`, so a window could only ever touch its
   * own recording. Tool calls carry no sender, so the same rule is kept the
   * only way that still holds: every recorder tool acts on THIS session and
   * ignores any sessionId in its arguments.
   */
  let recorderPanel: {
    sessionId: string;
    context?: MeetingContext;
    handle: FloatingPanelHandle;
  } | null = null;
  // Per-session waveform peak ring — populated by the recorder window's
  // push-chunk IPC. The recorder window's AudioWorklet emits PCM16; we
  // compute per-100ms peak amplitudes and keep the last ~10s for the UI
  // waveform poll.
  const PEAK_RING_MAX = 100;          // ~10s of 100ms peaks
  const PEAK_WINDOW_SAMPLES = 1600;   // 100ms @ 16kHz mono
  const floatingPeakRings = new Map<string, { peaks: number[] }>();
  /**
   * The host capture behind each recording, and the chunker fed by it.
   *
   * Keyed by session because a capture belongs to a meeting, and ended
   * together with it — the host allows only one capture at a time, so a leak
   * here does not merely waste a handle, it blocks the next recording.
   */
  const sessionCaptures = new Map<string, { capture: AudioCaptureHandle; chunker: AudioChunker }>();
  /**
   * Recordings the user has paused.
   *
   * Frames keep ARRIVING while paused — the host capture stays open, because
   * stopping and restarting it would drop the microphone permission prompt and
   * the loopback wiring into the middle of a meeting — but they are not fed to
   * the chunker, so the paused span never reaches the transcript.
   */
  const pausedSessions = new Set<string>();

  /**
   * Frame length asked of the host.
   *
   * 50 ms, because silence is measured PER FRAME and the chunker needs a run
   * of 0.5 s to call a pause a pause. Ten frames to that decision is enough
   * resolution not to cut mid-word; a longer frame would make the silence tail
   * coarse enough to slice one.
   */
  const CAPTURE_FRAME_MS = 50;

  /** Feed one chunk into the pipeline, and record why if it does not land. */
  /**
   * The last chunk-ingest failure per session, or nothing when the last chunk
   * went through.
   *
   * The recorder card shows a banner for these — a 429 from the STT provider
   * is the difference between a meeting being transcribed and a meeting
   * quietly not being transcribed, and the user has minutes in which acting on
   * it still helps. The window used to learn about it from the failure
   * response to its own `push-chunk` call; it does not push chunks any more,
   * so the fact is held here and read back through the levels poll the card
   * already runs at the rate chunks arrive.
   */
  const lastIngestError = new Map<string, string>();

  async function ingestCapturedChunk(sessionId: string, chunk: CapturedAudioChunk): Promise<void> {
    try {
      await pipeline.ingestAudioChunk(sessionId, chunk);
      lastIngestError.delete(sessionId);
    } catch (err) {
      lastIngestError.set(sessionId, (err as Error).message);
      hostApi.logEvent?.("warn", "meeting-capture.ingest_failed", {
        sessionId,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Start the host capture for a recording and wire its frames to the pipeline.
   *
   * Throws when the host does not publish the capability. That refusal is the
   * point: the alternative is the recorder window capturing for itself, which
   * is a renderer outside the sandbox — the ambient reach this whole migration
   * exists to give up.
   */
  async function beginSessionCapture(
    sessionId: string,
    opts: { systemAudio: boolean; microphoneDeviceId?: string },
  ): Promise<void> {
    if (sessionCaptures.has(sessionId)) return;
    const start = hostApi.startAudioCapture;
    if (!start) {
      throw new Error(
        "[meeting] this host does not provide hostApi.startAudioCapture "
          + "Recording needs host-owned audio capture; please update Ave.",
      );
    }
    const chunker = createAudioChunker(LOOPBACK_SAMPLE_RATE);
    const capture = await start.call(hostApi, {
      sampleRate: LOOPBACK_SAMPLE_RATE,
      frameMs: CAPTURE_FRAME_MS,
      microphone: true,
      systemAudio: opts.systemAudio,
      ...(opts.microphoneDeviceId ? { microphoneDeviceId: opts.microphoneDeviceId } : {}),
    });
    sessionCaptures.set(sessionId, { capture, chunker });

    capture.onFrame((frame) => {
      // The waveform the floating window polls. Fed from the frame rather than
      // from the chunk so the meter moves at capture rate instead of jumping
      // once every few seconds.
      const ring = floatingPeakRings.get(sessionId) ?? { peaks: [] as number[] };
      ring.peaks.push(frame.peak);
      while (ring.peaks.length > PEAK_RING_MAX) ring.peaks.shift();
      floatingPeakRings.set(sessionId, ring);

      // The waveform keeps moving while paused — the user can see the room is
      // still noisy — but the audio is not recorded.
      if (pausedSessions.has(sessionId)) return;
      for (const chunk of chunker.push(frame.pcm, frame.peak)) {
        void ingestCapturedChunk(sessionId, chunk);
      }
    });
    capture.onEnd((end) => {
      if (end.reason === "stopped") return;
      // A capture that ended on its own means the recording is now silent and
      // nothing else would say so. Reported rather than swallowed: a meeting
      // that quietly stops recording halfway is the worst outcome here.
      hostApi.logEvent?.("warn", "meeting-capture.ended_unexpectedly", {
        sessionId,
        reason: end.reason,
        detail: end.detail,
      });
      hostApi.emitEvent("meeting.error", {
        sessionId,
        error: `audio capture ended: ${end.reason}${end.detail ? ` (${end.detail})` : ""}`,
      });
    });
  }

  /**
   * End the capture for a recording, flushing whatever it still held.
   *
   * `flush` is false when the recording is being thrown away — a cancelled
   * meeting has no use for its last two seconds, and ingesting them would
   * start transcription work for a session about to be deleted.
   */
  async function endSessionCapture(sessionId: string, opts: { flush: boolean }): Promise<void> {
    const entry = sessionCaptures.get(sessionId);
    if (!entry) return;
    sessionCaptures.delete(sessionId);
    pausedSessions.delete(sessionId);
    try {
      await entry.capture.stop();
    } catch (err) {
      hostApi.logEvent?.("warn", "meeting-capture.stop_failed", {
        sessionId,
        error: (err as Error).message,
      });
    }
    if (!opts.flush) return;
    const tail = entry.chunker.final();
    // A recording rarely ends on a chunk boundary, so without this the last
    // seconds of every meeting would be missing from the transcript.
    if (tail) await ingestCapturedChunk(sessionId, tail);
  }
  /*
   * No `deliberateWindowClosures` set and no per-window init map.
   *
   * The first existed because a window's `closed` event cannot say who closed
   * it, so a side-channel had to remember. `onDetached` carries a
   * `DetachReason`, which is the same fact as data — and data that cannot go
   * stale if a teardown path forgets to write it.
   *
   * The second keyed an init payload by `webContents.id` so the renderer could
   * pull its own sessionId. The card asks `meeting_recorder_state` instead.
   */

  /*
   * No theme relay. The recorder card is served by the host's plugin UI shell,
   * the same one a sidebar card gets, and that shell already primes and
   * subscribes theme. Pushing tokens down a private channel as well would give
   * the card two sources for one value, and the one this plugin controls is
   * the one that can be stale.
   */

  /**
   * Take the recorder's slot out of the dock.
   *
   * `opts.cancelOnClosed` is gone with the window it described. A deliberate
   * teardown reaches `onDetached` as `"requested"`, and the orphan paths reach
   * it as `"user-closed"` or `"renderer-gone"`; the handler below reads the
   * reason instead of consulting a set this function had to remember to write.
   */
  function detachRecorderPanel(sessionId: string): void {
    // Unconditionally, and before anything else. The host allows ONE capture
    // at a time, so a capture left running by a closed card does not merely
    // leak — it blocks every later recording, and nothing would say why. When
    // the session already stopped cleanly this is a no-op.
    void endSessionCapture(sessionId, { flush: false }).catch(() => { /* teardown */ });
    const panel = recorderPanel;
    if (!panel || panel.sessionId !== sessionId) return;
    // Cleared BEFORE the await. `detach()` resolves after the host has torn
    // the slot down and fired `onDetached`, and that handler checks whether a
    // panel is still registered — leaving this set would have it read a
    // deliberate detach as an orphaned recording and cancel the session.
    recorderPanel = null;
    void panel.handle.detach().catch((err: unknown) => {
      hostApi.logEvent?.("warn", "meeting.recorder_panel.detach_failed", {
        sessionId,
        error: (err as Error).message,
      });
    });
  }

  /**
   * Treat an unexpected window teardown (X close, render-process-gone,
   * webContents crash) as a recovery point rather than an automatic
   * cancellation:
   *
   * - If the session already accumulated transcript segments, PRESERVE
   *   them. The recorded audio cost real time and a Whisper bill — the
   *   user can re-open the session in the sidebar and click "지금 회의록
   *   생성" to backfill the LLM summary later. Without this, accidentally
   *   closing the floating window deletes everything (a real loss
   *   reported as "녹음 다 했는데 회의록 비어있음").
   *
   * - If the transcript is empty (most often: every STT call failed —
   *   e.g. OpenAI 429 quota error — so no segments ever landed), keep
   *   the old "delete the orphan" behaviour. An empty record has no
   *   recovery value and would just clutter the list.
   */
  function cancelOrphanedSession(sessionId: string, reason: string): void {
    if (!activeSessions.has(sessionId)) return;

    const session = pipeline.getSession(sessionId);
    const segmentCount = session?.transcript?.length ?? 0;
    const persisted = sessionStore.load(sessionId);

    if (segmentCount > 0 || (persisted?.transcript?.length ?? 0) > 0) {
      // Preserve. Mark finalized=true so the session appears in
      // listFinished() / 회의록 list with the regenerate button.
      const base = persisted ?? (session
        ? {
            sessionId,
            context: session.context,
            transcript: [...session.transcript],
            intermediateSummaries: session.intermediateSummaries,
            finalized: false,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
          }
        : null);
      if (base) {
        try {
          sessionStore.save({
            ...base,
            finalized: true,
            updatedAt: new Date().toISOString(),
          });
        } catch (err) {
          hostApi.logEvent?.("warn", "meeting.orphan_preserve_failed", {
            sessionId, error: (err as Error).message,
          });
        }
      }
      try { pipeline.resetSession(sessionId); } catch { /* noop */ }
      activeSessions.delete(sessionId);
      finalBySession.delete(sessionId);
      floatingPeakRings.delete(sessionId);
      lastIngestError.delete(sessionId);
      sessionLengthTier.delete(sessionId);
      pushChunkLimiter.forget(sessionId);
      hostApi.emitEvent("meeting.ended", {
        sessionId,
        cancelled: true,
        reason,
        preservedSegments: (base?.transcript?.length ?? 0),
      });
      hostApi.logEvent?.("info", "meeting.orphan_preserved", {
        sessionId,
        reason,
        segments: base?.transcript?.length ?? 0,
      });
      return;
    }

    // Empty-transcript orphan — original cleanup path.
    try { pipeline.resetSession(sessionId); } catch { /* noop */ }
    try { sessionStore.delete(sessionId); } catch { /* noop */ }
    activeSessions.delete(sessionId);
    finalBySession.delete(sessionId);
    floatingPeakRings.delete(sessionId);
    lastIngestError.delete(sessionId);
    sessionLengthTier.delete(sessionId);
    pushChunkLimiter.forget(sessionId);
    hostApi.emitEvent("meeting.ended", { sessionId, cancelled: true, reason });
    hostApi.logEvent?.("warn", "meeting.orphan_cancelled", { sessionId, reason });
  }



  function cleanupStagedUpload(uploadId: string, opts: { abort?: boolean; reason?: string } = {}): void {
    const state = stagedUploads.get(uploadId);
    if (!state) return;
    stagedUploads.delete(uploadId);
    if (opts.abort) {
      try { state.abortController?.abort(); } catch { /* best-effort */ }
      try { pipeline.abortSession(state.sessionId); } catch { /* best-effort */ }
      hostApi.logEvent?.("warn", "meeting_stage_upload.cancelled", {
        sessionId: state.sessionId,
        uploadId,
        reason: opts.reason ?? "cleanup",
        status: state.status,
      });
    }
    try {
      rmSync(state.dir, { recursive: true, force: true });
    } catch {
      // Best-effort temp cleanup only.
    }
  }

  function cleanupStaleStagedUploads(now = Date.now()): void {
    for (const [uploadId, state] of stagedUploads) {
      if (state.status !== "receiving") continue;
      if (now - state.lastActivityAt <= STAGED_UPLOAD_TTL_MS) continue;
      cleanupStagedUpload(uploadId, { abort: true, reason: "ttl-expired" });
    }
    const protectedDirs = new Set([...stagedUploads.values()].map((state) => state.dir));
    const removedDirs = cleanupStaleStagedUploadDirs(stagedUploadsDir, now, protectedDirs);
    if (removedDirs > 0) {
      hostApi.logEvent?.("info", "meeting_stage_upload.tmp_sweep", { removedDirs });
    }
  }

  function hasStagedUploadForSession(sessionId: string): boolean {
    for (const state of stagedUploads.values()) {
      if (state.sessionId === sessionId) return true;
    }
    return false;
  }

  async function runStagedUploadSession(state: StagedUploadState) {
    try {
      await requireFfmpegRuntime();
      throwIfStagedUploadAborted(state);

      recorder.start(state.sessionId, state.context);
      activeSessions.add(state.sessionId);
      hostApi.emitEvent("meeting.started", { sessionId: state.sessionId, mode: "upload" });
      hostApi.logEvent?.("info", "meeting_stage_upload.finish.start", {
        sessionId: state.sessionId,
        uploadId: state.uploadId,
        bytes: state.receivedBytes,
        fileName: state.fileName,
      });

      throwIfStagedUploadAborted(state);
      const durationSec = await runFfprobeDurationSec(state.inputPath, {
        workerId: ffmpegWorkerId("ffprobe", state.workerSlot),
        spawnWorker: requireSpawnWorker(),
        signal: state.abortController?.signal,
        timeoutMs: STAGED_UPLOAD_FFPROBE_TIMEOUT_MS,
      });
      if (durationSec > STAGED_UPLOAD_MAX_DURATION_SEC) {
        throw new Error(`재생 길이가 4시간을 초과합니다 (${Math.round(durationSec)}s)`);
      }
      hostApi.logEvent?.("info", "meeting_stage_upload.probed", {
        sessionId: state.sessionId,
        uploadId: state.uploadId,
        durationSec: Math.round(durationSec),
      });

      mkdirSync(state.segmentDir, { recursive: true });
      throwIfStagedUploadAborted(state);
      await runFfmpegSegmenter(state.inputPath, join(state.segmentDir, "segment-%05d.wav"), {
        workerId: ffmpegWorkerId("ffmpeg", state.workerSlot),
        spawnWorker: requireSpawnWorker(),
        signal: state.abortController?.signal,
        timeoutMs: STAGED_UPLOAD_FFMPEG_TIMEOUT_MS,
      });
      try { unlinkSync(state.inputPath); } catch { /* best-effort: final dir cleanup remains */ }

      const segmentFiles = readdirSync(state.segmentDir)
        .filter((name) => /^segment-\d+\.wav$/.test(name))
        .sort();
      if (segmentFiles.length === 0) {
        throw new Error("ffmpeg produced no audio segments");
      }

      let startOffsetSec = 0;
      for (let i = 0; i < segmentFiles.length; i++) {
        throwIfStagedUploadAborted(state);
        const filePath = join(state.segmentDir, segmentFiles[i] ?? "");
        const segmentSize = statSync(filePath).size;
        if (segmentSize > STT_AUDIO_MAX_BYTES) {
          throw new Error(`file-too-large: segmented audio exceeds ${STT_AUDIO_MAX_BYTES} bytes`);
        }
        const bytes = readFileSync(filePath);
        if (bytes.length === 0) {
          try { unlinkSync(filePath); } catch { /* best-effort */ }
          continue;
        }
        const segmentDurationSec = parsePcmWavDurationSec(bytes);
        await pipeline.ingestAudioFile(state.sessionId, {
          bytes,
          mimeType: STAGED_SEGMENT_MIME,
          fileName: segmentFileName(state.fileName, i),
          startOffsetSec,
          durationSec: segmentDurationSec,
        });
        startOffsetSec += segmentDurationSec;
        try { unlinkSync(filePath); } catch { /* best-effort: final dir cleanup remains */ }
      }

      throwIfStagedUploadAborted(state);
      await recorder.stop(state.sessionId, {
        ...(state.lengthTier ? { lengthTier: state.lengthTier } : {}),
        signal: state.abortController?.signal,
      });
      await releaseSessionStt(state.sessionId);
      throwIfStagedUploadAborted(state);
      activeSessions.delete(state.sessionId);
      pushChunkLimiter.forget(state.sessionId);
      hostApi.emitEvent("meeting.ended", { sessionId: state.sessionId });

      const final = finalBySession.get(state.sessionId);
      if (!final) throw new Error(`final summary not found: ${state.sessionId}`);

      const persisted = sessionStore.load(state.sessionId);
      if (persisted) {
        sessionStore.save({ ...persisted, finalSummary: final });
      }
      finalBySession.delete(state.sessionId);

      const transcript = pipeline.getTranscript(state.sessionId);
      try { pipeline.resetSession(state.sessionId); } catch { /* best-effort */ }

      hostApi.logEvent?.("info", "meeting_stage_upload.finish.done", {
        sessionId: state.sessionId,
        uploadId: state.uploadId,
        segments: segmentFiles.length,
      });

      return {
        sessionId: state.sessionId,
        mode: "upload" as const,
        transcript,
        finalSummary: final,
      };
    } catch (err) {
      activeSessions.delete(state.sessionId);
      pushChunkLimiter.forget(state.sessionId);

      try {
        finalBySession.delete(state.sessionId);
      } catch {
        // Best-effort cleanup only; preserve the original failure.
      }

      try {
        (
          pipeline as { resetSession?: (sessionId: string) => void | Promise<void> }
        ).resetSession?.(state.sessionId);
      } catch {
        // Best-effort cleanup only; preserve the original failure.
      }
      await releaseSessionStt(state.sessionId);

      try {
        (sessionStore as { delete?: (sessionId: string) => void }).delete?.(state.sessionId);
      } catch {
        // Best-effort cleanup only; preserve the original failure.
      }

      hostApi.emitEvent("meeting.error", {
        sessionId: state.sessionId,
        error: (err as Error).message,
      });
      hostApi.emitEvent("meeting.ended", {
        sessionId: state.sessionId,
        cancelled: true,
      });
      if (err instanceof Error && err.message.startsWith("file-too-large:")) {
        return { ok: false, error: "file-too-large" as const, maxBytes: STT_AUDIO_MAX_BYTES };
      }
      throw err;
    } finally {
      cleanupStagedUpload(state.uploadId);
    }
  }

  async function cleanupRuntime(reason: string, finalizeActive: boolean): Promise<void> {
    clearInterval(stagedUploadTtlTimer);
    if (recorderPanel) detachRecorderPanel(recorderPanel.sessionId);
    for (const uploadId of [...stagedUploads.keys()]) {
      cleanupStagedUpload(uploadId, { abort: true, reason });
    }
    for (const sessionId of [...activeSessions]) {
      if (finalizeActive) {
        try {
          await recorder.stop(sessionId);
          hostApi.logEvent?.("info", "meeting.shutdown.session_stopped", { sessionId });
        } catch (err) {
          hostApi.logEvent?.("error", "meeting.shutdown.stop_failed", {
            sessionId,
            error: (err as Error).message,
          });
        } finally {
          await releaseSessionStt(sessionId);
        }
      } else {
        cancelOrphanedSession(sessionId, reason);
        await releaseSessionStt(sessionId);
      }
    }
    activeSessions.clear();
    finalBySession.clear();
    floatingPeakRings.clear();
    lastIngestError.clear();
    sessionLengthTier.clear();
    lastPrep = null;
  }

  /**
   * The recorder card's tools.
   *
   * Every one of these was an `ipcMain.handle("meeting-floating:…")` this
   * plugin registered for itself — a private channel, reachable only because
   * the plugin held `ipcMain`. They are ordinary tools now, reached over the
   * bridge every plugin card already has, so the host sees each call the way
   * it sees any other tool invocation and nothing here needs a channel.
   *
   * None of them appear in the model's tool list: the manifest marks them
   * `_meta.ui.visibility: ["app"]`. Enumerating microphones is something this
   * card needs and nothing an assistant should be choosing to do.
   *
   * THE SESSION IS NEVER AN ARGUMENT. The IPC handlers resolved it from the
   * sender's `webContents.id` and ignored any sessionId in the payload,
   * because honouring one would have let a window read another window's
   * recording. A tool call has no sender, so the rule is kept by there being
   * exactly one recorder panel: these act on `recorderPanel.sessionId` or they
   * refuse.
   */
  function requireRecorderSession(): string | null {
    return recorderPanel?.sessionId ?? null;
  }

  /**
   * Rate limit for `meeting_recorder_levels`. The card polls at 10Hz; a 200/sec
   * ceiling leaves 20x headroom and still catches a runaway poll loop.
   *
   * One bucket, not one per session, because there is one panel. The old
   * per-session map was keyed that way so concurrent floating windows could not
   * starve each other, and concurrent floating windows no longer exist.
   */
  const audioLevelsLimiter = (() => {
    const REFILL_PER_SEC = 200;
    const BUCKET_SIZE = 200;
    let tokens = BUCKET_SIZE;
    let refilledAt = Date.now();
    return {
      allow(): boolean {
        const now = Date.now();
        tokens = Math.min(BUCKET_SIZE, tokens + ((now - refilledAt) / 1000) * REFILL_PER_SEC);
        refilledAt = now;
        if (tokens < 1) return false;
        tokens -= 1;
        return true;
      },
    };
  })();

  /**
   * Begin capturing for the attached panel's session.
   *
   * Distinct from `meeting_start`, which is what ATTACHES the card. Two calls
   * because they are two moments: the card cannot ask for audio before it
   * exists, and collapsing them would have the card re-enter the tool that
   * created it.
   */
  const recorderBeginCapture = async (payload?: unknown) => {
    const sid = requireRecorderSession();
    if (!sid) return { ok: false, mode: "mic" as const, fallbackReason: "unauthorized" };
    const ctx = (payload && typeof payload === "object" ? payload : {}) as {
      context?: MeetingContext & { lengthTier?: unknown };
      lengthTier?: unknown;
      captureMode?: unknown;
      micId?: unknown;
    };
    // The card's own preference, which used to decide this inside the renderer
    // because that is where the capture happened. It crosses as a string now —
    // the card states what it wants and the host opens it.
    const wantsSystemAudio = ctx.captureMode !== "mic-only";
    const micId = typeof ctx.micId === "string" ? ctx.micId : undefined;
    const startTier = pickLengthTier(ctx.lengthTier) ?? pickLengthTier(ctx.context?.lengthTier);
    if (startTier) sessionLengthTier.set(sid, startTier);
    if (!activeSessions.has(sid)) {
      try {
        recorder.start(sid, ctx.context ?? recorderPanel?.context);
        activeSessions.add(sid);
        hostApi.emitEvent("meeting.started", { sessionId: sid, mode: "floating" });
        hostApi.logEvent?.("info", "meeting_recorder_begin_capture", { sessionId: sid });
      } catch (err) {
        return { ok: false, mode: "mic" as const, fallbackReason: (err as Error).message };
      }
      try {
        await beginSessionCapture(sid, { systemAudio: wantsSystemAudio, microphoneDeviceId: micId });
      } catch (err) {
        // The recording cannot proceed without audio, so it does not: the
        // session is torn back down rather than left open recording nothing.
        activeSessions.delete(sid);
        try { pipeline.resetSession(sid); } catch { /* best-effort */ }
        return { ok: false, mode: "mic" as const, fallbackReason: (err as Error).message };
      }
    }
    // The mode REPORTED is the one that actually opened. Saying "loopback"
    // unconditionally — which is what this used to do — labelled a
    // microphone-only recording as a full one whenever system audio was
    // unavailable, and nothing downstream could tell.
    const opened = sessionCaptures.get(sid)?.capture.opened;
    return { ok: true, mode: opened?.systemAudio === true ? ("loopback" as const) : ("mic" as const) };
  };

  /** What session this card is showing, and the context it was attached with. */
  const recorderState = async () => {
    const panel = recorderPanel;
    if (!panel) return null;
    return { sessionId: panel.sessionId, context: panel.context };
  };

  /**
   * Waveform peaks, and whether the last chunk reached the transcriber.
   *
   * `sttError` rides along rather than getting a tool of its own because the
   * card polls this at the rate chunks arrive — a second poll for the same
   * moment would be two round trips telling one story, and they could disagree
   * about which chunk they described.
   */
  const recorderLevels = async () => {
    const sid = requireRecorderSession();
    if (!sid) return { peaks: [] };
    if (!audioLevelsLimiter.allow()) return { peaks: [] };
    const wav = floatingPeakRings.get(sid);
    const sttError = lastIngestError.get(sid);
    return { peaks: wav ? [...wav.peaks] : [], ...(sttError ? { sttError } : {}) };
  };

  /**
   * The microphones the user can pick from, as the HOST sees them.
   *
   * The card used to call `enumerateDevices()` itself, which it could only do
   * because it was capturing. The host owns the capture and therefore the
   * device list, and the card asks for it.
   */
  const recorderMicrophones = async () => {
    if (!requireRecorderSession()) return { devices: [] };
    const list = hostApi.listAudioInputDevices;
    if (!list) return { devices: [] };
    try {
      return { devices: await list.call(hostApi) };
    } catch (err) {
      hostApi.logEvent?.("warn", "meeting_recorder_microphones failed", {
        error: (err as Error).message,
      });
      return { devices: [] };
    }
  };

  const recorderSetPaused = async (payload?: unknown) => {
    const sid = requireRecorderSession();
    if (!sid) return { ok: false, error: "unauthorized" };
    const paused = (payload as { paused?: unknown } | undefined)?.paused === true;
    if (paused) pausedSessions.add(sid);
    else pausedSessions.delete(sid);
    return { ok: true, paused };
  };

  /**
   * Swap microphone or capture mode mid-recording.
   *
   * The chunker is NOT rebuilt: `endSessionCapture` flushes what it held and
   * the new capture starts a fresh one, so the transcript's time axis restarts
   * at zero for the new chain. That is the same behaviour the renderer had —
   * it preserved its cursor — and it is worth naming as the difference it is
   * rather than leaving it to be discovered.
   */
  const recorderRestartCapture = async (payload?: unknown) => {
    const sid = requireRecorderSession();
    if (!sid) return { ok: false, error: "unauthorized" };
    if (!activeSessions.has(sid)) return { ok: false, error: "not recording" };
    const body = (payload && typeof payload === "object" ? payload : {}) as {
      captureMode?: unknown;
      micId?: unknown;
    };
    await endSessionCapture(sid, { flush: true });
    try {
      await beginSessionCapture(sid, {
        systemAudio: body.captureMode !== "mic-only",
        ...(typeof body.micId === "string" && body.micId ? { microphoneDeviceId: body.micId } : {}),
      });
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    const opened = sessionCaptures.get(sid)?.capture.opened;
    return { ok: true, mode: opened?.systemAudio === true ? "loopback" : "mic" };
  };

  /**
   * The card measured its content and would like more room.
   *
   * It ASKS. Everything this used to compute itself — the clamp, the width,
   * where on the screen the window sits so growth does not push it off the
   * bottom edge — belongs to the dock now, and the number that comes back is
   * what the host applied, not what was requested.
   */
  const recorderResize = async (payload?: unknown) => {
    const panel = recorderPanel;
    if (!panel) return { ok: false, error: "unauthorized" };
    const body = (payload && typeof payload === "object" ? payload : {}) as { height?: unknown };
    const raw = typeof body.height === "number" ? body.height : NaN;
    if (!Number.isFinite(raw)) return { ok: false, error: "invalid-height" };
    try {
      const height = await panel.handle.resize(Math.round(raw));
      return { ok: true, height };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  };

  /**
   * Close the card.
   *
   * `cancelOnClosed` is gone: this IS the deliberate path, and the reason the
   * detach handler sees will say so. An orphaned recording reaches that
   * handler through `user-closed` / `renderer-gone` instead.
   */
  const recorderClose = async () => {
    const sid = requireRecorderSession();
    if (sid) detachRecorderPanel(sid);
    return { ok: true };
  };

  log(`[meeting] STT mode: batch (REST, model=${sttModel})`);

  // ─── 이벤트 → Ave 통합 (hostApi) ────────────────

  // Per-chunk transcript streaming — delta emission (§35 / meeting#9)
  // Payload carries only the new segment index + segment object.
  // Consumers needing the full transcript must call meeting_transcript.
  recorder.on("transcript-updated", (payload) => {
    const { sessionId, newSegmentIndex, newSegment, isFinal } = payload as {
      sessionId: string;
      newSegmentIndex: number;
      newSegment: import("./types.js").TranscriptSegment | null;
      isFinal: boolean;
    };
    hostApi.emitEvent("meeting.transcript.updated", {
      meetingId: sessionId,
      newSegmentIndex,
      newSegment,
      isFinal,
    });
  });

  recorder.on("final-summary", (payload) => {
    const {
      sessionId,
      title,
      summary,
      highlights = [],
      actionItems = [],
      startedAt,
      endedAt,
      durationMs,
      participants,
      lengthTier,
    } = payload as {
      sessionId: string;
      title: string;
      summary: string;
      highlights?: string[];
      actionItems?: string[];
      startedAt: string;
      endedAt: string;
      durationMs: number;
      participants?: string[];
      lengthTier?: import("./types.js").SummaryLengthTier;
    };
    const final = { title, summary, highlights, actionItems, createdAt: new Date().toISOString(), lengthTier };
    finalBySession.set(sessionId, final);

    // Enriched payload lets calendar plugin correlate summary with
    // the right Outlook event (meeting.summary.created is the cross-plugin contract;
    // meeting.ended stays minimal).
    emitSummary({
      sessionId,
      title,
      summary,
      highlights,
      actionItems,
      startedAt,
      endedAt,
      durationMs,
      participants,
      lengthTier,
    });
  });

  recorder.on("error", ({ sessionId, error }) => {
    log(`meeting error: ${sessionId}`, error);
    hostApi.emitEvent("meeting.error", { sessionId, error: (error as Error).message });
  });

  const safePrepLogString = (value: unknown) =>
    typeof value === "string" ? value.replace(/[\r\n\0]/g, " ").slice(0, 200) : "";

  type PrepRegistrationSource =
    | "room-reservation"
    | "video-meeting"
    | "calendar-sync"
    | "manual"
    | "other";

  const normalisePrepRegistrationSource = (
    raw: unknown,
  ): PrepRegistrationSource => {
    return raw === "room-reservation"
      || raw === "video-meeting"
      || raw === "calendar-sync"
      || raw === "manual"
      || raw === "other"
      ? raw
      : "other";
  };

  const normaliseStringList = (raw: unknown): string[] | undefined => {
    if (!Array.isArray(raw)) return undefined;
    const values = raw
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return values.length > 0 ? values : undefined;
  };

  const normaliseAgendaList = (raw: unknown): string[] | undefined => {
    if (Array.isArray(raw)) return normaliseStringList(raw);
    if (typeof raw !== "string") return undefined;
    const text = raw.trim();
    if (text.length === 0) return undefined;
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
      .filter((line) => line.length > 0);
    return lines.length > 0 ? lines : [text];
  };

  const extractWebexUrlFromText = (...values: unknown[]): string | undefined => {
    for (const value of values) {
      if (typeof value !== "string" || value.length === 0) continue;
      const matches = value.match(/https:\/\/[^\s<>"'()]+/giu) ?? [];
      for (const candidate of matches) {
        const cleaned = candidate.replace(/[.,;:!?]+$/u, "");
        try {
          const parsed = new URL(cleaned);
          const host = parsed.hostname.toLowerCase();
          if (parsed.protocol === "https:" && (host === "webex.com" || host.endsWith(".webex.com"))) {
            return cleaned;
          }
        } catch {
          // keep scanning
        }
      }
    }
    return undefined;
  };

  const textForAgendaMining = (...values: unknown[]): string[] =>
    values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  const deriveAgendaFromText = (...values: unknown[]): string[] | undefined => {
    const texts = textForAgendaMining(...values);
    for (const text of texts) {
      const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const sectionIndex = lines.findIndex((line) => /(?:안건|agenda|topics?)/iu.test(line));
      if (sectionIndex >= 0) {
        const agendaLines = lines
          .slice(sectionIndex + 1)
          .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
          .filter((line) => line.length > 0 && !/^https?:\/\//iu.test(line))
          .slice(0, 50);
        if (agendaLines.length > 0) return agendaLines;
      }
      const bulletLines = lines
        .filter((line) => /^\s*(?:[-*•]|\d+[.)])\s*/u.test(line))
        .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
        .filter((line) => line.length > 0 && !/^https?:\/\//iu.test(line))
        .slice(0, 50);
      if (bulletLines.length > 0) return bulletLines;
    }
    return undefined;
  };

  const isWebexRelatedContext = (context: MeetingContext): boolean => {
    if (context.conference?.type === "webex") return true;
    return [
      context.title,
      context.description,
      context.contextHint,
      context.location,
      context.conference?.joinUrl,
    ].some((value) => typeof value === "string" && /webex/iu.test(value));
  };

  const enrichMeetingRegistrationContext = (context: MeetingContext): MeetingContext => {
    const agenda =
      Array.isArray(context.agenda) && context.agenda.length > 0
        ? context.agenda
        : deriveAgendaFromText(
          context.description,
          context.contextHint,
          context.previousSummary?.summary,
        )
          ?? (context.previousSummary?.summary
            ? ["지난 회의 요약 및 후속 조치 확인"]
            : undefined);

    let conference = context.conference;
    const webexUrl = extractWebexUrlFromText(
      conference?.joinUrl,
      context.description,
      context.contextHint,
      context.location,
    );
    if (webexUrl && (!conference?.joinUrl || conference.type !== "webex")) {
      conference = {
        ...(conference ?? {}),
        type: "webex",
        joinUrl: webexUrl,
      };
    }

    return {
      ...context,
      ...(agenda ? { agenda } : {}),
      ...(conference ? { conference } : {}),
    };
  };

  const agendaRequirementGate = (contexts: MeetingContext[]) => {
    const missing = contexts
      .map((context, index) => ({ context, index }))
      .filter(({ context }) => !Array.isArray(context.agenda) || context.agenda.length === 0);
    if (missing.length === 0) return null;
    return {
      ok: false as const,
      needsAgenda: true as const,
      missing: ["agenda"] as const,
      indexes: missing.map((item) => item.index),
      suggestions: missing.slice(0, 5).map(({ context, index }) => ({
        index,
        title: context.title,
        scheduledStart: context.scheduledStart,
      })),
      message:
        "회의 안건이 필요합니다. 메일 본문/초대장에 있는 안건 섹션이나 지난 회의 후속 조치를 바탕으로 agenda 또는 agendaText 를 전달해 주세요.",
    };
  };

  const webexUrlRequirementGate = (contexts: MeetingContext[]) => {
    const missing = contexts
      .map((context, index) => ({ context, index }))
      .filter(({ context }) => isWebexRelatedContext(context) && !extractWebexUrlFromText(context.conference?.joinUrl));
    if (missing.length === 0) return null;
    return {
      ok: false as const,
      needsWebexUrl: true as const,
      missing: ["webexUrl"] as const,
      indexes: missing.map((item) => item.index),
      suggestions: missing.slice(0, 5).map(({ context, index }) => ({
        index,
        title: context.title,
        scheduledStart: context.scheduledStart,
      })),
      message:
        "Webex 회의로 보이지만 Webex 참여 주소가 없습니다. 캘린더/메일 본문에서 https://*.webex.com/... 형태의 webexUrl 또는 conference.joinUrl 을 전달해 주세요.",
    };
  };

  const inferConferenceTypeFromUrl = (
    raw: unknown,
  ): "webex" | "zoom" | "teams" | "other" => {
    if (typeof raw !== "string" || raw.length === 0) return "other";
    try {
      const host = new URL(raw).hostname.toLowerCase();
      if (host.includes("teams.microsoft")) return "teams";
      if (host.includes("zoom.")) return "zoom";
      if (host.includes("webex.")) return "webex";
    } catch {
      return "other";
    }
    return "other";
  };

  const normaliseParticipantLabel = (raw: unknown): string | null => {
    if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as {
      name?: unknown;
      address?: unknown;
      email?: unknown;
      emailAddress?: { name?: unknown; address?: unknown };
    };
    const nestedName = obj.emailAddress?.name;
    const nestedAddress = obj.emailAddress?.address;
    const name =
      typeof obj.name === "string" && obj.name.trim().length > 0
        ? obj.name.trim()
        : typeof nestedName === "string" && nestedName.trim().length > 0
        ? nestedName.trim()
        : null;
    const address =
      typeof obj.address === "string" && obj.address.trim().length > 0
        ? obj.address.trim()
        : typeof obj.email === "string" && obj.email.trim().length > 0
        ? obj.email.trim()
        : typeof nestedAddress === "string" && nestedAddress.trim().length > 0
        ? nestedAddress.trim()
        : null;
    return name ?? address;
  };

  const normaliseOrganizerLabel = (raw: unknown): string | undefined => {
    const label = normaliseParticipantLabel(raw);
    return label ?? undefined;
  };

  const normaliseMeetingContextFromEvent = (raw: unknown): MeetingContext | null => {
    if (!raw || typeof raw !== "object") return null;
    const event = raw as {
      id?: unknown;
      subject?: unknown;
      start?: unknown;
      end?: unknown;
      location?: unknown;
      bodyText?: unknown;
      agenda?: unknown;
      agendaItems?: unknown;
      agendaText?: unknown;
      meetingAgenda?: unknown;
      todayAgenda?: unknown;
      category?: unknown;
      organizer?: unknown;
      attendees?: unknown;
      isOnlineMeeting?: unknown;
      onlineMeetingUrl?: unknown;
      joinUrl?: unknown;
      webexUrl?: unknown;
      webLink?: unknown;
      bodyPreview?: unknown;
      body?: { content?: unknown };
    };
    const organizer = normaliseOrganizerLabel(event.organizer);
    const joinUrl =
      typeof event.onlineMeetingUrl === "string" && event.onlineMeetingUrl.trim().length > 0
        ? event.onlineMeetingUrl.trim()
        : typeof event.webexUrl === "string" && event.webexUrl.trim().length > 0
        ? event.webexUrl.trim()
        : typeof event.joinUrl === "string" && event.joinUrl.trim().length > 0
        ? event.joinUrl.trim()
        : typeof event.webLink === "string" && event.webLink.trim().length > 0 && event.isOnlineMeeting === true
        ? event.webLink.trim()
        : extractWebexUrlFromText(event.bodyText, event.bodyPreview, event.body?.content) ?? "";
    const participants = Array.isArray(event.attendees)
      ? event.attendees
          .map((attendee) => normaliseParticipantLabel(attendee))
          .filter((value): value is string => typeof value === "string" && value.length > 0)
      : undefined;
    const agenda =
      normaliseAgendaList(event.agenda)
      ?? normaliseAgendaList(event.agendaItems)
      ?? normaliseAgendaList(event.agendaText)
      ?? normaliseAgendaList(event.meetingAgenda)
      ?? normaliseAgendaList(event.todayAgenda);
    return {
      ...(typeof event.id === "string" && event.id.length > 0 ? { id: event.id } : {}),
      ...(typeof event.subject === "string" && event.subject.length > 0 ? { title: event.subject } : {}),
      ...(typeof event.start === "string" && event.start.length > 0 ? { scheduledStart: event.start } : {}),
      ...(typeof event.end === "string" && event.end.length > 0 ? { scheduledEnd: event.end } : {}),
      ...(typeof event.location === "string" && event.location.length > 0 ? { location: event.location } : {}),
      ...(typeof event.bodyText === "string" && event.bodyText.length > 0
        ? { description: event.bodyText }
        : typeof event.bodyPreview === "string" && event.bodyPreview.length > 0
        ? { description: event.bodyPreview }
        : typeof event.body?.content === "string" && event.body.content.length > 0
        ? { description: event.body.content }
        : {}),
      ...(typeof event.category === "string" && event.category.length > 0 ? { category: event.category } : {}),
      ...(organizer ? { organizer } : {}),
      ...(participants && participants.length > 0 ? { participants } : {}),
      ...(agenda ? { agenda } : {}),
      ...(joinUrl.length > 0
        ? {
            conference: {
              type: inferConferenceTypeFromUrl(joinUrl),
              joinUrl,
            },
          }
        : {}),
    };
  };

  const normaliseMeetingContextFromTopLevel = (raw: unknown): MeetingContext | null => {
    if (!raw || typeof raw !== "object") return null;
    const payload = raw as {
      id?: unknown;
      title?: unknown;
      locale?: unknown;
      contextHint?: unknown;
      description?: unknown;
      category?: unknown;
      participants?: unknown;
      organizer?: unknown;
      scheduledStart?: unknown;
      scheduledEnd?: unknown;
      location?: unknown;
      conference?: unknown;
      agenda?: unknown;
      agendaItems?: unknown;
      agendaText?: unknown;
      meetingAgenda?: unknown;
      todayAgenda?: unknown;
      previousSummary?: unknown;
      joinUrl?: unknown;
      webexUrl?: unknown;
      zoomUrl?: unknown;
      teamsUrl?: unknown;
    };
    const text = (value: unknown): string | undefined =>
      typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
    const participants = normaliseStringList(payload.participants);
    const agenda =
      normaliseAgendaList(payload.agenda)
      ?? normaliseAgendaList(payload.agendaItems)
      ?? normaliseAgendaList(payload.agendaText)
      ?? normaliseAgendaList(payload.meetingAgenda)
      ?? normaliseAgendaList(payload.todayAgenda);
    const legacyJoinUrl =
      text(payload.joinUrl)
      ?? text(payload.webexUrl)
      ?? text(payload.zoomUrl)
      ?? text(payload.teamsUrl)
      ?? "";

    let conference: MeetingContext["conference"] | undefined;
    if (payload.conference && typeof payload.conference === "object") {
      const rawConference = payload.conference as {
        type?: unknown;
        joinUrl?: unknown;
        accessCode?: unknown;
        password?: unknown;
        hostDisplayName?: unknown;
      };
      const joinUrl = text(rawConference.joinUrl) ?? legacyJoinUrl;
      if (joinUrl.length > 0) {
        conference = {
          type:
            rawConference.type === "webex"
            || rawConference.type === "zoom"
            || rawConference.type === "teams"
            || rawConference.type === "other"
              ? rawConference.type
              : inferConferenceTypeFromUrl(joinUrl),
          joinUrl,
          ...(text(rawConference.accessCode) ? { accessCode: text(rawConference.accessCode) } : {}),
          ...(text(rawConference.password) ? { password: text(rawConference.password) } : {}),
          ...(text(rawConference.hostDisplayName) ? { hostDisplayName: text(rawConference.hostDisplayName) } : {}),
        };
      }
    } else if (legacyJoinUrl.length > 0) {
      conference = {
        type:
          text(payload.webexUrl) ? "webex"
          : text(payload.zoomUrl) ? "zoom"
          : text(payload.teamsUrl) ? "teams"
          : inferConferenceTypeFromUrl(legacyJoinUrl),
        joinUrl: legacyJoinUrl,
      };
    }

    const previousSummary =
      payload.previousSummary && typeof payload.previousSummary === "object"
        ? payload.previousSummary as { title?: unknown; summary?: unknown }
        : null;
    const previousSummaryText = text(previousSummary?.summary);

    const context: MeetingContext = {
      ...(text(payload.id) ? { id: text(payload.id) } : {}),
      ...(text(payload.title) ? { title: text(payload.title) } : {}),
      ...(text(payload.locale) ? { locale: text(payload.locale) } : {}),
      ...(text(payload.contextHint) ? { contextHint: text(payload.contextHint) } : {}),
      ...(text(payload.description) ? { description: text(payload.description) } : {}),
      ...(text(payload.category) ? { category: text(payload.category) } : {}),
      ...(participants ? { participants } : {}),
      ...(text(payload.organizer) ? { organizer: text(payload.organizer) } : {}),
      ...(text(payload.scheduledStart) ? { scheduledStart: text(payload.scheduledStart) } : {}),
      ...(text(payload.scheduledEnd) ? { scheduledEnd: text(payload.scheduledEnd) } : {}),
      ...(text(payload.location) ? { location: text(payload.location) } : {}),
      ...(conference ? { conference } : {}),
      ...(agenda ? { agenda } : {}),
      ...(previousSummaryText
        ? {
            previousSummary: {
              ...(text(previousSummary?.title) ? { title: text(previousSummary?.title) } : {}),
              summary: previousSummaryText,
            },
          }
        : {}),
    };

    return Object.keys(context).length > 0 ? context : null;
  };

  const resolveScheduledMeetingContext = (payload: {
    context?: MeetingContext;
    event?: unknown;
  } & Record<string, unknown>): MeetingContext => {
    if (payload.context) return enrichMeetingRegistrationContext(payload.context);
    const mapped = normaliseMeetingContextFromEvent(payload.event);
    if (mapped) return enrichMeetingRegistrationContext(mapped);
    const topLevel = normaliseMeetingContextFromTopLevel(payload);
    if (topLevel) return enrichMeetingRegistrationContext(topLevel);
    throw new Error("meeting data is required");
  };

  const resolveScheduledMeetingContexts = (payload: {
    meetings?: MeetingContext[];
    events?: unknown[];
  }): MeetingContext[] => {
    if (Array.isArray(payload.meetings)) return payload.meetings.map(enrichMeetingRegistrationContext);
    if (Array.isArray(payload.events)) {
      return payload.events.map((event) => resolveScheduledMeetingContext({ event }));
    }
    throw new Error("meetings or events must be an array");
  };

  const resolveManualMeetingContext = (payload: {
    id?: unknown;
    title?: unknown;
    scheduledStart?: unknown;
    scheduledEnd?: unknown;
    organizer?: unknown;
    description?: unknown;
    category?: unknown;
    location?: unknown;
    participants?: unknown;
    agenda?: unknown;
    agendaItems?: unknown;
    agendaText?: unknown;
    meetingAgenda?: unknown;
    todayAgenda?: unknown;
    previousSummary?: unknown;
    conference?: unknown;
    joinUrl?: unknown;
    webexUrl?: unknown;
    zoomUrl?: unknown;
    teamsUrl?: unknown;
  }): MeetingContext => {
    const title =
      typeof payload.title === "string" && payload.title.trim().length > 0
        ? payload.title.trim()
        : "";
    const scheduledStart =
      typeof payload.scheduledStart === "string" && payload.scheduledStart.trim().length > 0
        ? payload.scheduledStart.trim()
        : "";
    if (title.length === 0) {
      throw new Error("title is required");
    }
    if (scheduledStart.length === 0) {
      throw new Error("scheduledStart is required");
    }
    const scheduledEnd =
      typeof payload.scheduledEnd === "string" && payload.scheduledEnd.trim().length > 0
        ? payload.scheduledEnd.trim()
        : undefined;
    const organizer =
      typeof payload.organizer === "string" && payload.organizer.trim().length > 0
        ? payload.organizer.trim()
        : undefined;
    const description =
      typeof payload.description === "string" && payload.description.trim().length > 0
        ? payload.description.trim()
        : undefined;
    const category =
      typeof payload.category === "string" && payload.category.trim().length > 0
        ? payload.category.trim()
        : undefined;
    const location =
      typeof payload.location === "string" && payload.location.trim().length > 0
        ? payload.location.trim()
        : undefined;
    const participants = normaliseStringList(payload.participants);
    // Alias chain mirrors `meeting_register_scheduled_meeting` so LLM that
    // learned one tool's aliases doesn't fail silently on the other. Per
    // plugin-auditor parity finding.
    const agenda =
      normaliseAgendaList(payload.agenda)
      ?? normaliseAgendaList(payload.agendaItems)
      ?? normaliseAgendaList(payload.agendaText)
      ?? normaliseAgendaList(payload.meetingAgenda)
      ?? normaliseAgendaList(payload.todayAgenda);
    // Note: agenda required-ness is enforced at the handler layer (see
    // `meeting_register_manual_meeting`) so the missing-agenda case can
    // return a structured `needsAgenda` response in the same shape as
    // `needsCategorySelection` — keeps the LLM contract uniform.

    // previousSummary — same shape as MeetingContext.previousSummary.
    // Missing / malformed / array-shaped input is silently dropped.
    // `Array.isArray` guard catches `previousSummary: [...]` which would
    // otherwise pass `typeof === "object"` and reach `raw.summary` as
    // index access (resulting in undefined and silently incorrect parse).
    let previousSummary: MeetingContext["previousSummary"] | undefined;
    if (
      payload.previousSummary
      && typeof payload.previousSummary === "object"
      && !Array.isArray(payload.previousSummary)
    ) {
      const raw = payload.previousSummary as { title?: unknown; summary?: unknown };
      const summary =
        typeof raw.summary === "string" && raw.summary.trim().length > 0
          ? raw.summary.trim()
          : "";
      if (summary.length > 0) {
        const title =
          typeof raw.title === "string" && raw.title.trim().length > 0
            ? raw.title.trim()
            : undefined;
        previousSummary = title ? { title, summary } : { summary };
      }
    }

    const legacyJoinUrl =
      typeof payload.joinUrl === "string" && payload.joinUrl.trim().length > 0
        ? payload.joinUrl.trim()
        : typeof payload.webexUrl === "string" && payload.webexUrl.trim().length > 0
        ? payload.webexUrl.trim()
        : typeof payload.zoomUrl === "string" && payload.zoomUrl.trim().length > 0
        ? payload.zoomUrl.trim()
        : typeof payload.teamsUrl === "string" && payload.teamsUrl.trim().length > 0
        ? payload.teamsUrl.trim()
        : "";

    let conference: MeetingContext["conference"] | undefined;
    if (payload.conference && typeof payload.conference === "object") {
      const rawConference = payload.conference as {
        type?: unknown;
        joinUrl?: unknown;
        accessCode?: unknown;
        password?: unknown;
        hostDisplayName?: unknown;
      };
      const joinUrl =
        typeof rawConference.joinUrl === "string" && rawConference.joinUrl.trim().length > 0
          ? rawConference.joinUrl.trim()
          : legacyJoinUrl;
      if (joinUrl.length > 0) {
        conference = {
          type:
            rawConference.type === "webex"
            || rawConference.type === "zoom"
            || rawConference.type === "teams"
            || rawConference.type === "other"
              ? rawConference.type
              : inferConferenceTypeFromUrl(joinUrl),
          joinUrl,
          ...(typeof rawConference.accessCode === "string" && rawConference.accessCode.trim().length > 0
            ? { accessCode: rawConference.accessCode.trim() }
            : {}),
          ...(typeof rawConference.password === "string" && rawConference.password.trim().length > 0
            ? { password: rawConference.password.trim() }
            : {}),
          ...(typeof rawConference.hostDisplayName === "string" && rawConference.hostDisplayName.trim().length > 0
            ? { hostDisplayName: rawConference.hostDisplayName.trim() }
            : {}),
        };
      }
    } else if (legacyJoinUrl.length > 0) {
      conference = {
        type:
          typeof payload.webexUrl === "string" && payload.webexUrl.trim().length > 0 ? "webex"
          : typeof payload.zoomUrl === "string" && payload.zoomUrl.trim().length > 0 ? "zoom"
          : typeof payload.teamsUrl === "string" && payload.teamsUrl.trim().length > 0 ? "teams"
          : inferConferenceTypeFromUrl(legacyJoinUrl),
        joinUrl: legacyJoinUrl,
      };
    }

    return enrichMeetingRegistrationContext({
      ...(typeof payload.id === "string" && payload.id.trim().length > 0 ? { id: payload.id.trim() } : {}),
      title,
      scheduledStart,
      ...(scheduledEnd ? { scheduledEnd } : {}),
      ...(organizer ? { organizer } : {}),
      ...(description ? { description } : {}),
      ...(category ? { category } : {}),
      ...(location ? { location } : {}),
      ...(participants ? { participants } : {}),
      ...(agenda ? { agenda } : {}),
      ...(previousSummary ? { previousSummary } : {}),
      ...(conference ? { conference } : {}),
    });
  };

  const registerPrepContext = (
    context: MeetingContext,
    options: {
      source: PrepRegistrationSource;
      focusInUi: boolean;
      logEventName: string;
    },
  ): { id: string; stored: MeetingContext } => {
    const prepared = hydratePrepContext(context);
    const id = prepStore.upsert(prepared);
    const stored = prepStore.get(id) ?? { ...prepared, id };
    if (options.focusInUi) {
      lastPrep = stored;
      hostApi.emitEvent("meeting.prep.opened", { context: stored });
    }
    hostApi.emitEvent("meeting.prep.registered", {
      id,
      count: 1,
      source: options.source,
      focusInUi: options.focusInUi,
      context: stored,
    });
    hostApi.logEvent?.("info", options.logEventName, {
      id: safePrepLogString(id),
      title: safePrepLogString(stored.title),
      source: options.source,
      focusInUi: options.focusInUi,
      conferenceType: stored.conference?.type,
      category: stored.category,
      agendaCount: stored.agenda?.length ?? 0,
    });
    return { id, stored };
  };

  const registerPrepContexts = (
    preps: MeetingContext[],
    options: {
      source: PrepRegistrationSource;
      logEventName: string;
    },
  ): { ids: string[] } => {
    const hydrated = preps.map(hydratePrepContext);
    const ids = prepStore.bulkUpsert(hydrated);
    hostApi.emitEvent("meeting.prep.registered", {
      ids,
      count: ids.length,
      source: options.source,
      focusInUi: false,
    });
    hostApi.logEvent?.("info", options.logEventName, {
      count: ids.length,
      source: options.source,
    });
    return { ids };
  };

  const startBatchSession = async (payload?: unknown) => {
    const body = (payload ?? {}) as {
      sessionId?: string;
      context?: MeetingContext & { lengthTier?: unknown };
      lengthTier?: unknown;
    };
    assertSessionId(body.sessionId);
    recorder.start(body.sessionId, body.context);
    activeSessions.add(body.sessionId);

    const startTier = pickLengthTier(body.lengthTier) ?? pickLengthTier(body.context?.lengthTier);
    if (startTier) sessionLengthTier.set(body.sessionId, startTier);

    hostApi.emitEvent("meeting.started", { sessionId: body.sessionId, mode: "batch" });
    hostApi.logEvent?.("info", "batch_processing_audio", { sessionId: body.sessionId, mode: "batch", lengthTier: startTier });
    return { sessionId: body.sessionId, started: true, mode: "batch", sampleRate: 16000 };
  };

  /**
   * The recorder card's slot height when it first appears, in device-
   * independent pixels. A REQUEST — the dock clamps against the work area and
   * against what is already attached, and `handle.height` is what was applied.
   */
  const RECORDER_PANEL_HEIGHT = 240;

  /**
   * Put the recorder card in the host's floating dock.
   *
   * This used to build the window itself: a frameless, transparent,
   * always-on-top `BrowserWindow` with its own partition-bound session,
   * positioned bottom-right of the primary display, resized on demand. Every
   * one of those decisions is the host's now and none of them appear here —
   * which is the point. A plugin that could place and size a borderless
   * always-on-top surface can draw a convincing copy of somebody else's
   * window; a plugin that gets a slot inside the host's dock, with host chrome
   * always around its pixels, cannot.
   */
  const attachRecorderPanel = async (payload?: unknown, logEventName = "meeting_start") => {
    const body = (payload ?? {}) as {
      sessionId?: string;
      context?: MeetingContext & { lengthTier?: unknown };
      lengthTier?: unknown;
    };
    assertSessionId(body.sessionId);
    const sessionId = body.sessionId;
    // Carry per-session tier from either top-level or context. Used at
    // meeting_stop time when the card doesn't supply one.
    const openTier = pickLengthTier(body.lengthTier) ?? pickLengthTier(body.context?.lengthTier);
    if (openTier) sessionLengthTier.set(sessionId, openTier);

    // Idempotent for the SAME session — asking twice is friendlier than
    // orphaning the first card.
    if (recorderPanel?.sessionId === sessionId) {
      return { ok: true, reused: true };
    }
    // A DIFFERENT session while one is up is refused, not queued behind a
    // detach. The host permits one audio capture at a time, so the second card
    // would watch a recording that cannot start — and it would do so with the
    // first meeting's card gone from the screen. Whoever asked has to end the
    // recording that is running, which is a decision and not ours.
    if (recorderPanel) {
      throw new Error(
        `[meeting] a recorder is already open for session ${recorderPanel.sessionId}; `
        + "stop or cancel it before opening another",
      );
    }

    const attach = hostApi.attachFloatingPanel;
    if (!attach) {
      throw new Error(
        "[meeting] this host does not provide hostApi.attachFloatingPanel. "
        + "The floating recorder needs a host with the floating dock; update Ave.",
      );
    }

    const handle = await attach.call(hostApi, {
      extensionId: RECORDER_PANEL_EXTENSION_ID,
      height: RECORDER_PANEL_HEIGHT,
    });
    recorderPanel = { sessionId, context: body.context, handle };

    /**
     * Why the reason is read rather than a flag consulted.
     *
     * A window's `closed` event cannot say who closed it, so the old code kept
     * a set of sessions it had closed on purpose and checked membership. A
     * teardown path that forgot to write to that set read as an orphaned
     * recording and silently cancelled a meeting. The reason is data here, and
     * data cannot be forgotten by a path that does not touch it.
     */
    handle.onDetached((reason) => {
      // A detach WE asked for cleared this first; anything still registered is
      // a card that went away without us.
      if (recorderPanel?.sessionId !== sessionId) return;
      recorderPanel = null;
      if (reason === "requested") return;
      // `plugin-stopped` / `host-shutdown` are already being handled by
      // cleanupRuntime, which decides between finalizing and cancelling with
      // more context than this handler has.
      if (reason === "plugin-stopped" || reason === "host-shutdown") return;
      // The user closed the dock, or the card's renderer died. Either way the
      // recording is orphaned and nothing is driving it.
      cancelOrphanedSession(sessionId, reason);
    });

    hostApi.logEvent?.("info", logEventName, { sessionId, height: handle.height });
    return { ok: true, reused: false };
  };

  const asEventRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;

  // Calendar rows reach the prep store one way: resolved and enriched (agenda
  // from the body, Webex URL) before the registration gates.
  const registerCalendarRows = (events: unknown[], logPrefix: string): void => {
    try {
      const meetings = resolveScheduledMeetingContexts({ events });
      if (meetings.length === 0) return;
      if (categoryRegistrationGate(meetings) || agendaRequirementGate(meetings) || webexUrlRequirementGate(meetings)) {
        hostApi.logEvent?.("warn", `${logPrefix}.rejected`, { count: meetings.length });
        return;
      }
      const { ids } = registerPrepContexts(meetings, {
        source: "calendar-sync",
        logEventName: `${logPrefix}.requested`,
      });
      hostApi.logEvent?.("info", `${logPrefix}.accepted`, { count: ids.length });
    } catch (error) {
      hostApi.logEvent?.("warn", `${logPrefix}.failed`, {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  };

  const calendarAutomationEnabled = (getConfig?.("calendarAutomationEnabled") ?? context.config?.calendarAutomationEnabled) === true;
  // Claims survive a plugin restart, so a meeting inside its prep window does
  // not open its prep (or start its recording) a second time.
  const calendarClaims = calendarAutomationEnabled
    ? new CalendarClaims(hostApi.storage, (operation, error) => {
      hostApi.logEvent?.("warn", `meeting.calendar.claims.${operation}_failed`, {
        error: error instanceof Error ? error.name : "unknown",
      });
    })
    : null;
  const calendarAutomation = calendarClaims && new CalendarAutomation({
    registerRows: (rows) => registerCalendarRows(rows, "meeting.calendar.sync"),
    openPrep: (meeting) => {
      if (categoryRegistrationGate([meeting])) return;
      registerPrepContext(meeting, { source: "calendar-sync", focusInUi: true, logEventName: "meeting.calendar.prep" });
    },
    startRecording: async (sessionId, meeting) => {
      await attachRecorderPanel({ sessionId, context: meeting }, "meeting.calendar.recording");
    },
  }, calendarClaims);
  if (calendarClaims && calendarAutomation) {
    await calendarClaims.restore();
    hostApi.onEvent("calendar.events.loaded", (payload) => {
      calendarAutomation.load(asEventRecord(payload)?.events);
    });
    hostApi.onEvent("calendar.event.added", (payload) => {
      calendarAutomation.add(asEventRecord(payload)?.event);
    });
    hostApi.onEvent("calendar.event.upcoming", (payload) => {
      calendarAutomation.upcoming(asEventRecord(payload)?.event);
    });
    hostApi.onEvent("calendar.event.starting", (payload) => {
      calendarAutomation.starting(asEventRecord(payload)?.event);
    });
    hostApi.emitEvent("meeting.calendar.snapshot.requested", {});
  }

  const plugin = {
    handlers: {
      meeting_start: (payload?: unknown) => attachRecorderPanel(payload, "meeting_start"),

      // ── The recorder card's own methods ──────────────────────────────
      // App-visible only (plugin.json `_meta.ui.visibility: ["app"]`), and
      // every one of them acts on the single attached panel's session rather
      // than on a sessionId it was handed. See `requireRecorderSession`.
      meeting_recorder_state: recorderState,
      meeting_recorder_begin_capture: recorderBeginCapture,
      meeting_recorder_levels: recorderLevels,
      meeting_recorder_microphones: recorderMicrophones,
      meeting_recorder_restart_capture: recorderRestartCapture,
      meeting_recorder_set_paused: recorderSetPaused,
      meeting_recorder_resize: recorderResize,
      meeting_recorder_close: recorderClose,

      batch_processing_audio: startBatchSession,

      meeting_push_chunk: async (payload?: unknown) => {
        const body = (payload ?? {}) as { sessionId?: string; chunk?: MeetingChunk };
        // Same invariant as the other 7 handlers — sessionId must be a
        // string matching SESSION_ID_RE before we touch any per-session
        // state (rate-limiter bucket, pipeline buffer).
        assertSessionId(body.sessionId);
        if (!body.chunk) throw new Error("chunk is required");
        assertFiniteChunkNumbers(body.chunk);

        // DoS hardening — rate limit + per-chunk size cap.
        if (!pushChunkLimiter.tryAcquire(body.sessionId)) {
          hostApi.logEvent?.("warn", "meeting_push_chunk.rate_limited", {
            sessionId: body.sessionId,
            windowMs: PUSH_CHUNK_LIMITS.windowMs,
            maxCalls: PUSH_CHUNK_LIMITS.maxCalls,
          });
          return { ok: false, error: "rate-limited" };
        }
        const sampleCount = body.chunk.pcm16leMono?.length ?? 0;
        if (sampleCount * 2 > PUSH_CHUNK_LIMITS.maxBytes) {
          hostApi.logEvent?.("warn", "meeting_push_chunk.size_exceeded", {
            sessionId: body.sessionId,
            bytes: sampleCount * 2,
            maxBytes: PUSH_CHUNK_LIMITS.maxBytes,
          });
          return { ok: false, error: "rate-limited" };
        }

        // IPC를 통해 전달된 16-bit 정수 배열 → PCM16LE Buffer 변환
        // Buffer.from(number[])는 각 숫자를 1바이트(0-255)로 truncate하므로
        // 16-bit 샘플 데이터가 손상됨 → writeInt16LE로 올바르게 인코딩
        const samples = body.chunk.pcm16leMono;
        const pcmBuffer = Buffer.alloc(samples.length * 2);
        for (let i = 0; i < samples.length; i++) {
          pcmBuffer.writeInt16LE(
            Math.max(-32768, Math.min(32767, Math.round(samples[i] ?? 0))),
            i * 2,
          );
        }

        await recorder.pushAudioChunk(body.sessionId, {
          pcm16leMono: pcmBuffer,
          sampleRate: body.chunk.sampleRate,
          startSec: body.chunk.startSec,
          endSec: body.chunk.endSec,
        });
        const transcript = pipeline.getTranscript(body.sessionId);
        return { sessionId: body.sessionId, mode: "batch", added: transcript.length };
      },

      meeting_stop: async (payload?: unknown) => {
        const body = (payload ?? {}) as { sessionId?: string; lengthTier?: unknown };
        assertSessionId(body.sessionId);

        // In-flight dedup: if another stop is mid-flight for this
        // session, wait for it instead of racing into the pipeline's
        // assertNotFinalized() throw. After the in-flight one finishes
        // we fall through to the cached/persisted idempotency check.
        const inflightExisting = stopInflight.get(body.sessionId);
        if (inflightExisting) {
          try { await inflightExisting; } catch { /* first call failed — allow retry */ }
        }

        // Idempotency replay. The floating window's Done button +
        // meeting.ended event handler can both call meeting_stop within
        // milliseconds; if we already have a finalSummary cached/persisted
        // for this session, return it with an `idempotent: true` flag so
        // consumers can distinguish a fresh summary from a replay.
        const cachedFinal = finalBySession.get(body.sessionId);
        const persistedAlready = sessionStore.load(body.sessionId);
        if (cachedFinal || persistedAlready?.finalSummary) {
          const final = (cachedFinal ?? persistedAlready?.finalSummary) as import("./types.js").FinalSummary;
          finalBySession.delete(body.sessionId);
          return { ...final, idempotent: true };
        }

        // Register self as the in-flight stop so a concurrent caller
        // can await us instead of throwing.
        let resolveInflight!: () => void;
        let rejectInflight!: (err: unknown) => void;
        const inflightPromise = new Promise<void>((res, rej) => {
          resolveInflight = res;
          rejectInflight = rej;
        });
        // Swallow the rejection at the Promise level so an awaiter that
        // catches the error doesn't trigger an unhandled-rejection warn
        // for the deferred. Each awaiter wraps its own try/catch.
        inflightPromise.catch(() => {});
        stopInflight.set(body.sessionId, inflightPromise);

        try {
          // BEFORE the summary work, and flushing. A recording rarely ends on
          // a chunk boundary, so skipping this drops the last seconds of every
          // meeting — and they are usually the ones that say what was decided.
          //
          // This used to reach `endSessionCapture` through
          // `closeFloatingWindow`, which passes `flush: false`. The floating
          // window's Done button had its own stop implementation that flushed,
          // so the tail survived a click and was lost whenever the assistant
          // ended the meeting instead. There is one stop now, and it flushes.
          await endSessionCapture(body.sessionId, { flush: true });
          detachRecorderPanel(body.sessionId);

          // Resolve final-summary verbosity: per-call payload > sessionLengthTier
          // (set when the meeting started) > pipeline default (configSchema).
          const tier = pickLengthTier(body.lengthTier) ?? sessionLengthTier.get(body.sessionId);
          sessionLengthTier.delete(body.sessionId);
          await recorder.stop(body.sessionId, tier ? { lengthTier: tier } : undefined);
          await releaseSessionStt(body.sessionId);
          activeSessions.delete(body.sessionId);
          floatingPeakRings.delete(body.sessionId);
        lastIngestError.delete(body.sessionId);
          pushChunkLimiter.forget(body.sessionId);
          hostApi.emitEvent("meeting.ended", { sessionId: body.sessionId });
          hostApi.logEvent?.("info", "meeting_stop", { sessionId: body.sessionId, lengthTier: tier });

          const final = finalBySession.get(body.sessionId);
          if (!final) throw new Error(`final summary not found: ${body.sessionId}`);

          // Persist the final summary onto the on-disk session record. Pipeline's
          // finalizeSession already saved the session with finalized=true, but it
          // ran before the final-summary event populated finalBySession, so we
          // patch the record here. After app restart the detail view can read
          // title/summary/highlights/actionItems directly from SessionStore.
          const persisted = sessionStore.load(body.sessionId);
          if (persisted) {
            sessionStore.save({
              ...persisted,
              finalSummary: final,
            });
          }

          // Drop the in-memory cache entry now that it's persisted to disk —
          // otherwise finalBySession grows by one Map entry per completed
          // meeting until the plugin restarts.
          finalBySession.delete(body.sessionId);

          // Release the pipeline's in-memory copy of this session. finalizeSession
          // sets finalized=true + abortSession but intentionally leaves the
          // SessionState in the sessions Map so this handler can still read
          // back transcript metadata above. With persistence + finalBySession
          // already drained to disk, the in-memory transcript is now dead
          // weight (≈1 MB/finished-meeting) until the plugin restarts.
          // Drop it here so long-running plugin instances don't grow.
          try { pipeline.resetSession(body.sessionId); } catch { /* best-effort */ }

          // 액션 아이템은 meeting.summary.created 이벤트의 actionItems 페이로드로
          // 이미 broadcast 됨. 호스트 TaskService 가 제거되며 host addTask 직접
          // 호출도 사라졌다 — agent-hub 등 컨슈머 플러그인이 actionItems 를 자체
          // 큐/노티피케이션으로 surface.
          resolveInflight();
          return final;
        } catch (err) {
          // Capture flush or summary can fail before finalizeSession reaches
          // its own cleanup. The transcript stays for a later summary retry.
          await releaseSessionStt(body.sessionId);
          rejectInflight(err);
          throw err;
        } finally {
          stopInflight.delete(body.sessionId);
        }
      },

      meeting_transcript: async (payload?: unknown) => {
        const body = (payload ?? {}) as { sessionId?: string };
        assertSessionId(body.sessionId);
        return pipeline.getTranscript(body.sessionId);
      },

      meeting_sessions: async () => [
        projectSessionMetadata(cloneBundledGuideSession()),
        ...sessionStore.listFinished(20).map(projectSessionMetadata),
      ],

      meeting_previous_sessions: async (payload?: unknown) => {
        const body = (payload ?? {}) as {
          sessionId?: string;
          beforeCreatedAt?: unknown;
          category?: unknown;
          limit?: unknown;
        };
        let before = body.beforeCreatedAt;
        let excludeSessionId: string | undefined;
        if (body.sessionId) {
          assertSessionId(body.sessionId);
          excludeSessionId = body.sessionId;
          const base = isGuideSessionId(body.sessionId)
            ? cloneBundledGuideSession()
            : sessionStore.load(body.sessionId);
          if (!base) throw new Error(`session not found: ${body.sessionId}`);
          before = base.createdAt;
        }
        return listFinishedSessionMetadata({
          category: body.category,
          before,
          excludeSessionId,
          limit: body.limit,
        });
      },

      meeting_sessions_by_category: async (payload?: unknown) => {
        const body = (payload ?? {}) as {
          category?: unknown;
          limit?: unknown;
        };
        const category = normalizeProvidedCategory(body.category);
        if (!category) {
          return {
            ok: false,
            needsCategorySelection: true,
            missing: ["category"],
            categories: listMeetingCategories(),
            message: "Choose a meeting category before querying category-specific sessions.",
          };
        }
        return listFinishedSessionMetadata({
          category,
          limit: body.limit,
        });
      },

      meeting_categories: async () => ({
        categories: listMeetingCategories(),
      }),

      meeting_register_category: async (payload?: unknown) => {
        const body = (payload ?? {}) as { category?: unknown };
        const category = categoryStore.register(body.category);
        hostApi.logEvent?.("info", "meeting_register_category", { category });
        return {
          ok: true,
          category,
          categories: listMeetingCategories(),
        };
      },

      meeting_session_detail: async (payload?: unknown) => {
        const body = (payload ?? {}) as { sessionId?: string };
        assertSessionId(body.sessionId);
        if (isGuideSessionId(body.sessionId)) {
          return cloneBundledGuideSession();
        }
        const persisted = sessionStore.load(body.sessionId);
        return persisted ? withRelatedSessions(persisted) : null;
      },

      meeting_related_sessions: async (payload?: unknown) => {
        const body = (payload ?? {}) as { sessionId?: string };
        assertSessionId(body.sessionId);
        if (isGuideSessionId(body.sessionId)) return [];
        const persisted = sessionStore.load(body.sessionId);
        if (!persisted) throw new Error(`session not found: ${body.sessionId}`);
        return projectRelatedSessions(persisted.relatedSessionIds, body.sessionId);
      },

      meeting_stage_upload_begin: async (payload?: unknown) => {
        cleanupStaleStagedUploads();
        const body = (payload ?? {}) as {
          sessionId?: string;
          context?: MeetingContext & { lengthTier?: unknown };
          lengthTier?: unknown;
          file?: unknown;
        };
        assertSessionId(body.sessionId);
        if (activeSessions.has(body.sessionId) || hasStagedUploadForSession(body.sessionId)) {
          return { ok: false, error: "session-busy" };
        }
        if (sessionStore.load(body.sessionId)) {
          return { ok: false, error: "session-exists" };
        }
        if (stagedUploads.size >= STAGED_UPLOAD_MAX_ACTIVE) {
          return { ok: false, error: "too-many-active-uploads", maxActive: STAGED_UPLOAD_MAX_ACTIVE };
        }

        let file: StagedUploadFilePayload;
        try {
          file = normaliseStagedUploadFilePayload(body.file);
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("file-too-large:")) {
            return { ok: false, error: "file-too-large" as const, maxBytes: STAGED_UPLOAD_MAX_BYTES };
          }
          throw err;
        }
        const uploadTier =
          pickLengthTier(body.lengthTier) ?? pickLengthTier(body.context?.lengthTier);
        const uploadId = randomUUID();
        const workerSlot = takeFfmpegWorkerSlot(
          new Set([...stagedUploads.values()].map((active) => active.workerSlot)),
        );
        const dir = mkdtempSync(join(stagedUploadsDir, STAGED_UPLOAD_DIR_PREFIX));
        const inputPath = join(dir, "source");
        const segmentDir = join(dir, "segments");
        const fileName = safeFileName(file.name);
        writeFileSync(inputPath, Buffer.alloc(0));

        const now = Date.now();
        stagedUploads.set(uploadId, {
          uploadId,
          workerSlot,
          sessionId: body.sessionId,
          context: body.context,
          lengthTier: uploadTier,
          fileName,
          mimeType: file.mimeType,
          declaredSize: file.size,
          receivedBytes: 0,
          dir,
          inputPath,
          segmentDir,
          createdAt: now,
          lastActivityAt: now,
          status: "receiving",
        });

        hostApi.logEvent?.("info", "meeting_stage_upload.begin", {
          sessionId: body.sessionId,
          uploadId,
          bytes: file.size,
          fileName,
        });
        return {
          ok: true,
          uploadId,
          sessionId: body.sessionId,
          chunkMaxBytes: STAGED_UPLOAD_CHUNK_MAX_BYTES,
          maxBytes: STAGED_UPLOAD_MAX_BYTES,
        };
      },

      meeting_stage_upload_chunk: async (payload?: unknown) => {
        cleanupStaleStagedUploads();
        const body = (payload ?? {}) as Record<string, unknown>;
        const uploadId = typeof body.uploadId === "string" ? body.uploadId : "";
        const state = stagedUploads.get(uploadId);
        if (!state) throw new Error("staged upload not found");
        if (state.status !== "receiving") throw new Error("staged upload is already finishing");
        const offset = assertSafeByteCount(body.offset, "offset");
        if (offset !== state.receivedBytes) {
          throw new Error(`unexpected chunk offset: ${offset} != ${state.receivedBytes}`);
        }

        const bytes = decodeStagedBase64Chunk(body.bytesBase64);
        body.bytesBase64 = "";
        if (state.receivedBytes + bytes.length > state.declaredSize) {
          throw new Error("received bytes exceed declared file size");
        }
        appendFileSync(state.inputPath, bytes);
        state.receivedBytes += bytes.length;
        state.lastActivityAt = Date.now();
        return {
          ok: true,
          uploadId,
          receivedBytes: state.receivedBytes,
          complete: state.receivedBytes === state.declaredSize,
        };
      },

      meeting_stage_upload_finish: async (payload?: unknown) => {
        cleanupStaleStagedUploads();
        const body = (payload ?? {}) as { uploadId?: string };
        const uploadId = typeof body.uploadId === "string" ? body.uploadId : "";
        const state = stagedUploads.get(uploadId);
        if (!state) throw new Error("staged upload not found");
        if (state.status !== "receiving") throw new Error("staged upload is already finishing");
        if (state.receivedBytes !== state.declaredSize) {
          throw new Error(`incomplete staged upload: ${state.receivedBytes}/${state.declaredSize}`);
        }
        if (activeSessions.has(state.sessionId) || sessionStore.load(state.sessionId)) {
          throw new Error("session-busy");
        }
        state.lastActivityAt = Date.now();
        state.status = "finishing";
        state.abortController = new AbortController();
        return runStagedUploadSession(state);
      },

      meeting_stage_upload_cancel: async (payload?: unknown) => {
        const body = (payload ?? {}) as { uploadId?: string };
        const uploadId = typeof body.uploadId === "string" ? body.uploadId : "";
        const sessionId = stagedUploads.get(uploadId)?.sessionId;
        cleanupStagedUpload(uploadId, { abort: true, reason: "ui-cancel" });
        if (sessionId) await releaseSessionStt(sessionId);
        return { ok: true, cancelled: true };
      },

      meeting_upload_file: async (payload?: unknown) => {
        const body = (payload ?? {}) as {
          sessionId?: string;
          context?: MeetingContext & { lengthTier?: unknown };
          lengthTier?: unknown;
          file?: unknown;
        };
        assertSessionId(body.sessionId);
        if (activeSessions.has(body.sessionId) || hasStagedUploadForSession(body.sessionId)) {
          return { ok: false, error: "session-busy" };
        }
        if (sessionStore.load(body.sessionId)) {
          return { ok: false, error: "session-exists" };
        }
        const file = normaliseUploadFilePayload(body.file);
        // Priority: per-call top-level > nested context.lengthTier > undefined
        // (provider falls back to configSchema.summaryLengthTier). Matches
        // the precedence used by meeting_start / batch_processing_audio.
        const uploadTier =
          pickLengthTier(body.lengthTier) ?? pickLengthTier(body.context?.lengthTier);

        // Sanitise the caller-supplied filename — used as the multipart
        // filename param AND in host log entries, so any CR/LF/path
        // separator could smuggle headers or forge log lines.
        const fileName = safeFileName(file.name);

        // Pre-decode size check — base64 is 4 chars per 3 bytes, so a
        // 100MB string would allocate a 75MB Buffer just to reject it.
        // Gate on the encoded length first.
        if (!isBase64WithinCap(file.bytesBase64, UPLOAD_MAX_BYTES)) {
          hostApi.logEvent?.("warn", "meeting_upload_file.size_exceeded_pre_decode", {
            sessionId: body.sessionId,
            base64Length: file.bytesBase64.length,
            maxBytes: UPLOAD_MAX_BYTES,
          });
          return { ok: false, error: "file-too-large", maxBytes: UPLOAD_MAX_BYTES };
        }

        // Decode + post-decode size guard. Do NOT trust caller-reported
        // size — measure the decoded buffer.
        const bytes = Buffer.from(file.bytesBase64, "base64");
        // The base64 string is a V8 UTF-16 blob roughly 2.66× the binary
        // size (4/3 base64 expansion × 2 bytes/char). Once decoded, drop
        // both references so the GC can reclaim it before we forward the
        // Buffer through the ingest + Whisper upload chain.
        file.bytesBase64 = "";
        body.file = undefined;
        if (bytes.length > UPLOAD_MAX_BYTES) {
          hostApi.logEvent?.("warn", "meeting_upload_file.size_exceeded", {
            sessionId: body.sessionId,
            bytes: bytes.length,
            maxBytes: UPLOAD_MAX_BYTES,
          });
          return { ok: false, error: "file-too-large", maxBytes: UPLOAD_MAX_BYTES };
        }
        if (bytes.length === 0) {
          throw new Error("file is empty");
        }

        // The public direct route still accepts 25 MiB, but its STT request
        // cannot carry more than 15 MiB of audio inside a 16 MiB multipart.
        // Use the same FFmpeg staging path as the 500 MiB route above it.
        if (bytes.length > STT_AUDIO_MAX_BYTES) {
          if (stagedUploads.size >= STAGED_UPLOAD_MAX_ACTIVE) {
            return { ok: false, error: "too-many-active-uploads", maxActive: STAGED_UPLOAD_MAX_ACTIVE };
          }
          const uploadId = randomUUID();
          const workerSlot = takeFfmpegWorkerSlot(
            new Set([...stagedUploads.values()].map((active) => active.workerSlot)),
          );
          const dir = mkdtempSync(join(stagedUploadsDir, STAGED_UPLOAD_DIR_PREFIX));
          const inputPath = join(dir, "source");
          const segmentDir = join(dir, "segments");
          writeFileSync(inputPath, bytes);
          const now = Date.now();
          const state: StagedUploadState = {
            uploadId, workerSlot, sessionId: body.sessionId, context: body.context,
            lengthTier: uploadTier, fileName, mimeType: file.mimeType,
            declaredSize: bytes.length, receivedBytes: bytes.length,
            dir, inputPath, segmentDir, createdAt: now, lastActivityAt: now,
            status: "finishing", abortController: new AbortController(),
          };
          stagedUploads.set(uploadId, state);
          return runStagedUploadSession(state);
        }

        // Open a session, push the whole file as one batch, finalise, then
        // emit the same lifecycle events as a streaming session so downstream
        // consumers (notification, task ingestion) work uniformly.
        recorder.start(body.sessionId, body.context);
        activeSessions.add(body.sessionId);
        hostApi.emitEvent("meeting.started", { sessionId: body.sessionId, mode: "upload" });
        hostApi.logEvent?.("info", "meeting_upload_file.start", {
          sessionId: body.sessionId,
          bytes: bytes.length,
          fileName,
        });

        try {
          await pipeline.ingestAudioFile(body.sessionId, {
            bytes,
            mimeType: file.mimeType,
            fileName,
          });
          await recorder.stop(body.sessionId, uploadTier ? { lengthTier: uploadTier } : undefined);
          await releaseSessionStt(body.sessionId);
          activeSessions.delete(body.sessionId);
          pushChunkLimiter.forget(body.sessionId);
          hostApi.emitEvent("meeting.ended", { sessionId: body.sessionId });

          const final = finalBySession.get(body.sessionId);
          if (!final) throw new Error(`final summary not found: ${body.sessionId}`);

          const persisted = sessionStore.load(body.sessionId);
          if (persisted) {
            sessionStore.save({ ...persisted, finalSummary: final });
          }
          finalBySession.delete(body.sessionId);

          // Snapshot transcript BEFORE resetting the pipeline session —
          // resetSession drops the SessionState from the in-memory Map and
          // a subsequent getTranscript would throw. Mirrors the meeting_stop
          // happy-path cleanup; without it the upload path also pinned ~1 MB
          // of transcript per completed meeting until plugin restart.
          const transcript = pipeline.getTranscript(body.sessionId);
          try { pipeline.resetSession(body.sessionId); } catch { /* best-effort */ }

          return {
            sessionId: body.sessionId,
            mode: "upload" as const,
            transcript,
            finalSummary: final,
          };
        } catch (err) {
          activeSessions.delete(body.sessionId);
          pushChunkLimiter.forget(body.sessionId);

          try {
            finalBySession.delete(body.sessionId);
          } catch {
            // Best-effort cleanup only; preserve the original failure.
          }

          try {
            (
              pipeline as { resetSession?: (sessionId: string) => void | Promise<void> }
            ).resetSession?.(body.sessionId);
          } catch {
            // Best-effort cleanup only; preserve the original failure.
          }
          await releaseSessionStt(body.sessionId);

          try {
            (sessionStore as { delete?: (sessionId: string) => void }).delete?.(body.sessionId);
          } catch {
            // Best-effort cleanup only; preserve the original failure.
          }

          hostApi.emitEvent("meeting.error", {
            sessionId: body.sessionId,
            error: (err as Error).message,
          });
          hostApi.emitEvent("meeting.ended", {
            sessionId: body.sessionId,
            cancelled: true,
          });
          if (err instanceof Error && err.message.startsWith("file-too-large:")) {
            return { ok: false, error: "file-too-large" as const, maxBytes: STT_AUDIO_MAX_BYTES };
          }
          throw err;
        }
      },

      meeting_open_prep: async (payload?: unknown) => {
        const body = (payload ?? {}) as { context?: MeetingContext };
        if (!body.context) throw new Error("context is required");
        const categoryGate = categoryRegistrationGate([body.context]);
        if (categoryGate) return categoryGate;
        // Persist + cache + broadcast. Persistence ensures the prep
        // survives plugin restart; in-memory cache makes the next
        // get_prep call cheap; broadcast lets other plugins react.
        const { id } = registerPrepContext(body.context, {
          source: "other",
          focusInUi: true,
          logEventName: "meeting_open_prep",
        });
        return { ok: true, id };
      },

      meeting_register_scheduled_meeting: async (payload?: unknown) => {
        const body = (payload ?? {}) as {
          context?: MeetingContext;
          event?: unknown;
          source?: unknown;
          focusInUi?: unknown;
        } & Record<string, unknown>;
        let context: MeetingContext;
        try {
          context = resolveScheduledMeetingContext(body);
        } catch {
          return {
            ok: false,
            needsInput: true,
            missing: ["meetingData"],
            message:
              "등록할 예정 회의 정보가 필요합니다. 회의 제목/시간 또는 원본 캘린더 이벤트를 알려주세요. 참석자와 회의 링크는 선택 정보입니다.",
          };
        }
        const categoryGate = categoryRegistrationGate([context]);
        if (categoryGate) return categoryGate;
        const agendaGate = agendaRequirementGate([context]);
        if (agendaGate) return agendaGate;
        const webexGate = webexUrlRequirementGate([context]);
        if (webexGate) return webexGate;
        const source = normalisePrepRegistrationSource(body.source);
        const focusInUi = body.focusInUi === true;
        const { id } = registerPrepContext(context, {
          source,
          focusInUi,
          logEventName: "meeting_register_scheduled_meeting",
        });
        return { ok: true, id, source, focusInUi };
      },

      meeting_register_manual_meeting: async (payload?: unknown) => {
        const body = (payload ?? {}) as {
          id?: unknown;
          title?: unknown;
          scheduledStart?: unknown;
          scheduledEnd?: unknown;
          organizer?: unknown;
          description?: unknown;
          category?: unknown;
          location?: unknown;
          participants?: unknown;
          agenda?: unknown;
          agendaItems?: unknown;
          agendaText?: unknown;
          meetingAgenda?: unknown;
          todayAgenda?: unknown;
          previousSummary?: unknown;
          conference?: unknown;
          focusInUi?: unknown;
        };
        const context = resolveManualMeetingContext(body);
        const categoryGate = categoryRegistrationGate([context]);
        if (categoryGate) return categoryGate;
        const agendaGate = agendaRequirementGate([context]);
        if (agendaGate) return agendaGate;
        const webexGate = webexUrlRequirementGate([context]);
        if (webexGate) return webexGate;
        const focusInUi = body.focusInUi !== false;
        const { id } = registerPrepContext(context, {
          source: "manual",
          focusInUi,
          logEventName: "meeting_register_manual_meeting",
        });
        return { ok: true, id, source: "manual" as const, focusInUi };
      },

      meeting_register_scheduled_meetings: async (payload?: unknown) => {
        const body = (payload ?? {}) as {
          meetings?: MeetingContext[];
          events?: unknown[];
          source?: unknown;
        };
        if (!Array.isArray(body.meetings) && !Array.isArray(body.events)) {
          return {
            ok: false,
            needsInput: true,
            missing: ["meetings", "events"],
            message:
              "등록할 예정 회의 목록이 필요합니다. meetings 배열 또는 원본 캘린더 events 배열을 알려주세요.",
          };
        }
        const meetings = resolveScheduledMeetingContexts(body);
        const PER_CALL_MAX = 1000;
        if (meetings.length > PER_CALL_MAX) {
          throw new Error(`meetings array too large (${meetings.length} > ${PER_CALL_MAX})`);
        }
        const categoryGate = categoryRegistrationGate(meetings);
        if (categoryGate) return categoryGate;
        const agendaGate = agendaRequirementGate(meetings);
        if (agendaGate) return agendaGate;
        const webexGate = webexUrlRequirementGate(meetings);
        if (webexGate) return webexGate;
        const source = normalisePrepRegistrationSource(body.source);
        const { ids } = registerPrepContexts(meetings, {
          source,
          logEventName: "meeting_register_scheduled_meetings",
        });
        return { ok: true, ids, count: ids.length, source };
      },

      meeting_bulk_upsert_preps: async (payload?: unknown) => {
        const body = (payload ?? {}) as { preps?: MeetingContext[] };
        if (!Array.isArray(body.preps)) {
          throw new Error("preps must be an array");
        }
        // Per-call cap — caller-controlled flooding is bounded here, store-
        // level cap (MAX_PREPS=5000) is the deeper guard.
        const PER_CALL_MAX = 1000;
        if (body.preps.length > PER_CALL_MAX) {
          throw new Error(`preps array too large (${body.preps.length} > ${PER_CALL_MAX})`);
        }
        const preps = body.preps.map(enrichMeetingRegistrationContext);
        const categoryGate = categoryRegistrationGate(preps);
        if (categoryGate) return categoryGate;
        const agendaGate = agendaRequirementGate(preps);
        if (agendaGate) return agendaGate;
        const webexGate = webexUrlRequirementGate(preps);
        if (webexGate) return webexGate;
        const { ids } = registerPrepContexts(preps, {
          source: "calendar-sync",
          logEventName: "meeting_bulk_upsert_preps",
        });
        return { ok: true, ids, count: ids.length };
      },

      meeting_list_preps: async () => prepStore.list(),

      /**
       * Returns the prep the UI should display by default. Resolution
       * order:
       *   1. last in-memory open_prep call (intent: "show what was just opened")
       *   2. nearest scheduled meeting from the persistent store
       *   3. null
       */
      meeting_get_prep: async () => lastPrep ?? prepStore.getNearest(),

      meeting_delete_prep: async (payload?: unknown) => {
        const body = (payload ?? {}) as { id?: string };
        if (!body.id) throw new Error("id is required");
        const deleted = prepStore.delete(body.id);
        // Invalidate in-memory lastPrep so meeting_get_prep doesn't return a stale reference.
        if (lastPrep?.id === body.id) lastPrep = null;
        return { deleted };
      },

      /**
       * Returns the rolling per-100ms peak history for a loopback session
       * (empty array if the session isn't a loopback session or no chunks
       * have been ingested yet). UIs poll this every ~200ms to drive their
       * waveform animation in loopback mode (where they no longer hold an
       * AudioWorklet themselves).
       */
      /**
       * Open an external URL in the user's default browser via Electron
       * `shell.openExternal`. Used by the pre-meeting view's Webex/Zoom
       * /Teams "회의 참여" button — plugin webviews can't navigate to
       * external sites themselves (sandboxed), but the host plugin runs
       * in the main process and DOES have shell access.
       *
       * Strict http/https guard: rejects file:, data:, custom schemes
       * (steam:, mailto:, etc.) so a malformed/malicious conference link
       * can't pivot the user to a non-web target.
       */
      meeting_open_url: async (payload?: unknown) => {
        const body = (payload ?? {}) as { url?: string };
        const result = validateOpenUrl(body.url);
        if (!result.ok) {
          hostApi.logEvent?.("warn", "meeting_open_url.rejected", {
            reason: result.error,
            ...(result.protocol ? { protocol: result.protocol } : {}),
          });
          throw new Error(result.error);
        }
        await requireOpenExternalUrl()(result.url.toString());
        hostApi.logEvent?.("info", "meeting_open_url", { host: result.url.host });
        return { ok: true };
      },

      /**
       * The name `meeting_start` had before it was the one anybody used.
       * Kept as an alias because callers outside this repo still name it;
       * both reach the same attach.
       */
      meeting_open_floating_window: (payload?: unknown) =>
        attachRecorderPanel(payload, "meeting_open_floating_window"),

      meeting_cancel: async (payload?: unknown) => {
        const body = (payload ?? {}) as { sessionId?: string };
        assertSessionId(body.sessionId);
        // Drop the session WITHOUT calling summaryProvider — saves LLM cost
        // when the user cancels mid-recording. Also removes the persisted
        // session JSON so the cancelled meeting doesn't show in 회의록 list.
        detachRecorderPanel(body.sessionId);
        try {
          pipeline.resetSession(body.sessionId);
          sessionStore.delete(body.sessionId);
        } catch (err) {
          hostApi.logEvent?.("warn", "meeting_cancel.cleanup_failed", {
            sessionId: body.sessionId,
            error: (err as Error).message,
          });
        }
        await releaseSessionStt(body.sessionId);
        activeSessions.delete(body.sessionId);
        finalBySession.delete(body.sessionId);
        floatingPeakRings.delete(body.sessionId);
        lastIngestError.delete(body.sessionId);
        sessionLengthTier.delete(body.sessionId);
        pushChunkLimiter.forget(body.sessionId);
        hostApi.emitEvent("meeting.ended", { sessionId: body.sessionId, cancelled: true });
        hostApi.logEvent?.("info", "meeting_cancel", { sessionId: body.sessionId });
        return { ok: true };
      },

      /**
       * Patch the persisted finalSummary of a completed session. Used by
       * the inline-edit UI in the 회의록 sub-tab. Accepts partial fields —
       * any field not in the payload is preserved from the existing
       * finalSummary. The session must already be finalized; throws
       * otherwise (use meeting_stop / meeting_regenerate_summary first
       * if not).
       */
      meeting_update_summary: async (payload?: unknown) => {
        const body = (payload ?? {}) as {
          sessionId?: string;
          title?: unknown;
          summary?: unknown;
          highlights?: unknown;
          actionItems?: unknown;
        };
        assertSessionId(body.sessionId);
        const persisted = sessionStore.load(body.sessionId);
        if (!persisted) throw new Error(`session not found: ${body.sessionId}`);
        if (!persisted.finalSummary) {
          throw new Error("session has no finalSummary yet — call meeting_stop first");
        }
        const next = {
          ...persisted.finalSummary,
          ...(typeof body.title === "string" ? { title: body.title.slice(0, 200) } : {}),
          ...(typeof body.summary === "string" ? { summary: body.summary.slice(0, 8000) } : {}),
          ...(Array.isArray(body.highlights)
            ? { highlights: body.highlights
                .filter((h) => typeof h === "string")
                .map((h) => (h as string).slice(0, 500))
                .slice(0, 30) }
            : {}),
          ...(Array.isArray(body.actionItems)
            ? { actionItems: body.actionItems
                .filter((a) => typeof a === "string")
                .map((a) => (a as string).slice(0, 500))
                .slice(0, 50) }
            : {}),
        };
        const updatedPersisted = {
          ...persisted,
          finalSummary: next,
          updatedAt: new Date().toISOString(),
        };
        sessionStore.save(updatedPersisted);
        // Re-emit so downstream consumers (agent-hub, calendar) that
        // derived state from the original finalSummary (e.g. action-item
        // task queue) can refresh. `edited: true` distinguishes user
        // inline-edits from a fresh stop (`idempotent: true`) or a full
        // LLM re-roll (`regenerated: true`).
        emitSummary({
          ...deriveSummaryEventBase(updatedPersisted, body.sessionId),
          ...next,
          edited: true,
        });
        hostApi.logEvent?.("info", "meeting_update_summary", {
          sessionId: body.sessionId,
          fieldsTouched: [
            typeof body.title === "string" ? "title" : null,
            typeof body.summary === "string" ? "summary" : null,
            Array.isArray(body.highlights) ? "highlights" : null,
            Array.isArray(body.actionItems) ? "actionItems" : null,
          ].filter(Boolean),
        });
        return next;
      },

      meeting_update_session_category: async (payload?: unknown) => {
        const body = (payload ?? {}) as {
          sessionId?: string;
          category?: unknown;
        };
        assertSessionId(body.sessionId);
        const result = updateSessionCategory(body.sessionId, body.category);
        hostApi.logEvent?.("info", "meeting_update_session_category", result);
        return result;
      },

      meeting_link_sessions: async (payload?: unknown) => {
        const body = (payload ?? {}) as {
          sessionId?: string;
          targetSessionId?: string;
        };
        assertSessionId(body.sessionId);
        assertSessionId(body.targetSessionId);
        const result = updateLinkedSessions(body.sessionId, body.targetSessionId, true);
        hostApi.logEvent?.("info", "meeting_link_sessions", {
          sessionId: body.sessionId,
          targetSessionId: body.targetSessionId,
        });
        return result;
      },

      meeting_unlink_sessions: async (payload?: unknown) => {
        const body = (payload ?? {}) as {
          sessionId?: string;
          targetSessionId?: string;
        };
        assertSessionId(body.sessionId);
        assertSessionId(body.targetSessionId);
        const result = updateLinkedSessions(body.sessionId, body.targetSessionId, false);
        hostApi.logEvent?.("info", "meeting_unlink_sessions", {
          sessionId: body.sessionId,
          targetSessionId: body.targetSessionId,
        });
        return result;
      },

      /**
       * Re-run summarizeFinal on an already-finalized session's transcript
       * (preserving raw STT segments) and overwrite the persisted
       * finalSummary. Used by the "다시 생성" button in the 회의록 view.
       *
       * Optional `lengthTier` payload overrides the previous tier — lets
       * the user re-roll a summary at a different verbosity without
       * losing the captured audio/text. Re-emits meeting.summary.created
       * so downstream consumers (notification, agent-hub) re-receive
       * the regenerated payload.
       */
      meeting_regenerate_summary: async (payload?: unknown) => {
        const body = (payload ?? {}) as {
          sessionId?: string;
          lengthTier?: unknown;
        };
        assertSessionId(body.sessionId);
        const persisted = sessionStore.load(body.sessionId);
        if (!persisted) throw new Error(`session not found: ${body.sessionId}`);
        if (!Array.isArray(persisted.transcript) || persisted.transcript.length === 0) {
          throw new Error("transcript is empty — nothing to summarise");
        }
        // Priority: per-call > previously-recorded tier on persisted
        // finalSummary > global default. Honours the doc comment above
        // ("re-roll … at a different verbosity") so consecutive regens
        // without an explicit tier preserve the last choice.
        const tier =
          pickLengthTier(body.lengthTier)
          ?? persisted.finalSummary?.lengthTier
          ?? summaryLengthTier;
        const newSummary = await summaryProvider.summarizeFinal(
          {
            sessionId: body.sessionId,
            transcript: persisted.transcript,
            context: persisted.context,
          },
          { lengthTier: tier },
        );
        const updatedPersisted = {
          ...persisted,
          finalSummary: newSummary,
          updatedAt: new Date().toISOString(),
        };
        sessionStore.save(updatedPersisted);
        // Carry lifecycle fields (startedAt/endedAt/durationMs/participants)
        // so cross-plugin consumers (agent-hub, calendar) can still
        // correlate the re-emit with the original meeting.
        emitSummary({
          ...deriveSummaryEventBase(updatedPersisted, body.sessionId),
          ...newSummary,
          regenerated: true,
        });
        hostApi.logEvent?.("info", "meeting_regenerate_summary", {
          sessionId: body.sessionId, lengthTier: tier,
        });
        return newSummary;
      },

    },

    // Host lifecycle: runs once this generation is the active pointer, when
    // `spawnWorker` and `hostFetch` answer. The FFmpeg check belongs here, not
    // in the factory (see `ffmpegRuntimeReady`).
    onPublished: () => {
      warmFfmpegRuntime();
    },

    stop: async () => {
      calendarAutomation?.stop();
      await calendarClaims?.flush();
      await cleanupRuntime("plugin_stop", false);
    },
  };

  // onShutdown — drain STT buffer + stop any active recording.
  // Floating recorder windows hold the only audio capture path now, so
  // closing them tears down the AudioContext + media streams in renderer.
  hostApi.onShutdown?.(async () => {
    await cleanupRuntime("host_shutdown", true);
  });

  return plugin;
}
