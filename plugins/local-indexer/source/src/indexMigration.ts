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
 * vectors) and the folder list saved when the manifest was read. Both are kept
 * beside the old directory so a retry measures against the same list.
 *
 * The check fails closed (see `assessCoverage`): an old document leaves the
 * required set only on positive evidence of a named exclusion, a required
 * vector is waived only when the settings turn embedding off, and anything
 * that cannot be decided keeps the old index, with a count in the status.
 *
 * Whether a failure may pass (a lost worker, a provider outage) only shapes
 * the status text. Anything short of full coverage keeps the old directory,
 * and the next start tries again, up to `maxAttempts` automatic attempts (a
 * cancelled scan, or a manifest read deferred because the old index changed
 * under the copy or the disk is full, does not count). After that the old
 * directory stays and the status says why, so a cause that never clears does
 * not rescan every folder on every start.
 */

import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

/**
 * Whether embedding is available now: "on", "off" only when the settings say
 * so (no plugin key stored, or a custom endpoint the host key is withheld
 * from), and "unknown" when it could not be determined (a refused or failed
 * host lease, an unreadable key store).
 */
export type EmbeddingState = "on" | "off" | "unknown";

/** One document the old index held as indexed. */
export interface LegacyManifestDocument {
  /** Absolute path, as the old worker stored it. */
  path: string;
  /** `int(getmtime * 1000)` when the old index read the file. */
  mtimeMs: number;
  /** Whether any of its chunks had an embedding. */
  hadVectors: boolean;
}

/** The old index, as read once before the first rebuild attempt. */
export interface LegacyManifest {
  documents: LegacyManifestDocument[];
  /**
   * The saved folder list when the manifest was read (the list the old index
   * was built from), or null when it could not be read. Only a folder in this
   * list and absent from the current one counts as removed by the user.
   */
  folders: string[] | null;
}

/**
 * The manifest could not be read for a reason that is not the rebuild's
 * fault (the old index changed while it was copied, the disk is full). The
 * attempt is not counted.
 */
export class MigrationDeferred extends Error {
  readonly kind: "index-busy" | "no-space";
  constructor(kind: "index-busy" | "no-space", message: string) {
    super(message);
    this.name = "MigrationDeferred";
    this.kind = kind;
  }
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
  /** Held, but whether their vectors are required could not be decided. */
  undecidedVectors: number;
  /**
   * Old documents under no registered folder (indexed one by one, e.g. a
   * dropped file) that are still required. They are re-indexed directly.
   */
  outside: number;
  /** Of those, the ones whose file or folder could not be read: undecidable. */
  outsideUnreadable: number;
  /** Required documents the worker refuses as over the size limit now. */
  tooLarge: string[];
  /** Old documents whose files are gone. */
  excludedGone: number;
  /** Old documents under a folder the user removed since the manifest was read. */
  excludedRootRemoved: number;
  /** Old documents whose type the current settings do not index. */
  excludedUnsupported: number;
  /** Old documents, unchanged on disk, that the new parser rejects. */
  excludedCorrupt: string[];
  /** Registered folders that could not be listed or resolved, with old documents under them. */
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
  /** Set when the attempt waited on something outside the rebuild (not counted). */
  deferred?: "index-busy" | "no-space";
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
  /** Whether embedding is available now; see EmbeddingState. */
  embeddingState: () => Promise<EmbeddingState>;
  /**
   * The file's mtime in ms, or "gone" when it no longer exists (ENOENT,
   * ENOTDIR). Any other error throws: the file may still be there.
   */
  fileMtime: (path: string) => Promise<number | "gone">;
  /** Whether a scan of `folder` would index `path` under the current settings. */
  wouldIndex: (path: string, folder: string) => boolean;
  /** Re-index one file, bypassing the scan's mtime skip; true when it now has vectors. */
  reindex: (path: string) => Promise<boolean>;
  /**
   * Index files directly, outside a scan (a document under no registered
   * folder, or a second parse of one judged unparseable). Each answer says
   * whether it indexed and, when not, how it failed.
   */
  indexDirect: (paths: string[]) => Promise<DirectIndexResult[]>;
  /** The real path of a folder; throws when it cannot be resolved (offline, gone). */
  realpath: (path: string) => Promise<string>;
  /**
   * Whether the filesystem under `folder` compares names case-insensitively,
   * measured (the case-swapped path names the same file); false when it
   * cannot be measured.
   */
  caseInsensitive: (folder: string) => Promise<boolean>;
}

/** One file indexed by CoverageDeps.indexDirect. */
export interface DirectIndexResult {
  path: string;
  indexed: boolean;
  retryable?: boolean;
  failureKind?: string;
}

export interface IndexMigrationDeps {
  location: IndexLocation;
  /** The worker's scratch workspace; never deleted with the old index. */
  workspace: string;
  /**
   * The old index's manifest: read from the persisted copy when one exists,
   * otherwise built from the old index and persisted. Throws
   * MigrationDeferred when the read should wait for a later start.
   */
  loadManifest: () => Promise<LegacyManifest>;
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

/** Whether two mtimes in ms name the same file version (Python and Node round differently). */
function sameMtime(currentMs: number, oldMs: number): boolean {
  return Math.abs(Math.floor(currentMs) - Math.floor(oldMs)) <= 1;
}

/** A path as compared here: absolute and NFC. Exact: case is kept. */
function pathKey(path: string): string {
  return resolve(path).normalize("NFC");
}

/** Whether key `child` is `parent` or under it (both from pathKey, or both folded). */
function keyInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(prefix);
}

const fold = (key: string): string => key.toLowerCase();

interface Root {
  folder: string;
  /** pathKey of the folder as registered, and of its real path when that resolves. */
  forms: string[];
  resolved: boolean;
  /** Measured: names under this folder compare case-insensitively. */
  caseInsensitive: boolean;
}

async function rootsOf(folders: string[], deps: CoverageDeps): Promise<Root[]> {
  const roots: Root[] = [];
  for (const folder of folders) {
    const forms = [pathKey(folder)];
    let resolved = true;
    try {
      const real = pathKey(await deps.realpath(folder));
      if (!forms.includes(real)) forms.push(real);
    } catch {
      resolved = false;
    }
    let caseInsensitive = false;
    try {
      caseInsensitive = await deps.caseInsensitive(folder);
    } catch {
      caseInsensitive = false; // not measured: exact names only
    }
    roots.push({ folder, forms, resolved, caseInsensitive });
  }
  return roots;
}

/**
 * The root owning `key` through the longest matching form, and that form.
 * Exact containment first; case-folded containment only on a root measured
 * case-insensitive.
 */
function owner(key: string, roots: Root[]): { root: Root; form: string } | null {
  let best: { root: Root; form: string } | null = null;
  for (const root of roots) {
    for (const form of root.forms) {
      if (keyInside(key, form) && (best === null || form.length > best.form.length)) best = { root, form };
    }
  }
  if (best) return best;
  for (const root of roots) {
    if (!root.caseInsensitive) continue;
    for (const form of root.forms) {
      if (keyInside(fold(key), fold(form)) && (best === null || form.length > best.form.length)) best = { root, form };
    }
  }
  return best;
}

/** A path map with exact lookup, and folded lookup where a measured root allows it. */
class PathIndex<T> {
  private readonly exact = new Map<string, T>();
  private readonly folded = new Map<string, T>();
  set(path: string, value: T): void {
    const key = pathKey(path);
    this.exact.set(key, value);
    this.folded.set(fold(key), value);
  }
  get(key: string, foldAllowed: boolean): T | undefined {
    return this.exact.get(key) ?? (foldAllowed ? this.folded.get(fold(key)) : undefined);
  }
}

interface Assessment {
  coverage: IndexCoverage;
  /** Required documents that should have vectors and do not. */
  vectorGaps: string[];
  /** Required documents under no registered folder, readable, not in the new index. */
  outsidePending: string[];
  /** Missing documents judged unparseable once, unchanged: parsed again to confirm. */
  unparseableOnce: string[];
}

/** What the migration learned outside the scan, fed back into the check. */
export interface CoverageEvidence {
  /** Failures from direct indexing, newest last; they override the scan's. */
  failures: Array<{ path: string; retryable: boolean; failureKind?: string }>;
  /** Paths judged unparseable by two separate parses (pathKey). */
  confirmedUnparseable: Set<string>;
}

/**
 * Measure how the new index covers the old one after `scan`.
 *
 * Contract: this check fails closed.
 *   - An old document leaves the required set only on positive evidence of
 *     one named exclusion: its file is gone (ENOENT/ENOTDIR, under a folder
 *     that lists and still shows files, or, outside any folder, in a parent
 *     directory that still exists); its folder was in the manifest-time
 *     folder list and is absent from the current one, and every current
 *     folder resolved; the current settings do not index its type; or two
 *     separate parses judged the unchanged file unparseable (failureKind
 *     "unparseable", mtime within 1 ms of the old one).
 *   - A document under no registered folder that was not removed with one
 *     (indexed one by one) stays required and is re-indexed directly.
 *   - A required vector is waived only when the settings turn embedding off
 *     (EmbeddingState "off"); "unknown" leaves it undecided.
 *   - Everything else that cannot be shown covered — a folder that does not
 *     list or resolve, a folder that lists no files where old documents were,
 *     a file that cannot be stat'ed, an undecided vector — keeps the old
 *     index, and is counted.
 * Identity is the exact path first. Paths are compared in every form a
 * folder may take (as registered, its real path, NFC); case is folded only
 * under a folder measured case-insensitive, never by platform default.
 */
export async function assessCoverage(
  manifest: LegacyManifest,
  scan: MigrationScan,
  deps: CoverageDeps,
  evidence: CoverageEvidence = { failures: [], confirmedUnparseable: new Set() },
): Promise<Assessment> {
  const { result } = scan;
  const current = await rootsOf(scan.folders, deps);
  const allResolved = current.every((root) => root.resolved);
  const currentKeys = new Set(current.flatMap((root) => root.forms));
  const currentFolded = new Set(
    current.filter((root) => root.caseInsensitive).flatMap((root) => root.forms.map(fold)),
  );
  // A manifest-time folder the user removed: in the old list, and not the same
  // place as any current folder under any of its forms.
  const removed = manifest.folders === null
    ? []
    : (await rootsOf(manifest.folders, deps)).filter(
        (root) => !root.forms.some((form) => currentKeys.has(form) || currentFolded.has(fold(form))),
      );
  const unreadable = (result.unreadableFolders ?? []).map(pathKey);
  const lastFailure = new PathIndex<{ retryable: boolean; failureKind?: string }>();
  for (const failure of [...(result.failures ?? []), ...evidence.failures]) lastFailure.set(failure.path, failure);
  const held = new PathIndex<NewIndexDocument>();
  for (const doc of await deps.listNewDocuments()) {
    if (doc.status === undefined || doc.status === "indexed") held.set(doc.path, doc);
  }
  const embedding = await deps.embeddingState();

  const coverage: IndexCoverage = {
    required: 0,
    covered: 0,
    missingDocuments: 0,
    missingVectors: 0,
    undecidedVectors: 0,
    outside: 0,
    outsideUnreadable: 0,
    tooLarge: [],
    excludedGone: 0,
    excludedRootRemoved: 0,
    excludedUnsupported: 0,
    excludedCorrupt: [],
    unavailableFolders: [],
    vanishedFolders: [],
    missingRetryable: 0,
  };
  const vectorGaps: string[] = [];
  const outsidePending: string[] = [];
  const unparseableOnce: string[] = [];
  const unavailable = new Set<string>();
  const oldByFolder = new Map<string, number>();

  for (const doc of manifest.documents) {
    const key = pathKey(doc.path);
    const found = owner(key, current);
    let asWalked = doc.path;
    let walkedKey = key;
    let foldAllowed = false;
    let folder: string | null = null;
    if (found === null) {
      if (allResolved && owner(key, removed) !== null) {
        coverage.excludedRootRemoved += 1;
        continue;
      }
    } else {
      const { root, form } = found;
      folder = root.folder;
      foldAllowed = root.caseInsensitive;
      oldByFolder.set(root.folder, (oldByFolder.get(root.folder) ?? 0) + 1);
      // The same file as the scan would name it: under the folder as registered.
      const rel = keyInside(key, form) ? relative(form, key) : relative(fold(form), fold(key));
      asWalked = join(resolve(root.folder), rel);
      walkedKey = pathKey(asWalked);
      const under = (dir: string) =>
        keyInside(key, dir) || keyInside(walkedKey, dir)
        || (foldAllowed && (keyInside(fold(key), fold(dir)) || keyInside(fold(walkedKey), fold(dir))));
      if (!root.resolved || unreadable.some(under)) {
        // The folder, or a directory on the way to this file, could not be
        // resolved or listed: the file may be there, unindexed.
        unavailable.add(root.folder);
        continue;
      }
    }
    let mtime: number | "gone" | undefined;
    try {
      mtime = await deps.fileMtime(doc.path);
    } catch {
      mtime = undefined; // exists as far as anyone can tell
    }
    if (folder === null) {
      // Indexed one by one, under no folder. Gone counts only where its
      // directory is still there (an unmounted volume hides both).
      coverage.outside += 1;
      if (!allResolved) {
        // A current folder did not resolve: this may be one of its files
        // under a spelling that cannot be matched until it does.
        coverage.outsideUnreadable += 1;
        continue;
      }
      if (mtime === "gone") {
        let parent: number | "gone" | undefined;
        try {
          parent = await deps.fileMtime(dirname(doc.path));
        } catch {
          parent = undefined;
        }
        if (typeof parent === "number") {
          coverage.outside -= 1;
          coverage.excludedGone += 1;
        } else {
          coverage.outsideUnreadable += 1;
        }
        continue;
      }
      if (mtime === undefined) {
        coverage.outsideUnreadable += 1;
        continue;
      }
      if (!deps.wouldIndex(doc.path, dirname(doc.path))) {
        coverage.outside -= 1;
        coverage.excludedUnsupported += 1;
        continue;
      }
    } else {
      if (mtime === "gone") {
        coverage.excludedGone += 1;
        continue;
      }
      if (!deps.wouldIndex(asWalked, folder)) {
        coverage.excludedUnsupported += 1;
        continue;
      }
    }
    const now = held.get(key, foldAllowed) ?? held.get(walkedKey, foldAllowed);
    if (!now) {
      const failure = lastFailure.get(key, foldAllowed) ?? lastFailure.get(walkedKey, foldAllowed);
      const unchanged = typeof mtime === "number" && sameMtime(mtime, doc.mtimeMs);
      if (failure?.failureKind === "unparseable" && unchanged) {
        if (evidence.confirmedUnparseable.has(key)) {
          if (folder === null) coverage.outside -= 1;
          coverage.excludedCorrupt.push(doc.path);
          continue;
        }
        unparseableOnce.push(doc.path);
      } else if (folder === null && failure === undefined) {
        outsidePending.push(doc.path);
      }
      if (failure?.failureKind === "too_large") coverage.tooLarge.push(doc.path);
      coverage.required += 1;
      coverage.missingDocuments += 1;
      if (failure?.retryable === true) coverage.missingRetryable += 1;
      continue;
    }
    coverage.required += 1;
    if (doc.hadVectors && now.contentState !== "ok" && embedding !== "off") {
      if (embedding === "on") {
        coverage.missingVectors += 1;
        vectorGaps.push(doc.path);
      } else {
        coverage.undecidedVectors += 1;
      }
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
  return { coverage, vectorGaps, outsidePending, unparseableOnce };
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
  if (coverage.outsideUnreadable > 0) {
    parts.push(
      `${coverage.outsideUnreadable} document(s) indexed outside the registered folders could not be read ` +
        "(their file or folder is unavailable)",
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
  if (coverage.tooLarge.length > 0) {
    parts.push(
      `${coverage.tooLarge.length} of them are over the current file size limit ` +
        `(${coverage.tooLarge.slice(0, 3).join(", ")}${coverage.tooLarge.length > 3 ? ", …" : ""}); ` +
        "raise the limit, or remove them from the index folders",
    );
  }
  if (coverage.undecidedVectors > 0) {
    parts.push(
      `whether embedding is available could not be determined, so the vectors of ` +
        `${coverage.undecidedVectors} document(s) cannot be waived`,
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

  let manifest: LegacyManifest;
  try {
    manifest = await deps.loadManifest();
  } catch (err) {
    if (err instanceof MigrationDeferred) {
      status.deferred = err.kind;
      return keep(err.message, false);
    }
    return keep(`the old index could not be read: ${(err as Error).message}`);
  }
  status.legacyDocuments = manifest.documents.length;

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
    const evidence: CoverageEvidence = { failures: [], confirmedUnparseable: new Set() };
    assessed = await assessCoverage(manifest, scan, deps.coverage, evidence);
    // Documents the scan cannot reach (under no registered folder), and a
    // second parse of each file judged unparseable once: index them directly,
    // then measure again. One unparseable verdict may be a read that dropped
    // mid-parse; only two separate ones exclude the file.
    const direct = [...assessed.outsidePending, ...assessed.unparseableOnce];
    if (direct.length > 0) {
      const results = await deps.coverage.indexDirect(direct);
      for (const result of results) {
        if (result.indexed) continue;
        const wasUnparseable = assessed.unparseableOnce.includes(result.path);
        if (wasUnparseable && result.failureKind === "unparseable") {
          evidence.confirmedUnparseable.add(pathKey(result.path));
        }
        evidence.failures.push({
          path: result.path,
          retryable: result.retryable === true,
          ...(result.failureKind !== undefined ? { failureKind: result.failureKind } : {}),
        });
      }
      assessed = await assessCoverage(manifest, scan, deps.coverage, evidence);
    }
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
      assessed = await assessCoverage(manifest, scan, deps.coverage, evidence);
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
