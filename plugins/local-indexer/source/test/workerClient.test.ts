/**
 * WorkerClient over worker stdio control v1: every call is one
 * `handle.request(method, params)` on the attached incarnation.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WorkerControlError } from "@ave/plugin-contract";
import { WORKER_METHODS, WorkerCallError, WorkerClient } from "../src/workerClient";
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
      documents_list: [],
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
      ["documents_list", undefined],
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
      documents_list: () => [
        { doc_id: "d1", path: "/docs/a.md", doc_name: "a.md", doc_type: "md", line_count: 12, indexed_at: "2026-04-01T00:00:00Z", status: "ready" },
        { doc_id: "d2", path: "/docs/b.pdf", doc_name: "b.pdf", doc_type: "pdf", page_count: 10, indexed_at: "2026-04-02T00:00:00Z" },
      ],
    });
    const docs = await client.listDocuments();
    expect(docs[0]).toMatchObject({
      docId: "d1", docName: "a.md", type: "md", path: "/docs/a.md", lineCount: 12,
      indexedAt: "2026-04-01T00:00:00Z", updatedAt: "2026-04-01T00:00:00Z", status: "ready",
    });
    expect(docs[1]).toMatchObject({ docId: "d2", pageCount: 10, updatedAt: "2026-04-02T00:00:00Z" });
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
