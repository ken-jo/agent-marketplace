/**
 * WorkerClient over worker stdio control v1: every call is one
 * `handle.request(method, params)` on the attached incarnation.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WorkerControlError } from "@ave/plugin-contract";
import {
  DOCUMENTS_PAGE_SIZE,
  WORKER_METHODS,
  WorkerCallError,
  WorkerClient,
  WORKER_PATH_NOT_ALLOWED,
  WorkerIndexFailure,
  isTransientIndexFailure,
} from "../src/workerClient";
import { FakeStdioWorker, workerRefusal } from "./support/fakeStdioWorker";

function attached(responders: Record<string, (params: unknown) => unknown> = {}): {
  client: WorkerClient;
  worker: FakeStdioWorker;
} {
  const worker = new FakeStdioWorker(responders);
  const client = new WorkerClient();
  client.attach(worker);
  return { client, worker };
}

describe("WorkerClient request mapping", () => {
  it("names every worker method by the control channel's rule, with no dots or slashes", () => {
    for (const method of Object.values(WORKER_METHODS)) {
      expect(method).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/);
    }
  });

  it("names exactly the methods the Python worker registers", () => {
    const source = readFileSync(join(__dirname, "..", "worker", "local_indexer_worker.py"), "utf-8");
    const table = /^METHOD_NAMES = \(([\s\S]*?)^\)/m.exec(source);
    expect(table, "METHOD_NAMES tuple in local_indexer_worker.py").not.toBeNull();
    const pythonMethods = [...table![1]!.matchAll(/"([a-zA-Z_][a-zA-Z0-9_]*)"/g)].map((m) => m[1]);
    expect(pythonMethods.length).toBeGreaterThan(0);
    expect([...Object.values(WORKER_METHODS)].sort()).toEqual([...pythonMethods].sort());
  });

  it("maps each client call to its worker method and params", async () => {
    const answers: Record<string, unknown> = {
      search_bm25: [],
      search_vector: [],
      search_hybrid: [],
      documents_list: { documents: [], next_after: null },
      document_structure: { nodes: [] },
      page_content: [],
      document_get: { doc_id: "d 1" },
      documents_delete: { removed: true, doc_id: "d 1" },
      indexer_reindex: { doc_id: "d", doc_name: "a.md", doc_type: "md", chunk_count: 1, status: "indexed" },
      indexer_reconcile: { checked: true, drifted_docs: [], drifted_doc_count: 0, orphan_vectors_deleted: 0 },
      indexer_set_embedding_egress: { embeddingEgress: true },
      indexer_caption_image: { file_path: "/i.png", caption: "c", provider: "openai", model: "m", input_tokens: 1, output_tokens: 2 },
      metrics: { processed: 1 },
      runtime_info: { index_root: "/r", document_count: 0 },
      runtime_allowed_roots: { roots: ["/a"], count: 1 },
      worker_shutdown: { bye: true },
      worker_health: { status: "ok" },
    };
    const { client, worker } = attached(
      Object.fromEntries(Object.entries(answers).map(([method, answer]) => [method, () => answer])),
    );

    await client.searchBm25("q", 3);
    await client.searchVector("q", 4);
    await client.searchHybrid("q", 5);
    await client.listDocuments();
    await client.getStructure("d 1");
    await client.getPageContent("d 1", "1-3");
    await client.getDocument("d 1");
    await client.removeDocument("d 1");
    await client.reindex("/docs/a.md", "md");
    await client.reconcile();
    await client.setEmbeddingEgress(true);
    await client.captionImage("/i.png", "azure-openai-chat", "vision");
    await client.getMetrics();
    await client.runtimeInfo();
    await client.setAllowedRoots(["/a"]);
    await client.shutdown();
    await client.health();

    expect(worker.requests.map(({ method, params }) => [method, params])).toEqual([
      ["search_bm25", { query: "q", topK: 3 }],
      ["search_vector", { query: "q", topK: 4 }],
      ["search_hybrid", { query: "q", topK: 5 }],
      ["documents_list", { limit: DOCUMENTS_PAGE_SIZE }],
      ["document_structure", { doc_id: "d 1" }],
      ["page_content", { doc_id: "d 1", pages: "1-3" }],
      ["document_get", { doc_id: "d 1" }],
      ["documents_delete", { doc_id: "d 1" }],
      ["indexer_reindex", { file_path: "/docs/a.md", mode: "md" }],
      ["indexer_reconcile", {}],
      ["indexer_set_embedding_egress", { enabled: true }],
      ["indexer_caption_image", { file_path: "/i.png", provider: "azure-openai-chat", model: "vision" }],
      ["metrics", undefined],
      ["runtime_info", undefined],
      ["runtime_allowed_roots", { roots: ["/a"] }],
      ["worker_shutdown", undefined],
      ["worker_health", undefined],
    ]);
    // Nothing that looks like a credential or a token is ever sent.
    expect(JSON.stringify(worker.requests)).not.toMatch(/token|api_key|apiKey/i);
  });

  it("searchBm25 maps snake_case hits to camelCase search results", async () => {
    const { client } = attached({
      search_bm25: () => [
        { chunk_id: "c1", doc_id: "d1", doc_name: "doc-1.pdf", page: 3, raw_text: "body text", score: 0.85, path: "/d.pdf" },
      ],
    });
    const hits = await client.searchBm25("query", 5);
    expect(hits).toEqual([
      {
        source: "bm25",
        chunkId: "c1",
        docId: "d1",
        docName: "doc-1.pdf",
        page: 3,
        rawText: "body text",
        score: 0.85,
        rank: 0,
        path: "/d.pdf",
      },
    ]);
  });

  it("labels vector hits 'vec' and every fused hit 'hybrid', ranked by position", async () => {
    const hit = (id: string) => ({ chunk_id: id, doc_id: "d", doc_name: "r.md", raw_text: "t", score: 0.5 });
    const { client } = attached({
      search_vector: () => [hit("a"), hit("b")],
      search_hybrid: () => [hit("c"), hit("d")],
    });
    const vec = await client.searchVector("q", 2);
    expect(vec.map((h) => [h.source, h.chunkId, h.rank])).toEqual([["vec", "a", 0], ["vec", "b", 1]]);
    const hybrid = await client.searchHybrid("q", 2);
    expect(hybrid.map((h) => h.source)).toEqual(["hybrid", "hybrid"]);
  });

  it("listDocuments preserves DB-backed metadata and compatibility aliases", async () => {
    const { client } = attached({
      documents_list: () => ({
        documents: [
          { doc_id: "d1", path: "/docs/a.md", doc_name: "a.md", doc_type: "md", line_count: 12, indexed_at: "2026-04-01T00:00:00Z", status: "ready" },
          { doc_id: "d2", path: "/docs/b.pdf", doc_name: "b.pdf", doc_type: "pdf", page_count: 10, indexed_at: "2026-04-02T00:00:00Z" },
        ],
        next_after: null,
      }),
    });
    const docs = await client.listDocuments();
    // Newest first, whatever order the pages came in.
    expect(docs.map((d) => d.docId)).toEqual(["d2", "d1"]);
    expect(docs[1]).toMatchObject({
      docId: "d1", docName: "a.md", type: "md", path: "/docs/a.md", lineCount: 12,
      indexedAt: "2026-04-01T00:00:00Z", updatedAt: "2026-04-01T00:00:00Z", status: "ready",
    });
    expect(docs[0]).toMatchObject({ docId: "d2", pageCount: 10, updatedAt: "2026-04-02T00:00:00Z" });
  });

  it("indexDocument returns the doc id and throws the worker's errors for a failed file", async () => {
    const { client, worker } = attached({
      indexer_reindex: () => ({ doc_id: "d1", doc_name: "a.md", doc_type: "md", chunk_count: 2, status: "indexed" }),
    });
    await expect(client.indexDocument("/a.md")).resolves.toBe("d1");
    worker.respond("indexer_reindex", () => ({
      doc_id: "d2", doc_name: "b.pdf", doc_type: "pdf", chunk_count: 0, status: "failed", errors: ["empty content"],
    }));
    await expect(client.indexDocument("/b.pdf")).rejects.toThrow("indexDocument: 인덱싱 실패 (/b.pdf): empty content");
  });

  it("passes an abort signal through to the request", async () => {
    const { client, worker } = attached({ runtime_info: () => ({ index_root: "/r", document_count: 0 }) });
    const signal = AbortSignal.timeout(1000);
    await client.runtimeInfo({ signal });
    expect(worker.requests[0]?.options?.signal).toBe(signal);
  });
});

describe("WorkerClient.listDocuments paging", () => {
  it("follows the cursor through a large index, one bounded page per request", async () => {
    const total = 45_000;
    const all = Array.from({ length: total }, (_v, i) => ({
      doc_id: `doc-${String(i).padStart(6, "0")}`,
      path: `/docs/${i}.md`,
      doc_name: `${i}.md`,
      doc_type: "md",
      indexed_at: i,
    }));
    const { client, worker } = attached({
      documents_list: (params) => {
        const { after, limit } = params as { after?: string; limit: number };
        expect(limit).toBe(DOCUMENTS_PAGE_SIZE);
        const start = after ? all.findIndex((d) => d.doc_id === after) + 1 : 0;
        const page = all.slice(start, start + limit);
        return { documents: page, next_after: page.length === limit ? page.at(-1)!.doc_id : null };
      },
    });
    const docs = await client.listDocuments();
    expect(docs).toHaveLength(total);
    expect(new Set(docs.map((d) => d.docId)).size).toBe(total);
    expect(docs[0]!.docId).toBe("doc-044999"); // newest first
    const calls = worker.callsOf("documents_list");
    // A full last page cannot know it is last; one empty page ends the walk.
    expect(calls).toHaveLength(Math.floor(total / DOCUMENTS_PAGE_SIZE) + 1);
    expect(calls[0]!.params).toEqual({ limit: DOCUMENTS_PAGE_SIZE });
    expect(calls[1]!.params).toEqual({ after: "doc-000999", limit: DOCUMENTS_PAGE_SIZE });
  });

  it("fails clearly, instead of looping, when the cursor does not advance", async () => {
    const { client } = attached({
      documents_list: () => ({ documents: [{ doc_id: "a", path: "/a", doc_name: "a", doc_type: "md" }], next_after: "a" }),
    });
    await expect(client.listDocuments()).rejects.toThrow(/cursor did not advance/);
  });
});

describe("WorkerClient.legacyIndexManifest", () => {
  it("pages through the old index's documents and maps them", async () => {
    const all = Array.from({ length: 2_500 }, (_v, i) => ({
      doc_id: `old-${String(i).padStart(5, "0")}`,
      path: `/docs/${i}.md`,
      mtime_ms: 1_700_000_000_000 + i,
      content_state: i % 2 === 0 ? "ok" : null,
      content_hash: null,
      had_vectors: i % 2 === 0,
    }));
    const { client, worker } = attached({
      legacy_index_manifest: (params) => {
        const { sqlite_path, after, limit } = params as { sqlite_path: string; after?: string; limit: number };
        expect(sqlite_path).toBe("/ws/.legacy-index-manifest/fts5.sqlite");
        const start = after ? all.findIndex((d) => d.doc_id === after) + 1 : 0;
        const page = all.slice(start, start + limit);
        return { documents: page, next_after: page.length === limit ? page.at(-1)!.doc_id : null };
      },
    });
    const docs = await client.legacyIndexManifest("/ws/.legacy-index-manifest/fts5.sqlite");
    expect(docs).toHaveLength(all.length);
    expect(docs[1]).toEqual({
      docId: "old-00001", path: "/docs/1.md", mtimeMs: 1_700_000_000_001,
      contentState: null, contentHash: null, hadVectors: false,
    });
    expect(docs.filter((d) => d.hadVectors)).toHaveLength(1_250);
    expect(worker.callsOf("legacy_index_manifest")).toHaveLength(3);
  });

  it("fails clearly when the cursor does not advance", async () => {
    const { client } = attached({
      legacy_index_manifest: () => ({
        documents: [{ doc_id: "a", path: "/a", mtime_ms: 1, content_state: null, content_hash: null, had_vectors: false }],
        next_after: "a",
      }),
    });
    await expect(client.legacyIndexManifest("/ws/x")).rejects.toThrow(/cursor did not advance/);
  });
});

describe("isTransientIndexFailure", () => {
  it("separates the worker's verdict on a file from failures that may pass", () => {
    expect(isTransientIndexFailure(new WorkerIndexFailure("failed", "/a"))).toBe(false);
    expect(isTransientIndexFailure(new WorkerIndexFailure("caption 429", "/a", true))).toBe(true);
    expect(
      isTransientIndexFailure(new WorkerCallError("outside allowed roots", "worker-request-failed", WORKER_PATH_NOT_ALLOWED)),
    ).toBe(true);
    expect(isTransientIndexFailure(new WorkerCallError("bad path", "worker-request-failed", -32602))).toBe(false);
    expect(isTransientIndexFailure(new WorkerCallError("not found", "worker-request-failed", -32004))).toBe(false);
    expect(isTransientIndexFailure(new WorkerCallError("too big", "payload-too-large"))).toBe(false);
    expect(isTransientIndexFailure(new WorkerCallError("io", "worker-request-failed", -32000))).toBe(true);
    expect(isTransientIndexFailure(new WorkerCallError("x", "worker-request-failed"))).toBe(true);
    for (const code of ["worker-incarnation-ended", "worker-request-cancelled", "worker-backpressure", "worker-not-running"]) {
      expect(isTransientIndexFailure(new WorkerCallError(code, code)), code).toBe(true);
    }
    expect(isTransientIndexFailure(new Error("unknown"))).toBe(true);
  });

  it("indexDocument reports a failed result as the worker's verdict", async () => {
    const { client } = attached({
      indexer_reindex: () => ({ doc_id: "d", doc_name: "e.pdf", doc_type: "pdf", chunk_count: 0, status: "failed", errors: ["encrypted"] }),
    });
    const err = await client.indexDocument("/e.pdf").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkerIndexFailure);
    expect(isTransientIndexFailure(err)).toBe(false);
  });

  it("indexDocument carries the worker's retryable flag on a failed result", async () => {
    const { client } = attached({
      indexer_reindex: () => ({
        doc_id: "d", doc_name: "c.png", doc_type: "image", chunk_count: 0, status: "failed",
        errors: ["OpenAI Vision 호출 실패: 429"], retryable: true,
      }),
    });
    const err = await client.indexDocument("/c.png").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkerIndexFailure);
    expect((err as WorkerIndexFailure).retryable).toBe(true);
    expect(isTransientIndexFailure(err)).toBe(true);
  });
});

describe("WorkerClient.setImageCaptioning wire contract", () => {
  it("sends \"\" verbatim so the worker resets model/endpoint/apiVersion, and no credential", async () => {
    const { client, worker } = attached({
      indexer_set_image_captioning: () => ({ enabled: true, provider: "openai", model: "" }),
    });
    await client.setImageCaptioning(true, "openai", "", "", "");
    expect(worker.requests[0]?.params).toEqual({
      enabled: true,
      provider: "openai",
      model: "",
      endpoint: "",
      api_version: "",
    });
  });

  it("sends null verbatim so the worker keeps its current model/endpoint/apiVersion", async () => {
    const { client, worker } = attached({
      indexer_set_image_captioning: () => ({ enabled: false, provider: "azure-openai-chat", model: "vision-deploy" }),
    });
    await client.setImageCaptioning(false, "azure-openai-chat", null, null, null);
    const params = worker.requests[0]?.params as Record<string, unknown>;
    expect(params.model).toBeNull();
    expect(params.endpoint).toBeNull();
    expect(params.api_version).toBeNull();
    expect("model" in params && "endpoint" in params && "api_version" in params).toBe(true);
  });
});

describe("WorkerClient errors", () => {
  it("throws the worker's own message for a refusal, with its JSON-RPC code", async () => {
    const { client } = attached({
      document_get: () => {
        throw workerRefusal("Document nope not found", -32004);
      },
    });
    const err = await client.getDocument("nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkerCallError);
    expect((err as WorkerCallError).message).toBe("Document nope not found");
    expect((err as WorkerCallError).code).toBe("worker-request-failed");
    expect((err as WorkerCallError).workerCode).toBe(-32004);
  });

  it("names the control error when the incarnation ended mid-call", async () => {
    const { client, worker } = attached({ indexer_reindex: () => new Promise(() => {}) });
    const pending = client.reindex("/a.md");
    await Promise.resolve();
    worker.end("exited", 1);
    const err = await pending.catch((e: unknown) => e);
    expect((err as WorkerCallError).code).toBe("worker-incarnation-ended");
    expect((err as WorkerCallError).message).toMatch(/^indexer_reindex: worker-incarnation-ended/);
  });

  it("fails at once, without hanging, when no worker is attached", async () => {
    const client = new WorkerClient();
    const err = await client.listDocuments().catch((e: unknown) => e);
    expect((err as WorkerCallError).code).toBe("worker-not-running");
    expect(client.attached).toBe(false);
  });

  it("stops calling a detached incarnation", async () => {
    const { client, worker } = attached({ metrics: () => ({}) });
    client.attach(null);
    await expect(client.getMetrics()).rejects.toThrow(/not running/);
    expect(worker.requests).toEqual([]);
  });

  it("health is false, never a throw, when the worker refuses or is gone", async () => {
    const { client, worker } = attached({
      worker_health: () => {
        throw new WorkerControlError("worker-backpressure", "full");
      },
    });
    await expect(client.health()).resolves.toBe(false);
    worker.respond("worker_health", () => ({ status: "ok" }));
    await expect(client.health()).resolves.toBe(true);
    client.attach(null);
    await expect(client.health()).resolves.toBe(false);
  });
});
