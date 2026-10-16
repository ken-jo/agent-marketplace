import type { PluginWorkerSpec, SpawnedPluginWorker } from "@ave/plugin-contract";
import type { EgressChannel, EgressUpstreamFetch } from "./egressBroker.js";

export type { PluginWorkerSpec, SpawnedPluginWorker } from "@ave/plugin-contract";

export type IndexMode = "auto" | "pdf" | "md" | "docx" | "pptx" | "xlsx" | "txt" | "html" | "image";

export interface LocalIndexerWorkerOptions {
  /**
   * 호스트-중재 워커 spawn primitive (`hostApi.spawnWorker`). 주입되면 워커는
   * 호스트가 ASRT-confined로 띄운다. socketPath가 있으면 mac/linux UDS
   * control을 사용하고, null이면 TCP control을 사용한다(gate-OFF plain spawn
   * 또는 Windows ASRT-wrapped TCP control). transport 값으로 sandbox 여부를
   * 추론하지 않는다.
   */
  spawnWorker?: (spec: PluginWorkerSpec) => Promise<SpawnedPluginWorker>;
  pythonExecutable?: string;
  workerScriptPath?: string;
  indexStorageRoot?: string;
  testMode?: boolean;
  host?: string;
  port?: number;
  workspace?: string;
  /**
   * Plugin-scoped data directory supplied by the host via
   * `PluginRuntimeContext.pluginDataDir`. When provided, index DB and worker
   * scratch files are stored under `<pluginDataDir>/index/`.
   */
  pluginDataDir?: string;
  /**
   * The one directory this plugin may bind a Unix-domain socket in, supplied by
   * the host via `PluginRuntimeContext.pluginSocketDir`.
   *
   * The egress broker binds there instead of on loopback TCP. A confined plugin
   * child cannot bind loopback: on macOS the bind is refused, and on Linux it
   * succeeds into a network namespace the worker is not in — which is worse,
   * because the failure then arrives at the worker's first request rather than
   * at the bind. A Unix socket is a filesystem object and has neither problem.
   *
   * Required in practice on those platforms rather than optional: the host
   * supplies it on every context, and `requires.minAppVersion` is what enforces
   * that. Typed optional only because the whole options bag is. Unread on
   * Windows, where the broker binds loopback TCP because `listen(path)` there is
   * a named pipe rather than a Unix socket — `egressBrokerTransportFor` holds
   * that decision.
   */
  pluginSocketDir?: string;
  apiKey?: string;
  model?: string;
  retrieveModel?: string;
  startupTimeoutMs?: number;
  shutdownGraceMs?: number;
  /**
   * Absolute directories the worker is allowed to index.
   */
  allowedRoots?: string[];
  /** 임베딩 모델명. 'text-embedding-*'이면 openai provider 자동 선택.
   *  Azure 의 경우 deployment name 을 그대로 사용. */
  embeddingModel?: string;
  /** 임베딩 provider 명시. 미지정 시 embeddingModel로 자동 감지.
   *  ``azure`` 는 Azure OpenAI Service 의 임베딩 deployment 사용. */
  embeddingProvider?: "openai" | "azure";
  /** OpenAI-호환 base URL (provider=openai, optional) 또는 Azure OpenAI
   *  리소스 URL (provider=azure, required). */
  embeddingEndpoint?: string;
  embeddingApiVersion?: string;
  /**
   * Host 의 active LLM vendor 식별자 (예: "openai", "azure-foundry",
   * "azure-openai", "claude"). 명시 embeddingProvider / model 이 없을 때
   * `resolveEmbeddingProvider` 가 azure 계열 호스트를 감지하여 Azure
   * embedding deployment 로 자동 매핑하기 위해 사용한다.
   * hostPlugin 이 `hostApi.config.get("hostApiVendor")` 에서 읽어 주입.
   */
  hostVendor?: string;
  /**
   * Maximum file size in bytes. Files larger than this limit are recorded as
   * status='failed' (explicit failure visible to the user, not a silent skip).
   * Default: 52428800 (50 MB). Set to 0 to disable the limit.
   */
  maxFileSize?: number;
  /**
   * Maximum number of chunks per document. Documents that generate more chunks
   * than this limit are truncated to the cap and indexed with a recorded
   * warning in IndexResult.errors[]. Default: 2000.
   */
  maxChunksPerDoc?: number;
  /**
   * Host-mediated egress broker channel resolvers (P3 ⑬). Optional only for
   * config-only construction paths that never call start(); start() requires
   * these channels and rejects direct worker provider egress when they are
   * absent. With channels present, the plugin starts a loopback `EgressBroker`
   * BEFORE spawning the worker, passes the worker only a per-session broker
   * token (never the provider key), and the worker reaches the provider
   * exclusively through the broker. Each resolver is a thunk re-running the
   * host's P0 trust chokepoint
   * (`resolveEmbeddingKeyForEndpoint` / `resolveCaptionKeyForEndpoint`) fresh
   * per request, so a custom untrusted endpoint still gets the plugin-own key,
   * never the host key. Production hostPlugin always wires this with hostFetch
   * as the upstream transport; direct construction tests may inject their own
   * upstream transport explicitly.
   */
  egressChannels?: { embedding: EgressChannel; caption: EgressChannel };
  /**
   * Allow-list gate the broker applies to the host-resolved upstream base
   * (defence-in-depth: the worker cannot name a host, so this only ever sees
   * host-controlled URLs). Typically `isTrustedEndpointUrl`-or-validated-custom.
   */
  isUpstreamAllowed?: (url: string) => boolean;
  /**
   * Corporate-CA PEM under the host's storage root, or `null` when it is not
   * there. Resolved and existence-checked ONCE by the host entry, because it
   * has two consumers that must agree: the broker's upstream provider TLS, and
   * the worker's `SSL_CERT_FILE` for the model downloads it still makes
   * directly. Two resolutions of one path is how those two come to disagree
   * about whether corporate TLS is being intercepted.
   */
  corpCaPath?: string | null;
  /** Host-owned upstream transport. Optional only until start(); start() requires it. */
  egressUpstreamFetch?: EgressUpstreamFetch;
  onEgressEvent?: (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>) => void;
  onWorkerStdout?: (line: string) => void;
  onWorkerStderr?: (line: string) => void;
  /**
   * #955 round-2 architect Minor: surface azure-inherit config-missing
   * states beyond stderr so the host can emit a UI-visible warning event
   * (e.g. `local_indexer.config_warning`). Called once per scan-start
   * detect that resolved `azure` provider with missing endpoint or apiKey.
   * Stderr message is still emitted in parallel for log archival.
   */
  onConfigWarning?: (warning: {
    reason: "azure-inherit-missing-config";
    missing: string[];
    inheritedFrom: string;
  }) => void;
}

export interface LocalIndexerDocumentMeta {
  id: string;
  doc_id: string;
  type: string;
  doc_type: string;
  path: string;
  doc_name: string;
  doc_description?: string;
  page_count?: number;
  line_count?: number;
  mtime_ms?: number;
  indexed_at?: number | string;
  status?: string;
  /** Content quality independent of `status`: 'ok' | 'empty' | 'embed_failed'. */
  content_state?: string;
}

export interface LocalIndexerClient {
  indexDocument(filePath: string, mode?: IndexMode): Promise<string>;
  /** Remove an indexed document for unlink events when the host exposes delete support. */
  removeDocument?(docId: string): Promise<void>;
}

export type ScanProgressStatus = "idle" | "running" | "done" | "failed" | "canceled";

export interface FolderProgressCounters {
  total: number;
  processed: number;
  indexed: number;
  failed: number;
}

export interface ScanProgressSnapshot {
  status: ScanProgressStatus;
  total: number;
  processed: number;
  indexed: number;
  failed: number;
  currentPath?: string;
  message?: string;
  /** Per-folder breakdown of this scan cycle, keyed by registered absolute
   * folder path. Populated while ``status === "running"`` and retained
   * through done/failed/canceled so the UI can move finished folders into
   * the "complete" group mid-scan. A folder with ``total === 0`` had no
   * work this cycle (everything was already up-to-date). */
  byFolder?: Record<string, FolderProgressCounters>;
}

export interface FolderAutoIndexerOptions {
  client: LocalIndexerClient;
  folders: string[];
  extensions?: string[];
  /** chokidar ignore patterns. Merged with default dotfile ignore. */
  ignored?: Array<string | RegExp>;
  /** Follow symbolic links. Default: false (avoids cycles and untrusted targets). */
  followSymlinks?: boolean;
  /** Force polling instead of native fs events. Fallback for network mounts / WSL. */
  usePolling?: boolean;
  /** Trailing-edge debounce window for rapid add/change events (ms). Default: 300. */
  debounceMs?: number;
  /** When true, .jpg/.jpeg/.png files are walked and routed through the
   * worker's image-captioning path. Mutable via
   * FolderAutoIndexer.setImageEmbeddingEnabled so UI toggle flips
   * propagate without rebuilding the indexer. Default: false. */
  imageEmbeddingEnabled?: boolean;
  onScanProgress?: (snapshot: ScanProgressSnapshot) => void;
  /** Called when a file fails to index. Use to remove stale state entries and DB records.
   *  `error` is the indexer error message (e.g. "indexDocument: 인덱싱 실패 (...): empty content"); host
   *  can forward it to the UI warning banner so per-file failures are visible without
   *  polluting the top scan-status string with raw error text. */
  onFileFailed?: (filePath: string, docId?: string, error?: string) => void | Promise<void>;
}

export interface FolderAutoIndexerResult {
  totalIndexed: number;
  scanned: number;
  indexed: number;
  failed: number;
  canceled?: boolean;
}

export interface FolderIndexerEntry {
  filePath: string;
  docId: string;
  mtimeMs: number;
}

export type FolderIndexStatus =
  | "indexed"
  | "needs_scan"
  | "empty"
  | "missing"
  | "images_disabled";

export interface FolderIndexSummary {
  folder: string;
  status: FolderIndexStatus;
  totalFiles: number;
  indexedFiles: number;
  staleFiles: number;
  newFiles: number;
  missingFiles: number;
  pendingFiles: number;
  lastIndexedAt?: string;
  /**
   * `index_folders` 의 quick path 가 디스크 walk 없이 인덱스 state 만으로
   * 합계를 추정한 경우 true. UI 가 "정확치 미상" 으로 표시하거나 ≈ 표기를
   * 붙일 때 사용. 디스크 신규/stale 파일이 합계에 빠져 있을 수 있음을
   * 호출자에게 알리는 신호 — 정확한 값을 원하면 quick=false 로 재호출.
   */
  approximate?: boolean;
}

export interface PageContentItem {
  page: number;
  content: string;
}

export interface ChunkMeta {
  chunkId: string;
  docId: string;
  docName: string;
  page?: number;
  rawText: string;
  path?: string;
}

export interface SearchHit {
  source: "bm25" | "vec" | "hybrid";
  chunkId: string;
  docId: string;
  docName: string;
  page?: number;
  rawText: string;
  rank: number;
  score: number;
  path?: string;
}

export interface HybridResult {
  chunkId: string;
  docId: string;
  docName: string;
  page?: number;
  rawText: string;
  rrfScore: number;
  sources: Array<{ source: "bm25" | "vec" | "hybrid"; rank: number; score: number }>;
}

export interface DocumentRow {
  doc_id: string;
  path: string;
  doc_name: string;
  doc_type: string;
  page_count?: number;
  line_count?: number;
  mtime_ms?: number;
  indexed_at?: string;
  status?: string;
  /** Content quality independent of `status`: 'ok' | 'empty' | 'embed_failed'. */
  content_state?: string;
}
