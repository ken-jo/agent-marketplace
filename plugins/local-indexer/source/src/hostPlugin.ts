import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep as pathSep } from "node:path";
import { platform as osPlatform, tmpdir as osTmpdir } from "node:os";
/**
 * One in-flight-or-settled answer per drive, for this session.
 *
 * A REJECTION IS NOT CACHED. The stored value is the promise, so a failed
 * lookup would otherwise be replayed as the same failure for the life of the
 * process — including after the user fixed whatever broke it. The entry is
 * dropped on rejection and the next caller asks again.
 */
const _windowsMappedDriveUncCache = new Map<string, Promise<string | null>>();

/** What the host answers. Passed in rather than read from a module-level
 * `hostApi`, so the two functions below stay callable from a test without one. */
type MappedDriveResolver = (drive: string) => Promise<string | null>;

/**
 * The UNC root behind a mapped drive, asked of the HOST.
 *
 * This used to run `powershell.exe` here. Spawning an interpreter is ambient
 * axis 3, the axis a confined plugin child does not have, and the answer wanted
 * was one string — so the host owns the command now and this passes it a drive
 * letter. `hostApi.resolveMappedDriveRoot` validates the letter itself.
 *
 * A REJECTION IS NOT SWALLOWED, which is the other half of the change. The old
 * body had `catch { return null }`, and `null` already means "this drive is a
 * local disk". Under the old code a refused spawn therefore looked exactly like
 * an ordinary C:, and the allowed-root list came out silently short of a root
 * the worker needed — which surfaces much later as the worker rejecting files
 * the user can plainly see.
 */
async function resolveWindowsMappedDriveRoot(
  driveLetter: string,
  resolveRoot: MappedDriveResolver,
): Promise<string | null> {
  if (osPlatform() !== "win32") return null;
  const normalizedDrive = driveLetter.trim().toUpperCase();
  if (!/^[A-Z]:$/.test(normalizedDrive)) return null;
  const cached = _windowsMappedDriveUncCache.get(normalizedDrive);
  if (cached) return cached;
  const lookup = resolveRoot(normalizedDrive).catch((err: unknown) => {
    _windowsMappedDriveUncCache.delete(normalizedDrive);
    throw err;
  });
  _windowsMappedDriveUncCache.set(normalizedDrive, lookup);
  return lookup;
}

async function expandAllowedRootWithBackingUnc(
  absPath: string,
  resolveRoot: MappedDriveResolver,
): Promise<string[]> {
  if (osPlatform() !== "win32") return [absPath];
  if (!/^[A-Za-z]:[\\/]/.test(absPath) && !/^[A-Za-z]:$/.test(absPath)) return [absPath];
  const drive = absPath.slice(0, 2).toUpperCase();
  const uncRoot = await resolveWindowsMappedDriveRoot(drive, resolveRoot);
  if (!uncRoot) return [absPath];
  const suffix = absPath.slice(2).replace(/\//g, "\\").replace(/^\\+/, "");
  const uncPath = suffix ? `${uncRoot}\\${suffix}` : uncRoot;
  return [absPath, uncPath];
}
import { EgressLeaseDenied, type EgressAuthScheme, type EgressChannel, type EgressUpstreamFetch } from "./egressBroker.js";
import { FolderAutoIndexer } from "./folderIndexer.js";
import { IndexState } from "./indexState.js";
import {
  maybeProposeRescanRoutine,
  RESCAN_LEDGER_FILENAME,
} from "./rescanSuggestion.js";
import { LocalIndexerPlugin } from "./localIndexerPlugin.js";
import { LruCache } from "./lruCache.js";
import { getIndexModeForPath, isImageFilePath, isIndexableFilePath } from "./indexingFiles.js";
import { SKIP_DIR_NAMES } from "./skipDirs.js";
import type { ApiKeyLease, PluginRuntimeContext } from "@ave/plugin-contract";
import type {
  FolderIndexSummary,
  PageContentItem,
  LocalIndexerDocumentMeta,
  ScanProgressSnapshot,
  DocumentRow,
} from "./types.js";

const FOLDER_SUMMARY_CACHE_TTL_MS = 8_000;

function bufferToArrayBuffer(body: Buffer): ArrayBuffer {
  const copy = new Uint8Array(body.byteLength);
  copy.set(body);
  return copy.buffer;
}

// Max drifted docs the boot reconcile pass re-embeds per startup cycle. Bounds
// the embedding cost when a crash left a large backlog of meta-without-vector
// docs; the remainder are already marked for re-embed (content_hash NULL +
// content_state='embed_failed') and heal on the next cycle.
const RECONCILE_HEAL_CAP = 50;

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string");
}

/** path traversal, null-byte, 절대경로, 과도한 길이를 거부하는 모델명 검증 */
const _EMBEDDING_MODEL_RE = /^[A-Za-z0-9_\-./]{1,128}$/;
function validateEmbeddingModel(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (value.includes("\0") || value.includes("..")) return undefined;
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return undefined;
  return _EMBEDDING_MODEL_RE.test(value) ? value : undefined;
}
function validateEmbeddingProvider(value: unknown): "openai" | "azure" | undefined {
  if (value === "openai" || value === "azure") return value;
  return undefined;
}

/**
 * SSRF guard for caption / embedding endpoints. The endpoint is forwarded
 * to the worker as a CLI arg and then driven by the worker — a misconfigured
 * (or attacker-supplied via config-import) value of `file://`, an internal
 * admin URL, or a private-network host would otherwise become an SSRF vector.
 *
 * Allowlist:
 *  - `https://*` (any public TLS endpoint) — always allowed
 *  - `http://(localhost|127.0.0.1|::1)` — allowed ONLY when caller opts in
 *    via `allowLoopback: true`. The legitimate use case is OpenAI-compatible
 *    self-hosted endpoints (LM Studio, LiteLLM, Ollama-OpenAI-shim). Azure
 *    endpoints must always be https (no loopback Azure deployment exists).
 *
 * Returns "" for any rejected / empty input; callers MUST treat empty as
 * "no endpoint configured".
 */
export function validateEndpointUrl(
  value: unknown,
  opts: { allowLoopback: boolean },
): string {
  if (typeof value !== "string" || value.length === 0) return "";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "";
  }
  if (parsed.protocol === "https:") return value;
  if (parsed.protocol === "http:" && opts.allowLoopback) {
    const host = parsed.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") {
      return value;
    }
  }
  return "";
}

/**
 * Reduce a configured endpoint to its host portion for telemetry — Azure
 * resource URLs (e.g. `https://tenant.openai.azure.com/openai/...`)
 * embed the tenant/resource name in the host; the path/query may carry
 * deployment + api-version metadata. The host is the safer logging surface.
 * Returns the input unchanged when it cannot be parsed (e.g. empty),
 * letting downstream `Boolean(endpoint)` checks still work.
 */
export function endpointHostForLog(value: string): string {
  if (!value) return "";
  try {
    return new URL(value).host || "";
  } catch {
    return "";
  }
}

export function endpointRoot(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "";
  try {
    const parsed = new URL(value);
    if (!parsed.protocol || !parsed.host) return "";
    return `${parsed.protocol}//${parsed.host}/`;
  } catch {
    return "";
  }
}

export function endpointQueryParam(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0) return "";
  try {
    return new URL(value).searchParams.get(key)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function resolveAzureResourceEndpoint(opts: {
  explicitEndpoint?: unknown;
  fallbackEndpoint?: unknown;
  hostBaseUrl?: unknown;
}): string {
  for (const candidate of [opts.explicitEndpoint, opts.fallbackEndpoint, opts.hostBaseUrl]) {
    const validated = validateEndpointUrl(candidate, { allowLoopback: false });
    if (!validated) continue;
    const root = endpointRoot(validated);
    if (root) return root;
  }
  return "";
}

function inferAzureCaptionProviderFromEndpoint(value: unknown): "azure-openai-chat" | "azure-openai-responses" {
  if (typeof value === "string" && /\/openai\/responses\b/i.test(value)) {
    return "azure-openai-responses";
  }
  return "azure-openai-chat";
}

function isAzureEndpointUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    return new URL(value).host.toLowerCase().endsWith(".azure.com");
  } catch {
    return false;
  }
}

/**
 * Trust chokepoint for forwarding a HOST-issued LLM bearer to an endpoint.
 *
 * Returns true ONLY for the first-party OpenAI / Azure OpenAI domains the
 * plugin manifest declares (plugin.json `networkAccess.allowedDomains`):
 *   - `api.openai.com`                  (exact host)
 *   - `*.openai.azure.com`              (dot-boundary suffix)
 *   - `*.cognitiveservices.azure.com`   (dot-boundary suffix)
 * and only over https.
 *
 * The host's shared chat key is only ever routed to a trusted endpoint. A
 * user-supplied custom `embeddingEndpoint` / `imageCaptionEndpoint` (LM Studio,
 * LiteLLM, an internal proxy, or an attacker-controlled `base_url` smuggled in
 * via a malicious config import) is NOT trusted — the host key is withheld and
 * only the plugin's own key may be forwarded there.
 *
 * Dot-boundary matching (`endsWith(".openai.azure.com")`) rejects look-alike
 * hosts such as `evil-openai.azure.com.attacker.com`. Requiring https rejects
 * downgrade attempts like `http://api.openai.com`.
 */
export function isTrustedEndpointUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "api.openai.com") return true;
  if (hostname.endsWith(".openai.azure.com")) return true;
  if (hostname.endsWith(".cognitiveservices.azure.com")) return true;
  return false;
}

function extractAzureDeploymentFromEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "";
  try {
    const parsed = new URL(value);
    const match = parsed.pathname.match(/\/openai\/deployments\/([^/]+)/i);
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  } catch {
    return "";
  }
}

function uniqueDocuments(docs: LocalIndexerDocumentMeta[]): LocalIndexerDocumentMeta[] {
  const latestByPath = new Map<string, LocalIndexerDocumentMeta>();
  for (const doc of docs) {
    const key = doc.path || `${doc.doc_name}:${doc.type}`;
    latestByPath.set(key, doc);
  }
  return [...latestByPath.values()];
}

function mergeIndexedStateEntries(
  entries: Array<{ filePath: string; docId: string; mtimeMs: number; indexedAt: string }>,
): Map<string, { docId: string; mtimeMs: number; indexedAt: string }> {
  const merged = new Map<string, { docId: string; mtimeMs: number; indexedAt: string }>();
  for (const entry of entries) {
    const current = merged.get(entry.filePath);
    // indexedAt string 비교 대신 mtimeMs 숫자 비교 — 날짜 포맷 불일치 방지.
    if (!current || current.mtimeMs < entry.mtimeMs) {
      merged.set(entry.filePath, {
        docId: entry.docId,
        mtimeMs: entry.mtimeMs,
        indexedAt: entry.indexedAt,
      });
    }
  }
  return merged;
}

function buildStateMapFromDocs(
  docs: LocalIndexerDocumentMeta[],
): Map<string, { docId: string; mtimeMs: number; indexedAt: string }> {
  const map = new Map<string, { docId: string; mtimeMs: number; indexedAt: string }>();
  for (const doc of docs) {
    if (!doc.path) continue;
    const rawIndexedAt = doc.indexed_at;
    const indexedAt =
      typeof rawIndexedAt === "string" ? rawIndexedAt :
      typeof rawIndexedAt === "number" ? new Date(rawIndexedAt).toISOString() :
      new Date().toISOString();
    // mtime_ms가 없거나 0이면 0으로 저장 → stale 판정 → 다음 스캔에서 재인덱싱.
    // MAX_SAFE_INTEGER를 쓰면 파일 변경이 있어도 "항상 최신"으로 오판할 위험이 있다.
    const mtimeMs = (doc.mtime_ms != null && doc.mtime_ms > 0) ? doc.mtime_ms : 0;
    map.set(resolve(doc.path), {
      docId: doc.doc_id,
      mtimeMs,
      indexedAt,
    });
  }
  return map;
}

function synthesizeIndexedDocuments(indexedEntries: Array<{ filePath: string; docId: string; mtimeMs: number }>): LocalIndexerDocumentMeta[] {
  return indexedEntries.map((entry) => {
    // includeImages: true here — these entries are already in the index,
    // which means the image-embedding toggle WAS on when they were captured.
    // The fallback must therefore preserve `image` typing even if the toggle
    // has since been turned off; otherwise the synthesised metadata would
    // lose information the host already committed.
    const docType =
      getIndexModeForPath(entry.filePath, { includeImages: true }) ?? "auto";
    return {
      id: entry.docId,
      doc_id: entry.docId,
      type: docType,
      doc_type: docType,
      path: entry.filePath,
      doc_name: basename(entry.filePath),
      mtime_ms: entry.mtimeMs,
      indexed_at: new Date(entry.mtimeMs || Date.now()).toISOString(),
      status: "indexed",
    };
  });
}

function isWithinFolder(targetPath: string, folderPath: string): boolean {
  const rel = relative(folderPath, targetPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Normalize a user-supplied UNC prefix string from configSchema
 * `allowedUncRoots`. Returns a backslash-canonical form (e.g.
 * `\\server\share` or `\\server\share\subdir`) when valid, else null.
 *
 * Validation:
 *   - Must be a non-empty string with no NUL byte
 *   - Must start with `\\` (UNC) but NOT `\\?\` / `\\.\` (device namespace)
 *   - Must contain at least `server\share` after the leading `\\`
 *   - Trailing slashes stripped; forward slashes folded to backslashes
 *
 * The result is used as a prefix to allow-list UNC absolute paths in
 * `isBlockedIndexPath`. A blanket `\\` or `\\server` is rejected so a
 * mis-typed entry never opens the entire UNC namespace.
 */
export function normalizeUncRoot(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 4096) return null;
  if (trimmed.includes("\0")) return null;
  const normalized = trimmed.replace(/\//g, "\\").replace(/\\+$/, "");
  if (!normalized.startsWith("\\\\")) return null;
  if (normalized.startsWith("\\\\?\\") || normalized.startsWith("\\\\.\\")) return null;
  const parts = normalized.slice(2).split("\\");
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return normalized;
}

/**
 * What the path-classification rules need from the host.
 *
 * `userHome` is REQUIRED and the parameter carries no default, which is the
 * whole point of the type. These rules used to read `homedir()` themselves, and
 * inside a confined child that answers with the sandbox's throwaway — so every
 * home-relative rule stopped matching, and each one still reported that it had
 * checked. Requiring the value turns that into a compile error at the one place
 * it enters, rather than a silent `false` at each place it is used.
 */
interface IndexPathPolicy {
  /** `context.userHome` — the real user's home, as the HOST process reads it. */
  readonly userHome: string;
  readonly allowedUncRoots?: readonly string[];
}

function isBlockedIndexPath(
  absPath: string,
  opts: IndexPathPolicy,
): boolean {
  // NUL 바이트가 포함된 경로는 fs API 가 truncate 시킬 수 있어 검증 우회
  // 가능성 — 즉시 거부.
  if (absPath.includes("\0")) return true;

  if (osPlatform() === "win32") {
    // Windows device-namespace prefix (`\\?\…`, `\\.\…`) 는 정규화된 경로
    // 검사를 우회해 임의 디바이스/심볼릭 링크에 접근 가능. 등록 여부와
    // 무관하게 항상 거부.
    if (absPath.startsWith("\\\\?\\") || absPath.startsWith("\\\\.\\")) return true;
    // UNC root (`\\server\share\...`) 는 기본 거부. 단, 사용자가
    // configSchema 의 `allowedUncRoots` 에 명시한 prefix 로 시작하는
    // 경로만 통과. (잘못 입력된 한 항목이 전체 UNC namespace 를 열지
    // 않도록 normalizeUncRoot 가 최소 `\\server\share` 형태를 강제.)
    if (absPath.startsWith("\\\\")) {
      const normalized = absPath.replace(/\//g, "\\");
      const allowedRoots = opts.allowedUncRoots ?? [];
      const allowed = allowedRoots.some(
        (root) => normalized === root || normalized.startsWith(root + "\\"),
      );
      if (!allowed) return true;
    }
  }

  const home = opts.userHome;
  const tempRoot = resolve(osTmpdir());
  const blockedPrefixes = osPlatform() === "win32"
    ? ["C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)"]
    : [
        "/etc",
        "/usr",
        "/bin",
        "/sbin",
        "/var",
        "/sys",
        "/proc",
        "/dev",
        "/root",
        "/System",
        "/private/etc",
        "/private/var",
      ];
  const sensitiveHome = [
    join(home, ".ssh"),
    join(home, ".gnupg"),
    join(home, ".config"),
    join(home, ".aws"),
    join(home, ".kube"),
    join(home, ".docker"),
    join(home, ".npmrc"),
    join(home, ".pypirc"),
  ];

  return (
    !(
      absPath === tempRoot ||
      absPath.startsWith(tempRoot + pathSep)
    ) && (
      absPath === "/" ||
    blockedPrefixes.some(
      (pref) => absPath === pref || absPath.startsWith(pref + pathSep),
    ) ||
    sensitiveHome.some(
      (s) => absPath === s || absPath.startsWith(s + pathSep),
    )
    )
  );
}

function getBlockedIndexPathMessage(
  absPath: string,
  opts: IndexPathPolicy,
): string | null {
  return isBlockedIndexPath(absPath, opts)
    ? `보안: '${absPath}' 경로는 인덱싱 대상으로 추가할 수 없습니다.`
    : null;
}

// 사용자 홈 디렉터리 바로 아래에 있는지 (중첩된 하위 경로는 제외).
function isHomeChild(absPath: string, userHome: string): boolean {
  const home = resolve(userHome);
  const parent = resolve(dirname(absPath));
  return parent === home;
}

// 다른 사용자의 홈 디렉터리인지 (자기 자신 제외).
// Windows `C:\Users\<x>\`, macOS `/Users/<x>\`, Linux `/home/<x>\` 레이아웃
// 에서 현재 사용자 홈이 아닌 다른 사용자 홈을 검출. multi-user 호스트에서
// 다른 사용자 문서를 인덱스 DB 로 옮기는 경로를 막기 위한 핀포인트
// 차단 — 사용자 홈 외부의 일반 드라이브(`D:\foo`, `/mnt/data`)는 허용한다.
function isOtherUserHome(absPath: string, userHome: string): boolean {
  const home = resolve(userHome);
  // 자기 자신은 차단 대상이 아님
  if (absPath === home || absPath.startsWith(home + pathSep)) return false;
  const userRoots: string[] = [];
  if (osPlatform() === "win32") {
    // 현재 사용자 홈의 부모(예: `C:\Users`) 아래 다른 사용자
    userRoots.push(dirname(home));
  } else {
    userRoots.push("/home", "/Users");
  }
  for (const root of userRoots) {
    if (absPath === root) continue; // 사용자 루트 자체 (예: `C:\Users`) 는 별개 정책
    if (absPath.startsWith(root + pathSep)) return true;
  }
  return false;
}

function isHighChurnFolderPath(absPath: string, userHome: string): boolean {
  const normalized = resolve(absPath);
  const base = basename(normalized).toLowerCase();
  const parent = dirname(normalized);
  // 고변동 루트 차단 — 인덱싱/감시 부하가 비정상적으로 큰 폴더.
  // - Windows: 드라이브 루트 바로 아래 `Downloads` (`D:\Downloads` 등)
  // - macOS / Linux: 사용자 홈 바로 아래 `Downloads` / `Desktop`
  //   (`/Users/<name>/Downloads`, `/home/<name>/Desktop` 등)
  // 기존 코드는 Windows 케이스만 잡아서 macOS/Linux 사용자가 동일한
  // 사고를 그대로 겪었음.
  const isDriveRootParent = /^[A-Za-z]:\\?$/.test(parent);
  if (isDriveRootParent && base === "downloads") return true;
  if (isHomeChild(normalized, userHome) && (base === "downloads" || base === "desktop")) {
    return true;
  }
  return false;
}

async function expandDroppedPaths(
  paths: string[],
  configuredFolders: string[],
  options: IndexPathPolicy & { includeImages?: boolean },
): Promise<{ files: string[]; roots: string[]; blocked: string[] }> {
  const files: string[] = [];
  const fileSeen = new Set<string>();
  const roots: string[] = [];
  const rootSeen = new Set<string>();
  const blocked: string[] = [];
  const blockedSeen = new Set<string>();

  const addRoot = (root: string) => {
    if (rootSeen.has(root)) return;
    rootSeen.add(root);
    roots.push(root);
  };

  const addBlocked = (target: string) => {
    if (blockedSeen.has(target)) return;
    blockedSeen.add(target);
    blocked.push(target);
  };

  const home = options.userHome;
  const blockOpts: IndexPathPolicy = {
    userHome: options.userHome,
    allowedUncRoots: options.allowedUncRoots,
  };
  const visit = async (targetPath: string, inheritedRoot?: string): Promise<void> => {
    const absPath = resolve(targetPath);
    if (isBlockedIndexPath(absPath, blockOpts)) {
      addBlocked(absPath);
      return;
    }
    const withinHome = absPath === home || absPath.startsWith(home + pathSep);
    const withinConfigured = configuredFolders.some((f) => isWithinFolder(absPath, f));
    if (!withinHome && !withinConfigured) {
      addBlocked(absPath);
      return;
    }

    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(absPath);
    } catch {
      return;
    }

    if (metadata.isSymbolicLink()) return;

    if (metadata.isDirectory()) {
      const root = inheritedRoot ?? absPath;
      addRoot(root);
      try {
        const entries = await readdir(absPath, { withFileTypes: true, encoding: "utf8" });
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          await visit(join(absPath, entry.name), root);
        }
      } catch {
        return;
      }
      return;
    }

    if (!metadata.isFile()) return;

    addRoot(inheritedRoot ?? dirname(absPath));
    if (!isIndexableFilePath(absPath, { includeImages: options.includeImages }) || fileSeen.has(absPath)) return;
    fileSeen.add(absPath);
    files.push(absPath);
  };

  for (const filePath of paths) {
    await visit(filePath);
  }

  return { files, roots, blocked };
}

export default async function createPlugin(context: PluginRuntimeContext) {
  // Host contract: `pluginDataDir` is guaranteed by `PluginRuntimeContext`.
  // We assert at runtime so a host build that violates the contract fails
  // loudly here instead of silently writing under `~/.ave/local-indexer/`
  // and leaking plugin state out of its scoped data dir.
  if (typeof context.pluginDataDir !== "string" || context.pluginDataDir.length === 0) {
    throw new Error(
      "[local-indexer] context.pluginDataDir is required (host contract violation). " +
      "Update Ave to a build that injects a scoped pluginDataDir.",
    );
  }
  const pluginDataDir = context.pluginDataDir;
  const config = context.config ?? {};
  const { hostApi } = context;
  // Module-scoped warn-once cache so repeated reads of an invalid endpoint
  // don't spam the log. Keyed by `${role}:${value}`.
  const _warnedEndpoints = new Set<string>();

  // §9.2 Track B: configSchema-declared keys 는 호스트의 `hostApi.config.get`
  // accessor 로 읽는다. SDK 5.x 부터 `hostApi.config.{get,set,onChange}` 는
  // 모두 required 표면이므로 optional-chaining 없이 직접 바인딩.
  const getConfig = hostApi.config.get.bind(hostApi.config);
  // Bound once so the two pure functions at the top of this file can be called
  // from a test with a stub, and so the only place that knows where the answer
  // comes from is here.
  const resolveMappedDriveRoot: MappedDriveResolver = (drive) =>
    hostApi.resolveMappedDriveRoot(drive);
  const setConfig = hostApi.config.set.bind(hostApi.config);
  // Reads from the sidecar cache populated by loadImageSettings(). The
  // helper is sync so it can run inside file-walk loops; the cache is
  // primed at createPlugin time and refreshed by saveImageSettings on
  // every toggle. Until the first load completes (very narrow window
  // at boot) the helper returns the default (false).
  const isImageEmbeddingEnabled = (): boolean =>
    imageSettingsCache?.imageEmbeddingEnabled === true;

  const realtimeWatchRaw = getConfig("realtimeWatch") ?? config.realtimeWatch;
  const realtimeWatchEnabled =
    realtimeWatchRaw === true ||
    (typeof realtimeWatchRaw === "string" && realtimeWatchRaw.toLowerCase() === "true");
  // Packaged Electron hosts may pass `hostRoot` as the app.asar file path.
  // Resolving a relative workspace against that yields `<...>/app.asar/.local-indexer-workspace`
  // and mkdir fails with ENOTDIR. Stage 3 contract guarantees `pluginDataDir`,
  // so use it as the base for relative workspace paths.
  // Absolute config.workspace overrides — preserved verbatim.
  const workspaceConfig =
    typeof config.workspace === "string" && config.workspace.length > 0
      ? config.workspace
      : ".local-indexer-workspace";
  const workspace = isAbsolute(workspaceConfig)
    ? resolve(workspaceConfig)
    : resolve(pluginDataDir, workspaceConfig);

  // Migration probe: warn (and rename if target absent) when existing users have
  // indexed data under the old hostRoot-based path. The probe is deliberately
  // deferred to post-publication startup: createPlugin/start may run for a
  // hidden replacement candidate and must not mutate the incumbent's durable
  // workspace before that candidate owns the active generation pointer.
  const legacyWorkspace = resolve(context.hostRoot, workspaceConfig);
  async function migrateLegacyWorkspace(): Promise<void> {
    if (legacyWorkspace === workspace) return;
    try {
      const legacyExists = await stat(legacyWorkspace).then(() => true, () => false);
      const targetExists = await stat(workspace).then(() => true, () => false);
      if (legacyExists && !targetExists) {
        context.log(`migrating workspace from ${legacyWorkspace} to ${workspace}`);
        // Ensure target parent (pluginDataDir or absolute parent) exists so
        // rename does not fail with ENOENT when the host has not yet created
        // pluginDataDir on first boot.
        await mkdir(dirname(workspace), { recursive: true });
        await rename(legacyWorkspace, workspace);
      }
    } catch (err) {
      // CONFINED CHILD: `legacyWorkspace` sits under `context.hostRoot`, which
      // the child may READ but not WRITE, so the rename half of this arrives as
      // EPERM. That is the designed outcome rather than a fault — what the
      // legacy directory holds is the incremental-scan ledger and worker
      // scratch, all of it REBUILDABLE. The cost of not migrating is one full
      // re-scan, not lost data, which is why nothing here falls back to copying
      // the tree out. Logged with the path so the leftover is findable.
      context.log(
        `workspace migration skipped (${legacyWorkspace} → ${workspace}); `
          + `the index rebuilds from scratch. reason: ${(err as Error).message}`,
      );
    }
  }
  const scanFoldersRaw = getConfig("scanFolders") ?? config.scanFolders;
  const scanFolders = toStringArray(scanFoldersRaw).map((path) => resolve(context.hostRoot, path));

  // ─── allowedUncRoots ──────────────────────────────────────
  // configSchema.allowedUncRoots 에 사용자가 명시한 UNC prefix 만
  // 차단 해제. normalizeUncRoot 가 형태(`\\server\share` 이상)를 강제하고
  // 비정상 값은 빈 배열로 떨어뜨려 차단 전체를 풀어버리지 않는다.
  // 같은 set 이 worker `_validate_file_path_within_roots` 의 root list 에도
  // 추가돼 워커가 UNC 파일을 받았을 때 422 거부하지 않도록 한다.
  const allowedUncRootsRaw = getConfig("allowedUncRoots");
  const allowedUncRoots: readonly string[] = (Array.isArray(allowedUncRootsRaw)
    ? allowedUncRootsRaw
    : [])
    .map(normalizeUncRoot)
    .filter((p): p is string => p !== null);
  // The two paths the host resolves for us. NOT `homedir()`: inside a confined
  // child that answers with the sandbox's throwaway, and every home-relative
  // rule below would go on returning `false` while still reporting that it
  // checked. `aveHome` is separate because `AVE_HOME` can move the storage
  // root — rebuilding `~/.ave` from the home was wrong even in the main
  // process.
  const { userHome, aveHome } = context;
  const blockOpts: IndexPathPolicy = { userHome, allowedUncRoots };

  // pythonExecutable은 Agent 1의 PythonRuntimeBootstrapper가 주입 (필수)
  const pythonExecutable =
    typeof config.pythonExecutable === "string" ? config.pythonExecutable : undefined;

  // ─── pluginDataDir 기반 스토리지 경로 ──────────────────────
  // 호스트가 주입한 scoped data dir 안에서만 쓴다. 폴백 경로는 제거됐다 —
  // pluginDataDir 부재 시 createPlugin 입구에서 즉시 throw.
  const scopedStatePath = join(pluginDataDir, "index-state.json");

  // ─── Image-embedding 설정 sidecar ──────────────────────────
  // hostApi.config.set 은 호스트 버전에 따라 노출되지 않을 수도 있어
  // (set 실패시 UI 토글이 영구화되지 않고 즉시 롤백되는 버그 원인) plugin-
  // local sidecar JSON 으로 직접 영구화한다. config 와 양방향 sync —
  // set 가 있으면 호스트 config view 와도 일관성 유지, 없으면 sidecar 만.
  const imageSettingsPath = join(pluginDataDir, "image-embedding-settings.json");

  // The sidecar only persists the main-UI toggle. Provider / endpoint /
  // model / apiKey all live in host config + secret store now so the
  // user maintains them in Ave's plugin settings UI (single source
  // of truth across plugins).
  type ImageCaptionMode = "cloud";

  type ImageEmbeddingSettings = {
    imageEmbeddingEnabled: boolean;
    imageCaptionMode: ImageCaptionMode;
  };

  const defaultImageSettings: ImageEmbeddingSettings = {
    imageEmbeddingEnabled: false,
    imageCaptionMode: "cloud",
  };

  type CaptionProvider =
    | "openai"
    | "azure-openai-chat"
    | "azure-openai-responses";

  const readDefaultCaptionMode = (): ImageCaptionMode => "cloud";

  const readConfiguredCloudCaptionProvider = (): CaptionProvider | null => {
    const v = getConfig("imageCaptionProvider");
    if (v === "openai" || v === "azure-openai-chat" || v === "azure-openai-responses") {
      return v;
    }
    // 옛 "azure" (AI Vision REST) 가 저장돼 있던 사용자는 호환 위해 새
    // azure-openai-chat 으로 매핑. 두 provider 가 같은 Azure 리소스를 다른
    // surface 로 호출하던 거라 정상 동작은 다시 설정해야 하지만, 적어도
    // schema 검증 실패로 plugin 이 죽지는 않게.
    if (v === "azure") return "azure-openai-chat";
    return null;
  };

  type EmbeddingProvider = "openai" | "azure";

  const readConfiguredEmbeddingProvider = (): EmbeddingProvider | null =>
    validateEmbeddingProvider(
      (getConfig("embeddingProvider") as unknown)
        ?? config.embeddingProvider
        ?? config.embedding_provider,
    ) ?? null;

  const hostEmbeddingProvider = (hostVendor: string): EmbeddingProvider | null => {
    if (/azure/i.test(hostVendor)) return "azure";
    if (hostVendor === "openai") return "openai";
    return null;
  };

  const hostCaptionProvider = (
    hostVendor: string,
    hostBaseUrl?: unknown,
  ): CaptionProvider | null => {
    if (/azure/i.test(hostVendor)) return inferAzureCaptionProviderFromEndpoint(hostBaseUrl);
    if (hostVendor === "openai") return "openai";
    return null;
  };

  const readEmbeddingProvider = (
    opts: { hostVendor?: string } = {},
  ): EmbeddingProvider => {
    if (readApiKeySource() === "host") {
      const provider = hostEmbeddingProvider(opts.hostVendor ?? readActiveVendor());
      if (provider) return provider;
    }
    return readConfiguredEmbeddingProvider() ?? "openai";
  };

  const readCaptionProvider = (
    opts: { hostBaseUrl?: unknown; hostVendor?: string } = {},
  ): CaptionProvider => {
    if (readApiKeySource() === "host") {
      const provider = hostCaptionProvider(opts.hostVendor ?? readActiveVendor(), opts.hostBaseUrl);
      if (provider) return provider;
    }
    const configured = readConfiguredCloudCaptionProvider();
    return configured ?? "openai";
  };
  const isAzureCaptionProvider = (
    provider: string,
  ): provider is "azure-openai-chat" | "azure-openai-responses" =>
    provider === "azure-openai-chat" || provider === "azure-openai-responses";
  // Azure caption settings (deployment name, resource endpoint, api-version)
  // are DERIVED from the host key handle's baseUrl when the host supplies the
  // key. The worker reads "" as "reset to the provider default" and null as
  // "keep current", so a value that could not be derived must not be sent as
  // "": `resolveCaptionHostHandle` returns null transiently (resolveApiKey
  // refused, host busy) and that push would wipe the deployment name and
  // endpoint the worker already holds. Under the host key an empty derivation
  // is therefore "keep"; with the plugin's own key nothing is derived, so an
  // empty result is exactly what the user configured — "", reset.
  const derivedOrKeep = (derived: string): string | null =>
    derived || (readApiKeySource() === "host" ? null : "");
  const readCaptionEndpoint = (
    opts: { provider?: CaptionProvider; hostBaseUrl?: unknown; hostVendor?: string } = {},
  ): string | null => {
    const provider = opts.provider ?? readCaptionProvider({
      hostBaseUrl: opts.hostBaseUrl,
      hostVendor: opts.hostVendor,
    });
    const raw = getConfig("imageCaptionEndpoint");
    if (typeof raw !== "string" || raw.length === 0) {
      return isAzureCaptionProvider(provider)
        ? derivedOrKeep(resolveAzureResourceEndpoint({ hostBaseUrl: opts.hostBaseUrl }))
        : "";
    }
    // Loopback http:// is only legitimate for OpenAI-compatible self-hosted
    // captioners (LM Studio etc.). Azure captioning must always be https.
    const allowLoopback = provider === "openai";
    const ok = validateEndpointUrl(raw, { allowLoopback });
    if (!ok) {
      const key = `caption:${raw}`;
      if (!_warnedEndpoints.has(key)) {
        _warnedEndpoints.add(key);
        hostApi.logEvent("warn", "imageCaptionEndpoint rejected by SSRF guard", {
          value: raw,
          reason: allowLoopback
            ? "scheme must be https, or http+loopback"
            : "scheme must be https (loopback only allowed for openai provider)",
        });
      }
    }
    if (ok) {
      if (
        isAzureCaptionProvider(provider)
        && readApiKeySource() === "host"
        && /azure/i.test(opts.hostVendor ?? readActiveVendor())
        && !isAzureEndpointUrl(ok)
      ) {
        return derivedOrKeep(resolveAzureResourceEndpoint({ hostBaseUrl: opts.hostBaseUrl }));
      }
      return ok;
    }
    return isAzureCaptionProvider(provider)
      ? derivedOrKeep(resolveAzureResourceEndpoint({ hostBaseUrl: opts.hostBaseUrl }))
      : "";
  };
  const readCaptionModel = (
    opts: { provider?: CaptionProvider; hostBaseUrl?: unknown } = {},
  ): string | null => {
    const v = getConfig("imageCaptionModel");
    if (typeof v === "string" && v.trim()) return v.trim();
    if (opts.provider && isAzureCaptionProvider(opts.provider)) {
      return derivedOrKeep(extractAzureDeploymentFromEndpoint(opts.hostBaseUrl));
    }
    return "";
  };
  // Azure-only: api-version 쿼리값. 사용자가 root URL 만 줬을 때 워커가
  // ``/computervision/imageanalysis:analyze?api-version=…`` 를 합성하는
  // 데 사용된다. 사용자가 full URL (path+query) 를 직접 넣었다면 워커는
  // endpoint 를 그대로 쓰고 본 값은 무시됨. 빈 값은 워커 디폴트 적용.
  const readCaptionApiVersion = (
    opts: { provider?: CaptionProvider; hostBaseUrl?: unknown } = {},
  ): string | null => {
    const v = getConfig("imageCaptionApiVersion");
    if (typeof v === "string" && v.trim()) return v.trim();
    const explicitVersion = endpointQueryParam(getConfig("imageCaptionEndpoint"), "api-version");
    if (explicitVersion) return explicitVersion;
    if (opts.provider && isAzureCaptionProvider(opts.provider)) {
      return derivedOrKeep(endpointQueryParam(opts.hostBaseUrl, "api-version"));
    }
    return "";
  };
  const readEmbeddingApiVersion = (): string => {
    const v =
      (getConfig("embeddingApiVersion") as unknown)
      ?? (config as Record<string, unknown>).embeddingApiVersion
      ?? (config as Record<string, unknown>).embedding_api_version;
    if (typeof v === "string" && v.trim()) return v.trim();
    return endpointQueryParam(getConfig("embeddingEndpoint"), "api-version");
  };
  // Resolve a `format: "secret"` config key. Reads ONLY from the host
  // secret store (OS keychain). The previous plaintext-config fallback
  // was removed — falling back to `getConfig(configKey)` allowed an API
  // key to be recovered from a plaintext `pluginConfigs` blob on disk,
  // defeating the point of declaring the key as a secret. If the secret
  // is missing, downstream code should degrade (e.g. BM25-only search),
  // NOT silently use a plaintext value.
  const readSecretFor = async (configKey: string): Promise<string> => {
    const secretKey = `plugin.${context.pluginId}.${configKey}`;
    try {
      const s = await hostApi.getSecret(secretKey);
      if (typeof s === "string" && s) return s;
    } catch {
      // secret-store read failed — treat as "no secret"
    }
    return "";
  };

  // Resolve the apiKeySource toggle. Default "host" — demo environments need
  // no manual key entry. Users who already have plugin-own keys set should
  // switch explicitly to "plugin" (or set it via configSchema).
  const readApiKeySource = (): "host" | "plugin" => {
    const v = getConfig("apiKeySource");
    if (v === "host" || v === "plugin") return v;
    return "host";
  };

  // Read the active LLM vendor from host config (e.g. "openai", "claude").
  const readActiveVendor = (): string => {
    try {
      const v = hostApi.config?.get?.<string>("hostApiVendor");
      return typeof v === "string" && v ? v : "openai";
    } catch {
      return "openai";
    }
  };

  const requestHostLease = async (
    purpose: "embedding" | "vision",
    signal?: AbortSignal,
  ): Promise<ApiKeyLease> => {
    const resolveFn = hostApi.resolveApiKey;
    if (!resolveFn) throw new EgressLeaseDenied("lease-unavailable");
    const activeVendor = readActiveVendor();
    let sdkVendor: "openai" | "azure-openai" | "vertex" | "anthropic" | undefined;
    if (activeVendor === "openai") sdkVendor = "openai";
    else if (/azure/i.test(activeVendor)) sdkVendor = "azure-openai";
    else if (activeVendor === "anthropic" || activeVendor === "claude") sdkVendor = "anthropic";
    else if (activeVendor === "vertex") sdkVendor = "vertex";
    const out = await resolveFn({ purpose, vendor: sdkVendor, exposure: "lease", signal });
    if (!out.ok) throw new EgressLeaseDenied(out.reason);
    if (out.exposure !== "lease") {
      await out.release();
      throw new EgressLeaseDenied("credential-conflict");
    }
    return out;
  };

  // Metadata probes release their lease before returning. Only the broker
  // holds a live lease while an upstream response is being buffered.
  const resolveHostKeyHandle = async (
    purpose: "embedding" | "vision", signal?: AbortSignal,
  ): Promise<ApiKeyLease | null> => {
    if (readApiKeySource() !== "host") return null;
    try {
      const lease = await requestHostLease(purpose, signal);
      await lease.release();
      return lease;
    } catch (err) {
      hostApi.logEvent("warn", "local_indexer.resolve_api_key.failed", {
        purpose,
        reason: err instanceof EgressLeaseDenied ? err.reason : "transport-failure",
      });
      return null;
    }
  };

  const resolveCaptionHostHandle = (signal?: AbortSignal): Promise<ApiKeyLease | null> =>
    resolveHostKeyHandle("vision", signal);

  // ── Host-key trust chokepoint ──────────────────────────────────────────
  // SECURITY: the host's shared chat key (apiKeySource="host") must NEVER be
  // forwarded to a user-supplied custom endpoint. Routing a host-managed
  // bearer at an arbitrary `base_url` would let a malicious config-import
  // exfiltrate the key. The host key is only ever allowed to reach the
  // first-party trusted domains (isTrustedEndpointUrl). A custom endpoint
  // must use plugin-key mode explicitly; host mode never switches key source.
  //
  // `endpoint` is the user-controlled config value (`embeddingEndpoint` /
  // `imageCaptionEndpoint`). Empty endpoint = provider default (api.openai.com
  // / Azure resource) = trusted, so the host key is used.
  const isUntrustedHostEndpoint = (endpoint: unknown): boolean => {
    if (readApiKeySource() !== "host") return false;
    if (typeof endpoint !== "string" || endpoint.length === 0) return false;
    return !isTrustedEndpointUrl(endpoint);
  };

  // One-time-per-endpoint warning when the host key is withheld.
  const warnHostKeyWithheld = (
    kind: "embedding" | "caption",
    endpoint: unknown,
  ): void => {
    const host = typeof endpoint === "string" ? endpointHostForLog(endpoint) : "";
    const dedupeKey = `host-key-withheld:${kind}:${host}`;
    if (_warnedEndpoints.has(dedupeKey)) return;
    _warnedEndpoints.add(dedupeKey);
    hostApi.logEvent("warn", "local_indexer.host_key_withheld_custom_endpoint", {
      kind,
      endpointHost: host,
      reason:
        "host LLM key withheld from untrusted custom endpoint (apiKeySource=host); " +
        "using plugin-own key slot if present",
    });
  };

  // Plugin-owned key slots are used only in plugin mode. The OPENAI_API_KEY
  // env fallback is an explicit dev opt-in
  // (AVE_ALLOW_ENV_API_KEY=1), not the host's shared chat key, so it is part
  // of the plugin-own resolution chain.
  const pluginOwnCaptionKey = async (): Promise<string> => {
    const dedicated = await readSecretFor("imageCaptionApiKey");
    if (dedicated) return dedicated;
    if (process.env.AVE_ALLOW_ENV_API_KEY === "1" && process.env.OPENAI_API_KEY) {
      return process.env.OPENAI_API_KEY;
    }
    return "";
  };
  const pluginOwnEmbeddingKey = async (): Promise<string> => {
    const dedicated = await readSecretFor("embeddingApiKey");
    if (dedicated) return dedicated;
    if (process.env.AVE_ALLOW_ENV_API_KEY === "1" && process.env.OPENAI_API_KEY) {
      return process.env.OPENAI_API_KEY;
    }
    return "";
  };

  // Plugin-owned keys are read only in plugin mode. Host mode carries no key.
  const readCaptionApiKey = async (): Promise<string> => {
    if (isUntrustedHostEndpoint(getConfig("imageCaptionEndpoint"))) {
      warnHostKeyWithheld("caption", getConfig("imageCaptionEndpoint"));
      return "";
    }
    if (readApiKeySource() === "plugin") return pluginOwnCaptionKey();
    const lease = await resolveCaptionHostHandle();
    return lease ? "host-lease-present" : "";
  };

  const readEmbeddingApiKey = async (): Promise<string> => {
    if (isUntrustedHostEndpoint(getConfig("embeddingEndpoint"))) {
      warnHostKeyWithheld("embedding", getConfig("embeddingEndpoint"));
      return "";
    }
    return readApiKeySource() === "plugin" ? pluginOwnEmbeddingKey() : "";
  };

  // A returned lease is a presence marker for existing worker configuration
  // checks. The worker receives the broker token; only the broker uses the
  // lease with hostFetch. A denied host lease never switches to plugin key.
  const resolveEmbeddingKeyForEndpoint = async (
    endpoint: unknown,
    handle: ApiKeyLease | null,
  ): Promise<string> => {
    if (isUntrustedHostEndpoint(endpoint)) {
      warnHostKeyWithheld("embedding", endpoint);
      return "";
    }
    if (readApiKeySource() !== "host") return pluginOwnEmbeddingKey();
    return handle ? "host-lease-present" : "";
  };
  const resolveCaptionKeyForEndpoint = async (
    endpoint: unknown,
    handle: ApiKeyLease | null,
  ): Promise<string> => {
    if (isUntrustedHostEndpoint(endpoint)) {
      warnHostKeyWithheld("caption", endpoint);
      return "";
    }
    if (readApiKeySource() !== "host") return pluginOwnCaptionKey();
    return handle ? "host-lease-present" : "";
  };

  let imageSettingsCache: ImageEmbeddingSettings | null = null;
  // Promise-chain mutex serialises concurrent saveImageSettings calls so
  // (a) the in-memory cache and the on-disk sidecar can never diverge,
  // and (b) we never write a torn JSON file under fast UI clicks.
  let imageSettingsTail: Promise<void> = Promise.resolve();

  const loadImageSettings = async (): Promise<ImageEmbeddingSettings> => {
    if (imageSettingsCache) return imageSettingsCache;
    let merged: ImageEmbeddingSettings = { ...defaultImageSettings };
    // Prefer the sidecar (write path always honoured). Fall back to host
    // config keys for first-boot migration when only the host knew them.
    try {
      const raw = await readFile(imageSettingsPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<ImageEmbeddingSettings>;
      merged = {
        imageEmbeddingEnabled: parsed.imageEmbeddingEnabled === true,
        imageCaptionMode: "cloud",
      };
    } catch {
      const cfgEnabled = getConfig("imageEmbeddingEnabled");
      merged = {
        imageEmbeddingEnabled: cfgEnabled === true,
        imageCaptionMode: readDefaultCaptionMode(),
      };
    }
    imageSettingsCache = merged;
    return merged;
  };

  const saveImageSettings = (next: ImageEmbeddingSettings): Promise<void> => {
    // Append to the mutex tail. The runner updates the cache AFTER the
    // disk write succeeds, so a failed write leaves the cache untouched
    // (next loadImageSettings would re-read from disk / config fallback).
    const run = async () => {
      const tmpPath = `${imageSettingsPath}.tmp`;
      try {
        await mkdir(dirname(imageSettingsPath), { recursive: true });
        // tmp + rename = atomic — a crash mid-write leaves either the old
        // file or the fully-written new file, never a torn JSON. Mirrors
        // the loadPersistedFolders write path elsewhere in this module.
        await writeFile(tmpPath, JSON.stringify(next, null, 2), "utf-8");
        await rename(tmpPath, imageSettingsPath);
        imageSettingsCache = next;
      } catch (err) {
        hostApi.logEvent("warn", "image_settings.write_failed", {
          path: imageSettingsPath,
          error: (err as Error).message,
        });
        // Surface the error so the UI rolls back the toggle.
        throw new Error(
          `이미지 캡션 설정 저장 실패 (${imageSettingsPath}): ${(err as Error).message}`,
        );
      }
      // Mirror to host config when supported. Failure is informational —
      // sidecar is the source of truth for read.
      if (setConfig) {
        try {
          // Only the toggle round-trips through the main-UI path; the
          // rest (provider / endpoint / model / apiKey) is owned by the
          // plugin-config / secret-store flow.
          await setConfig("imageEmbeddingEnabled", next.imageEmbeddingEnabled);
        } catch (err) {
          hostApi.logEvent("warn", "image_settings.config_set_failed", {
            error: (err as Error).message,
          });
        }
      }
    };
    // Chain via .then(run, run): both fulfilled and rejected tails should
    // run the next task so a transient save failure doesn't poison the
    // mutex. Each caller gets its own promise from the chain.
    const result = imageSettingsTail.then(run, run);
    imageSettingsTail = result.catch(() => undefined);
    return result;
  };

  // ─── persisted folders 사전 로드 ───────────────────────────
  // ensureStarted가 그 이후에 다시 loadPersistedFolders를 호출하지만, plugin
  // spawn 시점의 allowedRoots에 사용자 추가 폴더를 포함시키려면 createPlugin
  // 시점에서 미리 로드해야 한다. 그렇지 않으면 사용자가 추가한 folder
  // (예: ~/Downloads) 의 파일이 worker에서 422로 거부됨.
  const foldersConfigPath = join(workspace, "folders.json");
  const indexStateStores = [
    new IndexState(join(workspace, "index-state.json")),
    new IndexState(scopedStatePath),
  ];
  let earlyPersistedFolders: string[] = [];
  try {
    if (existsSync(foldersConfigPath)) {
      const raw = await readFile(foldersConfigPath, "utf-8");
      const parsed = JSON.parse(raw) as { folders?: string[] };
      if (Array.isArray(parsed.folders)) {
        earlyPersistedFolders = parsed.folders.map((f: string) => resolve(f));
      }
    }
  } catch {
    /* parse 실패 시 빈 list — ensureStarted의 loadPersistedFolders가 다시 시도 */
  }

  // worker `_validate_file_path_within_roots` 가 422로 거부하지 않도록
  // host가 single source of truth로 indexing 허용 root list를 명시.
  // workspace + scan folders + persisted folders + hostRoot + ~/.ave 합집합.
  const allowedRoots = Array.from(
    new Set([
      workspace,
      context.hostRoot,
      ...scanFolders,
      ...earlyPersistedFolders,
      // User-allow-listed UNC prefixes. The worker uses `os.path.commonpath`
      // for the root check, which on Windows correctly treats UNC strings
      // as path-comparable. Each entry has already been validated by
      // normalizeUncRoot above.
      ...allowedUncRoots,
      aveHome,
    ]),
  );

  // configSchema-declared values take precedence; fall back to legacy config blob,
  // then environment variables. `apiKey` has `format: "secret"` so the host
  // routes it through setSecret/getSecret using the namespaced key
  // `plugin.<pluginId>.apiKey` (see ave/src/ipc/domains/plugins.ts) —
  // we must read it with the same key, NOT bare "apiKey".
  //
  // Boot-time embedding key resolution: dedicated slot only. The legacy
  // shared `apiKey` field is removed from the configSchema — users now
  // input keys in the two dedicated slots ([임베딩] / [캡션]).
  // ``AVE_ALLOW_ENV_API_KEY=1`` opt-in still allows an OS env-var
  // fallback (dev convenience) and is logged when it wins.
  const embeddingApiKey = readApiKeySource() === "host"
    ? "" // hydrateEmbeddingBootConfig probes the lease before worker start
    : await readEmbeddingApiKey();
  if (!embeddingApiKey
      && process.env.AVE_ALLOW_ENV_API_KEY !== "1"
      && process.env.OPENAI_API_KEY) {
    hostApi.logEvent("warn", "local_indexer.api_key.env_ignored", {
      reason: "OPENAI_API_KEY in env but AVE_ALLOW_ENV_API_KEY!=1; not used",
    });
  }
  const embeddingModel = validateEmbeddingModel(
    (getConfig("embeddingModel") as unknown) ?? config.embeddingModel ?? config.embedding_model,
  );
  const embeddingProvider = readEmbeddingProvider({ hostVendor: readActiveVendor() });
  // Azure / custom OpenAI-compatible endpoint URL for embeddings. Required
  // when provider="azure"; optional override for "openai" (LM Studio /
  // LiteLLM / internal proxies). Always read fresh from host config so a
  // user edit in plugin settings takes effect on next worker spawn.
  // SSRF guard: accept only https://*. Loopback http:// is only allowed
  // when provider="openai" (legitimate self-hosted OpenAI-compatible).
  // Azure embeddings must always be https — there is no legitimate
  // loopback Azure deployment, and allowing http://127.0.0.1 here would
  // let a malicious config-import steer the worker at arbitrary local
  // services (Ollama, Redis, etc.).
  // Invalid values are downgraded to "" (provider default) and warn-logged
  // once per session.
  const _embeddingEndpointRaw = getConfig("embeddingEndpoint");
  const _embeddingAllowLoopback = embeddingProvider === "openai";
  const validatedEmbeddingEndpoint =
    typeof _embeddingEndpointRaw === "string"
      ? validateEndpointUrl(_embeddingEndpointRaw, { allowLoopback: _embeddingAllowLoopback })
      : "";
  if (
    typeof _embeddingEndpointRaw === "string"
    && _embeddingEndpointRaw.length > 0
    && !validatedEmbeddingEndpoint
  ) {
    const key = `embedding:${_embeddingEndpointRaw}`;
    if (!_warnedEndpoints.has(key)) {
      _warnedEndpoints.add(key);
      hostApi.logEvent("warn", "embeddingEndpoint rejected by SSRF guard", {
        value: _embeddingEndpointRaw,
        reason: _embeddingAllowLoopback
          ? "scheme must be https, or http+loopback"
          : "scheme must be https (loopback only allowed for openai provider)",
      });
    }
  }
  const configuredCaptionProvider = readCaptionProvider({ hostVendor: readActiveVendor() });
  const embeddingEndpoint =
    embeddingProvider === "azure"
      ? (
          typeof _embeddingEndpointRaw === "string" && _embeddingEndpointRaw.length > 0
            ? endpointRoot(validatedEmbeddingEndpoint)
            : resolveAzureResourceEndpoint({
                fallbackEndpoint: isAzureCaptionProvider(configuredCaptionProvider)
                  ? readCaptionEndpoint()
                  : "",
              })
        )
      : validatedEmbeddingEndpoint;
  const embeddingApiVersion = readEmbeddingApiVersion();

  // Worker stdout warning surfacer ─────────────────────────────────────
  // Known event types and a human-readable label. The worker emits one
  // JSON object per line at INFO level; everything else (non-JSON, debug
  // chatter) is ignored. We dedupe by `${event}:${path}` so a single
  // misconfigured folder doesn't spam the host event bus 100 times.
  type IndexWarningPayload = {
    kind: string;
    path?: string;
    docId?: string;
    reason?: string;
    error?: string;
    message: string;
    [key: string]: unknown;
  };
  type WorkerWarning = IndexWarningPayload & {
    kind:
      | "caption.rejected_path"
      | "caption.failed"
      | "embed.skipped"
      | "file.empty"
      | "indexDocument.failed";
  };
  const MAX_INDEX_WARNINGS = 50;
  const recentIndexWarnings: IndexWarningPayload[] = [];
  const recentIndexWarningKeys = new Set<string>();
  const getIndexWarningKey = (warning: IndexWarningPayload): string =>
    [
      warning.kind,
      typeof warning.path === "string" ? warning.path : "",
      typeof warning.docId === "string" ? warning.docId : "",
      typeof warning.reason === "string" ? warning.reason : "",
      typeof warning.error === "string" ? warning.error : "",
      warning.message,
    ].join("\u0000");
  const clearRecentIndexWarnings = (): void => {
    recentIndexWarnings.length = 0;
    recentIndexWarningKeys.clear();
  };
  const rememberIndexWarning = (warning: IndexWarningPayload): void => {
    const key = getIndexWarningKey(warning);
    if (recentIndexWarningKeys.has(key)) return;
    recentIndexWarningKeys.add(key);
    recentIndexWarnings.push({ ...warning });
    if (recentIndexWarnings.length > MAX_INDEX_WARNINGS) {
      recentIndexWarnings.splice(0, recentIndexWarnings.length - MAX_INDEX_WARNINGS);
      recentIndexWarningKeys.clear();
      for (const item of recentIndexWarnings) {
        recentIndexWarningKeys.add(getIndexWarningKey(item));
      }
    }
  };
  const emitIndexWarning = (warning: IndexWarningPayload): void => {
    rememberIndexWarning(warning);
    hostApi.emitEvent("index.warning", warning);
  };
  const _surfacedWarningKeys = new Set<string>();
  const _surfaceWarning = (w: WorkerWarning): void => {
    const dedupeKey = `${w.kind}:${w.path ?? w.docId ?? ""}:${w.reason ?? w.error ?? ""}`;
    if (_surfacedWarningKeys.has(dedupeKey)) return;
    _surfacedWarningKeys.add(dedupeKey);
    // Cap memory: rotate to a recent window. 200 distinct warnings per
    // scan session is more than any reasonable UI needs to display.
    if (_surfacedWarningKeys.size > 200) {
      _surfacedWarningKeys.clear();
      _surfacedWarningKeys.add(dedupeKey);
    }
    hostApi.logEvent("warn", `local_indexer.worker.${w.kind}`, w);
    emitIndexWarning(w);
  };
  const handleWorkerStdoutLine = (line: string): void => {
    // Fast path: only inspect lines that mention one of our known events.
    if (
      !line.includes("caption.rejected_path")
      && !line.includes("caption.failed")
      && !line.includes("indexer.file.empty")
      && !line.includes("indexer.file.embed.skipped")
    ) {
      return;
    }
    const jsonStart = line.indexOf("{");
    if (jsonStart < 0) return;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line.slice(jsonStart)) as Record<string, unknown>;
    } catch {
      return;
    }
    const event = typeof obj.event === "string" ? obj.event : "";
    const path = typeof obj.path === "string" ? obj.path : undefined;
    const docId = typeof obj.doc_id === "string" ? obj.doc_id : undefined;
    const error = typeof obj.error === "string" ? obj.error : undefined;
    const reason = typeof obj.reason === "string" ? obj.reason : undefined;
    if (event === "indexer.caption.rejected_path") {
      _surfaceWarning({
        kind: "caption.rejected_path",
        path,
        docId,
        error,
        message:
          "이미지 캡션이 거부됨: 워커의 allowed_roots 밖 경로. " +
          "매핑 네트워크 드라이브의 백킹 UNC 경로 매칭 문제일 가능성이 큼. " +
          "(파일: " + (path ?? "?") + ")",
      });
    } else if (event === "indexer.caption.failed") {
      // 캡션 provider 가 응답은 했지만 비-OK 상태 (4xx/5xx) 였거나 응답
      // 파싱 실패. error 문자열에 HTTP status + 본문 일부가 들어있어
      // 그대로 노출. 가장 흔한 케이스: Azure resource URL 오타로 404,
      // API 키 만료로 401, 비용 한도 초과로 429.
      _surfaceWarning({
        kind: "caption.failed",
        path,
        docId,
        error,
        message:
          "이미지 캡션 실패: " + (error ?? "원인 불명") + ". " +
          "플러그인 설정의 캡션 endpoint URL / API 키 / 리소스 이름 확인. " +
          "(파일: " + (path ?? "?") + ")",
      });
    } else if (event === "indexer.file.empty") {
      _surfaceWarning({
        kind: "file.empty",
        path,
        docId,
        message:
          "파일 내용이 비어 인덱싱이 실패함. 이미지의 경우 캡션 거부가 원인일 수 있음. " +
          "(파일: " + (path ?? "?") + ")",
      });
    } else if (event === "indexer.file.embed.skipped") {
      _surfaceWarning({
        kind: "embed.skipped",
        path,
        docId,
        reason,
        message:
          "임베딩이 생략됨: " + (reason ?? "원인 불명") + ". " +
          "API 키/endpoint 설정 또는 네트워크 상태 확인 필요. " +
          "(파일: " + (path ?? "?") + ")",
      });
    }
  };

  // Operational guardrails — read from plugin configSchema defaults when not
  // explicitly set. Invalid (non-finite / negative) values fall through to
  // undefined so localIndexerPlugin uses the Python worker's built-in defaults
  // (50 MB / 2000 chunks) rather than passing a nonsensical arg.
  const _maxFileSizeRaw = getConfig("maxFileSize") ?? config.maxFileSize;
  const maxFileSize =
    typeof _maxFileSizeRaw === "number" && Number.isFinite(_maxFileSizeRaw) && _maxFileSizeRaw >= 0
      ? Math.floor(_maxFileSizeRaw)
      : undefined;
  const _maxChunksPerDocRaw = getConfig("maxChunksPerDoc") ?? config.maxChunksPerDoc;
  const maxChunksPerDoc =
    typeof _maxChunksPerDocRaw === "number" && Number.isFinite(_maxChunksPerDocRaw) && _maxChunksPerDocRaw >= 1
      ? Math.floor(_maxChunksPerDocRaw)
      : undefined;
  // The worker's TCP port. Left unset this falls through to localIndexerPlugin's
  // 43129, which is fine for one instance and fatal for a second: the port is
  // what the worker binds, so a second Ave on the same machine could not start
  // local-indexer at all, and there was no way to say otherwise. Out-of-range
  // values fall through to undefined rather than being clamped — a nonsensical
  // port is a configuration mistake worth leaving at the default, not worth
  // silently rewriting into a different port than the user asked for.
  const _workerPortRaw = getConfig("workerPort") ?? config.workerPort;
  const workerPort =
    typeof _workerPortRaw === "number" &&
    Number.isFinite(_workerPortRaw) &&
    _workerPortRaw >= 1024 &&
    _workerPortRaw <= 65535
      ? Math.floor(_workerPortRaw)
      : undefined;

  // 호스트-중재 워커 spawn capability. 주입되면 워커는 host가 ASRT-confined로
  // 띄운다. socketPath가 있으면 UDS control, null이면 TCP control(gate-off
  // plain spawn 또는 Windows ASRT-wrapped)이다.
  const spawnWorker =
    typeof hostApi.spawnWorker === "function"
      ? hostApi.spawnWorker.bind(hostApi)
      : undefined;
  const hostFetch =
    typeof hostApi.hostFetch === "function"
      ? hostApi.hostFetch.bind(hostApi)
      : undefined;
  if (!hostFetch) {
    throw new Error(
      "[local-indexer] requires hostApi.hostFetch for broker upstream egress. " +
      "Update Ave to a host build that exposes hostFetch.",
    );
  }
  const egressUpstreamFetch: EgressUpstreamFetch = async (url, init) => {
    const response = await hostFetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body ? bufferToArrayBuffer(init.body) : undefined,
      ...(init.lease ? { auth: { lease: init.lease.leaseId } } : {}),
      signal: init.signal,
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return {
      status: response.status,
      headers,
      body: Buffer.from(await response.arrayBuffer()),
    };
  };

  // ── Host-mediated egress broker channels (P3 ⑬) ───────────────────────
  // Build the two channel resolvers the plugin's `EgressBroker` consumes. Each
  // is a thunk re-run host-side, fresh per request — it NEVER leaves the host
  // process and the worker has no input into the upstream host or the key:
  //   - upstreamBaseUrl is whatever the worker's SDK base_url WOULD have been
  //     (OpenAI default `…/v1`, an SSRF-validated custom endpoint, or the Azure
  //     resource root), resolved host-side from config;
  //   - host mode resolves a new lease and lets hostFetch attach its key;
  //     plugin mode reads only the plugin-owned key slot;
  //   - authScheme selects the plugin-owned key header. The worker carries
  //     only the x-ave-egress-token and cannot name the upstream authority.
  const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";
  const safeOrigin = (value: unknown): string => {
    if (typeof value !== "string" || value.length === 0) return "";
    try {
      return new URL(value).origin;
    } catch {
      return "";
    }
  };
  const embeddingUpstreamBase =
    embeddingProvider === "azure"
      ? embeddingEndpoint
      : (embeddingEndpoint || OPENAI_DEFAULT_BASE);
  const embeddingAuthScheme: EgressAuthScheme =
    embeddingProvider === "azure" ? "api-key" : "bearer";
  const embeddingChannel: EgressChannel = async (signal) => {
    if (readApiKeySource() === "host") {
      if (isUntrustedHostEndpoint(getConfig("embeddingEndpoint"))) {
        throw new EgressLeaseDenied("audience-not-allowlisted");
      }
      const lease = await requestHostLease("embedding", signal);
      return {
        upstreamBaseUrl: embeddingUpstreamBase || lease.baseUrl || "",
        lease,
        authScheme: embeddingAuthScheme,
      };
    }
    return {
      upstreamBaseUrl: embeddingUpstreamBase,
      apiKey: await pluginOwnEmbeddingKey(),
      authScheme: embeddingAuthScheme,
    };
  };
  const captionChannel: EgressChannel = async (signal) => {
    const provider = readCaptionProvider({ hostVendor: readActiveVendor() });
    if (isUntrustedHostEndpoint(getConfig("imageCaptionEndpoint"))) {
      throw new EgressLeaseDenied("audience-not-allowlisted");
    }
    const lease = readApiKeySource() === "host" ? await requestHostLease("vision", signal) : undefined;
    const apiKey = lease ? undefined : await pluginOwnCaptionKey();
    // `null` from the resolver is the worker-push "keep"; a per-request
    // upstream has nothing to keep, so an underivable endpoint is no upstream
    // here (the empty string it always was).
    if (isAzureCaptionProvider(provider)) {
      const ep = readCaptionEndpoint({ provider, hostVendor: readActiveVendor() }) ?? "";
      return { upstreamBaseUrl: endpointRoot(ep) || ep || lease?.baseUrl || "", apiKey, lease, authScheme: "api-key" as const };
    }
    const ep = readCaptionEndpoint({ provider }) ?? "";
    return { upstreamBaseUrl: ep || lease?.baseUrl || OPENAI_DEFAULT_BASE, apiKey, lease, authScheme: "bearer" as const };
  };
  // Defence-in-depth allow-list: the worker cannot name a host, so this only
  // ever sees the host-resolved bases above. Trusted first-party suffixes pass;
  // the only non-trusted bases are the user's own SSRF-validated custom
  // OpenAI-compatible endpoints (LM Studio / LiteLLM / internal proxy).
  const customEmbeddingOrigin =
    embeddingProvider !== "azure" ? safeOrigin(embeddingEndpoint) : "";
  const isEgressUpstreamAllowed = (url: string): boolean => {
    if (isTrustedEndpointUrl(url)) return true;
    const origin = safeOrigin(url);
    if (!origin) return false;
    if (customEmbeddingOrigin && origin === customEmbeddingOrigin) return true;
    // Custom OpenAI-compatible caption endpoint (resolved fresh — caption
    // provider can differ from embedding).
    const captionProvider = readCaptionProvider({ hostVendor: readActiveVendor() });
    if (!isAzureCaptionProvider(captionProvider)) {
      const captionOrigin = safeOrigin(readCaptionEndpoint({ provider: captionProvider }));
      if (captionOrigin && origin === captionOrigin) return true;
    }
    return false;
  };
  // Corp-CA trust moves to the broker's upstream client (it terminates provider
  // TLS now). Mirror the worker's optional-corp-CA presence check.
  // ONE resolution, ONE existence check, for BOTH consumers: the broker's
  // upstream TLS and the worker's `SSL_CERT_FILE`. It used to be computed
  // twice — here and again in `localIndexerPlugin` — and two copies of a path
  // is how the broker and the worker come to disagree about whether corporate
  // TLS is being intercepted.
  const corpCaPemPath = resolve(aveHome, "certs", "corp-ca.pem");
  const corpCaPath = existsSync(corpCaPemPath) ? corpCaPemPath : null;

  const plugin = new LocalIndexerPlugin({
    workspace,
    pluginDataDir: context.pluginDataDir,
    // Where the egress broker binds its Unix socket. The host creates this
    // directory and registers it with the sandbox before the child starts; a
    // socket anywhere else — this plugin's own writable `data` dir included —
    // is refused. Passed on every platform; the broker reads it only on the
    // ones that bind a Unix socket.
    pluginSocketDir: context.pluginSocketDir,
    indexStorageRoot: typeof config.indexStorageRoot === "string" ? config.indexStorageRoot : process.env.LOCAL_INDEXER_ROOT,
    apiKey: embeddingApiKey,
    pythonExecutable,
    allowedRoots,
    spawnWorker,
    embeddingModel,
    embeddingProvider,
    embeddingEndpoint,
    embeddingApiVersion,
    maxFileSize,
    maxChunksPerDoc,
    port: workerPort,
    // P3 ⑬: host-mediated egress broker. With this wired the worker never
    // receives the provider key — only a per-session broker token.
    egressChannels: { embedding: embeddingChannel, caption: captionChannel },
    isUpstreamAllowed: isEgressUpstreamAllowed,
    corpCaPath,
    egressUpstreamFetch,
    onEgressEvent: (level, event, fields) => hostApi.logEvent(level, event, fields),
    // #955: forward the host's active LLM vendor so the embedding/captioning
    // provider auto-inherits Azure when the host is Azure AI Foundry. Plugin-
    // level explicit overrides (embeddingProvider / embeddingModel prefix)
    // still take precedence inside resolveEmbeddingProvider.
    hostVendor: readActiveVendor(),
    onWorkerStdout: (line) => {
      context.log(line);
      // Surface critical worker events as UI-visible warnings. The worker
      // logs path-confinement failures (`caption.rejected_path`) and other
      // soft errors at INFO level only, which means a misconfigured allowed-
      // roots / embedding endpoint / API key silently produces `file.empty`
      // results and the user has no idea why indexing keeps failing.
      // We parse only the known event types and forward them as a single
      // `index.warning` host event so the UI can render an actionable banner.
      handleWorkerStdoutLine(line);
    },
    onWorkerStderr: (line) => context.log(`[stderr] ${line}`),
    // #955 round-2 architect Minor: forward azure-inherit config warnings
    // as a host event so the UI can render an actionable banner. Stderr
    // remains the log archival path.
    //
    // We reuse the existing `index.warning` channel (declared in plugin.json
    // emittedEvents) with a `kind` discriminator instead of introducing a
    // new event name — the host's emittedEvents contract restricts plugins
    // to the public `index.*` namespace (knowledge-index capability), so a
    // new `local_indexer.*` event would be rejected at the manifest layer
    // (see test/securityHardening.test.ts).
    onConfigWarning: (warning) => {
      hostApi.logEvent("warn", "local_indexer.azure_inherit_missing_config", {
        missing: warning.missing,
        inheritedFrom: warning.inheritedFrom,
      });
      emitIndexWarning({
        kind: "azure-inherit-missing-config",
        missing: warning.missing.join(", "),
        inheritedFrom: warning.inheritedFrom,
        message:
          `Azure 임베딩 설정 누락: ${warning.missing.join(", ")} ` +
          `(${warning.inheritedFrom}). 플러그인 설정에서 endpoint URL과 API 키를 입력하세요.`,
      });
    },
  });

  // workerClient — WorkerClient 인스턴스
  const workerClient = plugin.getWorkerClient();

  // ── Egress credential push (P3 ⑬) ──────────────────────────────────────
  // What the host pushes to the worker over the control channel:
  // Always the per-session BROKER TOKEN, never the provider key. The worker
  // presents it as `x-ave-egress-token`; the broker injects the real provider
  // auth host-side through hostApi.hostFetch. The token is always present, so
  // query-time vector search and key rotation work through the broker without a
  // worker restart (the broker resolves the real key fresh per request).
  const embeddingCredentialFor = (
    _handle: ApiKeyLease | null,
  ): string => plugin.getEgressToken() ?? "";
  const captionCredentialFor = (
    _handle: ApiKeyLease | null,
  ): string => plugin.getEgressToken() ?? "";

  // §4.4 LRU Query Cache — 반복 쿼리 최적화
  const structureCache = new LruCache<unknown>({ maxSize: 32, ttlMs: 5 * 60_000 });
  const contentCache = new LruCache<PageContentItem[]>({ maxSize: 64, ttlMs: 5 * 60_000 });

  // M2 fix: let으로 선언하여 rebuildIndexer에서 재할당 가능하게
  let autoIndexer = new FolderAutoIndexer({
    client: plugin,
    folders: scanFolders.length > 0 ? scanFolders : [resolve(context.hostRoot, "fixtures")],
    imageEmbeddingEnabled: isImageEmbeddingEnabled(),
  });

  let folderSummaryVersion = 0;
  const folderSummaryCache = new Map<
    string,
    { summary: FolderIndexSummary; cachedAt: number; version: number }
  >();

  function getFolderSummaryCacheKey(targetFolder: string, quick = false): string {
    return quick ? `${targetFolder}\0quick` : targetFolder;
  }

  function invalidateFolderSummaryCache(targetFolder?: string): void {
    folderSummaryVersion += 1;
    if (targetFolder) {
      // quick / non-quick 양쪽 키 모두 정리.
      folderSummaryCache.delete(getFolderSummaryCacheKey(targetFolder));
      folderSummaryCache.delete(getFolderSummaryCacheKey(targetFolder, true));
      return;
    }
    folderSummaryCache.clear();
  }

  const bindIndexerCallbacks = (indexer: FolderAutoIndexer) => {
    indexer.onFileIndexed = async (filePath, docId) => {
      invalidateFolderSummaryCache();
      try {
        await recordIndexedState(filePath, docId);
        hostApi.logEvent("info", "local_indexer.record_state_ok", { filePath, docId });
      } catch (err) {
        hostApi.logEvent("warn", "local_indexer.record_state_failed", {
          filePath,
          docId,
          error: (err as Error).message,
        });
      }
      structureCache.invalidate(docId);
      contentCache.invalidate(docId);
      hostApi.emitEvent("index.document.updated", {
        docId,
        path: filePath,
        message: `문서 인덱싱 완료: ${filePath}`,
      });
    };
    indexer.onFileFailed = async (filePath, docId, error) => {
      invalidateFolderSummaryCache();
      const stateResults = await Promise.allSettled(indexStateStores.map((store) => store.removeEntry(filePath)));
      const stateFails = stateResults.filter((r) => r.status === "rejected").length;
      if (stateFails > 0) {
        hostApi.logEvent("warn", "local_indexer.remove_failed_file_state_partial_failure", { filePath, failed: stateFails });
      } else {
        hostApi.logEvent("info", "local_indexer.remove_failed_file_state_ok", { filePath, docId });
      }
      // Also remove from DB so the folder summary (built from DB when worker is running)
      // shows the file as pending rather than indexed.
      if (docId) {
        try {
          await plugin.removeDocument(docId);
          hostApi.logEvent("info", "local_indexer.remove_failed_file_db_ok", { filePath, docId });
        } catch (err) {
          hostApi.logEvent("warn", "local_indexer.remove_failed_file_db_failure", { filePath, docId, error: (err as Error).message });
        }
      }
      // Surface the per-file failure to the UI warning banner so the top
      // scan-status string can stay generic. The raw error message from
      // indexDocument (e.g. "indexDocument: 인덱싱 실패 (path): empty content")
      // contains the worker's `errors[]` array contents which are the most
      // useful debug hint for the user.
      emitIndexWarning({
        kind: "indexDocument.failed",
        path: filePath,
        docId,
        error: error ?? "원인 불명",
        message:
          "파일 인덱싱 실패: " + (error ?? "원인 불명") +
          " (파일: " + filePath + ")",
      });
    };
    indexer.onFileRemoved = async (filePath) => {
      invalidateFolderSummaryCache();
      const results = await Promise.allSettled(indexStateStores.map((store) => store.removeEntry(filePath)));
      const failCount = results.filter((r) => r.status === "rejected").length;
      if (failCount > 0) {
        hostApi.logEvent("warn", "local_indexer.remove_state_partial_fail", { filePath, failed: failCount });
      } else {
        hostApi.logEvent("info", "local_indexer.remove_state_ok", { filePath });
      }
    };
    indexer.onScanProgress = (snapshot: ScanProgressSnapshot) => {
      hostApi.emitEvent("index.scan.progress", snapshot);
    };
  };

  bindIndexerCallbacks(autoIndexer);

  // ─── 폴더 영속화 (foldersConfigPath는 createPlugin 첫 부분에서 정의됨) ──
  async function loadPersistedFolders(): Promise<string[]> {
    // Tool handlers are reachable only after publication, but may be invoked
    // before onPublished has finished. Preserve that lazy-start contract while
    // keeping candidate start side-effect free.
    await migrateLegacyWorkspace();
    let needsRewrite = false;
    try {
      if (existsSync(foldersConfigPath)) {
        const raw = await readFile(foldersConfigPath, "utf-8");
        const parsed = JSON.parse(raw) as { folders?: string[] };
        if (Array.isArray(parsed.folders)) {
          const unique = new Set<string>();
          const cleaned: string[] = [];
          for (const input of parsed.folders) {
            if (typeof input !== "string") {
              needsRewrite = true;
              continue;
            }
            const trimmed = input.trim();
            if (!trimmed || trimmed.includes("\"")) {
              needsRewrite = true;
              continue;
            }
            const absPath = resolve(trimmed);
            if (isHighChurnFolderPath(absPath, userHome)) {
              hostApi.logEvent("warn", "index_folders.skip_high_churn_folder", { folder: absPath });
              needsRewrite = true;
              continue;
            }
            if (!unique.has(absPath)) {
              unique.add(absPath);
              cleaned.push(absPath);
            }
          }
          if (needsRewrite) {
            await persistFolders(cleaned);
          }
          // 명시적 빈 folders.json 도 그대로 존중 — 사용자가 모든 폴더를
          // 제거했는데 fixtures fallback 으로 자동 복원되면 의도가 깨진다.
          // 파일이 존재해 파싱에 성공했다면 길이와 무관하게 cleaned 를 반환.
          return cleaned;
        }
      }
    } catch { /* 파싱 실패 시 기본값 사용 */ }
    return scanFolders.length > 0 ? scanFolders : [resolve(context.hostRoot, "fixtures")];
  }

  // Registered-folder count for the nightly-rescan suggestion gate. Unlike
  // loadPersistedFolders(), this has NO fixtures fallback — it reflects only
  // what the user actually registered (config scanFolders ∪ persisted
  // folders.json). Reads plugin-local state only; never host routine storage.
  async function countRegisteredFolders(): Promise<number> {
    const registered = new Set<string>(scanFolders);
    try {
      if (existsSync(foldersConfigPath)) {
        const raw = await readFile(foldersConfigPath, "utf-8");
        const parsed = JSON.parse(raw) as { folders?: unknown };
        if (Array.isArray(parsed.folders)) {
          for (const f of parsed.folders) {
            if (typeof f === "string" && f.trim().length > 0) {
              // Resolve against context.hostRoot (same base as scanFolders)
              // so a relative path present in both sources deduplicates
              // correctly in the Set.
              registered.add(resolve(context.hostRoot, f.trim()));
            }
          }
        }
      }
    } catch {
      /* unreadable folders.json → fall back to scanFolders-only count */
    }
    return registered.size;
  }

  // Nightly-rescan Daily Help suggestion. Fired once per launch (fire-and-
  // forget) from start(); the 3-AND gate + propose-once ledger inside
  // maybeProposeRescanRoutine make repeat calls cheap no-ops.
  let rescanSuggestionInFlight: Promise<void> | null = null;
  function runRescanSuggestionOnLaunch(): Promise<void> {
    if (rescanSuggestionInFlight) return rescanSuggestionInFlight;
    rescanSuggestionInFlight = maybeProposeRescanRoutine({
      hostApi,
      ledgerPath: join(pluginDataDir, RESCAN_LEDGER_FILENAME),
      countRegisteredFolders,
      log: context.log,
    })
      .then(() => undefined)
      .catch((err) => {
        context.log("local-indexer:rescan-suggestion:unexpected", {
          error: (err as Error).message,
        });
      })
      .finally(() => {
        rescanSuggestionInFlight = null;
      });
    return rescanSuggestionInFlight;
  }

  async function persistFolders(folders: string[]): Promise<void> {
    await mkdir(workspace, { recursive: true });
    // 원자적 쓰기 — tmp 파일에 먼저 기록한 뒤 rename 으로 swap.
    // 직접 `writeFile(foldersConfigPath, …)` 로 덮어쓰면 mid-write 크래시
    // 시 파일이 truncate / partial write 상태로 남아 다음 부팅에 파싱
    // 실패 → 사용자 폴더 목록 유실. mid-flight 안전 + 기존 손상 파일을
    // 한 번 백업 (`folders.json.bak`) 해 자동 cleanup 의 거짓 양성으로
    // 정상 entry 가 사라졌을 때 사후 복구할 수 있게 함.
    const tmpPath = `${foldersConfigPath}.tmp`;
    const backupPath = `${foldersConfigPath}.bak`;
    const payload = JSON.stringify({ folders }, null, 2);
    await writeFile(tmpPath, payload, "utf-8");
    if (existsSync(foldersConfigPath)) {
      try {
        await rename(foldersConfigPath, backupPath);
      } catch {
        // 백업 실패는 영속화를 막을 만한 사유가 아님 — 계속 진행.
      }
    }
    await rename(tmpPath, foldersConfigPath);
  }

  // folders.json 읽기→수정→쓰기 IPC 들 사이의 lost-update를 방지.
  // 이 큐는 host plugin 단일 인스턴스 내부의 동시 호출을 직렬화할 뿐,
  // 다중 host 프로세스 간 보호는 아님. 한 host 안에서 두 IPC 핸들러가
  // 동시에 folders 를 변경하면 마지막 writer가 다른 변경을 잃어버린다.
  let _foldersMutationChain: Promise<unknown> = Promise.resolve();
  function withFoldersLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = _foldersMutationChain.then(fn, fn);
    // 체인이 reject 되어도 다음 호출은 계속 진행되도록 swallow.
    _foldersMutationChain = next.catch(() => undefined);
    return next;
  }

  async function removeIndexedStateForFolder(folderPath: string): Promise<number> {
    let removed = 0;
    for (const store of indexStateStores) {
      const entries = await store.listEntries();
      const toRemove = entries.filter((e) => isWithinFolder(e.filePath, folderPath)).map((e) => e.filePath);
      removed += await store.removeEntries(toRemove);
    }
    return removed;
  }

  async function loadMergedIndexState(): Promise<Map<string, { docId: string; mtimeMs: number; indexedAt: string }>> {
    const results = await Promise.allSettled(indexStateStores.map((store) => store.listEntries()));
    const entries: import("./indexState.js").IndexedFileEntry[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        entries.push(...result.value);
      } else {
        hostApi.logEvent("warn", "indexState.store_load_failed", {
          error: (result.reason as Error)?.message,
        });
      }
    }
    return mergeIndexedStateEntries(entries);
  }

  async function listIndexableFiles(
    folderPath: string,
    options?: { includeImages?: boolean },
  ): Promise<Array<{ filePath: string; mtimeMs: number }>> {
    const files: Array<{ filePath: string; mtimeMs: number }> = [];
    // 호출자가 명시적 override 안 주면 현재 토글 상태를 따른다 (기존 동작 유지).
    // 미리보기 (`index_preview_folder`) 처럼 토글 무관하게 폴더 내용을 보여줘야
    // 하는 경우는 `includeImages: true` 를 명시.
    //
    // CRITICAL: prime the image-settings sidecar cache BEFORE reading
    // `isImageEmbeddingEnabled()`. The helper is synchronous and returns
    // `false` whenever `imageSettingsCache` is still `null` (the default
    // until the first `loadImageSettings()` await completes). Without this
    // prime, the very first folder-summary build after plugin start sees
    // image-embedding=OFF even when the user has enabled the toggle, so
    // .jpg/.png files get excluded from `listIndexableFiles` and the folder
    // appears as `0 / 0 indexed` despite containing legitimate image files.
    let includeImages: boolean;
    if (options?.includeImages !== undefined) {
      includeImages = options.includeImages;
    } else {
      await loadImageSettings();
      includeImages = isImageEmbeddingEnabled();
    }

    const walk = async (currentPath: string, isRoot = false): Promise<void> => {
      let metadata: Awaited<ReturnType<typeof lstat>>;
      try {
        metadata = await lstat(currentPath);
      } catch {
        return;
      }
      if (metadata.isSymbolicLink()) return;
      if (metadata.isDirectory()) {
        try {
          const entries = await readdir(currentPath, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name.startsWith(".")) continue;  // skip dotfiles/dotdirs
            if (entry.isDirectory() && SKIP_DIR_NAMES.has(entry.name)) continue;
            await walk(join(currentPath, entry.name));
          }
        } catch (err) {
          // 루트 폴더 readdir 실패는 상위로 전파 — silent empty 방지.
          // 서브디렉터리 실패는 무시하고 계속 진행.
          if (isRoot) throw err;
        }
        return;
      }
      if (
        !metadata.isFile() ||
        !isIndexableFilePath(currentPath, { includeImages })
      ) {
        return;
      }
      files.push({ filePath: currentPath, mtimeMs: metadata.mtimeMs });
    };

    await walk(folderPath, true);
    return files.sort((a, b) => a.filePath.localeCompare(b.filePath));
  }

  async function buildFolderSummary(
    folderPath: string,
    stateByPath?: Map<string, { docId: string; mtimeMs: number; indexedAt: string }>,
    options?: { quick?: boolean },
  ): Promise<FolderIndexSummary> {
    const quickMode = options?.quick === true;
    // Why: quick / non-quick 결과 형태가 달라 같은 키로 섞이면 근사치가
    // 정확치를 가리거나 그 반대가 발생함 → 키에 quick 플래그 포함.
    // Why: 키 생성 규칙을 helper로 일원화해 캐시 조회/저장과 무효화가
    // 동일한 기준을 사용하도록 한다.
    const cacheKey = getFolderSummaryCacheKey(folderPath, quickMode);
    // Why: stateByPath 유무와 관계없이 cache hit을 허용. 캐시는 8초 TTL 과
    // folderSummaryVersion 으로 자동 무효화되므로, 호출자가 stateByPath를
    // 매번 전달해도 동일 폴더 결과를 반복 계산하지 않도록 함.
    const cached = folderSummaryCache.get(cacheKey);
    if (
      cached &&
      cached.version === folderSummaryVersion &&
      Date.now() - cached.cachedAt < FOLDER_SUMMARY_CACHE_TTL_MS
    ) {
      return cached.summary;
    }

    const mergedState = stateByPath ?? (await loadMergedIndexState());
    const folderStateEntries = [...mergedState.entries()].filter(([filePath]) => isWithinFolder(filePath, folderPath));

    try {
      const metadata = await stat(folderPath);
      if (!metadata.isDirectory()) {
        throw new Error("not a directory");
      }
    } catch {
      const summary: FolderIndexSummary = {
        folder: folderPath,
        status: "missing",
        totalFiles: 0,
        indexedFiles: 0,
        staleFiles: 0,
        newFiles: 0,
        missingFiles: folderStateEntries.length,
        pendingFiles: folderStateEntries.length,
      };
      folderSummaryCache.set(cacheKey, {
        summary,
        cachedAt: Date.now(),
        version: folderSummaryVersion,
      });
      return summary;
    }

    await loadImageSettings();
    const imageEmbeddingEnabled = isImageEmbeddingEnabled();

    let currentFiles: Array<{ filePath: string; mtimeMs: number }>;
    let visibleFiles: Array<{ filePath: string; mtimeMs: number }>;
    if (quickMode) {
      // 주의: quick path 는 디스크를 걷지 않으므로 "indexed state 에 들어있는
      // 파일 수" 만 안다. 디스크에 새로 추가된 파일은 newFiles 로 잡히지
      // 않고, 인덱스에 있지만 사라진 파일도 missingFiles 로 잡히지 않는다.
      // status 가 "indexed" 라고 해서 "스캔이 최신" 이라고 단정하면 UI 가
      // 거짓을 말하게 되므로, `approximate: true` 와 totalFiles=undefined
      // 의도 대신 indexedFiles 만 채우고 호출자가 정확치를 원하면 quick=false
      // 로 재요청해야 함을 명시한다.
      const indexedFiles = folderStateEntries.length;
      const lastIndexedAt = folderStateEntries
        .map(([, entry]) => entry.indexedAt)
        .filter((value) => typeof value === "string" && value.length > 0)
        .sort()
        .at(-1);
      const summary: FolderIndexSummary = {
        folder: folderPath,
        status: indexedFiles === 0 ? "empty" : "indexed",
        totalFiles: indexedFiles,
        indexedFiles,
        staleFiles: 0,
        newFiles: 0,
        missingFiles: 0,
        pendingFiles: 0,
        lastIndexedAt,
        approximate: true,
      };
      folderSummaryCache.set(cacheKey, {
        summary,
        cachedAt: Date.now(),
        version: folderSummaryVersion,
      });
      return summary;
    }

    try {
      currentFiles = await listIndexableFiles(folderPath, {
        includeImages: imageEmbeddingEnabled,
      });
      visibleFiles = imageEmbeddingEnabled
        ? currentFiles
        : await listIndexableFiles(folderPath, { includeImages: true });
    } catch {
      const summary: FolderIndexSummary = {
        folder: folderPath,
        status: "missing",
        totalFiles: 0,
        indexedFiles: 0,
        staleFiles: 0,
        newFiles: 0,
        missingFiles: folderStateEntries.length,
        pendingFiles: folderStateEntries.length,
      };
      folderSummaryCache.set(cacheKey, {
        summary,
        cachedAt: Date.now(),
        version: folderSummaryVersion,
      });
      return summary;
    }
    const currentPaths = new Set(currentFiles.map((file) => file.filePath));
    const visiblePaths = new Set(visibleFiles.map((file) => file.filePath));
    let indexedFiles = 0;
    let staleFiles = 0;
    let newFiles = 0;
    let disabledFiles = 0;

    for (const file of visibleFiles) {
      const entry = mergedState.get(file.filePath);
      const actionable = currentPaths.has(file.filePath);
      if (!entry) {
        if (actionable) {
          newFiles += 1;
        } else {
          disabledFiles += 1;
        }
      } else if (Math.floor(entry.mtimeMs) >= Math.floor(file.mtimeMs)) {
        indexedFiles += 1;
      } else if (actionable) {
        staleFiles += 1;
      } else {
        disabledFiles += 1;
      }
    }
    hostApi.logEvent("info", "buildFolderSummary.detail", {
      folder: folderPath,
      stateMapSize: mergedState.size,
      folderStateEntries: folderStateEntries.length,
      totalFiles: visibleFiles.length,
      actionableFiles: currentFiles.length,
      disabledFiles,
      newFiles,
      staleFiles,
      indexedFiles,
      imageEmbeddingEnabled,
    });

    const missingFiles = folderStateEntries.filter(([filePath]) => !visiblePaths.has(filePath)).length;
    const pendingFiles = staleFiles + newFiles;
    const lastIndexedAt = folderStateEntries
      .map(([, entry]) => entry.indexedAt)
      .filter((value) => typeof value === "string" && value.length > 0)
      .sort()
      .at(-1);

    let status: FolderIndexSummary["status"];
    if (visibleFiles.length === 0) {
      status = "empty";
    } else if (pendingFiles === 0 && missingFiles === 0) {
      status = disabledFiles > 0 ? "images_disabled" : "indexed";
    } else {
      status = "needs_scan";
    }

    const summary: FolderIndexSummary = {
      folder: folderPath,
      status,
      totalFiles: visibleFiles.length,
      indexedFiles,
      staleFiles,
      newFiles,
      missingFiles,
      pendingFiles,
      lastIndexedAt,
    };
    folderSummaryCache.set(cacheKey, {
      summary,
      cachedAt: Date.now(),
      version: folderSummaryVersion,
    });
    return summary;
  }

  // Serialise concurrent recordIndexedState calls to prevent interleaved saves
  // overwriting each other in IndexState (each addEntry calls save()).
  let _recordQueue = Promise.resolve();

  async function recordIndexedState(filePath: string, docId: string): Promise<void> {
    const p = _recordQueue.then(() => _doRecord(filePath, docId));
    _recordQueue = p.catch(() => {}); // prevent cascade: reset queue on failure
    await p;
  }

  async function _doRecord(filePath: string, docId: string): Promise<void> {
    invalidateFolderSummaryCache();
    let mtimeMs = Date.now();
    try {
      mtimeMs = (await stat(filePath)).mtimeMs;
    } catch {
      // Keep the current timestamp if the file disappeared immediately after indexing.
    }
    hostApi.logEvent("info", "local_indexer.record_state", { filePath, docId, mtimeMs });
    await Promise.all(indexStateStores.map((store) => store.addEntry(filePath, docId, mtimeMs, "mtime-only")));
  }

  /**
   * FolderAutoIndexer 인스턴스를 재생성 (폴더 변경 시).
   * docsForCache와 stateForCache를 전달하면 이미 인덱싱된 파일은 스캔 시 skip된다.
   */
  async function rebuildIndexer(
    folders: string[],
    docsForCache?: LocalIndexerDocumentMeta[],
    stateForCache?: Map<string, { docId: string; mtimeMs: number }>,
  ): Promise<void> {
    invalidateFolderSummaryCache();
    await autoIndexer.stop();
    autoIndexer = new FolderAutoIndexer({
      client: plugin,
      folders,
      imageEmbeddingEnabled: isImageEmbeddingEnabled(),
    });
    bindIndexerCallbacks(autoIndexer);
    // IndexState 먼저(정확한 Node.js mtimes) → DB로 누락 경로 보충
    if (stateForCache && stateForCache.size > 0) {
      autoIndexer.prePopulateCacheFromState(stateForCache);
    }
    if (docsForCache && docsForCache.length > 0) {
      autoIndexer.prePopulateCache(docsForCache);
    }
  }

  async function removeIndexedDocumentsForFolder(folderPath: string): Promise<{ removed: number; failed: number }> {
    invalidateFolderSummaryCache(folderPath);
    const docs = uniqueDocuments(await plugin.listDocuments());
    let removed = 0;
    let failed = 0;

    for (const doc of docs) {
      const docPath = doc.path ? resolve(doc.path) : null;
      if (!docPath || !isWithinFolder(docPath, folderPath)) continue;
      try {
        await plugin.removeDocument(doc.doc_id);
        structureCache.invalidate(doc.doc_id);
        contentCache.invalidate(doc.doc_id);
        hostApi.emitEvent("index.document.updated", {
          docId: doc.doc_id,
          path: doc.path,
          message: `문서 제거: ${doc.path}`,
        });
        removed += 1;
      } catch (err) {
        failed += 1;
        hostApi.logEvent("warn", "index_remove_folder.document_remove_failed", {
          docId: doc.doc_id,
          path: doc.path,
          error: (err as Error).message,
        });
      }
    }

    return { removed, failed };
  }

  async function removeIndexedDocumentsForPaths(filePaths: string[]): Promise<{ removed: number; failed: number }> {
    invalidateFolderSummaryCache();
    if (filePaths.length === 0) return { removed: 0, failed: 0 };
    const targets = new Set(filePaths);
    const docs = uniqueDocuments(await plugin.listDocuments());
    let removed = 0;
    let failed = 0;

    for (const doc of docs) {
      const docPath = doc.path ? resolve(doc.path) : null;
      if (!docPath || !targets.has(docPath)) continue;
      try {
        await plugin.removeDocument(doc.doc_id);
        structureCache.invalidate(doc.doc_id);
        contentCache.invalidate(doc.doc_id);
        removed += 1;
      } catch {
        failed += 1;
      }
    }

    return { removed, failed };
  }

  function buildScanCompletionMessage(snapshot: ScanProgressSnapshot): string {
    const failSuffix = snapshot.failed > 0 ? `, 실패 ${snapshot.failed}개` : "";
    if (snapshot.status === "failed") {
      return snapshot.message ?? `스캔 실패: ${snapshot.failed}개 파일 오류`;
    }
    return `스캔 완료. 인덱싱 ${snapshot.indexed} / ${snapshot.total}${failSuffix}`;
  }

  function raiseIndexAlert(kind: "index-scan-completed" | "index-folders-changed"): void {
    // The host owns opt-in and delivery. The key contains no folder or file
    // path, and an alert failure must not interrupt the index operation.
    void Promise.resolve()
      .then(() => hostApi.raiseAlert({ kind, key: randomUUID() }))
      .catch((error: unknown) => {
        hostApi.logEvent("warn", "local_indexer.alert_failed", {
          kind,
          error: error instanceof Error ? error.name : "unknown",
        });
      });
  }

  function emitFolderChange(payload: Record<string, unknown>): void {
    hostApi.emitEvent("index.folders.changed", payload);
    raiseIndexAlert("index-folders-changed");
  }

  function emitScanCompletion(snapshot: ScanProgressSnapshot): void {
    if (snapshot.status !== "done" && snapshot.status !== "failed") return;
    hostApi.emitEvent("index.scan.completed", {
      title: "Local Indexer",
      message: buildScanCompletionMessage(snapshot),
      status: snapshot.status,
      total: snapshot.total,
      processed: snapshot.processed,
      indexed: snapshot.indexed,
      failed: snapshot.failed,
    });
    raiseIndexAlert("index-scan-completed");
  }

  /**
   * Worker의 path-confinement 허용 루트를 현재 folders + 고정 루트(workspace,
   * hostRoot, ~/.ave)로 동기화. `index_add_folder`/`index_remove_folder` 및
   * ensureStarted에서 호출하여, 런타임에 새 폴더를 추가했을 때 worker가 해당
   * 폴더 내 파일을 422로 거부하지 않도록 한다.
   *
   * 실패는 non-fatal: 로그만 남기고 후속 동작을 막지 않는다 (예: 토큰 미보유).
   */
  async function syncAllowedRootsToWorker(
    folders: string[],
    extraRoots: string[] = [],
  ): Promise<void> {
    const token = plugin.getShutdownToken();
    if (!token) {
      context.log("syncAllowedRootsToWorker: shutdown token missing, skipping");
      return;
    }
    // Why: Windows mapped network drives (e.g. `D:\업무\…` 가 `\\server\share\…`
    // 의 매핑) 에서 파일 walker 는 D:\ 형식 경로를 만들어 worker 에 전달하지만
    // worker 가 Python 측에서 realpath/실제 파일시스템 호출을 거치면 결과적으로
    // 백킹 UNC 경로를 보게 된다. 그러면 allowed_roots(D:\…) 에는 매치되지 않아
    // `indexer.caption.rejected_path` 같은 silent skip 으로 끝남. 사용자 폴더 각
    // 항목의 realpath 도 함께 등록해 두 형식 모두 워커가 같은 폴더로 인식하도록.
    // 보안: 사용자가 명시적으로 추가한 폴더의 realpath 이므로 attack surface 확장
    // 아님. `\\?\…` / `\\.\…` device-namespace 는 isBlockedIndexPath 에서 이미
    // 차단됐고, realpath 가 device-namespace 형식을 반환하더라도 여기서 한 번 더 거른다.
    const resolvedFolders = new Set<string>();
    for (const folder of [...folders, ...extraRoots]) {
      for (const candidate of await expandAllowedRootWithBackingUnc(folder, resolveMappedDriveRoot)) {
        resolvedFolders.add(candidate);
      }
      try {
        const real = await realpath(folder);
        if (
          !real.startsWith("\\\\?\\")
          && !real.startsWith("\\\\.\\")
        ) {
          for (const candidate of await expandAllowedRootWithBackingUnc(real, resolveMappedDriveRoot)) {
            resolvedFolders.add(candidate);
          }
        }
      } catch {
        // 사라진 폴더 등 realpath 실패는 무시 — 원본 경로만 등록
      }
    }
    const roots = Array.from(
      new Set([
        workspace,
        context.hostRoot,
        ...resolvedFolders,
        aveHome,
      ]),
    );
    try {
      await workerClient.setAllowedRoots(roots, token);
      hostApi.logEvent("info", "local_indexer.allowed_roots.synced", { count: roots.length });
    } catch (err) {
      hostApi.logEvent("warn", "local_indexer.allowed_roots.sync_failed", {
        error: (err as Error).message,
      });
    }
  }

  let started = false;
  let startupWarmupPromise: Promise<void> | null = null;

  async function hydrateEmbeddingBootConfig(): Promise<void> {
    const liveEmbeddingProvider = readEmbeddingProvider({ hostVendor: readActiveVendor() });
    const liveEmbeddingModel =
      validateEmbeddingModel(getConfig("embeddingModel")) ?? embeddingModel ?? "";
    const liveEmbeddingApiVersion = readEmbeddingApiVersion();
    const fallbackCaptionProvider = readCaptionProvider({ hostVendor: readActiveVendor() });
    const fallbackCaptionEndpoint = isAzureCaptionProvider(fallbackCaptionProvider)
      ? readCaptionEndpoint()
      : "";
    let liveEmbeddingEndpoint =
      liveEmbeddingProvider === "azure"
        ? resolveAzureResourceEndpoint({
            explicitEndpoint: getConfig("embeddingEndpoint"),
            fallbackEndpoint: fallbackCaptionEndpoint,
          })
        : (
            typeof getConfig("embeddingEndpoint") === "string"
              ? validateEndpointUrl(getConfig("embeddingEndpoint"), {
                  allowLoopback: liveEmbeddingProvider === "openai",
                })
              : ""
          );

    const embeddingHandle = await resolveHostKeyHandle("embedding");
    if (liveEmbeddingProvider === "azure" && !liveEmbeddingEndpoint && embeddingHandle) {
      liveEmbeddingEndpoint = resolveAzureResourceEndpoint({
        hostBaseUrl: embeddingHandle.baseUrl,
      });
    }

    // Keep a custom endpoint from inheriting a host-key presence marker.
    // The broker applies the same audience guard to each real request.
    const liveEmbeddingEndpointRaw = getConfig("embeddingEndpoint");
    const liveApiKey = await resolveEmbeddingKeyForEndpoint(
      liveEmbeddingEndpointRaw,
      embeddingHandle,
    );
    plugin.setEmbeddingBootConfig?.({
      apiKey: liveApiKey,
      embeddingProvider: liveEmbeddingProvider,
      embeddingModel: liveEmbeddingModel,
      embeddingEndpoint: liveEmbeddingEndpoint,
      embeddingApiVersion: liveEmbeddingApiVersion,
      hostVendor: readActiveVendor(),
    });
  }

  async function runStartupWarmup(folders: string[]): Promise<void> {
    try {
      const existingDocs = uniqueDocuments((await plugin.listDocuments()) as LocalIndexerDocumentMeta[]);
      hostApi.logEvent("info", "local_indexer.cache_from_db", { count: existingDocs.length });

      if (existingDocs.length > 0) {
        // DB에 실제로 있는 파일만 스캔 skip 대상으로. DB가 비어있으면
        // IndexState가 stale일 수 있으므로 pre-population 건너뜀 → 전체 재스캔.
        const dbPaths = new Set(existingDocs.map((d) => d.path ? resolve(d.path) : "").filter(Boolean));
        const state = await loadMergedIndexState().catch(() => new Map<string, { docId: string; mtimeMs: number; indexedAt: string }>());
        const validState = new Map([...state].filter(([p]) => dbPaths.has(p)));
        autoIndexer.prePopulateCacheFromState(validState);
        hostApi.logEvent("info", "local_indexer.cache_from_state", { total: state.size, valid: validState.size });
        autoIndexer.prePopulateCache(existingDocs);
      } else {
        hostApi.logEvent("warn", "local_indexer.cache_skipped_db_empty", {});
      }

      // DB → IndexState 동기화: IndexState에 없는 DB 항목을 기록.
      // 폴더 remove로 IndexState가 비워진 뒤 앱 재시작 시에도 정확한 상태를 표시하도록.
      // Math.floor 정렬을 위해 DB의 truncated int mtime을 그대로 저장.
      const currentState = await loadMergedIndexState().catch(() => new Map<string, unknown>());
      const syncDocs = existingDocs.filter(
        (doc) => doc.path && doc.doc_id && doc.mtime_ms != null && doc.mtime_ms > 0 && !currentState.has(resolve(doc.path)),
      );
      if (syncDocs.length > 0) {
        // 직렬화: 같은 IndexState 파일에 동시 쓰기하면 in-memory Map race 발생.
        // 각 doc를 순차 처리하고, store 간 병렬 쓰기(다른 파일)는 유지.
        for (const doc of syncDocs) {
          await Promise.all(
            indexStateStores.map((store) =>
              store.addEntry(resolve(doc.path!), doc.doc_id, doc.mtime_ms!, "db-sync").catch(() => {}),
            ),
          );
        }
        hostApi.logEvent("info", "local_indexer.db_to_state_sync", { count: syncDocs.length });
      }
    } catch {
      // worker 미응답 시 무시
    }
    if (realtimeWatchEnabled) {
      await autoIndexer.ensureWatching();
    } else {
      hostApi.logEvent("info", "local_indexer.realtime_watch_disabled", {
        reason: "config.realtimeWatch=false",
      });
    }
    await syncAllowedRootsToWorker(folders);

    // Boot reconcile pass — heal SQLite↔LanceDB vector drift left by a crash
    // between index_file's sqlite commit and the Lance upsert (the residual
    // window that the P1-7a content_hash-after-lance ordering narrows but
    // cannot fully close: embeddings_meta rows exist with no Lance vector, and
    // the doc silently has no vectors until something touches it).
    //
    // DETECT is key-free and runs unconditionally; it also deletes orphan Lance
    // vectors and marks drifted docs (content_hash NULL + content_state=
    // 'embed_failed') so a later reindex re-embeds them. HEAL (re-embedding the
    // drifted docs) needs the warmup-pushed embedding key, so it is deferred
    // when no key is available yet — the docs stay BM25-only until a future
    // cycle has a key. This runs inside the background warmup promise so it
    // never blocks boot; the re-embed is bounded to RECONCILE_HEAL_CAP docs per
    // cycle (the rest heal next cycle). Runs AFTER syncAllowedRootsToWorker so
    // the heal reindex paths pass the worker's within-roots validation.
    try {
      const report = await workerClient.reconcile();
      hostApi.logEvent("info", "local_indexer.reconcile", {
        checked: report.checked,
        drifted: report.drifted_doc_count,
        orphanVectorsDeleted: report.orphan_vectors_deleted,
      });
      const drifted = report.drifted_docs ?? [];
      if (drifted.length > 0) {
        const healHandle = await resolveHostKeyHandle("embedding");
        try {
          const bearer = await resolveEmbeddingKeyForEndpoint(
            getConfig("embeddingEndpoint"),
            healHandle,
          );
          if (!bearer) {
            // No embedding key yet — re-embed is impossible. The docs are
            // already marked for re-embed, so a later cycle (after a key push)
            // heals them. They remain BM25-only meanwhile (graceful).
            hostApi.logEvent("info", "local_indexer.reconcile_heal_deferred", {
              drifted: drifted.length,
              reason: "no embedding key",
            });
          } else {
            const toHeal = drifted.slice(0, RECONCILE_HEAL_CAP);
            let healed = 0;
            for (const doc of toHeal) {
              try {
                await workerClient.reindex(doc.path);
                healed += 1;
              } catch (err) {
                hostApi.logEvent("warn", "local_indexer.reconcile_heal_failed", {
                  path: doc.path,
                  error: (err as Error).message,
                });
              }
            }
            hostApi.logEvent("info", "local_indexer.reconcile_healed", {
              healed,
              remaining: Math.max(0, drifted.length - toHeal.length),
            });
          }
        } finally {
          if (healHandle) {
            try { await healHandle.release(); } catch { /* best effort */ }
          }
        }
      }
    } catch (err) {
      hostApi.logEvent("warn", "local_indexer.reconcile_failed", {
        error: (err as Error).message,
      });
    }
  }

  // 동시 호출 가드. ensureStarted 는 여러 진입점 (start, document_index_scan,
  // index_add_folder, index_search 등) 에서 호출되므로, `started` 플래그가
  // false 인 상태에서 두 caller 가 동시에 진입하면 rebuildIndexer / plugin.start
  // 가 병렬로 두 번 돌아 autoIndexer 인스턴스 충돌 + worker spawn race 가
  // 발생한다. in-flight promise 를 공유해 한 번만 돌게 함.
  let startingPromise: Promise<void> | null = null;
  let teardownPromise: Promise<void> | null = null;

  async function ensureStarted(): Promise<void> {
    if (teardownPromise) {
      throw new Error("Local Indexer runtime is stopping or stopped");
    }
    if (started && plugin.isRunning) return;
    if (started && !plugin.isRunning) {
      hostApi.logEvent("warn", "local_indexer.worker_restart_required", {
        reason: "started flag set but worker process is not running",
      });
      started = false;
    }
    if (startingPromise) {
      await startingPromise;
      return;
    }
    startingPromise = (async () => {
      await migrateLegacyWorkspace();
      await mkdir(workspace, { recursive: true });
      await hydrateEmbeddingBootConfig();
      // Prime image-embedding settings from sidecar BEFORE building the
      // auto-indexer / spawning the worker — so the saved toggle survives
      // restart and the walker / worker see the same state immediately.
      // Optional-chain so test fixtures with minimal FolderAutoIndexer
      // mocks don't have to declare the setter.
      const imgSettings = await loadImageSettings();
      autoIndexer.setImageEmbeddingEnabled?.(imgSettings.imageEmbeddingEnabled);
      // 영속화된 폴더 로드
      const folders = await loadPersistedFolders();
      await rebuildIndexer(folders);
      await plugin.start();
      // Push the saved settings to the worker so a restart never reverts
      // the toggle. Failure is logged but does not abort startup —
      // captioning is opt-in and BM25/text indexing still works without it.
      try {
        const captionHandle = await resolveCaptionHostHandle();
        const captionHostBaseUrl = captionHandle?.baseUrl;
        const captionHostVendor = captionHandle?.vendor ?? readActiveVendor();
        const captionProvider = readCaptionProvider({
          hostBaseUrl: captionHostBaseUrl,
          hostVendor: captionHostVendor,
        });
        const captionModel = readCaptionModel({
          provider: captionProvider,
          hostBaseUrl: captionHostBaseUrl,
        });
        const captionEndpoint = readCaptionEndpoint({
          provider: captionProvider,
          hostBaseUrl: captionHostBaseUrl,
          hostVendor: captionHostVendor,
        });
        const captionApiVersion = readCaptionApiVersion({
          provider: captionProvider,
          hostBaseUrl: captionHostBaseUrl,
        });
        await workerClient.setImageCaptioning(
          imgSettings.imageEmbeddingEnabled,
          captionProvider,
          captionModel,
          captionEndpoint,
          captionCredentialFor(captionHandle),
          captionApiVersion,
        );
        if (captionHandle) {
          try { await captionHandle.release(); } catch { /* best effort */ }
        }
      } catch (err) {
        hostApi.logEvent("warn", "local_indexer.image_captioning_sync_failed", {
          error: (err as Error).message,
        });
      }
      // Push the embedding key to the freshly-started worker so query-time
      // vector search has a credential immediately. The env key channel was
      // removed (no INDEXER_API_KEY in the worker process), so without
      // this warmup push the SearchService would boot with an empty key and
      // silently degrade to BM25-only for any query that runs outside an
      // index_scan window. The bearer is supplied as a thunk and flows through
      // the same trust chokepoint as the per-scan push, so an untrusted custom
      // embeddingEndpoint still withholds the host key. The per-scan re-push
      // (below, at index_scan entry) and rotation re-pushes still apply.
      try {
        const warmupEmbeddingHandle = await resolveHostKeyHandle("embedding");
        try {
          // Push the session token (always present); the provider key stays
          // host-side in the broker/hostFetch path.
          //
          // Gated on the trust chokepoint, which this push previously claimed
          // to honour and did not: it read the handle directly, so a user in
          // `apiKeySource: "plugin"` mode with no key of their own — or one
          // pointing embeddings at an untrusted custom endpoint — still had a
          // credential pushed to the worker at boot, and the worker then
          // embedded through the broker on the host key. The per-scan push
          // below already asks this question; asking it here too is what makes
          // "no host key" mean no host key.
          const warmupHasKey = (await resolveEmbeddingKeyForEndpoint(
            getConfig("embeddingEndpoint"),
            warmupEmbeddingHandle,
          )).length > 0;
          const warmupCredential = warmupHasKey
            ? embeddingCredentialFor(warmupEmbeddingHandle)
            : "";
          if (warmupCredential) {
            await workerClient.setEgressToken(() =>
              embeddingCredentialFor(warmupEmbeddingHandle),
            );
          }
        } finally {
          if (warmupEmbeddingHandle) {
            try { await warmupEmbeddingHandle.release(); } catch { /* best effort */ }
          }
        }
      } catch (err) {
        hostApi.logEvent("warn", "local_indexer.embedding_key_warmup_failed", {
          error: (err as Error).message,
        });
      }
      // Start는 worker readiness까지만 blocking하고, 캐시 동기화/워처 준비는
      // 백그라운드 warmup으로 돌려 부팅 체감 지연을 줄인다.
      started = true;
      if (!startupWarmupPromise) {
        startupWarmupPromise = runStartupWarmup(folders)
          .catch((err) => {
            hostApi.logEvent("warn", "local_indexer.startup_warmup_failed", {
              error: (err as Error).message,
            });
          })
          .finally(() => {
            startupWarmupPromise = null;
          });
      }
    })();
    try {
      await startingPromise;
    } finally {
      startingPromise = null;
    }
  }

  async function teardown(): Promise<void> {
    if (teardownPromise) return teardownPromise;
    // The retained promise also closes startup admission before teardown yields.
    teardownPromise = (async () => {
      const startup = startingPromise;
      if (startup) {
        try {
          await startup;
        } catch {
          // LocalIndexerPlugin.start() rolls back partial startup before
          // rethrowing. The publication caller still receives that error;
          // teardown only waits for the rollback to settle before inspecting
          // the final running state.
        }
      }
      if (!started && !plugin.isRunning) return;
      // ensureStarted deliberately backgrounds watcher/cache warmup. Let that
      // work settle before stopping the indexer, otherwise a late
      // ensureWatching() could recreate a watcher after teardown returned.
      const warmup = startupWarmupPromise;
      if (warmup) await warmup;
      const results = await Promise.allSettled([autoIndexer.stop(), plugin.stop()]);
      started = false;
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Local Indexer teardown failed");
      }
    })();
    return teardownPromise;
  }

  // Both host shutdown and public stop share the same retained teardown
  // promise, so concurrent lifecycle exits cannot stop either component twice.
  hostApi.onShutdown(async () => {
    try {
      await teardown();
      hostApi.logEvent("info", "local_indexer.shutdown.completed");
    } catch (err) {
      hostApi.logEvent("error", "local_indexer.shutdown.failed", {
        error: (err as Error).message,
      });
    }
  });

  // ── Consolidated LLM tool surface (12→6, BREAKING hard-cut) ──
  // The 9 absorbed tool implementations stay here verbatim under their
  // original names and are reused (never rewritten) by the 3 consolidated
  // dispatchers (index_scan / index_folders / index_search) built in the
  // public `handlers` map below. These original names are intentionally NOT
  // exposed on the public handlers map, so calls to the old tool ids
  // (chat_preview, document_index_scan, index_refresh_folder,
  // index_add_folder, index_add_folders, index_remove_folder) hard-fail —
  // no alias handlers (owner decision A).
  const handlerImpls = {
      index_scan: async () => {
        clearRecentIndexWarnings();
        _surfacedWarningKeys.clear();

        // 워커가 silent "embedding client unavailable" 로 끝나기 전에
        // 명백한 misconfig 는 user-visible 에러로 즉시 throw 한다.
        // 워커는 키/endpoint 누락 시 INFO 로그만 남기고 indexing 자체는
        // 진행해 buryf 되기 때문에, 호스트 측에서 사전 게이트하지 않으면
        // 사용자는 왜 임베딩이 안 됐는지 알 수가 없다.
        const liveEmbeddingProvider = readEmbeddingProvider({ hostVendor: readActiveVendor() });

        // Probe provider metadata for scan configuration. The probe lease is
        // released immediately; each upstream request obtains its own lease.
        const scanAbort = new AbortController();
        const embeddingHandle = await resolveHostKeyHandle("embedding", scanAbort.signal);
        const captionHandle = await resolveCaptionHostHandle(scanAbort.signal);
        const currentSettings = await loadImageSettings();
        let scanImageEmbeddingEnabled = currentSettings.imageEmbeddingEnabled;
        let scanCaptionConfig: {
          provider: CaptionProvider;
          model: string | null;
          endpoint: string | null;
          apiVersion: string | null;
        } | null = null;

        // SECURITY chokepoint (SSRF / host-key exfil): when the host injects a
        // shared bearer (apiKeySource="host") and the user pointed embeddings
        // at a custom UNTRUSTED endpoint, the host key must never be sent
        // there. resolveEmbeddingKeyForEndpoint already withholds it and routes
        // the plugin's own key instead — but if the plugin has no own key,
        // there is nothing safe to send, so refuse rather than silently
        // mis-route. Trusted endpoints (api.openai.com / *.openai.azure.com /
        // *.cognitiveservices.azure.com) and an empty endpoint (provider
        // default) are unaffected: the host key is used as before. Unlike the
        // previous guard (openai + SDK-handle only), this also covers the
        // legacy (handle=null) path and is trusted-suffix-aware, so
        // api.openai.com is no longer wrongly rejected.
        const liveEmbeddingEndpointRaw = getConfig("embeddingEndpoint");
        if (
          isUntrustedHostEndpoint(liveEmbeddingEndpointRaw)
        ) {
          try {
            await embeddingHandle?.release();
          } catch {
            /* release failure is informational — host already logs */
          }
          if (captionHandle) {
            try { await captionHandle.release(); } catch { /* see above */ }
          }
          scanAbort.abort();
          throw new Error(
            "사용자 지정 embeddingEndpoint 가 신뢰할 수 없는 커스텀 URL 이라 호스트 LLM 키를 " +
            "전송할 수 없습니다 (SSRF/키 유출 보호). plugin 모드로 전환해 자체 키를 입력하거나, " +
            "embeddingEndpoint 를 비워 호스트 디폴트 라우팅(OpenAI/Azure)을 사용하세요.",
          );
        }

        if (liveEmbeddingProvider === "azure" || liveEmbeddingProvider === "openai") {
          // Prefer the SDK-resolved bearer when present; fall back to legacy
          // sync read for v5.4 hosts and plugin-mode users. The trust
          // chokepoint withholds the host bearer for untrusted custom URLs.
          const liveKey = await resolveEmbeddingKeyForEndpoint(liveEmbeddingEndpointRaw, embeddingHandle);
          const embeddingMissing: string[] = [];
          if (!liveKey) embeddingMissing.push("apiKey");
          if (embeddingMissing.length === 0 && !liveKey && liveEmbeddingProvider === "openai" && embeddingHandle) {
            try { await embeddingHandle.release(); } catch { /* informational */ }
          }
          if (embeddingMissing.length === 0 && !liveKey && liveEmbeddingProvider !== "openai") {
            const apiKeySource = readApiKeySource();
            if (embeddingHandle) {
              try { await embeddingHandle.release(); } catch { /* informational */ }
            }
            if (captionHandle) {
              try { await captionHandle.release(); } catch { /* informational */ }
            }
            throw new Error(
              `${liveEmbeddingProvider === "azure" ? "Azure" : "OpenAI"} 임베딩 API 키가 설정되지 않았습니다. ` +
              (apiKeySource === "host"
                ? "OpenAI API 키 미설정. Settings 에서 LLM 로그인하거나 plugin 모드 apiKey 입력 필요."
                : "플러그인 설정 → '[임베딩] API 키' 에 입력하세요."),
            );
          }
          if (liveEmbeddingProvider === "azure") {
            const rawEp = getConfig("embeddingEndpoint");
            const validatedExplicitEndpoint =
              typeof rawEp === "string"
                ? validateEndpointUrl(rawEp, { allowLoopback: false })
                : "";
            const endpoint =
              typeof rawEp === "string" && rawEp.length > 0
                ? endpointRoot(validatedExplicitEndpoint)
                : resolveAzureResourceEndpoint({
                    fallbackEndpoint: isAzureCaptionProvider(readCaptionProvider({ hostVendor: readActiveVendor() }))
                      ? readCaptionEndpoint()
                      : "",
                    hostBaseUrl: embeddingHandle?.baseUrl ?? captionHandle?.baseUrl,
                  });
            if (!endpoint) {
              embeddingMissing.push(
                typeof rawEp === "string" && rawEp.length > 0
                  ? "endpoint URL format"
                  : "embeddingEndpoint",
              );
            }
            if (embeddingMissing.length === 0 && !endpoint) {
              if (embeddingHandle) {
                try { await embeddingHandle.release(); } catch { /* informational */ }
              }
              if (captionHandle) {
                try { await captionHandle.release(); } catch { /* informational */ }
              }
              const reason =
                typeof rawEp === "string" && rawEp.length > 0
                  ? "URL 형식이 잘못됐습니다 (https://<resource>.openai.azure.com/ 형식이어야 합니다)"
                  : "비어있습니다";
              throw new Error(
                `Azure 임베딩 endpoint URL 이 ${reason}. 플러그인 설정 → '[임베딩] endpoint URL' 을 확인하세요.`,
              );
            }
          }
          if (embeddingMissing.length > 0) {
            hostApi.logEvent("warn", "index_scan.embedding_config_missing", {
              provider: liveEmbeddingProvider,
              missing: embeddingMissing,
              keySource: readApiKeySource(),
            });
            emitIndexWarning({
              kind: "embedding.missing_config",
              missing: embeddingMissing.join(", "),
              message:
                `${liveEmbeddingProvider === "azure" ? "Azure" : "OpenAI"} 임베딩 설정 누락: ` +
                `${embeddingMissing.join(", ")}. 벡터 임베딩 없이 텍스트/BM25 인덱싱으로 계속합니다.`,
            });
          }
        }

        if (liveEmbeddingProvider === "azure") {
          const rawEp = getConfig("embeddingEndpoint");
          const validatedExplicitEndpoint =
            typeof rawEp === "string"
              ? validateEndpointUrl(rawEp, { allowLoopback: false })
              : "";
          const bootEmbeddingEndpoint =
            typeof rawEp === "string" && rawEp.length > 0
              ? endpointRoot(validatedExplicitEndpoint)
              : resolveAzureResourceEndpoint({
                  fallbackEndpoint: isAzureCaptionProvider(readCaptionProvider({ hostVendor: readActiveVendor() }))
                    ? readCaptionEndpoint()
                    : "",
                  hostBaseUrl: embeddingHandle?.baseUrl ?? captionHandle?.baseUrl,
                });
          if (bootEmbeddingEndpoint) {
            plugin.setEmbeddingBootConfig({
              apiKey: await resolveEmbeddingKeyForEndpoint(getConfig("embeddingEndpoint"), embeddingHandle),
              embeddingProvider: liveEmbeddingProvider,
              embeddingModel:
                validateEmbeddingModel(getConfig("embeddingModel")) ?? embeddingModel ?? "",
              embeddingEndpoint: bootEmbeddingEndpoint,
              embeddingApiVersion: readEmbeddingApiVersion(),
              hostVendor: readActiveVendor(),
            });
          }
        }

        if (currentSettings.imageEmbeddingEnabled) {
          const captionHostBaseUrl = captionHandle?.baseUrl ?? embeddingHandle?.baseUrl;
          const captionHostVendor = captionHandle?.vendor ?? embeddingHandle?.vendor ?? readActiveVendor();
          const captionProvider = readCaptionProvider({
            hostBaseUrl: captionHostBaseUrl,
            hostVendor: captionHostVendor,
          });
          const captionEndpoint = readCaptionEndpoint({
            provider: captionProvider,
            hostBaseUrl: captionHostBaseUrl,
            hostVendor: captionHostVendor,
          });
          const captionModel = readCaptionModel({
            provider: captionProvider,
            hostBaseUrl: captionHostBaseUrl,
          });
          const captionApiVersion = readCaptionApiVersion({
            provider: captionProvider,
            hostBaseUrl: captionHostBaseUrl,
          });
          scanCaptionConfig = {
            provider: captionProvider,
            model: captionModel,
            endpoint: captionEndpoint,
            apiVersion: captionApiVersion,
          };
          const captionKey = await resolveCaptionKeyForEndpoint(getConfig("imageCaptionEndpoint"), captionHandle);
          const captionMissing: string[] = [];
          if (!captionKey) captionMissing.push("apiKey");
          if (
            captionProvider === "azure-openai-chat"
            || captionProvider === "azure-openai-responses"
          ) {
            if (!captionEndpoint) captionMissing.push("endpoint");
            if (!captionModel) captionMissing.push("model");
          }
          if (captionMissing.length > 0) {
            const providerLabel =
              captionProvider === "azure-openai-chat" || captionProvider === "azure-openai-responses"
                ? "Azure OpenAI"
                : "OpenAI";
            scanImageEmbeddingEnabled = false;
            hostApi.logEvent("warn", "index_scan.image_captioning_disabled", {
              provider: captionProvider,
              missing: captionMissing,
              keySource: readApiKeySource(),
            });
            emitIndexWarning({
              kind: "caption.missing_config",
              missing: captionMissing.join(", "),
              message:
                `${providerLabel} 이미지 캡션 설정 누락: ${captionMissing.join(", ")}. ` +
                "이번 스캔에서는 이미지 캡션만 건너뛰고 텍스트 인덱싱은 계속합니다.",
            });
          }
            if (captionMissing.length === 0 && !captionKey) {
              const providerLabel =
                captionProvider === "azure-openai-chat" || captionProvider === "azure-openai-responses"
                  ? "Azure OpenAI"
                  : "OpenAI";
              const apiKeySource = readApiKeySource();
              if (embeddingHandle) {
                try { await embeddingHandle.release(); } catch { /* informational */ }
              }
              if (captionHandle) {
                try { await captionHandle.release(); } catch { /* informational */ }
              }
              throw new Error(
                `${providerLabel} 이미지 캡션 API 키가 설정되지 않았습니다. ` +
                (apiKeySource === "host"
                  ? "OpenAI API 키 미설정. Settings 에서 LLM 로그인하거나 plugin 모드 apiKey 입력 필요."
                  : "플러그인 설정 → '[캡션] API 키' 에 입력하거나, 이미지 캡션을 해제하세요."),
              );
            }
            // Azure OpenAI chat 은 endpoint + deployment 이름 (model) 필수.
            // OpenAI provider 는 endpoint 비워두면 SDK 디폴트 사용.
            if (
              captionProvider === "azure-openai-chat"
              || captionProvider === "azure-openai-responses"
            ) {
              if (captionMissing.length === 0 && !captionEndpoint) {
                if (embeddingHandle) {
                  try { await embeddingHandle.release(); } catch { /* informational */ }
                }
                if (captionHandle) {
                  try { await captionHandle.release(); } catch { /* informational */ }
                }
                throw new Error(
                  "Azure OpenAI 캡션 endpoint URL 이 비어있거나 형식이 잘못됐습니다. " +
                  "플러그인 설정 → '[캡션] endpoint URL' 을 확인하세요.",
                );
              }
              if (captionMissing.length === 0 && !captionModel) {
                if (embeddingHandle) {
                  try { await embeddingHandle.release(); } catch { /* informational */ }
                }
                if (captionHandle) {
                  try { await captionHandle.release(); } catch { /* informational */ }
                }
                throw new Error(
                  "Azure OpenAI 캡션 model 이 비어있습니다. " +
                  "플러그인 설정 → '[캡션] 모델' 에 vision-capable deployment 이름 " +
                  "(예: gpt-4o-mini, gpt-5.4-mini) 을 입력하세요.",
                );
              }
            }
        }

        await ensureStarted();
        autoIndexer.setImageEmbeddingEnabled?.(scanImageEmbeddingEnabled);

        try {
        // Capture provider metadata and key-source mode for this scan. The
        // worker receives only its broker token; the broker resolves each
        // upstream lease afresh after this configuration snapshot.
        const capturedVendor = embeddingHandle?.vendor ?? readActiveVendor();
        const capturedKeySource = readApiKeySource();
        // Use the trust chokepoint so the "has key" flag describes provider
        // credential availability, not broker-token availability. The worker is
        // still pushed only the broker session token below; the real provider
        // key stays host-side in the egress channel resolver.
        const hasEmbeddingKey =
          (await resolveEmbeddingKeyForEndpoint(getConfig("embeddingEndpoint"), embeddingHandle)).length > 0;
        const hasCaptionKey =
          currentSettings.imageEmbeddingEnabled
            ? (await resolveCaptionKeyForEndpoint(getConfig("imageCaptionEndpoint"), captionHandle)).length > 0
            : false;
        hostApi.logEvent("info", "index_scan.key_capture", {
          vendor: capturedVendor,
          hasEmbeddingKey,
          hasCaptionKey,
          keySource: capturedKeySource,
          via: embeddingHandle ? "lease-metadata" : "plugin-key",
        });

        // Push the embedding key to the worker so the running scan uses a
        // consistent credential regardless of mid-flight toggle changes.
        // The bearer is supplied as a thunk so workerClient never holds it
        // as a long-lived field (#893 Stage 3).
        if (hasEmbeddingKey) {
          const getEmbeddingCredential = (): string => embeddingCredentialFor(embeddingHandle);
          try {
            await workerClient.setEgressToken(getEmbeddingCredential);
          } catch (err) {
            hostApi.logEvent("warn", "index_scan.embedding_key_sync_failed", {
              error: (err as Error).message,
            });
          }
        }

        // Push the caption key to the worker. Same thunk pattern.
        const currentSettingsForCapture = await loadImageSettings();
        if (currentSettingsForCapture.imageEmbeddingEnabled) {
          const captionHostBaseUrl = captionHandle?.baseUrl ?? embeddingHandle?.baseUrl;
          const captionHostVendor = captionHandle?.vendor ?? embeddingHandle?.vendor ?? readActiveVendor();
          // A captured null is a "keep" that must reach the worker as null —
          // `??` would re-derive it, so the capture is taken whole or not at all.
          const captionProvider = scanCaptionConfig
            ? scanCaptionConfig.provider
            : readCaptionProvider({ hostBaseUrl: captionHostBaseUrl, hostVendor: captionHostVendor });
          const captionModel = scanCaptionConfig
            ? scanCaptionConfig.model
            : readCaptionModel({ provider: captionProvider, hostBaseUrl: captionHostBaseUrl });
          const captionEndpoint = scanCaptionConfig
            ? scanCaptionConfig.endpoint
            : readCaptionEndpoint({
                provider: captionProvider,
                hostBaseUrl: captionHostBaseUrl,
                hostVendor: captionHostVendor,
              });
          const captionApiVersion = scanCaptionConfig
            ? scanCaptionConfig.apiVersion
            : readCaptionApiVersion({ provider: captionProvider, hostBaseUrl: captionHostBaseUrl });
          const getCaptionCredential = (): string => captionCredentialFor(captionHandle);
          try {
            await workerClient.setImageCaptioning(
              scanImageEmbeddingEnabled,
              captionProvider,
              captionModel,
              captionEndpoint,
              scanImageEmbeddingEnabled ? getCaptionCredential : "",
              captionApiVersion,
            );
          } catch (err) {
            hostApi.logEvent("warn", "index_scan.caption_key_sync_failed", {
              error: (err as Error).message,
            });
          }
        }

        // "Indexed" 상태가 아닌 폴더만 스캔 대상으로 한정.
        // index_folders(UI)와 동일한 소스(DB 우선, 실패 시 IndexState 폴백)를 사용해야
        // UI에 "Indexed"로 표시된 폴더가 스캔 대상에서 정확히 제외된다.
        const allFolders = await loadPersistedFolders();
        let stateForScan: Map<string, { docId: string; mtimeMs: number; indexedAt: string }>;
        try {
          const docs = uniqueDocuments((await plugin.listDocuments()) as LocalIndexerDocumentMeta[]);
          stateForScan = buildStateMapFromDocs(docs);
          hostApi.logEvent("info", "index_scan.state_source", {
            source: "db",
            docCount: docs.length,
            stateMapSize: stateForScan.size,
            sampleMtimes: docs.slice(0, 3).map((d) => ({ path: d.path, mtime_ms: d.mtime_ms })),
          });
        } catch (err) {
          stateForScan = await loadMergedIndexState();
          hostApi.logEvent("warn", "index_scan.state_source", {
            source: "indexState_fallback",
            stateMapSize: stateForScan.size,
            error: (err as Error).message,
          });
        }
        // Purge orphaned docs (files deleted from disk but still in DB/IndexState)
        // before computing folder summaries so missingFiles don't inflate needs_scan.
        for (const folder of allFolders) {
          const folderKeys = [...stateForScan.keys()].filter((p) => isWithinFolder(p, folder));
          const currentPaths = new Set(
            (await listIndexableFiles(folder).catch(() => [])).map((f) => f.filePath),
          );
          const orphans = folderKeys.filter((p) => !currentPaths.has(p));
          if (orphans.length > 0) {
            await removeIndexedDocumentsForPaths(orphans);
            for (const p of orphans) {
              await Promise.all(indexStateStores.map((s) => s.removeEntry(p)));
              stateForScan.delete(p);
            }
          }
        }

        const pendingFolders: string[] = [];
        for (const folder of allFolders) {
          const summary = await buildFolderSummary(folder, stateForScan);
          hostApi.logEvent("info", "index_scan.folder_summary", {
            folder,
            status: summary.status,
            totalFiles: summary.totalFiles,
            indexedFiles: summary.indexedFiles,
            newFiles: summary.newFiles,
            staleFiles: summary.staleFiles,
            pendingFiles: summary.pendingFiles,
            stateEntries: [...stateForScan.keys()].filter((k) => k.startsWith(folder)).length,
          });
          if (
            summary.status !== "indexed"
            && summary.status !== "empty"
            && summary.status !== "images_disabled"
          ) {
            pendingFolders.push(folder);
          }
        }
        const foldersToScan = pendingFolders.length > 0 ? pendingFolders : allFolders;
        hostApi.logEvent("info", "index_scan.target_folders", {
          total: allFolders.length,
          pending: pendingFolders.length,
          scanning: foldersToScan,
        });

        const res = await autoIndexer.scanOnce(foldersToScan);
        invalidateFolderSummaryCache();
        hostApi.logEvent("info", "index_scan.complete", {
          scanned: res.scanned,
          indexed: res.indexed,
          failed: res.failed,
          totalIndexed: res.totalIndexed,
          canceled: res.canceled,
        });
        emitScanCompletion(autoIndexer.getScanProgress());
        if (res.canceled) {
          return {
            ...res,
            message: "스캔이 중단되었습니다.",
          };
        }
        const failMsg = res.failed > 0 ? `, 실패 ${res.failed}개` : "";
        return {
          ...res,
          message: `스캔 완료. 현재 총 ${res.totalIndexed}개의 문서가 인덱싱되어 있으며 이번 스캔에서 ${res.indexed}개 인덱싱${failMsg}.`,
        };
        } finally {
          // #893 Stage 3: always release SDK-resolved bearers when the scan
          // exits — success, failure, or cancellation. The disposer signals
          // the host that the lease is done so it may rotate the key, zero
          // out buffers, etc. `release()` may be sync or async per SDK 5.13.
          if (embeddingHandle) {
            try { await embeddingHandle.release(); } catch (err) {
              hostApi.logEvent("warn", "local_indexer.resolve_api_key.release_failed", {
                purpose: "embedding",
                error: (err as Error).message,
              });
            }
          }
          if (captionHandle) {
            try { await captionHandle.release(); } catch (err) {
              hostApi.logEvent("warn", "local_indexer.resolve_api_key.release_failed", {
                purpose: "vision",
                error: (err as Error).message,
              });
            }
          }
        }
      },

      index_scan_cancel: async () => {
        await ensureStarted();
        const canceled = autoIndexer.cancelScan();
        return {
          canceled,
          message: canceled
            ? "스캔 중단을 요청했습니다."
            : "진행 중인 스캔이 없습니다.",
        };
      },

      index_scan_status: async () => {
        await ensureStarted();
        return {
          ...autoIndexer.getScanProgress(),
          warnings: recentIndexWarnings.map((warning) => ({ ...warning })),
        };
      },

      index_clear_warnings: async () => {
        clearRecentIndexWarnings();
        _surfacedWarningKeys.clear();
        return { cleared: true };
      },

      /**
       * D7 — On-demand indexing triggered by drag & drop.
       * Enqueues the given absolute paths into the existing indexing queue.
       * Each path is indexed via the Python worker HTTP API.
       * Returns { indexed, failed, jobId } for caller feedback.
       */
      document_index_scan: async (payload?: unknown) => {
        const p = (payload ?? {}) as { paths?: unknown };
        const paths = Array.isArray(p.paths)
          ? p.paths.filter((x): x is string => typeof x === "string")
          : [];
        if (paths.length === 0) {
          return { indexed: 0, failed: 0, message: "No paths provided." };
        }

        await ensureStarted();
        clearRecentIndexWarnings();
        _surfacedWarningKeys.clear();
        const jobId = `drop-${Date.now()}`;
        const folders = await loadPersistedFolders();
        const includeImages = isImageEmbeddingEnabled();
        const { files, roots, blocked } = await expandDroppedPaths(paths, folders, {
          ...blockOpts,
          includeImages,
        });
        if (blocked.length > 0) {
          hostApi.logEvent("warn", "document_index_scan.blocked_paths_skipped", { blocked });
        }
        if (files.length === 0) {
          return { indexed: 0, failed: 0, jobId, message: "No indexable files found." };
        }

        await syncAllowedRootsToWorker(folders, roots);

        let indexed = 0;
        let failed = 0;
        for (const filePath of files) {
          let docId: string | undefined;
          try {
            docId = await workerClient.indexDocument(
              filePath,
              getIndexModeForPath(filePath, { includeImages }) ?? "auto",
            );
            indexed += 1;
          } catch (err) {
            failed += 1;
            context.log(`document_index_scan: failed to index ${filePath}`, err);
            emitIndexWarning({
              kind: "indexDocument.failed",
              path: filePath,
              error: (err as Error).message,
              message: `파일 인덱싱 실패: ${(err as Error).message} (파일: ${filePath})`,
            });
          }
          if (docId) {
            await recordIndexedState(filePath, docId).catch((e) => {
              context.log(`document_index_scan: state record failed for ${filePath}`, e);
            });
          }
        }
        context.log(`document_index_scan: indexed=${indexed} failed=${failed}`, {
          inputPaths: paths,
          expandedFiles: files,
        });
        invalidateFolderSummaryCache();
        return { indexed, failed, jobId, message: `Indexed ${indexed}, failed ${failed}.` };
      },

      index_documents: async (payload?: unknown) => {
        // 단일 응답 크기를 LLM TPM 한도 이하로 유지하기 위한 서버측 페이지 cap.
        // 큰 limit (예: 999999) 우회는 MAX_LIMIT 으로 잘림.
        const DEFAULT_LIMIT = 100;
        const MAX_LIMIT = 100;
        const args = (payload ?? {}) as { limit?: unknown; offset?: unknown; full?: unknown };
        const rawLimit =
          typeof args.limit === "number" && Number.isFinite(args.limit) ? args.limit : DEFAULT_LIMIT;
        const rawOffset =
          typeof args.offset === "number" && Number.isFinite(args.offset) ? args.offset : 0;
        const limit = Math.min(Math.max(1, Math.floor(rawLimit)), MAX_LIMIT);
        const offset = Math.max(0, Math.floor(rawOffset));
        const full = args.full === true;

        const workerWasRunning = started;
        await ensureStarted();
        let docs: LocalIndexerDocumentMeta[] = [];
        try {
          docs = uniqueDocuments((await plugin.listDocuments()) as LocalIndexerDocumentMeta[]);
          hostApi.logEvent("info", "index_documents.worker_list_ok", { count: docs.length });
        } catch (err) {
          hostApi.logEvent("warn", "index_documents.worker_list_failed", { error: (err as Error).message });
        }

        if (docs.length === 0) {
          // Worker가 이미 실행 중이었는데 DB가 비어있으면 IndexState도 stale일 가능성 높음.
          // index_folders(폴더 상태)와 일관성을 유지하기 위해 빈 envelope 반환 → 사용자가 Scan 필요성을 명확히 인지.
          if (started && workerWasRunning) {
            hostApi.logEvent("warn", "index_documents.db_empty_while_running", {});
          } else {
            // Worker 미실행(오프라인) → IndexState 폴백 (best-effort 오프라인 표시)
            const mergedState = await loadMergedIndexState();
            hostApi.logEvent("info", "index_documents.index_state", { count: mergedState.size });
            const fallbackDocs = synthesizeIndexedDocuments(
              [...mergedState.entries()].map(([filePath, entry]) => ({
                filePath,
                docId: entry.docId,
                mtimeMs: entry.mtimeMs,
              })),
            );
            if (fallbackDocs.length > 0) {
              hostApi.logEvent("warn", "index_documents.fallback_to_indexer_state", {
                count: fallbackDocs.length,
              });
              docs = uniqueDocuments(fallbackDocs);
            } else {
              hostApi.logEvent("warn", "index_documents.empty", { workerDocs: 0, stateDocs: mergedState.size });
            }
          }
        }

        // 기본 응답 (LLM function call) 은 LLM 한테 불필요한 page_count/line_count
        // 까지 제외한 lean shape. UI 처럼 표시용 카운트가 필요한 호출자는
        // `full: true` 를 명시해 page_count/line_count 가 포함된 응답을 받는다.
        // 어느 모드든 중복(id=doc_id, doc_type=type) / 미사용(indexed_at, mtime_ms,
        // doc_description) 필드는 제외해 raw worker meta 보다 항상 작다.
        docs = docs.filter((doc) => (doc.status ?? "indexed") === "indexed");
        const total = docs.length;
        const sliced = docs.slice(offset, offset + limit);
        const page = full
          ? sliced.map((d) => ({
              doc_id: d.doc_id,
              doc_name: d.doc_name,
              type: d.type,
              path: d.path,
              page_count: d.page_count,
              line_count: d.line_count,
              status: d.status,
              content_state: d.content_state,
            }))
          : sliced.map((d) => ({
              doc_id: d.doc_id,
              doc_name: d.doc_name,
              type: d.type,
              path: d.path,
              status: d.status,
              content_state: d.content_state,
            }));
        const hasMore = offset + page.length < total;
        return { documents: page, total, hasMore };
      },

      index_folders: async () => {
        // worker가 아직 미시작이면 여기서 시작 (UI 로드 타이밍 경쟁 방지)
        if (!started) {
          try {
            await ensureStarted();
          } catch {
            // 시작 실패 → started=false 유지 → 아래에서 IndexState 폴백 사용
          }
        }

        const folders = await loadPersistedFolders();

        // DB가 source of truth. worker 실행 중이면 DB에서 상태를 읽는다.
        // - listDocuments() 성공, 결과 있음 → DB state 사용 (+ IndexState mtime 보정)
        // - listDocuments() 성공, 결과 없음 → DB 비어있음 → 빈 맵 → "Needs Scan" 유도
        // - listDocuments() 실패 (ECONNREFUSED, crash 등) → IndexState 폴백 (데이터 유실 방지)
        // - worker 미실행 → IndexState 폴백 (오프라인 표시)
        let stateByPath: Map<string, { docId: string; mtimeMs: number; indexedAt: string }>;
        if (started) {
          let dbState: Map<string, { docId: string; mtimeMs: number; indexedAt: string }> = new Map();
          let dbFailed = false;
          try {
            const docs = uniqueDocuments((await plugin.listDocuments()) as LocalIndexerDocumentMeta[]);
            dbState = buildStateMapFromDocs(docs);
            hostApi.logEvent("info", "index_folders.from_worker", { count: dbState.size });
          } catch (err) {
            dbFailed = true;
            hostApi.logEvent("warn", "index_folders.worker_failed", { error: (err as Error).message });
          }
          if (dbState.size > 0) {
            // DB 항목에 IndexState mtime으로 정밀도 보정 (Python int→Node.js float 오차)
            const indexState = await loadMergedIndexState();
            stateByPath = new Map(dbState);
            for (const [p, entry] of indexState) {
              if (stateByPath.has(p)) stateByPath.set(p, entry); // DB에 있는 것만 mtime 보정
            }
          } else if (dbFailed) {
            // listDocuments() 네트워크 오류 → worker crash/포트 막힘 → IndexState 폴백
            hostApi.logEvent("warn", "index_folders.fallback_to_index_state", {});
            stateByPath = await loadMergedIndexState();
          } else {
            // worker 응답 OK, DB 비어있음 → IndexState stale 가능성 → 빈 맵으로 재스캔 유도
            stateByPath = new Map();
            hostApi.logEvent("warn", "index_folders.db_empty_while_running", {});
          }
        } else {
          // worker 미실행 → IndexState fallback (오프라인 표시)
          stateByPath = await loadMergedIndexState();
        }
        hostApi.logEvent("info", "index_folders.state", {
          started,
          stateSize: stateByPath.size,
        });

        // index_folders는 디스크를 walk 해서 정확한 totalFiles / pendingFiles
        // 를 함께 노출한다. 이전에는 quick:true 경로를 사용해 IndexState 기반
        // 카운트만 보냈는데, 그러면 새로 추가됐지만 아직 한 번도 스캔되지
        // 않은 폴더가 (디스크에 파일이 13개 있어도) IndexState 가 비어 있다는
        // 이유로 status="empty", 0/0 으로 표시되어 UI 가 "비어 있음" 이라고
        // 거짓을 말했다. 8초 cache(`FOLDER_SUMMARY_CACHE_TTL_MS`) 가 반복
        // 호출 비용을 흡수하므로 정상 경로로 walk 한다.
        const summaries = await Promise.all(
          folders.map((folder) => buildFolderSummary(folder, stateByPath)),
        );
        return { folders, summaries };
      },

      index_folders_purge_orphans: async () => {
        await ensureStarted();
        const allFolders = await loadPersistedFolders();

        // Load DB state (same as index_scan)
        let stateForRefresh: Map<string, { docId: string; mtimeMs: number; indexedAt: string }>;
        try {
          const docs = uniqueDocuments((await plugin.listDocuments()) as LocalIndexerDocumentMeta[]);
          stateForRefresh = buildStateMapFromDocs(docs);
        } catch {
          stateForRefresh = await loadMergedIndexState();
        }

        // Purge orphaned docs per folder (files deleted from disk)
        let totalPurged = 0;
        for (const folder of allFolders) {
          const folderKeys = [...stateForRefresh.keys()].filter((p) => isWithinFolder(p, folder));
          const currentPaths = new Set(
            (await listIndexableFiles(folder).catch(() => [])).map((f) => f.filePath),
          );
          const orphans = folderKeys.filter((p) => !currentPaths.has(p));
          if (orphans.length > 0) {
            await removeIndexedDocumentsForPaths(orphans).catch(() => {});
            for (const p of orphans) {
              await Promise.all(indexStateStores.map((s) => s.removeEntry(p)));
              stateForRefresh.delete(p);
            }
            totalPurged += orphans.length;
          }
        }

        hostApi.logEvent("info", "index_folders_purge_orphans.purged", { totalPurged });

        const summaries = await Promise.all(
          allFolders.map((folder) => buildFolderSummary(folder, stateForRefresh)),
        );
        return { folders: allFolders, summaries, purged: totalPurged };
      },

      index_refresh_folder: async (payload?: unknown) => {
        const p = (payload ?? {}) as { folder?: string };
        if (!p.folder) throw new Error("folder path is required");
        const folder = resolve(p.folder);
        const folders = await loadPersistedFolders();
        if (!folders.includes(folder)) throw new Error("folder is not registered");

        await ensureStarted();
        await syncAllowedRootsToWorker(folders, [folder]);

        const stateByPath = await loadMergedIndexState();
        const currentFiles = await listIndexableFiles(folder);
        const currentPaths = new Set(currentFiles.map((file) => file.filePath));
        const refreshTargets = currentFiles.filter((file) => {
          const entry = stateByPath.get(file.filePath);
          return !entry || Math.floor(entry.mtimeMs) < Math.floor(file.mtimeMs);
        });
        const orphanPaths = [...stateByPath.keys()].filter(
          (filePath) => isWithinFolder(filePath, folder) && !currentPaths.has(filePath),
        );

        let indexed = 0;
        let failed = 0;
        for (const target of refreshTargets) {
          try {
            const docId = await plugin.indexDocument(
              target.filePath,
              getIndexModeForPath(target.filePath, { includeImages: isImageEmbeddingEnabled() }) ?? "auto",
            );
            await recordIndexedState(target.filePath, docId);
            indexed += 1;
          } catch {
            failed += 1;
          }
        }

        const removedDocs = await removeIndexedDocumentsForPaths(orphanPaths);
        for (const filePath of orphanPaths) {
          await Promise.all(indexStateStores.map((store) => store.removeEntry(filePath)));
        }

        return {
          folder,
          indexed,
          failed,
          removedDocuments: removedDocs.removed,
          summary: await buildFolderSummary(folder),
          message: `Refreshed ${folder}: indexed ${indexed}, removed ${removedDocs.removed}.`,
        };
      },

      // 폴더 선택은 호스트가 연다. 예전에는 이 플러그인이 `createRequire`
      // 로 `electron` 을 직접 받아 `dialog.showOpenDialog` 를 불렀는데,
      // 그건 메서드 하나가 아니라 main 프로세스 표면 전체를 쥐는 것이라
      // 플러그인을 격리된 자식 프로세스로 못 올리는 이유였다.
      //
      // 반환된 경로는 **권한이 아니라 답**이다. 읽기 제한은 deny-only 라
      // 평범한 사용자 디렉토리는 원래 읽을 수 있었고, 몰랐던 것은 사용자가
      // 어느 디렉토리를 가리켰는지뿐이다.
      //
      // `pickFolders` 가 없는 호스트를 위한 우회는 두지 않는다 —
      // `requires.minAppVersion` 이 그 조건을 로드 시점에 강제한다.
      index_pick_folder: async () => {
        const picked = await hostApi.pickFolders();
        if (picked.canceled || picked.folders.length === 0) {
          return { folders: [], canceled: true };
        }
        return { folders: picked.folders, canceled: false };
      },

      index_preview_folder: async (payload?: unknown) => {
        const p = (payload ?? {}) as { folder?: string };
        if (!p.folder || typeof p.folder !== "string") {
          throw new Error("folder 경로가 필요합니다.");
        }
        const absPath = resolve(p.folder);
        // UI 모달이 여러 폴더 미리보기를 함께 띄우므로 검증 실패는 throw 대신
        // error 필드로 반환 — 한 폴더의 차단/오류가 다른 폴더 미리보기를
        // 같이 무산시키지 않도록.
        const blockedMessage = getBlockedIndexPathMessage(absPath, blockOpts);
        if (blockedMessage) {
          return { folder: absPath, total: 0, byType: {}, sample: [], error: blockedMessage };
        }
        if (isHighChurnFolderPath(absPath, userHome)) {
          return {
            folder: absPath,
            total: 0,
            byType: {},
            sample: [],
            error: `성능 보호: '${absPath}'는 변경 이벤트가 너무 많은 경로라 실시간 인덱싱 폴더로 추가할 수 없습니다.`,
          };
        }
        try {
          const metadata = await stat(absPath);
          if (!metadata.isDirectory()) {
            return { folder: absPath, total: 0, byType: {}, sample: [], error: "폴더가 아닙니다." };
          }
        } catch (err) {
          return {
            folder: absPath,
            total: 0,
            byType: {},
            sample: [],
            error: (err as Error).message,
          };
        }
        try {
          // 미리보기는 토글 상태와 무관하게 폴더에 실제로 어떤 indexable
          // 파일이 있는지를 보여줘야 한다 (사용자가 jpg 폴더를 추가하려고
          // 미리보기 했는데 토글이 OFF 라 0 으로 보이면 혼란). 실제 인덱싱
          // 단계는 토글을 따라가므로 본 단계의 includeImages 강제가 인덱싱
          // 동작을 바꾸진 않는다.
          const files = await listIndexableFiles(absPath, { includeImages: true });
          const byType: Record<string, number> = {};
          for (const file of files) {
            const ext = extname(file.filePath).slice(1).toLowerCase();
            byType[ext] = (byType[ext] ?? 0) + 1;
          }
          const sample = files.slice(0, 5).map((f) => basename(f.filePath));
          return { folder: absPath, total: files.length, byType, sample };
        } catch (err) {
          return {
            folder: absPath,
            total: 0,
            byType: {},
            sample: [],
            error: (err as Error).message,
          };
        }
      },

      index_add_folder: async (payload?: unknown) => {
        const p = (payload ?? {}) as { folder?: string };
        if (!p.folder) throw new Error("folder 경로가 필요합니다.");
        const absPath = resolve(p.folder);
        const blockedMessage = getBlockedIndexPathMessage(absPath, blockOpts);
        if (blockedMessage) {
          throw new Error(blockedMessage);
        }
        // multi-user 호스트에서 다른 사용자 홈(`C:\Users\<other>` 등)을
        // 인덱싱 폴더로 추가해 그 사용자 문서를 인덱스 DB 로 옮기는 경로만
        // 핀포인트로 차단. 사용자 홈 외부의 일반 드라이브(`D:\foo`,
        // `/mnt/data`)는 그대로 허용.
        if (isOtherUserHome(absPath, userHome)) {
          throw new Error(
            `보안: 다른 사용자 홈 디렉터리는 인덱싱 폴더로 추가할 수 없습니다: ${absPath}`,
          );
        }
        if (isHighChurnFolderPath(absPath, userHome)) {
          throw new Error(`성능 보호: '${absPath}'는 변경 이벤트가 너무 많은 경로라 실시간 인덱싱 폴더로 추가할 수 없습니다.`);
        }
        return withFoldersLock(async () => {
          const folders = await loadPersistedFolders();
          if (folders.includes(absPath)) {
            const summary = await buildFolderSummary(absPath);
            return { folders, added: false, message: "이미 등록된 폴더입니다.", summary };
          }
          folders.push(absPath);
          await persistFolders(folders);
          invalidateFolderSummaryCache();
          if (started) {
            // Worker 허용 루트를 먼저 갱신해야 rebuild 직후의 scanOnce()가
            // 새 폴더의 파일을 /indexer/reindex에 넣을 때 422로 거부되지 않음.
            await syncAllowedRootsToWorker(folders);
            // IndexState 먼저 → DB로 보충 (이미 인덱싱된 파일 재스캔 방지).
            const addFolderState = await loadMergedIndexState().catch(() => new Map());
            let existingDocs: LocalIndexerDocumentMeta[] = [];
            try {
              existingDocs = uniqueDocuments((await plugin.listDocuments()) as LocalIndexerDocumentMeta[]);
            } catch { /* 실패 시 IndexState만 사용 */ }
            await rebuildIndexer(folders, existingDocs, addFolderState);
            if (realtimeWatchEnabled) {
              await autoIndexer.ensureWatching();
            }
          }
          emitFolderChange({
            folder: absPath,
            folders,
            message: `폴더 추가: ${absPath}`,
          });
          hostApi.logEvent("info", "index_add_folder", { folder: absPath, total: folders.length, allFolders: folders });
          const summary = await buildFolderSummary(absPath);
          return { folders, added: true, message: `폴더 추가: ${absPath}`, summary };
        });
      },

      index_add_folders: async (payload?: unknown) => {
        const p = (payload ?? {}) as { folders?: unknown };
        if (!Array.isArray(p.folders) || p.folders.length === 0) {
          throw new Error("folders 배열이 필요합니다.");
        }
        const inputs = p.folders.filter((f): f is string => typeof f === "string" && f.length > 0);
        if (inputs.length === 0) {
          throw new Error("folders 배열에 유효한 경로가 없습니다.");
        }

        return withFoldersLock(async () => {
          const folders = await loadPersistedFolders();
          const added: string[] = [];
          const skipped: Array<{ folder: string; reason: string }> = [];
          const failures: Array<{ folder: string; error: string }> = [];

          for (const raw of inputs) {
            const absPath = resolve(raw);
            const blocked = getBlockedIndexPathMessage(absPath, blockOpts);
            if (blocked) {
              failures.push({ folder: absPath, error: blocked });
              continue;
            }
            // index_add_folder와 동일 정책. multi-user 호스트에서 다른
            // 사용자 홈 경로가 일괄 추가에 끼어드는 것만 막고, 사용자 홈
            // 외부의 일반 드라이브는 그대로 허용.
            if (isOtherUserHome(absPath, userHome)) {
              failures.push({
                folder: absPath,
                error: `보안: 다른 사용자 홈 디렉터리는 인덱싱 폴더로 추가할 수 없습니다: ${absPath}`,
              });
              continue;
            }
            if (isHighChurnFolderPath(absPath, userHome)) {
              failures.push({
                folder: absPath,
                error: `성능 보호: '${absPath}'는 변경 이벤트가 너무 많은 경로라 실시간 인덱싱 폴더로 추가할 수 없습니다.`,
              });
              continue;
            }
            if (folders.includes(absPath)) {
              skipped.push({ folder: absPath, reason: "이미 등록된 폴더입니다." });
              continue;
            }
            folders.push(absPath);
            added.push(absPath);
          }

          if (added.length > 0) {
            await persistFolders(folders);
            invalidateFolderSummaryCache();
            if (started) {
              // Worker 허용 루트를 먼저 갱신해야 rebuild 직후의 scanOnce()가
              // 새 폴더 파일을 /indexer/reindex에 넣을 때 422로 거부되지 않음.
              await syncAllowedRootsToWorker(folders);
              const addState = await loadMergedIndexState().catch(() => new Map());
              let existingDocs: LocalIndexerDocumentMeta[] = [];
              try {
                existingDocs = uniqueDocuments((await plugin.listDocuments()) as LocalIndexerDocumentMeta[]);
              } catch { /* 실패 시 IndexState만 사용 */ }
              // 단일 rebuild로 모든 신규 폴더 일괄 처리 — N번 추가해도 1회만 rebuild.
              await rebuildIndexer(folders, existingDocs, addState);
              if (realtimeWatchEnabled) {
                await autoIndexer.ensureWatching();
              }
            }
            emitFolderChange({
              folders,
              added,
              message: `폴더 ${added.length}개 추가`,
            });
            hostApi.logEvent("info", "index_add_folders", { added, skipped, failures, total: folders.length });
          }

          return { folders, added, skipped, failures };
        });
      },

      index_remove_folder: async (payload?: unknown) => {
        const p = (payload ?? {}) as { folder?: string };
        if (!p.folder) throw new Error("folder 경로가 필요합니다.");
        const absPath = resolve(p.folder);
        return withFoldersLock(async () => {
          let folders = await loadPersistedFolders();
          const before = folders.length;
          folders = folders.filter((f) => f !== absPath);
          if (folders.length === before) return { folders, removed: false, message: "등록되지 않은 폴더입니다." };
          await ensureStarted();
          const purgeResult = await removeIndexedDocumentsForFolder(absPath);
          const removedStateEntries = await removeIndexedStateForFolder(absPath);
          await persistFolders(folders);
          invalidateFolderSummaryCache();
          if (started) {
            // 제거 시에도 worker 허용 루트를 좁혀서 일관성 유지 (향후 재스캔이
            // 삭제된 폴더 파일을 내보내지 않도록).
            await syncAllowedRootsToWorker(folders);
            if (folders.length > 0) {
              // IndexState 먼저 → DB로 보충 (기존 indexed 파일 재스캔 방지).
              const removeFolderState = await loadMergedIndexState().catch(() => new Map());
              let remainingDocs: LocalIndexerDocumentMeta[] = [];
              try {
                remainingDocs = uniqueDocuments((await plugin.listDocuments()) as LocalIndexerDocumentMeta[]);
              } catch { /* 실패 시 IndexState만 사용 */ }
              await rebuildIndexer(folders, remainingDocs, removeFolderState);
              if (realtimeWatchEnabled) {
                await autoIndexer.ensureWatching();
              }
            } else {
              await autoIndexer.stop();
            }
          }
          const message =
            purgeResult.failed > 0
              ? `폴더 제거: ${absPath} (문서 ${purgeResult.removed}개 삭제, 상태 ${removedStateEntries}개 정리, ${purgeResult.failed}개 실패)`
              : `폴더 제거: ${absPath} (문서 ${purgeResult.removed}개 삭제, 상태 ${removedStateEntries}개 정리)`;
          emitFolderChange({
            folder: absPath,
            folders,
            message,
          });
          hostApi.logEvent("info", "index_remove_folder", { folder: absPath, total: folders.length });
          return { folders, removed: true, removedDocuments: purgeResult.removed, failedDocuments: purgeResult.failed, message };
        });
      },

      chat_preview: async (payload?: unknown) => {
        await ensureStarted();
        const question =
          typeof (payload as Record<string, unknown>)?.question === "string"
            ? ((payload as Record<string, unknown>).question as string)
            : "";
        if (!question.trim()) return { question, results: [], preview: "질문을 입력해주세요." };

        try {
          // chat_preview는 가벼운 키워드 1차 스크린 — BM25 전용. 정밀(hybrid) 검색은 index_search 사용.
          const hits = await workerClient.searchBm25(question, 5);
          return {
            question,
            documentCount: hits.length,
            results: hits.map((h) => ({
              chunkId: h.chunkId,
              docId: h.docId,
              docName: h.docName,
              page: h.page,
              snippet: h.rawText.slice(0, 500),
            })),
            preview:
              hits.length === 0
                ? "관련 문서를 찾지 못했습니다."
                : `${hits.length}개 문서 발견:\n` +
                  hits
                    .map((h) => `- ${h.docName} (page ${h.page ?? "?"}): ${h.rawText.slice(0, 120)}`)
                    .join("\n"),
          };
        } catch (err) {
          const message = (err as Error).message;
          context.log(`chat_preview bm25 search failed: ${message}`);
          throw new Error(`chat_preview requires the Local Indexer worker BM25 search endpoint: ${message}`);
        }
      },

      index_search: async (payload?: unknown) => {
        await ensureStarted();
        const data = (payload ?? {}) as Record<string, unknown>;
        const query = typeof data.query === "string" ? data.query.trim() : "";
        const modeRaw = typeof data.mode === "string" ? data.mode.toLowerCase() : "hybrid";
        const mode: "bm25" | "vector" | "hybrid" =
          modeRaw === "bm25" || modeRaw === "vector" || modeRaw === "hybrid" ? modeRaw : "hybrid";
        const topKRaw = typeof data.topK === "number" && Number.isFinite(data.topK) ? Math.floor(data.topK) : 10;
        const topK = Math.max(1, Math.min(50, topKRaw));
        // Why: blank-query 도 응답 shape(특히 topK)을 스키마(1~50)에 맞춰야 한다.
        // 이전에는 topK:0 을 반환해 스키마 위반 + downstream consumer가 무한 재시도하는 문제가 있었음.
        if (!query) {
          return { query: "", mode, topK, hits: [] };
        }

        try {
          const hits =
            mode === "bm25"
              ? await workerClient.searchBm25(query, topK)
              : mode === "vector"
                ? await workerClient.searchVector(query, topK)
                : await workerClient.searchHybrid(query, topK);
          // Why: WorkerClient는 내부 라벨(bm25/vec/hybrid)을 쓰지만 외부 툴 스펙은
          // mode와 동일한 어휘(bm25/vector/hybrid)로 노출해야 일관성이 있다.
          const normalizeSource = (s: "bm25" | "vec" | "hybrid"): "bm25" | "vector" | "hybrid" =>
            s === "vec" ? "vector" : s === "hybrid" ? "hybrid" : "bm25";
          return {
            query,
            mode,
            topK,
            hits: hits.map((h) => ({
              chunkId: h.chunkId,
              docId: h.docId,
              docName: h.docName,
              page: h.page,
              score: h.score,
              source: normalizeSource(h.source),
              path: h.path,
              snippet: h.rawText.slice(0, 500),
              rawText: h.rawText,
            })),
          };
        } catch (err) {
          const message = (err as Error).message;
          context.log(`index_search worker search failed: ${message}`, { mode, query });
          throw new Error(`index_search failed (${mode}): ${message}`);
        }
      },

      index_get_document: async (payload?: unknown) => {
        await ensureStarted();
        const data = (payload ?? {}) as Record<string, unknown>;
        const docId = typeof data.docId === "string" ? data.docId.trim() : "";
        if (!docId) {
          throw new Error("index_get_document: 'docId' is required");
        }
        const pagesArg = typeof data.pages === "string" ? data.pages.trim() : "";
        const includeContent = data.includeContent === true;
        const includeStructure = data.includeStructure === true;

        let row: DocumentRow;
        try {
          row = await workerClient.getDocument(docId);
        } catch (err) {
          throw new Error(
            `index_get_document: 문서 조회 실패 (${docId}): ${(err as Error).message}`,
          );
        }

        const doc = {
          docId: row.doc_id,
          docName: row.doc_name,
          type: row.doc_type,
          path: row.path,
          pageCount: row.page_count,
          lineCount: row.line_count,
          indexedAt: row.indexed_at,
          status: row.status,
          contentState: row.content_state,
        };

        let pages: PageContentItem[] = [];
        if (pagesArg) {
          try {
            pages = await workerClient.getPageContent(docId, pagesArg);
          } catch (err) {
            throw new Error(
              `index_get_document: 페이지 조회 실패 (${docId}, ${pagesArg}): ${(err as Error).message}`,
            );
          }
        } else if (includeContent && typeof row.page_count === "number" && row.page_count > 0) {
          // 전체 본문 fetch는 페이로드 폭주를 막기 위해 50페이지로 캡.
          const cap = Math.min(row.page_count, 50);
          try {
            pages = await workerClient.getPageContent(docId, `1-${cap}`);
          } catch (err) {
            throw new Error(
              `index_get_document: 전체 페이지 조회 실패 (${docId}): ${(err as Error).message}`,
            );
          }
        }

        if (!includeStructure) {
          return { doc, pages };
        }

        // 구조는 doc.pageCount 의 중복이 아니다: 워커는 청크가 실제로 저장된
        // 페이지 번호만 돌려주므로, 파싱에서 빠진 페이지를 요청하는 왕복을
        // 없애 준다 — 긴 문서에서 pages 범위를 고르는 근거가 이 목록이다.
        let structure: unknown;
        try {
          structure = await workerClient.getStructure(docId);
        } catch (err) {
          throw new Error(
            `index_get_document: 구조 조회 실패 (${docId}): ${(err as Error).message}`,
          );
        }

        return { doc, pages, structure };
      },

      // ─── Image embedding settings ────────────────────────────────
      // 이미지 임베딩 토글은 startup config 가 아니라 call-time 옵션이라
      // worker restart 없이 즉시 적용된다. UI 토글이 이 두 핸들러를 통해
      // 호스트 config store 를 갱신하고, scan walker 가 그 값을 매번 읽어
      // image-only 경로(.jpg/.jpeg/.png + 컨테이너 이미지 추출)를 활성/
      // 비활성한다.
      index_get_settings: async () => {
        const current = await loadImageSettings();
        const currentEmbeddingProvider = readEmbeddingProvider({ hostVendor: readActiveVendor() });
        const currentEmbeddingModel =
          validateEmbeddingModel(getConfig("embeddingModel")) ?? embeddingModel ?? "";
        // Re-resolve the caption key on every read so the main-UI "API
        // 키 없음" warning reflects host-config changes the user makes
        // mid-session (e.g. they enter the key in plugin settings while
        // the main panel is open). The reader handles secret store +
        // env fallback in one place.
        const liveApiKey = await readCaptionApiKey();
        return {
          imageEmbeddingEnabled: current.imageEmbeddingEnabled,
          imageCaptionMode: current.imageCaptionMode,
          // Provider / endpoint / model are sourced from host config so
          // the plugin settings UI is the single source of truth. The
          // main UI only renders them, never writes them.
          imageCaptionProvider: readCaptionProvider({ hostVendor: readActiveVendor() }),
          imageCaptionEndpoint: readCaptionEndpoint({ hostVendor: readActiveVendor() }),
          imageCaptionModel: readCaptionModel({
            provider: readCaptionProvider({ hostVendor: readActiveVendor() }),
          }),
          imageCaptionApiVersion: readCaptionApiVersion({
            provider: readCaptionProvider({ hostVendor: readActiveVendor() }),
          }),
          embeddingProvider: currentEmbeddingProvider,
          embeddingModel: currentEmbeddingModel,
          embeddingApiVersion: readEmbeddingApiVersion(),
          hasApiKey: Boolean(liveApiKey),
        };
      },

      index_set_image_embedding: async (payload?: unknown) => {
        // The main UI is now toggle-only. Provider / endpoint / model /
        // apiKey are managed in Ave's plugin settings — this handler
        // intentionally ignores anything else on the payload so a stale
        // UI build can't push provider mutations from here.
        const data = (payload ?? {}) as Record<string, unknown>;
        const enabled = data.enabled === true;
        const previous = await loadImageSettings();
        const mode: ImageCaptionMode = "cloud";

        const next: ImageEmbeddingSettings = {
          imageEmbeddingEnabled: enabled,
          imageCaptionMode: mode,
        };
        await saveImageSettings(next);

        const captionHandle = await resolveCaptionHostHandle();
        const hostBaseUrl = captionHandle?.baseUrl;
        const hostVendor = captionHandle?.vendor ?? readActiveVendor();
        const provider = readCaptionProvider({ hostBaseUrl, hostVendor });
        const endpoint = readCaptionEndpoint({ provider, hostBaseUrl, hostVendor });
        const model = readCaptionModel({ provider, hostBaseUrl });
        // Push the session token; the caption provider key stays host-side in
        // the broker/hostFetch path.
        const apiKey = captionCredentialFor(captionHandle);
        const apiVersion = readCaptionApiVersion({ provider, hostBaseUrl });

        // Sidecar 는 이미 위에서 영속화됨. worker push 는 best-effort —
        // 워커가 죽어있거나 (port 충돌, 좀비 등) 시작 실패해도 토글 자체는
        // 성공으로 처리해야 다른 UI 동작이 줄줄이 차단되지 않는다. 다음
        // worker boot 의 startup-sync 가 디스크에서 다시 읽어 반영.
        let workerSynced = false;
        let workerSyncError: string | undefined;
        try {
          await ensureStarted();
          await workerClient.setImageCaptioning(
            next.imageEmbeddingEnabled,
            provider,
            model,
            endpoint,
            apiKey,
            apiVersion,
          );
          workerSynced = true;
        } catch (err) {
          workerSyncError = (err as Error).message;
          hostApi.logEvent("warn", "index_set_image_embedding.worker_sync_failed", {
            error: workerSyncError,
          });
          // UI 경고 배너에도 표시 — 토글이 디스크엔 저장됐지만 다음 스캔까지
          // 워커가 반영을 못 한다는 사실을 사용자에게 보여준다.
          emitIndexWarning({
            kind: "indexDocument.failed",
            error: workerSyncError,
            message:
              "워커 동기화 실패 — 토글은 저장됐지만 다음 워커 부팅 시 반영됩니다. " +
              "(원인: " + workerSyncError + ")",
          });
        }
        // Walker 도 알아야 함 (워커 sync 와 무관하게 in-process 상태).
        if (captionHandle) {
          try { await captionHandle.release(); } catch { /* best effort */ }
        }
        autoIndexer.setImageEmbeddingEnabled?.(next.imageEmbeddingEnabled);
        let invalidatedImageEntries = 0;
        if (next.imageEmbeddingEnabled && !previous.imageEmbeddingEnabled) {
          invalidatedImageEntries = autoIndexer.invalidateImageEntries?.() ?? 0;
        }
        if (next.imageEmbeddingEnabled !== previous.imageEmbeddingEnabled) {
          invalidateFolderSummaryCache();
        }

        hostApi.logEvent("info", "index_set_image_embedding", {
          enabled: next.imageEmbeddingEnabled,
          previousEnabled: previous.imageEmbeddingEnabled,
          mode: next.imageCaptionMode,
          previousMode: previous.imageCaptionMode,
          provider,
          model,
          // Log host only — Azure URLs embed tenant/resource names in the
          // full URL; the host suffices for audit/debug without leaking
          // internal-network metadata. The full endpoint is still
          // returned to the UI (caller-controlled) below.
          endpointHost: endpoint === null ? null : endpointHostForLog(endpoint),
          apiVersion,
          hasApiKey: apiKey.length > 0,
          workerSynced,
          invalidatedImageEntries,
        });
        const baseMessage = next.imageEmbeddingEnabled
          ? "이미지 캡션이 활성화되었습니다. 다음 스캔부터 적용됩니다."
          : "이미지 캡션이 비활성화되었습니다.";
        return {
          imageEmbeddingEnabled: next.imageEmbeddingEnabled,
          imageCaptionMode: next.imageCaptionMode,
          imageCaptionProvider: provider,
          imageCaptionModel: model,
          imageCaptionEndpoint: endpoint,
          imageCaptionApiVersion: apiVersion,
          hasApiKey: apiKey.length > 0,
          workerSynced,
          message: workerSynced
            ? baseMessage
            : `${baseMessage} (워커 동기화 보류 — 다음 워커 부팅 시 반영)`,
        };
      },
  };

  return {
    // start() may execute for a hidden marketplace candidate while the
    // incumbent generation still owns the worker socket and persistent index.
    // Keep it side-effect free; the host invokes onPublished only after the
    // predecessor has completed graceful retirement.
    async start() {},
    // Worker readiness remains a publication gate for normal boot completion.
    // Cache sync / watcher warmup stays backgrounded inside ensureStarted.
    async onPublished() {
      try {
        await ensureStarted();
        context.log("local-indexer plugin started");
        // Propose the nightly-rescan routine once (fire-and-forget). Runs after
        // ensureStarted so registered folders are loaded before the gate check.
        void runRescanSuggestionOnLaunch();
      } catch (err) {
        context.log("local-indexer plugin startup failed", err);
        throw err;
      }
    },
    async stop() {
      await teardown();
      context.log("local-indexer plugin stopped");
    },

    handlers: {
      // ── index_scan: full scan | one-folder refresh | ad-hoc paths ──
      // Discriminator is presence-based: paths[] → ad-hoc indexing (former
      // document_index_scan), folder → incremental refresh of one registered
      // folder (former index_refresh_folder), nothing → scan all registered
      // folders (former index_scan).
      index_scan: async (payload?: unknown) => {
        const p = (payload ?? {}) as { folder?: unknown; paths?: unknown };
        if (Array.isArray(p.paths)) {
          return handlerImpls.document_index_scan(payload);
        }
        if (typeof p.folder === "string" && p.folder.length > 0) {
          return handlerImpls.index_refresh_folder(payload);
        }
        return handlerImpls.index_scan();
      },
      index_scan_cancel: handlerImpls.index_scan_cancel,
      index_scan_status: handlerImpls.index_scan_status,
      index_clear_warnings: handlerImpls.index_clear_warnings,
      index_documents: handlerImpls.index_documents,
      // ── index_folders: list | add (single/batch) | remove ──
      // action selects the operation; default 'list' preserves the former
      // no-arg index_folders behavior (also how the UI lists folders).
      index_folders: async (payload?: unknown) => {
        const p = (payload ?? {}) as { action?: unknown; folder?: unknown; folders?: unknown };
        const action = typeof p.action === "string" ? p.action.toLowerCase() : "list";
        if (action === "add") {
          if (Array.isArray(p.folders)) {
            return handlerImpls.index_add_folders(payload);
          }
          if (typeof p.folder === "string") {
            return handlerImpls.index_add_folder(payload);
          }
          throw new Error(
            "index_folders: action 'add' requires 'folder' (string) or 'folders' (array).",
          );
        }
        if (action === "remove") {
          return handlerImpls.index_remove_folder(payload);
        }
        if (action === "list") {
          return handlerImpls.index_folders();
        }
        throw new Error(
          `index_folders: unknown action '${String(p.action)}' (expected list | add | remove).`,
        );
      },
      index_folders_purge_orphans: handlerImpls.index_folders_purge_orphans,
      index_pick_folder: handlerImpls.index_pick_folder,
      index_preview_folder: handlerImpls.index_preview_folder,
      // ── index_search: bm25 (preview) | vector | hybrid ──
      // mode 'bm25' reproduces the former chat_preview behavior verbatim — a
      // BM25 keyword screen returning human-readable preview formatting —
      // while vector/hybrid return the structured hit list. Both reuse the
      // original handler bodies (no rewrite).
      index_search: async (payload?: unknown) => {
        const data = (payload ?? {}) as Record<string, unknown>;
        const modeRaw = typeof data.mode === "string" ? data.mode.toLowerCase() : "hybrid";
        if (modeRaw === "bm25") {
          const query = typeof data.query === "string" ? data.query : "";
          return handlerImpls.chat_preview({ question: query });
        }
        return handlerImpls.index_search(payload);
      },
      index_get_document: handlerImpls.index_get_document,
      index_get_settings: handlerImpls.index_get_settings,
      index_set_image_embedding: handlerImpls.index_set_image_embedding,
    },
  };
}
