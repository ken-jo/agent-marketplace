/**
 * D7 — ad-hoc path indexing unit test (index_scan{paths} dispatch).
 *
 * Verifies that calling index_scan({ paths }) — which dispatches to the reused
 * former document_index_scan body — indexes each path via the
 * workerClient.indexDocument method and returns the expected result shape.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { fsPromisesMockState } = vi.hoisted(() => ({
  fsPromisesMockState: {
    realReaddir: null as null | typeof import("node:fs/promises").readdir,
    realLstat: null as null | typeof import("node:fs/promises").lstat,
    readdirMock: vi.fn(),
    lstatMock: vi.fn(),
  },
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  fsPromisesMockState.realReaddir = actual.readdir;
  fsPromisesMockState.realLstat = actual.lstat;
  fsPromisesMockState.readdirMock.mockImplementation(actual.readdir);
  fsPromisesMockState.lstatMock.mockImplementation(actual.lstat);
  return {
    ...actual,
    readdir: fsPromisesMockState.readdirMock,
    lstat: fsPromisesMockState.lstatMock,
  };
});

// ─── spawn mock ─────────────────────────────────────────────────────────────
vi.mock("node:child_process", () => {
  const { EventEmitter } = require("node:events");
  function makeChild() {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter() as any;
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = vi.fn();
    child.pid = 99999;
    return child;
  }
  const execFile = vi.fn((...args: any[]) => {
    const cb = args.at(-1);
    if (typeof cb === "function") cb(null, "", "");
  });
  return { spawn: vi.fn(() => makeChild()), execFile };
});

// ─── FolderAutoIndexer mock ──────────────────────────────────────────────────
vi.mock("../src/folderIndexer.js", () => {
  class FolderAutoIndexer {
    client: any;
    folders: string[];
    constructor(opts: { client: any; folders: string[] }) {
      this.client = opts.client;
      this.folders = opts.folders;
    }
    async start() {}
    async ensureWatching() {}
    stop() {}
    async scanOnce() { return { indexed: 0, totalIndexed: 0, folders: this.folders }; }
  }
  return { FolderAutoIndexer };
});

// ─── LocalIndexerPlugin mock: indexDocument counts calls ───────────────────
const indexDocumentMock = vi.fn(async (_fp: string, _mode: string) => "doc-id-1");
const setAllowedRootsMock = vi.fn(async (roots: string[], _token: string) => ({ roots, count: roots.length }));

vi.mock("../src/localIndexerPlugin.js", () => {
  class LocalIndexerPlugin {
    constructor(_opts: any) {}
    getWorkerClient() {
      return {
        indexDocument: indexDocumentMock,
        searchBm25: vi.fn(async () => []),
        setAllowedRoots: setAllowedRootsMock,
      };
    }
    async start() {}
    async stop() {}
    getShutdownToken() { return "test-shutdown-token"; }
    async listDocuments() { return []; }
  }
  return { LocalIndexerPlugin };
});

import createPlugin from "../src/hostPlugin.js";

function makeContext(hostRoot: string) {
  const ctx = {
    pluginId: "local-indexer",
    pluginRoot: hostRoot,
    hostRoot,
    // Required by PluginRuntimeContext — scope plugin state under the
    // per-test temp dir so each run is isolated.
    pluginDataDir: join(hostRoot, "plugin-data"),
    userHome: join(hostRoot, "user-home"),
    aveHome: join(hostRoot, "user-home", ".ave"),
    config: { scanFolders: [hostRoot] },
    log: vi.fn(),
    hostApi: {
      emitEvent: vi.fn(),
      onEvent: vi.fn(),
      addTask: vi.fn(),
      saveNote: vi.fn(),
      config: {
        get: vi.fn(() => undefined),
        set: vi.fn(async () => {}),
        onChange: vi.fn(() => () => {}),
      },
      getSecret: vi.fn(() => null),
      hostFetch: vi.fn(async () => new Response("{}", { status: 200 })),
      logEvent: vi.fn(),
      onShutdown: vi.fn(),
    },
  };
  return ctx;
}

describe("index_scan{paths} dispatch (former document_index_scan)", () => {
  let hostRoot: string;

  beforeEach(async () => {
    hostRoot = await mkdtemp(join(tmpdir(), "ave-scan-"));
    indexDocumentMock.mockClear();
    setAllowedRootsMock.mockClear();
    fsPromisesMockState.readdirMock.mockImplementation((...args) => fsPromisesMockState.realReaddir!(...args));
    fsPromisesMockState.lstatMock.mockImplementation((...args) => fsPromisesMockState.realLstat!(...args));
  });

  afterEach(async () => {
    await rm(hostRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("indexes each provided path and returns indexed count", async () => {
    const pdfPath = join(hostRoot, "a.pdf");
    const mdPath = join(hostRoot, "b.md");
    await writeFile(pdfPath, "%PDF-1.4");
    await writeFile(mdPath, "# hello");

    const plugin = await createPlugin(makeContext(hostRoot) as any);
    await plugin.start();

    const result = await plugin.handlers.index_scan({ paths: [pdfPath, mdPath] }) as {
      indexed: number;
      failed: number;
      jobId: string;
      message: string;
    };

    expect(indexDocumentMock).toHaveBeenCalledTimes(2);
    expect(indexDocumentMock).toHaveBeenCalledWith(pdfPath, "pdf");
    expect(indexDocumentMock).toHaveBeenCalledWith(mdPath, "md");
    expect(result.indexed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.jobId).toMatch(/^drop-\d+$/);
  });

  it("recursively expands dropped folders and syncs allowed roots", async () => {
    const dropDir = join(hostRoot, "drop");
    const nestedDir = join(dropDir, "nested");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(join(dropDir, "a.pdf"), "%PDF-1.4");
    await writeFile(join(nestedDir, "b.md"), "# hello");
    await writeFile(join(nestedDir, "ignore.png"), "png");

    const plugin = await createPlugin(makeContext(hostRoot) as any);
    await plugin.start();

    const result = await plugin.handlers.index_scan({ paths: [dropDir] }) as {
      indexed: number;
      failed: number;
      jobId: string;
      message: string;
    };

    expect(indexDocumentMock).toHaveBeenCalledTimes(2);
    expect(indexDocumentMock).toHaveBeenCalledWith(join(dropDir, "a.pdf"), "pdf");
    expect(indexDocumentMock).toHaveBeenCalledWith(join(nestedDir, "b.md"), "md");
    expect(result.indexed).toBe(2);
    expect(result.failed).toBe(0);
    expect(setAllowedRootsMock).toHaveBeenCalled();
    expect(setAllowedRootsMock.mock.calls.at(-1)?.[0]).toContain(dropDir);
  });

  it("returns indexed=0 when paths array is empty", async () => {
    const plugin = await createPlugin(makeContext(hostRoot) as any);
    await plugin.start();

    const result = await plugin.handlers.index_scan({ paths: [] }) as {
      indexed: number;
      failed: number;
      message: string;
    };

    expect(indexDocumentMock).not.toHaveBeenCalled();
    expect(result.indexed).toBe(0);
  });

  it("skips blocked dropped roots without widening worker allowed roots", async () => {
    const blockedRoot = process.platform === "win32" ? "C:\\Windows" : "/etc";

    const plugin = await createPlugin(makeContext(hostRoot) as any);
    await plugin.start();

    const result = await plugin.handlers.index_scan({ paths: [blockedRoot] }) as {
      indexed: number;
      failed: number;
      message: string;
    };

    expect(result.indexed).toBe(0);
    expect(result.failed).toBe(0);
    expect(indexDocumentMock).not.toHaveBeenCalled();
    // When all paths are blocked, no files are expanded so syncAllowedRootsToWorker
    // is never called — the blocked root is never added to worker allowed roots.
    const allCalls = setAllowedRootsMock.mock.calls.flatMap((c) => c[0] as string[]);
    expect(allCalls).not.toContain(blockedRoot);
  });

  it("continues scanning when a nested directory is unreadable", async () => {
    const dropDir = join(hostRoot, "drop");
    const blockedDir = join(dropDir, "blocked");
    await mkdir(blockedDir, { recursive: true });
    const safeFile = join(dropDir, "safe.md");
    await writeFile(safeFile, "# hello");

    fsPromisesMockState.readdirMock.mockImplementation(async (path, options) => {
      if (String(path) === blockedDir) {
        throw new Error("EACCES");
      }
      return fsPromisesMockState.realReaddir!(path, options);
    });

    const plugin = await createPlugin(makeContext(hostRoot) as any);
    await plugin.start();

    const result = await plugin.handlers.index_scan({ paths: [dropDir] }) as {
      indexed: number;
      failed: number;
    };

    expect(result.indexed).toBe(1);
    expect(result.failed).toBe(0);
    expect(indexDocumentMock).toHaveBeenCalledWith(safeFile, "md");
  });

  it("counts failed paths when indexDocument throws", async () => {
    const badPath = join(hostRoot, "bad.pdf");
    const okPath = join(hostRoot, "ok.pdf");
    await writeFile(badPath, "%PDF-1.4");
    await writeFile(okPath, "%PDF-1.4");
    indexDocumentMock.mockRejectedValueOnce(new Error("worker error"));

    const plugin = await createPlugin(makeContext(hostRoot) as any);
    await plugin.start();

    const result = await plugin.handlers.index_scan({ paths: [badPath, okPath] }) as {
      indexed: number;
      failed: number;
    };

    expect(result.failed).toBe(1);
    expect(result.indexed).toBe(1);
  });
});
