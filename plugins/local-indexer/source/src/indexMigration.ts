/**
 * The visible rebuild that moves the index out of `<pluginDataDir>/index`.
 *
 * Before 0.8.0 the worker kept its index (`fts5.sqlite`, `vectors.lance`) in
 * the plugin's own data directory. From 0.8.0 it lives in the worker's private
 * state directory, which the host creates beside that data directory and only
 * the worker may write. The plugin process cannot write there, so nothing is
 * copied: the new index is rebuilt from the registered folders, and the old
 * directory is deleted only once the rebuild is known to be complete.
 *
 * "Complete" means all of these held for one full scan:
 *   - the folders came from the user's saved folder list, not the built-in
 *     fallback set used when that list is missing or unreadable;
 *   - every directory under them could be listed (an unmounted volume or a
 *     folder the OS refuses is not an empty folder);
 *   - with at least one registered folder, the walk saw at least one file,
 *     and no folder that the plugin's index state says held documents now
 *     shows none (an unmounted volume's empty mountpoint lists cleanly);
 *   - the scan was not cancelled, and no file failed for a reason that may
 *     pass (a lost worker, a cancelled or backed-up request). A file the
 *     worker itself judged unindexable (too large, encrypted, unparseable)
 *     fails again the same way, so it counts as done;
 *   - every document the scan holds as indexed is present in the worker.
 * Anything less keeps the old directory, and the next start tries again, up
 * to `maxAttempts` automatic attempts (a cancelled scan does not count). After that the old directory stays
 * and the status says why, so a cause that never clears does not rescan
 * every folder on every start.
 */

import { isAbsolute, relative, resolve } from "node:path";
import type { FolderAutoIndexerResult } from "./types.js";
import type { IndexLocation } from "./localIndexerPlugin.js";

export type IndexMigrationPhase = "rebuilding" | "completed" | "kept-old";

/** Automatic rebuild attempts before the plugin stops retrying on start. */
export const INDEX_MIGRATION_MAX_ATTEMPTS = 5;

/** Where the scanned folder list came from. */
export type FolderSource = "saved" | "fallback";

/** What the plugin shows and logs about the rebuild. */
export interface IndexMigrationStatus {
  phase: IndexMigrationPhase;
  legacyIndexDir: string;
  indexRoot: string;
  /** Documents the new index held before the rebuild began. */
  documentsBefore: number;
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
  /** The worker's document count after the scan, when it was asked. */
  documentsAfter?: number;
  /** Why the old directory was kept. */
  reason?: string;
}

export interface MigrationScan {
  result: FolderAutoIndexerResult;
  folderSource: FolderSource;
  registeredFolders: number;
  /**
   * Per registered folder, how many documents the plugin's own index state
   * (index-state.json, kept beside the old index) recorded under it before
   * this scan. A folder that had documents and now shows no files at all is
   * most likely an unmounted volume whose empty mountpoint lists cleanly.
   */
  previouslyIndexedByFolder?: Record<string, number>;
}

/** Persisted across starts so the attempt bound survives a restart. */
export interface MigrationAttempts {
  attempts: number;
  lastReason?: string;
}

export interface IndexMigrationDeps {
  location: IndexLocation;
  /** The worker's scratch workspace; never deleted with the old index. */
  workspace: string;
  /** Run one full scan of the registered folders (the normal index_scan path). */
  runFullScan: (status: IndexMigrationStatus) => Promise<MigrationScan>;
  /**
   * Ask the worker what it holds now: its document count, and how many of
   * the documents the scan holds as indexed it does not have.
   */
  verifyIndexed: () => Promise<{ documentCount: number; missing: number }>;
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

/** Why a finished scan does not prove the rebuild complete, or null when it does. */
function incompleteScanReason(scan: MigrationScan): string | null {
  const { result } = scan;
  if (result.canceled) return "the rebuild scan was cancelled";
  if (scan.folderSource === "fallback") {
    return "the saved folder list was missing or unreadable, so the scan used the default folders";
  }
  const unreadable = result.unreadableFolders ?? [];
  if (unreadable.length > 0) {
    return `${unreadable.length} folder(s) could not be read: ${unreadable.slice(0, 3).join(", ")}`;
  }
  if (scan.registeredFolders > 0 && (result.walked ?? 0) === 0) {
    return `the ${scan.registeredFolders} registered folder(s) held no files`;
  }
  const vanished = Object.entries(scan.previouslyIndexedByFolder ?? {}).filter(
    ([folder, before]) => before > 0 && (result.walkedByFolder?.[folder] ?? 0) === 0,
  );
  if (vanished.length > 0) {
    const [folder, before] = vanished[0]!;
    return (
      `${vanished.length} folder(s) that held indexed documents now show no files ` +
      `(${folder} had ${before}; an unmounted volume? If the folder was emptied on purpose, remove it from the index folders)`
    );
  }
  const transient = result.failedTransient ?? 0;
  if (transient > 0) {
    return `${transient} file(s) failed for a reason that may pass (worker lost or request cancelled)`;
  }
  return null;
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
    registeredFolders: scan.registeredFolders,
  };
  const incomplete = incompleteScanReason(scan);
  if (incomplete) return keep(incomplete, !result.canceled);

  let verified: { documentCount: number; missing: number };
  try {
    verified = await deps.verifyIndexed();
  } catch (err) {
    return keep(`the worker did not report its documents: ${(err as Error).message}`);
  }
  status.documentsAfter = verified.documentCount;
  if (verified.missing > 0) {
    return keep(`${verified.missing} document(s) the scan indexed are missing from the worker`);
  }

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
  const done: IndexMigrationStatus = { ...status, phase: "completed" };
  deps.report(done);
  return done;
}
