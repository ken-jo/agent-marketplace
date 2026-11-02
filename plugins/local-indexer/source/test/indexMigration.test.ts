/**
 * The visible rebuild out of `<pluginDataDir>/index`: the old directory is
 * removed only after a verified rebuild, and kept for every lesser outcome.
 *
 * The scans here are real `FolderAutoIndexer` scans over real directories,
 * against a fake worker that keys documents by absolute path the way the
 * worker's `documents.path UNIQUE` column does. A premature delete, a folder
 * that could not be read, or a lost document all show up on disk.
 */
import { describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FolderAutoIndexer } from "../src/folderIndexer";
import {
  INDEX_MIGRATION_MAX_ATTEMPTS,
  migrateLegacyIndex,
  type FolderSource,
  type IndexMigrationDeps,
  type IndexMigrationStatus,
  type MigrationAttempts,
} from "../src/indexMigration";
import { WorkerCallError, WorkerIndexFailure } from "../src/workerClient";

/** The worker's documents table: one row per absolute path. */
class FakeWorkerIndex {
  readonly rows = new Map<string, string>();
  private next = 0;
  /** Paths whose indexing fails, and how. */
  readonly failures = new Map<string, () => Error>();

  readonly client = {
    indexDocument: vi.fn(async (filePath: string) => {
      const failure = this.failures.get(resolve(filePath));
      if (failure) throw failure();
      const key = resolve(filePath);
      const existing = this.rows.get(key);
      if (existing) return existing;
      const docId = `doc-${++this.next}`;
      this.rows.set(key, docId);
      return docId;
    }),
    removeDocument: vi.fn(async (docId: string) => {
      for (const [path, id] of this.rows) if (id === docId) this.rows.delete(path);
    }),
  };
}

interface Fixture {
  root: string;
  legacy: string;
  pluginDataDir: string;
}

async function withLegacy<T>(run: (fx: Fixture) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ave-li-migrate-"));
  const pluginDataDir = join(root, "data");
  const legacy = join(pluginDataDir, "index");
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, "fts5.sqlite"), "old index");
  try {
    return await run({ root, legacy, pluginDataDir });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function memoryAttempts(initial: MigrationAttempts = { attempts: 0 }) {
  let state: MigrationAttempts | null = { ...initial };
  return {
    get state() { return state; },
    read: vi.fn(async () => state ?? { attempts: 0 }),
    write: vi.fn(async (next: MigrationAttempts) => { state = { ...next }; }),
    clear: vi.fn(async () => { state = null; }),
  };
}

/** Migration deps driven by a real folder scan over `folders`. */
function scanDeps(
  fx: Fixture,
  worker: FakeWorkerIndex,
  folders: string[],
  opts: { folderSource?: FolderSource; attempts?: ReturnType<typeof memoryAttempts> } = {},
) {
  const reports: IndexMigrationStatus[] = [];
  const removeDirectory = vi.fn(async (path: string) => {
    await rm(path, { recursive: true, force: true });
  });
  const indexer = new FolderAutoIndexer({ client: worker.client, folders, extensions: [".md"] });
  const attempts = opts.attempts ?? memoryAttempts();
  const deps: IndexMigrationDeps = {
    location: {
      indexRoot: join(fx.root, "state", "index"),
      documentCount: 0,
      inStateDirectory: true,
      legacyIndexDir: fx.legacy,
    },
    workspace: join(fx.pluginDataDir, ".local-indexer-workspace"),
    runFullScan: async () => ({
      result: await indexer.scanOnce(),
      folderSource: opts.folderSource ?? "saved",
      registeredFolders: folders.length,
    }),
    verifyIndexed: async () => {
      const held = new Set(worker.rows.values());
      const missing = indexer.getIndexedEntries().filter((entry) => !held.has(entry.docId)).length;
      return { documentCount: worker.rows.size, missing };
    },
    removeDirectory,
    attempts,
    report: (s) => reports.push(structuredClone(s)),
  };
  return { deps, reports, removeDirectory, indexer, attempts };
}

async function writeDocs(dir: string, names: string[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const name of names) await writeFile(join(dir, name), `# ${name}`);
}

function expectKept(result: IndexMigrationStatus | null, fx: Fixture, reason: RegExp): void {
  expect(result?.phase).toBe("kept-old");
  expect(result?.reason).toMatch(reason);
  expect(existsSync(join(fx.legacy, "fts5.sqlite"))).toBe(true);
}

describe("migrateLegacyIndex — verified rebuild", () => {
  it("does nothing when there is no old index", async () => {
    await withLegacy(async (fx) => {
      const { deps, reports } = scanDeps(fx, new FakeWorkerIndex(), []);
      const result = await migrateLegacyIndex({ ...deps, location: { ...deps.location, legacyIndexDir: null } });
      expect(result).toBeNull();
      expect(reports).toEqual([]);
    });
  });

  it("deletes the old directory after a verified rebuild, and clears the attempt ledger", async () => {
    await withLegacy(async (fx) => {
      const docs = join(fx.root, "docs");
      await writeDocs(docs, ["a.md", "b.md", "c.md"]);
      const worker = new FakeWorkerIndex();
      const { deps, reports, attempts } = scanDeps(fx, worker, [docs], { attempts: memoryAttempts({ attempts: 2 }) });
      const result = await migrateLegacyIndex(deps);
      expect(result).toMatchObject({ phase: "completed", attempt: 3, documentsAfter: 3 });
      expect(result?.scan).toMatchObject({ walked: 3, scanned: 3, failed: 0, unreadableFolders: [] });
      expect(reports.map((r) => r.phase)).toEqual(["rebuilding", "completed"]);
      expect(existsSync(fx.legacy)).toBe(false);
      expect(existsSync(fx.pluginDataDir)).toBe(true);
      expect(attempts.state).toBeNull();
    });
  });

  it("keeps the old index while the rebuild runs", async () => {
    await withLegacy(async (fx) => {
      const docs = join(fx.root, "docs");
      await writeDocs(docs, ["a.md"]);
      const worker = new FakeWorkerIndex();
      worker.client.indexDocument.mockImplementationOnce(async () => {
        expect(existsSync(join(fx.legacy, "fts5.sqlite"))).toBe(true);
        return "doc-x";
      });
      worker.rows.set(resolve(docs, "a.md"), "doc-x");
      const { deps } = scanDeps(fx, worker, [docs]);
      expect((await migrateLegacyIndex(deps))?.phase).toBe("completed");
    });
  });

  it("an explicit empty folder list deletes: the user has no folders to rebuild", async () => {
    await withLegacy(async (fx) => {
      const { deps } = scanDeps(fx, new FakeWorkerIndex(), [], { folderSource: "saved" });
      const result = await migrateLegacyIndex(deps);
      expect(result).toMatchObject({ phase: "completed", scan: { registeredFolders: 0, walked: 0 } });
      expect(existsSync(fx.legacy)).toBe(false);
    });
  });

  it("a file the worker judges unindexable counts as done", async () => {
    await withLegacy(async (fx) => {
      const docs = join(fx.root, "docs");
      await writeDocs(docs, ["ok.md", "encrypted.md"]);
      const worker = new FakeWorkerIndex();
      worker.failures.set(
        resolve(docs, "encrypted.md"),
        () => new WorkerIndexFailure("indexDocument: 인덱싱 실패: encrypted", resolve(docs, "encrypted.md")),
      );
      const { deps } = scanDeps(fx, worker, [docs]);
      const result = await migrateLegacyIndex(deps);
      expect(result).toMatchObject({ phase: "completed", scan: { failed: 1, failedTransient: 0 } });
      expect(existsSync(fx.legacy)).toBe(false);
    });
  });

  it("a worker refusal of the file itself (invalid params, not found) counts as done", async () => {
    await withLegacy(async (fx) => {
      const docs = join(fx.root, "docs");
      await writeDocs(docs, ["ok.md", "outside.md"]);
      const worker = new FakeWorkerIndex();
      worker.failures.set(
        resolve(docs, "outside.md"),
        () => new WorkerCallError("path outside allowed roots", "worker-request-failed", -32602),
      );
      const { deps } = scanDeps(fx, worker, [docs]);
      expect((await migrateLegacyIndex(deps))?.phase).toBe("completed");
    });
  });

  it("two registered paths to the same files (a symlinked folder) still verify", async () => {
    await withLegacy(async (fx) => {
      const docs = join(fx.root, "docs");
      await writeDocs(docs, ["a.md", "b.md"]);
      const alias = join(fx.root, "docs-alias");
      await symlink(docs, alias, "dir");
      const worker = new FakeWorkerIndex();
      const { deps } = scanDeps(fx, worker, [docs, alias]);
      const result = await migrateLegacyIndex(deps);
      // The worker keys by absolute path, so each spelling is its own row,
      // and the scan holds the same documents the worker does.
      expect(result).toMatchObject({ phase: "completed", documentsAfter: 4, scan: { walked: 4 } });
      expect(worker.rows.size).toBe(4);
    });
  });
});

describe("migrateLegacyIndex — keeps the old index", () => {
  it("when a registered folder cannot be read (unmounted volume, gone)", async () => {
    await withLegacy(async (fx) => {
      const gone = join(fx.root, "unmounted-volume");
      const { deps, removeDirectory } = scanDeps(fx, new FakeWorkerIndex(), [gone]);
      const result = await migrateLegacyIndex(deps);
      expectKept(result, fx, /1 folder\(s\) could not be read/);
      expect(result?.scan?.unreadableFolders).toEqual([gone]);
      expect(removeDirectory).not.toHaveBeenCalled();
    });
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "when one folder reads and another is refused by the OS (partial)",
    async () => {
      await withLegacy(async (fx) => {
        const readable = join(fx.root, "readable");
        await writeDocs(readable, ["a.md"]);
        const refused = join(fx.root, "refused");
        await writeDocs(refused, ["secret.md"]);
        await chmod(refused, 0o000);
        try {
          const worker = new FakeWorkerIndex();
          const { deps } = scanDeps(fx, worker, [readable, refused]);
          const result = await migrateLegacyIndex(deps);
          expectKept(result, fx, /could not be read: .*refused/);
          // The readable folder was still rebuilt.
          expect(worker.rows.size).toBe(1);
        } finally {
          await chmod(refused, 0o755);
        }
      });
    },
  );

  it("when an unreadable subdirectory hides inside a readable folder", async () => {
    await withLegacy(async (fx) => {
      const docs = join(fx.root, "docs");
      await writeDocs(docs, ["a.md"]);
      const worker = new FakeWorkerIndex();
      const { deps, indexer } = scanDeps(fx, worker, [docs]);
      // Make the listing of one nested directory fail the way EPERM does.
      const nested = join(docs, "nested");
      await mkdir(nested);
      const original = (indexer as unknown as { walkDir: Function }).walkDir.bind(indexer);
      (indexer as unknown as { walkDir: Function }).walkDir = async (
        dir: string,
        readdir: Function,
        unreadable: string[],
      ) => original(dir, async (p: string, o: unknown) => {
        if (p === nested) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
        return readdir(p, o);
      }, unreadable);
      expectKept(await migrateLegacyIndex(deps), fx, /could not be read: .*nested/);
    });
  });

  it("when the scan used the default folders because the saved list was missing or corrupt", async () => {
    await withLegacy(async (fx) => {
      const docs = join(fx.root, "fixtures");
      await writeDocs(docs, ["a.md"]);
      const { deps } = scanDeps(fx, new FakeWorkerIndex(), [docs], { folderSource: "fallback" });
      expectKept(await migrateLegacyIndex(deps), fx, /saved folder list was missing or unreadable/);
    });
  });

  it("when the registered folders held no files at all", async () => {
    await withLegacy(async (fx) => {
      const empty = join(fx.root, "empty");
      await mkdir(empty);
      const { deps } = scanDeps(fx, new FakeWorkerIndex(), [empty]);
      expectKept(await migrateLegacyIndex(deps), fx, /registered folder\(s\) held no files/);
    });
  });

  it("when a file failed for a reason that may pass (the worker was lost)", async () => {
    await withLegacy(async (fx) => {
      const docs = join(fx.root, "docs");
      await writeDocs(docs, ["a.md", "b.md"]);
      const worker = new FakeWorkerIndex();
      worker.failures.set(
        resolve(docs, "b.md"),
        () => new WorkerCallError("indexer_reindex: worker-incarnation-ended", "worker-incarnation-ended"),
      );
      const { deps } = scanDeps(fx, worker, [docs]);
      const result = await migrateLegacyIndex(deps);
      expectKept(result, fx, /1 file\(s\) failed for a reason that may pass/);
      expect(result?.scan).toMatchObject({ failed: 1, failedTransient: 1 });
    });
  });

  it("when an unexpected worker error (-32000) or an unknown error failed a file", async () => {
    for (const make of [
      () => new WorkerCallError("disk I/O error", "worker-request-failed", -32000),
      () => new Error("something else"),
    ]) {
      await withLegacy(async (fx) => {
        const docs = join(fx.root, "docs");
        await writeDocs(docs, ["a.md"]);
        const worker = new FakeWorkerIndex();
        worker.failures.set(resolve(docs, "a.md"), make);
        const { deps } = scanDeps(fx, worker, [docs]);
        expectKept(await migrateLegacyIndex(deps), fx, /may pass/);
      });
    }
  });

  it("when a document the scan indexed is missing from the worker", async () => {
    await withLegacy(async (fx) => {
      const docs = join(fx.root, "docs");
      await writeDocs(docs, ["a.md", "b.md"]);
      const worker = new FakeWorkerIndex();
      const { deps } = scanDeps(fx, worker, [docs]);
      const verify = deps.verifyIndexed;
      deps.verifyIndexed = async () => {
        worker.rows.delete(resolve(docs, "a.md")); // lost after indexing
        return verify();
      };
      expectKept(await migrateLegacyIndex(deps), fx, /1 document\(s\) the scan indexed are missing/);
    });
  });

  it("when the scan throws, the count cannot be read, or the removal fails", async () => {
    await withLegacy(async (fx) => {
      const docs = join(fx.root, "docs");
      await writeDocs(docs, ["a.md"]);
      const a = scanDeps(fx, new FakeWorkerIndex(), [docs]);
      a.deps.runFullScan = async () => { throw new Error("worker gone"); };
      expectKept(await migrateLegacyIndex(a.deps), fx, /rebuild scan failed: worker gone/);
      const b = scanDeps(fx, new FakeWorkerIndex(), [docs]);
      b.deps.verifyIndexed = async () => { throw new Error("timeout"); };
      expectKept(await migrateLegacyIndex(b.deps), fx, /did not report its documents: timeout/);
      const c = scanDeps(fx, new FakeWorkerIndex(), [docs]);
      c.deps.removeDirectory = async () => { throw new Error("EACCES"); };
      expectKept(await migrateLegacyIndex(c.deps), fx, /could not be removed: EACCES/);
    });
  });

  it("never deletes a directory that holds the new index or the workspace", async () => {
    await withLegacy(async (fx) => {
      const scan = vi.fn();
      const a = scanDeps(fx, new FakeWorkerIndex(), []);
      a.deps.runFullScan = scan;
      expectKept(
        await migrateLegacyIndex({ ...a.deps, location: { ...a.deps.location, indexRoot: join(fx.legacy, "nested") } }),
        fx,
        /inside the old index directory/,
      );
      const b = scanDeps(fx, new FakeWorkerIndex(), []);
      b.deps.runFullScan = scan;
      expectKept(await migrateLegacyIndex({ ...b.deps, workspace: join(fx.legacy, "ws") }), fx, /inside/);
      expect(scan).not.toHaveBeenCalled();
    });
  });
});

describe("migrateLegacyIndex — bounded retries", () => {
  it("counts each failed attempt, stops after the bound, and says why", async () => {
    await withLegacy(async (fx) => {
      const gone = join(fx.root, "unmounted-volume");
      const attempts = memoryAttempts();
      for (let n = 1; n <= INDEX_MIGRATION_MAX_ATTEMPTS; n += 1) {
        const { deps } = scanDeps(fx, new FakeWorkerIndex(), [gone], { attempts });
        const result = await migrateLegacyIndex(deps);
        expect(result).toMatchObject({ phase: "kept-old", attempt: n, maxAttempts: INDEX_MIGRATION_MAX_ATTEMPTS });
        expect(Boolean(result?.retriesExhausted)).toBe(n === INDEX_MIGRATION_MAX_ATTEMPTS);
      }
      expect(attempts.state).toMatchObject({ attempts: INDEX_MIGRATION_MAX_ATTEMPTS, lastReason: expect.stringMatching(/could not be read/) });

      const { deps, reports } = scanDeps(fx, new FakeWorkerIndex(), [gone], { attempts });
      const scan = vi.spyOn(deps, "runFullScan");
      const stopped = await migrateLegacyIndex(deps);
      expect(scan).not.toHaveBeenCalled();
      expect(stopped).toMatchObject({
        phase: "kept-old",
        retriesExhausted: true,
        reason: expect.stringMatching(/stopped after 5 attempt\(s\); last reason: 1 folder\(s\) could not be read/),
      });
      expect(reports.map((r) => r.phase)).toEqual(["kept-old"]);
      expect(existsSync(join(fx.legacy, "fts5.sqlite"))).toBe(true);
    });
  });

  it("a cancelled scan (the app quit mid-rebuild) does not use up an attempt", async () => {
    await withLegacy(async (fx) => {
      const docs = join(fx.root, "docs");
      await writeDocs(docs, ["a.md"]);
      const attempts = memoryAttempts({ attempts: 1 });
      const { deps } = scanDeps(fx, new FakeWorkerIndex(), [docs], { attempts });
      deps.runFullScan = async () => ({
        result: { scanned: 1, indexed: 0, failed: 0, totalIndexed: 0, walked: 1, unreadableFolders: [], canceled: true },
        folderSource: "saved",
        registeredFolders: 1,
      });
      const result = await migrateLegacyIndex(deps);
      expectKept(result, fx, /cancelled/);
      expect(attempts.write).not.toHaveBeenCalled();
      expect(attempts.state).toEqual({ attempts: 1 });
    });
  });
});
