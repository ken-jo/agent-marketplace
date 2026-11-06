import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { delimiter as pathDelimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  IndexMode,
  PageContentItem,
  LocalIndexerDocumentMeta,
  LocalIndexerWorkerOptions,
  StdioControlPluginWorker,
  PluginWorkerExitInfo,
} from "./types.js";
import { EgressBroker } from "./egressBroker.js";
import { WorkerClient, type WorkerRuntimeInfo } from "./workerClient.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;

/** The worker's id: names its host-made state directory, `<plugin root>/workers/<id>/`. */
export const LOCAL_INDEXER_WORKER_ID = "local-indexer-worker";

/** Where versions before 0.8.0 kept the index, inside the plugin's own data directory. */
export const LEGACY_INDEX_DIR_NAME = "index";

const DEFAULT_OPENAI_MODEL = "text-embedding-3-small";
const OPENAI_MODEL_PREFIXES = ["text-embedding-"];

/**
 * embedding_model 값으로 provider를 결정한다.
 * 지원 provider 집합은 정확히 {"openai", "azure"} — worker argparse choices,
 * create_embedding_client, manifest configSchema enum 과 동일하게 유지한다.
 * 우선순위:
 *   1. explicitProvider ("openai" | "azure") — 사용자가 명시했으면 그대로.
 *   2. model 이름 패턴 (text-embedding-* 류) → "openai" 자동 감지.
 *   3. hostVendor inherit — 호스트 LLM vendor 가 azure 계열이면 "azure".
 *      Azure-only 사용자가 plugin default "openai" 때문에 OpenAI public 호출
 *      → 회사망 cert 차단되는 버그를 막기 위함.
 *   4. default = "openai". API 키가 없으면 worker 가 BM25-only 폴백.
 *
 * hostVendor 는 hostApi.config.get("hostApiVendor") 의 값 (예: "openai",
 * "azure-foundry", "azure-openai", "claude") 을 그대로 전달한다.
 */
export function resolveEmbeddingProvider(
  model?: string,
  explicitProvider?: string,
  hostVendor?: string,
): "openai" | "azure" {
  if (explicitProvider === "openai" || explicitProvider === "azure") {
    return explicitProvider;
  }
  if (model) {
    const lc = model.toLowerCase();
    if (OPENAI_MODEL_PREFIXES.some((prefix) => lc.startsWith(prefix))) return "openai";
  }
  // Host vendor inherit: azure-foundry / azure-openai 등 azure 계열 호스트면
  // Azure embedding deployment 로 자동 매핑. 사용자가 plugin 측에서 explicit
  // 하게 다른 provider 를 지정하지 않은 한 host 와 동일 vendor 를 따라간다.
  if (hostVendor && /azure/i.test(hostVendor)) return "azure";
  // Default to openai mode. Without an API key, worker falls back to BM25-only.
  return "openai";
}

/** Where the running worker keeps its index, and what an upgrade left behind. */
export interface IndexLocation {
  /** The index root the worker resolved (its state directory, or the user-chosen root). */
  indexRoot: string;
  /** Documents in that index when the worker started. */
  documentCount: number;
  /** True when the index lives in the host-made worker state directory. */
  inStateDirectory: boolean;
  /**
   * `<pluginDataDir>/index` when it still exists and the index has moved
   * away from it: the pre-0.8.0 location, rebuilt rather than copied.
   */
  legacyIndexDir: string | null;
}

export class LocalIndexerPlugin {
  private readonly options: LocalIndexerWorkerOptions & {
    startupTimeoutMs: number;
  };

  // The running worker incarnation. Non-null while it runs.
  private workerHandle: StdioControlPluginWorker | null = null;
  private startingPromise: Promise<void> | null = null;
  private readonly workerClient: WorkerClient;
  private stderrRemainder = "";
  private indexLocation: IndexLocation | null = null;
  private lastExit: PluginWorkerExitInfo | null = null;

  constructor(options: LocalIndexerWorkerOptions = {}) {
    this.options = {
      ...options,
      startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    };
    this.workerClient = new WorkerClient();
  }

  /** boot.ts가 HybridRetriever DI 시 사용 */
  getWorkerClient(): WorkerClient {
    return this.workerClient;
  }

  get isRunning(): boolean {
    return this.workerHandle !== null;
  }

  /** Where the running worker keeps its index; null until a start succeeded. */
  getIndexLocation(): IndexLocation | null {
    return this.indexLocation;
  }

  /** How the last worker incarnation ended, if one has. */
  getLastWorkerExit(): PluginWorkerExitInfo | null {
    return this.lastExit;
  }

  private forwardWorkerStderr(chunk: string): void {
    const combined = this.stderrRemainder + chunk;
    const lines = combined.split(/\r?\n/);
    this.stderrRemainder = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line) this.options.onWorkerStderr?.(line);
    }
  }

  /** Emit a buffered trailing (newline-less) stderr line on worker exit. */
  private flushWorkerStderr(): void {
    const line = this.stderrRemainder.trim();
    this.stderrRemainder = "";
    if (line) this.options.onWorkerStderr?.(line);
  }

  async start(): Promise<void> {
    if (this.workerHandle) return;
    if (this.startingPromise) {
      await this.startingPromise;
      return;
    }
    this.startingPromise = this.startInternal();
    try {
      await this.startingPromise;
    } catch (err) {
      // A worker that spawned but never became ready is stopped here.
      try {
        await this.stop();
      } catch (stopErr) {
        this.options.onWorkerStderr?.(
          `[ave-local-indexer] start failure cleanup failed: ${(stopErr as Error).message}`,
        );
      }
      throw err;
    } finally {
      this.startingPromise = null;
    }
  }

  async stop(): Promise<void> {
    const handle = this.workerHandle;
    if (!handle) return;
    // Orderly stop: ask the worker to close its stores (SQLite WAL checkpoint,
    // lance flush) while it is still attached, then let the host stop it
    // ($/ai.agent-connector.ave/shutdown, stdin EOF, then SIGTERM→SIGKILL grace).
    this.workerHandle = null;
    try {
      await this.workerClient.shutdown({
        signal: AbortSignal.timeout(this.options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS),
      });
    } catch (err) {
      this.options.onWorkerStderr?.(
        `[ave-local-indexer] worker_shutdown failed: ${(err as Error).message}`,
      );
    }
    this.workerClient.attach(null);
    try {
      handle.stop();
    } catch (err) {
      this.options.onWorkerStderr?.(
        `[ave-local-indexer] worker handle stop failed: ${(err as Error).message}`,
      );
    }
  }

  // ─── Worker calls: workerClient delegation (single source of truth) ──
  //
  // Every worker method lives on workerClient. LocalIndexerPlugin owns only the
  // process lifecycle (spawn / stop / readiness) and the workerClient.

  async indexDocument(filePath: string, mode: IndexMode = "auto"): Promise<string> {
    return this.workerClient.indexDocument(filePath, mode);
  }

  async listDocuments(): Promise<LocalIndexerDocumentMeta[]> {
    const rows = await this.workerClient.listDocuments();
    return rows.map((row) => ({
      id: row.docId,
      doc_id: row.docId,
      type: row.type,
      doc_type: row.type,
      path: row.path,
      doc_name: row.docName,
      page_count: row.pageCount,
      line_count: row.lineCount,
      mtime_ms: row.mtimeMs,
      indexed_at: row.indexedAt,
      status: row.status,
      content_state: row.contentState,
    }));
  }

  /**
   * Update boot-time embedding settings before the next worker start.
   * Running workers keep the config they were spawned with.
   */
  setEmbeddingBootConfig(next: {
    apiKey?: string;
    embeddingModel?: string;
    embeddingProvider?: "openai" | "azure";
    embeddingEndpoint?: string;
    embeddingApiVersion?: string;
    hostVendor?: string;
  }): void {
    if (typeof next.apiKey === "string") this.options.apiKey = next.apiKey;
    if (typeof next.embeddingModel === "string") this.options.embeddingModel = next.embeddingModel;
    if (next.embeddingProvider === "openai" || next.embeddingProvider === "azure") {
      this.options.embeddingProvider = next.embeddingProvider;
    }
    if (typeof next.embeddingEndpoint === "string") {
      this.options.embeddingEndpoint = next.embeddingEndpoint;
    }
    if (typeof next.embeddingApiVersion === "string") {
      this.options.embeddingApiVersion = next.embeddingApiVersion;
    }
    if (typeof next.hostVendor === "string") this.options.hostVendor = next.hostVendor;
  }

  async removeDocument(docId: string): Promise<void> {
    await this.workerClient.removeDocument(docId);
  }

  async getDocument(docId: string): Promise<Record<string, unknown>> {
    return (await this.workerClient.getDocument(docId)) as unknown as Record<string, unknown>;
  }

  async getDocumentStructure(docId: string): Promise<unknown> {
    // workerClient의 메서드 이름은 `getStructure` (worker method `document_structure`)
    return this.workerClient.getStructure(docId);
  }

  async getPageContent(docId: string, pages: string): Promise<PageContentItem[]> {
    return (await this.workerClient.getPageContent(docId, pages)) as unknown as PageContentItem[];
  }

  private async startInternal(): Promise<void> {
    // Worker is bundled into `dist/worker/` by `scripts/copy-worker.mjs` (build
    // step). The marketplace publish artifact only ships `dist/` + `plugin.json`,
    // so the sibling `worker/` directory used during local dev does not exist
    // post-install. Resolving from `__dirname` (= `dist/`) keeps the layout
    // self-contained for both dev and marketplace install paths.
    const workerScriptPath =
      this.options.workerScriptPath ?? resolve(__dirname, "worker/local_indexer_worker.py");

    // python3 폴백 제거 — Agent 1의 pythonPath가 반드시 주입되어야 함
    if (!this.options.pythonExecutable) {
      throw new Error(
        "localIndexerPlugin: pythonExecutable이 설정되지 않았습니다. " +
        "boot.ts의 PythonRuntimeBootstrapper.ensureReady()가 먼저 실행되어야 합니다.",
      );
    }
    const pythonExecutable = this.options.pythonExecutable;

    // Storage: the index lives in the worker's private state directory, which
    // the host creates beside this plugin's data directory and names in the
    // worker's AVE_WORKER_STATE_DIR (spec `stateDirectory: true`). Only the
    // worker can write there. A user-chosen `indexStorageRoot` replaces it and
    // keeps its own write grant (manifest sandbox.write userChosenDirectory).
    // The scratch workspace stays in the plugin's data directory.
    if (!this.options.pluginDataDir && !this.options.indexStorageRoot) {
      throw new Error(
        "[ave-local-indexer] indexStorageRoot or pluginDataDir is required; " +
        "the host injects pluginDataDir via PluginRuntimeContext.",
      );
    }
    const userIndexRoot = this.options.indexStorageRoot ? resolve(this.options.indexStorageRoot) : null;
    const workspace = this.options.workspace
      ?? (userIndexRoot
        ? resolve(userIndexRoot, "workspace")
        : resolve(this.options.pluginDataDir!, ".local-indexer-workspace"));
    if (typeof this.options.spawnWorker !== "function") {
      throw new Error(
        "[ave-local-indexer] requires a host with the spawnWorker capability. Please update Ave.",
      );
    }
    if (userIndexRoot) await mkdir(userIndexRoot, { recursive: true });
    await mkdir(workspace, { recursive: true });

    // ── Plugin-mediated egress ────────────────────────────────────────────
    // The worker asks THIS plugin for every provider call (egress_embedding /
    // egress_caption over its control channel) and holds no key. The broker
    // resolves the real upstream and credential host-side, per request.
    // Missing channels fail start(): direct worker provider egress is not
    // supported, and a worker that held the key would defeat the control.
    if (!this.options.egressChannels) {
      throw new Error(
        "[ave-local-indexer] requires host-mediated egressChannels; direct worker provider egress is not supported.",
      );
    }
    if (!this.options.egressUpstreamFetch) {
      throw new Error(
        "[ave-local-indexer] requires host-mediated egressUpstreamFetch; direct broker upstream egress is not supported.",
      );
    }
    const broker = new EgressBroker({
      channels: this.options.egressChannels,
      isUpstreamAllowed: this.options.isUpstreamAllowed ?? (() => true),
      upstreamFetch: this.options.egressUpstreamFetch,
      audit: (level, event, fields) => {
        this.options.onEgressEvent?.(level, event, fields);
        if (level === "error") this.options.onWorkerStderr?.(`[${event}] ${JSON.stringify(fields)}`);
      },
    });

    const args: string[] = [workerScriptPath, "--workspace", workspace];
    if (userIndexRoot) args.push("--index-root", userIndexRoot);

    if (this.options.model) {
      args.push("--model", this.options.model);
    } else {
      args.push("--model", "gpt-4o-mini");
    }

    // embedding provider/model: plugin 설정에서 주입, 없으면 local 기본값.
    // model이 'text-embedding-*'이면 resolveEmbeddingProvider가 openai를 자동 선택.
    // hostVendor 가 azure 계열이면 명시 미지정 시 "azure" 로 inherit (#955).
    const embProvider = resolveEmbeddingProvider(
      this.options.embeddingModel,
      this.options.embeddingProvider,
      this.options.hostVendor,
    );
    const embModel = this.options.embeddingModel ?? DEFAULT_OPENAI_MODEL;
    if (embProvider === "openai" && !this.options.apiKey) {
      this.options.onWorkerStderr?.(
        "[ave-local-indexer] WARNING: embeddingModel이 OpenAI 모델로 설정되었지만 apiKey가 없습니다. " +
          "벡터 임베딩이 비활성화되어 BM25 검색만 동작합니다. " +
          "플러그인 설정 → '[임베딩] API 키' 에 입력하세요.",
      );
    }
    if (embProvider === "azure" && (!this.options.embeddingEndpoint || !this.options.apiKey)) {
      // Issue #955 round-1 critic (MAJOR 2): host vendor inherit으로 azure가
      // 자동 선택되었지만 endpoint/key가 비어 있으면 사용자가 영문도 모르고
      // BM25-only fallback에 빠진다. Message를 명시적으로 — provider 선택
      // 출처(host inherit vs explicit)와 어떤 필드가 비어 있는지 + 어디서
      // 입력해야 하는지를 surface 한다.
      const missing: string[] = [];
      if (!this.options.embeddingEndpoint) missing.push("embeddingEndpoint");
      if (!this.options.apiKey) missing.push("apiKey");
      const inheritedFrom = this.options.embeddingProvider
        ? `explicit embeddingProvider=azure`
        : `host vendor inherit (hostVendor=${this.options.hostVendor ?? "?"})`;
      this.options.onWorkerStderr?.(
        `[ave-local-indexer] CONFIG REQUIRED: embeddingModel=${embModel}이 azure provider로 ` +
          `${inheritedFrom} 결정되었지만 ${missing.join(", ")} 미설정. ` +
          `벡터 임베딩이 비활성화되어 BM25-only fallback으로 동작합니다. ` +
          `플러그인 사이드카 UI(설정 → [임베딩])에서 endpoint URL과 API 키를 입력하세요.`,
      );
      // #955 round-2 architect Minor: stderr only is invisible to the UI.
      // Surface the same condition as a structured callback so the host can
      // emit a UI-visible host event (e.g. `local_indexer.config_warning`).
      this.options.onConfigWarning?.({
        reason: "azure-inherit-missing-config",
        missing,
        inheritedFrom,
      });
    }
    args.push("--embedding-provider", embProvider);
    args.push("--embedding-model", embModel);
    // The real `embeddingEndpoint` stays here, with the broker's channel
    // resolver; it is deliberately NOT passed to the worker. Provider, model
    // and api-version are non-secret and still flow so the worker builds the
    // right SDK request shape (OpenAI vs Azure path construction).
    if (this.options.embeddingApiVersion) {
      args.push("--embedding-api-version", this.options.embeddingApiVersion);
    }
    args.push("--batch-rpm", "400");

    if (typeof this.options.maxFileSize === "number" && this.options.maxFileSize >= 0) {
      args.push("--max-file-size", String(Math.floor(this.options.maxFileSize)));
    }
    if (typeof this.options.maxChunksPerDoc === "number" && this.options.maxChunksPerDoc >= 1) {
      args.push("--max-chunks-per-doc", String(Math.floor(this.options.maxChunksPerDoc)));
    }

    // Whitelist-only env — avoid leaking arbitrary host env vars into the
    // Python subprocess. Only OS-essential variables are propagated. No
    // credential is ever placed here: the worker holds none.
    const allowedEnvKeys = new Set<string>([
      "PATH",
      "HOME",
      "USERPROFILE",
      "LANG",
      "LC_ALL",
      "TMPDIR",
      "TEMP",
      "TMP",
      "SYSTEMROOT",
      "NODE_ENV",
    ]);
    const env: NodeJS.ProcessEnv = {};
    for (const key of allowedEnvKeys) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    // Never let the worker cache bytecode next to its scripts. Python writes
    // `__pycache__/*.pyc` beside imported `.py` files by default — i.e. into the
    // plugin's own `dist/worker/`, which is signed install payload, not a
    // writable directory. The sandbox already jails writes, so in a confined
    // run those writes just fail; disabling bytecode makes it explicit and
    // keeps the payload immutable (and its install receipt valid) even in an
    // unconfined dev run.
    env.PYTHONDONTWRITEBYTECODE = "1";

    // §A3 / 422 root fix: allowed roots를 host(this.options.allowedRoots)에서
    // 명시적으로 받아 worker `_get_allowed_roots` 환경변수로 주입.
    // 미지정 시 worker default (~/Documents, ~/Desktop, ~/.ave)를 그대로 사용.
    // host(hostPlugin)는 single source of truth로서 scan folders + workspace +
    // ~/.ave 등 indexing 대상이 될 모든 경로를 명시한다.
    if (this.options.allowedRoots && this.options.allowedRoots.length > 0) {
      env.AVE_INDEX_ALLOWED_ROOTS = this.options.allowedRoots.join(pathDelimiter);
    }

    // §17 C1: corp-ca-loader가 ~/.ave/certs/corp-ca.pem을 생성했으면
    // Python ssl / requests / curl 에 주입하여 사내망 TLS 인터셉트를 정식 처리
    // (the worker still downloads models directly). PYTHONHTTPSVERIFY=0 is
    // intentionally never injected.
    env.HF_HUB_DISABLE_TELEMETRY = "1"; // 유지 (UX 용)
    const corpCaPath = this.options.corpCaPath ?? null;
    // Imports need the shipped worker modules and the host-managed Python
    // environment, not just its entry files. Keep grants within this lock's
    // runtime rather than widening to the runtime root or another plugin.
    const workerReadGrantPaths = [pythonExecutable, workerScriptPath, dirname(workerScriptPath)];
    const venvRoot = dirname(dirname(pythonExecutable));
    if (dirname(venvRoot) !== venvRoot && /[\\/]venv$/.test(venvRoot)) {
      workerReadGrantPaths.push(venvRoot, resolve(venvRoot, "../python"));
    }
    if (corpCaPath) {
      env.SSL_CERT_FILE = corpCaPath;         // Python ssl
      env.REQUESTS_CA_BUNDLE = corpCaPath;    // requests
      env.CURL_CA_BUNDLE = corpCaPath;        // curl backend
      workerReadGrantPaths.push(corpCaPath);
    }

    // Host-mediated spawn over worker stdio control v1: the host resolves
    // this only after the worker answered `$/ai.agent-connector.ave/hello`. No socket, no port.
    const spawned = await this.options.spawnWorker({
      workerId: LOCAL_INDEXER_WORKER_ID,
      command: pythonExecutable,
      args,
      env,
      allowReadPaths: workerReadGrantPaths,
      allowWritePaths: userIndexRoot ? [userIndexRoot, workspace] : [workspace],
      control: "stdio-control-v1",
      stateDirectory: true,
    });
    if (spawned.control !== "stdio-control-v1") {
      // A host that answered a stdio-control spec with any other handle broke
      // the contract; never read from it.
      spawned.stop();
      throw new Error(
        `[ave-local-indexer] spawnWorker returned a "${String(spawned.control)}" worker for a stdio-control-v1 spec.`,
      );
    }
    const handle = spawned;

    handle.onRequest((method, params, signal) => {
      if (EgressBroker.handles(method)) return broker.handleWorkerRequest(method, params, signal);
      throw new Error(`local-indexer plugin answers no worker request named ${method}`);
    });
    this.stderrRemainder = "";
    handle.onStderr((chunk) => this.forwardWorkerStderr(chunk));

    // The handle reports the end of an incarnation once. Detaching here is
    // what lets `isRunning` go false so the host's ensureStarted() starts a new
    // incarnation; calls still pending on the old one reject with
    // `worker-incarnation-ended` and nothing is replayed.
    handle.onExit((info) => {
      this.lastExit = info;
      if (this.workerHandle !== handle) return; // already stopped or replaced
      this.flushWorkerStderr();
      this.workerHandle = null;
      this.workerClient.attach(null);
      this.options.onWorkerStderr?.(
        `[ave-local-indexer] worker exited (${info.reason}, code ${info.code ?? "none"}${info.signal ? `, ${info.signal}` : ""})`,
      );
    });
    this.workerHandle = handle;
    this.workerClient.attach(handle);
    await this.waitUntilReady(userIndexRoot);
  }

  /** Wait for the worker's stores to open, and learn where the index lives. */
  private async waitUntilReady(userIndexRoot: string | null): Promise<void> {
    let info: WorkerRuntimeInfo;
    try {
      info = await this.workerClient.runtimeInfo({ signal: AbortSignal.timeout(this.options.startupTimeoutMs) });
    } catch (err) {
      if (!this.workerHandle) {
        throw new Error(`Local Indexer worker exited before becoming ready: ${(err as Error).message}`);
      }
      throw new Error(
        `Local Indexer worker failed to become ready within ${this.options.startupTimeoutMs}ms: ${(err as Error).message}`,
      );
    }
    const legacyCandidate = !userIndexRoot && this.options.pluginDataDir
      ? resolve(this.options.pluginDataDir, LEGACY_INDEX_DIR_NAME)
      : null;
    const legacyIndexDir = legacyCandidate
      && resolve(info.index_root) !== legacyCandidate
      && existsSync(resolve(legacyCandidate, "fts5.sqlite"))
      ? legacyCandidate
      : null;
    this.indexLocation = {
      indexRoot: info.index_root,
      documentCount: info.document_count,
      inStateDirectory: !userIndexRoot && Boolean(info.state_dir),
      legacyIndexDir,
    };
  }
}
