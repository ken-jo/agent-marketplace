/**
 * FolderAutoIndexer performs the initial folder scan and keeps watching for
 * file changes afterwards.
 */

import { access, lstat, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import type {
  FolderAutoIndexerOptions,
  FolderAutoIndexerResult,
  FolderIndexerEntry,
  FolderProgressCounters,
  ScanProgressSnapshot,
} from "./types.js";
import {
  getIndexModeForPath,
  isImageFilePath,
  isIndexableFilePath,
  TEMP_FILE_PREFIXES,
} from "./indexingFiles.js";
import { SKIP_DIR_NAMES } from "./skipDirs.js";

/** Simple ReDoS heuristic: detect nested quantifiers like (...+)+ or (...*)*. */
const NESTED_QUANTIFIER_RE = /\([^)]*[+*][^)]*\)[+*]/;
const MAX_PATTERN_SOURCE_LEN = 200;
const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_IGNORED: Array<string | RegExp> = [/(^|[\/])\../];

function sanitizeIgnoredPatterns(
  patterns: ReadonlyArray<string | RegExp>,
): Array<string | RegExp> {
  const safe: Array<string | RegExp> = [];
  for (const pattern of patterns) {
    if (typeof pattern === "string") {
      safe.push(pattern);
      continue;
    }
    if (pattern.source.length > MAX_PATTERN_SOURCE_LEN) {
      console.warn(
        `[FolderAutoIndexer] ignored pattern dropped (source length ${pattern.source.length} > ${MAX_PATTERN_SOURCE_LEN}): ${pattern}`,
      );
      continue;
    }
    if (NESTED_QUANTIFIER_RE.test(pattern.source)) {
      console.warn(
        `[FolderAutoIndexer] ignored pattern dropped (nested quantifier, potential ReDoS): ${pattern}`,
      );
      continue;
    }
    safe.push(pattern);
  }
  return safe;
}

function cloneProgress(snapshot: ScanProgressSnapshot): ScanProgressSnapshot {
  const copy: ScanProgressSnapshot = { ...snapshot };
  if (snapshot.byFolder) {
    const folders: Record<string, FolderProgressCounters> = {};
    for (const [folder, counters] of Object.entries(snapshot.byFolder)) {
      folders[folder] = { ...counters };
    }
    copy.byFolder = folders;
  }
  return copy;
}

/** Match ``filePath`` against a list of registered folder roots and return
 *  the owning folder, or undefined if none. Windows paths are compared
 *  case-insensitively because NTFS is case-insensitive in practice; on
 *  POSIX the comparison is exact. The boundary check uses ``sep`` so a
 *  folder like ``C:\\a`` does not falsely match ``C:\\abc\\file``. */
function findOwningFolder(filePath: string, folders: readonly string[]): string | undefined {
  const isWin = process.platform === "win32";
  const norm = isWin ? filePath.toLowerCase() : filePath;
  for (const folder of folders) {
    const fn = isWin ? folder.toLowerCase() : folder;
    if (norm === fn) return folder;
    const boundary = fn.endsWith(sep) ? fn : fn + sep;
    if (norm.startsWith(boundary)) return folder;
  }
  return undefined;
}

function createIdleProgress(message = "Ready"): ScanProgressSnapshot {
  return {
    status: "idle",
    total: 0,
    processed: 0,
    indexed: 0,
    failed: 0,
    message,
  };
}

export class FolderAutoIndexer {
  private readonly client: FolderAutoIndexerOptions["client"];
  private readonly folders: string[];
  private readonly extensions: Set<string> | null; // null = use global defaults
  private readonly mtimeByPath = new Map<string, number>();
  private readonly docIdByPath = new Map<string, string>();
  private readonly ignored: Array<string | RegExp>;
  private readonly followSymlinks: boolean;
  private readonly usePolling: boolean;
  private readonly debounceMs: number;
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  // Mutable so the host UI toggle can flip it without rebuilding the
  // indexer. Read on every walk / file event to decide whether image
  // extensions are scanned.
  private imageEmbeddingEnabled: boolean;
  private watcher: FSWatcher | null = null;
  private watcherPromise: Promise<void> | null = null;
  private startPromise: Promise<void> | null = null;
  private scanPromise: Promise<FolderAutoIndexerResult> | null = null;
  private scanProgress: ScanProgressSnapshot = createIdleProgress();
  private scanCancelRequested = false;
  onFileIndexed?: (filePath: string, docId: string) => void | Promise<void>;
  onFileRemoved?: (filePath: string, docId: string) => void | Promise<void>;
  onFileFailed?: (filePath: string, docId?: string, error?: string) => void | Promise<void>;
  onScanProgress?: (snapshot: ScanProgressSnapshot) => void;

  constructor(options: FolderAutoIndexerOptions) {
    this.client = options.client;
    this.folders = options.folders.map((folder) => resolve(folder));
    this.extensions = options.extensions ? new Set(options.extensions.map((e) => e.toLowerCase())) : null;
    this.ignored = [...DEFAULT_IGNORED, ...sanitizeIgnoredPatterns(options.ignored ?? [])];
    this.followSymlinks = options.followSymlinks ?? false;
    this.usePolling = options.usePolling ?? false;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.imageEmbeddingEnabled = options.imageEmbeddingEnabled === true;
    this.onScanProgress = options.onScanProgress;
    this.onFileFailed = options.onFileFailed;
  }

  /** Flip the image-embedding toggle at runtime. Subsequent scans /
   * file events observe the new state; in-flight indexing calls keep
   * their original behaviour. */
  setImageEmbeddingEnabled(enabled: boolean): void {
    this.imageEmbeddingEnabled = enabled === true;
  }

  /** When image captioning is re-enabled, force standalone image files to be
   * considered "due" again even if their mtimes did not change while the
   * toggle was off. Keep docId mappings so a subsequent re-index can upsert
   * rather than looking like an unrelated unlink. */
  invalidateImageEntries(): number {
    let invalidated = 0;
    for (const filePath of this.mtimeByPath.keys()) {
      if (!isImageFilePath(filePath)) continue;
      this.mtimeByPath.delete(filePath);
      invalidated += 1;
    }
    return invalidated;
  }

  /**
   * IndexState 기반으로 mtime 캐시를 채운다.
   * IndexState는 Node.js stat.mtimeMs 기준이므로 항상 정확하다.
   * 기존 값을 덮어쓴다(IndexState가 최고 우선순위).
   */
  prePopulateCacheFromState(state: Map<string, { docId: string; mtimeMs: number }>): void {
    for (const [filePath, entry] of state) {
      this.mtimeByPath.set(filePath, entry.mtimeMs);
      this.docIdByPath.set(filePath, entry.docId);
    }
  }

  /**
   * DB docs로 캐시를 보충한다 (IndexState에 없는 경로만).
   * DB mtime 단위(초 vs ms)가 불확실하므로 IndexState가 있는 경로는 건드리지 않는다.
   */
  prePopulateCache(docs: Array<{ path?: string | null; mtime_ms?: number; doc_id?: string }>): void {
    for (const doc of docs) {
      if (!doc.path) continue;
      const absPath = resolve(doc.path);
      // IndexState가 이미 채운 경로는 건드리지 않음
      if (!this.mtimeByPath.has(absPath)) {
        // null/0/음수 mtime은 신뢰할 수 없으므로 저장하지 않음
        if (doc.mtime_ms != null && doc.mtime_ms > 0) {
          this.mtimeByPath.set(absPath, doc.mtime_ms);
        }
      }
      if (doc.doc_id && !this.docIdByPath.has(absPath)) {
        this.docIdByPath.set(absPath, doc.doc_id);
      }
    }
  }

  getScanProgress(): ScanProgressSnapshot {
    return cloneProgress(this.scanProgress);
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;

    const run = async () => {
      try {
        await this.scanOnce();
        await this.ensureWatching();
      } catch (err) {
        this.startPromise = null;
        throw err;
      }
    };

    this.startPromise = run();
    return this.startPromise;
  }

  async ensureWatching(): Promise<void> {
    if (this.watcher) return;
    if (this.watcherPromise) return this.watcherPromise;

    const run = async () => {
      try {
        this.watcher = watch(this.folders, {
          ignored: this.ignored,
          persistent: true,
          ignoreInitial: true,
          followSymlinks: this.followSymlinks,
          usePolling: this.usePolling,
          awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
        });

        this.watcher.on("add", (filePath) => this.scheduleFileEvent(filePath));
        this.watcher.on("change", (filePath) => this.scheduleFileEvent(filePath));
        this.watcher.on("unlink", (filePath) => {
          const pending = this.debounceTimers.get(filePath);
          if (pending) {
            clearTimeout(pending);
            this.debounceTimers.delete(filePath);
          }
          void this.handleUnlinkEvent(filePath);
        });
        this.watcher.on("error", (err) => {
          console.warn("[FolderAutoIndexer] watcher error:", err);
        });
      } catch (err) {
        this.watcher = null;
        this.watcherPromise = null;
        throw err;
      }
    };

    this.watcherPromise = run();
    await this.watcherPromise;
    this.watcherPromise = null;
  }

  cancelScan(): boolean {
    if (!this.scanPromise || this.scanProgress.status !== "running" || this.scanCancelRequested) {
      return false;
    }
    this.scanCancelRequested = true;
    this.emitScanProgress({
      ...this.scanProgress,
      message: "스캔 중단 요청 중...",
    });
    return true;
  }

  async stop(): Promise<void> {
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();

    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        // Ignore start failures during shutdown.
      }
    }

    if (this.scanPromise) {
      try {
        await this.scanPromise;
      } catch {
        // Ignore scan failures during shutdown.
      }
    }

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.watcherPromise = null;
    this.startPromise = null;
  }

  async scanOnce(foldersOverride?: string[]): Promise<FolderAutoIndexerResult> {
    if (this.scanPromise) return this.scanPromise;

    const run = async () => {
      let files: string[] = [];
      let processed = 0;
      let indexed = 0;
      let failed = 0;
      let lastError: string | undefined;
      let canceled = false;

      this.scanCancelRequested = false;

      // Per-folder progress is tracked alongside the global counters so the
      // UI can move finished folders into the "complete" group mid-scan.
      // ``byFolder`` is mutated in place each iteration; ``cloneProgress``
      // deep-copies it on every emit so consumers never share the live map.
      const targetFolders = foldersOverride ?? this.folders;
      const byFolder: Record<string, FolderProgressCounters> = {};
      for (const folder of targetFolders) {
        byFolder[folder] = { total: 0, processed: 0, indexed: 0, failed: 0 };
      }
      const folderByFile = new Map<string, string>();

      this.emitScanProgress({
        status: "running",
        total: 0,
        processed: 0,
        indexed: 0,
        failed: 0,
        currentPath: undefined,
        message: "처리 완료 0 / 0",
        byFolder,
      });

      try {
        const { readdir } = await import("node:fs/promises");
        const allFiles = await this.collectSupportedFiles(readdir, foldersOverride);

        // Pre-filter: 이미 캐시에 있고 mtime이 동일한(up-to-date) 파일은 제외.
        // total이 실제로 처리해야 할 파일 수만 반영되도록 한다.
        for (const filePath of allFiles) {
          const knownMtime = this.mtimeByPath.get(filePath);
          if (knownMtime === undefined) {
            files.push(filePath); // 새 파일
            continue;
          }
          try {
            const { mtimeMs } = await stat(filePath);
            if (Math.floor(knownMtime) < Math.floor(mtimeMs)) {
              files.push(filePath); // stale — 재인덱싱 필요
            }
            // else: up-to-date → skip
          } catch {
            // stat 실패 → skip
          }
        }
        // Partition this cycle's work by owning folder so per-folder totals
        // reflect the actually-due work (skipping up-to-date files).
        for (const filePath of files) {
          const owner = findOwningFolder(filePath, targetFolders);
          if (!owner) continue;
          folderByFile.set(filePath, owner);
          if (!byFolder[owner]) {
            byFolder[owner] = { total: 0, processed: 0, indexed: 0, failed: 0 };
          }
          byFolder[owner].total += 1;
        }

        this.emitScanProgress({
          status: "running",
          total: files.length,
          processed: 0,
          indexed: 0,
          failed: 0,
          currentPath: undefined,
          message: `처리 완료 0 / ${files.length}`,
          byFolder,
        });

        for (const filePath of files) {
          if (this.scanCancelRequested) {
            canceled = true;
            break;
          }

          const owner = folderByFile.get(filePath);
          const counters = owner ? byFolder[owner] : undefined;

          this.emitScanProgress({
            status: "running",
            total: files.length,
            processed,
            indexed,
            failed,
            currentPath: filePath,
            message: `처리 완료 ${processed} / ${files.length}`,
            byFolder,
          });

          try {
            const didIndex = await this.indexIfChanged(filePath);
            if (didIndex) {
              indexed += 1;
              if (counters) counters.indexed += 1;
              const docId = this.docIdByPath.get(filePath);
              if (docId && this.onFileIndexed) {
                try {
                  const cbResult = this.onFileIndexed(filePath, docId);
                  if (cbResult instanceof Promise) await cbResult;
                } catch (cbErr) {
                  console.warn("[FolderAutoIndexer] onFileIndexed callback failed:", cbErr);
                }
              }
            }
          } catch (err) {
            failed += 1;
            if (counters) counters.failed += 1;
            lastError = (err as Error).message;
            // Capture docId before clearing maps so the callback can remove the DB record too.
            const failedDocId = this.docIdByPath.get(filePath);
            // Remove stale state so the file shows as pending in folder summary,
            // not falsely "indexed" from a previous successful (but empty) run.
            this.mtimeByPath.delete(filePath);
            this.docIdByPath.delete(filePath);
            if (this.onFileFailed) {
              try {
                const cbResult = this.onFileFailed(filePath, failedDocId, (err as Error).message);
                if (cbResult instanceof Promise) await cbResult;
              } catch (cbErr) {
                console.warn("[FolderAutoIndexer] onFileFailed callback failed:", cbErr);
              }
            }
          } finally {
            processed += 1;
            if (counters) counters.processed += 1;
            this.emitScanProgress({
              status: "running",
              total: files.length,
              processed,
              indexed,
              failed,
              currentPath: undefined,
              message: this.scanCancelRequested
                ? "스캔 중단 요청 중..."
                : `처리 완료 ${processed} / ${files.length}`,
              byFolder,
            });
          }

          if (this.scanCancelRequested) {
            canceled = true;
            break;
          }
        }

        const stalePaths: string[] = [];
        for (const filePath of this.docIdByPath.keys()) {
          try {
            await access(filePath);
          } catch {
            stalePaths.push(filePath);
          }
        }
        for (const filePath of stalePaths) {
          const docId = this.docIdByPath.get(filePath);
          if (docId && this.client.removeDocument) {
            try {
              await this.client.removeDocument(docId);
            } catch (err) {
              console.warn(
                `[FolderAutoIndexer] scanOnce prune removeDocument failed for ${filePath}:`,
                err,
              );
              continue;
            }
          }
          this.docIdByPath.delete(filePath);
          this.mtimeByPath.delete(filePath);
          if (docId && this.onFileRemoved) {
            try {
              const cbResult = this.onFileRemoved(filePath, docId);
              if (cbResult instanceof Promise) await cbResult;
            } catch (cbErr) {
              console.warn("[FolderAutoIndexer] onFileRemoved callback failed (scanOnce):", cbErr);
            }
          }
        }

        const result = {
          scanned: files.length,
          indexed,
          failed,
          totalIndexed: this.docIdByPath.size,
          canceled,
        } satisfies FolderAutoIndexerResult;

        if (canceled) {
          this.emitScanProgress({
            status: "canceled",
            total: files.length,
            processed,
            indexed,
            failed,
            currentPath: undefined,
            message: `스캔 중단됨. 처리 완료 ${processed} / ${files.length}`,
            byFolder,
          });
        } else if (failed > 0) {
          // Top scan status: keep it generic so the raw per-file error message
          // (e.g. "indexDocument: 인덱싱 실패 (path): empty content") doesn't
          // crowd the UI status line. Per-file failure detail is surfaced
          // through `onFileFailed` → `index.warning` 이벤트 → UI 경고 배너.
          this.emitScanProgress({
            status: "failed",
            total: files.length,
            processed,
            indexed,
            failed,
            currentPath: undefined,
            message: `${failed}개 파일 인덱싱 실패. 상세 사유는 '인덱싱 경고' 배너에서 확인하세요.`,
            byFolder,
          });
        } else {
          this.emitScanProgress({
            status: "done",
            total: files.length,
            processed,
            indexed,
            failed: 0,
            currentPath: undefined,
            message: "스캔 완료",
            byFolder,
          });
        }

        return result;
      } catch (err) {
        // Outer catch covers fatal errors (worker died, fs walker crashed,
        // etc.) which are scan-level not file-level. Keep the raw error here
        // because there is no per-file warning to fall back to.
        const message = (err as Error).message;
        this.emitScanProgress({
          status: "failed",
          total: files.length,
          processed,
          indexed,
          failed: Math.max(failed, 1),
          currentPath: undefined,
          message: `스캔 실패: ${message}`,
          byFolder,
        });
        throw err;
      } finally {
        this.scanCancelRequested = false;
        this.scanPromise = null;
      }
    };

    this.scanPromise = run();
    return this.scanPromise;
  }

  getIndexedEntries(): FolderIndexerEntry[] {
    return [...this.docIdByPath.entries()].map(([filePath, docId]) => ({
      filePath,
      docId,
      mtimeMs: this.mtimeByPath.get(filePath) ?? 0,
    }));
  }

  private emitScanProgress(snapshot: ScanProgressSnapshot): void {
    this.scanProgress = cloneProgress(snapshot);
    this.onScanProgress?.(this.getScanProgress());
  }

  /** Trailing-edge debounce: collapse rapid add/change events into one index call. */
  private scheduleFileEvent(filePath: string): void {
    if (this.debounceMs <= 0) {
      void this.handleFileEvent(filePath);
      return;
    }
    const existing = this.debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      void this.handleFileEvent(filePath);
    }, this.debounceMs);
    this.debounceTimers.set(filePath, timer);
  }

  private async isWithinConfiguredRoots(filePath: string): Promise<boolean> {
    let real: string;
    try {
      real = await realpath(filePath);
    } catch {
      // realpath failed: file doesn't exist or is a broken symlink.
      // Reject broken symlinks to prevent TOCTOU — the unresolved target
      // could point outside roots once the target is created.
      try {
        const lst = await lstat(filePath);
        if (lst.isSymbolicLink()) return false;
      } catch {
        // lstat also failed — file truly doesn't exist, use lexical path.
      }
      real = resolve(filePath);
    }
    for (const root of this.folders) {
      let realRoot: string;
      try {
        realRoot = await realpath(root);
      } catch {
        realRoot = root;
      }
      const rel = relative(realRoot, real);
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
        return true;
      }
    }
    return false;
  }

  private async handleUnlinkEvent(filePath: string): Promise<void> {
    if (!(await this.isWithinConfiguredRoots(filePath))) {
      console.warn(`[FolderAutoIndexer] unlink event outside configured roots dropped: ${filePath}`);
      return;
    }
    const docId = this.docIdByPath.get(filePath);

    if (docId && this.client.removeDocument) {
      try {
        await this.client.removeDocument(docId);
      } catch (err) {
        console.warn(`[FolderAutoIndexer] removeDocument failed for ${filePath}:`, err);
        return;
      }
    }

    this.docIdByPath.delete(filePath);
    this.mtimeByPath.delete(filePath);
    if (docId && this.onFileRemoved) {
      try {
        const cbResult = this.onFileRemoved(filePath, docId);
        if (cbResult instanceof Promise) await cbResult;
      } catch (cbErr) {
        console.warn("[FolderAutoIndexer] onFileRemoved callback failed (unlink):", cbErr);
      }
    }
  }

  private async handleFileEvent(filePath: string): Promise<void> {
    if (!this.isSupportedFile(filePath)) return;
    if (!(await this.isWithinConfiguredRoots(filePath))) {
      console.warn(`[FolderAutoIndexer] file event outside configured roots dropped: ${filePath}`);
      return;
    }

    try {
      const indexed = await this.indexIfChanged(filePath);
      if (indexed) {
        const docId = this.docIdByPath.get(filePath);
        if (docId && this.onFileIndexed) {
          try {
            const cbResult = this.onFileIndexed(filePath, docId);
            if (cbResult instanceof Promise) await cbResult;
          } catch (cbErr) {
            console.warn("[FolderAutoIndexer] onFileIndexed callback failed (watcher):", cbErr);
          }
        }
      }
    } catch {
      // transient FS errors during watcher events are expected; suppress debug noise
    }
  }

  private async indexIfChanged(filePath: string): Promise<boolean> {
    let metadata: Awaited<ReturnType<typeof stat>>;
    try {
      metadata = await stat(filePath);
    } catch {
      return false;
    }
    const currentMtime = metadata.mtimeMs;
    const knownMtime = this.mtimeByPath.get(filePath);
    if (knownMtime !== undefined && knownMtime >= currentMtime) return false;

    const mode =
      getIndexModeForPath(filePath, { includeImages: this.imageEmbeddingEnabled }) ?? "auto";

    const docId = await this.client.indexDocument(filePath, mode);
    this.mtimeByPath.set(filePath, currentMtime);
    this.docIdByPath.set(filePath, docId);
    return true;
  }

  private isSupportedFile(filePath: string): boolean {
    const name = basename(filePath);
    if (TEMP_FILE_PREFIXES.some((p) => name.startsWith(p))) return false;
    if (this.extensions !== null) {
      return this.extensions.has(extname(filePath).toLowerCase());
    }
    return isIndexableFilePath(filePath, { includeImages: this.imageEmbeddingEnabled });
  }

  private async collectSupportedFiles(
    readdir: typeof import("node:fs/promises").readdir,
    foldersOverride?: string[],
  ): Promise<string[]> {
    const folders = foldersOverride ?? this.folders;
    const allFiles = await Promise.all(folders.map((folder) => this.walkDir(folder, readdir)));
    return allFiles.flat().filter((filePath) => this.isSupportedFile(filePath));
  }

  private async walkDir(
    dirPath: string,
    readdir: typeof import("node:fs/promises").readdir,
  ): Promise<string[]> {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        if (entry.isDirectory() && SKIP_DIR_NAMES.has(entry.name)) {
          continue;
        }
        const fullPath = resolve(dirPath, entry.name);
        if (entry.isDirectory()) {
          files.push(...(await this.walkDir(fullPath, readdir)));
        } else if (entry.isFile()) {
          files.push(fullPath);
        }
      }
      return files;
    } catch (err) {
      console.warn(`[FolderAutoIndexer] walkDir: readdir failed for ${dirPath}:`, err);
      return [];
    }
  }
}
