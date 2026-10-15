/**
 * Session Store — 세션 상태 디스크 영속화
 *
 * JSON 파일 기반 (Ave Memory 패턴과 일관).
 * 크래시 복구: 앱 재시작 시 미완료 세션 복원 가능.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { TranscriptSegment, MeetingContext, IntermediateSummary, FinalSummary } from "../types.js";

export interface PersistedSession {
  sessionId: string;
  readOnlyGuide?: boolean;
  context?: MeetingContext;
  transcript: TranscriptSegment[];
  intermediateSummaries: Array<{ coveredSegmentCount: number; data: IntermediateSummary }>;
  finalized: boolean;
  /** Set once meeting_stop produces the final summary. Optional for backward
   * compatibility with sessions persisted before this field existed. */
  finalSummary?: FinalSummary;
  /** Other completed meeting sessions that should be shown as related. */
  relatedSessionIds?: string[];
  /** User-facing category shown in completed meeting lists. */
  category?: string;
  createdAt: string;
  updatedAt: string;
}

export class SessionStore {
  private readonly dir: string;

  constructor(storageDir: string) {
    this.dir = storageDir;
    mkdirSync(this.dir, { recursive: true });
  }

  save(session: PersistedSession): void {
    const path = join(this.dir, `${session.sessionId}.json`);
    // Compact JSON intentionally — `save` is on the hot path
    // (called from MeetingPipeline.persistSession every chunk +
    // every intermediate summary + every finalize). The pretty-print
    // form roughly doubles the UTF-16 string + writeFileSync Buffer
    // for no observable benefit since readers go through JSON.parse.
    // On a 4 h meeting that's ~5 MB → ~2.5 MB per write and ~2.4 GB
    // → ~1.2 GB of cumulative allocation churn through the run.
    //
    // Atomic write: serialise to a tmp sibling then rename. Renames on the
    // same filesystem are atomic on POSIX + Windows NTFS, so a crash/power
    // loss mid-write leaves the previous good session file in place rather
    // than producing a truncated JSON that load()/listUnfinished() would
    // silently drop — that drop is total loss of a multi-hour transcript +
    // summary. On any serialise/write/rename error the tmp file is unlinked
    // and the error rethrown so the failure surfaces instead of corrupting
    // the live file.
    const tmpPath = `${path}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify(session), "utf-8");
      renameSync(tmpPath, path);
    } catch (err) {
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch {
        /* best-effort cleanup — surface the original error below */
      }
      throw err;
    }
  }

  load(sessionId: string): PersistedSession | null {
    const path = join(this.dir, `${sessionId}.json`);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as PersistedSession;
    } catch {
      return null;
    }
  }

  /** 미완료(finalized=false) 세션 목록 — 크래시 복구용. updatedAt 내림차순 정렬. */
  listUnfinished(): PersistedSession[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const data = JSON.parse(readFileSync(join(this.dir, f), "utf-8")) as PersistedSession;
          return data.finalized ? null : data;
        } catch { return null; }
      })
      .filter((s): s is PersistedSession => s !== null)
      // Recency order so the consumer's `.slice(0, N)` cap picks the
      // most-likely-to-be-resumable orphans. Mirrors listFinished's
      // sort. localeCompare is correct for ISO timestamps (sortable
      // as strings) and avoids a Date.parse per entry.
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** 완료된 세션 목록 (최근 순) */
  listFinished(limit = 20): PersistedSession[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(this.dir, f), "utf-8")) as PersistedSession;
        } catch { return null; }
      })
      .filter((s): s is PersistedSession => s !== null && s.finalized)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  delete(sessionId: string): void {
    const path = join(this.dir, `${sessionId}.json`);
    if (existsSync(path)) unlinkSync(path);
  }
}
