/**
 * WorkerClient — typed calls to the Python worker over worker stdio control v1.
 *
 * Each worker method is one `handle.request(method, params)` on the
 * `StdioControlPluginWorker` the host hands back from `spawnWorker`; there is
 * no URL, port, socket or token. Method names follow the control channel's
 * rule (`^[a-zA-Z_][a-zA-Z0-9_]{0,127}$`).
 *
 * Responses are converted from the worker's snake_case shape:
 *   { chunk_id, doc_id, doc_name, page, raw_text, score } →
 *   { chunkId, docId, docName, page, rawText, rank, score }
 *
 * Errors: a worker refusal (JSON-RPC error) throws `Error(message)` carrying
 * the worker's message, its JSON-RPC `code` as `workerCode`, and the control
 * error `code` (`worker-request-failed`, `worker-incarnation-ended`, ...).
 */

import type { StdioControlPluginWorker } from "@ave/plugin-contract";
import type { SearchHit, DocumentRow } from "./types.js";
import type { WorkerSearchClient, KnowledgeWorkerClient } from "./host-contracts.js";

/** The worker methods this client calls (worker stdio control v1 request names). */
export const WORKER_METHODS = {
  health: "worker_health",
  runtimeInfo: "runtime_info",
  allowedRoots: "runtime_allowed_roots",
  reindex: "indexer_reindex",
  reconcile: "indexer_reconcile",
  listDocuments: "documents_list",
  getDocument: "document_get",
  removeDocument: "documents_delete",
  structure: "document_structure",
  pageContent: "page_content",
  legacyIndexManifest: "legacy_index_manifest",
  searchBm25: "search_bm25",
  searchVector: "search_vector",
  searchHybrid: "search_hybrid",
  setImageCaptioning: "indexer_set_image_captioning",
  setEmbeddingEgress: "indexer_set_embedding_egress",
  captionImage: "indexer_caption_image",
  metrics: "metrics",
  shutdown: "worker_shutdown",
} as const;

/** A failed worker call. `code` is the control error code; `workerCode` the worker's JSON-RPC code. */
export class WorkerCallError extends Error {
  readonly code: string;
  readonly workerCode?: number;
  constructor(message: string, code: string, workerCode?: number) {
    super(message);
    this.name = "WorkerCallError";
    this.code = code;
    if (workerCode !== undefined) this.workerCode = workerCode;
  }
}

/**
 * The worker indexed the file and reported `status: "failed"` for it.
 * `retryable` is the worker's own call: false for a verdict on the file (too
 * large, encrypted, unparseable, missing config), which fails the same way
 * every time; true when the same file may index later (the caption provider
 * or relay was rate limited, down, timed out, refused egress, or the file
 * was outside the roots the worker held at that moment).
 */
export class WorkerIndexFailure extends Error {
  readonly filePath: string;
  readonly retryable: boolean;
  constructor(message: string, filePath: string, retryable = false) {
    super(message);
    this.name = "WorkerIndexFailure";
    this.filePath = filePath;
    this.retryable = retryable;
  }
}

/**
 * Worker refusals that are a verdict on the request itself: invalid params
 * (a bad mode, a malformed path) and a file that is not there. A path outside
 * the allowed roots has its own code (-32011, PATH_NOT_ALLOWED) because the
 * roots are runtime state a later sync can change, so it is not here; nor is
 * -32000, an unexpected worker failure.
 */
const PERMANENT_WORKER_CODES = new Set([-32602, -32004]);

/** The worker's code for a path outside the allowed roots it holds right now. */
export const WORKER_PATH_NOT_ALLOWED = -32011;

/**
 * Whether an indexing failure may go away on a retry. The worker's own
 * verdicts — a `failed` result, or a refusal in PERMANENT_WORKER_CODES — do
 * not. A lost worker, a cancelled or backed-up request, an unexpected worker
 * error and any error this client does not recognise may.
 */
export function isTransientIndexFailure(err: unknown): boolean {
  if (err instanceof WorkerIndexFailure) return err.retryable;
  if (err instanceof WorkerCallError) {
    if (err.code === "worker-request-failed") {
      return err.workerCode === undefined || !PERMANENT_WORKER_CODES.has(err.workerCode);
    }
    // payload-too-large is the same request failing the same way; every other
    // control code (worker-incarnation-ended, worker-request-cancelled,
    // worker-backpressure, worker-not-running, …) says nothing about the file.
    return err.code !== "payload-too-large";
  }
  return true;
}

/** Duck-typed: the control error may be the host's own class instance. */
function asWorkerCallError(method: string, err: unknown): Error {
  if (typeof err === "object" && err !== null && "code" in err && typeof (err as { code: unknown }).code === "string") {
    const code = (err as { code: string }).code;
    const remote = (err as { remote?: { code?: unknown; message?: unknown } }).remote;
    if (code === "worker-request-failed" && remote && typeof remote.message === "string") {
      return new WorkerCallError(remote.message, code, typeof remote.code === "number" ? remote.code : undefined);
    }
    const message = err instanceof Error ? err.message : String(err);
    return new WorkerCallError(`${method}: ${code}${message ? ` (${message})` : ""}`, code);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** The runtime_info answer: where the worker's index lives and what is in it. */
export interface WorkerRuntimeInfo {
  index_root: string;
  state_dir: string;
  sqlite_path: string;
  lance_path: string;
  workspace: string;
  document_count: number;
  [key: string]: unknown;
}

/** What the worker's search_* methods return per hit. */
interface RawSearchHit {
  chunk_id: string;
  doc_id: string;
  doc_name: string;
  page?: number;
  raw_text: string;
  score: number;
  source?: string;
  path?: string;
}

/** One documents_list row (snake_case). */
interface RawDocumentRow {
  doc_id: string;
  path: string;
  doc_name: string;
  doc_type: string;
  page_count?: number;
  line_count?: number;
  mtime_ms?: number;
  indexed_at?: string;
  status?: string;
  content_state?: string;
}

/** One documents_list page; `next_after` is null on the last page. */
interface DocumentsPage {
  documents: RawDocumentRow[];
  next_after: string | null;
}

/** One document a pre-0.8.0 index held as indexed (legacy_index_manifest row). */
export interface LegacyIndexDocument {
  docId: string;
  /** The absolute path the old worker stored (os.path.abspath). */
  path: string;
  /** int(os.path.getmtime(path) * 1000) when the old index read it. */
  mtimeMs: number;
  contentState: string | null;
  contentHash: string | null;
  /** Whether any of its chunks had an embeddings_meta row. */
  hadVectors: boolean;
}

interface RawLegacyIndexRow {
  doc_id: string;
  path: string;
  mtime_ms: number;
  content_state: string | null;
  content_hash: string | null;
  had_vectors: boolean;
}

/** Rows per documents_list page; the worker caps it at the same number. */
export const DOCUMENTS_PAGE_SIZE = 1000;

function indexedAtKey(row: RawDocumentRow): number {
  const value = row.indexed_at as unknown;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

interface DocumentListing {
  docId: string;
  docName: string;
  type: string;
  path: string;
  pageCount?: number;
  lineCount?: number;
  mtimeMs?: number;
  indexedAt?: string;
  updatedAt?: string;
  status?: string;
  contentState?: string;
}

/**
 * The indexer_reindex result
 * (worker `_result_dict(IndexResult)` 와 1:1 대응)
 */
export interface IndexResultDict {
  doc_id: string;
  doc_name: string;
  doc_type: string;
  chunk_count: number;
  status: string;
  page_count?: number | null;
  line_count?: number | null;
  errors?: string[] | null;
  /** For a failed result: the same file may index on a later try. */
  retryable?: boolean;
  /**
   * 임베딩 (벡터) 까지 성공적으로 생성됐는지. `true` 는 검색 인덱스에
   * 사용 가능한 doc, `false` 는 BM25/청크는 만들어졌지만 벡터가 없는
   * 부분 인덱싱 상태 (caption rejected, embedding client unavailable,
   * 네트워크 실패 등의 결과). 옛 워커 호환을 위해 `undefined` 가능.
   */
  embedded?: boolean | null;
  /**
   * `true` 면 content-hash 가 저장값과 일치해 임베딩/persist 를 건너뛴
   * short-circuit (기존 청크/벡터 재사용, mtime 만 갱신). 옛 워커 호환을
   * 위해 `undefined` 가능.
   */
  unchanged?: boolean | null;
}

/**
 * The indexer_reconcile result (1:1 with worker `LocalIndexer.reconcile()`).
 *
 * Boot reconcile pass 가 감지한 SQLite↔LanceDB 벡터 drift 요약.
 * `drifted_docs` 는 embeddings_meta 행은 있으나 Lance 벡터가 없는 doc
 * (P1-7a crash window 잔여) — 호스트가 warmup 키 push 이후 bounded reindex 로
 * 치유한다. `orphan_vectors_deleted` 는 meta 없는 Lance 벡터를 삭제한 수.
 * `checked=false` 는 vector store 부재로 비교 자체를 건너뛴 경우.
 */
export interface ReconcileReport {
  checked: boolean;
  drifted_docs: Array<{ doc_id: string; path: string }>;
  drifted_doc_count: number;
  orphan_vectors_deleted: number;
}

// ─── WorkerClient ────────────────────────────────────

export interface WorkerCallOptions {
  signal?: AbortSignal;
}

/**
 * The plugin's client for the Python Local Indexer worker. Implements the
 * host's `WorkerSearchClient` and `KnowledgeWorkerClient` shapes.
 *
 * The client calls whichever worker incarnation is attached. The worker's
 * owner (`LocalIndexerPlugin`) attaches each new handle and detaches it when
 * that incarnation ends; a call with nothing attached fails at once.
 */
export class WorkerClient implements WorkerSearchClient, KnowledgeWorkerClient {
  private handle: StdioControlPluginWorker | null = null;

  /** Attach the running worker incarnation, or `null` when none is running. */
  attach(handle: StdioControlPluginWorker | null): void {
    this.handle = handle;
  }

  get attached(): boolean {
    return this.handle !== null;
  }

  /** One worker method call. Resolves with its result or throws `WorkerCallError`. */
  async call<T>(method: string, params?: unknown, options: WorkerCallOptions = {}): Promise<T> {
    const handle = this.handle;
    if (!handle) {
      throw new WorkerCallError(`${method}: the Local Indexer worker is not running`, "worker-not-running");
    }
    try {
      return (await handle.request(method, params, options.signal ? { signal: options.signal } : undefined)) as T;
    } catch (err) {
      throw asWorkerCallError(method, err);
    }
  }

  // ─── WorkerSearchClient 구현 ──────────────────────

  async searchBm25(query: string, topK: number): Promise<SearchHit[]> {
    const raw = await this.call<RawSearchHit[]>(WORKER_METHODS.searchBm25, { query, topK });
    return raw.map((hit, idx) => this.mapHit(hit, "bm25", idx));
  }

  async searchVector(query: string, topK: number): Promise<SearchHit[]> {
    const raw = await this.call<RawSearchHit[]>(WORKER_METHODS.searchVector, { query, topK });
    return raw.map((hit, idx) => this.mapHit(hit, "vec", idx));
  }

  async searchHybrid(query: string, topK: number): Promise<SearchHit[]> {
    const raw = await this.call<RawSearchHit[]>(WORKER_METHODS.searchHybrid, { query, topK });
    // Every search_hybrid hit is the fused RRF output — label it "hybrid".
    return raw.map((hit, idx) => this.mapHit(hit, "hybrid", idx));
  }

  // ─── KnowledgeWorkerClient 구현 ──────────────────

  /**
   * Every document, newest first. documents_list is paged (one control frame
   * cannot carry a large index), so this follows its cursor to the end.
   */
  async listDocuments(): Promise<DocumentListing[]> {
    const rows: RawDocumentRow[] = [];
    let after: string | null = null;
    for (;;) {
      const page: DocumentsPage = await this.call<DocumentsPage>(
        WORKER_METHODS.listDocuments,
        after === null ? { limit: DOCUMENTS_PAGE_SIZE } : { after, limit: DOCUMENTS_PAGE_SIZE },
      );
      rows.push(...page.documents);
      if (page.next_after === null) break;
      if (after !== null && page.next_after <= after) {
        throw new WorkerCallError(`${WORKER_METHODS.listDocuments}: cursor did not advance`, "worker-contract");
      }
      after = page.next_after;
    }
    // The pages come in doc_id order; callers have always seen newest first.
    rows.sort((a, b) => indexedAtKey(b) - indexedAtKey(a));
    return rows.map((row) => this.toDocumentListing(row));
  }

  /**
   * The documents a copy of a pre-0.8.0 index held as indexed. `sqlitePath`
   * must be inside the worker's workspace. Paged like listDocuments.
   */
  async legacyIndexManifest(sqlitePath: string): Promise<LegacyIndexDocument[]> {
    const rows: RawLegacyIndexRow[] = [];
    let after: string | null = null;
    for (;;) {
      const page: { documents: RawLegacyIndexRow[]; next_after: string | null } = await this.call(
        WORKER_METHODS.legacyIndexManifest,
        after === null
          ? { sqlite_path: sqlitePath, limit: DOCUMENTS_PAGE_SIZE }
          : { sqlite_path: sqlitePath, after, limit: DOCUMENTS_PAGE_SIZE },
      );
      rows.push(...page.documents);
      if (page.next_after === null) break;
      if (after !== null && page.next_after <= after) {
        throw new WorkerCallError(`${WORKER_METHODS.legacyIndexManifest}: cursor did not advance`, "worker-contract");
      }
      after = page.next_after;
    }
    return rows.map((row) => ({
      docId: row.doc_id,
      path: row.path,
      mtimeMs: row.mtime_ms,
      contentState: row.content_state ?? null,
      contentHash: row.content_hash ?? null,
      hadVectors: row.had_vectors === true,
    }));
  }

  async getStructure(docId: string): Promise<unknown> {
    return this.call<unknown>(WORKER_METHODS.structure, { doc_id: docId });
  }

  async getPageContent(docId: string, pages: string): Promise<Array<{ page: number; content: string }>> {
    return this.call<Array<{ page: number; content: string }>>(WORKER_METHODS.pageContent, {
      doc_id: docId,
      pages,
    });
  }

  // ─── 추가 메서드 ────────────────────────────────

  async getDocument(docId: string): Promise<DocumentRow> {
    return this.call<DocumentRow>(WORKER_METHODS.getDocument, { doc_id: docId });
  }

  async removeDocument(docId: string): Promise<void> {
    await this.call<{ removed: boolean; doc_id: string }>(WORKER_METHODS.removeDocument, { doc_id: docId });
  }

  /** indexer_reindex — 동기 인덱싱, IndexResultDict 반환 */
  async reindex(filePath: string, mode = "auto"): Promise<IndexResultDict> {
    return this.call<IndexResultDict>(WORKER_METHODS.reindex, { file_path: filePath, mode });
  }

  /**
   * indexer_reconcile — SQLite↔LanceDB 벡터 drift 를 감지 + 정규화.
   *
   * Detect + normalise 만 수행 (임베딩 호출 없음) → 키 불필요. 응답의
   * `drifted_docs` 는 embeddings_meta 행은 있으나 Lance 벡터가 없는 doc
   * (크래시로 인한 잔여) — 호스트가 warmup 이후 bounded reindex 로
   * 치유한다. orphan 벡터(메타 없는 Lance 행)는 여기서 즉시 삭제된다.
   */
  async reconcile(): Promise<ReconcileReport> {
    return this.call<ReconcileReport>(WORKER_METHODS.reconcile, {});
  }

  /**
   * Convenience: 파일을 인덱싱하고 doc_id를 반환.
   * 내부적으로 reindex(synchronous)을 호출하여 결과에서 doc_id 추출.
   * (LocalIndexerPlugin.indexDocument의 single source of truth)
   */
  async indexDocument(filePath: string, mode = "auto"): Promise<string> {
    const result = await this.reindex(filePath, mode);
    if (result.status === "failed") {
      const detail = result.errors?.length ? `: ${result.errors.join(", ")}` : "";
      throw new WorkerIndexFailure(
        `indexDocument: 인덱싱 실패 (${filePath})${detail}`,
        filePath,
        result.retryable === true,
      );
    }
    if (!result?.doc_id) {
      throw new Error(`indexDocument: worker reindex 응답에 doc_id 없음 (${filePath})`);
    }
    // 빈 doc 은 에러 아님 (사용자 정책): 캡션 모델이 description 못 만든
    // 이미지, 텍스트 추출이 비어버린 doc 등은 worker 가 status="indexed"
    // + embedded=False 로 반환한다. 실패 사유가 있는 경우엔 worker 가
    // status="failed" + errors[] 로 반환하므로 위 분기에서 잡힌다.
    // 따라서 embedded 필드는 informational — 인덱싱 성공/실패 판정에 쓰지
    // 않는다.
    return result.doc_id;
  }

  /**
   * indexer_set_image_captioning — worker indexer 의 image-captioning 설정을
   * 갱신. 다음 indexing call 부터 적용된다 (worker restart 불필요). host 가
   * config store 를 단일 소스로 유지하고 worker boot 시마다 본 메서드를
   * 호출해 상태를 동기화한다.
   *
   * `model` / `endpoint` / `apiVersion` are tri-state on the wire: `null`
   * keeps the worker's current value, `""` resets it to the provider default,
   * a non-empty string sets it. The host reads all three from config on every
   * push and sends `""` for an unset one, so a provider switch drops the
   * previous provider's model and endpoint instead of carrying them across.
   *
   * No credential crosses: the worker relays each caption request to this
   * plugin, which resolves the provider key itself (`egressBroker.ts`).
   */
  async setImageCaptioning(
    enabled: boolean,
    provider: "openai" | "azure-openai-chat" | "azure-openai-responses",
    model: string | null,
    endpoint: string | null,
    apiVersion: string | null,
  ): Promise<{
    enabled: boolean;
    provider: "openai" | "azure-openai-chat" | "azure-openai-responses";
    model: string;
    endpoint?: string;
    apiVersion?: string;
  }> {
    return this.call(WORKER_METHODS.setImageCaptioning, {
      enabled,
      provider,
      model,
      // Worker schema uses snake_case field names; match it exactly.
      endpoint,
      api_version: apiVersion,
    });
  }

  /**
   * indexer_set_embedding_egress — tell the worker that a provider credential
   * exists, so it may ask this plugin for embeddings. The worker never holds
   * the credential: each embedding request it relays is resolved here, fresh.
   * Without this push the worker stays BM25-only rather than sending a request
   * per chunk that would be refused.
   */
  async setEmbeddingEgress(enabled: boolean): Promise<{ embeddingEgress: boolean }> {
    return this.call<{ embeddingEgress: boolean }>(WORKER_METHODS.setEmbeddingEgress, { enabled });
  }

  /**
   * indexer_caption_image — 이미지 한 장을 캡셔닝하여 텍스트 반환.
   * provider 는 "openai" (gpt-4.1-mini Vision) 또는 Azure OpenAI 두 형태.
   * model 빈 문자열이면 provider 별 디폴트 사용.
   */
  async captionImage(
    filePath: string,
    provider: "openai" | "azure-openai-chat" | "azure-openai-responses" = "openai",
    model = "",
  ): Promise<{
    filePath: string;
    caption: string;
    provider: "openai" | "azure-openai-chat" | "azure-openai-responses";
    model: string;
    inputTokens: number;
    outputTokens: number;
  }> {
    const data = await this.call<{
      file_path: string;
      caption: string;
      provider: "openai" | "azure-openai-chat" | "azure-openai-responses";
      model: string;
      input_tokens: number;
      output_tokens: number;
    }>(WORKER_METHODS.captionImage, { file_path: filePath, provider, model });
    return {
      filePath: data.file_path,
      caption: data.caption,
      provider: data.provider,
      model: data.model,
      inputTokens: data.input_tokens ?? 0,
      outputTokens: data.output_tokens ?? 0,
    };
  }

  async getMetrics(): Promise<Record<string, number>> {
    return this.call<Record<string, number>>(WORKER_METHODS.metrics);
  }

  /** runtime_info — the index location the worker resolved, and its document count. */
  async runtimeInfo(options: WorkerCallOptions = {}): Promise<WorkerRuntimeInfo> {
    return this.call<WorkerRuntimeInfo>(WORKER_METHODS.runtimeInfo, undefined, options);
  }

  /** worker_shutdown — close the stores (WAL checkpoint, lance flush) before the plugin stops the worker. */
  async shutdown(options: WorkerCallOptions = {}): Promise<{ bye: boolean }> {
    return this.call<{ bye: boolean }>(WORKER_METHODS.shutdown, undefined, options);
  }

  /**
   * runtime_allowed_roots — replace the worker's path-confinement roots. The
   * host calls it when index_folders (action add/remove) changes the scan
   * folders, so `_validate_file_path_within_roots` accepts the new paths.
   */
  async setAllowedRoots(roots: string[]): Promise<{ roots: string[]; count: number }> {
    return this.call<{ roots: string[]; count: number }>(WORKER_METHODS.allowedRoots, { roots });
  }

  /** worker_health — true once the worker answers with its stores open. */
  async health(options: WorkerCallOptions = {}): Promise<boolean> {
    try {
      const res = await this.call<{ status?: string }>(WORKER_METHODS.health, undefined, options);
      return res?.status === "ok";
    } catch {
      return false;
    }
  }

  // ─── shape 변환 ──────────────────────────────────

  private mapHit(raw: RawSearchHit, source: "bm25" | "vec" | "hybrid", idx: number): SearchHit {
    return {
      source,
      chunkId: raw.chunk_id,
      docId: raw.doc_id,
      docName: raw.doc_name,
      page: raw.page,
      rawText: raw.raw_text,
      rank: idx,
      score: raw.score,
      path: raw.path,
    };
  }

  private toDocumentListing(row: RawDocumentRow): DocumentListing {
    return {
      docId: row.doc_id,
      docName: row.doc_name,
      type: row.doc_type,
      path: row.path,
      pageCount: row.page_count,
      lineCount: row.line_count,
      mtimeMs: row.mtime_ms,
      indexedAt: row.indexed_at,
      updatedAt: row.indexed_at,
      status: row.status,
      contentState: row.content_state,
    };
  }
}
