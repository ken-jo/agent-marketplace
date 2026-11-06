/**
 * The visible rebuild out of `<pluginDataDir>/index`: the old directory is
 * removed only once the new index covers what the old one held, and kept for
 * every lesser outcome.
 *
 * The scans here are real `FolderAutoIndexer` scans over real directories,
 * through the real `WorkerClient`, against a scripted stdio worker that keys
 * documents by absolute path the way the worker's `documents.path UNIQUE`
 * column does. The old index is a manifest of the documents it held. A
 * premature delete, a folder that could not be read, or a lost document or
 * vector all show up on disk.
 */
import { describe, expect, it, vi } from "vitest";
import { existsSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WorkerControlError } from "@ave/plugin-contract";
import { FolderAutoIndexer } from "../src/folderIndexer";
import {
  BACKFILL_STOP_AFTER,
  INDEX_MIGRATION_MAX_ATTEMPTS,
  migrateLegacyIndex,
  type FolderSource,
  type IndexMigrationDeps,
  type DirectIndexResult,
  type EmbeddingState,
  type IndexMigrationStatus,
  type LegacyManifestDocument,
  type MigrationAttempts,
} from "../src/indexMigration";
import { WORKER_PATH_NOT_ALLOWED, WorkerClient } from "../src/workerClient";
import { FakeStdioWorker, workerRefusal } from "./support/fakeStdioWorker";

interface Row {
  doc_id: string;
  path: string;
  doc_name: string;
  doc_type: string;
  status: string;
  content_state: string;
  mtime_ms: number;
}

/**
 * The new index, behind a scripted stdio worker. Embedding is "up" or "down";
 * a document indexed while it is down is held without vectors
 * (content_state embed_failed), as the worker does.
 */
class FakeWorker {
  readonly rows = new Map<string, Row>();
  embedding: "up" | "down" = "up";
  /** Paths whose indexing is scripted: a result to return, or an error to throw. */
  readonly scripted = new Map<string, () => unknown>();
  private next = 0;
  readonly handle = new FakeStdioWorker({
    indexer_reindex: (params) => this.reindex((params as { file_path: string }).file_path),
    documents_list: (params) => {
      const { after } = (params ?? {}) as { after?: string };
      const rows = [...this.rows.values()].sort((a, b) => a.doc_id.localeCompare(b.doc_id));
      const page = rows.filter((row) => after === undefined || row.doc_id > after);
      return { documents: page, next_after: null };
    },
    documents_delete: (params) => {
      const { doc_id } = params as { doc_id: string };
      for (const [path, row] of this.rows) if (row.doc_id === doc_id) this.rows.delete(path);
      return { removed: true, doc_id };
    },
    runtime_info: () => ({ document_count: this.rows.size }),
  });
  readonly client = new WorkerClient();
  /** What FolderAutoIndexer calls: the real client's methods. */
  readonly indexerClient = {
    indexDocument: (filePath: string, mode?: string) => this.client.indexDocument(filePath, mode),
    removeDocument: (docId: string) => this.client.removeDocument(docId),
  };

  constructor() {
    this.client.attach(this.handle);
  }

  reindexCalls(): string[] {
    return this.handle.callsOf("indexer_reindex").map((r) => resolve((r.params as { file_path: string }).file_path));
  }

  private reindex(filePath: string): unknown {
    const key = resolve(filePath);
    const script = this.scripted.get(key);
    const existing = this.rows.get(key);
    const mtime_ms = Math.floor(statSync(key).mtimeMs);
    if (script) {
      const out = script() as { status?: string } | undefined;
      // The worker keeps a failed row, with the file's mtime, for each failed attempt.
      if (out?.status === "failed") {
        this.rows.set(key, {
          doc_id: existing?.doc_id ?? `doc-${String(++this.next).padStart(4, "0")}`,
          path: key, doc_name: key.split(/[\\/]/).pop()!, doc_type: "md",
          status: "failed", content_state: "ok", mtime_ms,
        });
      }
      return out;
    }
    const doc_id = existing?.doc_id ?? `doc-${String(++this.next).padStart(4, "0")}`;
    const embedded = this.embedding === "up";
    this.rows.set(key, {
      doc_id,
      path: key,
      doc_name: key.split(/[\\/]/).pop()!,
      doc_type: "md",
      status: "indexed",
      content_state: embedded ? "ok" : "embed_failed",
      mtime_ms,
    });
    return { doc_id, doc_name: "x", doc_type: "md", chunk_count: 1, status: "indexed", embedded };
  }
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
  await mkdir(join(legacy, "vectors.lance"), { recursive: true });
  await writeFile(join(legacy, "fts5.sqlite"), "old index");
  await writeFile(join(legacy, "vectors.lance", "data.lance"), "old vectors");
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

/** What the old index held for `paths`, read at the files' current mtimes. */
async function oldIndexOf(paths: string[], hadVectors = true): Promise<LegacyManifestDocument[]> {
  const docs: LegacyManifestDocument[] = [];
  for (const path of paths) {
    let mtimeMs = 1_600_000_000_000;
    try {
      mtimeMs = Math.floor((await stat(path)).mtimeMs);
    } catch {
      // A file that is gone now: any mtime will do.
    }
    docs.push({ path: resolve(path), mtimeMs, hadVectors });
  }
  return docs;
}

/** Migration deps driven by a real folder scan over `folders`. */
function scanDeps(
  fx: Fixture,
  worker: FakeWorker,
  folders: string[],
  manifest: LegacyManifestDocument[],
  opts: {
    folderSource?: FolderSource;
    attempts?: ReturnType<typeof memoryAttempts>;
    embeddingConfigured?: boolean;
    embeddingState?: EmbeddingState;
    /** The folder list saved when the manifest was read; defaults to `folders`. */
    manifestFolders?: string[] | null;
  } = {},
) {
  const reports: IndexMigrationStatus[] = [];
  const removeDirectory = vi.fn(async (path: string) => {
    await rm(path, { recursive: true, force: true });
  });
  const indexer = new FolderAutoIndexer({ client: worker.indexerClient, folders, extensions: [".md"] });
  const attempts = opts.attempts ?? memoryAttempts();
  const discardManifest = vi.fn(async () => {});
  const deps: IndexMigrationDeps = {
    location: {
      indexRoot: join(fx.root, "state", "index"),
      documentCount: 0,
      inStateDirectory: true,
      legacyIndexDir: fx.legacy,
    },
    workspace: join(fx.pluginDataDir, ".local-indexer-workspace"),
    loadManifest: async () => ({
      documents: manifest,
      folders: opts.manifestFolders === undefined ? folders : opts.manifestFolders,
    }),
    discardManifest,
    runFullScan: async () => ({
      result: await indexer.scanOnce(),
      folderSource: opts.folderSource ?? "saved",
      folders,
    }),
    coverage: {
      listNewDocuments: async () =>
        (await worker.client.listDocuments()).map((doc) => ({
          path: doc.path,
          status: doc.status,
          contentState: doc.contentState,
        })),
      embeddingState: async () => opts.embeddingState ?? (opts.embeddingConfigured === false ? "off" : "on"),
      realpath: (path) => realpath(path),
      caseInsensitive: async () => false,
      indexDirect: async (paths) => {
        const out: DirectIndexResult[] = [];
        for (const path of paths) {
          try {
            await worker.client.indexDocument(path);
            out.push({ path, indexed: true });
          } catch (err) {
            const e = err as { retryable?: boolean; failureKind?: string };
            out.push({ path, indexed: false, retryable: e.retryable === true, ...(e.failureKind ? { failureKind: e.failureKind } : {}) });
          }
        }
        return out;
      },
      fileMtime: async (path) => {
        try {
          return (await stat(path)).mtimeMs;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ENOTDIR") return "gone";
          throw err;
        }
      },
      wouldIndex: (path, folder) => indexer.wouldIndex(path, folder),
      reindex: async (path) => {
        const result = await worker.client.reindex(path);
        return result.status === "indexed" && result.embedded === true;
      },
    },
    documentCount: async () => (await worker.client.runtimeInfo()).document_count,
    removeDirectory,
    attempts,
    report: (s) => reports.push(structuredClone(s)),
  };
  return { deps, reports, removeDirectory, indexer, attempts, discardManifest };
}

/**
 * A new process: a fresh FolderAutoIndexer whose scan cache is seeded from
 * what the worker holds, the way the start-up warmup seeds it.
 */
function restart(deps: IndexMigrationDeps, worker: FakeWorker, folders: string[]): void {
  const indexer = new FolderAutoIndexer({ client: worker.indexerClient, folders, extensions: [".md"] });
  indexer.prePopulateCache(
    [...worker.rows.values()].map((row) => ({ path: row.path, doc_id: row.doc_id, mtime_ms: row.mtime_ms, status: row.status })),
  );
  deps.runFullScan = async () => ({ result: await indexer.scanOnce(), folderSource: "saved", folders });
  deps.coverage.wouldIndex = (path, folder) => indexer.wouldIndex(path, folder);
}

async function writeDocs(dir: string, names: string[]): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  for (const name of names) await writeFile(join(dir, name), `# ${name}`);
  return names.map((name) => resolve(dir, name));
}

function expectKept(result: IndexMigrationStatus | null, fx: Fixture, reason: RegExp): void {
  expect(result?.phase).toBe("kept-old");
  expect(result?.reason).toMatch(reason);
  // The old index and its vectors are still there.
  expect(existsSync(join(fx.legacy, "fts5.sqlite"))).toBe(true);
  expect(existsSync(join(fx.legacy, "vectors.lance", "data.lance"))).toBe(true);
}

const corrupt = { doc_id: "bad", doc_name: "bad.md", doc_type: "md", chunk_count: 0, status: "failed",
  errors: ["Layer A parse failed: not a PDF"], retryable: false, failure_kind: "unparseable" };

describe("migrateLegacyIndex — completes when the new index covers the old one", () => {
  it("does nothing when there is no old index", async () => {
    await withLegacy(async (fx) => {
      const { deps, reports } = scanDeps(fx, new FakeWorker(), [], []);
      const result = await migrateLegacyIndex({ ...deps, location: { ...deps.location, legacyIndexDir: null } });
      expect(result).toBeNull();
      expect(reports).toEqual([]);
    });
  });

  it("deletes the old directory, the ledger and the manifest once every old document is back with its vectors", async () => {
    await withLegacy(async (fx) => {
      const paths = await writeDocs(join(fx.root, "docs"), ["a.md", "b.md", "c.md"]);
      const worker = new FakeWorker();
      const { deps, reports, attempts, discardManifest } = scanDeps(
        fx, worker, [join(fx.root, "docs")], await oldIndexOf(paths),
        { attempts: memoryAttempts({ attempts: 2 }) },
      );
      const result = await migrateLegacyIndex(deps);
      expect(result).toMatchObject({
        phase: "completed",
        attempt: 3,
        documentsAfter: 3,
        legacyDocuments: 3,
        coverage: { required: 3, covered: 3, missingDocuments: 0, missingVectors: 0 },
      });
      expect(reports.map((r) => r.phase)).toEqual(["rebuilding", "completed"]);
      expect(existsSync(fx.legacy)).toBe(false);
      expect(existsSync(fx.pluginDataDir)).toBe(true);
      expect(attempts.state).toBeNull();
      expect(discardManifest).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps the old index while the rebuild runs", async () => {
    await withLegacy(async (fx) => {
      const paths = await writeDocs(join(fx.root, "docs"), ["a.md"]);
      const worker = new FakeWorker();
      worker.scripted.set(paths[0]!, () => {
        expect(existsSync(join(fx.legacy, "fts5.sqlite"))).toBe(true);
        worker.scripted.delete(paths[0]!);
        return (worker as unknown as { reindex: (p: string) => unknown }).reindex(paths[0]!);
      });
      const { deps } = scanDeps(fx, worker, [join(fx.root, "docs")], await oldIndexOf(paths));
      expect((await migrateLegacyIndex(deps))?.phase).toBe("completed");
    });
  });

  it("a key-less user whose old index had no vectors completes without vectors", async () => {
    await withLegacy(async (fx) => {
      const paths = await writeDocs(join(fx.root, "docs"), ["a.md", "b.md"]);
      const worker = new FakeWorker();
      worker.embedding = "down"; // no key: every document is held without vectors
      const { deps } = scanDeps(fx, worker, [join(fx.root, "docs")], await oldIndexOf(paths, false), {
        embeddingConfigured: false,
      });
      const result = await migrateLegacyIndex(deps);
      expect(result).toMatchObject({ phase: "completed", coverage: { required: 2, covered: 2, missingVectors: 0 } });
      expect(existsSync(fx.legacy)).toBe(false);
    });
  });

  it("vectors are only required where the old index had them and embedding is configured now", async () => {
    // Configured now, but the old documents had none: nothing to lose.
    await withLegacy(async (fx) => {
      const paths = await writeDocs(join(fx.root, "docs"), ["a.md"]);
      const worker = new FakeWorker();
      worker.embedding = "down";
      const { deps } = scanDeps(fx, worker, [join(fx.root, "docs")], await oldIndexOf(paths, false));
      expect((await migrateLegacyIndex(deps))?.phase).toBe("completed");
    });
    // The old documents had vectors, but the settings make embedding unusable now: waived.
    await withLegacy(async (fx) => {
      const paths = await writeDocs(join(fx.root, "docs"), ["a.md"]);
      const worker = new FakeWorker();
      worker.embedding = "down";
      const { deps } = scanDeps(fx, worker, [join(fx.root, "docs")], await oldIndexOf(paths, true), {
        embeddingConfigured: false,
      });
      expect((await migrateLegacyIndex(deps))?.phase).toBe("completed");
    });
  });

  it("a deleted file and a removed folder are excluded, and the rebuild completes", async () => {
    await withLegacy(async (fx) => {
      const docs = join(fx.root, "docs");
      const kept = await writeDocs(docs, ["a.md", "deleted.md"]);
      const removedRoot = await writeDocs(join(fx.root, "old-project"), ["x.md", "y.md"]);
      const manifest = await oldIndexOf([...kept, ...removedRoot]);
      await rm(kept[1]!);
      // old-project is no longer registered; its files still exist.
      const worker = new FakeWorker();
      const { deps } = scanDeps(fx, worker, [docs], manifest, {
        manifestFolders: [docs, join(fx.root, "old-project")],
      });
      const result = await migrateLegacyIndex(deps);
      expect(result).toMatchObject({
        phase: "completed",
        coverage: { required: 1, covered: 1, excludedGone: 1, excludedRootRemoved: 2 },
      });
      expect(existsSync(fx.legacy)).toBe(false);
    });
  });

  it("an explicit empty folder list excludes every old document: the user removed all folders", async () => {
    await withLegacy(async (fx) => {
      const paths = await writeDocs(join(fx.root, "docs"), ["a.md"]);
      const { deps } = scanDeps(fx, new FakeWorker(), [], await oldIndexOf(paths), {
        folderSource: "saved",
        manifestFolders: [join(fx.root, "docs")],
      });
      const result = await migrateLegacyIndex(deps);
      expect(result).toMatchObject({ phase: "completed", coverage: { required: 0, excludedRootRemoved: 1 } });
      expect(existsSync(fx.legacy)).toBe(false);
    });
  });

  it("an old document of a type the current settings do not index is excluded", async () => {
    await withLegacy(async (fx) => {
      const docs = join(fx.root, "docs");
      const md = await writeDocs(docs, ["a.md"]);
      const images = await writeDocs(docs, ["photo.png"]); // the old index captioned it
      const skipped = await writeDocs(join(docs, "node_modules"), ["dep.md"]);
      const { deps } = scanDeps(fx, new FakeWorker(), [docs], await oldIndexOf([...md, ...images, ...skipped]));
      const result = await migrateLegacyIndex(deps);
      expect(result).toMatchObject({ phase: "completed", coverage: { required: 1, excludedUnsupported: 2 } });
    });
  });

  it("an unchanged file the new parser rejects as unreadable is excluded with a note", async () => {
    await withLegacy(async (fx) => {
      const docs = join(fx.root, "docs");
      const [good, bad] = await writeDocs(docs, ["a.md", "bad.md"]);
      const worker = new FakeWorker();
      worker.scripted.set(bad!, () => corrupt);
      const { deps } = scanDeps(fx, worker, [docs], await oldIndexOf([good!, bad!]));
      const result = await migrateLegacyIndex(deps);
      expect(result).toMatchObject({ phase: "completed", coverage: { required: 1, excludedCorrupt: [bad] } });
      expect(result?.notes?.[0]).toMatch(/1 document\(s\) from the old index could not be read by the new parser .*bad\.md/);
      expect(existsSync(fx.legacy)).toBe(false);
    });
  });

  it("an unchanged unreadable file is still excluded on a retry after a restart", async () => {
    await withLegacy(async (fx) => {
      const docs = join(fx.root, "docs");
      const [good, bad, chart] = await writeDocs(docs, ["a.md", "bad.md", "chart.md"]);
      const worker = new FakeWorker();
      worker.scripted.set(bad!, () => corrupt);
      // A caption rate limit keeps the old index on the first attempt.
      worker.scripted.set(chart!, () => ({ ...corrupt, errors: ["429"], retryable: true, failure_kind: "caption" }));
      const attempts = memoryAttempts();
      const { deps } = scanDeps(fx, worker, [docs], await oldIndexOf([good!, bad!, chart!]), { attempts });
      expectKept(await migrateLegacyIndex(deps), fx, /lacks 1 document\(s\) \(1 failed for a reason that may pass\)/);

      // Next start: the worker holds failed rows for both. They must be
      // retried, not skipped: the rate limit has passed, the corrupt file is
      // still corrupt.
      worker.scripted.delete(chart!);
      restart(deps, worker, [docs]);
      const second = await migrateLegacyIndex(deps);
      expect(second).toMatchObject({ phase: "completed", attempt: 2, coverage: { required: 2, excludedCorrupt: [bad] } });
      // Each attempt: the scan parses both, then the corrupt file is parsed a
      // second time before it may be excluded.
      expect(worker.reindexCalls().filter((p) => p === bad || p === chart)).toEqual([bad, chart, bad, bad, chart, bad]);
    });
  });

  it("two registered paths to the same files (a symlinked folder) still cover", async () => {
    await withLegacy(async (fx) => {
      const docs = join(fx.root, "docs");
      const paths = await writeDocs(docs, ["a.md", "b.md"]);
      const alias = join(fx.root, "docs-alias");
      await symlink(docs, alias, "dir");
      const worker = new FakeWorker();
      const { deps } = scanDeps(fx, worker, [docs, alias], await oldIndexOf(paths));
      const result = await migrateLegacyIndex(deps);
      // The worker keys by absolute path, so each spelling is its own row.
      expect(result).toMatchObject({ phase: "completed", documentsAfter: 4, coverage: { required: 2, covered: 2 } });
    });
  });
});

describe("migrateLegacyIndex — keeps the old index", () => {
  it("when embedding fails during the rebuild: the old vectors stay, and a later attempt fills them", async () => {
    await withLegacy(async (fx) => {
      const docs = join(fx.root, "docs");
      const paths = await writeDocs(docs, ["a.md", "b.md", "c.md", "d.md", "e.md"]);
      const worker = new FakeWorker();
      worker.embedding = "down"; // the provider is out for the whole attempt
      const attempts = memoryAttempts();
      const { deps } = scanDeps(fx, worker, [docs], await oldIndexOf(paths), { attempts });
      const first = await migrateLegacyIndex(deps);
      expectKept(first, fx, /lacks 0 document\(s\) and the vectors of 5 document\(s\)/);
      // The re-embed pass stopped once the provider kept failing.
      expect(first?.coverage?.backfill).toEqual({ attempted: BACKFILL_STOP_AFTER, embedded: 0 });
      expect(attempts.state).toMatchObject({ attempts: 1 });

      // The provider is back, after a restart. The scan skips every file
      // (same mtime, already held), so only the re-embed pass can give them vectors.
      worker.embedding = "up";
      restart(deps, worker, [docs]);
      const before = worker.reindexCalls().length;
      const second = await migrateLegacyIndex(deps);
      expect(second).toMatchObject({
        phase: "completed",
        attempt: 2,
        coverage: { covered: 5, missingVectors: 0, backfill: { attempted: 5, embedded: 5 } },
      });
      expect(second?.scan?.scanned).toBe(0);
      expect(worker.reindexCalls().length - before).toBe(5);
      expect(existsSync(fx.legacy)).toBe(false);
    });
  });

  it("when a changed file now fails to parse, or an unchanged one fails for a reason that may pass", async () => {
    await withLegacy(async (fx) => {
      const docs = join(fx.root, "docs");
      const [bad] = await writeDocs(docs, ["bad.md"]);
      const manifest = await oldIndexOf([bad!]);
      // Edited since the old index read it: the old copy is the only good one.
      const later = new Date(manifest[0]!.mtimeMs + 60_000);
      await utimes(bad!, later, later);
      const worker = new FakeWorker();
      worker.scripted.set(bad!, () => corrupt);
      const { deps } = scanDeps(fx, worker, [docs], manifest);
      const result = await migrateLegacyIndex(deps);
      expectKept(result, fx, /lacks 1 document\(s\)/);
      expect(result?.coverage?.excludedCorrupt).toEqual([]);
    });
    await withLegacy(async (fx) => {
      const docs = join(fx.root, "docs");
      const [chart] = await writeDocs(docs, ["chart.md"]);
      const worker = new FakeWorker();
      worker.scripted.set(chart!, () => ({ ...corrupt, errors: ["OpenAI Vision 호출 실패: Error code: 429"], retryable: true, failure_kind: "caption" }));
      const { deps } = scanDeps(fx, worker, [docs], await oldIndexOf([chart!]));
      const result = await migrateLegacyIndex(deps);
      expectKept(result, fx, /lacks 1 document\(s\) \(1 failed for a reason that may pass\)/);
      expect(result?.scan).toMatchObject({ failed: 1, failedTransient: 1 });
    });
  });

  it("when a file failed because the worker was lost, refused the roots, or hit an unexpected error", async () => {
    for (const make of [
      () => new WorkerControlError("worker-incarnation-ended", "the worker stopped"),
      () => workerRefusal("file_path: outside allowed roots", WORKER_PATH_NOT_ALLOWED),
      () => workerRefusal("disk I/O error", -32000),
    ]) {
      await withLegacy(async (fx) => {
        const docs = join(fx.root, "docs");
        const paths = await writeDocs(docs, ["a.md", "b.md"]);
        const worker = new FakeWorker();
        worker.scripted.set(paths[1]!, () => { throw make(); });
        const { deps, removeDirectory } = scanDeps(fx, worker, [docs], await oldIndexOf(paths));
        expectKept(await migrateLegacyIndex(deps), fx, /lacks 1 document\(s\) \(1 failed for a reason that may pass\)/);
        expect(removeDirectory).not.toHaveBeenCalled();
      });
    }
  });

  it("when an old document is simply not in the new index", async () => {
    await withLegacy(async (fx) => {
      const docs = join(fx.root, "docs");
      const paths = await writeDocs(docs, ["a.md", "b.md"]);
      const worker = new FakeWorker();
      const { deps } = scanDeps(fx, worker, [docs], await oldIndexOf(paths));
      const list = deps.coverage.listNewDocuments;
      deps.coverage.listNewDocuments = async () => (await list()).filter((doc) => !doc.path.endsWith("a.md"));
      expectKept(await migrateLegacyIndex(deps), fx, /lacks 1 document\(s\) and the vectors of 0/);
    });
  });

  it("when a registered folder with old documents cannot be read (unmounted volume)", async () => {
    await withLegacy(async (fx) => {
      const volume = join(fx.root, "Volumes", "Archive");
      const paths = await writeDocs(volume, ["a.md"]);
      const manifest = await oldIndexOf(paths);
      await rm(join(fx.root, "Volumes"), { recursive: true }); // macOS removes the mountpoint on unmount
      const { deps, removeDirectory } = scanDeps(fx, new FakeWorker(), [volume], manifest);
      const result = await migrateLegacyIndex(deps);
      expectKept(result, fx, /1 folder\(s\) could not be read: .*Archive/);
      // Its files read as gone, but that is not the user deleting them.
      expect(result?.coverage).toMatchObject({ excludedGone: 0, unavailableFolders: [volume] });
      expect(removeDirectory).not.toHaveBeenCalled();
    });
  });

  it("an unreadable folder that held no old documents does not block the rebuild", async () => {
    await withLegacy(async (fx) => {
      const docs = join(fx.root, "docs");
      const paths = await writeDocs(docs, ["a.md"]);
      const { deps } = scanDeps(fx, new FakeWorker(), [docs, join(fx.root, "never-there")], await oldIndexOf(paths));
      expect((await migrateLegacyIndex(deps))?.phase).toBe("completed");
    });
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "when one folder reads and another is refused by the OS (partial)",
    async () => {
      await withLegacy(async (fx) => {
        const readable = join(fx.root, "readable");
        const refused = join(fx.root, "refused");
        const paths = [...(await writeDocs(readable, ["a.md"])), ...(await writeDocs(refused, ["secret.md"]))];
        const manifest = await oldIndexOf(paths);
        await chmod(refused, 0o000);
        try {
          const worker = new FakeWorker();
          const { deps } = scanDeps(fx, worker, [readable, refused], manifest);
          const result = await migrateLegacyIndex(deps);
          expectKept(result, fx, /could not be read: .*refused/);
          expect(worker.rows.size).toBe(1); // the readable folder was still rebuilt
        } finally {
          await chmod(refused, 0o755);
        }
      });
    },
  );

  it("when an old document sits in an unreadable subdirectory of a readable folder", async () => {
    await withLegacy(async (fx) => {
      const docs = join(fx.root, "docs");
      const nested = join(docs, "nested");
      const paths = [...(await writeDocs(docs, ["a.md"])), ...(await writeDocs(nested, ["n.md"]))];
      const worker = new FakeWorker();
      const { deps, indexer } = scanDeps(fx, worker, [docs], await oldIndexOf(paths));
      // Make the listing of the nested directory fail the way EPERM does.
      const original = (indexer as unknown as { walkDir: Function }).walkDir.bind(indexer);
      (indexer as unknown as { walkDir: Function }).walkDir = async (
        dir: string,
        readdir: Function,
        unreadable: string[],
      ) => original(dir, async (p: string, o: unknown) => {
        if (p === nested) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
        return readdir(p, o);
      }, unreadable);
      expectKept(await migrateLegacyIndex(deps), fx, /1 folder\(s\) could not be read: .*docs/);
    });
  });

  it("when a folder that held old documents now shows no files (an empty, unmounted mountpoint)", async () => {
    await withLegacy(async (fx) => {
      const docs = join(fx.root, "docs");
      const mountpoint = join(fx.root, "mnt", "archive");
      const paths = [...(await writeDocs(docs, ["a.md"])), ...(await writeDocs(mountpoint, ["x.md", "y.md"]))];
      const manifest = await oldIndexOf(paths);
      await rm(join(mountpoint, "x.md"));
      await rm(join(mountpoint, "y.md")); // lists cleanly, holds nothing
      const worker = new FakeWorker();
      const { deps } = scanDeps(fx, worker, [docs, mountpoint], manifest);
      const result = await migrateLegacyIndex(deps);
      expectKept(result, fx, /1 folder\(s\) that held indexed documents now show no files .*archive/);
      expect(result?.scan?.unreadableFolders).toEqual([]);
      expect(worker.rows.size).toBe(1); // the mounted folder was still rebuilt
    });
  });

  it("an empty folder that held no old documents does not block the rebuild", async () => {
    await withLegacy(async (fx) => {
      const docs = join(fx.root, "docs");
      const paths = await writeDocs(docs, ["a.md"]);
      const empty = join(fx.root, "new-empty");
      await mkdir(empty);
      const { deps } = scanDeps(fx, new FakeWorker(), [docs, empty], await oldIndexOf(paths));
      expect((await migrateLegacyIndex(deps))?.phase).toBe("completed");
    });
  });

  it("when the scan used the default folders because the saved list was missing or corrupt", async () => {
    await withLegacy(async (fx) => {
      const docs = join(fx.root, "fixtures");
      const paths = await writeDocs(docs, ["a.md"]);
      const { deps } = scanDeps(fx, new FakeWorker(), [docs], await oldIndexOf(paths), { folderSource: "fallback" });
      expectKept(await migrateLegacyIndex(deps), fx, /saved folder list was missing or unreadable/);
    });
  });

  it("when the manifest or the scan fails, the count cannot be read, or the removal fails", async () => {
    await withLegacy(async (fx) => {
      const docs = join(fx.root, "docs");
      const paths = await writeDocs(docs, ["a.md"]);
      const manifest = await oldIndexOf(paths);
      const m = scanDeps(fx, new FakeWorker(), [docs], manifest);
      m.deps.loadManifest = async () => { throw new Error("database disk image is malformed"); };
      expectKept(await migrateLegacyIndex(m.deps), fx, /old index could not be read: database disk image/);
      const a = scanDeps(fx, new FakeWorker(), [docs], manifest);
      a.deps.runFullScan = async () => { throw new Error("worker gone"); };
      expectKept(await migrateLegacyIndex(a.deps), fx, /rebuild scan failed: worker gone/);
      const l = scanDeps(fx, new FakeWorker(), [docs], manifest);
      l.deps.coverage.listNewDocuments = async () => { throw new Error("timeout"); };
      expectKept(await migrateLegacyIndex(l.deps), fx, /new index could not be checked: timeout/);
      const b = scanDeps(fx, new FakeWorker(), [docs], manifest);
      b.deps.documentCount = async () => { throw new Error("timeout"); };
      expectKept(await migrateLegacyIndex(b.deps), fx, /did not report its documents: timeout/);
      const c = scanDeps(fx, new FakeWorker(), [docs], manifest);
      c.deps.removeDirectory = async () => { throw new Error("EACCES"); };
      expectKept(await migrateLegacyIndex(c.deps), fx, /could not be removed: EACCES/);
    });
  });

  it("never deletes a directory that holds the new index or the workspace", async () => {
    await withLegacy(async (fx) => {
      const scan = vi.fn();
      const a = scanDeps(fx, new FakeWorker(), [], []);
      a.deps.runFullScan = scan;
      expectKept(
        await migrateLegacyIndex({ ...a.deps, location: { ...a.deps.location, indexRoot: join(fx.legacy, "nested") } }),
        fx,
        /inside the old index directory/,
      );
      const b = scanDeps(fx, new FakeWorker(), [], []);
      b.deps.runFullScan = scan;
      expectKept(await migrateLegacyIndex({ ...b.deps, workspace: join(fx.legacy, "ws") }), fx, /inside/);
      expect(scan).not.toHaveBeenCalled();
    });
  });
});

describe("migrateLegacyIndex — bounded retries", () => {
  it("counts each failed attempt, stops after the bound, and says why", async () => {
    await withLegacy(async (fx) => {
      const volume = join(fx.root, "unmounted-volume");
      const manifest = await oldIndexOf([join(volume, "a.md")]);
      const attempts = memoryAttempts();
      for (let n = 1; n <= INDEX_MIGRATION_MAX_ATTEMPTS; n += 1) {
        const { deps } = scanDeps(fx, new FakeWorker(), [volume], manifest, { attempts });
        const result = await migrateLegacyIndex(deps);
        expect(result).toMatchObject({ phase: "kept-old", attempt: n, maxAttempts: INDEX_MIGRATION_MAX_ATTEMPTS });
        expect(Boolean(result?.retriesExhausted)).toBe(n === INDEX_MIGRATION_MAX_ATTEMPTS);
      }
      expect(attempts.state).toMatchObject({ attempts: INDEX_MIGRATION_MAX_ATTEMPTS, lastReason: expect.stringMatching(/could not be read/) });

      const { deps, reports } = scanDeps(fx, new FakeWorker(), [volume], manifest, { attempts });
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
      const paths = await writeDocs(docs, ["a.md"]);
      const attempts = memoryAttempts({ attempts: 1 });
      const { deps } = scanDeps(fx, new FakeWorker(), [docs], await oldIndexOf(paths), { attempts });
      deps.runFullScan = async () => ({
        result: { scanned: 1, indexed: 0, failed: 0, totalIndexed: 0, walked: 1, unreadableFolders: [], canceled: true },
        folderSource: "saved",
        folders: [docs],
      });
      const result = await migrateLegacyIndex(deps);
      expectKept(result, fx, /cancelled/);
      expect(attempts.write).not.toHaveBeenCalled();
      expect(attempts.state).toEqual({ attempts: 1 });
    });
  });
});

/**
 * The fail-closed contract of assessCoverage, one row per probe. Every row
 * keeps the old index unless it carries positive evidence: a named exclusion
 * proven, or a document proven covered.
 */
describe("migrateLegacyIndex — coverage fails closed", () => {
  interface Row {
    name: string;
    folders: string[];
    /** Folder list saved when the manifest was read (default: `folders`). */
    manifestFolders?: string[] | null;
    doc: string;
    hadVectors?: boolean;
    /** realpath per folder: a string, or "fails". Default: identity. */
    real?: Record<string, string>;
    /** Measured case-insensitivity of every root (default: case-sensitive). */
    caseInsensitive?: boolean;
    unreadable?: string[];
    /** stat of the document's directory, for documents outside every folder. */
    parentMtime?: number | "gone" | "EIO";
    /** Answers to direct indexing (outside documents, second parses), in call order. */
    direct?: Array<"indexed" | { retryable: boolean; failureKind?: string }>;
    reason?: RegExp;
    excludedCorrupt?: number;
    walked?: Record<string, number>;
    mtime?: number | "gone" | "EIO";
    held?: { path: string; contentState?: string } | null;
    failure?: { retryable: boolean; failureKind?: string };
    embedding?: EmbeddingState;
    folderSource?: FolderSource;
    expect: "kept-old" | "completed";
  }
  const OLD = 1_700_000_000_000;
  const nfd = (s: string) => s.normalize("NFD");
  const rows: Row[] = [
    { name: "symlinked folder, target volume offline", folders: ["/Users/u/Docs"], real: { "/Users/u/Docs": "fails" },
      doc: "/Volumes/NAS/Docs/a.pdf", unreadable: ["/Users/u/Docs"], walked: { "/Users/u/Docs": 0 }, mtime: "gone",
      expect: "kept-old" },
    { name: "symlinked folder, target an empty mountpoint", folders: ["/Users/u/Docs"],
      real: { "/Users/u/Docs": "/Volumes/NAS/Docs" }, doc: "/Volumes/NAS/Docs/a.pdf", walked: { "/Users/u/Docs": 0 },
      mtime: "gone", expect: "kept-old" },
    { name: "mapped drive registered, UNC path stored, share offline", folders: ["/mnt/z/Docs"],
      real: { "/mnt/z/Docs": "fails" }, doc: "/net/nas/share/Docs/a.pdf", unreadable: ["/mnt/z/Docs"], mtime: "gone",
      expect: "kept-old" },
    { name: "mapped drive registered, UNC path stored, share online (covered)", folders: ["/mnt/z/Docs"],
      real: { "/mnt/z/Docs": "/net/nas/share/Docs" }, doc: "/net/nas/share/Docs/a.pdf",
      held: { path: "/mnt/z/Docs/a.pdf", contentState: "ok" }, expect: "completed" },
    { name: "case variant of the folder, unreadable", folders: ["/Users/u/documents"], caseInsensitive: true,
      doc: "/Users/u/Documents/a.pdf", unreadable: ["/Users/u/documents"], mtime: "gone", expect: "kept-old" },
    { name: "case-only rename of the folder, readable (covered)", manifestFolders: ["/Users/u/documents"],
      folders: ["/Users/u/Documents"], caseInsensitive: true, doc: "/Users/u/documents/a.pdf",
      held: { path: "/Users/u/Documents/a.pdf", contentState: "ok" }, expect: "completed" },
    { name: "case-only rename of the folder, document not rebuilt", manifestFolders: ["/Users/u/documents"],
      folders: ["/Users/u/Documents"], caseInsensitive: true, doc: "/Users/u/documents/a.pdf", expect: "kept-old" },
    { name: "folder re-registered by its real path, old document under the symlink spelling, not indexable now",
      manifestFolders: ["/Users/u/Docs"], real: { "/Users/u/Docs": "/Volumes/NAS/Docs" },
      folders: ["/Volumes/NAS/Docs"], doc: "/Users/u/Docs/a.pdf", direct: [{ retryable: true, failureKind: "io" }],
      expect: "kept-old" },
    { name: "case-sensitive root: A.pdf is not covered by a.pdf", folders: ["/cs"], caseInsensitive: false,
      doc: "/cs/A.pdf", held: { path: "/cs/a.pdf", contentState: "ok" }, expect: "kept-old" },
    { name: "case-sensitive root, document in a folder cased differently: outside, indexed directly",
      folders: ["/cs"], caseInsensitive: false, doc: "/CS/a.pdf", expect: "completed" },
    { name: "case-insensitive root (measured): A.pdf held as a.pdf (covered)", folders: ["/ci"], caseInsensitive: true,
      doc: "/ci/A.pdf", held: { path: "/ci/a.pdf", contentState: "ok" }, expect: "completed" },
    { name: "NFD folder, NFC path, unreadable", folders: [nfd("/Users/u/문서")], doc: "/Users/u/문서/a.pdf",
      unreadable: [nfd("/Users/u/문서")], mtime: "gone", expect: "kept-old" },
    { name: "NFD folder, NFC path, readable (covered)", folders: [nfd("/Users/u/문서")], doc: "/Users/u/문서/a.pdf",
      held: { path: nfd("/Users/u/문서/a.pdf"), contentState: "ok" }, expect: "completed" },
    { name: "folder in the manifest-time list and removed since (excluded)", manifestFolders: ["/d/keep", "/d/old"],
      folders: ["/d/keep"], doc: "/d/old/a.pdf", expect: "completed" },
    { name: "removed folder, but a current folder does not resolve", manifestFolders: ["/d/keep", "/d/old"],
      folders: ["/d/keep"], real: { "/d/keep": "fails" }, doc: "/d/old/a.pdf", mtime: "gone", parentMtime: "gone",
      expect: "kept-old" },
    { name: "folder does not resolve, document under it as registered", folders: ["/d"], real: { "/d": "fails" },
      doc: "/d/a.pdf", mtime: "gone", expect: "kept-old" },
    { name: "symlinked folder online, unreadable subdirectory named as walked", folders: ["/Users/u/Docs"],
      real: { "/Users/u/Docs": "/Volumes/NAS/Docs" }, doc: "/Volumes/NAS/Docs/sub/a.pdf",
      unreadable: ["/Users/u/Docs/sub"], mtime: "gone", expect: "kept-old" },
    { name: "outside every folder (indexed one by one), file there: indexed directly (covered)",
      folders: ["/d/keep"], doc: "/elsewhere/a.pdf", expect: "completed" },
    { name: "outside every folder, file gone, its directory still there (excluded)", folders: ["/d/keep"],
      doc: "/elsewhere/a.pdf", mtime: "gone", parentMtime: OLD, expect: "completed" },
    { name: "outside every folder, file and directory gone (volume offline?)", folders: ["/d/keep"],
      doc: "/Volumes/USB/a.pdf", mtime: "gone", parentMtime: "gone", reason: /outside the registered folders could not be read/,
      expect: "kept-old" },
    { name: "outside every folder, stat fails", folders: ["/d/keep"], doc: "/elsewhere/a.pdf", mtime: "EIO",
      expect: "kept-old" },
    { name: "outside every folder, direct indexing fails (permission denied)", folders: ["/d/keep"],
      doc: "/elsewhere/a.pdf", direct: [{ retryable: true, failureKind: "io" }], expect: "kept-old" },
    { name: "manifest-time folder list unknown: the document is outside, indexed directly", manifestFolders: null,
      folders: ["/d/keep"], doc: "/d/old/a.pdf", expect: "completed" },
    { name: "stat fails with EIO, not in the new index", folders: ["/d"], doc: "/d/a.pdf", mtime: "EIO",
      expect: "kept-old" },
    { name: "file gone under a folder that lists files (excluded)", folders: ["/d"], doc: "/d/a.pdf", mtime: "gone",
      expect: "completed" },
    { name: "embedding state unknown (lease refused), vectors missing", folders: ["/d"], doc: "/d/a.pdf",
      hadVectors: true, embedding: "unknown", held: { path: "/d/a.pdf", contentState: "embed_failed" },
      expect: "kept-old" },
    { name: "plugin key reads null (embedding configured), vectors missing", folders: ["/d"], doc: "/d/a.pdf",
      hadVectors: true, embedding: "no-key", held: { path: "/d/a.pdf", contentState: "embed_failed" },
      reason: /embedding API key could not be read or is not set, so the vectors of 1 document\(s\) cannot be rebuilt or waived; re-enter the key/,
      expect: "kept-old" },
    { name: "embedding off in the settings, vectors missing (waived)", folders: ["/d"], doc: "/d/a.pdf",
      hadVectors: true, embedding: "off", held: { path: "/d/a.pdf", contentState: "embed_failed" },
      expect: "completed" },
    { name: "embedding on, vectors still missing after the re-embed", folders: ["/d"], doc: "/d/a.pdf",
      hadVectors: true, embedding: "on", held: { path: "/d/a.pdf", contentState: "embed_failed" },
      expect: "kept-old" },
    { name: "permission denied (io), unchanged", folders: ["/d"], doc: "/d/a.pdf",
      failure: { retryable: true, failureKind: "io" }, expect: "kept-old" },
    { name: "non-retryable caption 401, unchanged", folders: ["/d"], doc: "/d/a.png",
      failure: { retryable: false, failureKind: "caption" }, expect: "kept-old" },
    { name: "non-retryable without a failure kind (older worker)", folders: ["/d"], doc: "/d/a.pdf",
      failure: { retryable: false }, expect: "kept-old" },
    { name: "too large under a lowered size limit, unchanged: named in the status", folders: ["/d"], doc: "/d/a.pdf",
      failure: { retryable: false, failureKind: "too_large" },
      reason: /1 of them are over the current file size limit \(\/d\/a\.pdf\); raise the limit, or remove them/,
      expect: "kept-old" },
    { name: "unparseable twice, unchanged (excluded)", folders: ["/d"], doc: "/d/a.pdf",
      failure: { retryable: false, failureKind: "unparseable" },
      direct: [{ retryable: false, failureKind: "unparseable" }], excludedCorrupt: 1, expect: "completed" },
    { name: "unparseable once, the second parse fails to read (a network drop)", folders: ["/d"], doc: "/d/a.pdf",
      failure: { retryable: false, failureKind: "unparseable" },
      direct: [{ retryable: true, failureKind: "io" }], expect: "kept-old" },
    { name: "unparseable once, the second parse indexes it (covered, not excluded)", folders: ["/d"], doc: "/d/a.pdf",
      failure: { retryable: false, failureKind: "unparseable" }, direct: ["indexed"], excludedCorrupt: 0,
      expect: "completed" },
    { name: "unparseable but changed since the old index read it", folders: ["/d"], doc: "/d/a.pdf",
      mtime: OLD + 60_000, failure: { retryable: false, failureKind: "unparseable" }, expect: "kept-old" },
    { name: "scan used the fallback folders", folders: ["/d"], doc: "/d/a.pdf",
      held: { path: "/d/a.pdf", contentState: "ok" }, folderSource: "fallback", expect: "kept-old" },
  ];

  it.each(rows)("$name → $expect", async (row) => {
    await withLegacy(async (fx) => {
      const reports: IndexMigrationStatus[] = [];
      const direct = [...(row.direct ?? [])];
      const indexedDirectly: string[] = [];
      const deps: IndexMigrationDeps = {
        location: { indexRoot: join(fx.root, "state", "index"), documentCount: 0, inStateDirectory: true, legacyIndexDir: fx.legacy },
        workspace: join(fx.pluginDataDir, ".local-indexer-workspace"),
        loadManifest: async () => ({
          documents: [{ path: row.doc, mtimeMs: OLD, hadVectors: row.hadVectors ?? false }],
          folders: row.manifestFolders === undefined ? row.folders : row.manifestFolders,
        }),
        discardManifest: async () => {},
        runFullScan: async () => ({
          result: {
            scanned: 0, indexed: 0, failed: row.failure ? 1 : 0, totalIndexed: 0, walked: 1,
            walkedByFolder: { ...Object.fromEntries(row.folders.map((f) => [f, 1])), ...(row.walked ?? {}) },
            unreadableFolders: row.unreadable ?? [],
            failures: row.failure ? [{ path: row.doc, ...row.failure }] : [],
          },
          folderSource: row.folderSource ?? "saved",
          folders: row.folders,
        }),
        coverage: {
          listNewDocuments: async () => [
            ...(row.held ? [{ path: row.held.path, status: "indexed", contentState: row.held.contentState }] : []),
            ...indexedDirectly.map((path) => ({ path, status: "indexed", contentState: "ok" })),
          ],
          embeddingState: async () => row.embedding ?? "on",
          fileMtime: async (path) => {
            const mtime = path === row.doc ? row.mtime ?? OLD : row.parentMtime ?? OLD;
            if (mtime === "EIO") throw Object.assign(new Error("EIO"), { code: "EIO" });
            return mtime;
          },
          wouldIndex: () => true,
          reindex: async () => false,
          realpath: async (path) => {
            const real = row.real?.[path];
            if (real === "fails") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
            return real ?? path;
          },
          caseInsensitive: async () => row.caseInsensitive ?? false,
          indexDirect: async (paths) =>
            paths.map((path) => {
              const answer = direct.shift() ?? "indexed";
              if (answer === "indexed") {
                indexedDirectly.push(path);
                return { path, indexed: true };
              }
              return { path, indexed: false, ...answer };
            }),
        },
        documentCount: async () => (row.held ? 1 : 0),
        removeDirectory: (path) => rm(path, { recursive: true, force: true }),
        attempts: memoryAttempts(),
        report: (s) => reports.push(structuredClone(s)),
      };
      const result = await migrateLegacyIndex(deps);
      expect(result?.phase, JSON.stringify(result?.coverage)).toBe(row.expect);
      expect(existsSync(join(fx.legacy, "fts5.sqlite"))).toBe(row.expect === "kept-old");
      if (row.expect === "kept-old") expect(result?.reason).toBeTruthy();
      if (row.reason) expect(result?.reason).toMatch(row.reason);
      if (row.excludedCorrupt !== undefined) expect(result?.coverage?.excludedCorrupt).toHaveLength(row.excludedCorrupt);
    });
  });
});
