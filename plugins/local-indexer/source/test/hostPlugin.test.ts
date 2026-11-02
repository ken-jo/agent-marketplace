import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { EgressChannel } from "../src/egressBroker.js";

const removeDocumentMock = vi.fn(async (_docId) => {});
const indexDocumentMock = vi.fn(async (filePath) => `doc:${filePath}`);
const invalidateImageEntriesMock = vi.fn(() => 0);
const localIndexerStartMock = vi.fn(async () => {});
const localIndexerStopMock = vi.fn(async () => {});
const folderAutoIndexerEnsureWatchingMock = vi.fn(async () => {});
const folderAutoIndexerStopMock = vi.fn(async () => {});
const localIndexerPluginInstances: Array<{ started: boolean; opts?: any }> = [];
// Spy hook used by the image-embedding handler tests below.
const setImageCaptioningMock = vi.fn(async (_enabled, _provider, _model) => ({
  enabled: false,
  provider: "openai",
  model: "",
}));
const setEmbeddingEgressMock = vi.fn(async (enabled: boolean) => ({ embeddingEgress: enabled }));
const setAllowedRootsMock = vi.fn(async (roots: string[]) => ({ roots, count: roots.length }));
// Where the mocked worker says its index lives. Tests of the 0.8.0 index
// rebuild set a legacy directory here.
let mockScanTotalIndexed = 5;
let mockUnreadableFolders: string[] = [];
// Files the mocked walk saw per folder; null = 2 in every scanned folder.
let mockWalkedByFolder: Record<string, number> | null = null;
// What the mocked worker reads from the copy of a pre-0.8.0 index.
let mockLegacyManifest: Array<{
  docId: string; path: string; mtimeMs: number; contentState: string | null; contentHash: string | null; hadVectors: boolean;
}> = [];
const prePopulateCacheMock = vi.fn((_docs: unknown[]) => {});
const prePopulateCacheFromStateMock = vi.fn((_state: Map<string, unknown>) => {});
const legacyIndexManifestMock = vi.fn(async (_sqlitePath: string) => mockLegacyManifest);
let mockIndexLocation: {
  indexRoot: string;
  documentCount: number;
  inStateDirectory: boolean;
  legacyIndexDir: string | null;
} | null = null;
// Boot reconcile pass mocks. Default: no drift (a clean warmup no-op so every
// existing test's background warmup completes without error). Tests that
// exercise the heal path override reconcileMock per-case.
const reconcileMock = vi.fn(async () => ({
  checked: true,
  drifted_docs: [] as Array<{ doc_id: string; path: string }>,
  drifted_doc_count: 0,
  orphan_vectors_deleted: 0,
}));
const reindexMock = vi.fn(async (filePath: string) => ({
  doc_id: `doc:${filePath}`,
  doc_name: filePath,
  doc_type: "md",
  chunk_count: 1,
  status: "indexed",
  embedded: true as boolean | undefined,
}));
let mockDocuments = [
  { id: "d1", doc_id: "d1", doc_name: "a.pdf", doc_type: "pdf", type: "pdf", path: "/tmp/a.pdf" },
  { id: "d2", doc_id: "d2", doc_name: "b.md", doc_type: "md", type: "md", path: "/tmp/b.md" },
];

const searchBm25Mock = vi.fn(async (_query, _topK) => [
  { chunkId: "c1", docId: "d1", docName: "a.pdf", page: 1, rawText: "answer text snippet", score: 0.9, source: "bm25", path: "/tmp/a.pdf", rank: 1 },
]);
const searchVectorMock = vi.fn(async (_query, _topK) => [
  { chunkId: "c2", docId: "d2", docName: "b.md", page: 3, rawText: "v".repeat(600), score: 0.8, source: "vec", path: "/tmp/b.md", rank: 1 },
]);
const searchHybridMock = vi.fn(async (_query, _topK) => [
  { chunkId: "c3", docId: "d1", docName: "a.pdf", page: 2, rawText: "hybrid hit", score: 0.7, source: "hybrid", path: "/tmp/a.pdf", rank: 1 },
]);
let mockDocumentRow = {
  doc_id: "d1",
  doc_name: "a.pdf",
  doc_type: "pdf",
  path: "/tmp/a.pdf",
  page_count: 4,
  line_count: 100,
  indexed_at: "2025-01-01T00:00:00Z",
  status: "indexed",
};
const getDocumentMock = vi.fn(async (_docId) => mockDocumentRow);
const getPageContentMock = vi.fn(async (_docId, _pages) => [
  { page: 1, content: "page one" },
  { page: 2, content: "page two" },
]);
const getStructureMock = vi.fn(async (_docId) => ({
  doc_id: "d1",
  doc_name: "a.pdf",
  doc_type: "pdf",
  page_count: 4,
  line_count: 100,
  pages: [1, 2, 4],
}));

// 폴더 선택은 이제 `hostApi.pickFolders` — 호스트가 여는 것이라
// `node:module` 을 가로채 `electron` 을 흉내낼 이유가 없어졌다. 그 mock 은
// 이 파일 전체의 `createRequire` 를 바꿔 놓고 있었으므로, 사라진 것은
// picker 배선만이 아니라 그 부수효과이기도 하다.
const pickFoldersMock = vi.fn(async () => ({ canceled: false, folders: [] as string[] }));

// Hooks into the copy of a pre-0.8.0 index (torn copies, a full disk).
let copyFileHook: ((src: string, dst: string) => void | Promise<void>) | null = null;
let statfsOverride: ((path: string) => { bavail: number; bsize: number }) | null = null;
let lstatHook: ((path: string, real: any) => any) | null = null;
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    copyFile: async (src: string, dst: string, mode?: number) => {
      if (copyFileHook) await copyFileHook(src, dst);
      return real.copyFile(src, dst, mode);
    },
    statfs: async (path: string, opts?: any) => (statfsOverride ? statfsOverride(path) : real.statfs(path, opts)),
    lstat: async (path: string, opts?: any) => {
      const st = await real.lstat(path, opts);
      return lstatHook ? lstatHook(path, st) : st;
    },
  };
});

vi.mock("node:child_process", () => {
  const { EventEmitter } = require("node:events");
  function makeChild() {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter();
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = vi.fn();
    child.pid = 54321;
    return child;
  }
  const execFile = vi.fn((...args: any[]) => {
    const cb = args.at(-1);
    if (typeof cb === "function") cb(null, "", "");
  });
  return { spawn: vi.fn(() => makeChild()), execFile };
});

vi.mock("../src/folderIndexer.js", () => {
  class FolderAutoIndexer {
    client;
    folders;
    onFileIndexed;
    onScanProgress;
    started = false;
    scanState = { status: "idle", total: 0, processed: 0, indexed: 0, failed: 0, message: "Ready" };

    constructor(opts) {
      this.client = opts.client;
      this.folders = opts.folders;
    }

    emitProgress(snapshot) {
      this.scanState = { ...snapshot };
      this.onScanProgress?.({ ...this.scanState });
    }

    getScanProgress() {
      return { ...this.scanState };
    }

    async start() {
      this.started = true;
      await this.ensureWatching();
    }

    async ensureWatching() {
      await folderAutoIndexerEnsureWatchingMock();
      this.started = true;
    }

    async stop() {
      await folderAutoIndexerStopMock();
      this.started = false;
    }

    cancelScan() {
      if (this.scanState.status !== "running") return false;
      this.emitProgress({
        ...this.scanState,
        status: "canceled",
        message: "scan canceled",
      });
      return true;
    }

    setImageEmbeddingEnabled(_enabled) {}

    invalidateImageEntries() {
      return invalidateImageEntriesMock();
    }

    prePopulateCacheFromState(state) {
      prePopulateCacheFromStateMock(state);
    }

    prePopulateCache(docs) {
      prePopulateCacheMock(docs);
    }

    wouldIndex(_path, _folder) {
      return true;
    }

    getIndexedEntries() {
      return [
        { filePath: join(this.folders[0] ?? "/tmp", "a.pdf"), docId: "fallback-1", mtimeMs: 1710000000000 },
      ];
    }

    async scanOnce(foldersOverride) {
      const scanned = foldersOverride ?? this.folders;
      const firstPath = join(this.folders[0] ?? "/tmp", "a.md");
      const secondPath = join(this.folders[0] ?? "/tmp", "b.md");
      this.emitProgress({
        status: "running",
        total: 2,
        processed: 0,
        indexed: 0,
        failed: 0,
        message: "처리 완료 0 / 2",
      });
      this.emitProgress({
        status: "running",
        total: 2,
        processed: 1,
        indexed: 1,
        failed: 0,
        currentPath: firstPath,
        message: "처리 완료 1 / 2",
      });
      this.emitProgress({
        status: "done",
        total: 2,
        processed: 2,
        indexed: 2,
        failed: 0,
        message: "스캔 완료",
      });
      return {
        scanned: 2,
        indexed: 2,
        failed: 0,
        failedTransient: 0,
        walked: 2,
        walkedByFolder: mockWalkedByFolder ?? Object.fromEntries(scanned.map((folder) => [folder, 2])),
        failures: [],
        unreadableFolders: mockUnreadableFolders,
        totalIndexed: mockScanTotalIndexed,
        folders: this.folders,
      };
    }
  }

  return { FolderAutoIndexer };
});

vi.mock("../src/localIndexerPlugin.js", () => {
  class LocalIndexerPlugin {
    opts;
    started = false;
    constructor(opts) {
      this.opts = opts;
      localIndexerPluginInstances.push(this);
    }
    get isRunning() { return this.started; }
    getWorkerClient() {
      return {
        searchBm25: searchBm25Mock,
        searchVector: searchVectorMock,
        searchHybrid: searchHybridMock,
        getDocument: getDocumentMock,
        getPageContent: getPageContentMock,
        getStructure: getStructureMock,
        setImageCaptioning: setImageCaptioningMock,
        setEmbeddingEgress: setEmbeddingEgressMock,
        setAllowedRoots: setAllowedRootsMock,
        runtimeInfo: async () => ({ index_root: mockIndexLocation?.indexRoot ?? "", document_count: mockDocuments.length }),
        reconcile: reconcileMock,
        reindex: reindexMock,
        indexDocument: (filePath: string) => indexDocumentMock(filePath),
        legacyIndexManifest: legacyIndexManifestMock,
        captionImage: async () => ({
          filePath: "",
          caption: "",
          provider: "local",
          model: "",
          inputTokens: 0,
          outputTokens: 0,
        }),
      };
    }
    async start() {
      try {
        await localIndexerStartMock();
        this.started = true;
      } catch (err) {
        // Match the production core plugin contract: partial startup is
        // rolled back before the original startup error is rethrown.
        await this.stop();
        throw err;
      }
    }
    async stop() {
      await localIndexerStopMock();
      this.started = false;
    }
    getIndexLocation() { return this.started ? mockIndexLocation : null; }
    async listDocuments() {
      return mockDocuments;
    }
    setEmbeddingBootConfig(next) {
      this.opts = { ...this.opts, ...next };
    }
    async indexDocument(filePath) { return indexDocumentMock(filePath); }
    async removeDocument(docId) { return removeDocumentMock(docId); }
    async getDocumentStructure() { return { sections: [] }; }
    async getPageContent() { return []; }
  }
  return { LocalIndexerPlugin };
});

import createPlugin from "../src/hostPlugin.js";

/**
 * The home the fixture TELLS the plugin about — which is no longer the real
 * one. A test that needs a directory the plugin will accept has to create it
 * here: under the developer's actual home the plugin now, correctly, sees
 * another user's home, because the fixture's user lives somewhere else.
 */
function fixtureUserHome(hostRoot) {
  return join(hostRoot, "user-home");
}

function makeContext(hostRoot, config = {}, options = {}) {
  const events = [];
  const logs = [];
  const shutdownHandlers = [];
  const ctx = {
    pluginId: "local-indexer",
    pluginRoot: hostRoot,
    hostRoot,
    // `pluginDataDir` is a required host contract per SDK
    // `PluginRuntimeContext`. Default each test to a scoped subdir under the
    // per-test temp `hostRoot` so every createPlugin call satisfies the
    // assertion in hostPlugin.ts without per-test boilerplate; tests that
    // need to control the exact path (e.g. image-embedding sidecar) override.
    pluginDataDir: options.pluginDataDir ?? join(hostRoot, "plugin-data"),
    // A per-test home, NOT the developer's. The corp-CA lookup and every
    // home-relative path rule hang off these two, so pointing them at the real
    // home would make those branches depend on whether this machine happens to
    // have `~/.ave/certs/corp-ca.pem` — a test that passes for a reason the
    // suite does not state.
    userHome: options.userHome ?? fixtureUserHome(hostRoot),
    aveHome: options.aveHome ?? join(fixtureUserHome(hostRoot), ".ave"),
    config,
    log: vi.fn(),
    hostApi: {
      pickFolders: pickFoldersMock,
      emitEvent: vi.fn((type, data) => {
        events.push([type, data]);
      }),
      raiseAlert: vi.fn(async () => ({ status: "disabled_by_user" as const })),
      onEvent: vi.fn(),
      addTask: vi.fn(),
      saveNote: vi.fn(),
      // Per SDK PluginHostApi: `config.{get,set,onChange}` is a required
      // surface. Tests that exercise configSchema keys (embeddingProvider,
      // imageCaptionEndpoint, etc.) override via `options.configValues` —
      // the default returns undefined so production code falls back to
      // its own defaults.
      config: {
        get: vi.fn((key) =>
          options.configValues ? options.configValues[key] : undefined,
        ),
        set: vi.fn(async () => {}),
        onChange: vi.fn(() => () => {}),
      },
      // Default returns null; tests that need a live-rotating secret
      // override this via vi.fn() before calling createPlugin.
      getSecret: vi.fn(() => null),
      resolveApiKey: vi.fn(async () => ({
        ok: true, exposure: "lease", leaseId: "lease-test", vendor: "openai",
        release: async () => {}, onClosed: () => () => {},
      })),
      logEvent: vi.fn((level, msg, data) => logs.push([`${level}:${msg}`, data])),
      onShutdown: vi.fn((handler) => shutdownHandlers.push(handler)),
      hostFetch: vi.fn(async () => new Response("{}", { status: 200 })),
    },
  };
  return { ctx, events, logs, shutdownHandlers };
}

function latestEgressChannels() {
  const channels = localIndexerPluginInstances.at(-1)?.opts?.egressChannels;
  expect(channels).toBeTruthy();
  return channels as { embedding: EgressChannel; caption: EgressChannel };
}

describe("hostPlugin createPlugin", () => {
  let hostRoot;

  beforeEach(async () => {
    hostRoot = await mkdtemp(join(tmpdir(), "ave-hp-"));
    mockDocuments = [
      { id: "d1", doc_id: "d1", doc_name: "a.pdf", doc_type: "pdf", type: "pdf", path: "/tmp/a.pdf" },
      { id: "d2", doc_id: "d2", doc_name: "b.md", doc_type: "md", type: "md", path: "/tmp/b.md" },
    ];
    removeDocumentMock.mockClear();
    indexDocumentMock.mockClear();
    invalidateImageEntriesMock.mockClear();
    localIndexerStartMock.mockClear();
    localIndexerStopMock.mockClear();
    folderAutoIndexerEnsureWatchingMock.mockClear();
    folderAutoIndexerStopMock.mockClear();
    localIndexerPluginInstances.length = 0;
    setImageCaptioningMock.mockClear();
    setEmbeddingEgressMock.mockClear();
    setAllowedRootsMock.mockClear();
    mockIndexLocation = null;
    mockScanTotalIndexed = 5;
    mockUnreadableFolders = [];
    mockWalkedByFolder = null;
    mockLegacyManifest = [];
    legacyIndexManifestMock.mockClear();
    copyFileHook = null;
    statfsOverride = null;
    lstatHook = null;
    prePopulateCacheMock.mockClear();
    prePopulateCacheFromStateMock.mockClear();
    reconcileMock.mockClear();
    reconcileMock.mockResolvedValue({
      checked: true,
      drifted_docs: [],
      drifted_doc_count: 0,
      orphan_vectors_deleted: 0,
    });
    reindexMock.mockClear();
    pickFoldersMock.mockClear();
    pickFoldersMock.mockResolvedValue({ canceled: false, folders: [] });
    searchBm25Mock.mockClear();
    searchVectorMock.mockClear();
    searchHybridMock.mockClear();
    getDocumentMock.mockClear();
    getPageContentMock.mockClear();
    mockDocumentRow = {
      doc_id: "d1",
      doc_name: "a.pdf",
      doc_type: "pdf",
      path: "/tmp/a.pdf",
      page_count: 4,
      line_count: 100,
      indexed_at: "2025-01-01T00:00:00Z",
      status: "indexed",
    };
  });

  afterEach(async () => {
    await rm(hostRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("registers the shutdown hook and exposes public methods", async () => {
    const { ctx, shutdownHandlers } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    expect(shutdownHandlers.length).toBe(1);
    expect(typeof plugin.start).toBe("function");
    expect(typeof plugin.onPublished).toBe("function");
    expect(typeof plugin.stop).toBe("function");
    // 워커 클라이언트는 플러그인 안에만 있다: 호스트는 out-of-process 라
    // 함수 핸들을 건네받을 수 없고, 문서 도구는 이 플러그인이 소유한다.
    expect(plugin).not.toHaveProperty("getWorkerClient");

    await plugin.start();
    expect(localIndexerStartMock).not.toHaveBeenCalled();
    expect(folderAutoIndexerStopMock).not.toHaveBeenCalled();

    await plugin.onPublished?.();
    expect(ctx.log).toHaveBeenCalledWith("local-indexer plugin started");

    await plugin.stop();
    expect(ctx.log).toHaveBeenCalledWith("local-indexer plugin stopped");
  });

  it("single-flights concurrent post-publication startup", async () => {
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    await plugin.start();
    expect(localIndexerStartMock).not.toHaveBeenCalled();

    await Promise.all([plugin.onPublished?.(), plugin.onPublished?.()]);

    expect(localIndexerStartMock).toHaveBeenCalledTimes(1);
    await plugin.stop();
  });

  it("rejects publication and lazy startup after stop-before-publish", async () => {
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    await plugin.start();
    await plugin.stop();

    await expect(plugin.onPublished?.()).rejects.toThrow(
      "Local Indexer runtime is stopping or stopped",
    );
    await expect(
      plugin.handlers.index_search({ query: "late query", mode: "hybrid" }),
    ).rejects.toThrow("Local Indexer runtime is stopping or stopped");
    expect(localIndexerStartMock).not.toHaveBeenCalled();
  });

  it("waits for in-flight startup before stopping each component once", async () => {
    let releaseStartup!: () => void;
    const startupGate = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    localIndexerStartMock.mockImplementationOnce(() => startupGate);
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    const publishing = plugin.onPublished?.();
    await vi.waitFor(() => expect(localIndexerStartMock).toHaveBeenCalledTimes(1));
    const folderStopsBeforeTeardown = folderAutoIndexerStopMock.mock.calls.length;

    let stopped = false;
    const stopping = plugin.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    const stoppedBeforeStartupSettled = stopped;
    const stoppedCoreBeforeStartupSettled = localIndexerStopMock.mock.calls.length;

    releaseStartup();
    await Promise.all([publishing, stopping]);

    expect(stoppedBeforeStartupSettled).toBe(false);
    expect(stoppedCoreBeforeStartupSettled).toBe(0);
    expect(folderAutoIndexerStopMock).toHaveBeenCalledTimes(folderStopsBeforeTeardown + 1);
    expect(localIndexerStopMock).toHaveBeenCalledTimes(1);
  });

  it("waits for successful background warmup settlement before teardown", async () => {
    let releaseReconcile!: () => void;
    const reconcileGate = new Promise<void>((resolve) => {
      releaseReconcile = resolve;
    });
    reconcileMock.mockImplementationOnce(async () => {
      await reconcileGate;
      return {
        checked: true,
        drifted_docs: [],
        drifted_doc_count: 0,
        orphan_vectors_deleted: 0,
      };
    });
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    await plugin.onPublished?.();
    await vi.waitFor(() => expect(reconcileMock).toHaveBeenCalledTimes(1));
    const folderStopsBeforeTeardown = folderAutoIndexerStopMock.mock.calls.length;

    let stopped = false;
    const stopping = plugin.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    const stoppedBeforeWarmupSettled = stopped;
    const folderStopsBeforeWarmupSettled = folderAutoIndexerStopMock.mock.calls.length;
    const workerStopsBeforeWarmupSettled = localIndexerStopMock.mock.calls.length;

    releaseReconcile();
    await stopping;

    expect(stoppedBeforeWarmupSettled).toBe(false);
    expect(folderStopsBeforeWarmupSettled).toBe(folderStopsBeforeTeardown);
    expect(workerStopsBeforeWarmupSettled).toBe(0);
    expect(folderAutoIndexerStopMock).toHaveBeenCalledTimes(folderStopsBeforeTeardown + 1);
    expect(localIndexerStopMock).toHaveBeenCalledTimes(1);
  });

  it("waits for rejected background warmup settlement before teardown", async () => {
    const warmupError = new Error("watcher warmup failed");
    let rejectWatching!: (error: Error) => void;
    const watchingGate = new Promise<void>((_resolve, reject) => {
      rejectWatching = reject;
    });
    folderAutoIndexerEnsureWatchingMock.mockImplementationOnce(() => watchingGate);
    const { ctx, logs } = makeContext(hostRoot, { realtimeWatch: true });
    const plugin = await createPlugin(ctx);

    await plugin.onPublished?.();
    await vi.waitFor(() =>
      expect(folderAutoIndexerEnsureWatchingMock).toHaveBeenCalledTimes(1),
    );
    const folderStopsBeforeTeardown = folderAutoIndexerStopMock.mock.calls.length;

    let stopped = false;
    const stopping = plugin.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    const stoppedBeforeWarmupSettled = stopped;
    const folderStopsBeforeWarmupSettled = folderAutoIndexerStopMock.mock.calls.length;
    const workerStopsBeforeWarmupSettled = localIndexerStopMock.mock.calls.length;

    rejectWatching(warmupError);
    await stopping;

    expect(stoppedBeforeWarmupSettled).toBe(false);
    expect(folderStopsBeforeWarmupSettled).toBe(folderStopsBeforeTeardown);
    expect(workerStopsBeforeWarmupSettled).toBe(0);
    expect(folderAutoIndexerStopMock).toHaveBeenCalledTimes(folderStopsBeforeTeardown + 1);
    expect(localIndexerStopMock).toHaveBeenCalledTimes(1);
    expect(logs).toContainEqual([
      "warn:local_indexer.startup_warmup_failed",
      { error: warmupError.message },
    ]);
  });

  it("shares teardown between concurrent stop and shutdown calls", async () => {
    let releaseStartup!: () => void;
    const startupGate = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    localIndexerStartMock.mockImplementationOnce(() => startupGate);
    const { ctx, shutdownHandlers } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    const publishing = plugin.onPublished?.();
    await vi.waitFor(() => expect(localIndexerStartMock).toHaveBeenCalledTimes(1));
    const folderStopsBeforeTeardown = folderAutoIndexerStopMock.mock.calls.length;
    const stopping = plugin.stop();
    const shuttingDown = shutdownHandlers[0]();

    releaseStartup();
    await Promise.all([publishing, stopping, shuttingDown]);

    expect(folderAutoIndexerStopMock).toHaveBeenCalledTimes(folderStopsBeforeTeardown + 1);
    expect(localIndexerStopMock).toHaveBeenCalledTimes(1);
  });

  it("rejects lazy handlers during and after admitted teardown", async () => {
    let releaseWorkerStop!: () => void;
    const workerStopGate = new Promise<void>((resolve) => {
      releaseWorkerStop = resolve;
    });
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);
    await plugin.onPublished?.();
    localIndexerStopMock.mockImplementationOnce(() => workerStopGate);

    const stopping = plugin.stop();
    const duringTeardownError = await plugin.handlers
      .index_search({ query: "during teardown", mode: "hybrid" })
      .catch((err) => err);

    releaseWorkerStop();
    await stopping;

    expect(duringTeardownError).toMatchObject({
      message: "Local Indexer runtime is stopping or stopped",
    });
    await expect(
      plugin.handlers.index_search({ query: "after teardown", mode: "hybrid" }),
    ).rejects.toThrow("Local Indexer runtime is stopping or stopped");
    expect(localIndexerStartMock).toHaveBeenCalledTimes(1);
  });

  it("preserves startup failure and core rollback behavior", async () => {
    const startupError = new Error("worker readiness failed");
    localIndexerStartMock.mockRejectedValueOnce(startupError);
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    await expect(plugin.onPublished?.()).rejects.toBe(startupError);
    const folderStopsAfterFailedStartup = folderAutoIndexerStopMock.mock.calls.length;
    expect(localIndexerStopMock).toHaveBeenCalledTimes(1);

    await expect(plugin.stop()).resolves.toBeUndefined();
    expect(folderAutoIndexerStopMock).toHaveBeenCalledTimes(folderStopsAfterFailedStartup);
    expect(localIndexerStopMock).toHaveBeenCalledTimes(1);
  });

  it("makes repeated teardown idempotent", async () => {
    const { ctx, shutdownHandlers } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);
    await plugin.onPublished?.();
    const folderStopsBeforeTeardown = folderAutoIndexerStopMock.mock.calls.length;

    await plugin.stop();
    await plugin.stop();
    await shutdownHandlers[0]();

    expect(folderAutoIndexerStopMock).toHaveBeenCalledTimes(folderStopsBeforeTeardown + 1);
    expect(localIndexerStopMock).toHaveBeenCalledTimes(1);
  });

  it("shares and preserves a teardown rejection without retrying components", async () => {
    const stopError = new Error("worker shutdown failed");
    const { ctx, logs, shutdownHandlers } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);
    await plugin.onPublished?.();
    const folderStopsBeforeTeardown = folderAutoIndexerStopMock.mock.calls.length;
    localIndexerStopMock.mockRejectedValueOnce(stopError);

    const firstStop = plugin.stop();
    const secondStop = plugin.stop();
    await expect(firstStop).rejects.toBe(stopError);
    await expect(secondStop).rejects.toBe(stopError);
    await expect(shutdownHandlers[0]()).resolves.toBeUndefined();

    expect(folderAutoIndexerStopMock).toHaveBeenCalledTimes(folderStopsBeforeTeardown + 1);
    expect(localIndexerStopMock).toHaveBeenCalledTimes(1);
    expect(logs).toContainEqual([
      "error:local_indexer.shutdown.failed",
      { error: stopError.message },
    ]);
  });

  it("preserves both component failures in an aggregate teardown error", async () => {
    const indexerError = new Error("watcher shutdown failed");
    const workerError = new Error("worker shutdown failed");
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);
    await plugin.onPublished?.();
    folderAutoIndexerStopMock.mockRejectedValueOnce(indexerError);
    localIndexerStopMock.mockRejectedValueOnce(workerError);

    const failure = await plugin.stop().catch((err) => err);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([indexerError, workerError]);
  });

  it("routes egress broker upstream calls through hostApi.hostFetch", async () => {
    const hostFetch = vi.fn(async () =>
      new Response('{"ok":true}', {
        status: 202,
        headers: { "x-ave-test": "hostFetch" },
      }),
    );
    const { ctx } = makeContext(hostRoot);
    (ctx.hostApi as any).hostFetch = hostFetch;

    await createPlugin(ctx);

    const instance = localIndexerPluginInstances.at(-1);
    const upstreamFetch = instance?.opts?.egressUpstreamFetch;
    expect(upstreamFetch).toEqual(expect.any(Function));

    const body = Buffer.from('{"input":"hello"}');
    const res = await upstreamFetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(hostFetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: expect.any(ArrayBuffer),
      }),
    );
    const sentBody = hostFetch.mock.calls[0]?.[1]?.body;
    expect(Buffer.from(sentBody as ArrayBuffer).toString("utf-8")).toBe('{"input":"hello"}');
    expect(res.status).toBe(202);
    expect(res.headers).toMatchObject({ "x-ave-test": "hostFetch" });
    expect(res.body).toEqual(Buffer.from('{"ok":true}'));
  });

  it("hands the worker plugin no port, socket or token: the worker talks over stdio control", async () => {
    // A leftover `workerPort` from a pre-0.8.0 config is ignored.
    const { ctx } = makeContext(hostRoot, {}, {
      pluginDataDir: hostRoot,
      configValues: { workerPort: 43229 },
    });

    await createPlugin(ctx);

    const opts = localIndexerPluginInstances.at(-1)?.opts ?? {};
    for (const key of ["port", "host", "pluginSocketDir", "onWorkerStdout"]) {
      expect(opts, key).not.toHaveProperty(key);
    }
    expect(JSON.stringify(Object.keys(opts))).not.toMatch(/token|port|socket/i);
    expect(typeof opts.onWorkerStderr).toBe("function");
  });

  it("fails closed at plugin load when hostApi.hostFetch is absent", async () => {
    const { ctx } = makeContext(hostRoot);
    delete (ctx.hostApi as any).hostFetch;

    await expect(createPlugin(ctx)).rejects.toThrow(/requires hostApi\.hostFetch/);
    expect(localIndexerPluginInstances).toHaveLength(0);
  });

  it("index_scan returns the folder scan result with a message", async () => {
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    const res = await plugin.handlers.index_scan();
    expect(res.indexed).toBe(2);
    expect(res.totalIndexed).toBe(5);
    expect(res.message).toContain("5");
  });

  it("index_scan_status exposes the latest scan snapshot", async () => {
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    const status = await plugin.handlers.index_scan_status();
    expect(status).toMatchObject({
      status: "idle",
      total: 0,
      processed: 0,
      indexed: 0,
      failed: 0,
    });
  });

  it("index_scan_status replays buffered warnings and index_clear_warnings resets them", async () => {
    const { ctx } = makeContext(hostRoot, {}, { pluginDataDir: hostRoot });
    const plugin = await createPlugin(ctx);
    // Worker logs arrive on stderr, one JSON line each.
    localIndexerPluginInstances.at(-1)?.opts.onWorkerStderr(
      '{"event":"indexer.file.empty","path":"C:/docs/empty.pdf","error":"empty content"}',
    );

    let status = await plugin.handlers.index_scan_status();
    expect(Array.isArray(status.warnings)).toBe(true);
    expect(status.warnings).toHaveLength(1);
    expect(status.warnings[0]).toMatchObject({
      kind: "file.empty",
      path: "C:/docs/empty.pdf",
    });

    await plugin.handlers.index_clear_warnings();
    status = await plugin.handlers.index_scan_status();
    expect(status.warnings).toEqual([]);
  });

  describe("0.8.0 index location rebuild", () => {
    async function legacyIndexFixture(): Promise<string> {
      const legacy = join(hostRoot, "index");
      await mkdir(legacy, { recursive: true });
      await writeFile(join(legacy, "fts5.sqlite"), "pre-0.8.0 index");
      mockIndexLocation = {
        indexRoot: join(hostRoot, "workers", "local-indexer-worker", "index"),
        documentCount: 0,
        inStateDirectory: true,
        legacyIndexDir: legacy,
      };
      return legacy;
    }

    /** A saved folder list, so the scan does not use the default folders. */
    async function savedFolders(): Promise<string> {
      const docs = join(hostRoot, "docs");
      await mkdir(docs, { recursive: true });
      const workspaceDir = join(hostRoot, ".local-indexer-workspace");
      await mkdir(workspaceDir, { recursive: true });
      await writeFile(join(workspaceDir, "folders.json"), JSON.stringify({ folders: [docs] }));
      return docs;
    }

    /**
     * Files on disk under `docs` that the old index held, and that the
     * mocked new index holds too (with vectors).
     */
    async function oldIndexHolds(docs: string, names = ["a.pdf", "b.md"], inNewIndex = names) {
      mockLegacyManifest = [];
      for (const name of names) {
        const path = join(docs, name);
        await writeFile(path, `# ${name}`);
        mockLegacyManifest.push({
          docId: `old-${name}`,
          path,
          mtimeMs: Math.floor((await stat(path)).mtimeMs),
          contentState: "ok",
          contentHash: null,
          hadVectors: true,
        });
      }
      mockDocuments = inNewIndex.map((name, i) => ({
        id: `d${i}`, doc_id: `d${i}`, doc_name: name, doc_type: "md", type: "md",
        path: join(docs, name), status: "indexed", content_state: "ok",
      })) as typeof mockDocuments;
    }

    const ledgerPath = () => join(hostRoot, "index-migration-attempts.json");
    const manifestPath = () => join(hostRoot, "index-migration-manifest.json");
    const manifestCopyDir = () => join(hostRoot, ".local-indexer-workspace", ".legacy-index-manifest");

    async function settledMigration(plugin: any) {
      let status: any;
      await vi.waitFor(async () => {
        status = (await plugin.handlers.index_scan_status()).indexMigration;
        expect(status?.phase).toMatch(/^(completed|kept-old)$/);
      });
      return status;
    }

    function migrationNotices(events: any[]): string[] {
      return events
        .filter(([name, payload]: [string, any]) => name === "index.warning" && payload.kind === "index-migration")
        .map(([, payload]: [string, any]) => payload.message);
    }

    it("rebuilds visibly and deletes the old index once the new one covers it", async () => {
      const legacy = await legacyIndexFixture();
      await writeFile(join(legacy, "fts5.sqlite-wal"), "un-checkpointed rows");
      await oldIndexHolds(await savedFolders());
      await writeFile(ledgerPath(), JSON.stringify({ attempts: 2, lastReason: "earlier" }));
      // The worker reads a copy in its workspace, WAL included.
      legacyIndexManifestMock.mockImplementationOnce(async (sqlitePath: string) => {
        expect(sqlitePath).toBe(join(manifestCopyDir(), "fts5.sqlite"));
        expect(await readFile(sqlitePath, "utf-8")).toBe("pre-0.8.0 index");
        expect(await readFile(`${sqlitePath}-wal`, "utf-8")).toBe("un-checkpointed rows");
        return mockLegacyManifest;
      });
      const { ctx, events } = makeContext(hostRoot, {}, { pluginDataDir: hostRoot });
      const plugin = await createPlugin(ctx);
      await plugin.onPublished?.();

      const status = await settledMigration(plugin);
      expect(status).toMatchObject({
        phase: "completed",
        legacyIndexDir: legacy,
        attempt: 3,
        documentsAfter: mockDocuments.length,
        legacyDocuments: 2,
        scan: { folderSource: "saved", registeredFolders: 1, unreadableFolders: [], failedTransient: 0 },
        coverage: { required: 2, covered: 2, missingDocuments: 0 },
      });
      expect(legacyIndexManifestMock).toHaveBeenCalledTimes(1);
      await expect(stat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(ledgerPath())).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(manifestPath())).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(manifestCopyDir())).rejects.toMatchObject({ code: "ENOENT" });
      const notices = migrationNotices(events);
      expect(notices).toHaveLength(2);
      expect(notices[0]).toMatch(/전체 재인덱싱/);
      expect(notices[1]).toMatch(/재구축 완료/);
      const migrationEvents = (ctx.hostApi.logEvent as ReturnType<typeof vi.fn>).mock.calls
        .map(([, event]: [string, string]) => event)
        .filter((event: string) => event.startsWith("local_indexer.index_migration."));
      expect(migrationEvents).toEqual([
        "local_indexer.index_migration.manifest",
        "local_indexer.index_migration.rebuilding",
        "local_indexer.index_migration.completed",
      ]);
      await plugin.stop();
    });

    it("keeps the old index, counts the attempt, and keeps the manifest, when an old document is missing", async () => {
      const legacy = await legacyIndexFixture();
      const docs = await savedFolders();
      await oldIndexHolds(docs, ["a.pdf", "b.md", "lost.md"], ["a.pdf", "b.md"]);
      const { ctx, events } = makeContext(hostRoot, {}, { pluginDataDir: hostRoot });
      const plugin = await createPlugin(ctx);
      await plugin.onPublished?.();

      const status = await settledMigration(plugin);
      expect(status).toMatchObject({ phase: "kept-old", attempt: 1, coverage: { required: 3, missingDocuments: 1 } });
      expect(status.reason).toMatch(/the new index lacks 1 document\(s\) and the vectors of 0 document\(s\)/);
      expect((await stat(join(legacy, "fts5.sqlite"))).isFile()).toBe(true);
      expect(JSON.parse(await readFile(ledgerPath(), "utf-8"))).toMatchObject({ attempts: 1 });
      expect(migrationNotices(events).at(-1)).toMatch(/이전 인덱스를 보존.*다음 시작 때 다시 시도합니다 \(1\/5\)/);
      // The manifest stays beside the old index for the next attempt.
      const saved = JSON.parse(await readFile(manifestPath(), "utf-8"));
      expect(saved).toMatchObject({ version: 2, folders: [docs] });
      expect(saved.documents.map((d: any) => d.path)).toEqual(mockLegacyManifest.map((d) => d.path));
      await expect(stat(manifestCopyDir())).rejects.toMatchObject({ code: "ENOENT" });
      await plugin.stop();

      // The next start measures against the saved manifest, without reading the old index again.
      legacyIndexManifestMock.mockClear();
      const again = makeContext(hostRoot, {}, { pluginDataDir: hostRoot });
      const plugin2 = await createPlugin(again.ctx);
      await plugin2.onPublished?.();
      expect(await settledMigration(plugin2)).toMatchObject({ phase: "kept-old", attempt: 2 });
      expect(legacyIndexManifestMock).not.toHaveBeenCalled();
      await plugin2.stop();
    });

    it("keeps the old index when the scan used the default folders (no saved folder list)", async () => {
      const legacy = await legacyIndexFixture();
      const { ctx } = makeContext(hostRoot, {}, { pluginDataDir: hostRoot });
      const plugin = await createPlugin(ctx);
      await plugin.onPublished?.();

      const status = await settledMigration(plugin);
      expect(status.phase).toBe("kept-old");
      expect(status.scan.folderSource).toBe("fallback");
      expect(status.reason).toMatch(/saved folder list was missing or unreadable/);
      expect((await stat(join(legacy, "fts5.sqlite"))).isFile()).toBe(true);
      await plugin.stop();
    });

    it("keeps the old index when a registered folder with old documents could not be read", async () => {
      const legacy = await legacyIndexFixture();
      const docs = await savedFolders();
      await oldIndexHolds(docs);
      mockUnreadableFolders = [docs];
      const { ctx } = makeContext(hostRoot, {}, { pluginDataDir: hostRoot });
      const plugin = await createPlugin(ctx);
      await plugin.onPublished?.();

      const status = await settledMigration(plugin);
      expect(status.phase).toBe("kept-old");
      expect(status.reason).toMatch(/1 folder\(s\) could not be read: .*docs/);
      expect((await stat(join(legacy, "fts5.sqlite"))).isFile()).toBe(true);
      await plugin.stop();
    });

    it("stops retrying after the bound and says so in the banner, without scanning", async () => {
      const legacy = await legacyIndexFixture();
      await writeFile(ledgerPath(), JSON.stringify({ attempts: 5, lastReason: "1 folder(s) could not be read: /x" }));
      const { ctx, events } = makeContext(hostRoot, {}, { pluginDataDir: hostRoot });
      const plugin = await createPlugin(ctx);
      await plugin.onPublished?.();

      const status = await settledMigration(plugin);
      expect(status).toMatchObject({ phase: "kept-old", retriesExhausted: true });
      expect(status.scan).toBeUndefined();
      expect(status.reason).toMatch(/stopped after 5 attempt\(s\); last reason: 1 folder\(s\) could not be read/);
      expect(migrationNotices(events).at(-1)).toMatch(/자동 재시도 5회를 모두 썼으므로/);
      expect((await stat(join(legacy, "fts5.sqlite"))).isFile()).toBe(true);
      await plugin.stop();
    });

    it("keeps the old index when a folder that held old documents now shows no files", async () => {
      const legacy = await legacyIndexFixture();
      const docs = await savedFolders();
      await oldIndexHolds(docs, ["x.md", "y.md"], []);
      await rm(join(docs, "x.md"));
      await rm(join(docs, "y.md"));
      mockWalkedByFolder = { [docs]: 0 }; // the walk lists it cleanly and finds nothing
      const { ctx } = makeContext(hostRoot, {}, { pluginDataDir: hostRoot });
      const plugin = await createPlugin(ctx);
      await plugin.onPublished?.();

      const status = await settledMigration(plugin);
      expect(status.phase).toBe("kept-old");
      expect(status.reason).toMatch(/held indexed documents now show no files .*docs/);
      expect((await stat(join(legacy, "fts5.sqlite"))).isFile()).toBe(true);
      await plugin.stop();
    });

    it("keeps the old index, and its vectors, when the rebuild could not embed (an outage)", async () => {
      const legacy = await legacyIndexFixture();
      await writeFile(join(legacy, "vectors.lance"), "old vectors");
      const docs = await savedFolders();
      await oldIndexHolds(docs);
      for (const doc of mockDocuments) (doc as any).content_state = "embed_failed";
      const { ctx } = makeContext(hostRoot, {}, {
        pluginDataDir: hostRoot,
        configValues: { apiKeySource: "host", hostApiVendor: "openai", embeddingProvider: "openai" },
      });
      ctx.hostApi.getSecret = vi.fn((key: string) => (key === "llm.apiKey.openai" ? "sk-key" : null));
      // The provider is down: a re-embed indexes the file but gets no vectors.
      reindexMock.mockImplementation(async (filePath: string) => ({
        doc_id: `doc:${filePath}`, doc_name: filePath, doc_type: "md", chunk_count: 1, status: "indexed", embedded: false,
      }) as any);
      try {
        const plugin = await createPlugin(ctx);
        await plugin.onPublished?.();
        const status = await settledMigration(plugin);
        expect(status).toMatchObject({
          phase: "kept-old",
          coverage: { required: 2, missingVectors: 2, backfill: { attempted: 2, embedded: 0 } },
        });
        expect(status.reason).toMatch(/lacks 0 document\(s\) and the vectors of 2 document\(s\)/);
        // The backfill went to the worker for exactly the documents without vectors.
        const backfilled = reindexMock.mock.calls.map((c) => c[0]).filter((p) => p.startsWith(docs));
        expect(new Set(backfilled)).toEqual(new Set(mockDocuments.map((d) => d.path)));
        expect(await readFile(join(legacy, "vectors.lance"), "utf-8")).toBe("old vectors");
        await plugin.stop();
      } finally {
        reindexMock.mockReset();
        reindexMock.mockImplementation(async (filePath: string) => ({
          doc_id: `doc:${filePath}`, doc_name: filePath, doc_type: "md", chunk_count: 1, status: "indexed", embedded: true,
        }));
      }
    });

    it("retries a copy the old index changed under, and reads the consistent one", async () => {
      const legacy = await legacyIndexFixture();
      await writeFile(join(legacy, "fts5.sqlite-wal"), "wal v1");
      await oldIndexHolds(await savedFolders());
      let torn = 0;
      copyFileHook = async (src) => {
        // A checkpoint lands after the main file was copied, once.
        if (src.endsWith("fts5.sqlite-wal") && torn === 0) {
          torn += 1;
          await writeFile(join(legacy, "fts5.sqlite-wal"), "wal v2, longer");
        }
      };
      legacyIndexManifestMock.mockImplementationOnce(async (sqlitePath: string) => {
        expect(await readFile(`${sqlitePath}-wal`, "utf-8")).toBe("wal v2, longer");
        return mockLegacyManifest;
      });
      const { ctx } = makeContext(hostRoot, {}, { pluginDataDir: hostRoot });
      const plugin = await createPlugin(ctx);
      await plugin.onPublished?.();
      expect((await settledMigration(plugin)).phase).toBe("completed");
      const events = (ctx.hostApi.logEvent as ReturnType<typeof vi.fn>).mock.calls.map(([, e]: [string, string]) => e);
      expect(events.filter((e: string) => e === "local_indexer.index_migration.copy_torn")).toHaveLength(1);
      await plugin.stop();
    });

    it("an old index that keeps changing while copied waits for the next start, without using an attempt", async () => {
      const legacy = await legacyIndexFixture();
      await writeFile(join(legacy, "fts5.sqlite-wal"), "wal");
      await oldIndexHolds(await savedFolders());
      let n = 0;
      copyFileHook = async (src) => {
        if (src.endsWith("fts5.sqlite-wal")) await writeFile(join(legacy, "fts5.sqlite-wal"), `wal ${"x".repeat(++n)}`);
      };
      const { ctx, events } = makeContext(hostRoot, {}, { pluginDataDir: hostRoot });
      const plugin = await createPlugin(ctx);
      await plugin.onPublished?.();
      const status = await settledMigration(plugin);
      expect(status).toMatchObject({ phase: "kept-old", deferred: "index-busy" });
      expect(status.reason).toMatch(/kept changing while it was copied \(3 tries\)/);
      expect(legacyIndexManifestMock).not.toHaveBeenCalled();
      await expect(stat(ledgerPath())).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(manifestPath())).rejects.toMatchObject({ code: "ENOENT" });
      expect(migrationNotices(events).at(-1)).toMatch(/자동 재시도 횟수에 넣지 않습니다/);
      expect((await stat(join(legacy, "fts5.sqlite"))).isFile()).toBe(true);
      await plugin.stop();
    });

    it("a disk without room for the copy, or one that fills up, waits with its own status", async () => {
      for (const setup of [
        () => { statfsOverride = () => ({ bavail: 10, bsize: 4096 }); },
        () => {
          copyFileHook = async () => { throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" }); };
        },
      ]) {
        const legacy = await legacyIndexFixture();
        await oldIndexHolds(await savedFolders());
        copyFileHook = null;
        statfsOverride = null;
        setup();
        const { ctx, events } = makeContext(hostRoot, {}, { pluginDataDir: hostRoot });
        const plugin = await createPlugin(ctx);
        await plugin.onPublished?.();
        const status = await settledMigration(plugin);
        expect(status).toMatchObject({ phase: "kept-old", deferred: "no-space" });
        await expect(stat(ledgerPath())).rejects.toMatchObject({ code: "ENOENT" });
        expect(migrationNotices(events).at(-1)).toMatch(/디스크 공간이 부족해/);
        expect((await stat(join(legacy, "fts5.sqlite"))).isFile()).toBe(true);
        await plugin.stop();
      }
    });

    it("keeps the old vectors when the host refuses the embedding lease (embedding state unknown)", async () => {
      const legacy = await legacyIndexFixture();
      await oldIndexHolds(await savedFolders());
      for (const doc of mockDocuments) (doc as any).content_state = "embed_failed";
      const { ctx } = makeContext(hostRoot, {}, {
        pluginDataDir: hostRoot,
        configValues: { apiKeySource: "host", hostApiVendor: "openai", embeddingProvider: "openai" },
      });
      ctx.hostApi.resolveApiKey = vi.fn(async () => ({ ok: false, reason: "busy" })) as any;
      const plugin = await createPlugin(ctx);
      await plugin.onPublished?.();
      const status = await settledMigration(plugin);
      expect(status).toMatchObject({ phase: "kept-old", coverage: { undecidedVectors: 2, missingVectors: 0 } });
      expect(status.reason).toMatch(/whether embedding is available could not be determined/);
      expect((await stat(join(legacy, "fts5.sqlite"))).isFile()).toBe(true);
      await plugin.stop();
    });

    it("waives the old vectors only when the settings turn embedding off (plugin key mode, no key)", async () => {
      const legacy = await legacyIndexFixture();
      await oldIndexHolds(await savedFolders());
      for (const doc of mockDocuments) (doc as any).content_state = "embed_failed";
      const { ctx } = makeContext(hostRoot, {}, {
        pluginDataDir: hostRoot,
        configValues: { apiKeySource: "plugin", embeddingProvider: "openai" },
      });
      ctx.hostApi.getSecret = vi.fn(async () => null) as any;
      const plugin = await createPlugin(ctx);
      await plugin.onPublished?.();
      expect(await settledMigration(plugin)).toMatchObject({ phase: "completed", coverage: { covered: 2 } });
      await expect(stat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
      await plugin.stop();

      // The same with a key store that throws: undecided, so the old index stays.
      const legacy2 = await legacyIndexFixture();
      await oldIndexHolds(await savedFolders());
      for (const doc of mockDocuments) (doc as any).content_state = "embed_failed";
      const again = makeContext(hostRoot, {}, {
        pluginDataDir: hostRoot,
        configValues: { apiKeySource: "plugin", embeddingProvider: "openai" },
      });
      again.ctx.hostApi.getSecret = vi.fn(async () => { throw new Error("keychain locked"); }) as any;
      const plugin2 = await createPlugin(again.ctx);
      await plugin2.onPublished?.();
      expect(await settledMigration(plugin2)).toMatchObject({ phase: "kept-old", coverage: { undecidedVectors: 2 } });
      expect((await stat(join(legacy2, "fts5.sqlite"))).isFile()).toBe(true);
      await plugin2.stop();
    });

    it("indexes an old document from outside the folders (a dropped file) directly, then completes", async () => {
      const legacy = await legacyIndexFixture();
      const docs = await savedFolders();
      await oldIndexHolds(docs);
      const dropped = join(hostRoot, "user-home", "Downloads", "dropped.md");
      await mkdir(dirname(dropped), { recursive: true });
      await writeFile(dropped, "# dropped");
      mockLegacyManifest.push({
        docId: "old-dropped", path: dropped, mtimeMs: Math.floor((await stat(dropped)).mtimeMs),
        contentState: "ok", contentHash: null, hadVectors: false,
      });
      indexDocumentMock.mockImplementationOnce(async (filePath: string) => {
        mockDocuments.push({
          id: "dd", doc_id: "dd", doc_name: "dropped.md", doc_type: "md", type: "md",
          path: filePath, status: "indexed", content_state: "ok",
        } as (typeof mockDocuments)[number]);
        return "dd";
      });
      const { ctx } = makeContext(hostRoot, {}, { pluginDataDir: hostRoot });
      const plugin = await createPlugin(ctx);
      await plugin.onPublished?.();
      const status = await settledMigration(plugin);
      expect(status).toMatchObject({ phase: "completed", coverage: { required: 3, covered: 3, outside: 1 } });
      expect(indexDocumentMock).toHaveBeenCalledWith(dropped);
      // Its directory was allowed for that call, as document_index_scan does.
      expect(setAllowedRootsMock.mock.calls.some(([roots]) => roots.includes(dirname(dropped)))).toBe(true);
      await expect(stat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
      await plugin.stop();
    });

    it("measures whether a folder folds case instead of assuming the platform default", async () => {
      await legacyIndexFixture();
      const docs = await savedFolders();
      await writeFile(join(docs, "Note.md"), "# note");
      const probe = await Promise.all([stat(join(docs, "Note.md")), stat(join(docs, "nOTE.MD")).catch(() => null)]);
      const foldsHere = probe[1] !== null && probe[0].ino === probe[1].ino && probe[0].dev === probe[1].dev;
      mockLegacyManifest = [{
        docId: "old-note", path: join(docs, "Note.md"), mtimeMs: Math.floor(probe[0].mtimeMs),
        contentState: "ok", contentHash: null, hadVectors: false,
      }];
      // The new index names it in another case.
      mockDocuments = [{ id: "n", doc_id: "n", doc_name: "note.md", doc_type: "md", type: "md",
        path: join(docs, "note.md"), status: "indexed", content_state: "ok" }] as typeof mockDocuments;
      const { ctx } = makeContext(hostRoot, {}, { pluginDataDir: hostRoot });
      const plugin = await createPlugin(ctx);
      await plugin.onPublished?.();
      // Folding filesystem: the same file, covered. Case-sensitive: a
      // different name, so Note.md is missing and the old index stays.
      expect((await settledMigration(plugin)).phase).toBe(foldsHere ? "completed" : "kept-old");
      await plugin.stop();
    });

    it("a case-swapped name that is a different file means the folder is case-sensitive", async () => {
      await legacyIndexFixture();
      const docs = await savedFolders();
      await writeFile(join(docs, "Note.md"), "# note");
      const st = await stat(join(docs, "Note.md"));
      // As on a case-sensitive volume holding both Note.md and nOTE.MD.
      lstatHook = (path, real) => (path.endsWith("nOTE.MD") ? { ...real, ino: Number(real.ino) + 1 } : real);
      if ((await stat(join(docs, "nOTE.MD")).catch(() => null)) === null) await writeFile(join(docs, "nOTE.MD"), "# other");
      mockLegacyManifest = [{
        docId: "old-note", path: join(docs, "Note.md"), mtimeMs: Math.floor(st.mtimeMs),
        contentState: "ok", contentHash: null, hadVectors: false,
      }];
      mockDocuments = [{ id: "n", doc_id: "n", doc_name: "note.md", doc_type: "md", type: "md",
        path: join(docs, "note.md"), status: "indexed", content_state: "ok" }] as typeof mockDocuments;
      const { ctx } = makeContext(hostRoot, {}, { pluginDataDir: hostRoot });
      const plugin = await createPlugin(ctx);
      await plugin.onPublished?.();
      expect((await settledMigration(plugin)).phase).toBe("kept-old");
      await plugin.stop();
    });

    it("keeps the old index when the old index cannot be read", async () => {
      const legacy = await legacyIndexFixture();
      await savedFolders();
      legacyIndexManifestMock.mockRejectedValueOnce(new Error("database disk image is malformed"));
      const { ctx } = makeContext(hostRoot, {}, { pluginDataDir: hostRoot });
      const plugin = await createPlugin(ctx);
      await plugin.onPublished?.();

      const status = await settledMigration(plugin);
      expect(status).toMatchObject({ phase: "kept-old", attempt: 1 });
      expect(status.reason).toMatch(/old index could not be read: database disk image is malformed/);
      expect((await stat(join(legacy, "fts5.sqlite"))).isFile()).toBe(true);
      await expect(stat(manifestCopyDir())).rejects.toMatchObject({ code: "ENOENT" });
      await plugin.stop();
    });

    it("the rebuild scan walks every registered folder, even ones whose summary reads empty", async () => {
      await legacyIndexFixture();
      const docs = await savedFolders();
      // A mixed set: docs/ holds a file (pending), mount/ is empty (summary
      // "empty"). A normal scan walks only the pending folder.
      await writeFile(join(docs, "note.md"), "# note");
      const mount = join(hostRoot, "mount");
      await mkdir(mount, { recursive: true });
      await writeFile(
        join(hostRoot, ".local-indexer-workspace", "folders.json"),
        JSON.stringify({ folders: [docs, mount] }),
      );
      const { ctx } = makeContext(hostRoot, {}, { pluginDataDir: hostRoot });
      const plugin = await createPlugin(ctx);
      await plugin.onPublished?.();
      await settledMigration(plugin);
      const targets = (ctx.hostApi.logEvent as ReturnType<typeof vi.fn>).mock.calls
        .filter(([, event]: [string, string]) => event === "index_scan.target_folders")
        .map(([, , fields]: [string, string, any]) => fields);
      expect(targets.at(0)).toMatchObject({ total: 2, pending: 1, scanning: [docs, mount] });
      await plugin.stop();
    });

    it("a manual full scan resets the attempt bound and, once retries had stopped, rebuilds again", async () => {
      const legacy = await legacyIndexFixture();
      await oldIndexHolds(await savedFolders());
      await writeFile(ledgerPath(), JSON.stringify({ attempts: 5, lastReason: "1 folder(s) could not be read: /x" }));
      const { ctx } = makeContext(hostRoot, {}, { pluginDataDir: hostRoot });
      const plugin = await createPlugin(ctx);
      await plugin.onPublished?.();
      expect((await settledMigration(plugin)).retriesExhausted).toBe(true);

      await plugin.handlers.index_scan();
      await vi.waitFor(async () => {
        expect((await plugin.handlers.index_scan_status()).indexMigration?.phase).toBe("completed");
      });
      await expect(stat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(ledgerPath())).rejects.toMatchObject({ code: "ENOENT" });
      const events = (ctx.hostApi.logEvent as ReturnType<typeof vi.fn>).mock.calls.map(([, e]: [string, string]) => e);
      expect(events).toContain("local_indexer.index_migration.manual_retry");
      // Once the old index is gone, another manual scan starts no rebuild.
      await plugin.handlers.index_scan();
      await new Promise((r) => setTimeout(r, 20));
      const after = (ctx.hostApi.logEvent as ReturnType<typeof vi.fn>).mock.calls.map(([, e]: [string, string]) => e);
      expect(after.filter((e: string) => e === "local_indexer.index_migration.rebuilding")).toHaveLength(1);
      expect(after.filter((e: string) => e === "local_indexer.index_migration.manual_retry")).toHaveLength(1);
      await plugin.stop();
    });

    it("a manual full scan starts no rebuild once the old index was removed by hand", async () => {
      const legacy = await legacyIndexFixture();
      await writeFile(ledgerPath(), JSON.stringify({ attempts: 5, lastReason: "x" }));
      const { ctx } = makeContext(hostRoot, {}, { pluginDataDir: hostRoot });
      const plugin = await createPlugin(ctx);
      await plugin.onPublished?.();
      expect((await settledMigration(plugin)).retriesExhausted).toBe(true);
      await rm(legacy, { recursive: true, force: true }); // the user followed the banner
      await plugin.handlers.index_scan();
      await new Promise((r) => setTimeout(r, 20));
      const events = (ctx.hostApi.logEvent as ReturnType<typeof vi.fn>).mock.calls.map(([, e]: [string, string]) => e);
      expect(events).toContain("local_indexer.index_migration.manual_retry");
      expect(events).not.toContain("local_indexer.index_migration.rebuilding");
      // The stale "kept the old index" status goes with it.
      expect((await plugin.handlers.index_scan_status()).indexMigration).toBeNull();
      expect(events).toContain("local_indexer.index_migration.cleared");
      await plugin.stop();
    });

    it("a manual full scan clears a partial attempt count", async () => {
      await legacyIndexFixture();
      await writeFile(ledgerPath(), JSON.stringify({ attempts: 2, lastReason: "earlier" }));
      const { ctx } = makeContext(hostRoot, {}, { pluginDataDir: hostRoot });
      const plugin = await createPlugin(ctx);
      await plugin.onPublished?.();
      await settledMigration(plugin); // fallback folders: kept-old, attempt 3
      expect(JSON.parse(await readFile(ledgerPath(), "utf-8"))).toMatchObject({ attempts: 3 });
      await plugin.handlers.index_scan();
      await expect(stat(ledgerPath())).rejects.toMatchObject({ code: "ENOENT" });
      await plugin.stop();
    });

    it("runs no rebuild when there is no old index", async () => {
      const { ctx } = makeContext(hostRoot, {}, { pluginDataDir: hostRoot });
      const plugin = await createPlugin(ctx);
      await plugin.onPublished?.();
      expect((await plugin.handlers.index_scan_status()).indexMigration).toBeNull();
      await plugin.stop();
    });
  });

  it("post-publish startup does not auto scan when the page opens", async () => {
    const { ctx, events } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    await plugin.start();
    await plugin.onPublished?.();
    await Promise.resolve();

    const progressEvents = events.filter(([type]) => type === "index.scan.progress");
    expect(progressEvents).toEqual([]);
  });

  it("index_scan emits one completion event and summary alert", async () => {
    const { ctx, events } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    await plugin.handlers.index_scan();

    const completed = events.filter(([type]) => type === "index.scan.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.[1]).toMatchObject({
      title: "Local Indexer",
      status: "done",
      processed: 2,
      total: 2,
    });
    await vi.waitFor(() => expect(ctx.hostApi.raiseAlert).toHaveBeenCalledTimes(1));
    expect(ctx.hostApi.raiseAlert).toHaveBeenCalledWith({
      kind: "index-scan-completed",
      key: expect.any(String),
    });
  });

  it("index_scan_cancel reports no active scan when idle", async () => {
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    const res = await plugin.handlers.index_scan_cancel();
    expect(res.canceled).toBe(false);
  });

  it("index_documents deduplicates by path", async () => {
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    const res = await plugin.handlers.index_documents();
    expect(Array.isArray(res.documents)).toBe(true);
    expect(res.total).toBe(2);
    expect(res.hasMore).toBe(false);
    expect(res.documents.length).toBe(2);
    const ids = res.documents.map((doc) => doc.doc_id).sort();
    expect(ids).toEqual(["d1", "d2"]);
  });

  it("index_documents hides documents that are not fully indexed", async () => {
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);
    mockDocuments = [
      { id: "d1", doc_id: "d1", doc_name: "ok.pdf", doc_type: "pdf", type: "pdf", path: "/tmp/ok.pdf", status: "indexed" },
      { id: "d2", doc_id: "d2", doc_name: "failed.pdf", doc_type: "pdf", type: "pdf", path: "/tmp/failed.pdf", status: "failed" },
      { id: "d3", doc_id: "d3", doc_name: "pending.pdf", doc_type: "pdf", type: "pdf", path: "/tmp/pending.pdf", status: "processing" },
    ];

    const res = await plugin.handlers.index_documents();

    expect(res.total).toBe(1);
    expect(res.documents).toHaveLength(1);
    expect(res.documents[0]).toMatchObject({ doc_id: "d1" });
  });

  it("index_documents falls back to persisted index state when the worker returns no documents", async () => {
    const { ctx, logs } = makeContext(hostRoot);
    const workspace = join(hostRoot, ".local-indexer-workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, "index-state.json"),
      JSON.stringify({
        version: 1,
        entries: {
          [join(hostRoot, "a.pdf")]: {
            docId: "fallback-1",
            mtimeMs: 1710000000000,
            chunkHash: "mtime-only",
            indexedAt: new Date().toISOString(),
          },
        },
      }),
      "utf-8",
    );
    const plugin = await createPlugin(ctx);
    mockDocuments = [];

    const res = await plugin.handlers.index_documents();

    // Global IndexState (~/.ave/local-indexer/index-state.json) may have real entries
    // on the developer's machine — only assert that the workspace fallback entry is present.
    expect(res.documents.some((d) => d.doc_id === "fallback-1")).toBe(true);
    expect(res.documents.find((d) => d.doc_id === "fallback-1")).toMatchObject({
      doc_id: "fallback-1",
      doc_name: "a.pdf",
      status: "indexed",
    });
    expect(logs.some(([msg]) => msg === "warn:index_documents.fallback_to_indexer_state")).toBe(true);
  });

  it("index_folders falls back to configured scan folders", async () => {
    const { ctx } = makeContext(hostRoot, { scanFolders: ["docs"] });
    const plugin = await createPlugin(ctx);

    const res = await plugin.handlers.index_folders();
    expect(res.folders.length).toBe(1);
    expect(res.folders[0]).toContain("docs");
    expect(Array.isArray(res.summaries)).toBe(true);
  });

  it("index_scan({folder}) only reindexes stale or new files", async () => {
    const workspace = join(hostRoot, ".local-indexer-workspace");
    const folder = join(hostRoot, "refresh-target");
    await mkdir(workspace, { recursive: true });
    await mkdir(folder, { recursive: true });
    const sameFile = join(folder, "same.pdf");
    const staleFile = join(folder, "stale.pdf");
    const newFile = join(folder, "new.pdf");
    await writeFile(sameFile, "same", "utf-8");
    await writeFile(staleFile, "stale-2", "utf-8");
    await writeFile(newFile, "new", "utf-8");
    await writeFile(join(workspace, "folders.json"), JSON.stringify({ folders: [folder] }), "utf-8");

    const sameStats = await stat(sameFile);
    const staleStats = await stat(staleFile);
    await writeFile(
      join(workspace, "index-state.json"),
      JSON.stringify({
        version: 1,
        entries: {
          [sameFile]: {
            docId: "doc-same",
            mtimeMs: sameStats.mtimeMs,
            chunkHash: "mtime-only",
            indexedAt: new Date().toISOString(),
          },
          [staleFile]: {
            docId: "doc-stale",
            mtimeMs: staleStats.mtimeMs - 1000,
            chunkHash: "mtime-only",
            indexedAt: new Date().toISOString(),
          },
        },
      }),
      "utf-8",
    );

    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);
    const res = await plugin.handlers.index_scan({ folder });

    expect(indexDocumentMock).toHaveBeenCalledTimes(2);
    const indexedPaths = indexDocumentMock.mock.calls.map((call) => call[0]).sort();
    expect(indexedPaths).toEqual([newFile, staleFile].sort());
    expect(res.indexed).toBe(2);
    expect(res.summary).toMatchObject({
      folder,
      status: "indexed",
      totalFiles: 3,
      indexedFiles: 3,
      pendingFiles: 0,
    });
  });

  it("index_folders add blocks sensitive paths", async () => {
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);
    const target = process.platform === "win32" ? "C:\\Windows" : "/etc";
    await expect(
      plugin.handlers.index_folders({ action: "add", folder: target }),
    ).rejects.toThrow();
  });

  it("index_folders add requires a folder path", async () => {
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);
    await expect(plugin.handlers.index_folders({ action: "add" })).rejects.toThrow(/folder/);
  });

  it("index_folders add/remove persist and emit folder change events", async () => {
    const { ctx, events } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    const safeBase = join(fixtureUserHome(hostRoot), ".ave-test-tmp");
    await mkdir(safeBase, { recursive: true });
    const safeDir = await mkdtemp(join(safeBase, "hp-safe-"));
    try {
      const addRes = await plugin.handlers.index_folders({ action: "add", folder: safeDir });
      expect(addRes.added).toBe(true);
      expect(addRes.folders).toContain(safeDir);

      const saved = JSON.parse(
        await readFile(
          join(hostRoot, "plugin-data", ".local-indexer-workspace", "folders.json"),
          "utf-8",
        ),
      );
      expect(saved.folders).toContain(safeDir);

      const dup = await plugin.handlers.index_folders({ action: "add", folder: safeDir });
      expect(dup.added).toBe(false);

      mockDocuments = [
        { id: "d-in", doc_id: "d-in", doc_name: "inside.pdf", doc_type: "pdf", type: "pdf", path: join(safeDir, "inside.pdf") },
        { id: "d-out", doc_id: "d-out", doc_name: "outside.pdf", doc_type: "pdf", type: "pdf", path: join(hostRoot, "outside.pdf") },
      ];
      const rmRes = await plugin.handlers.index_folders({ action: "remove", folder: safeDir });
      expect(rmRes.removed).toBe(true);
      expect(rmRes.folders).not.toContain(safeDir);
      expect(rmRes.removedDocuments).toBe(1);
      expect(removeDocumentMock).toHaveBeenCalledWith("d-in");
      expect(removeDocumentMock).not.toHaveBeenCalledWith("d-out");

      const rm2 = await plugin.handlers.index_folders({ action: "remove", folder: safeDir });
      expect(rm2.removed).toBe(false);

      const changed = events.filter(([type]) => type === "index.folders.changed");
      expect(changed.length).toBeGreaterThanOrEqual(2);
      await vi.waitFor(() => expect(ctx.hostApi.raiseAlert).toHaveBeenCalledTimes(2));
      expect(ctx.hostApi.raiseAlert.mock.calls.map(([alert]) => alert.kind)).toEqual([
        "index-folders-changed",
        "index-folders-changed",
      ]);
      for (const [alert] of ctx.hostApi.raiseAlert.mock.calls) {
        expect(alert.key).toMatch(/^[0-9a-f-]{36}$/);
        expect(JSON.stringify(alert)).not.toContain(safeDir);
      }
      expect(changed[0]?.[1]).toMatchObject({
        folder: safeDir,
        message: `폴더 추가: ${safeDir}`,
      });
      expect(changed.at(-1)?.[1]).toMatchObject({
        folder: safeDir,
      });
      expect(String(changed.at(-1)?.[1]?.message ?? "")).toContain("문서 1개 삭제");
    } finally {
      await rm(safeDir, { recursive: true, force: true });
    }
  });

  it("restarts the worker when the started flag is stale but the process is gone", async () => {
    const { ctx, logs } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    await plugin.onPublished?.();
    expect(localIndexerStartMock).toHaveBeenCalledTimes(1);

    localIndexerPluginInstances[0].started = false;

    await plugin.handlers.index_scan_status();

    expect(localIndexerStartMock).toHaveBeenCalledTimes(2);
    expect(logs).toContainEqual([
      "warn:local_indexer.worker_restart_required",
      { reason: "started flag set but worker process is not running" },
    ]);
  });

  it("shows image-only folders as images_disabled while image captioning is off", async () => {
    const safeBase = join(fixtureUserHome(hostRoot), ".ave-test-tmp");
    await mkdir(safeBase, { recursive: true });
    const folder = await mkdtemp(join(safeBase, "hp-image-only-"));
    try {
      await writeFile(join(folder, "photo.png"), "png", "utf-8");

      const { ctx } = makeContext(hostRoot);
      const plugin = await createPlugin(ctx);

      const added = await plugin.handlers.index_folders({ action: "add", folder });
      expect(added.summary).toMatchObject({
        folder,
        status: "images_disabled",
        totalFiles: 1,
        indexedFiles: 0,
        pendingFiles: 0,
      });

      const listed = await plugin.handlers.index_folders();
      expect(listed.summaries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            folder,
            status: "images_disabled",
            totalFiles: 1,
            indexedFiles: 0,
            pendingFiles: 0,
          }),
        ]),
      );
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  // index_search{mode:bm25} reproduces the former chat_preview behavior verbatim
  // (BM25 keyword screen + human-readable preview formatting). The dispatcher
  // maps query→question and routes to the reused chat_preview body.
  it("index_search bm25 returns an empty prompt hint for blank queries", async () => {
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    const res = await plugin.handlers.index_search({ query: "   ", mode: "bm25" });
    expect(res.preview).toBe("질문을 입력해주세요.");
    expect(res.results).toEqual([]);
  });

  it("index_search bm25 reproduces chat_preview: maps BM25 hits + preview formatting", async () => {
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    const res = await plugin.handlers.index_search({ query: "??", mode: "bm25" });
    // chat_preview shape — preview string + documentCount + results, NOT hits[]
    expect(res.documentCount).toBe(1);
    expect(res.results?.[0]).toMatchObject({ docId: "d1", docName: "a.pdf", page: 1 });
    expect(res.preview).toContain("a.pdf");
    expect(res.hits).toBeUndefined();
    expect(searchBm25Mock).toHaveBeenCalledWith("??", 5);
  });

  it("loads persisted folders from folders.json during plugin creation", async () => {
    const workspace = join(hostRoot, ".local-indexer-workspace");
    await mkdir(workspace, { recursive: true });
    const persisted = join(tmpdir(), `ave-hp-persisted-${Date.now()}`);
    await writeFile(join(workspace, "folders.json"), JSON.stringify({ folders: [persisted] }), "utf-8");

    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    const res = await plugin.handlers.index_folders();
    expect(res.folders).toContain(persisted);
  });

  it("index_search returns empty result for blank query without calling worker", async () => {
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    const res = await plugin.handlers.index_search({ query: "   " });
    // topK 는 스키마 (1~50) 에 맞게 default(10) 또는 호출자가 보낸 clamped 값을 유지.
    expect(res).toEqual({ query: "", mode: "hybrid", topK: 10, hits: [] });
    expect(searchBm25Mock).not.toHaveBeenCalled();
    expect(searchVectorMock).not.toHaveBeenCalled();
    expect(searchHybridMock).not.toHaveBeenCalled();
  });

  it("index_search keeps caller-provided clamped topK for blank query", async () => {
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    // 명시적 topK가 들어와도 스키마 범위(1~50)로 clamp된 값을 응답에 그대로 노출.
    const res = await plugin.handlers.index_search({ query: "   ", topK: 100, mode: "vector" });
    expect(res).toEqual({ query: "", mode: "vector", topK: 50, hits: [] });
  });

  it("index_search routes to the correct worker method per mode", async () => {
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    await plugin.handlers.index_search({ query: "hi", mode: "bm25" });
    expect(searchBm25Mock).toHaveBeenCalledTimes(1);
    expect(searchVectorMock).not.toHaveBeenCalled();
    expect(searchHybridMock).not.toHaveBeenCalled();

    await plugin.handlers.index_search({ query: "hi", mode: "vector" });
    expect(searchVectorMock).toHaveBeenCalledTimes(1);

    await plugin.handlers.index_search({ query: "hi", mode: "hybrid" });
    expect(searchHybridMock).toHaveBeenCalledTimes(1);

    // 알 수 없는 mode → hybrid 로 fallback
    searchHybridMock.mockClear();
    await plugin.handlers.index_search({ query: "hi", mode: "unknown" });
    expect(searchHybridMock).toHaveBeenCalledTimes(1);
  });

  it("index_search clamps topK to [1,50]", async () => {
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    // topK clamping lives on the vector/hybrid hit path (runIndexSearch);
    // bm25 mode now folds into chat_preview which ignores topK (fixed 5).
    const r1 = await plugin.handlers.index_search({ query: "hi", mode: "vector", topK: 100 });
    expect(searchVectorMock).toHaveBeenLastCalledWith("hi", 50);
    expect(r1.topK).toBe(50);

    const r2 = await plugin.handlers.index_search({ query: "hi", mode: "vector", topK: 0 });
    expect(searchVectorMock).toHaveBeenLastCalledWith("hi", 1);
    expect(r2.topK).toBe(1);

    const r3 = await plugin.handlers.index_search({ query: "hi", mode: "vector", topK: -5 });
    expect(searchVectorMock).toHaveBeenLastCalledWith("hi", 1);
    expect(r3.topK).toBe(1);
  });

  it("index_search maps hit fields and normalizes source labels", async () => {
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    // vector 모드 → worker source 'vec' 가 'vector' 로 정규화되고 snippet 은 500자 cap
    const vectorRes = await plugin.handlers.index_search({ query: "q", mode: "vector" });
    expect(vectorRes.hits).toHaveLength(1);
    expect(vectorRes.hits[0]).toMatchObject({
      chunkId: "c2",
      docId: "d2",
      docName: "b.md",
      page: 3,
      score: 0.8,
      source: "vector",
      path: "/tmp/b.md",
    });
    expect(vectorRes.hits[0].rawText.length).toBe(600);
    expect(vectorRes.hits[0].snippet.length).toBe(500);

    // hybrid 모드 → worker source 'hybrid' 가 'hybrid' 로 정규화
    const hybridRes = await plugin.handlers.index_search({ query: "q", mode: "hybrid" });
    expect(hybridRes.hits[0].source).toBe("hybrid");
    // bm25 모드는 chat_preview 미리보기 경로로 분기 (hits[] 대신 preview shape) —
    // parity 는 별도 "index_search bm25 reproduces chat_preview" 테스트가 검증.
  });

  // ── Consolidated 12→6 dispatch matrix (presence/discriminator routing) ──
  // {} → full scan (this test); {folder} → refresh (see "index_scan({folder})
  // only reindexes stale or new files"); {paths} → ad-hoc indexing (see the
  // "index_scan{paths} dispatch" suite in documentIndexScan.test.ts).
  it("index_scan dispatch: {} routes to the full-scan body (not refresh/ad-hoc)", async () => {
    const { ctx } = makeContext(hostRoot, { scanFolders: ["docs"] });
    const plugin = await createPlugin(ctx);
    const full = await plugin.handlers.index_scan();
    // scanOnce mock returns indexed:2 / totalIndexed:5 — proves the full-scan body ran.
    expect(full).toMatchObject({ indexed: 2, totalIndexed: 5 });
    // full scan returns no jobId (the ad-hoc {paths} body does) and never
    // touches per-file indexDocument (the {folder} refresh body does).
    expect(full).not.toHaveProperty("jobId");
    expect(indexDocumentMock).not.toHaveBeenCalled();
  });

  it("index_folders dispatch: default lists, unknown action throws", async () => {
    const { ctx } = makeContext(hostRoot, { scanFolders: ["docs"] });
    const plugin = await createPlugin(ctx);

    // no action → list (former no-arg index_folders)
    const listed = await plugin.handlers.index_folders();
    expect(Array.isArray(listed.folders)).toBe(true);
    expect(Array.isArray(listed.summaries)).toBe(true);

    // explicit list action → same listing shape
    const listed2 = await plugin.handlers.index_folders({ action: "list" });
    expect(Array.isArray(listed2.folders)).toBe(true);

    // remove on an unregistered folder → removed:false (former index_remove_folder body)
    const rm = await plugin.handlers.index_folders({
      action: "remove",
      folder: join(hostRoot, "not-registered"),
    });
    expect(rm.removed).toBe(false);

    // unknown action → hard error (no silent fallback)
    await expect(
      plugin.handlers.index_folders({ action: "frobnicate" }),
    ).rejects.toThrow(/unknown action/);
  });

  it("index_get_document throws when docId is missing or blank", async () => {
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    await expect(plugin.handlers.index_get_document({})).rejects.toThrow(/docId.*required/);
    await expect(plugin.handlers.index_get_document({ docId: "   " })).rejects.toThrow(/docId.*required/);
    expect(getDocumentMock).not.toHaveBeenCalled();
  });

  it("index_get_document fetches given pages via worker", async () => {
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    const res = await plugin.handlers.index_get_document({ docId: "d1", pages: "1-3" });
    expect(getDocumentMock).toHaveBeenCalledWith("d1");
    expect(getPageContentMock).toHaveBeenCalledWith("d1", "1-3");
    expect(res.doc).toMatchObject({
      docId: "d1",
      docName: "a.pdf",
      type: "pdf",
      path: "/tmp/a.pdf",
      pageCount: 4,
      lineCount: 100,
      indexedAt: "2025-01-01T00:00:00Z",
      status: "indexed",
    });
    expect(res.pages).toHaveLength(2);
  });

  it("index_get_document caps full-content fetch at 50 pages when includeContent=true", async () => {
    mockDocumentRow = { ...mockDocumentRow, page_count: 200 };
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    await plugin.handlers.index_get_document({ docId: "d1", includeContent: true });
    expect(getPageContentMock).toHaveBeenCalledWith("d1", "1-50");
  });

  it("index_get_document does not fetch pages when includeContent omitted and no pages range", async () => {
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    const res = await plugin.handlers.index_get_document({ docId: "d1" });
    expect(getPageContentMock).not.toHaveBeenCalled();
    expect(res.pages).toEqual([]);
    expect(res).not.toHaveProperty("structure");
  });

  it("index_get_document returns the indexed page inventory when includeStructure=true", async () => {
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    const res = await plugin.handlers.index_get_document({ docId: "d1", includeStructure: true });
    expect(getStructureMock).toHaveBeenCalledWith("d1");
    // 본문은 따로 요청하지 않는 한 딸려오지 않는다 — 구조는 읽을 범위를
    // 고르기 위한 것이므로 페이로드가 커지면 안 된다.
    expect(getPageContentMock).not.toHaveBeenCalled();
    expect(res.pages).toEqual([]);
    expect(res.structure).toEqual({
      doc_id: "d1",
      doc_name: "a.pdf",
      doc_type: "pdf",
      page_count: 4,
      line_count: 100,
      pages: [1, 2, 4],
    });
  });

  it("index_get_document surfaces a worker structure failure", async () => {
    getStructureMock.mockRejectedValueOnce(new Error("worker offline"));
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    await expect(
      plugin.handlers.index_get_document({ docId: "d1", includeStructure: true }),
    ).rejects.toThrow(/구조 조회 실패 \(d1\): worker offline/);
  });

  it("keeps an explicit empty folders.json instead of falling back to fixtures", async () => {
    const workspace = join(hostRoot, ".local-indexer-workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "folders.json"), JSON.stringify({ folders: [] }), "utf-8");

    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    const res = await plugin.handlers.index_folders();
    expect(res.folders).toEqual([]);
    expect(res.summaries).toEqual([]);
  });

  it("index_pick_folder returns the folders the host says the user named", async () => {
    pickFoldersMock.mockResolvedValueOnce({
      canceled: false,
      folders: ["/picked/one", "/picked/two"],
    });
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    const res = await plugin.handlers.index_pick_folder();
    expect(pickFoldersMock).toHaveBeenCalledTimes(1);
    // 인자 없이 부른다 — 제목도, 창도, 다중선택 여부도 호스트가 정한다.
    // 플러그인이 제목을 넘길 수 있었다면 그 제목이 곧 사칭 수단이 된다.
    expect(pickFoldersMock).toHaveBeenCalledWith();
    expect(res).toEqual({ folders: ["/picked/one", "/picked/two"], canceled: false });
  });

  it("index_pick_folder reports canceled selection", async () => {
    pickFoldersMock.mockResolvedValueOnce({ canceled: true, folders: [] });
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    const res = await plugin.handlers.index_pick_folder();
    expect(res).toEqual({ folders: [], canceled: true });
  });

  it("index_pick_folder reads an empty selection as canceled", async () => {
    // 호스트도 같은 판단을 하지만, 그 판단을 여기서도 고정해 둔다: 두 답이
    // 갈라지면 사용자가 아무것도 고르지 않았는데 빈 배열을 "선택함" 으로
    // 처리하는 경로가 생긴다.
    pickFoldersMock.mockResolvedValueOnce({ canceled: false, folders: [] });
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    const res = await plugin.handlers.index_pick_folder();
    expect(res).toEqual({ folders: [], canceled: true });
  });

  it("index_preview_folder aggregates indexable files by extension", async () => {
    const folder = join(hostRoot, "preview-target");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "a.pdf"), "x", "utf-8");
    await writeFile(join(folder, "b.pdf"), "y", "utf-8");
    await writeFile(join(folder, "c.md"), "# hi", "utf-8");

    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    const res = await plugin.handlers.index_preview_folder({ folder });
    expect(res.folder).toBe(folder);
    expect(res.total).toBe(3);
    expect(res.byType).toMatchObject({ pdf: 2, md: 1 });
    expect(Array.isArray(res.sample)).toBe(true);
    expect(res.sample.length).toBeGreaterThan(0);
    expect(res.error).toBeUndefined();
  });

  it("index_preview_folder rejects missing/non-string folder argument", async () => {
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    await expect(plugin.handlers.index_preview_folder({})).rejects.toThrow(/folder/);
    await expect(plugin.handlers.index_preview_folder({ folder: 123 })).rejects.toThrow(/folder/);
  });

  it("index_preview_folder returns error field for blocked sensitive paths", async () => {
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);
    const target = process.platform === "win32" ? "C:\\Windows" : "/etc";

    const res = await plugin.handlers.index_preview_folder({ folder: target });
    expect(res.total).toBe(0);
    expect(typeof res.error).toBe("string");
    expect(res.error?.length).toBeGreaterThan(0);
  });

  it("index_preview_folder returns error when path is a file, not a directory", async () => {
    const filePath = join(hostRoot, "not-a-folder.pdf");
    await writeFile(filePath, "x", "utf-8");

    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    const res = await plugin.handlers.index_preview_folder({ folder: filePath });
    expect(res.total).toBe(0);
    expect(res.error).toBe("폴더가 아닙니다.");
  });

  it("index_folders add (batch) rejects empty/invalid input", async () => {
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    await expect(
      plugin.handlers.index_folders({ action: "add" }),
    ).rejects.toThrow(/folder/);
    await expect(
      plugin.handlers.index_folders({ action: "add", folders: [] }),
    ).rejects.toThrow(/folders/);
    await expect(
      plugin.handlers.index_folders({ action: "add", folders: [123, null, ""] }),
    ).rejects.toThrow(/유효한 경로/);
  });

  it("index_folders add (batch) splits results into added/skipped/failures and emits one event", async () => {
    const { ctx, events } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);

    const safeBase = join(fixtureUserHome(hostRoot), ".ave-test-tmp");
    await mkdir(safeBase, { recursive: true });
    const safeA = await mkdtemp(join(safeBase, "hp-bulk-a-"));
    const safeB = await mkdtemp(join(safeBase, "hp-bulk-b-"));
    const blocked = process.platform === "win32" ? "C:\\Windows" : "/etc";

    try {
      // 첫 번째: safeA만 미리 등록 → 두 번째 호출에서 skipped로 분류돼야 함.
      await plugin.handlers.index_folders({ action: "add", folder: safeA });
      events.length = 0;

      const res = await plugin.handlers.index_folders({
        action: "add",
        folders: [safeA, safeB, blocked],
      });

      expect(res.added).toEqual([safeB]);
      expect(res.skipped.map((s: { folder: string }) => s.folder)).toEqual([safeA]);
      expect(res.failures.map((f: { folder: string }) => f.folder)).toEqual([blocked]);
      expect(res.folders).toContain(safeA);
      expect(res.folders).toContain(safeB);

      const changed = events.filter(([type]) => type === "index.folders.changed");
      // 단일 rebuild → 단일 이벤트
      expect(changed).toHaveLength(1);
      expect(changed[0]?.[1]).toMatchObject({
        added: [safeB],
        message: "폴더 1개 추가",
      });
    } finally {
      await rm(safeA, { recursive: true, force: true });
      await rm(safeB, { recursive: true, force: true });
    }
  });

  // F2: Windows device-namespace, UNC, NUL 바이트 거부 — isBlockedIndexPath
  // 가 정규화된 prefix 검사를 우회당하지 않게 하는 회귀 테스트.
  it.runIf(process.platform === "win32")(
    "index_preview_folder rejects Windows device-namespace path (\\\\?\\)",
    async () => {
      const { ctx } = makeContext(hostRoot);
      const plugin = await createPlugin(ctx);
      const res = await plugin.handlers.index_preview_folder({
        folder: "\\\\?\\C:\\Windows",
      });
      expect(res.total).toBe(0);
      expect(typeof res.error).toBe("string");
      expect(res.error?.length).toBeGreaterThan(0);
    },
  );

  it.runIf(process.platform === "win32")(
    "index_preview_folder rejects UNC root (\\\\server\\share)",
    async () => {
      const { ctx } = makeContext(hostRoot);
      const plugin = await createPlugin(ctx);
      const res = await plugin.handlers.index_preview_folder({
        folder: "\\\\attacker\\share",
      });
      expect(res.total).toBe(0);
      expect(typeof res.error).toBe("string");
    },
  );

  it("index_preview_folder rejects path containing NUL byte", async () => {
    const { ctx } = makeContext(hostRoot);
    const plugin = await createPlugin(ctx);
    // NUL 바이트는 모든 OS 에서 거부 — 일부 fs 호출이 truncate 시켜 검증을
    // 우회당할 수 있어 platform 분기 없이 차단해야 한다.
    const target = process.platform === "win32" ? "C:\\foo\0bar" : "/tmp/foo\0bar";
    const res = await plugin.handlers.index_preview_folder({ folder: target });
    expect(res.total).toBe(0);
    expect(typeof res.error).toBe("string");
    expect(res.error?.length).toBeGreaterThan(0);
  });

  it.runIf(process.platform === "win32")(
    "index_folders add reports Windows device-namespace path in failures",
    async () => {
      const { ctx } = makeContext(hostRoot);
      const plugin = await createPlugin(ctx);
      const target = "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1";
      const res = await plugin.handlers.index_folders({
        action: "add",
        folders: [target],
      });
      expect(res.added).toEqual([]);
      expect(res.failures.map((f: { folder: string }) => f.folder)).toContain(
        target,
      );
    },
  );

  // ─── Image-embedding handler tests ────────────────────────────────
  // Cover the three contract surfaces flagged in the code review:
  //   - index_set_image_embedding round-trip (sidecar write + worker push)
  //   - index_get_settings live-reads the host secret (rotation works)
  //   - sidecar survives a re-construct (cache populates from disk)

  it("index_set_image_embedding writes sidecar and pushes to worker", async () => {
    const { ctx } = makeContext(hostRoot, {}, { pluginDataDir: hostRoot });
    const plugin = await createPlugin(ctx);

    // The handler only accepts `enabled` now — provider / endpoint /
    // model / apiKey are owned by host config + secret store. Anything
    // else on the payload is intentionally ignored.
    const res = await plugin.handlers.index_set_image_embedding({
      enabled: true,
      mode: "cloud",
    });

    expect(res.imageEmbeddingEnabled).toBe(true);
    expect(res.imageCaptionMode).toBe("cloud");
    // Provider is read from host config; with no override wired in this
    // ctx the configSchema default ("openai") is returned.
    expect(res.imageCaptionProvider).toBe("openai");

    // Sidecar is toggle-only now — it no longer carries provider/model.
    const sidecarPath = join(hostRoot, "image-embedding-settings.json");
    const onDisk = JSON.parse(await readFile(sidecarPath, "utf-8"));
    expect(onDisk.imageEmbeddingEnabled).toBe(true);
    expect(onDisk.imageCaptionMode).toBe("cloud");

    // Worker received the new state (host kicks ensureStarted on the
    // handler, so setImageCaptioning is forwarded after spawn). At least
    // one call carrying our enabled+provider must be observed.
    const callArgs = setImageCaptioningMock.mock.calls.map(
      (call: unknown[]) => ({
        enabled: call[0],
        provider: call[1],
      }),
    );
    expect(callArgs).toContainEqual({ enabled: true, provider: "openai" });
  });

  it("index_set_image_embedding ignores legacy local mode and keeps the configured cloud provider", async () => {
    const { ctx } = makeContext(hostRoot, {}, {
      pluginDataDir: hostRoot,
      configValues: {
        apiKeySource: "plugin",
        imageCaptionProvider: "azure-openai-chat",
      },
    });
    const plugin = await createPlugin(ctx);

    const res = await plugin.handlers.index_set_image_embedding({
      enabled: true,
      mode: "local",
    });

    expect(res.imageEmbeddingEnabled).toBe(true);
    expect(res.imageCaptionMode).toBe("cloud");
    expect(res.imageCaptionProvider).toBe("azure-openai-chat");
    expect(setImageCaptioningMock).toHaveBeenLastCalledWith(
      true,
      "azure-openai-chat",
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });

  it("index_set_image_embedding cloud mode keeps the configured azure provider", async () => {
    const { ctx } = makeContext(hostRoot, {}, {
      pluginDataDir: hostRoot,
      configValues: {
        apiKeySource: "plugin",
        imageCaptionProvider: "azure-openai-chat",
      },
    });
    const plugin = await createPlugin(ctx);

    const res = await plugin.handlers.index_set_image_embedding({
      enabled: true,
      mode: "cloud",
    });

    expect(res.imageEmbeddingEnabled).toBe(true);
    expect(res.imageCaptionMode).toBe("cloud");
    expect(res.imageCaptionProvider).toBe("azure-openai-chat");
    expect(setImageCaptioningMock).toHaveBeenLastCalledWith(
      true,
      "azure-openai-chat",
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });

  it("index_set_image_embedding cloud mode keeps the configured azure responses provider", async () => {
    const { ctx } = makeContext(hostRoot, {}, {
      pluginDataDir: hostRoot,
      configValues: {
        apiKeySource: "plugin",
        imageCaptionProvider: "azure-openai-responses",
      },
    });
    const plugin = await createPlugin(ctx);

    const res = await plugin.handlers.index_set_image_embedding({
      enabled: true,
      mode: "cloud",
    });

    expect(res.imageEmbeddingEnabled).toBe(true);
    expect(res.imageCaptionMode).toBe("cloud");
    expect(res.imageCaptionProvider).toBe("azure-openai-responses");
    expect(setImageCaptioningMock).toHaveBeenLastCalledWith(
      true,
      "azure-openai-responses",
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });

  it("index_set_image_embedding derives azure chat caption config from the host SDK baseUrl", async () => {
    const { ctx } = makeContext(hostRoot, {}, {
      pluginDataDir: hostRoot,
      configValues: {
        apiKeySource: "host",
        hostApiVendor: "azure-openai",
      },
    });
    ctx.hostApi.resolveApiKey = vi.fn(async () => ({
      ok: true,
      vendor: "azure-openai",
      exposure: "lease", leaseId: "lease-test", onClosed: () => () => {},
      baseUrl:
        "https://sdk-base.openai.azure.com/openai/deployments/gpt-5.4-mini/chat/completions?api-version=2025-01-01-preview",
      release: async () => {},
    }));
    const plugin = await createPlugin(ctx);

    const res = await plugin.handlers.index_set_image_embedding({
      enabled: true,
      mode: "cloud",
    });

    expect(res.imageCaptionProvider).toBe("azure-openai-chat");
    expect(res.imageCaptionEndpoint).toBe("https://sdk-base.openai.azure.com/");
    expect(res.imageCaptionApiVersion).toBe("2025-01-01-preview");
    expect(setImageCaptioningMock).toHaveBeenLastCalledWith(
      true,
      "azure-openai-chat",
      "gpt-5.4-mini",
      "https://sdk-base.openai.azure.com/",
      "2025-01-01-preview",
    );
  });

  it("a push with no host key handle keeps the worker's azure model/endpoint (null, not reset)", async () => {
    const { ctx } = makeContext(hostRoot, {}, {
      pluginDataDir: hostRoot,
      configValues: {
        apiKeySource: "host",
        hostApiVendor: "azure-openai",
      },
    });
    // resolveApiKey refuses transiently: nothing to derive the deployment
    // name, resource endpoint, or api-version from. The worker contract
    // reads "" as "reset to the provider default", so the host must send
    // null ("keep") for each derived field rather than wipe the values the
    // worker already holds.
    ctx.hostApi.resolveApiKey = vi.fn(async () => ({
      ok: false,
      reason: "busy",
    }));
    const plugin = await createPlugin(ctx);

    const res = await plugin.handlers.index_set_image_embedding({
      enabled: true,
      mode: "cloud",
    });

    expect(res.imageCaptionProvider).toBe("azure-openai-chat");
    expect(setImageCaptioningMock).toHaveBeenLastCalledWith(
      true,
      "azure-openai-chat",
      null,
      null,
      null,
    );
  });

  it("an explicitly empty imageCaptionModel still resets when nothing is derived", async () => {
    const { ctx } = makeContext(hostRoot, {}, {
      pluginDataDir: hostRoot,
      configValues: {
        apiKeySource: "plugin",
        imageCaptionProvider: "azure-openai-chat",
        imageCaptionModel: "",
        imageCaptionEndpoint: "",
      },
    });
    const plugin = await createPlugin(ctx);

    await plugin.handlers.index_set_image_embedding({ enabled: true, mode: "cloud" });

    // Plugin key: no host handle is ever consulted, so an empty config value
    // is the user's choice — "" goes to the worker and resets the field.
    expect(setImageCaptioningMock).toHaveBeenLastCalledWith(
      true,
      "azure-openai-chat",
      "",
      "",
      "",
    );
  });

  it("host azure caption settings override a configured openai caption provider", async () => {
    const { ctx } = makeContext(hostRoot, {}, {
      pluginDataDir: hostRoot,
      configValues: {
        apiKeySource: "host",
        hostApiVendor: "azure-openai",
        imageCaptionProvider: "openai",
      },
    });
    ctx.hostApi.resolveApiKey = vi.fn(async () => ({
      ok: true,
      vendor: "azure-openai",
      exposure: "lease", leaseId: "lease-test", onClosed: () => () => {},
      baseUrl:
        "https://sdk-base.openai.azure.com/openai/deployments/gpt-5.4-mini/chat/completions?api-version=2025-01-01-preview",
      release: async () => {},
    }));
    const plugin = await createPlugin(ctx);

    const res = await plugin.handlers.index_set_image_embedding({
      enabled: true,
      mode: "cloud",
    });

    expect(res.imageCaptionProvider).toBe("azure-openai-chat");
    expect(res.imageCaptionEndpoint).toBe("https://sdk-base.openai.azure.com/");
    expect(setImageCaptioningMock).toHaveBeenLastCalledWith(
      true,
      "azure-openai-chat",
      "gpt-5.4-mini",
      "https://sdk-base.openai.azure.com/",
      "2025-01-01-preview",
    );
  });

  it("host openai caption settings override a configured azure caption provider", async () => {
    const { ctx } = makeContext(hostRoot, {}, {
      pluginDataDir: hostRoot,
      configValues: {
        apiKeySource: "host",
        hostApiVendor: "openai",
        imageCaptionProvider: "azure-openai-chat",
      },
    });
    const plugin = await createPlugin(ctx);

    const res = await plugin.handlers.index_set_image_embedding({
      enabled: true,
      mode: "cloud",
    });

    expect(res.imageCaptionProvider).toBe("openai");
    expect(setImageCaptioningMock).toHaveBeenLastCalledWith(
      true,
      "openai",
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });

  it("host azure embedding settings override a configured openai embedding provider", async () => {
    const { ctx } = makeContext(hostRoot, {}, {
      pluginDataDir: hostRoot,
      configValues: {
        apiKeySource: "host",
        hostApiVendor: "azure-openai",
        embeddingProvider: "openai",
      },
    });
    const plugin = await createPlugin(ctx);

    const res = await plugin.handlers.index_get_settings();

    expect(res.embeddingProvider).toBe("azure");
    expect(localIndexerPluginInstances.at(-1)?.opts?.embeddingProvider).toBe("azure");
  });

  it("re-enabling image embedding invalidates cached image entries", async () => {
    const { ctx } = makeContext(hostRoot, {}, { pluginDataDir: hostRoot });
    const plugin = await createPlugin(ctx);
    invalidateImageEntriesMock.mockReturnValueOnce(3);

    await plugin.handlers.index_set_image_embedding({ enabled: false });
    const res = await plugin.handlers.index_set_image_embedding({ enabled: true });

    expect(invalidateImageEntriesMock).toHaveBeenCalledTimes(1);
    expect(res.imageEmbeddingEnabled).toBe(true);
  });

  it("index_set_image_embedding resolves with workerSynced:false when worker sync fails", async () => {
    // 워커 sync 실패는 best-effort 로 강등됐다 — sidecar 는 이미 저장됐고,
    // 다음 워커 부팅 시 startup-sync 가 디스크에서 재반영. 토글이 worker
    // 좀비/port 충돌로 throw 하면 UI 의 다른 동작 (폴더 추가, 인덱싱 시작
    // 등) 이 줄줄이 막힘 — 그걸 막기 위해 본 핸들러는 resolve 한다.
    const { ctx } = makeContext(hostRoot, {}, { pluginDataDir: hostRoot });
    const plugin = await createPlugin(ctx);
    setImageCaptioningMock
      .mockRejectedValueOnce(new Error("startup sync unavailable"))
      .mockRejectedValueOnce(new Error("worker unavailable"));

    const result = await plugin.handlers.index_set_image_embedding({
      enabled: false,
      mode: "cloud",
    });
    expect(result.workerSynced).toBe(false);
    expect(result.message).toContain("워커 동기화 보류");
    // imageEmbeddingEnabled 는 디스크에 저장된 값을 그대로 반영해야 함.
    expect(result.imageEmbeddingEnabled).toBe(false);
  });

  it("index_get_settings re-reads the plugin-owned caption secret on every call", async () => {
    // `hasApiKey` now mirrors the dedicated `imageCaptionApiKey` slot —
    // the shared `apiKey` field was removed and the main UI warning is
    // caption-focused, so this test exercises that exact secret key.
    let secret = "";
    const { ctx } = makeContext(hostRoot, {}, {
      pluginDataDir: hostRoot, configValues: { apiKeySource: "plugin" },
    });
    ctx.hostApi.getSecret = vi.fn((key: string) =>
      key === "plugin.local-indexer.imageCaptionApiKey" ? secret || null : null,
    );
    const plugin = await createPlugin(ctx);

    // Cold: no secret stored, hasApiKey should be false.
    let res = await plugin.handlers.index_get_settings();
    expect(res.hasApiKey).toBe(false);

    // User enters a key in the host's settings UI mid-session — the
    // handler must observe the live secret without a plugin restart.
    secret = "sk-test-key";
    res = await plugin.handlers.index_get_settings();
    expect(res.hasApiKey).toBe(true);

    // Removing the key flips hasApiKey back without re-mounting.
    secret = "";
    res = await plugin.handlers.index_get_settings();
    expect(res.hasApiKey).toBe(false);
  });

  it("image-embedding sidecar persists across plugin re-construct", async () => {
    // First plugin instance writes the sidecar (toggle-only now —
    // provider is read live from host config on every get_settings).
    const first = makeContext(hostRoot, {}, { pluginDataDir: hostRoot });
    const pluginA = await createPlugin(first.ctx);
    await pluginA.handlers.index_set_image_embedding({ enabled: true, mode: "local" });

    // Second instance (simulating plugin reload) reads from disk —
    // get_settings should report the persisted toggle and the
    // host-config-default provider.
    const second = makeContext(hostRoot, {}, { pluginDataDir: hostRoot });
    const pluginB = await createPlugin(second.ctx);
    const res = await pluginB.handlers.index_get_settings();
    expect(res.imageEmbeddingEnabled).toBe(true);
    expect(res.imageCaptionMode).toBe("cloud");
    expect(res.imageCaptionProvider).toBe("openai");
  });

  it("uses pluginDataDir for relative workspace when hostRoot is a file path", async () => {
    const asarLikeHostRoot = join(hostRoot, "app.asar");
    const pluginDataDir = join(hostRoot, "plugin-data");
    await writeFile(asarLikeHostRoot, "asar-file", "utf-8");
    await mkdir(pluginDataDir, { recursive: true });

    const { ctx } = makeContext(asarLikeHostRoot, {}, { pluginDataDir });
    const plugin = await createPlugin(ctx);

    await expect(plugin.start()).resolves.toBeUndefined();
    await expect(plugin.onPublished?.()).resolves.toBeUndefined();
    const st = await stat(join(pluginDataDir, ".local-indexer-workspace"));
    expect(st.isDirectory()).toBe(true);
    await plugin.stop();
  });

  it("migrates legacy <hostRoot>/.local-indexer-workspace to <pluginDataDir>/.local-indexer-workspace", async () => {
    const legacy = join(hostRoot, ".local-indexer-workspace");
    const pluginDataDir = join(hostRoot, "plugin-data");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "index-state.json"), "{}", "utf-8");
    await mkdir(pluginDataDir, { recursive: true });

    const { ctx } = makeContext(hostRoot, {}, { pluginDataDir });
    const plugin = await createPlugin(ctx);
    await plugin.start();
    expect((await stat(legacy)).isDirectory()).toBe(true);
    await expect(
      stat(join(pluginDataDir, ".local-indexer-workspace")),
    ).rejects.toThrow();
    await plugin.onPublished?.();

    // Legacy path is gone, target has the file
    await expect(stat(legacy)).rejects.toThrow();
    const indexState = await stat(join(pluginDataDir, ".local-indexer-workspace", "index-state.json"));
    expect(indexState.isFile()).toBe(true);

    await plugin.stop();
  });

  describe("apiKeySource toggle", () => {
    it("apiKeySource=host uses hostApiKey from config for embedding and caption", async () => {
      // Simulate host injecting its active LLM vendor key via getSecret (B4: unified path).
      // The old config.get("hostApiKey") path is removed; the host now exposes the key
      // via hostApi.getSecret("llm.apiKey.openai") for vendor=openai.
      const { ctx } = makeContext(hostRoot, {}, {
        pluginDataDir: hostRoot,
        configValues: {
          apiKeySource: "host",
          embeddingProvider: "openai",
        },
      });
      // Host provides key via getSecret (B4 unified path); no plugin-own secrets.
      ctx.hostApi.getSecret = vi.fn((key: string) =>
        key === "llm.apiKey.openai" ? "hk-from-host-vendor" : null,
      );
      const plugin = await createPlugin(ctx);

      // index_get_settings resolves caption key via host getSecret path → hasApiKey true.
      const settings = await plugin.handlers.index_get_settings();
      expect(settings.hasApiKey).toBe(true);
    });

    it("apiKeySource=plugin uses plugin own secret and ignores hostApiKey", async () => {
      // Host has a key injected, but apiKeySource=plugin means we read the
      // plugin's own secret slot, not the host key.
      let pluginSecret = "";
      const { ctx } = makeContext(hostRoot, {}, {
        pluginDataDir: hostRoot,
        configValues: {
          apiKeySource: "plugin",
          hostApiKey: "hk-from-host-vendor",
          embeddingProvider: "openai",
        },
      });
      ctx.hostApi.getSecret = vi.fn((key: string) =>
        key === "plugin.local-indexer.imageCaptionApiKey" ? pluginSecret || null : null,
      );
      const plugin = await createPlugin(ctx);

      // No plugin-own secret → hasApiKey false, even though host key exists.
      let settings = await plugin.handlers.index_get_settings();
      expect(settings.hasApiKey).toBe(false);

      // Plugin-own secret entered → hasApiKey true.
      pluginSecret = "sk-plugin-own";
      settings = await plugin.handlers.index_get_settings();
      expect(settings.hasApiKey).toBe(true);
    });

    // B4: vendor=openai → key read via getSecret("llm.apiKey.openai")
    it("vendor=openai resolves a lease without exporting the host key", async () => {
      const { ctx } = makeContext(hostRoot, {}, {
        pluginDataDir: hostRoot,
        configValues: {
          apiKeySource: "host",
          hostApiVendor: "openai",
          embeddingProvider: "openai",
        },
      });
      ctx.hostApi.getSecret = vi.fn((key: string) =>
        key === "llm.apiKey.openai" ? "sk-openai-via-secret" : null,
      );
      const plugin = await createPlugin(ctx);

      const settings = await plugin.handlers.index_get_settings();
      expect(settings.hasApiKey).toBe(true);
      expect(ctx.hostApi.resolveApiKey).toHaveBeenCalledWith(expect.objectContaining({
        purpose: "vision", vendor: "openai", exposure: "lease",
      }));
      expect(ctx.hostApi.getSecret).not.toHaveBeenCalledWith("llm.apiKey.openai");
    });

    // B4: vendor=claude → non-openai/azure vendor → readHostApiKey returns "" → fallback to plugin slot
    it("vendor=claude denial does not fall back to a plugin key", async () => {
      const { ctx } = makeContext(hostRoot, {}, {
        pluginDataDir: hostRoot,
        configValues: {
          apiKeySource: "host",
          hostApiVendor: "claude",
          embeddingProvider: "openai",
        },
      });
      // plugin slot also empty
      ctx.hostApi.getSecret = vi.fn(() => null);
      ctx.hostApi.resolveApiKey = vi.fn(async () => ({ ok: false, reason: "vendor-unsupported" }));
      const plugin = await createPlugin(ctx);

      const settings = await plugin.handlers.index_get_settings();
      // Non-openai/azure vendor → readHostApiKey returns "" → no plugin slot either → hasApiKey false.
      expect(settings.hasApiKey).toBe(false);
    });

    // #955 round-1 critic MAJOR 1: vendor=azure-foundry must broker key via
    // llm.apiKey.azure-foundry slot (declared in plugin.json hostSecrets.read).
    // Previously readHostApiKey gated on vendor==="openai" only and returned ""
    // for azure-foundry — embProvider auto-inherited "azure" but apiKey was empty,
    // causing worker throw "Azure 임베딩 API 키 미설정".
    it("vendor=azure-foundry requests the Azure lease without exporting the key", async () => {
      const { ctx } = makeContext(hostRoot, {}, {
        pluginDataDir: hostRoot,
        configValues: {
          apiKeySource: "host",
          hostApiVendor: "azure-foundry",
          embeddingProvider: "azure",
          embeddingEndpoint: "https://example.openai.azure.com/",
        },
      });
      ctx.hostApi.getSecret = vi.fn((key: string) =>
        key === "llm.apiKey.azure-foundry" ? "az-foundry-key" : null,
      );
      const plugin = await createPlugin(ctx);

      const settings = await plugin.handlers.index_get_settings();
      expect(settings.hasApiKey).toBe(true);
      expect(ctx.hostApi.resolveApiKey).toHaveBeenCalledWith(expect.objectContaining({
        purpose: "vision", vendor: "azure-openai", exposure: "lease",
      }));
      expect(ctx.hostApi.getSecret).not.toHaveBeenCalledWith("llm.apiKey.azure-foundry");
    });

    // #955 round-2 architect MAJOR: any azure variant (not just azure-foundry)
    // must broker through the single `llm.apiKey.azure-foundry` slot declared
    // in plugin.json hostSecrets.read. Previously the template `llm.apiKey.${vendor}`
    // produced "llm.apiKey.azure-openai" for vendor=azure-openai — a slot not in
    // the manifest allow-list, so the host capability check silently refused
    // the read and the worker ended up without an apiKey.
    it("vendor=azure-openai uses the same Azure lease request", async () => {
      const { ctx } = makeContext(hostRoot, {}, {
        pluginDataDir: hostRoot,
        configValues: {
          apiKeySource: "host",
          hostApiVendor: "azure-openai",
          embeddingProvider: "azure",
          embeddingEndpoint: "https://example.openai.azure.com/",
        },
      });
      ctx.hostApi.getSecret = vi.fn((key: string) =>
        key === "llm.apiKey.azure-foundry" ? "az-shared-key" : null,
      );
      const plugin = await createPlugin(ctx);

      const settings = await plugin.handlers.index_get_settings();
      expect(settings.hasApiKey).toBe(true);
      expect(ctx.hostApi.resolveApiKey).toHaveBeenCalledWith(expect.objectContaining({
        purpose: "vision", vendor: "azure-openai", exposure: "lease",
      }));
      const calls = (ctx.hostApi.getSecret as ReturnType<typeof vi.fn>).mock.calls.map(([k]) => k);
      expect(calls).not.toContain("llm.apiKey.azure-foundry");
      expect(calls).not.toContain("llm.apiKey.azure-openai");
    });

    it("derives azure embedding root from the configured caption endpoint when embeddingEndpoint is blank", async () => {
      const { ctx } = makeContext(hostRoot, {}, {
        pluginDataDir: hostRoot,
        configValues: {
          apiKeySource: "host",
          hostApiVendor: "azure-openai",
          embeddingProvider: "azure",
          embeddingModel: "text-embedding-3-small",
          embeddingApiVersion: "2023-05-15",
          imageCaptionProvider: "azure-openai-responses",
          imageCaptionEndpoint:
            "https://example.cognitiveservices.azure.com/openai/responses?api-version=2025-04-01-preview",
        },
      });
      ctx.hostApi.getSecret = vi.fn((key: string) =>
        key === "llm.apiKey.azure-foundry" ? "az-shared-key" : null,
      );

      await createPlugin(ctx);

      const instance = localIndexerPluginInstances.at(-1);
      expect(instance?.opts?.embeddingEndpoint).toBe("https://example.cognitiveservices.azure.com/");
      expect(instance?.opts?.embeddingApiVersion).toBe("2023-05-15");
    });

    it("derives azure embedding root from the host SDK baseUrl before first worker start", async () => {
      const { ctx } = makeContext(hostRoot, {}, {
        pluginDataDir: hostRoot,
        configValues: {
          apiKeySource: "host",
          hostApiVendor: "azure-openai",
          embeddingProvider: "azure",
          embeddingModel: "text-embedding-3-small",
        },
      });
      ctx.hostApi.resolveApiKey = vi.fn(async () => ({
        ok: true,
        vendor: "azure-openai",
        exposure: "lease", leaseId: "lease-test", onClosed: () => () => {},
        baseUrl:
          "https://sdk-base.openai.azure.com/openai/deployments/gpt-5.4-mini/chat/completions?api-version=2025-01-01-preview",
        release: async () => {},
      }));

      const plugin = await createPlugin(ctx);
      const instance = localIndexerPluginInstances.at(-1);
      expect(instance?.opts?.embeddingEndpoint ?? "").toBe("");

      await expect(plugin.handlers.index_scan()).resolves.toHaveProperty("indexed");
      expect(instance?.opts?.embeddingEndpoint).toBe("https://sdk-base.openai.azure.com/");
    });

    it("index_scan keeps embedding but does not reacquire for caption after a vision denial", async () => {
      await writeFile(
        join(hostRoot, "image-embedding-settings.json"),
        JSON.stringify({ imageEmbeddingEnabled: true, imageCaptionMode: "cloud" }),
      );
      const { ctx } = makeContext(hostRoot, {}, {
        pluginDataDir: hostRoot,
        configValues: {
          apiKeySource: "host",
          hostApiVendor: "openai",
          embeddingProvider: "openai",
        },
      });
      ctx.hostApi.resolveApiKey = vi.fn(async ({ purpose }: { purpose: string }) => {
        if (purpose === "vision") return { ok: false, reason: "vision-not-granted" };
        return {
          ok: true,
          vendor: "openai",
          exposure: "lease", leaseId: "lease-test", onClosed: () => () => {},
          release: async () => {},
        };
      });
      const plugin = await createPlugin(ctx);

      await expect(plugin.handlers.index_scan()).resolves.toHaveProperty("indexed");
      expect(setImageCaptioningMock).toHaveBeenLastCalledWith(
        false,
        "openai",
        "",
        "",
        "",
      );
      const keyCaptureLogs = (ctx.hostApi.logEvent as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([_level, event]: [string, string]) => event === "index_scan.key_capture",
      );
      expect(keyCaptureLogs.at(-1)?.[2]).toMatchObject({ hasCaptionKey: false });
    });

    it("hydrates azure embedding root before post-publish startup warnings", async () => {
      const { ctx } = makeContext(hostRoot, {}, {
        pluginDataDir: hostRoot,
        configValues: {
          apiKeySource: "host",
          hostApiVendor: "azure-openai",
          embeddingProvider: "azure",
          embeddingModel: "text-embedding-3-small",
        },
      });
      ctx.hostApi.resolveApiKey = vi.fn(async ({ purpose }: { purpose: string }) => ({
        ok: true,
        vendor: "azure-openai",
        exposure: "lease", leaseId: "lease-test", onClosed: () => () => {},
        baseUrl:
          purpose === "embedding"
            ? "https://startup-base.openai.azure.com/openai/deployments/text-embedding-3-small/embeddings?api-version=2023-05-15"
            : "https://startup-base.openai.azure.com/openai/deployments/gpt-5.4-mini/chat/completions?api-version=2025-01-01-preview",
        release: async () => {},
      }));

      const plugin = await createPlugin(ctx);
      await plugin.onPublished?.();

      const instance = localIndexerPluginInstances.at(-1);
      expect(instance?.opts?.embeddingEndpoint).toBe("https://startup-base.openai.azure.com/");
    });

    // T1-6: key and vendor captured once at index_scan entry; logged via index_scan.key_capture
    it("index_scan captures vendor and keys at entry and logs key_capture event", async () => {
      const { ctx } = makeContext(hostRoot, {}, {
        pluginDataDir: hostRoot,
        configValues: {
          apiKeySource: "host",
          hostApiVendor: "openai",
          embeddingProvider: "openai",
        },
      });
      ctx.hostApi.getSecret = vi.fn((key: string) =>
        key === "llm.apiKey.openai" ? "sk-captured-at-start" : null,
      );
      const plugin = await createPlugin(ctx);

      // Run scan — key capture happens at scan entry and is logged.
      const res = await plugin.handlers.index_scan();
      expect(res).toHaveProperty("indexed");

      // Verify key_capture event was emitted with vendor and key presence.
      const keyCaptureLogs = (ctx.hostApi.logEvent as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([_level, event]: [string, string]) => event === "index_scan.key_capture",
      );
      expect(keyCaptureLogs.length).toBeGreaterThan(0);
      expect(keyCaptureLogs[0][2]).toMatchObject({ vendor: "openai", hasEmbeddingKey: true });
    });

    // Broker contract: the worker gets a go-ahead flag, never a credential.
    it("index_scan tells the worker embedding egress may go ahead, with no credential", async () => {
      const { ctx } = makeContext(hostRoot, {}, {
        pluginDataDir: hostRoot,
        configValues: {
          apiKeySource: "host",
          hostApiVendor: "openai",
          embeddingProvider: "openai",
        },
      });
      ctx.hostApi.getSecret = vi.fn((key: string) =>
        key === "llm.apiKey.openai" ? "sk-scan-start-key" : null,
      );
      const plugin = await createPlugin(ctx);

      setEmbeddingEgressMock.mockClear();
      await plugin.handlers.index_scan();

      // First scan also boots the worker, so the go-ahead is pushed once at
      // warmup and once at scan entry. It carries a flag only: the worker
      // never receives the provider key or any other credential.
      expect(setEmbeddingEgressMock).toHaveBeenCalledTimes(2);
      expect(setEmbeddingEgressMock.mock.calls).toEqual([[true], [true]]);
      const channel = await latestEgressChannels().embedding();
      expect(channel.apiKey).toBeUndefined();
      expect(channel.lease?.exposure).toBe("lease");
      await channel.lease?.release();
    });

    it("index_scan gives no embedding go-ahead when no embedding key is available", async () => {
      // Both the warmup and the scan-entry push are gated on a provider key
      // existing: with none, the worker stays BM25-only instead of relaying a
      // request per chunk that the broker would refuse.
      const { ctx } = makeContext(hostRoot, {}, {
        pluginDataDir: hostRoot,
        configValues: {
          apiKeySource: "plugin",
          embeddingProvider: "openai",
        },
      });
      // No secret set → readEmbeddingApiKey returns "".
      ctx.hostApi.getSecret = vi.fn(() => null);
      const plugin = await createPlugin(ctx);

      setEmbeddingEgressMock.mockClear();
      try { await plugin.handlers.index_scan(); } catch { /* expected */ }

      expect(setEmbeddingEgressMock).not.toHaveBeenCalled();
      expect((await latestEgressChannels().embedding()).apiKey).toBe("");
    });

    // Cycle 3 LOW: key_capture log must include keySource field.
    it("index_scan.key_capture log includes keySource diagnostic field", async () => {
      const { ctx } = makeContext(hostRoot, {}, {
        pluginDataDir: hostRoot,
        configValues: {
          apiKeySource: "host",
          hostApiVendor: "openai",
          embeddingProvider: "openai",
        },
      });
      ctx.hostApi.getSecret = vi.fn((key: string) =>
        key === "llm.apiKey.openai" ? "sk-test" : null,
      );
      const plugin = await createPlugin(ctx);

      await plugin.handlers.index_scan();

      const keyCaptureLogs = (ctx.hostApi.logEvent as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([_level, event]: [string, string]) => event === "index_scan.key_capture",
      );
      expect(keyCaptureLogs.length).toBeGreaterThan(0);
      // host + openai vendor → keySource = "host"
      expect(keyCaptureLogs[0][2]).toMatchObject({ keySource: "host" });
    });

    it("index_scan continues text indexing when image caption key is missing", async () => {
      await writeFile(
        join(hostRoot, "image-embedding-settings.json"),
        JSON.stringify({ imageEmbeddingEnabled: true, imageCaptionMode: "cloud" }),
      );
      const { ctx, events } = makeContext(hostRoot, {}, {
        pluginDataDir: hostRoot,
        configValues: {
          apiKeySource: "host",
          hostApiVendor: "openai",
          embeddingProvider: "openai",
        },
      });
      ctx.hostApi.getSecret = vi.fn(() => null);
      ctx.hostApi.resolveApiKey = vi.fn(async ({ purpose }: { purpose: string }) =>
        purpose === "vision"
          ? { ok: false, reason: "not-whitelisted" }
          : { ok: true, exposure: "lease", leaseId: "lease-test", vendor: "openai", release: async () => {}, onClosed: () => () => {} },
      );
      const plugin = await createPlugin(ctx);

      await expect(plugin.handlers.index_scan()).resolves.toHaveProperty("indexed", 2);
      expect(setImageCaptioningMock).toHaveBeenLastCalledWith(
        false,
        "openai",
        expect.any(String),
        expect.any(String),
        expect.any(String),
      );
      expect(events).toContainEqual([
        "index.warning",
        expect.objectContaining({ kind: "caption.missing_config" }),
      ]);
    });
  });

  describe("lease-backed egress channels", () => {
    it("hydrates the host embedding presence and the embedding go-ahead before a scan", async () => {
      const { ctx } = makeContext(hostRoot, {}, {
        pluginDataDir: hostRoot,
        configValues: { apiKeySource: "host", embeddingProvider: "openai" },
      });
      const release = vi.fn(async () => {});
      ctx.hostApi.resolveApiKey = vi.fn(async () => ({
        ok: true, exposure: "lease", leaseId: "boot-lease", vendor: "openai",
        release, onClosed: () => () => {},
      }));
      const plugin = await createPlugin(ctx);
      await plugin.onPublished?.();

      expect(localIndexerPluginInstances.at(-1)?.opts?.apiKey).toBe("host-lease-present");
      expect(release).toHaveBeenCalled();
      expect(setEmbeddingEgressMock).toHaveBeenCalledWith(true);
    });

    it("gives no embedding go-ahead and reads no plugin key after a host lease denial", async () => {
      const { ctx } = makeContext(hostRoot, {}, {
        pluginDataDir: hostRoot,
        configValues: { apiKeySource: "host", embeddingProvider: "openai" },
      });
      ctx.hostApi.resolveApiKey = vi.fn(async () => ({ ok: false, reason: "not-whitelisted" }));
      const plugin = await createPlugin(ctx);
      await plugin.onPublished?.();

      expect(localIndexerPluginInstances.at(-1)?.opts?.apiKey).toBe("");
      expect(setEmbeddingEgressMock).not.toHaveBeenCalled();
      expect(ctx.hostApi.getSecret).not.toHaveBeenCalled();
    });

    it("uses the public lease for host embedding requests without exporting a key", async () => {
      const { ctx } = makeContext(hostRoot, {}, {
        pluginDataDir: hostRoot,
        configValues: { apiKeySource: "host", hostApiVendor: "openai" },
      });
      const hostFetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      }));
      ctx.hostApi.hostFetch = hostFetch;
      const plugin = await createPlugin(ctx);
      await plugin.handlers.index_scan();

      const channel = await latestEgressChannels().embedding();
      expect(channel.apiKey).toBeUndefined();
      expect(channel.lease?.exposure).toBe("lease");
      const upstreamFetch = localIndexerPluginInstances.at(-1)!.opts.egressUpstreamFetch;
      const result = await upstreamFetch("https://api.openai.com/v1/embeddings", {
        method: "POST", headers: { "content-type": "application/json" },
        body: Buffer.from("{}"), lease: channel.lease,
      });
      expect(result.status).toBe(200);
      expect(result.body.toString()).toContain("data");
      expect(hostFetch).toHaveBeenCalledWith("https://api.openai.com/v1/embeddings", expect.objectContaining({
        auth: { lease: channel.lease?.leaseId },
        headers: { "content-type": "application/json" },
      }));
      expect(ctx.hostApi.getSecret).not.toHaveBeenCalledWith("llm.apiKey.openai");
      await channel.lease?.release();
    });

    it("refuses an untrusted host endpoint without switching to a plugin key", async () => {
      const { ctx } = makeContext(hostRoot, {}, {
        pluginDataDir: hostRoot,
        configValues: {
          apiKeySource: "host", embeddingEndpoint: "https://evil.attacker.example/v1",
        },
      });
      ctx.hostApi.getSecret = vi.fn((key: string) =>
        key === "plugin.local-indexer.embeddingApiKey" ? "plugin-own-key" : null,
      );
      await createPlugin(ctx);
      await expect(latestEgressChannels().embedding()).rejects.toMatchObject({
        reason: "audience-not-allowlisted",
      });
      expect(ctx.hostApi.getSecret).not.toHaveBeenCalledWith("plugin.local-indexer.embeddingApiKey");
    });

    it("uses only the plugin-owned key after a live source switch", async () => {
      const configValues: Record<string, unknown> = { apiKeySource: "host" };
      const { ctx } = makeContext(hostRoot, {}, { pluginDataDir: hostRoot, configValues });
      ctx.hostApi.getSecret = vi.fn((key: string) =>
        key === "plugin.local-indexer.embeddingApiKey" ? "plugin-owned-key" : null,
      );
      await createPlugin(ctx);
      const hostChannel = await latestEgressChannels().embedding();
      expect(hostChannel.lease?.exposure).toBe("lease");
      await hostChannel.lease?.release();

      configValues.apiKeySource = "plugin";
      const resolverCalls = (ctx.hostApi.resolveApiKey as ReturnType<typeof vi.fn>).mock.calls.length;
      const pluginChannel = await latestEgressChannels().embedding();
      expect(pluginChannel.lease).toBeUndefined();
      expect(pluginChannel.apiKey).toBe("plugin-owned-key");
      expect((ctx.hostApi.resolveApiKey as ReturnType<typeof vi.fn>).mock.calls.length).toBe(resolverCalls);
    });

    it("refuses a host caption endpoint outside the approved audience", async () => {
      const { ctx } = makeContext(hostRoot, {}, {
        pluginDataDir: hostRoot,
        configValues: {
          apiKeySource: "host", imageCaptionProvider: "openai",
          imageCaptionEndpoint: "https://evil.attacker.example/caption",
        },
      });
      await createPlugin(ctx);
      await expect(latestEgressChannels().caption()).rejects.toMatchObject({
        reason: "audience-not-allowlisted",
      });
    });
  });

  // Boot reconcile pass: after the warmup key push, the host calls
  // /indexer/reconcile to DETECT SQLite↔LanceDB vector drift (key-free), then
  // heals the drifted docs via a bounded reindex. Heal is deferred when no key
  // is available. These tests drive the background warmup and wait for it to
  // settle via vi.waitFor.
  describe("boot reconcile pass — SQLite↔LanceDB drift heal", () => {
    it("bounded heal: re-embeds at most RECONCILE_HEAL_CAP (50) drifted docs per cycle", async () => {
      const { ctx } = makeContext(hostRoot, {}, {
        pluginDataDir: hostRoot,
        configValues: {
          apiKeySource: "host",
          hostApiVendor: "openai",
          embeddingProvider: "openai",
        },
      });
      ctx.hostApi.getSecret = vi.fn((key: string) =>
        key === "llm.apiKey.openai" ? "sk-heal-key" : null,
      );
      // 60 drifted docs — more than the cap of 50.
      const drifted = Array.from({ length: 60 }, (_, i) => ({
        doc_id: `d${i}`,
        path: `/tmp/drift-${i}.md`,
      }));
      reconcileMock.mockResolvedValue({
        checked: true,
        drifted_docs: drifted,
        drifted_doc_count: drifted.length,
        orphan_vectors_deleted: 0,
      });
      const plugin = await createPlugin(ctx);

      reindexMock.mockClear();
      await plugin.handlers.index_scan();

      // Warmup (and thus reconcile + heal) runs in the background.
      await vi.waitFor(
        () => {
          expect(reconcileMock).toHaveBeenCalled();
          expect(reindexMock).toHaveBeenCalledTimes(50);
        },
        { timeout: 3000 },
      );
      // Exactly the cap — never the full 60.
      expect(reindexMock).toHaveBeenCalledTimes(50);
      // Only the bounded prefix of drifted-doc paths was healed.
      const healedPaths = reindexMock.mock.calls.map((c) => c[0]);
      expect(healedPaths).toEqual(drifted.slice(0, 50).map((d) => d.path));
    });

    it("heal re-embeds documents indexed without vectors, with the drifted ones, within the cap", async () => {
      const { ctx } = makeContext(hostRoot, {}, {
        pluginDataDir: hostRoot,
        configValues: {
          apiKeySource: "host",
          hostApiVendor: "openai",
          embeddingProvider: "openai",
        },
      });
      ctx.hostApi.getSecret = vi.fn((key: string) =>
        key === "llm.apiKey.openai" ? "sk-heal-key" : null,
      );
      // Embedded during an outage: indexed, but without vectors. A scan skips
      // them (same mtime), so only the heal re-embeds them.
      mockDocuments = [
        ...Array.from({ length: 55 }, (_, i) => ({
          id: `e${i}`, doc_id: `e${i}`, doc_name: `e${i}.md`, doc_type: "md", type: "md",
          path: `/tmp/embed-failed-${i}.md`, status: "indexed", content_state: "embed_failed",
        })),
        { id: "ok", doc_id: "ok", doc_name: "ok.md", doc_type: "md", type: "md",
          path: "/tmp/ok.md", status: "indexed", content_state: "ok" },
        { id: "f", doc_id: "f", doc_name: "f.md", doc_type: "md", type: "md",
          path: "/tmp/failed.md", status: "failed", content_state: "embed_failed" },
      ] as typeof mockDocuments;
      reconcileMock.mockResolvedValue({
        checked: true,
        // One drifted document is also embed_failed: healed once.
        drifted_docs: [{ doc_id: "d1", path: "/tmp/drift-1.md" }, { doc_id: "e0", path: "/tmp/embed-failed-0.md" }],
        drifted_doc_count: 2,
        orphan_vectors_deleted: 0,
      });
      const plugin = await createPlugin(ctx);
      reindexMock.mockClear();
      await plugin.handlers.index_scan();

      await vi.waitFor(() => expect(reindexMock).toHaveBeenCalledTimes(50), { timeout: 3000 });
      const healed = reindexMock.mock.calls.map((c) => c[0]);
      expect(healed.slice(0, 3)).toEqual(["/tmp/drift-1.md", "/tmp/embed-failed-0.md", "/tmp/embed-failed-1.md"]);
      expect(new Set(healed).size).toBe(50);
      expect(healed).not.toContain("/tmp/ok.md");
      expect(healed).not.toContain("/tmp/failed.md");
      // 1 drifted + 55 embed_failed (one shared) = 56; 50 healed, 6 next cycle.
      await vi.waitFor(() => {
        const done = (ctx.hostApi.logEvent as ReturnType<typeof vi.fn>).mock.calls.find(
          ([, event]: [string, string]) => event === "local_indexer.reconcile_healed",
        );
        expect(done?.[2]).toMatchObject({ healed: 50, remaining: 6 });
      });
    });

    function hostKeyContext() {
      const made = makeContext(hostRoot, {}, {
        pluginDataDir: hostRoot,
        configValues: { apiKeySource: "host", hostApiVendor: "openai", embeddingProvider: "openai" },
      });
      made.ctx.hostApi.getSecret = vi.fn((key: string) => (key === "llm.apiKey.openai" ? "sk-heal-key" : null));
      return made;
    }

    async function healOnce(paths: string[], fails: (path: string) => boolean) {
      mockDocuments = paths.map((path, i) => ({
        id: `e${i}`, doc_id: `e${i}`, doc_name: `${i}.md`, doc_type: "md", type: "md",
        path, status: "indexed", content_state: "embed_failed",
      })) as typeof mockDocuments;
      reindexMock.mockReset();
      reindexMock.mockImplementation(async (filePath: string) => ({
        doc_id: `doc:${filePath}`, doc_name: filePath, doc_type: "md", chunk_count: 1, status: "indexed",
        embedded: !fails(filePath),
      }));
      const { ctx } = hostKeyContext();
      const plugin = await createPlugin(ctx);
      await plugin.handlers.index_scan();
      let done: any;
      await vi.waitFor(() => {
        done = (ctx.hostApi.logEvent as ReturnType<typeof vi.fn>).mock.calls.find(
          ([, event]: [string, string]) => event === "local_indexer.reconcile_healed",
        );
        expect(done).toBeTruthy();
      }, { timeout: 3000 });
      const called = reindexMock.mock.calls.map((c) => c[0] as string);
      await plugin.stop();
      return { called, done: done[2] };
    }

    it("heal stops after 3 failures in a row, and puts documents that keep failing at the back", async () => {
      const paths = Array.from({ length: 10 }, (_, i) => `/tmp/heal-${i}.md`);
      const alwaysFails = new Set(paths.slice(0, 3)); // e.g. over the provider's token limit
      try {
        const first = await healOnce(paths, (p) => alwaysFails.has(p));
        expect(first.called).toEqual(paths.slice(0, 3));
        expect(first.done).toMatchObject({ healed: 0, attempted: 3, stoppedEarly: true });
        const ledger = JSON.parse(await readFile(join(hostRoot, "heal-attempts.json"), "utf-8"));
        expect(ledger).toEqual(Object.fromEntries(paths.slice(0, 3).map((p) => [p, 1])));

        // Next start: the documents that failed go last, so the rest heal.
        const second = await healOnce(paths, (p) => alwaysFails.has(p));
        expect(second.called.slice(0, 7)).toEqual(paths.slice(3));
        expect(second.done).toMatchObject({ healed: 7, stoppedEarly: true });
        const after = JSON.parse(await readFile(join(hostRoot, "heal-attempts.json"), "utf-8"));
        expect(after).toEqual(Object.fromEntries(paths.slice(0, 3).map((p) => [p, 2])));
      } finally {
        reindexMock.mockReset();
        reindexMock.mockImplementation(async (filePath: string) => ({
          doc_id: `doc:${filePath}`, doc_name: filePath, doc_type: "md", chunk_count: 1, status: "indexed", embedded: true,
        }));
      }
    });

    it("documents without vectors wait for a key: no re-embed without one", async () => {
      const { ctx } = makeContext(hostRoot, {}, {
        pluginDataDir: hostRoot,
        configValues: { apiKeySource: "plugin", embeddingProvider: "openai" },
      });
      ctx.hostApi.getSecret = vi.fn(() => null);
      mockDocuments = [
        { id: "e", doc_id: "e", doc_name: "e.md", doc_type: "md", type: "md",
          path: "/tmp/embed-failed.md", status: "indexed", content_state: "embed_failed" },
      ] as typeof mockDocuments;
      const plugin = await createPlugin(ctx);
      reindexMock.mockClear();
      try { await plugin.handlers.index_scan(); } catch { /* expected: no key */ }
      await vi.waitFor(() => expect(reconcileMock).toHaveBeenCalled(), { timeout: 3000 });
      await vi.waitFor(() => {
        const deferred = (ctx.hostApi.logEvent as ReturnType<typeof vi.fn>).mock.calls.find(
          ([, event]: [string, string]) => event === "local_indexer.reconcile_heal_deferred",
        );
        expect(deferred?.[2]).toMatchObject({ drifted: 0, embedFailed: 1 });
      });
      expect(reindexMock).not.toHaveBeenCalled();
    });

    it("seeds the scan cache only from indexed rows, so a failed file is retried after a restart", async () => {
      const { ctx } = makeContext(hostRoot, {}, { pluginDataDir: hostRoot });
      mockDocuments = [
        { id: "a", doc_id: "a", doc_name: "a.md", doc_type: "md", type: "md", path: "/tmp/a.md",
          status: "indexed", mtime_ms: 1_700_000_000_000 },
        { id: "f", doc_id: "f", doc_name: "f.md", doc_type: "md", type: "md", path: "/tmp/failed.md",
          status: "failed", mtime_ms: 1_700_000_000_000 },
        { id: "p", doc_id: "p", doc_name: "p.md", doc_type: "md", type: "md", path: "/tmp/pending.md",
          status: "pending", mtime_ms: 1_700_000_000_000 },
      ] as typeof mockDocuments;
      const plugin = await createPlugin(ctx);
      await plugin.handlers.index_scan();
      await vi.waitFor(() => expect(prePopulateCacheMock).toHaveBeenCalled(), { timeout: 3000 });
      const seeded = (prePopulateCacheMock.mock.calls.at(-1)![0] as Array<{ path: string }>).map((d) => d.path);
      expect(seeded).toEqual(["/tmp/a.md"]);
      // Nor does the DB-to-state sync record the failed rows as indexed.
      await vi.waitFor(async () => {
        const state = JSON.parse(await readFile(join(hostRoot, "index-state.json"), "utf-8"));
        expect(Object.keys(state.entries)).toEqual(["/tmp/a.md"]);
      });
      const fromState = [...(prePopulateCacheFromStateMock.mock.calls.at(-1)![0] as Map<string, unknown>).keys()];
      expect(fromState.every((p) => p === "/tmp/a.md")).toBe(true);
    });

    it("heal deferred when no embedding key — detect runs key-free, no reindex", async () => {
      const { ctx } = makeContext(hostRoot, {}, {
        pluginDataDir: hostRoot,
        configValues: {
          apiKeySource: "plugin",
          embeddingProvider: "openai",
        },
      });
      // No secret → no embedding key available.
      ctx.hostApi.getSecret = vi.fn(() => null);
      reconcileMock.mockResolvedValue({
        checked: true,
        drifted_docs: [{ doc_id: "d1", path: "/tmp/drift-1.md" }],
        drifted_doc_count: 1,
        orphan_vectors_deleted: 0,
      });
      const plugin = await createPlugin(ctx);

      reindexMock.mockClear();
      // openai embedding requires a key, so index_scan itself throws — but the
      // background warmup (key-free reconcile detect) still runs.
      try { await plugin.handlers.index_scan(); } catch { /* expected: no key */ }

      await vi.waitFor(
        () => {
          expect(reconcileMock).toHaveBeenCalled();
        },
        { timeout: 3000 },
      );
      // Detect ran (key-free), but heal is deferred — no reindex without a key.
      expect(reindexMock).not.toHaveBeenCalled();
      const logged = (ctx.hostApi.logEvent as ReturnType<typeof vi.fn>).mock.calls.some(
        ([, event]: [string, string]) => event === "local_indexer.reconcile_heal_deferred",
      );
      expect(logged).toBe(true);
    });
  });
});
