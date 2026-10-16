/**
 * WorkerClient — Agent 2 Python worker HTTP 클라이언트
 *
 * Python worker endpoints exposed as typed methods + Agent 3 인터페이스 구현.
 *
 * Agent 2의 Python snake_case 응답 shape을 Agent 3의 camelCase shape으로 변환:
 *   { chunk_id, doc_id, doc_name, page, raw_text, score } →
 *   { chunkId, docId, docName, page, rawText, rank, score }
 *
 * 에러 처리: { ok: false, error: string } 응답 → throws Error(error)
 */

import { request as httpRequest } from "node:http"; // egress-gate: allow — UDS control-channel only (socketPath-bound local IPC, no outbound network)
import type { SearchHit, DocumentRow } from "./types.js";
// moved to ./host-contracts
import type { WorkerSearchClient, KnowledgeWorkerClient } from "./host-contracts.js";

// ─── 응답 shape ──────────────────────────────────────

type WorkerOk<T> = { ok: true; data: T };
type WorkerFail = { ok: false; error: string };
type WorkerResp<T> = WorkerOk<T> | WorkerFail;

/**
 * Single parse point for the worker response envelope.
 *
 * Python worker가 반환하는 `{ ok, data | error }` envelope을 단일 위치에서
 * 파싱한다. localIndexerPlugin.ts와 workerClient.ts에 동일 로직이 존재하던 것을
 * 이 함수 하나로 위임.
 *
 * - 200 + `{ok: true, data: T}` → T 반환
 * - 200 + `{ok: false, error: ...}` → throws Error(error)
 * - 비-200 응답 → throws Error(error || status)
 * - JSON 파싱 실패 → throws Error
 * - envelope 없는 raw JSON → 그대로 T로 취급
 */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB

async function readResponseTextWithLimit(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) {
    const text = await res.text();
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > maxBytes) {
      throw new Error(`Worker response too large (${bytes} bytes, max ${maxBytes})`);
    }
    return text;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel("response too large");
      throw new Error(`Worker response too large (${totalBytes} bytes, max ${maxBytes})`);
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(combined);
}

export async function parseWorkerResponse<T>(res: Response): Promise<T> {
  const contentLength = res.headers.get("content-length");
  if (contentLength !== null) {
    const size = parseInt(contentLength, 10);
    if (!Number.isNaN(size) && size > MAX_RESPONSE_BYTES) {
      throw new Error(`Worker response too large (${size} bytes, max ${MAX_RESPONSE_BYTES})`);
    }
  }
  const text = await readResponseTextWithLimit(res, MAX_RESPONSE_BYTES);
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON response from worker: ${text.slice(0, 200)}`);
    }
  }

  if (!res.ok) {
    // FastAPI HTTPException serializes as `{detail: "..."}`; our own envelope
    // uses `{error: "..."}`. Check both to avoid swallowing the real message.
    let message = `${res.status} ${res.statusText}`;
    if (parsed && typeof parsed === "object") {
      const obj = parsed as { error?: unknown; detail?: unknown };
      if ("error" in obj && obj.error !== undefined) {
        message = String(obj.error);
      } else if ("detail" in obj && obj.detail !== undefined) {
        message = typeof obj.detail === "string" ? obj.detail : JSON.stringify(obj.detail);
      }
    }
    throw new Error(message);
  }

  if (parsed && typeof parsed === "object" && "ok" in parsed) {
    const wrapped = parsed as WorkerResp<T>;
    if (!wrapped.ok) {
      throw new Error(wrapped.error);
    }
    return wrapped.data;
  }

  return parsed as T;
}

/** Python /search/* 엔드포인트가 반환하는 raw hit */
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

/** Python /documents 행 (snake_case) */
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
 * /indexer/reindex 응답 내부 result dict
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
 * /indexer/reconcile 응답 (worker `LocalIndexer.reconcile()` 와 1:1 대응).
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

export interface WorkerClientOptions {
  baseUrl?: string;
  /**
   * 호스트-중재 confinement 채널의 Unix-domain socket 경로. 설정되면 모든 HTTP는
   * 이 소켓 위로 흐르고 `baseUrl`의 authority는 더미("http://localhost")로 대체된다.
   * 미설정(null)이면 기존 TCP `baseUrl` 경로를 그대로 사용한다.
   */
  socketPath?: string | null;
}

/** UDS 위로 HTTP 요청을 보낼 때 쓰는 더미 authority. 경로(path)만 의미가 있다. */
const UDS_BASE_URL = "http://localhost";

/**
 * Python Local Indexer worker endpoints를 감싸는 TS 클라이언트.
 * WorkerSearchClient (hybrid-retriever.ts) 및 KnowledgeWorkerClient
 * (knowledge-search-tool.ts) 인터페이스를 모두 구현한다.
 */
export class WorkerClient implements WorkerSearchClient, KnowledgeWorkerClient {
  private baseUrl: string;
  private socketPath: string | null;
  private writeToken: string | null = null;

  constructor(options: WorkerClientOptions = {}) {
    this.socketPath = options.socketPath ?? null;
    this.baseUrl = this.socketPath
      ? UDS_BASE_URL
      : options.baseUrl ?? "http://127.0.0.1:43129";
  }

  /**
   * 호스트가 spawnWorker로 워커를 띄운 뒤 resolve된 UDS 경로로 transport를
   * 재구성한다. socketPath가 non-null이면 UDS 모드(baseUrl=더미 authority),
   * null이면 기존 TCP baseUrl로 되돌린다. 워커 lifecycle owner(plugin)가 start
   * 직전에 한 번 호출한다.
   */
  configureTransport(socketPath: string | null, tcpBaseUrl?: string): void {
    this.socketPath = socketPath;
    if (socketPath) {
      this.baseUrl = UDS_BASE_URL;
    } else if (tcpBaseUrl) {
      this.baseUrl = tcpBaseUrl;
    }
  }

  /**
   * 단일 fetch 진입점. UDS 모드에서는 Node `http.request({ socketPath })`로
   * Unix 소켓 위에서 요청하고, 그 외에는 표준 `fetch`를 그대로 쓴다.
   * undici를 plugin 의존성으로 추가하지 않기 위해 내장 `http`만 사용한다
   * (Electron 호스트/Node 양쪽에서 항상 resolvable).
   */
  private async fetch(url: string, init?: RequestInit): Promise<Response> {
    if (!this.socketPath) {
      return fetch(url, init);
    }
    return this.fetchOverSocket(this.socketPath, url, init);
  }

  private fetchOverSocket(
    socketPath: string,
    url: string,
    init?: RequestInit,
  ): Promise<Response> {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    const initHeaders = init?.headers;
    if (initHeaders) {
      for (const [key, value] of Object.entries(initHeaders as Record<string, string>)) {
        headers[key] = value;
      }
    }
    const body = typeof init?.body === "string" ? init.body : undefined;

    return new Promise<Response>((resolvePromise, rejectPromise) => {
      const req = httpRequest(
        { socketPath, path, method, headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const buffer = Buffer.concat(chunks);
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(res.headers)) {
              if (value === undefined) continue;
              responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : String(value));
            }
            resolvePromise(
              new Response(buffer, {
                status: res.statusCode ?? 502,
                statusText: res.statusMessage ?? "",
                headers: responseHeaders,
              }),
            );
          });
        },
      );
      req.on("error", rejectPromise);
      // 연결은 됐지만 응답이 멈춘(wedged) 워커가 무한정 매달리지 않도록 요청
      // 자체에 타임아웃을 건다. 만료되면 소켓을 destroy 하여 위 'error' 핸들러로
      // reject 시킨다 (init.signal 과 독립적인 하드 상한).
      req.setTimeout(5000, () => {
        req.destroy(new Error("[ave-local-indexer] worker UDS request timeout"));
      });
      const signal = init?.signal;
      if (signal) {
        if (signal.aborted) {
          req.destroy(new Error("aborted"));
        } else {
          signal.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true });
        }
      }
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  setWriteToken(token: string | null): void {
    this.writeToken = token;
  }

  // ─── WorkerSearchClient 구현 ──────────────────────

  async searchBm25(query: string, topK: number): Promise<SearchHit[]> {
    const raw = await this.post<RawSearchHit[]>("/search/bm25", { query, topK });
    return raw.map((hit, idx) => this.mapHit(hit, "bm25", idx));
  }

  async searchVector(query: string, topK: number): Promise<SearchHit[]> {
    const raw = await this.post<RawSearchHit[]>("/search/vector", { query, topK });
    return raw.map((hit, idx) => this.mapHit(hit, "vec", idx));
  }

  async searchHybrid(query: string, topK: number): Promise<SearchHit[]> {
    const raw = await this.post<RawSearchHit[]>("/search/hybrid", { query, topK });
    // Every /search/hybrid hit is the fused RRF output — label it "hybrid".
    return raw.map((hit, idx) => this.mapHit(hit, "hybrid", idx));
  }

  // ─── KnowledgeWorkerClient 구현 ──────────────────

  async listDocuments(): Promise<DocumentListing[]> {
    const rows = await this.get<RawDocumentRow[]>("/documents");
    return rows.map((row) => this.toDocumentListing(row));
  }

  async getStructure(docId: string): Promise<unknown> {
    return this.get<unknown>(`/structure?doc_id=${encodeURIComponent(docId)}`);
  }

  async getPageContent(docId: string, pages: string): Promise<Array<{ page: number; content: string }>> {
    return this.get<Array<{ page: number; content: string }>>(
      `/page-content?doc_id=${encodeURIComponent(docId)}&pages=${encodeURIComponent(pages)}`,
    );
  }

  // ─── 추가 엔드포인트 ────────────────────────────

  /** GET /document?doc_id=... */
  async getDocument(docId: string): Promise<DocumentRow> {
    return this.get<DocumentRow>(`/document?doc_id=${encodeURIComponent(docId)}`);
  }

  /** POST /documents/delete */
  async removeDocument(docId: string): Promise<void> {
    await this.post<{ removed: boolean; doc_id: string }>("/documents/delete", { doc_id: docId });
  }

  /** POST /indexer/reindex — 동기 인덱싱, IndexResultDict 반환 */
  async reindex(filePath: string, mode = "auto"): Promise<IndexResultDict> {
    return this.post<IndexResultDict>("/indexer/reindex", { file_path: filePath, mode });
  }

  /**
   * POST /indexer/reconcile — SQLite↔LanceDB 벡터 drift 를 감지 + 정규화.
   *
   * Detect + normalise 만 수행 (임베딩 호출 없음) → 키 불필요. 응답의
   * `drifted_docs` 는 embeddings_meta 행은 있으나 Lance 벡터가 없는 doc
   * (크래시로 인한 잔여) — 호스트가 warmup 키 push 이후 bounded reindex 로
   * 치유한다. orphan 벡터(메타 없는 Lance 행)는 여기서 즉시 삭제된다.
   */
  async reconcile(): Promise<ReconcileReport> {
    return this.post<ReconcileReport>("/indexer/reconcile", {});
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
      throw new Error(`indexDocument: 인덱싱 실패 (${filePath})${detail}`);
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
   * POST /indexer/set_image_captioning — worker indexer 의 image-embedding
   * 토글을 갱신. 호출 즉시 다음 indexing call 부터 적용된다 (worker restart
   * 불필요). host 가 config store 를 단일 소스로 유지하고 worker boot 시
   * 마다 본 메서드를 호출해 상태를 동기화한다.
   *
   * `model` / `endpoint` / `apiVersion` are tri-state on the wire: `null`
   * keeps the worker's current value, `""` resets it to the provider default,
   * a non-empty string sets it. The host reads all three from config on every
   * push and sends `""` for an unset one, so a provider switch drops the
   * previous provider's model and endpoint instead of carrying them across.
   * `apiKey` keeps `""` as "keep current" — a secret has no default.
   *
   * The `apiKey` parameter accepts either a plaintext string or a
   * `() => string` thunk (#893 Stage 3). The thunk variant is preferred — it
   * is invoked once, immediately before the outbound `fetch()`, so the secret
   * is never stored on the client instance and is harder to leak via
   * structured-clone / serialization. Plaintext form remains for callers that
   * already obtained a string from a non-SDK path.
   */
  async setImageCaptioning(
    enabled: boolean,
    provider: "openai" | "azure-openai-chat" | "azure-openai-responses",
    model: string | null,
    endpoint: string | null,
    apiKey: string | (() => string),
    apiVersion: string | null,
  ): Promise<{
    enabled: boolean;
    provider: "openai" | "azure-openai-chat" | "azure-openai-responses";
    model: string;
    endpoint?: string;
    apiVersion?: string;
    hasApiKey?: boolean;
  }> {
    // Invoke the bearer thunk at the latest possible moment so the plaintext
    // value never sits on a long-lived field. Plaintext input is taken as-is.
    const resolvedKey = typeof apiKey === "function" ? apiKey() : apiKey;
    return this.post<{
      enabled: boolean;
      provider: "openai" | "azure-openai-chat" | "azure-openai-responses";
      model: string;
      endpoint?: string;
      apiVersion?: string;
      hasApiKey?: boolean;
    }>("/indexer/set_image_captioning", {
      enabled,
      provider,
      model,
      // Worker schema uses snake_case field names; match it exactly.
      endpoint,
      api_key: resolvedKey,
      api_version: apiVersion,
    });
  }

  /**
   * POST /indexer/set_egress_token — push the worker's outbound broker token at
   * runtime. The pushed value is the per-session BROKER TOKEN (not the provider
   * key): the worker presents it as `x-ave-egress-token` and the broker injects
   * the real provider auth host-side through hostFetch. It is captured once at
   * scan entry so a mid-scan toggle change cannot reload the embedding client
   * with a different credential. An empty value is ignored worker-side, so
   * callers must check presence first.
   *
   * (Route renamed from `/indexer/set_embedding_api_key` for honesty — the
   * worker↔host contract moves together in the same single-repo change.)
   *
   * Accepts either a plaintext string or a `() => string` thunk
   * (#893 Stage 3). The thunk variant is preferred — it is invoked once,
   * immediately before the outbound `fetch()`, so the secret never lives on
   * the client instance.
   */
  async setEgressToken(
    tokenOrKey: string | (() => string),
  ): Promise<{ hasEmbeddingKey: boolean }> {
    const resolved = typeof tokenOrKey === "function" ? tokenOrKey() : tokenOrKey;
    return this.post<{ hasEmbeddingKey: boolean }>("/indexer/set_egress_token", {
      token: resolved,
    });
  }

  /**
   * POST /indexer/caption_image — 이미지 한 장을 캡셔닝하여 텍스트 반환.
   * provider 는 "openai" (gpt-4.1-mini Vision) 또는 Azure OpenAI 두 형태.
   * model 빈 문자열이면 provider 별 디폴트 사용.
   *
   * Why a dedicated endpoint instead of reusing reindex:
   * 이미지는 기존 텍스트 파서 경로(FTS5 chunker)에
   * 그대로 흘릴 수 없다. 호스트가 캡셔닝 결과 텍스트를 받아 별도 chunk 로
   * 인덱서에 주입하는 흐름이 더 명확하고, 캡션 모델 교체/A-B 테스트도
   * 한 곳에서만 한다.
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
    const data = await this.post<{
      file_path: string;
      caption: string;
      provider: "openai" | "azure-openai-chat" | "azure-openai-responses";
      model: string;
      input_tokens: number;
      output_tokens: number;
    }>("/indexer/caption_image", { file_path: filePath, provider, model });
    return {
      filePath: data.file_path,
      caption: data.caption,
      provider: data.provider,
      model: data.model,
      inputTokens: data.input_tokens ?? 0,
      outputTokens: data.output_tokens ?? 0,
    };
  }

  /** GET /metrics */
  async getMetrics(): Promise<Record<string, number>> {
    return this.get<Record<string, number>>("/metrics");
  }

  /** POST /shutdown — per-process 토큰을 x-ave-shutdown-token 헤더로 전달해 외부 종료를 차단한다. */
  async shutdown(token?: string): Promise<{ bye: boolean }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers["x-ave-shutdown-token"] = token;
    const res = await this.fetch(`${this.baseUrl}/shutdown`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    return this.parseResponse<{ bye: boolean }>(res);
  }

  /**
   * POST /runtime/allowed_roots — 런타임에 worker의 path-confinement 허용 루트
   * 갱신. host가 index_folders(action add/remove)로 스캔 폴더를 바꿀 때
   * 호출하여, `_validate_file_path_within_roots`의 422 거부를 막는다.
   * `shutdown`과 동일한 토큰으로 인증.
   */
  async setAllowedRoots(
    roots: string[],
    token: string,
  ): Promise<{ roots: string[]; count: number }> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-ave-shutdown-token": token,
    };
    const res = await this.fetch(`${this.baseUrl}/runtime/allowed_roots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ roots }),
    });
    return this.parseResponse<{ roots: string[]; count: number }>(res);
  }

  /** GET /health (헬스체크) */
  async health(): Promise<boolean> {
    try {
      // 헬스 프로브에 상한을 둔다 — TCP/UDS 양 transport 모두 signal 을 honor 하므로
      // wedged 워커가 health()를 무한정 매달리게 두지 않는다. 표준 fetch 는 signal
      // 을 네이티브로, fetchOverSocket 은 abort 리스너로 처리한다.
      const res = await this.fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ─── fetch 헬퍼 ─────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.writeToken) headers["x-ave-shutdown-token"] = this.writeToken;
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      headers,
    });
    return this.parseResponse<T>(res);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.writeToken) headers["x-ave-shutdown-token"] = this.writeToken;
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return this.parseResponse<T>(res);
  }

  private async parseResponse<T>(res: Response): Promise<T> {
    // 공용 parseWorkerResponse 헬퍼로 위임 — 로직 중복 제거.
    return parseWorkerResponse<T>(res);
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
