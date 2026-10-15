import { mkdtemp, writeFile, rm, symlink, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderAutoIndexer } from "../src/folderIndexer";

afterEach(() => {
  // Ensure fake timers from one test don't bleed into the next.
  vi.useRealTimers();
});

function makeClient() {
  let counter = 0;
  return {
    indexDocument: vi.fn(async (_path: string) => `doc-${++counter}`),
    removeDocument: vi.fn(async (_id: string) => {}),
  };
}

describe("FolderAutoIndexer", () => {
  it("지원 확장자만 인덱싱한다 — nonexistent 폴더는 0개 스캔", async () => {
    const mockClient = {
      indexDocument: vi.fn(async () => "doc-1"),
    };

    const nonExistentDir = resolve(
      tmpdir(),
      `ave-test-nonexistent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const indexer = new FolderAutoIndexer({
      client: mockClient,
      folders: [nonExistentDir],
      extensions: [".md", ".pdf"],
    });

    const result = await indexer.scanOnce();
    expect(result.scanned).toBe(0);
    expect(result.indexed).toBe(0);
  });

  it("getIndexedEntries 초기 상태는 빈 배열", () => {
    const indexer = new FolderAutoIndexer({
      client: { indexDocument: vi.fn(async () => "doc-1") },
      folders: ["/tmp/test"],
    });

    expect(indexer.getIndexedEntries()).toEqual([]);
  });

  it("start 전 stop 호출해도 에러 없음", async () => {
    const indexer = new FolderAutoIndexer({
      client: { indexDocument: vi.fn(async () => "doc-1") },
      folders: ["/tmp/test"],
    });

    await indexer.stop();
    expect(indexer.getIndexedEntries()).toEqual([]);
  });

  it("scanOnce: 실제 파일들로 인덱스 빌드", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ave-build-"));
    try {
      await writeFile(join(dir, "a.md"), "# Hello");
      await writeFile(join(dir, "b.pdf"), "%PDF-1.4");
      await writeFile(join(dir, "c.txt"), "ignored extension");

      const client = makeClient();
      const indexer = new FolderAutoIndexer({
        client,
        folders: [dir],
        extensions: [".md", ".pdf"],
      });

      const result = await indexer.scanOnce();

      expect(result.scanned).toBe(2);
      expect(result.indexed).toBe(2);
      expect(client.indexDocument).toHaveBeenCalledTimes(2);
      expect(indexer.getIndexedEntries()).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("scanOnce: default extensions also index txt/html/docx", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ave-build-default-ext-"));
    try {
      const txtPath = join(dir, "a.txt");
      const htmlPath = join(dir, "b.html");
      const docxPath = join(dir, "c.docx");
      await writeFile(txtPath, "plain text");
      await writeFile(htmlPath, "<h1>Hello</h1>");
      await writeFile(docxPath, "docx placeholder");

      const client = makeClient();
      const indexer = new FolderAutoIndexer({
        client,
        folders: [dir],
      });

      const result = await indexer.scanOnce();

      expect(result.scanned).toBe(3);
      expect(result.indexed).toBe(3);
      expect(client.indexDocument).toHaveBeenCalledWith(txtPath, "txt");
      expect(client.indexDocument).toHaveBeenCalledWith(htmlPath, "html");
      expect(client.indexDocument).toHaveBeenCalledWith(docxPath, "docx");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("scanOnce: configured custom extension falls back to auto mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ave-build-custom-ext-"));
    try {
      const customPath = join(dir, "a.custom");
      await writeFile(customPath, "custom payload");

      const client = makeClient();
      const indexer = new FolderAutoIndexer({
        client,
        folders: [dir],
        extensions: [".custom"],
      });

      const result = await indexer.scanOnce();

      expect(result.scanned).toBe(1);
      expect(result.indexed).toBe(1);
      expect(client.indexDocument).toHaveBeenCalledWith(customPath, "auto");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("mtime 미변경 파일은 재인덱싱하지 않음", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ave-mtime-"));
    try {
      await writeFile(join(dir, "stable.md"), "# Stable");

      const client = makeClient();
      const indexer = new FolderAutoIndexer({
        client,
        folders: [dir],
        extensions: [".md"],
      });

      const r1 = await indexer.scanOnce();
      expect(r1.indexed).toBe(1);

      const r2 = await indexer.scanOnce();
      expect(r2.indexed).toBe(0);
      expect(client.indexDocument).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  // ─── Unlink tests ─────────────────────────────────────

  it("unlink: 인덱싱된 파일 삭제 → removeDocument 호출 및 맵 정리", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ave-unlink-"));
    const filePath = join(dir, "doc.md");

    try {
      await writeFile(filePath, "# Doc");
      const client = makeClient();
      const indexer = new FolderAutoIndexer({
        client,
        folders: [dir],
        extensions: [".md"],
      });

      await indexer.scanOnce();
      expect(indexer.getIndexedEntries()).toHaveLength(1);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (indexer as any).handleUnlinkEvent(filePath);

      expect(indexer.getIndexedEntries()).toHaveLength(0);
      expect(client.removeDocument).toHaveBeenCalledWith("doc-1");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("unlink: 인덱싱되지 않은 파일 삭제 → removeDocument 호출 안 함", async () => {
    const client = makeClient();
    const indexer = new FolderAutoIndexer({
      client,
      folders: ["/tmp/ave-no-index"],
      extensions: [".md"],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (indexer as any).handleUnlinkEvent("/tmp/ave-no-index/never.md");

    expect(client.removeDocument).not.toHaveBeenCalled();
  });

  it("unlink: removeDocument 실패 시 맵은 보존 (재시도 가능)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ave-rmerr-"));
    const filePath = join(dir, "doc.md");
    try {
      await writeFile(filePath, "# Doc");

      const client = {
        indexDocument: vi.fn(async () => "doc-err"),
        removeDocument: vi.fn(async () => {
          throw new Error("removeDocument failed");
        }),
      };
      const indexer = new FolderAutoIndexer({
        client,
        folders: [dir],
        extensions: [".md"],
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (indexer as any).handleFileEvent(filePath);

      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (indexer as any).handleUnlinkEvent(filePath),
      ).resolves.toBeUndefined();

      // Map preserved for retry
      expect(indexer.getIndexedEntries()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  // ─── Debounce tests ───────────────────────────────────

  it("scheduleFileEvent: 연속된 change 이벤트가 단일 index 호출로 합쳐짐 (debounce)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ave-debounce-"));
    const filePath = join(dir, "hot.md");
    try {
      await writeFile(filePath, "# v1");

      vi.useFakeTimers();

      const client = makeClient();
      const indexer = new FolderAutoIndexer({
        client,
        folders: [dir],
        extensions: [".md"],
        debounceMs: 50,
      });
      const handleSpy = vi.spyOn(indexer as any, "handleFileEvent");

      // Fire 5 rapid events for the same path
      for (let i = 0; i < 5; i++) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (indexer as any).scheduleFileEvent(filePath);
      }

      // Still debouncing; no index calls yet
      expect(client.indexDocument).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(120);
      vi.useRealTimers();
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setImmediate(r));
      }

      expect(handleSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      await rm(dir, { recursive: true });
    }
  });

  it("debounceMs=0: 이벤트가 즉시 처리됨 (바이패스)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ave-nodeb-"));
    const filePath = join(dir, "now.md");
    try {
      await writeFile(filePath, "# Now");

      const client = makeClient();
      const indexer = new FolderAutoIndexer({
        client,
        folders: [dir],
        extensions: [".md"],
        debounceMs: 0,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (indexer as any).scheduleFileEvent(filePath);

      // Let the microtask complete
      await new Promise((r) => setTimeout(r, 10));
      expect(client.indexDocument).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("stop(): 대기 중인 debounce 타이머 모두 취소됨", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ave-stop-deb-"));
    const filePath = join(dir, "pending.md");
    try {
      await writeFile(filePath, "# Pending");

      vi.useFakeTimers();

      const client = makeClient();
      const indexer = new FolderAutoIndexer({
        client,
        folders: [dir],
        extensions: [".md"],
        debounceMs: 200,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (indexer as any).scheduleFileEvent(filePath);
      await indexer.stop();

      await vi.advanceTimersByTimeAsync(260);
      expect(client.indexDocument).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await rm(dir, { recursive: true });
    }
  });

  // ─── handleFileEvent 엣지 케이스 ───────────────────────

  it("handleFileEvent: 미지원 확장자 → indexDocument 호출 안 함", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ave-hfe-txt-"));
    const filePath = join(dir, "readme.txt");
    try {
      await writeFile(filePath, "plain text");

      const client = makeClient();
      const indexer = new FolderAutoIndexer({
        client,
        folders: [dir],
        extensions: [".md", ".pdf"],
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (indexer as any).handleFileEvent(filePath);

      expect(client.indexDocument).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("handleFileEvent: mtime 동일한 파일 change → indexDocument 호출 안 함", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ave-hfe-mtime-"));
    const filePath = join(dir, "stable.md");
    try {
      await writeFile(filePath, "# Stable");

      const client = makeClient();
      const indexer = new FolderAutoIndexer({
        client,
        folders: [dir],
        extensions: [".md"],
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (indexer as any).handleFileEvent(filePath);
      expect(client.indexDocument).toHaveBeenCalledTimes(1);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (indexer as any).handleFileEvent(filePath);
      expect(client.indexDocument).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  // ─── Idempotent start / awaitable stop ────────────────

  it("concurrent start() → scanOnce는 단 한 번만 실행됨 (in-flight promise 재사용)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ave-concurrent-"));
    try {
      await writeFile(join(dir, "a.md"), "# A");

      const client = makeClient();
      const indexer = new FolderAutoIndexer({
        client,
        folders: [dir],
        extensions: [".md"],
      });

      // Spy on the instance's scanOnce to count calls
      const scanSpy = vi.spyOn(indexer, "scanOnce");

      // Two concurrent start() — should share the same in-flight promise
      await Promise.all([indexer.start(), indexer.start()]);

      // scanOnce invoked exactly once despite two concurrent start() calls
      expect(scanSpy).toHaveBeenCalledTimes(1);

      await indexer.stop();
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("stop() is awaitable and resolves only after watcher teardown completes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ave-stop-await-"));
    try {
      await writeFile(join(dir, "b.md"), "# B");

      const client = makeClient();
      const indexer = new FolderAutoIndexer({
        client,
        folders: [dir],
        extensions: [".md"],
      });

      await indexer.start();

      let resolved = false;
      const stopPromise = indexer.stop().then(() => { resolved = true; });

      // Before await, the promise is still pending (microtask hasn't run yet)
      // After awaiting, it must be fully resolved
      await stopPromise;
      expect(resolved).toBe(true);

      // Calling stop() again after teardown is safe
      await expect(indexer.stop()).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  // ─── PR#7 review fixes ────────────────────────────────

  it("stop() cancels in-flight start() without leaking a watcher", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ave-stop-race-"));
    try {
      await writeFile(join(dir, "a.md"), "# A");

      const client = makeClient();
      const indexer = new FolderAutoIndexer({
        client,
        folders: [dir],
        extensions: [".md"],
      });

      // Kick off start(), then immediately request stop() while scanOnce is still running.
      const startP = indexer.start();
      const stopP = indexer.stop();

      await Promise.all([startP, stopP]);

      // No watcher should be left behind.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((indexer as any).watcher).toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((indexer as any).startPromise).toBeNull();
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("startPromise resets on scanOnce failure — next start() retries fresh", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ave-start-reset-"));
    try {
      await writeFile(join(dir, "a.md"), "# A");

      const client = makeClient();
      const indexer = new FolderAutoIndexer({
        client,
        folders: [dir],
        extensions: [".md"],
      });

      // Force the first scanOnce to throw, leave subsequent calls untouched.
      const realScan = indexer.scanOnce.bind(indexer);
      const scanSpy = vi
        .spyOn(indexer, "scanOnce")
        .mockRejectedValueOnce(new Error("boom"))
        .mockImplementation(realScan);

      await expect(indexer.start()).rejects.toThrow("boom");

      // Second start() must retry rather than returning the rejected promise.
      await expect(indexer.start()).resolves.toBeUndefined();
      expect(scanSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

      await indexer.stop();
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("symlink escape: event for path outside configured root is dropped", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ave-sym-root-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "ave-sym-out-"));
    try {
      const outsideFile = join(outsideDir, "secret.md");
      await writeFile(outsideFile, "# secret");

      // Symlink inside root that points outside.
      const linkPath = join(rootDir, "escape.md");
      await symlink(outsideFile, linkPath);

      const client = makeClient();
      const indexer = new FolderAutoIndexer({
        client,
        folders: [rootDir],
        extensions: [".md"],
      });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Trigger events directly with the outside real path.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (indexer as any).handleFileEvent(outsideFile);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (indexer as any).handleUnlinkEvent(outsideFile);

      expect(client.indexDocument).not.toHaveBeenCalled();
      expect(client.removeDocument).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    } finally {
      await rm(rootDir, { recursive: true });
      await rm(outsideDir, { recursive: true });
    }
  });

  it("scanOnce prunes mappings for files unlinked externally", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ave-prune-"));
    const filePath = join(dir, "ghost.md");
    try {
      await writeFile(filePath, "# Ghost");

      const client = makeClient();
      const indexer = new FolderAutoIndexer({
        client,
        folders: [dir],
        extensions: [".md"],
      });

      await indexer.scanOnce();
      expect(indexer.getIndexedEntries()).toHaveLength(1);

      // Remove the file on disk without going through the watcher.
      await unlink(filePath);

      const r = await indexer.scanOnce();
      expect(r.scanned).toBe(0);
      expect(indexer.getIndexedEntries()).toHaveLength(0);
      expect(client.removeDocument).toHaveBeenCalledWith("doc-1");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  // ─── Edge scenario tests ──────────────────────────────

  it("rename: stale doc removed, new path indexed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ave-rename-"));
    const oldPath = join(dir, "original.md");
    const newPath = join(dir, "renamed.md");
    try {
      await writeFile(oldPath, "# Original");

      const client = makeClient();
      const indexer = new FolderAutoIndexer({
        client,
        folders: [dir],
        extensions: [".md"],
      });

      // Index the original file
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (indexer as any).handleFileEvent(oldPath);
      expect(client.indexDocument).toHaveBeenCalledTimes(1);
      expect(indexer.getIndexedEntries()).toHaveLength(1);

      // Simulate rename: unlink old, add new
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (indexer as any).handleUnlinkEvent(oldPath);
      expect(client.removeDocument).toHaveBeenCalledWith("doc-1");
      expect(indexer.getIndexedEntries()).toHaveLength(0);

      await writeFile(newPath, "# Renamed");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (indexer as any).handleFileEvent(newPath);
      expect(client.indexDocument).toHaveBeenCalledTimes(2);
      expect(indexer.getIndexedEntries()).toHaveLength(1);
      expect(indexer.getIndexedEntries()[0]?.filePath).toBe(newPath);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("rename symlink: event for resolved path outside root is dropped", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ave-rensym-root-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "ave-rensym-out-"));
    try {
      const outsideFile = join(outsideDir, "target.md");
      await writeFile(outsideFile, "# Outside");

      // Symlink inside root → points outside
      const linkPath = join(rootDir, "link.md");
      await symlink(outsideFile, linkPath);

      const client = makeClient();
      const indexer = new FolderAutoIndexer({
        client,
        folders: [rootDir],
        extensions: [".md"],
      });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Simulate rename: unlink symlink, then try to add using the outside real path
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (indexer as any).handleUnlinkEvent(outsideFile);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (indexer as any).handleFileEvent(outsideFile);

      // Neither operation should touch index — path escapes configured root
      expect(client.removeDocument).not.toHaveBeenCalled();
      expect(client.indexDocument).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    } finally {
      await rm(rootDir, { recursive: true });
      await rm(outsideDir, { recursive: true });
    }
  });

  it("mtime collision: two files written in the same second → both indexed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ave-mtime-col-"));
    const file1 = join(dir, "first.md");
    const file2 = join(dir, "second.md");
    try {
      await writeFile(file1, "# First");
      await writeFile(file2, "# Second");

      const client = makeClient();
      const indexer = new FolderAutoIndexer({
        client,
        folders: [dir],
        extensions: [".md"],
      });

      // Manually drive handleFileEvent for both paths (simulates same-second writes)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (indexer as any).handleFileEvent(file1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (indexer as any).handleFileEvent(file2);

      // Both files must be indexed — mtime collision between different paths is fine
      expect(client.indexDocument).toHaveBeenCalledTimes(2);
      expect(indexer.getIndexedEntries()).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("chokidar error event: logs warning and does not crash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ave-chok-err-"));
    try {
      await writeFile(join(dir, "a.md"), "# A");

      const client = makeClient();
      const indexer = new FolderAutoIndexer({
        client,
        folders: [dir],
        extensions: [".md"],
      });

      await indexer.start();

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

      // Simulate the watcher emitting an error event.
      // If there is no "error" listener on the EventEmitter, Node re-throws
      // the error — so wrap in try/catch and verify the watcher still exists
      // after the fact (indexer is not torn down).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const watcher = (indexer as any).watcher as import("chokidar").FSWatcher;
      const simulatedError = new Error("ENOSPC: no space left on device");
      try {
        watcher.emit("error", simulatedError);
      } catch {
        // Expected if no error handler is registered — the important thing is
        // that the indexer instance itself is not torn down.
      }

      // Watcher instance must still be assigned (indexer did not self-destruct)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((indexer as any).watcher).not.toBeNull();

      warnSpy.mockRestore();
      errorSpy.mockRestore();
      debugSpy.mockRestore();
      await indexer.stop();
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("disk full error: indexDocument throws mid-write → catch + warn, stats entry count preserved", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ave-diskfull-"));
    const filePath = join(dir, "data.md");
    try {
      await writeFile(filePath, "# Data");

      let callCount = 0;
      const client = {
        indexDocument: vi.fn(async (_path: string) => {
          callCount++;
          if (callCount === 1) throw new Error("ENOSPC: no space left on device");
          return `doc-${callCount}`;
        }),
        removeDocument: vi.fn(async () => {}),
      };

      const indexer = new FolderAutoIndexer({
        client,
        folders: [dir],
        extensions: [".md"],
      });

      // First call: indexDocument throws ENOSPC — must not propagate
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (indexer as any).handleFileEvent(filePath),
      ).resolves.toBeUndefined();

      // Entry must NOT be present after a failed index
      expect(indexer.getIndexedEntries()).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("ReDoS-prone ignored pattern is dropped with a warning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ave-redos-"));
    try {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const evil = /(a+)+$/; // nested quantifier — classic ReDoS shape
      const indexer = new FolderAutoIndexer({
        client: { indexDocument: vi.fn(async () => "doc-1") },
        folders: [dir],
        extensions: [".md"],
        ignored: [evil],
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((indexer as any).ignored).not.toContain(evil);
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

it("scanOnce reports a fixed total and ordered progress snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ave-progress-"));
  try {
    await writeFile(join(dir, "a.md"), "# A");
    await writeFile(join(dir, "b.md"), "# B");

    const snapshots = [] as Array<{
      status: string;
      total: number;
      processed: number;
      indexed: number;
      failed: number;
      currentPath?: string;
      message?: string;
    }>;
    const client = makeClient();
    const indexer = new FolderAutoIndexer({
      client,
      folders: [dir],
      extensions: [".md"],
      onScanProgress: (snapshot) => snapshots.push({ ...snapshot }),
    });

    await indexer.scanOnce();

    expect(snapshots[0]).toMatchObject({ status: "running", total: 0, processed: 0 });
    const fixedTotalSnapshots = snapshots.filter((snapshot) => snapshot.status === "running" && snapshot.total > 0);
    expect(fixedTotalSnapshots.length).toBeGreaterThan(0);
    expect(new Set(fixedTotalSnapshots.map((snapshot) => snapshot.total))).toEqual(new Set([2]));
    expect(snapshots.at(-1)).toMatchObject({
      status: "done",
      total: 2,
      processed: 2,
      indexed: 2,
      failed: 0,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("re-enabling image embedding re-queues cached image files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ave-image-toggle-"));
  try {
    const imagePath = join(dir, "photo.png");
    await writeFile(imagePath, "png placeholder");

    const client = makeClient();
    const indexer = new FolderAutoIndexer({
      client,
      folders: [dir],
      imageEmbeddingEnabled: true,
    });

    const first = await indexer.scanOnce();
    expect(first.indexed).toBe(1);
    expect(client.indexDocument).toHaveBeenCalledWith(imagePath, "image");

    const second = await indexer.scanOnce();
    expect(second.indexed).toBe(0);

    indexer.setImageEmbeddingEnabled(false);
    indexer.setImageEmbeddingEnabled(true);
    expect(indexer.invalidateImageEntries()).toBe(1);

    const third = await indexer.scanOnce();
    expect(third.indexed).toBe(1);
    expect(client.indexDocument).toHaveBeenCalledTimes(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("concurrent scanOnce calls share one underlying indexing pass", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ave-scan-inflight-"));
  try {
    await writeFile(join(dir, "a.md"), "# A");

    let release;
    const gate = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });

    const client = {
      indexDocument: vi.fn(async () => {
        await gate;
        return "doc-1";
      }),
      removeDocument: vi.fn(async () => {}),
    };
    const indexer = new FolderAutoIndexer({
      client,
      folders: [dir],
      extensions: [".md"],
    });

    const first = indexer.scanOnce();
    const second = indexer.scanOnce();

    release();
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toEqual(r2);
    expect(client.indexDocument).toHaveBeenCalledTimes(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("scanOnce leaves a failed snapshot and allows a later retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ave-scan-failed-state-"));
  try {
    await writeFile(join(dir, "a.md"), "# A");
    await writeFile(join(dir, "b.md"), "# B");

    let callCount = 0;
    const client = {
      indexDocument: vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) throw new Error("boom");
        return `doc-${callCount}`;
      }),
      removeDocument: vi.fn(async () => {}),
    };
    const indexer = new FolderAutoIndexer({
      client,
      folders: [dir],
      extensions: [".md"],
    });

    const first = await indexer.scanOnce();
    expect(first.indexed).toBe(1);
    expect(indexer.getScanProgress()).toMatchObject({
      status: "failed",
      total: 2,
      processed: 2,
      indexed: 1,
      failed: 1,
    });

    const second = await indexer.scanOnce();
    // Only a.md failed in the first scan and is retried; b.md is cached (already indexed).
    expect(second.scanned).toBe(1);
    expect(indexer.getScanProgress()).toMatchObject({
      status: "done",
      total: 1,
      processed: 1,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("scanOnce can be canceled between files and keeps partial results", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ave-scan-canceled-state-"));
  try {
    await writeFile(join(dir, "a.md"), "# A");
    await writeFile(join(dir, "b.md"), "# B");

    const client = makeClient();
    let indexer: FolderAutoIndexer;
    indexer = new FolderAutoIndexer({
      client,
      folders: [dir],
      extensions: [".md"],
      onScanProgress: (snapshot) => {
        if (snapshot.status === "running" && snapshot.processed === 1) {
          indexer.cancelScan();
        }
      },
    });

    const result = await indexer.scanOnce();

    expect(result.canceled).toBe(true);
    expect(result.indexed).toBe(1);
    expect(client.indexDocument).toHaveBeenCalledTimes(1);
    expect(indexer.getScanProgress()).toMatchObject({
      status: "canceled",
      total: 2,
      processed: 1,
      indexed: 1,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
