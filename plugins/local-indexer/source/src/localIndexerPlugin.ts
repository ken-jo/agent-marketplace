import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { delimiter as pathDelimiter, dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type {
  IndexMode,
  PageContentItem,
  LocalIndexerDocumentMeta,
  LocalIndexerWorkerOptions,
  SpawnedPluginWorker,
} from "./types.js";
import {
  EgressBroker,
  egressBrokerTransportFor,
  egressBrokerWorkerArgs,
} from "./egressBroker.js";
import { WorkerClient } from "./workerClient.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;

const DEFAULT_OPENAI_MODEL = "text-embedding-3-small";
const OPENAI_MODEL_PREFIXES = ["text-embedding-"];

function isShutdownTokenLogLine(line: string): boolean {
  return /\b(?:shutdown_token|AVE_SHUTDOWN_TOKEN)\s*=/i.test(line);
}

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

export class AveLocalIndexerPlugin {
  private readonly options: LocalIndexerWorkerOptions & {
    host: string;
    port: number;
    startupTimeoutMs: number;
  };

  // 호스트-중재 워커 핸들. non-null이면 워커가 실행 중.
  private workerHandle: SpawnedPluginWorker | null = null;
  private startingPromise: Promise<void> | null = null;
  private readonly baseUrl: string;
  private readonly workerClient: WorkerClient;
  private stdoutRemainder = "";
  private stderrRemainder = "";
  // 호스트가 생성해 메모리에만 보관하는 per-process shutdown 토큰.
  // /shutdown 호출 시 헤더로 전달해 외부 종료 요청을 거부한다.
  private shutdownToken: string | null = null;

  // Host-mediated egress broker (P3 ⑬). Non-null while a worker is running and
  // `egressChannels` was supplied. The worker reaches the provider ONLY through
  // this broker, holding only `egressToken` (never the provider key).
  private egressBroker: EgressBroker | null = null;
  private egressToken: string | null = null;

  constructor(options: LocalIndexerWorkerOptions = {}) {
    this.options = {
      ...options,
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 43129,
      startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    };
    this.baseUrl = `http://${this.options.host}:${this.options.port}`;
    this.workerClient = new WorkerClient({ baseUrl: this.baseUrl });
  }

  /** boot.ts가 HybridRetriever DI 시 사용 */
  getWorkerClient(): WorkerClient {
    return this.workerClient;
  }

  /**
   * 호스트가 HTTP /shutdown을 직접 호출할 때 사용할 토큰.
   * worker 기동 시 env로 주입하기 전에는 null.
   */
  getShutdownToken(): string | null {
    return this.shutdownToken;
  }

  /**
   * The per-session egress broker token, or null when no broker is configured.
   * The host pushes THIS (not the provider key) to the worker via the renamed
   * `/indexer/set_egress_token` channel and the caption push, so the worker's
   * four credential holders only ever carry the token.
   */
  getEgressToken(): string | null {
    return this.egressToken;
  }

  /** True when the worker is running behind a host-mediated egress broker. */
  get isEgressBrokered(): boolean {
    return this.egressBroker !== null && this.egressToken !== null;
  }

  get isRunning(): boolean {
    return this.workerHandle !== null;
  }

  private forwardWorkerOutput(stream: "stdout" | "stderr", chunk: Buffer): void {
    const text = chunk.toString("utf8");
    const remainder = stream === "stdout" ? this.stdoutRemainder : this.stderrRemainder;
    const combined = remainder + text;
    const lines = combined.split(/\r?\n/);
    const trailing = lines.pop() ?? "";
    if (stream === "stdout") {
      this.stdoutRemainder = trailing;
    } else {
      this.stderrRemainder = trailing;
    }
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || isShutdownTokenLogLine(line)) continue;
      if (stream === "stdout") {
        this.options.onWorkerStdout?.(line);
      } else {
        this.options.onWorkerStderr?.(line);
      }
    }
  }

  /** Emit any buffered trailing (newline-less) stdout/stderr line on worker exit. */
  private flushWorkerRemainders(): void {
    for (const stream of ["stdout", "stderr"] as const) {
      const raw = stream === "stdout" ? this.stdoutRemainder : this.stderrRemainder;
      if (stream === "stdout") {
        this.stdoutRemainder = "";
      } else {
        this.stderrRemainder = "";
      }
      const line = raw.trim();
      if (!line || isShutdownTokenLogLine(line)) continue;
      if (stream === "stdout") {
        this.options.onWorkerStdout?.(line);
      } else {
        this.options.onWorkerStderr?.(line);
      }
    }
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
      // Always run cleanup: the broker may be listening even when spawnWorker /
      // health-wait failed before `workerHandle` was assigned. stop() is a no-op
      // for the worker part when nothing is running.
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
    if (handle) {
      // 호스트-중재 lifecycle: graceful /shutdown(토큰 인증)을 먼저 시도해
      // SQLite WAL checkpoint / lance flush가 돌게 한 뒤, handle.stop()으로
      // 호스트가 SIGTERM→SIGKILL grace + ASRT/UDS state를 정리하게 한다.
      const shutdownToken = this.shutdownToken;
      this.workerHandle = null;

      if (shutdownToken) {
        try {
          await Promise.race([
            this.workerClient.shutdown(shutdownToken),
            sleep(this.options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS).then(() => {
              throw new Error("shutdown request timeout");
            }),
          ]);
        } catch (err) {
          this.options.onWorkerStderr?.(
            `[ave-local-indexer] worker /shutdown failed: ${(err as Error).message}`,
          );
        }
      }

      try {
        handle.stop();
      } catch (err) {
        this.options.onWorkerStderr?.(
          `[ave-local-indexer] worker handle stop failed: ${(err as Error).message}`,
        );
      }

      this.workerClient.setWriteToken(null);
      this.workerClient.configureTransport(null, this.baseUrl);
      this.shutdownToken = null;
    }

    // Tear down the broker last so in-flight worker egress can drain during the
    // graceful worker shutdown above. Runs even when the worker handle was
    // already null (e.g. broker started but spawnWorker failed in start()).
    await this.stopEgressBroker();
  }

  private async stopEgressBroker(): Promise<void> {
    const broker = this.egressBroker;
    this.egressBroker = null;
    this.egressToken = null;
    if (!broker) return;
    try {
      await broker.stop();
    } catch (err) {
      this.options.onWorkerStderr?.(
        `[ave-local-indexer] egress broker stop failed: ${(err as Error).message}`,
      );
    }
  }

  // ─── HTTP API: workerClient delegation (single source of truth) ──
  //
  // 초기에는 AveLocalIndexerPlugin이 자체 fetch+parse 로직을 가지고 있었지만,
  // workerClient.ts가 후기에 추가되며 두 client가 공존하게 됐다. 두 client는 같은
  // worker route를 정의하고 있어 drift 가능성이 있고, 실제로 indexDocument는
  // `/index` (존재 안 함) vs workerClient의 `/indexer/reindex` 로 갈라져 있었다.
  //
  // Root fix (이번 세션): 5개 HTTP 메서드를 모두 workerClient에 위임하여 single
  // source of truth를 확립한다. AveLocalIndexerPlugin은 process lifecycle (spawn/
  // stop/health) + workerClient owner 역할만 담당.

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
    // workerClient의 메서드 이름은 `getStructure` (worker route `/structure` 그대로)
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

    // Storage root: explicit config/env override OR plugin-scoped dir
    // (context.pluginDataDir/index/). Either must be provided — the host
    // (hostPlugin.ts) asserts `context.pluginDataDir` upstream, and direct
    // construction paths (tests, embedded use) must pass `indexStorageRoot`
    // explicitly. No `~/.ave/local-indexer/` fallback — silently writing
    // there would leak plugin state out of the per-plugin namespace and
    // mask a host contract violation.
    const baseDataDir = this.options.indexStorageRoot
      ? resolve(this.options.indexStorageRoot)
      : this.options.pluginDataDir
        ? resolve(this.options.pluginDataDir, "index")
        : (() => {
            throw new Error(
              "[ave-local-indexer] indexStorageRoot or pluginDataDir is required; " +
              "the host injects pluginDataDir via PluginRuntimeContext.",
            );
          })();
    const workspace = this.options.workspace ?? resolve(baseDataDir, "workspace");
    const sqlite = resolve(baseDataDir, "fts5.sqlite");
    const lance = resolve(baseDataDir, "vectors.lance");
    if (typeof this.options.spawnWorker !== "function") {
      throw new Error(
        "[ave-local-indexer] requires a host with the spawnWorker capability Please update Ave.",
      );
    }
    await mkdir(baseDataDir, { recursive: true });
    await mkdir(workspace, { recursive: true });

    // ── Host-mediated egress broker (P3 ⑬) ────────────────────────────────
    // Start the broker BEFORE spawning the worker so the worker can reach the
    // provider the instant it boots. Broker-start failure fails start()
    // deterministically — the broker is a hard dependency of vector indexing,
    // never a soft fallback (a worker that still held the key + free network
    // would defeat the whole control). The worker then receives ONLY the
    // broker base URL (boot arg) + the broker token (control-channel push);
    // the real endpoint and real key stay host-side.
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
    // One decision, made from the platform: a Unix socket in the one directory
    // the host registered with the sandbox, or loopback TCP where `listen(path)`
    // is a named pipe. `egressBrokerTransportFor` carries the reasoning.
    const transport = egressBrokerTransportFor(process.platform, this.options.pluginSocketDir);
    if (transport === null) {
      throw new Error(
        "[ave-local-indexer] requires context.pluginSocketDir; the egress broker binds a "
          + "Unix socket there rather than loopback TCP, which a confined plugin child "
          + "cannot bind. Host too old — see requires.minAppVersion.",
      );
    }
    const token = randomBytes(32).toString("base64url");
    const broker = new EgressBroker({
      token,
      transport,
      channels: this.options.egressChannels,
      isUpstreamAllowed: this.options.isUpstreamAllowed ?? (() => true),
      upstreamCaPath: this.options.corpCaPath ?? null,
      upstreamFetch: this.options.egressUpstreamFetch,
      logEvent: (level, event, fields) => {
        this.options.onEgressEvent?.(level, event, fields);
        if (level === "error") this.options.onWorkerStderr?.(`[${event}] ${JSON.stringify(fields)}`);
      },
    });
    const info = await broker.start();
    this.egressBroker = broker;
    this.egressToken = token;

    // --host/--port 는 호스트가 --uds <socketPath> 를 주입하면 inert 다 (워커가
    // UDS 위로만 listen). socketPath=null 경로(gate-OFF plain spawn 또는
    // Windows ASRT-wrapped TCP control)는 TCP 로 동작하므로 그대로 둔다.
    const args: string[] = [
      workerScriptPath,
      "--host", this.options.host,
      "--port", String(this.options.port),
      "--workspace", workspace,
      "--sqlite", sqlite,
      "--lance", lance,
    ];

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
    // The worker addresses the broker, never the real provider. The real
    // `embeddingEndpoint` is held host-side by the broker's channel resolver and
    // hostFetch chokepoint — it is deliberately NOT passed to the worker.
    // Provider/model/api-version are non-secret and still flow so the worker
    // builds the right SDK request shape (OpenAI vs Azure path construction).
    // The address itself is derived from what the broker bound, not restated
    // here, so the two cannot disagree.
    args.push(...egressBrokerWorkerArgs(info));
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
    // Python subprocess. Only OS-essential variables are propagated. The
    // embedding API key is deliberately NOT injected here: it is pushed into
    // the running worker via /indexer/set_embedding_api_key so it never lands
    // in the subprocess environment (no /proc/<pid>/environ, child-inheritance,
    // or crash-dump exposure).
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
    // plugin's own `dist/worker/`, which is signed install payload, not the
    // plugin's writable data dir. The sandbox already jails writes to the data
    // dir, so in a confined run those writes just fail; disabling bytecode makes
    // it explicit and keeps the payload immutable (and its install receipt
    // valid) even in an unconfined dev/plain-spawn run.
    env.PYTHONDONTWRITEBYTECODE = "1";
    // The embedding API key is intentionally not placed on `env` — it is
    // pushed to the running worker over the control channel
    // (workerClient.setEmbeddingApiKey) instead. `this.options.apiKey` is kept
    // only as a presence signal for the BM25-only warning below.

    // shutdown 토큰은 env로만 주입한다. 호스트가 생성하여 프로세스 메모리에만
    // 보관하고, worker는 os.environ.pop으로 읽는 즉시 env 슬롯을 제거한다.
    // stdout 평문 노출 경로를 두지 않아 토큰이 로그/캡처로 새지 않는다.
    const shutdownToken = randomBytes(32).toString("base64url");
    env.AVE_SHUTDOWN_TOKEN = shutdownToken;
    this.shutdownToken = shutdownToken;
    this.workerClient.setWriteToken(shutdownToken);

    // §A3 / 422 root fix: allowed roots를 host(this.options.allowedRoots)에서
    // 명시적으로 받아 worker `_get_allowed_roots` 환경변수로 주입.
    // 미지정 시 worker default (~/Documents, ~/Desktop, ~/.ave)를 그대로 사용.
    // host(hostPlugin)는 single source of truth로서 scan folders + workspace +
    // ~/.ave 등 indexing 대상이 될 모든 경로를 명시한다.
    if (this.options.allowedRoots && this.options.allowedRoots.length > 0) {
      env.AVE_INDEX_ALLOWED_ROOTS = this.options.allowedRoots.join(pathDelimiter);
    }

    // §17 C1: corp-ca-loader가 ~/.ave/certs/corp-ca.pem을 생성했으면
    // Python httpx / requests / curl 에 주입하여 사내망 TLS 인터셉트를 정식 처리.
    // corp-ca.pem이 없으면 Python은 기본 CA로 시도 (해외망 정상 동작).
    // PYTHONHTTPSVERIFY=0 is intentionally never injected.
    env.HF_HUB_DISABLE_TELEMETRY = "1"; // 유지 (UX 용)
    const corpCaPath = this.options.corpCaPath ?? null;
    const workerReadGrantPaths = [pythonExecutable, workerScriptPath];
    if (corpCaPath) {
      env.SSL_CERT_FILE = corpCaPath;         // Python ssl / httpx
      env.REQUESTS_CA_BUNDLE = corpCaPath;    // requests
      env.CURL_CA_BUNDLE = corpCaPath;        // curl backend
      workerReadGrantPaths.push(corpCaPath);
    }

    // 호스트-중재 spawn: 호스트가 ASRT-confined로 워커를 띄우고 control-socket
    // dir을 할당한다. `udsArgName`으로 `--uds <socketPath>`를 args에 덧붙인다.
    // handle.socketPath:
    //   - non-null → UDS control. workerClient를 UDS로 재구성.
    //   - null     → TCP control(gate-OFF plain spawn 또는 Windows ASRT-wrapped).
    const handle = await this.options.spawnWorker({
      workerId: "local-indexer-worker",
      command: pythonExecutable,
      args,
      env,
      allowReadPaths: workerReadGrantPaths,
      allowWritePaths: [baseDataDir, workspace],
      udsArgName: "--uds",
    });

    // workerClient transport를 UDS(있으면) 또는 기존 TCP baseUrl로 구성한다.
    this.workerClient.configureTransport(handle.socketPath, this.baseUrl);

    this.stdoutRemainder = "";
    this.stderrRemainder = "";
    handle.onStdout((chunk) => {
      this.forwardWorkerOutput("stdout", Buffer.from(chunk, "utf8"));
    });
    handle.onStderr((chunk) => {
      this.forwardWorkerOutput("stderr", Buffer.from(chunk, "utf8"));
    });

    // 워커가 예기치 않게 죽으면(crash) 호스트 핸들의 onExit 가 알린다. workerHandle 을
    // null 로 돌려 isRunning→false 가 되게 해야 host 의 ensureStarted() auto-restart 가
    // 재진입한다 (onExit 가 없으면 죽은 워커가 영구 isRunning=true 로 남아 재시작 불가).
    // 호스트가 워커 lifecycle 을 소유하므로 plugin-side stale-worker/세션 복구 기계는
    // 제거됐다 — 재시작 간 stale TCP-port 탐지가 불필요.
    handle.onExit(() => {
      if (this.workerHandle !== handle) return; // 이미 stop()/교체됨 — 무시
      this.flushWorkerRemainders(); // 종료 직전 미완(개행 없는) 라인 flush
      this.workerHandle = null;
      this.workerClient.configureTransport(null, this.baseUrl);
      this.workerClient.setWriteToken(null);
      this.shutdownToken = null;
      // Worker crashed/exited — tear down its 1:1 broker so the next (re)start
      // mints a fresh token + listener. A stale broker holding the host key must
      // not outlive the worker it was pinned to.
      void this.stopEgressBroker();
    });
    this.workerHandle = handle;
    await this.waitUntilHealthy();
  }

  private async waitUntilHealthy(): Promise<void> {
    const deadline = Date.now() + this.options.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (!this.workerHandle) {
        throw new Error("Local Indexer worker exited before becoming healthy.");
      }
      try {
        // workerClient.health()는 구성된 transport(UDS or TCP)를 그대로 사용한다.
        if (await this.workerClient.health()) {
          return;
        }
      } catch {
        // ignore and retry
      }
      if (!this.workerHandle) {
        throw new Error("Local Indexer worker exited before becoming healthy.");
      }
      await sleep(500);
    }
    throw new Error(`Local Indexer worker failed health check within ${this.options.startupTimeoutMs}ms`);
  }

}
