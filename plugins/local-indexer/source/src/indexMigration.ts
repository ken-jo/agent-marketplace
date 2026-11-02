/**
 * The visible rebuild that moves the index out of `<pluginDataDir>/index`.
 *
 * Before 0.8.0 the worker kept its index (`fts5.sqlite`, `vectors.lance`) in
 * the plugin's own data directory. From 0.8.0 it lives in the worker's private
 * state directory, which the host creates beside that data directory and only
 * the worker may write. The plugin process cannot write there, so nothing is
 * copied: the new index is rebuilt from the registered folders, and the old
 * directory is deleted only once the new index covers what the old one held.
 *
 * Coverage is measured against a manifest of the old index (each document it
 * held as indexed: its path, the mtime it was read at, and whether it had
 * vectors), read once and kept beside the old directory so a retry does not
 * depend on reading it again. Each old document is one of:
 *   - excluded: its file is gone, it is no longer under a registered folder
 *     (the user removed that folder), the current settings no longer index
 *     its type, or it is unchanged since the old index read it and the new
 *     parse rejects it as unreadable (a verdict, not a fault; noted);
 *   - required: everything else. A required document must be in the new
 *     index, and if it had vectors and embedding is configured now, it must
 *     have vectors in the new index too.
 * A document under a folder the scan could not list, or under a folder that
 * held old documents and now lists no files at all (an unmounted volume's
 * empty mountpoint lists cleanly), cannot be judged and keeps the old index.
 * So does a scan that used the built-in fallback folder list.
 *
 * Whether a failure may pass (a lost worker, a provider outage) only shapes
 * the status text; it no longer decides deletion. Anything short of full
 * coverage keeps the old directory, and the next start tries again, up to
 * `maxAttempts` automatic attempts (a cancelled scan does not count). After
 * that the old directory stays and the status says why, so a cause that never
 * clears does not rescan every folder on every start.
 */

import { isAbsolute, relative, resolve } from "node:path";
import type { FolderAutoIndexerResult } from "./types.js";
import type { IndexLocation } from "./localIndexerPlugin.js";

export type IndexMigrationPhase = "rebuilding" | "completed" | "kept-old";

/** Automatic rebuild attempts before the plugin stops retrying on start. */
export const INDEX_MIGRATION_MAX_ATTEMPTS = 5;

/**
 * After this many documents in a row stay without vectors when the rebuild
 * re-embeds them, the embedding provider is taken to be down and the
 * remaining re-embeds wait for the next attempt.
 */
export const BACKFILL_STOP_AFTER = 3;

/** Where the scanned folder list came from. */
export type FolderSource = "saved" | "fallback";

/** One document the old index held as indexed. */
export interface LegacyManifestDocument {
  /** Absolute path, as the old worker stored it. */
  path: string;
  /** `int(getmtime * 1000)` when the old index read the file. */
  mtimeMs: number;
  /** Whether any of its chunks had an embedding. */
  hadVectors: boolean;
}

/** How the new index covers the old one. */
export interface IndexCoverage {
  /** Old documents the new index has to hold. */
  required: number;
  /** Of those, held (with vectors where needed). */
  covered: number;
  /** Required, but not in the new index. */
  missingDocuments: number;
  /** In the new index, but without the vectors the old one had. */
  missingVectors: number;
  /** Old documents whose files are gone. */
  excludedGone: number;
  /** Old documents under a folder no longer registered. */
  excludedRootRemoved: number;
  /** Old documents whose type the current settings do not index. */
  excludedUnsupported: number;
  /** Old documents, unchanged on disk, that the new parser rejects. */
  excludedCorrupt: string[];
  /** Registered folders the scan could not list, with old documents under them. */
  unavailableFolders: string[];
  /** Registered folders that held old documents and now list no files. */
  vanishedFolders: string[];
  /** Of the missing documents, those whose last failure may pass. */
  missingRetryable: number;
  /** Documents re-embedded during this attempt, and how many got vectors. */
  backfill?: { attempted: number; embedded: number };
}

/** What the plugin shows and logs about the rebuild. */
export interface IndexMigrationStatus {
  phase: IndexMigrationPhase;
  legacyIndexDir: string;
  indexRoot: string;
  /** Documents the new index held before the rebuild began. */
  documentsBefore: number;
  /** Documents the old index held as indexed. */
  legacyDocuments?: number;
  /** This attempt's number, counting from 1, and the bound. */
  attempt: number;
  maxAttempts: number;
  /** True once the attempts are used up: no further automatic rebuild. */
  retriesExhausted?: boolean;
  /** Set once the scan finished. */
  scan?: {
    scanned: number;
    indexed: number;
    failed: number;
    failedTransient: number;
    walked: number;
    unreadableFolders: string[];
    totalIndexed: number;
    canceled?: boolean;
    folderSource: FolderSource;
    registeredFolders: number;
  };
  coverage?: IndexCoverage;
  /** The worker's document count after the scan, when it was asked. */
  documentsAfter?: number;
  /** Why the old directory was kept. */
  reason?: string;
  /** What the user should know even when the rebuild completed. */
  notes?: string[];
}

export interface MigrationScan {
  result: FolderAutoIndexerResult;
  folderSource: FolderSource;
  /** The folders the scan walked (the registered list). */
  folders: string[];
}

/** Persisted across starts so the attempt bound survives a restart. */
export interface MigrationAttempts {
  attempts: number;
  lastReason?: string;
}

/** One document of the new index, as the worker lists it. */
export interface NewIndexDocument {
  path: string;
  status?: string;
  contentState?: string;
}

export interface CoverageDeps {
  /** Every document the new index holds. */
  listNewDocuments: () => Promise<NewIndexDocument[]>;
  /** Whether embedding is configured now (a key or endpoint the scan would use). */
  embeddingConfigured: () => Promise<boolean>;
  /**
   * The file's mtime in ms, or "gone" when it no longer exists (ENOENT,
   * ENOTDIR). Any other error throws: the file may still be there.
   */
  fileMtime: (path: string) => Promise<number | "gone">;
  /** Whether a scan of `folder` would index `path` under the current settings. */
  wouldIndex: (path: string, folder: string) => boolean;
  /** Re-index one file, bypassing the scan's mtime skip; true when it now has vectors. */
  reindex: (path: string) => Promise<boolean>;
}

export interface IndexMigrationDeps {
  location: IndexLocation;
  /** The worker's scratch workspace; never deleted with the old index. */
  workspace: string;
  /**
   * The old index's manifest: read from the persisted copy when one exists,
   * otherwise built from the old index and persisted.
   */
  loadManifest: () => Promise<LegacyManifestDocument[]>;
  /** Drop the persisted manifest once the old index is gone. */
  discardManifest: () => Promise<void>;
  /** Run one full scan of the registered folders (the normal index_scan path). */
  runFullScan: (status: IndexMigrationStatus) => Promise<MigrationScan>;
  coverage: CoverageDeps;
  /** The worker's document count. */
  documentCount: () => Promise<number>;
  /** Remove a directory tree (the plugin child owns `pluginDataDir`). */
  removeDirectory: (path: string) => Promise<void>;
  /** The attempt ledger, kept outside the old index directory. */
  attempts: {
    read: () => Promise<MigrationAttempts>;
    write: (next: MigrationAttempts) => Promise<void>;
    clear: () => Promise<void>;
  };
  maxAttempts?: number;
  /** Called at every phase change. */
  report: (status: IndexMigrationStatus) => void;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The registered folder that owns `path`: the deepest one containing it. */
function owningFolder(path: string, folders: string[]): string | null {
  let best: string | null = null;
  for (const folder of folders) {
    if (isInside(path, folder) && (best === null || resolve(folder).length > resolve(best).length)) best = folder;
  }
  return best;
}

/** Whether two mtimes in ms name the same file version (Python and Node round differently). */
function sameMtime(currentMs: number, oldMs: number): boolean {
  return Math.abs(Math.floor(currentMs) - Math.floor(oldMs)) <= 1;
}

interface Assessment {
  coverage: IndexCoverage;
  /** Required documents that should have vectors and do not. */
  vectorGaps: string[];
}

/** Measure how the new index covers the manifest after `scan`. */
export async function assessCoverage(
  manifest: LegacyManifestDocument[],
  scan: MigrationScan,
  deps: CoverageDeps,
): Promise<Assessment> {
  const { result, folders } = scan;
  const unreadable = result.unreadableFolders ?? [];
  const lastFailure = new Map<string, boolean>();
  for (const failure of result.failures ?? []) lastFailure.set(resolve(failure.path), failure.retryable);
  const held = new Map<string, NewIndexDocument>();
  for (const doc of await deps.listNewDocuments()) {
    if (doc.status === undefined || doc.status === "indexed") held.set(resolve(doc.path), doc);
  }
  const embedding = await deps.embeddingConfigured();

  const coverage: IndexCoverage = {
    required: 0,
    covered: 0,
    missingDocuments: 0,
    missingVectors: 0,
    excludedGone: 0,
    excludedRootRemoved: 0,
    excludedUnsupported: 0,
    excludedCorrupt: [],
    unavailableFolders: [],
    vanishedFolders: [],
    missingRetryable: 0,
  };
  const vectorGaps: string[] = [];
  const unavailable = new Set<string>();
  const oldByFolder = new Map<string, number>();

  for (const doc of manifest) {
    const path = resolve(doc.path);
    const folder = owningFolder(path, folders);
    if (folder === null) {
      coverage.excludedRootRemoved += 1;
      continue;
    }
    oldByFolder.set(folder, (oldByFolder.get(folder) ?? 0) + 1);
    if (unreadable.some((dir) => isInside(path, dir))) {
      // The walk could not list a directory on the way to this file: it may
      // be there, unindexed. Judged on a later attempt.
      unavailable.add(folder);
      continue;
    }
    let mtime: number | "gone" | undefined;
    try {
      mtime = await deps.fileMtime(path);
    } catch {
      mtime = undefined; // exists as far as anyone can tell
    }
    if (mtime === "gone") {
      coverage.excludedGone += 1;
      continue;
    }
    if (!deps.wouldIndex(path, folder)) {
      coverage.excludedUnsupported += 1;
      continue;
    }
    const now = held.get(path);
    if (!now) {
      const retryable = lastFailure.get(path);
      if (retryable === false && mtime !== undefined && sameMtime(mtime, doc.mtimeMs)) {
        coverage.excludedCorrupt.push(path);
        continue;
      }
      coverage.required += 1;
      coverage.missingDocuments += 1;
      if (retryable === true) coverage.missingRetryable += 1;
      continue;
    }
    coverage.required += 1;
    if (doc.hadVectors && embedding && now.contentState !== "ok") {
      coverage.missingVectors += 1;
      vectorGaps.push(path);
      continue;
    }
    coverage.covered += 1;
  }

  for (const [folder, count] of oldByFolder) {
    if (count > 0 && !unavailable.has(folder) && (result.walkedByFolder?.[folder] ?? 0) === 0) {
      coverage.vanishedFolders.push(folder);
    }
  }
  coverage.unavailableFolders = [...unavailable];
  return { coverage, vectorGaps };
}

/** Why the coverage does not let the old index go, or null when it does. */
function coverageGapReason(coverage: IndexCoverage): string | null {
  const parts: string[] = [];
  if (coverage.unavailableFolders.length > 0) {
    parts.push(
      `${coverage.unavailableFolders.length} folder(s) could not be read: ` +
        coverage.unavailableFolders.slice(0, 3).join(", "),
    );
  }
  if (coverage.vanishedFolders.length > 0) {
    parts.push(
      `${coverage.vanishedFolders.length} folder(s) that held indexed documents now show no files ` +
        `(${coverage.vanishedFolders[0]}; an unmounted volume? If the folder was emptied on purpose, ` +
        "remove it from the index folders)",
    );
  }
  if (coverage.missingDocuments > 0 || coverage.missingVectors > 0) {
    const retryable = coverage.missingRetryable > 0
      ? ` (${coverage.missingRetryable} failed for a reason that may pass)`
      : "";
    parts.push(
      `the new index lacks ${coverage.missingDocuments} document(s)${retryable} and the vectors of ` +
        `${coverage.missingVectors} document(s) that the old index held`,
    );
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

function coverageNotes(coverage: IndexCoverage): string[] {
  const notes: string[] = [];
  if (coverage.excludedCorrupt.length > 0) {
    notes.push(
      `${coverage.excludedCorrupt.length} document(s) from the old index could not be read by the new parser ` +
        `and were left out: ${coverage.excludedCorrupt.slice(0, 3).join(", ")}`,
    );
  }
  return notes;
}

/**
 * Rebuild into the new location and retire the old one. Returns the final
 * status, or null when there is nothing to migrate.
 */
export async function migrateLegacyIndex(deps: IndexMigrationDeps): Promise<IndexMigrationStatus | null> {
  const { location } = deps;
  const legacyIndexDir = location.legacyIndexDir;
  if (!legacyIndexDir) return null;
  const maxAttempts = deps.maxAttempts ?? INDEX_MIGRATION_MAX_ATTEMPTS;

  const previous = await deps.attempts.read();
  const status: IndexMigrationStatus = {
    phase: "rebuilding",
    legacyIndexDir,
    indexRoot: location.indexRoot,
    documentsBefore: location.documentCount,
    attempt: previous.attempts + 1,
    maxAttempts,
  };

  if (previous.attempts >= maxAttempts) {
    const stopped: IndexMigrationStatus = {
      ...status,
      attempt: previous.attempts,
      phase: "kept-old",
      retriesExhausted: true,
      reason:
        `automatic rebuild stopped after ${previous.attempts} attempt(s); ` +
        `last reason: ${previous.lastReason ?? "unknown"}`,
    };
    deps.report(stopped);
    return stopped;
  }

  // `counted: false` for a cancelled scan: quitting the app mid-rebuild is
  // not a failed attempt, and must not use up the bound.
  const keep = async (reason: string, counted = true): Promise<IndexMigrationStatus> => {
    const kept: IndexMigrationStatus = {
      ...status,
      phase: "kept-old",
      reason,
      ...(counted && status.attempt >= maxAttempts ? { retriesExhausted: true } : {}),
    };
    if (counted) {
      try {
        await deps.attempts.write({ attempts: status.attempt, lastReason: reason });
      } catch {
        // The ledger is a backstop; failing to write it only costs a retry.
      }
    }
    deps.report(kept);
    return kept;
  };

  if (isInside(location.indexRoot, legacyIndexDir) || isInside(deps.workspace, legacyIndexDir)) {
    // The new index or the scratch workspace sits inside the old directory;
    // deleting it would delete them.
    return keep("the new index or the workspace is inside the old index directory");
  }

  let manifest: LegacyManifestDocument[];
  try {
    manifest = await deps.loadManifest();
  } catch (err) {
    return keep(`the old index could not be read: ${(err as Error).message}`);
  }
  status.legacyDocuments = manifest.length;

  deps.report(status);
  let scan: MigrationScan;
  try {
    scan = await deps.runFullScan(status);
  } catch (err) {
    return keep(`the rebuild scan failed: ${(err as Error).message}`);
  }
  const { result } = scan;
  status.scan = {
    scanned: result.scanned,
    indexed: result.indexed,
    failed: result.failed,
    failedTransient: result.failedTransient ?? 0,
    walked: result.walked ?? 0,
    unreadableFolders: [...(result.unreadableFolders ?? [])],
    totalIndexed: result.totalIndexed,
    canceled: result.canceled,
    folderSource: scan.folderSource,
    registeredFolders: scan.folders.length,
  };
  if (result.canceled) return keep("the rebuild scan was cancelled", false);
  if (scan.folderSource === "fallback") {
    return keep("the saved folder list was missing or unreadable, so the scan used the default folders");
  }

  let assessed: Assessment;
  try {
    assessed = await assessCoverage(manifest, scan, deps.coverage);
    if (assessed.vectorGaps.length > 0) {
      // The scan skips a file the new index already holds at this mtime, so a
      // document embedded during an outage would never get vectors from a
      // later scan. Re-embed those here, then measure again.
      const backfill = { attempted: 0, embedded: 0 };
      let failedInARow = 0;
      for (const path of assessed.vectorGaps) {
        backfill.attempted += 1;
        let embedded = false;
        try {
          embedded = await deps.coverage.reindex(path);
        } catch {
          embedded = false;
        }
        if (embedded) {
          backfill.embedded += 1;
          failedInARow = 0;
        } else if (++failedInARow >= BACKFILL_STOP_AFTER) {
          break;
        }
      }
      assessed = await assessCoverage(manifest, scan, deps.coverage);
      assessed.coverage.backfill = backfill;
    }
  } catch (err) {
    return keep(`the new index could not be checked: ${(err as Error).message}`);
  }
  status.coverage = assessed.coverage;
  const notes = coverageNotes(assessed.coverage);
  if (notes.length > 0) status.notes = notes;
  try {
    status.documentsAfter = await deps.documentCount();
  } catch (err) {
    return keep(`the worker did not report its documents: ${(err as Error).message}`);
  }

  const gap = coverageGapReason(assessed.coverage);
  if (gap) return keep(gap);

  try {
    await deps.removeDirectory(legacyIndexDir);
  } catch (err) {
    return keep(`the old index directory could not be removed: ${(err as Error).message}`);
  }
  try {
    await deps.attempts.clear();
  } catch {
    // Nothing is left to migrate, so a stale ledger is never read again.
  }
  try {
    await deps.discardManifest();
  } catch {
    // Same: the manifest is only read while the old directory exists.
  }
  const done: IndexMigrationStatus = { ...status, phase: "completed" };
  deps.report(done);
  return done;
}
