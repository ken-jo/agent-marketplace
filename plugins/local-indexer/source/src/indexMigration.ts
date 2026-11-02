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
 * "Complete" means a full scan that was not cancelled, failed no file, and
 * left the worker answering with exactly as many documents as the scan
 * reports indexed. Anything less leaves the old directory where it is, and
 * the next start tries again. No marker file is kept: the old directory's
 * presence is the state.
 */

import { isAbsolute, relative, resolve } from "node:path";
import type { FolderAutoIndexerResult } from "./types.js";
import type { IndexLocation } from "./localIndexerPlugin.js";

export type IndexMigrationPhase = "rebuilding" | "completed" | "kept-old";

/** What the plugin shows and logs about the rebuild. */
export interface IndexMigrationStatus {
  phase: IndexMigrationPhase;
  legacyIndexDir: string;
  indexRoot: string;
  /** Documents the new index held before the rebuild began. */
  documentsBefore: number;
  /** Set once the scan finished. */
  scan?: Pick<FolderAutoIndexerResult, "scanned" | "indexed" | "failed" | "totalIndexed" | "canceled">;
  /** The worker's document count after the scan, when it was asked. */
  documentsAfter?: number;
  /** Why the old directory was kept. */
  reason?: string;
}

export interface IndexMigrationDeps {
  location: IndexLocation;
  /** The worker's scratch workspace; never deleted with the old index. */
  workspace: string;
  /** Run one full scan of the registered folders (the normal index_scan path). */
  runFullScan: (status: IndexMigrationStatus) => Promise<FolderAutoIndexerResult>;
  /** Ask the worker how many documents it holds now. */
  countDocuments: () => Promise<number>;
  /** Remove a directory tree (the plugin child owns `pluginDataDir`). */
  removeDirectory: (path: string) => Promise<void>;
  /** Called at every phase change. */
  report: (status: IndexMigrationStatus) => void;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Rebuild into the new location and retire the old one. Returns the final
 * status, or null when there is nothing to migrate.
 */
export async function migrateLegacyIndex(deps: IndexMigrationDeps): Promise<IndexMigrationStatus | null> {
  const { location } = deps;
  const legacyIndexDir = location.legacyIndexDir;
  if (!legacyIndexDir) return null;

  const status: IndexMigrationStatus = {
    phase: "rebuilding",
    legacyIndexDir,
    indexRoot: location.indexRoot,
    documentsBefore: location.documentCount,
  };
  const keep = (reason: string): IndexMigrationStatus => {
    const kept: IndexMigrationStatus = { ...status, phase: "kept-old", reason };
    deps.report(kept);
    return kept;
  };

  if (isInside(location.indexRoot, legacyIndexDir) || isInside(deps.workspace, legacyIndexDir)) {
    // The new index or the scratch workspace sits inside the old directory;
    // deleting it would delete them.
    return keep("the new index or the workspace is inside the old index directory");
  }

  deps.report(status);
  let scan: FolderAutoIndexerResult;
  try {
    scan = await deps.runFullScan(status);
  } catch (err) {
    return keep(`the rebuild scan failed: ${(err as Error).message}`);
  }
  status.scan = {
    scanned: scan.scanned,
    indexed: scan.indexed,
    failed: scan.failed,
    totalIndexed: scan.totalIndexed,
    canceled: scan.canceled,
  };
  if (scan.canceled) return keep("the rebuild scan was cancelled");
  if (scan.failed > 0) return keep(`${scan.failed} file(s) failed to index`);

  let count: number;
  try {
    count = await deps.countDocuments();
  } catch (err) {
    return keep(`the worker did not report its documents: ${(err as Error).message}`);
  }
  status.documentsAfter = count;
  if (count !== scan.totalIndexed) {
    return keep(`the worker holds ${count} document(s) but the scan indexed ${scan.totalIndexed}`);
  }

  try {
    await deps.removeDirectory(legacyIndexDir);
  } catch (err) {
    return keep(`the old index directory could not be removed: ${(err as Error).message}`);
  }
  const done: IndexMigrationStatus = { ...status, phase: "completed" };
  deps.report(done);
  return done;
}
