/**
 * Prep Store — upcoming-meeting persistence
 *
 * Holds calendar-imported MeetingContext records (pre-recording, no
 * transcript yet). Distinct from SessionStore which only carries finalised
 * recordings. Single JSON file (preps.json) under pluginDataDir; the
 * collection is small (dozens of upcoming meetings at most) so we read/write
 * the whole thing rather than splitting per file.
 *
 * Stable ID semantics: if the caller does not supply `id`, one is derived
 * deterministically from scheduledStart + title + organizer so re-importing
 * the same calendar event upserts (idempotent) instead of duplicating.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  lstatSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { MeetingContext } from "../types.js";
import { normalizeSessionCategory } from "./sessionMetadata.js";

const LEGACY_FILE_NAME = "briefings.json";
const MIGRATION_MARKER = ".prep-migration-done";

export interface StoredPrep extends MeetingContext {
  id: string;
}

const FILE_NAME = "preps.json";
/** Refuse to parse a preps file larger than this — guards against a
 *  tampered / runaway file blowing up plugin start. 10MB ≫ any reasonable
 *  upcoming-meeting registry. */
const MAX_PREPS_FILE_BYTES = 10 * 1024 * 1024;
/** Per-store hard cap on stored preps — keeps memory + write times
 *  bounded even if a misbehaving caller floods bulkUpsert. */
const MAX_PREPS = 5000;
const DEFAULT_PREP_DURATION_MS = 60 * 60 * 1000;

// ─── Per-field validation caps ──────────────────────────────────────────
// External callers (calendar plugin, agent-hub, manual import) are not
// trusted to bound their inputs. Without these limits a single oversized
// description field could push the on-disk preps.json past the 10MB
// load cap and the store would silently reset to empty next read.
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_TITLE_LEN = 500;
const MAX_DESCRIPTION_LEN = 16384;
const MAX_AGENDA_ITEMS = 100;
const MAX_AGENDA_ITEM_LEN = 1024;
const MAX_PARTICIPANTS = 500;
const MAX_PREVIOUS_SUMMARY_LEN = 16384;

function truncateString(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.length > max ? value.slice(0, max) : value;
}

function isJoinUrlAllowed(url: unknown): boolean {
  if (typeof url !== "string" || url.length === 0) return false;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function normaliseScheduledDate(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? raw : undefined;
}

function inferPrepEndMs(prep: { scheduledStart?: string; scheduledEnd?: string }): number {
  const start = prep.scheduledStart ? new Date(prep.scheduledStart).getTime() : NaN;
  if (!Number.isFinite(start)) return NaN;
  const explicitEnd = prep.scheduledEnd ? new Date(prep.scheduledEnd).getTime() : NaN;
  if (Number.isFinite(explicitEnd) && explicitEnd >= start) return explicitEnd;
  return start + DEFAULT_PREP_DURATION_MS;
}

/**
 * Per-field schema validation for caller-supplied prep context. Strips
 * unknown / oversized fields rather than throwing where possible — strip
 * is the conservative choice when plugin callers (calendar / agent-hub)
 * forward third-party calendar data we don't fully control. The one
 * exception is `id`, which must match `[A-Za-z0-9_-]{1,128}` because it
 * is later used as a Map key + persisted JSON key; a truly invalid id
 * (only when caller explicitly supplied one) is rejected hard.
 */
export function validatePrep(input: unknown): MeetingContext {
  if (!input || typeof input !== "object") {
    throw new Error("invalid prep (expected object)");
  }
  const b = input as Record<string, unknown>;
  const out: MeetingContext = {};

  // id: explicit caller-supplied id must match the regex. Missing id is
  // fine — bulkUpsert will derive one.
  if (b.id !== undefined && b.id !== null) {
    if (typeof b.id !== "string" || !ID_RE.test(b.id)) {
      throw new Error("invalid prep id (must match [A-Za-z0-9_-]{1,128})");
    }
    out.id = b.id;
  }

  if (b.title !== undefined) out.title = truncateString(b.title, MAX_TITLE_LEN);
  if (b.locale !== undefined && typeof b.locale === "string") out.locale = b.locale;
  if (b.contextHint !== undefined && typeof b.contextHint === "string") {
    out.contextHint = truncateString(b.contextHint, MAX_DESCRIPTION_LEN);
  }
  if (b.description !== undefined) {
    out.description = truncateString(b.description, MAX_DESCRIPTION_LEN);
  }
  if (typeof b.category === "string" && b.category.trim().length > 0) {
    out.category = normalizeSessionCategory(b.category);
  }
  if (b.organizer !== undefined && typeof b.organizer === "string") {
    out.organizer = truncateString(b.organizer, MAX_TITLE_LEN);
  }
  if (b.location !== undefined && typeof b.location === "string") {
    out.location = truncateString(b.location, MAX_TITLE_LEN);
  }

  // Participants: keep string participants only. Cap the array so a runaway
  // payload can't balloon the on-disk record.
  if (Array.isArray(b.participants)) {
    out.participants = (b.participants as unknown[])
      .slice(0, MAX_PARTICIPANTS)
      .filter((p): p is string => typeof p === "string");
  }

  // scheduledStart/End: ISO string OR undefined. NaN-Date strips silently
  // so a malformed calendar payload doesn't poison getNearest().
  const start = normaliseScheduledDate(b.scheduledStart);
  if (start !== undefined) out.scheduledStart = start;
  const end = normaliseScheduledDate(b.scheduledEnd);
  if (end !== undefined) out.scheduledEnd = end;

  if (Array.isArray(b.agenda)) {
    out.agenda = (b.agenda as unknown[])
      .slice(0, MAX_AGENDA_ITEMS)
      .map((item) => truncateString(item, MAX_AGENDA_ITEM_LEN))
      .filter((item) => item.length > 0);
  }

  if (b.previousSummary && typeof b.previousSummary === "object") {
    const ps = b.previousSummary as Record<string, unknown>;
    const summary = truncateString(ps.summary, MAX_PREVIOUS_SUMMARY_LEN);
    out.previousSummary = {
      title: typeof ps.title === "string" ? truncateString(ps.title, MAX_TITLE_LEN) : undefined,
      summary,
    };
  }

  const legacyJoinUrl =
    typeof b.joinUrl === "string" ? b.joinUrl
    : typeof b.webexUrl === "string" ? b.webexUrl
    : typeof b.zoomUrl === "string" ? b.zoomUrl
    : typeof b.teamsUrl === "string" ? b.teamsUrl
    : "";
  if ((b.conference && typeof b.conference === "object") || legacyJoinUrl.length > 0) {
    const c = (b.conference && typeof b.conference === "object")
      ? b.conference as Record<string, unknown>
      : {} as Record<string, unknown>;
    const type = c.type;
    const validType = type === "webex" || type === "zoom" || type === "teams" || type === "other"
      ? type
      : typeof b.webexUrl === "string" && b.webexUrl.length > 0 ? "webex"
      : typeof b.zoomUrl === "string" && b.zoomUrl.length > 0 ? "zoom"
      : typeof b.teamsUrl === "string" && b.teamsUrl.length > 0 ? "teams"
      : "other";
    // Strip joinUrl when it fails the http/https allowlist — keep the
    // rest of the conference object so the UI still shows access codes /
    // host names. Conservative: caller can always re-import with a valid
    // url; throwing would make prep import lose every other field.
    const rawUrl = typeof c.joinUrl === "string" && c.joinUrl.length > 0 ? c.joinUrl : legacyJoinUrl;
    const joinUrl = isJoinUrlAllowed(rawUrl) ? (rawUrl as string) : "";
    out.conference = {
      type: validType,
      joinUrl,
      ...(typeof c.accessCode === "string" ? { accessCode: c.accessCode } : {}),
      ...(typeof c.password === "string" ? { password: c.password } : {}),
      ...(typeof c.hostDisplayName === "string"
        ? { hostDisplayName: truncateString(c.hostDisplayName, MAX_TITLE_LEN) }
        : {}),
    };
  }

  return out;
}

/**
 * One-shot rename of briefings.json → preps.json for users upgrading from
 * v0.4.18. Guarded by a marker file so it runs exactly once even across
 * multiple plugin restarts. Migration failures are logged but never crash
 * plugin init — defer the marker so a later boot can retry when the lock
 * clears (EBUSY / antivirus / read-only fs).
 *
 * Symlink reject: refuses to follow a symlink for the legacy path — data
 * dir attacker could otherwise plant `briefings.json -> /etc/passwd` to
 * silently corrupt preps.json with non-JSON content (DoS).
 */
function migrateLegacyFile(
  storageDir: string,
  logEvent?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void,
): void {
  const markerPath = join(storageDir, MIGRATION_MARKER);
  if (existsSync(markerPath)) return;

  const legacyPath = join(storageDir, LEGACY_FILE_NAME);
  const newPath = join(storageDir, FILE_NAME);

  if (existsSync(legacyPath) && !existsSync(newPath)) {
    try {
      // Symlink reject — lstatSync does not follow the link.
      const stat = lstatSync(legacyPath);
      if (!stat.isFile()) {
        logEvent?.("warn", "meeting_prep_legacy_file_skipped_not_regular", {
          path: LEGACY_FILE_NAME,
        });
        // Marker NOT written — leave the path for explicit user cleanup.
        return;
      }
      renameSync(legacyPath, newPath);
      logEvent?.("info", "meeting_prep_legacy_file_migrated", {
        from: LEGACY_FILE_NAME,
        to: FILE_NAME,
      });
    } catch (err) {
      logEvent?.("warn", "meeting_prep_legacy_file_migration_failed", {
        from: LEGACY_FILE_NAME,
        error: err instanceof Error ? err.message : String(err),
      });
      // Defer marker — let a later boot retry once the lock clears.
      return;
    }
  }

  // Write marker only when nothing was left to migrate (or rename succeeded).
  try {
    writeFileSync(markerPath, "", "utf-8");
  } catch (err) {
    logEvent?.("warn", "meeting_prep_migration_marker_write_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export class PrepStore {
  private readonly path: string;
  private cache: Map<string, StoredPrep> | null = null;

  constructor(
    storageDir: string,
    logEvent?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void,
  ) {
    mkdirSync(storageDir, { recursive: true });
    this.path = join(storageDir, FILE_NAME);
    migrateLegacyFile(storageDir, logEvent);
  }

  /**
   * Bulk insert/replace. Returns the resolved IDs of records that were
   * actually persisted, in input order. The current input batch is
   * protected from MAX_PREPS eviction so callers can trust that
   * returned IDs map to retained records — but if the batch itself
   * exceeds MAX_PREPS, the oldest within-batch entries lose and
   * are omitted from the result.
   */
  bulkUpsert(preps: MeetingContext[]): string[] {
    const map = this.readMap();
    const ids: string[] = [];
    const batchIds = new Set<string>();
    for (const raw of preps) {
      // Validate at the entry point — every persisted record passes
      // through here so invalidating once means all reads (list,
      // get, getNearest) see clean data.
      const b = validatePrep(raw);
      const id = b.id ?? deriveId(b);
      const stored: StoredPrep = { ...b, id };
      map.set(id, stored);
      ids.push(id);
      batchIds.add(id);
    }
    this.writeMap(map, batchIds);
    // After eviction, batchIds entries are guaranteed retained unless
    // the batch alone overflows MAX_PREPS; filter so the caller
    // never receives an ID that isn't actually persisted.
    const retained = this.cache!;
    return ids.filter((id) => retained.has(id));
  }

  upsert(prep: MeetingContext): string {
    return this.bulkUpsert([prep])[0]!;
  }

  get(id: string): StoredPrep | null {
    return this.readMap().get(id) ?? null;
  }

  list(): StoredPrep[] {
    return Array.from(this.readMap().values());
  }

  /**
   * Returns the prep whose scheduledStart is closest to `now` — preferring
   * upcoming/in-progress meetings over past ones. Used by the UI to pick a
   * default prep for the pre-meeting view when no explicit id is selected.
   * Returns null when the store is empty.
   */
  getNearest(now: Date = new Date()): StoredPrep | null {
    const all = this.list();
    if (all.length === 0) return null;
    const t = now.getTime();
    // Score: upcoming/in-progress = positive, past = negative. Pick min |delta|
    // but among ties prefer upcoming.
    let best: StoredPrep | null = null;
    let bestScore = Infinity;
    for (const b of all) {
      const start = b.scheduledStart ? new Date(b.scheduledStart).getTime() : NaN;
      if (!Number.isFinite(start)) continue;
      const end = inferPrepEndMs(b);
      // 진행 중이면 즉시 채택 (가장 우선)
      if (t >= start && t <= end) return b;
      const delta = start - t;
      // 미래는 양수, 과거는 음수. 미래에 가산점을 줘서 동일 거리면 미래를 우선.
      const score = delta >= 0 ? delta : -delta * 1.5;
      if (score < bestScore) { bestScore = score; best = b; }
    }
    return best;
  }

  delete(id: string): boolean {
    const map = this.readMap();
    const existed = map.delete(id);
    if (existed) this.writeMap(map);
    return existed;
  }

  clear(): void {
    this.cache = new Map();
    this.writeMap(this.cache);
  }

  // ─── Private ────────────────────────────────────

  private readMap(): Map<string, StoredPrep> {
    if (this.cache) return this.cache;
    if (!existsSync(this.path)) {
      this.cache = new Map();
      return this.cache;
    }
    try {
      // Size guard — refuse to load a runaway / tampered file.
      const size = statSync(this.path).size;
      if (size > MAX_PREPS_FILE_BYTES) {
        // Don't auto-truncate (would silently destroy data); just refuse.
        this.cache = new Map();
        return this.cache;
      }
      // v0.4.20 (PR #122 follow-up hotfix): accept both `preps` (current) and
      // `briefings` (legacy v0.4.18 payload key) so users upgrading from
      // 0.4.18 don't silently lose data. The v0.4.19 file-rename migration
      // moved briefings.json → preps.json without transforming the payload
      // key — readMap stayed `parsed.preps`-only, so all upcoming meeting
      // entries dropped. Next write naturally rewrites with `preps` key.
      //
      // Deprecation: keep the `briefings` fallback at least through v0.5.x.
      // v0.4.21 will add logEvent at fallback-hit to measure upgrade tail;
      // v0.5.x may force a one-shot normalize at boot; v0.6.x removes the
      // fallback. See follow-up PR notes.
      //
      // Array.isArray guards reject hostile JSON like `{ preps: 42 }` whose
      // `??` chain would otherwise feed a non-iterable to `for...of` and
      // throw — outer catch would then silently wipe the cache.
      const raw = JSON.parse(readFileSync(this.path, "utf-8")) as unknown;
      const root = (raw && typeof raw === "object" ? raw : {}) as {
        preps?: unknown;
        briefings?: unknown;
      };
      const entries: unknown[] = Array.isArray(root.preps)
        ? root.preps
        : Array.isArray(root.briefings)
        ? root.briefings
        : [];
      const valid: StoredPrep[] = [];
      for (const candidate of entries) {
        if (!candidate || typeof candidate !== "object") continue;
        const id = (candidate as { id?: unknown }).id;
        if (typeof id !== "string" || !ID_RE.test(id)) continue;
        try {
          const normalized = validatePrep(candidate);
          if (typeof normalized.id === "string" && ID_RE.test(normalized.id)) {
            valid.push(normalized as StoredPrep);
          }
        } catch {
          // Skip one bad disk entry without discarding the rest of the store.
        }
      }
      // Trim to MAX_PREPS in case a previous version wrote more.
      const trimmed = valid.slice(0, MAX_PREPS);
      this.cache = new Map(trimmed.map((b) => [b.id, b]));
    } catch {
      // Corrupt file — start clean rather than throw at module init.
      this.cache = new Map();
    }
    return this.cache;
  }

  /**
   * `protectedIds` (optional): caller-provided set whose entries should
   *  not be evicted by the MAX_PREPS cap unless the protected set
   *  alone overflows the cap. Used by bulkUpsert to keep the just-written
   *  batch consistent with the IDs it returns.
   */
  private writeMap(
    map: Map<string, StoredPrep>,
    protectedIds?: ReadonlySet<string>,
  ): void {
    this.cache = map;
    let all = Array.from(map.values());
    // Hard cap on store size. If we exceed, drop the OLDEST entries
    // (smallest scheduledStart) since those are least likely to matter.
    if (all.length > MAX_PREPS) {
      const byNewest = (a: StoredPrep, b: StoredPrep) => {
        const ta = a?.scheduledStart ? new Date(a.scheduledStart).getTime() : 0;
        const tb = b?.scheduledStart ? new Date(b.scheduledStart).getTime() : 0;
        return tb - ta; // newest first
      };
      if (protectedIds && protectedIds.size > 0) {
        const inBatch = all.filter((b) => protectedIds.has(b.id));
        if (inBatch.length >= MAX_PREPS) {
          // Batch alone overflows — evict oldest within the batch.
          all = inBatch.sort(byNewest).slice(0, MAX_PREPS);
        } else {
          // Keep all batch entries, fill the rest with newest non-batch.
          const outOfBatch = all.filter((b) => !protectedIds.has(b.id));
          const remaining = MAX_PREPS - inBatch.length;
          all = [...inBatch, ...outOfBatch.sort(byNewest).slice(0, remaining)];
        }
      } else {
        all.sort(byNewest);
        all.length = MAX_PREPS;
      }
      // Rebuild cache too so listing matches what's persisted.
      this.cache = new Map(all.map((b) => [b.id, b]));
    }
    const payload = { preps: all };
    // Atomic write: serialise to a tmp sibling then rename. Renames on the
    // same filesystem are atomic on POSIX + Windows NTFS, so a crash mid-
    // write leaves the previous good file in place rather than producing
    // a truncated JSON that readMap would silently reset to empty.
    const tmpPath = this.path + ".tmp";
    try {
      writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf-8");
      renameSync(tmpPath, this.path);
    } catch (err) {
      try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* noop */ }
      throw err;
    }
  }
}

/**
 * Deterministic ID derivation when caller didn't supply one. Hash of
 * scheduledStart + title + organizer keeps re-imports idempotent without
 * needing the caller to track UUIDs across runs.
 */
function deriveId(b: MeetingContext): string {
  const seed = [
    b.scheduledStart ?? "",
    b.title ?? "",
    b.organizer ?? "",
  ].join("|");
  return "pr_" + createHash("sha1").update(seed).digest("hex").slice(0, 16);
}
