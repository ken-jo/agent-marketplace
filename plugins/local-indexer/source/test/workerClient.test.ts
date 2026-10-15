import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerClient, parseWorkerResponse } from "../src/workerClient";

function mockFetch(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? "OK" : "Internal Server Error",
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  });
}

describe("WorkerClient", () => {
  let client: WorkerClient;

  beforeEach(() => {
    client = new WorkerClient({ baseUrl: "http://127.0.0.1:43129" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("searchBm25 maps snake_case hits to camelCase search results", async () => {
    vi.stubGlobal("fetch", mockFetch([
      {
        chunk_id: "c1",
        doc_id: "d1",
        doc_name: "doc-1.pdf",
        page: 3,
        raw_text: "body text",
        score: 0.85,
      },
    ]));

    const hits = await client.searchBm25("query", 5);

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      source: "bm25",
      chunkId: "c1",
      docId: "d1",
      docName: "doc-1.pdf",
      page: 3,
      rawText: "body text",
      score: 0.85,
      rank: 0,
    });
  });

  it("searchVector maps snake_case hits to vector search results", async () => {
    vi.stubGlobal("fetch", mockFetch([
      { chunk_id: "c2", doc_id: "d2", doc_name: "report.md", raw_text: "vector body", score: 0.72 },
      { chunk_id: "c3", doc_id: "d2", doc_name: "report.md", raw_text: "second chunk", score: 0.60 },
    ]));

    const hits = await client.searchVector("report", 10);

    expect(hits).toHaveLength(2);
    expect(hits[0].source).toBe("vec");
    expect(hits[0].chunkId).toBe("c2");
    expect(hits[0].rank).toBe(0);
    expect(hits[1].rank).toBe(1);
  });

  it("listDocuments preserves DB-backed metadata and compatibility aliases", async () => {
    vi.stubGlobal("fetch", mockFetch([
      {
        doc_id: "d1",
        path: "/docs/a.md",
        doc_name: "a.md",
        doc_type: "md",
        line_count: 12,
        indexed_at: "2026-04-01T00:00:00Z",
        status: "ready",
      },
      {
        doc_id: "d2",
        path: "/docs/b.pdf",
        doc_name: "b.pdf",
        doc_type: "pdf",
        page_count: 10,
        indexed_at: "2026-04-02T00:00:00Z",
      },
    ]));

    const docs = await client.listDocuments();

    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({
      docId: "d1",
      docName: "a.md",
      type: "md",
      path: "/docs/a.md",
      lineCount: 12,
      indexedAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-04-01T00:00:00Z",
      status: "ready",
    });
    expect(docs[1]).toMatchObject({
      docId: "d2",
      docName: "b.pdf",
      type: "pdf",
      path: "/docs/b.pdf",
      pageCount: 10,
      indexedAt: "2026-04-02T00:00:00Z",
      updatedAt: "2026-04-02T00:00:00Z",
    });
  });

  it("sends the worker token on read endpoints", async () => {
    const fetchMock = mockFetch([]);
    vi.stubGlobal("fetch", fetchMock);
    client.setWriteToken("read-token");

    await client.listDocuments();

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        "x-ave-shutdown-token": "read-token",
      },
    });
  });

  it("getStructure URL-encodes the doc id", async () => {
    const tree = { nodes: [{ title: "Intro", page: 1 }] };
    const fetchMock = mockFetch(tree);
    vi.stubGlobal("fetch", fetchMock);

    const result = await client.getStructure("doc/123");

    expect(result).toEqual(tree);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain(encodeURIComponent("doc/123"));
  });

  it("getPageContent includes the encoded pages parameter", async () => {
    const pages = [{ page: 1, content: "first page" }];
    const fetchMock = mockFetch(pages);
    vi.stubGlobal("fetch", fetchMock);

    const result = await client.getPageContent("d1", "1-3");

    expect(result).toEqual(pages);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("pages=1-3");
  });


  it("getMetrics returns the worker counters", async () => {
    const metrics = { indexed: 100, queued: 5, failed: 2 };
    vi.stubGlobal("fetch", mockFetch(metrics));

    const result = await client.getMetrics();

    expect(result).toEqual(metrics);
  });

  it("shutdown posts to /shutdown", async () => {
    vi.stubGlobal("fetch", mockFetch({ bye: true }));

    const result = await client.shutdown();

    expect(result).toMatchObject({ bye: true });
  });

  it("removeDocument posts to /documents/delete", async () => {
    const fetchMock = mockFetch({ ok: true, data: { removed: true, doc_id: "d1" } });
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.removeDocument("d1")).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/documents/delete");
  });

  it("throws when the worker returns ok:false", async () => {
    vi.stubGlobal("fetch", mockFetch({ ok: false, error: "file not found" }));

    await expect(client.searchBm25("query", 5)).rejects.toThrow("file not found");
  });

  it("throws the HTTP error payload for non-2xx responses", async () => {
    vi.stubGlobal("fetch", mockFetch({ error: "invalid query" }, false, 400));

    await expect(client.searchBm25("", 5)).rejects.toThrow("invalid query");
  });

  it("throws on invalid JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => null },
      text: async () => "not json {{",
    }));

    await expect(client.searchBm25("query", 5)).rejects.toThrow("Invalid JSON");
  });

  it("throws when the streamed response body exceeds the byte limit", async () => {
    const bigChunk = new Uint8Array(10 * 1024 * 1024 + 1);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bigChunk);
        controller.close();
      },
    });

    const res = new Response(stream, {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    await expect(parseWorkerResponse(res)).rejects.toThrow("Worker response too large");
  });

  it("throws when content-length already exceeds the byte limit", async () => {
    const res = new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(10 * 1024 * 1024 + 1),
      },
    });

    await expect(parseWorkerResponse(res)).rejects.toThrow("Worker response too large");
  });

  it("health returns true on a healthy worker", async () => {
    vi.stubGlobal("fetch", mockFetch({ status: "ok" }));

    const result = await client.health();

    expect(result).toBe(true);
  });

  it("health returns false when fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));

    const result = await client.health();

    expect(result).toBe(false);
  });

  it("searchHybrid labels every fused hit 'hybrid'", async () => {
    vi.stubGlobal("fetch", mockFetch([
      { chunk_id: "c1", doc_id: "d1", doc_name: "doc.pdf", raw_text: "text", score: 0.9, source: "bm25" },
      { chunk_id: "c2", doc_id: "d1", doc_name: "doc.pdf", raw_text: "text", score: 0.8, source: "vec" },
    ]));

    const hits = await client.searchHybrid("query", 10);

    // /search/hybrid returns the fused RRF output; the client labels every hit
    // "hybrid" regardless of the per-hit source the worker echoes.
    expect(hits[0].source).toBe("hybrid");
    expect(hits[1].source).toBe("hybrid");
  });

  it("reindex posts to /indexer/reindex", async () => {
    const indexResult = { doc_id: "d1", status: "ok", chunks: 5 };
    vi.stubGlobal("fetch", mockFetch(indexResult));

    const result = await client.reindex("/path/to/doc.pdf");

    expect(result).toEqual(indexResult);
  });

  it("getDocument fetches /document?doc_id=...", async () => {
    const doc = { doc_id: "d1", path: "/docs/a.pdf", doc_name: "a.pdf", doc_type: "pdf" };
    vi.stubGlobal("fetch", mockFetch(doc));

    const result = await client.getDocument("d1");

    expect(result).toEqual(doc);
  });
});

// ─── UDS transport (real node:http server on a Unix socket) ──────────
//
// configureTransport(socketPath, …) 로 UDS 모드를 켜면 모든 HTTP 가 Node
// http.request({ socketPath }) 위로 흐른다. 여기서는 실제 node:http 서버를
// tmpdir 하위 Unix 소켓에 띄워 round-trip / 헤더 전달 / 에러 envelope / M2
// 타임아웃을 결정론적으로 검증한다.
describe("WorkerClient UDS transport", () => {
  interface RecordedRequest {
    method: string;
    url: string;
    headers: IncomingMessage["headers"];
    body: string;
  }

  let server: Server;
  let socketPath: string;
  let socketDir: string;
  let recorded: RecordedRequest[];
  // 핸들러가 null 이면 서버는 응답하지 않고 매달린다 (M2 타임아웃 검증용).
  let handler:
    | ((req: RecordedRequest, res: ServerResponse) => void)
    | null;

  beforeEach(async () => {
    socketDir = await mkdtemp(join(tmpdir(), "ave-wc-uds-"));
    socketPath = join(socketDir, "worker.sock");
    recorded = [];
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { status: "ok" } }));
    };

    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const record: RecordedRequest = {
          method: req.method ?? "",
          url: req.url ?? "",
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        recorded.push(record);
        if (handler) {
          handler(record, res);
        }
        // handler === null → 의도적으로 응답하지 않음 (wedged worker 모사).
      });
    });

    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(socketDir, { recursive: true, force: true });
  });

  function makeUdsClient(): WorkerClient {
    const client = new WorkerClient({ baseUrl: "http://127.0.0.1:43129" });
    // tcpBaseUrl 인자는 UDS 모드에서는 무시되지만 production 호출부와 동일하게 전달한다.
    client.configureTransport(socketPath, "http://127.0.0.1:43129");
    return client;
  }

  // Unix-domain-socket — N/A on Windows (pre-existing platform limitation, unrelated to #885)
  it.skipIf(process.platform === "win32")("(a) GET /health round-trips over the Unix socket", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    };
    const client = makeUdsClient();

    await expect(client.health()).resolves.toBe(true);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].method).toBe("GET");
    expect(recorded[0].url).toBe("/health");
  });

  // Unix-domain-socket — N/A on Windows (pre-existing platform limitation, unrelated to #885)
  it.skipIf(process.platform === "win32")("(b) POST /shutdown delivers the x-ave-shutdown-token header + JSON body over the socket", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ bye: true }));
    };
    const client = makeUdsClient();

    await expect(client.shutdown("tok-123")).resolves.toEqual({ bye: true });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].method).toBe("POST");
    expect(recorded[0].url).toBe("/shutdown");
    expect(recorded[0].headers["x-ave-shutdown-token"]).toBe("tok-123");
    expect(JSON.parse(recorded[0].body)).toEqual({});
  });

  // Unix-domain-socket — N/A on Windows (pre-existing platform limitation, unrelated to #885)
  it.skipIf(process.platform === "win32")("(b) POST /runtime/allowed_roots delivers the token header + roots body over the socket", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ roots: ["/a", "/b"], count: 2 }));
    };
    const client = makeUdsClient();

    await expect(client.setAllowedRoots(["/a", "/b"], "tok-xyz")).resolves.toEqual({
      roots: ["/a", "/b"],
      count: 2,
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].method).toBe("POST");
    expect(recorded[0].url).toBe("/runtime/allowed_roots");
    expect(recorded[0].headers["x-ave-shutdown-token"]).toBe("tok-xyz");
    expect(JSON.parse(recorded[0].body)).toEqual({ roots: ["/a", "/b"] });
  });

  // Unix-domain-socket — N/A on Windows (pre-existing platform limitation, unrelated to #885)
  it.skipIf(process.platform === "win32")("(c) a non-200 response → parseWorkerResponse throws the worker error message", async () => {
    handler = (_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "worker exploded" }));
    };
    const client = makeUdsClient();

    await expect(client.searchBm25("query", 5)).rejects.toThrow("worker exploded");
  });

  // Unix-domain-socket — N/A on Windows (pre-existing platform limitation, unrelated to #885)
  it.skipIf(process.platform === "win32")("(d) the M2 request timeout rejects when the server never responds", async () => {
    // handler=null → 서버가 본문을 받고도 절대 응답하지 않는다 (connected-but-wedged).
    // fetchOverSocket 의 req.setTimeout(5000) 가 소켓을 destroy → reject.
    handler = null;
    const client = makeUdsClient();

    await expect(client.shutdown("tok")).rejects.toThrow(/timeout/);
  }, 10_000);

  // Unix-domain-socket — N/A on Windows (pre-existing platform limitation, unrelated to #885)
  it.skipIf(process.platform === "win32")("(d) health() resolves false (not hang) when the server never responds", async () => {
    // health() 는 AbortSignal.timeout(3_000) 으로 상한이 있어 wedged 서버에서도
    // 매달리지 않고 false 로 떨어진다.
    handler = null;
    const client = makeUdsClient();

    await expect(client.health()).resolves.toBe(false);
  }, 10_000);
});

describe("WorkerClient.setImageCaptioning wire contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function lastBody(fetchMock: ReturnType<typeof mockFetch>): Record<string, unknown> {
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    return JSON.parse(init.body) as Record<string, unknown>;
  }

  it("sends \"\" verbatim so the worker resets model/endpoint/apiVersion to the provider default", async () => {
    const fetchMock = mockFetch({
      ok: true,
      data: { enabled: true, provider: "openai", model: "", endpoint: "", apiVersion: "" },
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new WorkerClient({ baseUrl: "http://127.0.0.1:43129" });

    await client.setImageCaptioning(true, "openai", "", "", "", "");

    expect(lastBody(fetchMock)).toMatchObject({
      enabled: true,
      provider: "openai",
      model: "",
      endpoint: "",
      api_key: "",
      api_version: "",
    });
  });

  it("sends null verbatim so the worker keeps its current model/endpoint/apiVersion", async () => {
    const fetchMock = mockFetch({
      ok: true,
      data: { enabled: false, provider: "azure-openai-chat", model: "vision-deploy" },
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new WorkerClient({ baseUrl: "http://127.0.0.1:43129" });

    await client.setImageCaptioning(false, "azure-openai-chat", null, null, "", null);

    const body = lastBody(fetchMock);
    expect(body.model).toBeNull();
    expect(body.endpoint).toBeNull();
    expect(body.api_version).toBeNull();
    expect("model" in body && "endpoint" in body && "api_version" in body).toBe(true);
  });
});
