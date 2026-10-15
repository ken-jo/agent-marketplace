/**
 * AveLocalIndexerPlugin 스모크 테스트
 *
 * Python worker 프로세스는 실제로 spawn하지 않음 — hostApi.spawnWorker를
 * 모킹한 SpawnedPluginWorker 핸들로 대체하여 lifecycle, tool 위임, stdout/stderr
 * 흐름을 검증한다. raw-spawn 경로는 제거됐으므로 child_process mock 불필요.
 */
import { describe, expect, it, vi, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { flattenAgentPluginsManifest } from "@ave/plugin-contract";
import type { SpawnedPluginWorker } from "@ave/plugin-contract";

function assertStringArray(value: unknown, label: string): string[] {
  expect(value, `${label} should exist`).not.toBeUndefined();
  expect(value, `${label} should be an array`).toEqual(expect.any(Array));
  const valueAsArray = value as unknown[];
  expect(valueAsArray.every((entry) => typeof entry === "string"), `${label} should contain only strings`).toBe(true);
  return valueAsArray as string[];
}

// ─── SpawnedPluginWorker mock 헬퍼 ───────────────────────────
/**
 * 테스트용 SpawnedPluginWorker 핸들을 생성한다.
 * - socketPath: null → TCP transport (gate-OFF plain spawn or Windows ASRT-wrapped)
 * - socketPath: "/tmp/x.sock" → UDS control mode
 */
function makeHandle(opts: {
  socketPath?: string | null;
  pid?: number;
} = {}): SpawnedPluginWorker & {
  stdoutListeners: Array<(chunk: string) => void>;
  stderrListeners: Array<(chunk: string) => void>;
  exitListeners: Array<(info: { code: number | null; signal: NodeJS.Signals | null }) => void>;
  stopMock: ReturnType<typeof vi.fn>;
  emitStdout(chunk: string): void;
  emitStderr(chunk: string): void;
  emitExit(info?: { code: number | null; signal: NodeJS.Signals | null }): void;
} {
  const stdoutListeners: Array<(chunk: string) => void> = [];
  const stderrListeners: Array<(chunk: string) => void> = [];
  const exitListeners: Array<(info: { code: number | null; signal: NodeJS.Signals | null }) => void> = [];
  const stopMock = vi.fn();
  const handle = {
    socketPath: opts.socketPath ?? null,
    pid: opts.pid ?? 12345,
    stop: stopMock,
    onStdout(listener: (chunk: string) => void) { stdoutListeners.push(listener); },
    onStderr(listener: (chunk: string) => void) { stderrListeners.push(listener); },
    onExit(listener: (info: { code: number | null; signal: NodeJS.Signals | null }) => void) { exitListeners.push(listener); },
    stdoutListeners,
    stderrListeners,
    exitListeners,
    stopMock,
    emitStdout(chunk: string) { stdoutListeners.forEach((l) => l(chunk)); },
    emitStderr(chunk: string) { stderrListeners.forEach((l) => l(chunk)); },
    emitExit(info: { code: number | null; signal: NodeJS.Signals | null } = { code: 0, signal: null }) {
      exitListeners.forEach((l) => l(info));
    },
  };
  return handle;
}

/**
 * macOS caps `sockaddr_un.sun_path` at 104 bytes including the NUL, and a
 * per-test `/var/folders/...` tmpdir already spends most of that — an
 * over-long address makes `bind()` answer `EINVAL`, which names no length.
 * `/private/tmp` is the real path `/tmp` resolves to, so it survives the
 * sandbox's canonicalisation too.
 */
const SHORT_TMP_ROOT = process.platform === "darwin" ? "/private/tmp" : tmpdir();
const createdSocketDirs: string[] = [];

function makeSocketDir(): string {
  const dir = mkdtempSync(join(SHORT_TMP_ROOT, "ave-sock-"));
  createdSocketDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdSocketDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Dial the broker over its Unix socket. `fetch()` cannot reach it: the broker
 * has no TCP authority to name any more, and `--egress-broker-url` carries
 * only the dummy authority the provider SDKs insist on parsing.
 */
function brokerProbe(socketPath: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((settle, reject) => {
    const req = httpRequest(
      {
        socketPath,
        path: "/egress/embedding/embeddings",
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
      },
      (res) => {
        res.resume();
        settle(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
}

function testBrokerOptions() {
  const channel = async () => ({
    upstreamBaseUrl: "https://api.openai.com/v1",
    apiKey: "fake-host-provider-token",
    authScheme: "bearer" as const,
  });
  return {
    egressChannels: { embedding: channel, caption: channel },
    isUpstreamAllowed: () => true,
    egressUpstreamFetch: async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from("{}"),
    }),
    pluginSocketDir: makeSocketDir(),
  };
}

// ─── 테스트 ──────────────────────────────────────────────────

describe("AveLocalIndexerPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("인스턴스 생성: isRunning 초기값 false", async () => {
    const { AveLocalIndexerPlugin } = await import("../src/localIndexerPlugin");
    const plugin = new AveLocalIndexerPlugin({ pythonExecutable: "/usr/bin/python3" });
    expect(plugin.isRunning).toBe(false);
  });

  it("getWorkerClient(): WorkerClient 인스턴스 반환", async () => {
    const { AveLocalIndexerPlugin } = await import("../src/localIndexerPlugin");
    const { WorkerClient } = await import("../src/workerClient");
    const plugin = new AveLocalIndexerPlugin({ pythonExecutable: "/usr/bin/python3" });
    expect(plugin.getWorkerClient()).toBeInstanceOf(WorkerClient);
  });

  it("getShutdownToken(): start 전 null", async () => {
    const { AveLocalIndexerPlugin } = await import("../src/localIndexerPlugin");
    const plugin = new AveLocalIndexerPlugin({ pythonExecutable: "/usr/bin/python3" });
    // token은 startInternal()에서 생성되므로 start 전에는 null
    // (실제로는 constructor에서 생성하지 않음)
    // start()를 호출하지 않으면 null이어야 함
    expect(plugin.getShutdownToken()).toBeNull();
  });

  it("pythonExecutable 미설정 시 start() → Error throw", async () => {
    const { AveLocalIndexerPlugin } = await import("../src/localIndexerPlugin");
    // pythonExecutable 없이 생성
    const plugin = new AveLocalIndexerPlugin({});

    // health check가 오기 전에 에러가 발생해야 하므로 fetch는 stub하지 않음
    await expect(plugin.start()).rejects.toThrow("pythonExecutable");
  });

  it("stop(): 실행 중이 아닌 상태에서 호출해도 에러 없음", async () => {
    const { AveLocalIndexerPlugin } = await import("../src/localIndexerPlugin");
    const plugin = new AveLocalIndexerPlugin({ pythonExecutable: "/usr/bin/python3" });
    await expect(plugin.stop()).resolves.toBeUndefined();
  });

  it("indexDocument(): workerClient에 위임 → 결과 반환", async () => {
    const { AveLocalIndexerPlugin } = await import("../src/localIndexerPlugin");
    const plugin = new AveLocalIndexerPlugin({ pythonExecutable: "/usr/bin/python3" });

    // workerClient.indexDocument를 spy
    const wc = plugin.getWorkerClient();
    vi.spyOn(wc, "indexDocument").mockResolvedValue("doc-mocked");

    const result = await plugin.indexDocument("/path/to/doc.pdf", "auto");
    expect(result).toBe("doc-mocked");
    expect(wc.indexDocument).toHaveBeenCalledWith("/path/to/doc.pdf", "auto");
  });

  it("listDocuments(): workerClient에 위임 → 배열 반환", async () => {
    const { AveLocalIndexerPlugin } = await import("../src/localIndexerPlugin");
    const plugin = new AveLocalIndexerPlugin({ pythonExecutable: "/usr/bin/python3" });

    const wc = plugin.getWorkerClient();
    const mockDocs = [{
      docId: "d1",
      docName: "a.pdf",
      type: "pdf",
      pageCount: 5,
      indexedAt: "2026-04-01",
      path: "/a.pdf",
      mtimeMs: 1234,
      status: "indexed",
    }];
    vi.spyOn(wc, "listDocuments").mockResolvedValue(mockDocs as any);

    const result = await plugin.listDocuments();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "d1",
      doc_id: "d1",
      doc_name: "a.pdf",
      doc_type: "pdf",
      type: "pdf",
      path: "/a.pdf",
      page_count: 5,
      mtime_ms: 1234,
      indexed_at: "2026-04-01",
      status: "indexed",
    });
    expect(wc.listDocuments).toHaveBeenCalledOnce();
  });

  it("removeDocument(): workerClient.removeDocument에 위임", async () => {
    const { AveLocalIndexerPlugin } = await import("../src/localIndexerPlugin");
    const plugin = new AveLocalIndexerPlugin({ pythonExecutable: "/usr/bin/python3" });

    const wc = plugin.getWorkerClient();
    vi.spyOn(wc, "removeDocument").mockResolvedValue(undefined);

    await expect(plugin.removeDocument("doc-1")).resolves.toBeUndefined();
    expect(wc.removeDocument).toHaveBeenCalledWith("doc-1");
  });

  it("getDocumentStructure(): workerClient.getStructure에 위임", async () => {
    const { AveLocalIndexerPlugin } = await import("../src/localIndexerPlugin");
    const plugin = new AveLocalIndexerPlugin({ pythonExecutable: "/usr/bin/python3" });

    const wc = plugin.getWorkerClient();
    const tree = { nodes: [{ title: "서론", page: 1 }] };
    vi.spyOn(wc, "getStructure").mockResolvedValue(tree);

    const result = await plugin.getDocumentStructure("doc-1");
    expect(result).toEqual(tree);
    expect(wc.getStructure).toHaveBeenCalledWith("doc-1");
  });

  it("getPageContent(): workerClient에 위임 → 응답 반환", async () => {
    const { AveLocalIndexerPlugin } = await import("../src/localIndexerPlugin");
    const plugin = new AveLocalIndexerPlugin({ pythonExecutable: "/usr/bin/python3" });

    const wc = plugin.getWorkerClient();
    const mockPages = [{ page: 1, content: "페이지 내용" }];
    vi.spyOn(wc, "getPageContent").mockResolvedValue(mockPages as any);

    const result = await plugin.getPageContent("doc-1", "1-3");
    expect(result).toEqual(mockPages);
    expect(wc.getPageContent).toHaveBeenCalledWith("doc-1", "1-3");
  });

  it("grants and injects the corp CA the host resolved, and only that one", async () => {
    // The path comes from the HOST entry, which resolved it under `aveHome`
    // and checked once that it exists. The plugin no longer rebuilds it from
    // `homedir()` — inside a confined child that answers with the sandbox's
    // throwaway, and the worker would silently fall back to the default trust
    // store on a network that intercepts TLS.
    const root = await mkdtemp(join(tmpdir(), "ave-local-indexer-ca-"));
    const corpCaPath = join(root, "corp-ca.pem");
    await writeFile(corpCaPath, "-----BEGIN CERTIFICATE-----\n");
    try {
      const { AveLocalIndexerPlugin } = await import("../src/localIndexerPlugin");
      const { WorkerClient } = await import("../src/workerClient");

      let capturedSpec: Record<string, unknown> | null = null;
      const handle = makeHandle({ socketPath: null });
      const spawnWorker = vi.fn().mockImplementation(async (spec: any) => {
        capturedSpec = spec;
        return handle;
      });
      vi.spyOn(WorkerClient.prototype, "health").mockResolvedValue(true);
      vi.spyOn(WorkerClient.prototype, "shutdown").mockResolvedValue({ bye: true });

      const plugin = new AveLocalIndexerPlugin({
        pythonExecutable: "/usr/bin/python3",
        indexStorageRoot: root,
        startupTimeoutMs: 500,
        shutdownGraceMs: 0,
        spawnWorker,
        corpCaPath,
        ...testBrokerOptions(),
      });
      await plugin.start();

      const spec = capturedSpec as unknown as {
        allowReadPaths: string[];
        env: Record<string, string>;
      };
      expect(spec.allowReadPaths).toContain(corpCaPath);
      // All three, because the worker's Python reaches the trust store through
      // three different libraries and a PEM named to only some of them is a
      // trust store that disagrees with itself.
      expect(spec.env.SSL_CERT_FILE).toBe(corpCaPath);
      expect(spec.env.REQUESTS_CA_BUNDLE).toBe(corpCaPath);
      expect(spec.env.CURL_CA_BUNDLE).toBe(corpCaPath);
      await plugin.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("indexStorageRoot는 worker 저장 경로로만 반영하고 미지원 CLI 플래그를 전달하지 않는다", async () => {
    const root = await mkdtemp(join(tmpdir(), "ave-local-indexer-storage-"));
    try {
      const { AveLocalIndexerPlugin } = await import("../src/localIndexerPlugin");
      const { WorkerClient } = await import("../src/workerClient");

      let capturedArgs: string[] = [];
      let capturedSpec: Record<string, unknown> | null = null;
      const handle = makeHandle({ socketPath: null, pid: 12345 });
      const spawnWorker = vi.fn().mockImplementation(async (spec: any) => {
        capturedSpec = spec;
        capturedArgs = spec.args ?? [];
        return handle;
      });

      // workerClient.health()를 즉시 true 반환으로 패치해 waitUntilHealthy 통과
      vi.spyOn(WorkerClient.prototype, "health").mockResolvedValue(true);
      // workerClient.shutdown()도 패치 (stop 시 호출)
      vi.spyOn(WorkerClient.prototype, "shutdown").mockResolvedValue({ bye: true });

      const plugin = new AveLocalIndexerPlugin({
        pythonExecutable: "/usr/bin/python3",
        indexStorageRoot: root,
        startupTimeoutMs: 500,
        shutdownGraceMs: 0,
        spawnWorker,
        ...testBrokerOptions(),
      });
      await plugin.start();

      const expectedRoot = resolve(root);
      expect(capturedArgs).toContain("--workspace");
      expect(capturedArgs).toContain(resolve(expectedRoot, "workspace"));
      expect(capturedArgs).toContain("--sqlite");
      expect(capturedArgs).toContain(resolve(expectedRoot, "fts5.sqlite"));
      expect(capturedArgs).toContain("--lance");
      expect(capturedArgs).toContain(resolve(expectedRoot, "vectors.lance"));

      expect(capturedSpec).not.toBeNull();
      expect(capturedSpec).toEqual(
        expect.objectContaining({
          allowReadPaths: expect.any(Array),
          allowWritePaths: expect.any(Array),
        }),
      );
      const capturedReadPaths = assertStringArray(capturedSpec.allowReadPaths, "allowReadPaths");
      const capturedWritePaths = assertStringArray(capturedSpec.allowWritePaths, "allowWritePaths");

      const expectedReadPaths = new Set<string>([
        "/usr/bin/python3",
      ]);
      const workerGrantPath = capturedReadPaths.find((value) =>
        /[\\/]local_indexer_worker\.py$/.test(value)
      );
      expect(workerGrantPath).toBeDefined();
      if (workerGrantPath) expectedReadPaths.add(workerGrantPath);

      // No `corpCaPath` option was given, so no PEM is granted. This used to
      // read the developer's own `~/.ave/certs/` and assert conditionally,
      // which made the outcome depend on the machine rather than on the input.
      expect(capturedReadPaths.filter((value) => value.endsWith(".pem"))).toEqual([]);

      const forbiddenEntries = [
        "--workspace",
        "--sqlite",
        "--lance",
        "--embedding-endpoint",
        "--embedding-api-key",
        "fake",
      ];
      for (const forbidden of forbiddenEntries) {
        expect(capturedReadPaths).not.toContain(forbidden);
      }

      expect(capturedReadPaths).toEqual(expect.arrayContaining(Array.from(expectedReadPaths)));
      expect(capturedReadPaths.every((value) => expectedReadPaths.has(value))).toBe(true);
      expect(capturedReadPaths).toHaveLength(expectedReadPaths.size);

      const expectedWritePaths = new Set<string>([
        resolve(expectedRoot),
        resolve(expectedRoot, "workspace"),
      ]);
      expect(capturedWritePaths).toEqual(expect.arrayContaining(Array.from(expectedWritePaths)));
      expect(capturedWritePaths).toHaveLength(expectedWritePaths.size);
      await plugin.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // SECURITY (P1 item 9): the embedding API key must NEVER be placed on the
  // worker's spawn env. The host-injected AVE_INDEXER_API_KEY channel was
  // removed because it exposed the key via /proc/<pid>/environ, child-process
  // inheritance, and crash dumps. The key is pushed to the running worker over
  // the control channel instead, so even with an apiKey configured the spawn
  // env must carry no AVE_INDEXER_API_KEY (and no OPENAI_API_KEY).
  it("spawn env에 AVE_INDEXER_API_KEY를 주입하지 않는다 (키는 런타임 push 전용)", async () => {
    const root = await mkdtemp(join(tmpdir(), "ave-local-indexer-noenvkey-"));
    try {
      const { AveLocalIndexerPlugin } = await import("../src/localIndexerPlugin");
      const { WorkerClient } = await import("../src/workerClient");

      let capturedEnv: Record<string, string | undefined> = {};
      const handle = makeHandle({ socketPath: null, pid: 12345 });
      const spawnWorker = vi.fn().mockImplementation(async (spec: any) => {
        capturedEnv = spec.env ?? {};
        return handle;
      });

      vi.spyOn(WorkerClient.prototype, "health").mockResolvedValue(true);
      vi.spyOn(WorkerClient.prototype, "shutdown").mockResolvedValue({ bye: true });

      const plugin = new AveLocalIndexerPlugin({
        pythonExecutable: "/usr/bin/python3",
        indexStorageRoot: root,
        startupTimeoutMs: 500,
        shutdownGraceMs: 0,
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
        apiKey: "fake-provider-token-must-not-leak-into-env",
        spawnWorker,
        ...testBrokerOptions(),
      });
      await plugin.start();

      expect(capturedEnv).not.toHaveProperty("AVE_INDEXER_API_KEY");
      expect(capturedEnv).not.toHaveProperty("OPENAI_API_KEY");
      // Defense in depth: no env value should equal the configured key.
      expect(Object.values(capturedEnv)).not.toContain("fake-provider-token-must-not-leak-into-env");
      await plugin.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // #955 round-2 architect Minor: onConfigWarning surfaces azure-inherit
  // missing-config as a structured callback so the host can emit a UI-visible
  // event (forwarded to `index.warning` with kind="azure-inherit-missing-config"
  // in hostPlugin.ts).
  //
  // The callback fires inside `startInternal()` during arg construction,
  // before the worker health check. We use a tight startupTimeoutMs so the
  // start() promise rejects quickly rather than hanging, then assert the
  // callback was invoked with the expected shape.
  it("azure provider with missing endpoint/apiKey invokes onConfigWarning", async () => {
    const root = await mkdtemp(join(tmpdir(), "ave-local-indexer-config-warn-"));
    try {
      const { AveLocalIndexerPlugin } = await import("../src/localIndexerPlugin");
      const { WorkerClient } = await import("../src/workerClient");

      // health() never resolves within 0ms timeout → start() rejects as intended.
      vi.spyOn(WorkerClient.prototype, "health").mockRejectedValue(new Error("health unavailable"));

      const handle = makeHandle({ socketPath: null });
      const spawnWorker = vi.fn().mockResolvedValue(handle);

      const onConfigWarning = vi.fn();
      const onWorkerStderr = vi.fn();
      const plugin = new AveLocalIndexerPlugin({
        pythonExecutable: "/usr/bin/python3",
        indexStorageRoot: root,
        startupTimeoutMs: 0,
        shutdownGraceMs: 0,
        embeddingProvider: "azure",
        embeddingModel: "text-embedding-3-small",
        // endpoint + apiKey intentionally omitted to trigger CONFIG REQUIRED branch.
        hostVendor: "azure-foundry",
        onConfigWarning,
        onWorkerStderr,
        spawnWorker,
        ...testBrokerOptions(),
      });
      // start() will fail health check — the onConfigWarning fires during arg-building,
      // before waitUntilHealthy is reached.
      await expect(plugin.start()).rejects.toThrow();

      // Stderr path still fires (log archival).
      const stderrMessages = onWorkerStderr.mock.calls.map(([line]) => line);
      expect(stderrMessages.some((line) => String(line).includes("CONFIG REQUIRED"))).toBe(true);

      // New structured callback fires once with exact shape.
      expect(onConfigWarning).toHaveBeenCalledTimes(1);
      expect(onConfigWarning).toHaveBeenCalledWith({
        reason: "azure-inherit-missing-config",
        missing: ["embeddingEndpoint", "apiKey"],
        // explicit embeddingProvider="azure" → inheritedFrom describes explicit path.
        inheritedFrom: "explicit embeddingProvider=azure",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("start() 실패 시 handle.stop()이 호출되고 isRunning이 false다", async () => {
    const root = await mkdtemp(join(tmpdir(), "ave-local-indexer-start-fail-"));
    try {
      const { AveLocalIndexerPlugin } = await import("../src/localIndexerPlugin");
      const { WorkerClient } = await import("../src/workerClient");

      vi.spyOn(WorkerClient.prototype, "health").mockRejectedValue(new Error("health unavailable"));

      const handle = makeHandle({ socketPath: null });
      const spawnWorker = vi.fn().mockResolvedValue(handle);

      const plugin = new AveLocalIndexerPlugin({
        pythonExecutable: "/usr/bin/python3",
        indexStorageRoot: root,
        startupTimeoutMs: 0,
        shutdownGraceMs: 0,
        spawnWorker,
        ...testBrokerOptions(),
      });

      await expect(plugin.start()).rejects.toThrow(/failed health check/);
      expect(handle.stopMock).toHaveBeenCalled();
      expect(plugin.isRunning).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("worker stdout/stderr shutdown token 로그를 host callback으로 전달하지 않는다", async () => {
    const root = await mkdtemp(join(tmpdir(), "ave-local-indexer-token-redaction-"));
    try {
      const { AveLocalIndexerPlugin } = await import("../src/localIndexerPlugin");
      const { WorkerClient } = await import("../src/workerClient");

      vi.spyOn(WorkerClient.prototype, "health").mockResolvedValue(true);
      vi.spyOn(WorkerClient.prototype, "shutdown").mockResolvedValue({ bye: true });

      const onWorkerStdout = vi.fn();
      const onWorkerStderr = vi.fn();
      const handle = makeHandle({ socketPath: null, pid: 12345 });
      const spawnWorker = vi.fn().mockResolvedValue(handle);

      const plugin = new AveLocalIndexerPlugin({
        pythonExecutable: "/usr/bin/python3",
        indexStorageRoot: root,
        startupTimeoutMs: 100,
        shutdownGraceMs: 0,
        onWorkerStdout,
        onWorkerStderr,
        spawnWorker,
        ...testBrokerOptions(),
      });
      await plugin.start();

      // Emit via the handle's registered listeners (mirrors what host UDS bridge does).
      handle.emitStdout("[Worker] shutdown_token=secret\n");
      handle.emitStderr("AVE_SHUTDOWN_TOKEN=secret\n");
      handle.emitStdout("ordinary stdout\n");
      handle.emitStderr("ordinary stderr\n");
      handle.emitStdout("line one\nline two\n");
      handle.emitStderr("err one\nerr two\n");

      const stdoutMessages = onWorkerStdout.mock.calls.map(([line]) => line);
      const stderrMessages = onWorkerStderr.mock.calls.map(([line]) => line);
      expect(stdoutMessages).toContain("ordinary stdout");
      expect(stdoutMessages).toContain("line one");
      expect(stdoutMessages).toContain("line two");
      expect(stderrMessages).toContain("ordinary stderr");
      expect(stderrMessages).toContain("err one");
      expect(stderrMessages).toContain("err two");
      expect(stdoutMessages.some((line) => String(line).includes("shutdown_token"))).toBe(false);
      expect(stderrMessages.some((line) => String(line).includes("AVE_SHUTDOWN_TOKEN"))).toBe(false);
      await plugin.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("worker가 crash하면 onExit가 isRunning을 false로 돌려 재시작을 가능케 한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "ave-local-indexer-crash-"));
    try {
      const { AveLocalIndexerPlugin } = await import("../src/localIndexerPlugin");
      const { WorkerClient } = await import("../src/workerClient");
      vi.spyOn(WorkerClient.prototype, "health").mockResolvedValue(true);

      const onWorkerStdout = vi.fn();
      const handle = makeHandle({ socketPath: "/tmp/ave-crash.sock", pid: 12345 });
      const spawnWorker = vi.fn().mockResolvedValue(handle);

      const plugin = new AveLocalIndexerPlugin({
        pythonExecutable: "/usr/bin/python3",
        indexStorageRoot: root,
        startupTimeoutMs: 100,
        onWorkerStdout,
        spawnWorker,
        ...testBrokerOptions(),
      });
      await plugin.start();
      expect(plugin.isRunning).toBe(true);

      // 미완(개행 없는) 마지막 라인은 종종 crash 사유 — exit 시 flush 돼야 한다.
      handle.emitStdout("worker crashed: OOM");
      // 워커 비정상 종료 → 호스트 핸들 onExit 발화.
      handle.emitExit({ code: 1, signal: null });

      // isRunning=false → host ensureStarted()의 auto-restart 가 재진입 가능
      // (onExit 가 없으면 죽은 워커가 영구 isRunning=true 로 남아 재시작 불가).
      expect(plugin.isRunning).toBe(false);
      // exit 직전 미완 라인이 flush 됐다.
      expect(onWorkerStdout.mock.calls.map(([line]) => line)).toContain("worker crashed: OOM");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // ─── spawnWorker capability tests ───────────────────────────────────────────

  it("spawnWorker 없이 start()하면 minAppVersion 가이드 에러를 던진다", async () => {
    const root = await mkdtemp(join(tmpdir(), "ave-local-indexer-no-spawn-"));
    try {
      const { AveLocalIndexerPlugin } = await import("../src/localIndexerPlugin");
      const plugin = new AveLocalIndexerPlugin({
        pythonExecutable: "/usr/bin/python3",
        indexStorageRoot: root,
        startupTimeoutMs: 100,
        shutdownGraceMs: 0,
        // spawnWorker intentionally omitted
      });
      await expect(plugin.start()).rejects.toThrow(/spawnWorker/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("egressChannels 없이 start()하면 direct worker provider egress를 거부한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "ave-local-indexer-no-egress-"));
    try {
      const { AveLocalIndexerPlugin } = await import("../src/localIndexerPlugin");
      const spawnWorker = vi.fn().mockResolvedValue(makeHandle({ socketPath: null }));
      const plugin = new AveLocalIndexerPlugin({
        pythonExecutable: "/usr/bin/python3",
        indexStorageRoot: root,
        startupTimeoutMs: 100,
        shutdownGraceMs: 0,
        spawnWorker,
      });
      await expect(plugin.start()).rejects.toThrow(/egressChannels|direct worker provider egress/i);
      expect(spawnWorker).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("handle.socketPath === null → TCP transport으로 workerClient를 구성한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "ave-local-indexer-tcp-transport-"));
    try {
      const { AveLocalIndexerPlugin } = await import("../src/localIndexerPlugin");
      const { WorkerClient } = await import("../src/workerClient");

      const configureSpy = vi.spyOn(WorkerClient.prototype, "configureTransport");
      vi.spyOn(WorkerClient.prototype, "health").mockResolvedValue(true);
      vi.spyOn(WorkerClient.prototype, "shutdown").mockResolvedValue({ bye: true });

      const handle = makeHandle({ socketPath: null, pid: 0 }); // pid=0 → no session file
      const spawnWorker = vi.fn().mockResolvedValue(handle);

      const plugin = new AveLocalIndexerPlugin({
        pythonExecutable: "/usr/bin/python3",
        indexStorageRoot: root,
        startupTimeoutMs: 200,
        shutdownGraceMs: 0,
        spawnWorker,
        ...testBrokerOptions(),
      });
      await plugin.start();

      // configureTransport called with null socketPath → TCP mode preserved
      expect(configureSpy).toHaveBeenCalledWith(null, expect.stringContaining("http://"));
      expect(plugin.isRunning).toBe(true);
      await plugin.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("handle.socketPath non-null → UDS transport으로 workerClient를 구성한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "ave-local-indexer-uds-transport-"));
    try {
      const { AveLocalIndexerPlugin } = await import("../src/localIndexerPlugin");
      const { WorkerClient } = await import("../src/workerClient");

      const configureSpy = vi.spyOn(WorkerClient.prototype, "configureTransport");
      vi.spyOn(WorkerClient.prototype, "health").mockResolvedValue(true);
      vi.spyOn(WorkerClient.prototype, "shutdown").mockResolvedValue({ bye: true });

      const sockPath = "/tmp/ave-test-worker.sock";
      const handle = makeHandle({ socketPath: sockPath, pid: 0 }); // pid=0 → no session file
      const spawnWorker = vi.fn().mockResolvedValue(handle);

      const plugin = new AveLocalIndexerPlugin({
        pythonExecutable: "/usr/bin/python3",
        indexStorageRoot: root,
        startupTimeoutMs: 200,
        shutdownGraceMs: 0,
        spawnWorker,
        ...testBrokerOptions(),
      });
      await plugin.start();

      // configureTransport called with the real socketPath → UDS mode
      expect(configureSpy).toHaveBeenCalledWith(sockPath, expect.stringContaining("http://"));
      expect(plugin.isRunning).toBe(true);
      await plugin.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ─── manifest contract: UI-only tools off the LLM schema ──────────────────────
describe("manifest contract — UI-only tools are uiActions, not LLM tools", () => {
  type PureTool = {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    _meta?: { ui?: { visibility?: string[] } };
  };
  const manifest = flattenAgentPluginsManifest(
    JSON.parse(readFileSync(join(__dirname, "..", "plugin.json"), "utf-8")),
  ) as unknown as {
    tools: PureTool[];
    [key: string]: unknown;
  };
  // Pure v6 manifest: a single tools[] array, visibility carried per-tool in
  // _meta.ui.visibility. "model" = LLM-callable (former tools[]), "app" =
  // renderer-invokable via bridge.callTool (former uiActions).
  const modelTools = manifest.tools
    .filter((t) => t._meta?.ui?.visibility?.includes("model"))
    .map((t) => t.name);
  const uiActions = manifest.tools
    .filter((t) => t._meta?.ui?.visibility?.includes("app"))
    .map((t) => t.name);

  // The 12→6 hard-cut consolidation: the LLM-visible tool surface is exactly
  // these 6. index_search absorbs chat_preview; index_scan absorbs
  // index_refresh_folder + document_index_scan; index_folders absorbs
  // index_add_folder + index_add_folders + index_remove_folder.
  const SIX_TOOLS = [
    "index_search",
    "index_scan",
    "index_folders",
    "index_documents",
    "index_get_document",
    "index_scan_status",
  ];

  it("tools[] is exactly the 6 consolidated tools", () => {
    expect([...modelTools].sort()).toEqual([...SIX_TOOLS].sort());
  });

  it("the 6 absorbed old tool names are gone from tools[] (no aliases)", () => {
    for (const gone of [
      "chat_preview",
      "document_index_scan",
      "index_refresh_folder",
      "index_add_folder",
      "index_add_folders",
      "index_remove_folder",
    ]) {
      expect(modelTools).not.toContain(gone);
    }
  });

  it("omits the retired keyword-to-tool manifest contract", () => {
    expect(Object.prototype.hasOwnProperty.call(manifest, "keywords")).toBe(false);
  });

  // Tools the renderer drives directly (folder picker, settings toggles,
  // warning buffer, orphan purge) — the model never calls these, so they
  // belong in uiActions[] only and must stay out of the LLM-visible tools[].
  const UI_ONLY = [
    "index_scan_cancel",
    "index_clear_warnings",
    "index_pick_folder",
    "index_preview_folder",
    "index_get_settings",
    "index_set_image_embedding",
    "index_folders_purge_orphans",
  ];

  it("the 7 UI-only tools are absent from LLM tools[]", () => {
    for (const name of UI_ONLY) {
      expect(modelTools, `${name} must not be LLM-visible`).not.toContain(name);
    }
  });

  it("the 7 UI-only tools are present in uiActions[]", () => {
    for (const name of UI_ONLY) {
      expect(uiActions, `${name} must stay renderer-invokable`).toContain(name);
    }
  });

  it("index_scan_status stays in tools[] (the model legitimately polls scan progress)", () => {
    expect(modelTools).toContain("index_scan_status");
  });

  it("every tool name in tools[] is unique (host runtime registry sync requires it)", () => {
    const names = manifest.tools.map((t) => t.name);
    expect(names.length).toBe(new Set(names).size);
  });
});

// ─── Egress broker lifecycle (P3 ⑬) ──────────────────────────────────────
describe("AveLocalIndexerPlugin — egress broker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("broker is listening BEFORE spawnWorker resolves, and passes the broker URL via --egress-broker-url (never the real key)", async () => {
    const root = await mkdtemp(join(tmpdir(), "ave-broker-life-"));
    try {
      const { AveLocalIndexerPlugin } = await import("../src/localIndexerPlugin");
      const { WorkerClient } = await import("../src/workerClient");
      const { EGRESS_TOKEN_HEADER } = await import("../src/egressBroker");

      let capturedArgs: string[] = [];
      let brokerReachableAtSpawn = false;
      const handle = makeHandle({ socketPath: null });
      const spawnWorker = vi.fn().mockImplementation(async (spec: any) => {
        capturedArgs = spec.args ?? [];
        const idx = capturedArgs.indexOf("--egress-broker-uds");
        const socketPath = idx >= 0 ? capturedArgs[idx + 1] : "";
        // The broker must already be listening at spawn time.
        brokerReachableAtSpawn = (await brokerProbe(socketPath)) === 403; // up, but no token
        return handle;
      });
      vi.spyOn(WorkerClient.prototype, "health").mockResolvedValue(true);
      vi.spyOn(WorkerClient.prototype, "shutdown").mockResolvedValue({ bye: true });

      const plugin = new AveLocalIndexerPlugin({
        pythonExecutable: "/usr/bin/python3",
        indexStorageRoot: root,
        startupTimeoutMs: 500,
        shutdownGraceMs: 0,
        embeddingEndpoint: "https://api.openai.com",
        apiKey: "fake-real-provider-token-must-not-reach-worker",
        spawnWorker,
        ...testBrokerOptions(),
      });
      await plugin.start();

      expect(brokerReachableAtSpawn).toBe(true);
      expect(capturedArgs).toContain("--egress-broker-uds");
      // The URL is still passed because the provider SDKs insist on parsing an
      // authority — but it names no port, so nothing can be dialled through it.
      // The socket arg above is the only address that reaches the broker.
      expect(capturedArgs).toContain("--egress-broker-url");
      expect(capturedArgs[capturedArgs.indexOf("--egress-broker-url") + 1]).toBe("http://localhost");
      // In broker mode the real --embedding-endpoint is NOT passed to the worker.
      expect(capturedArgs).not.toContain("--embedding-endpoint");
      // No spawn arg or env carries the real key.
      expect(capturedArgs).not.toContain("fake-real-provider-token-must-not-reach-worker");
      expect(plugin.isEgressBrokered).toBe(true);
      expect(plugin.getEgressToken()).toBeTruthy();
      // The token is NOT the provider key.
      expect(plugin.getEgressToken()).not.toBe("fake-real-provider-token-must-not-reach-worker");

      const idx = capturedArgs.indexOf("--egress-broker-uds");
      const socketPath = capturedArgs[idx + 1];
      expect(existsSync(socketPath)).toBe(true);
      await plugin.stop();
      // After stop the socket is both unbound AND unlinked — a stale node left
      // behind would make the next start() fail with EADDRINUSE.
      await expect(brokerProbe(socketPath, { [EGRESS_TOKEN_HEADER]: "x" })).rejects.toThrow();
      expect(existsSync(socketPath)).toBe(false);
      expect(plugin.isEgressBrokered).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("worker onExit tears down the pinned broker", async () => {
    const root = await mkdtemp(join(tmpdir(), "ave-broker-exit-"));
    try {
      const { AveLocalIndexerPlugin } = await import("../src/localIndexerPlugin");
      const { WorkerClient } = await import("../src/workerClient");
      const { EGRESS_TOKEN_HEADER } = await import("../src/egressBroker");

      let brokerSocketPath = "";
      const handle = makeHandle({ socketPath: null });
      const spawnWorker = vi.fn().mockImplementation(async (spec: any) => {
        const args: string[] = spec.args ?? [];
        const idx = args.indexOf("--egress-broker-uds");
        brokerSocketPath = args[idx + 1];
        return handle;
      });
      vi.spyOn(WorkerClient.prototype, "health").mockResolvedValue(true);

      const plugin = new AveLocalIndexerPlugin({
        pythonExecutable: "/usr/bin/python3",
        indexStorageRoot: root,
        startupTimeoutMs: 500,
        spawnWorker,
        ...testBrokerOptions(),
      });
      await plugin.start();
      expect(plugin.isEgressBrokered).toBe(true);

      handle.emitExit({ code: 1, signal: null });
      // Allow the async stopEgressBroker() to settle.
      await new Promise((r) => setTimeout(r, 50));
      expect(plugin.isEgressBrokered).toBe(false);
      await expect(brokerProbe(brokerSocketPath, { [EGRESS_TOKEN_HEADER]: "x" })).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("on win32 binds loopback TCP, hands the worker the real bound URL and no socket, and still refuses an untokened caller", async () => {
    const root = await mkdtemp(join(tmpdir(), "ave-broker-win32-"));
    // `listen(path)` on Windows creates a named pipe under `\\.\pipe\`, so a
    // socket path is refused (EACCES) and there is nothing for the worker's
    // httpx transport to pin to either. The platform is stubbed rather than
    // detected so this runs on the CI hosts we actually have.
    const realPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const { AveLocalIndexerPlugin } = await import("../src/localIndexerPlugin");
      const { WorkerClient } = await import("../src/workerClient");
      const { EGRESS_TOKEN_HEADER } = await import("../src/egressBroker");

      let capturedArgs: string[] = [];
      const handle = makeHandle({ socketPath: null });
      const spawnWorker = vi.fn().mockImplementation(async (spec: any) => {
        capturedArgs = spec.args ?? [];
        return handle;
      });
      vi.spyOn(WorkerClient.prototype, "health").mockResolvedValue(true);
      vi.spyOn(WorkerClient.prototype, "shutdown").mockResolvedValue({ bye: true });

      const brokerOptions = testBrokerOptions();
      const plugin = new AveLocalIndexerPlugin({
        pythonExecutable: "/usr/bin/python3",
        indexStorageRoot: root,
        startupTimeoutMs: 500,
        shutdownGraceMs: 0,
        spawnWorker,
        ...brokerOptions,
        // Windows binds nothing in the socket directory, so the host not having
        // one must not stop the plugin.
        pluginSocketDir: undefined,
      });
      await plugin.start();

      expect(capturedArgs).not.toContain("--egress-broker-uds");
      const brokerUrl = capturedArgs[capturedArgs.indexOf("--egress-broker-url") + 1];
      // The real bound address, not the dummy authority the UDS path passes.
      expect(brokerUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      // Loopback is reachable by any local process, so the token is the whole
      // of the control there — exactly as it is over the socket.
      const denied = await fetch(`${brokerUrl}/egress/embedding/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(denied.status).toBe(403);
      const allowed = await fetch(`${brokerUrl}/egress/embedding/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [EGRESS_TOKEN_HEADER]: plugin.getEgressToken() ?? "",
        },
        body: "{}",
      });
      expect(allowed.status).toBe(200);

      await plugin.stop();
      expect(plugin.isEgressBrokered).toBe(false);
      await expect(fetch(`${brokerUrl}/egress/embedding/embeddings`, { method: "POST" })).rejects.toThrow();
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "still refuses to start without pluginSocketDir where the broker binds a Unix socket",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "ave-broker-nosock-"));
      try {
        const { AveLocalIndexerPlugin } = await import("../src/localIndexerPlugin");
        const spawnWorker = vi.fn();
        const plugin = new AveLocalIndexerPlugin({
          pythonExecutable: "/usr/bin/python3",
          indexStorageRoot: root,
          startupTimeoutMs: 500,
          spawnWorker,
          ...testBrokerOptions(),
          pluginSocketDir: undefined,
        });
        await expect(plugin.start()).rejects.toThrow(/pluginSocketDir|minAppVersion/);
        expect(spawnWorker).not.toHaveBeenCalled();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("a broker-start failure fails start() deterministically (worker not spawned)", async () => {
    const root = await mkdtemp(join(tmpdir(), "ave-broker-fail-"));
    try {
      const { AveLocalIndexerPlugin } = await import("../src/localIndexerPlugin");
      const { EgressBroker } = await import("../src/egressBroker");

      const spawnWorker = vi.fn();
      // Force broker.start() to throw — start() must reject before spawnWorker.
      const startSpy = vi.spyOn(EgressBroker.prototype, "start").mockRejectedValue(new Error("broker bind failed"));

      const plugin = new AveLocalIndexerPlugin({
        pythonExecutable: "/usr/bin/python3",
        indexStorageRoot: root,
        startupTimeoutMs: 500,
        spawnWorker,
        ...testBrokerOptions(),
      });
      await expect(plugin.start()).rejects.toThrow(/broker bind failed/);
      expect(spawnWorker).not.toHaveBeenCalled();
      expect(plugin.isEgressBrokered).toBe(false);
      startSpy.mockRestore();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
