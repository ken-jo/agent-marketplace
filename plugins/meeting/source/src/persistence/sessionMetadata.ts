/**
 * Session metadata projection — used by `meeting_sessions` to produce the
 * lightweight list payload consumed by the sidebar UI's session list view.
 *
 * `durationMs` is derived from the maximum `endSec` across all transcript
 * segments, not from `updatedAt - createdAt`. `updatedAt` is bumped on
 * every transcript ingest and on `pipeline.finalizeSession`. (Intermediate
 * summary writes happen inside the ingest path, so they ride that bump
 * without one of their own. `meeting_stop` patches `finalSummary` onto
 * the persisted record without bumping `updatedAt` — the timestamp already
 * drifts enough during ingest/finalize on its own.) Using it for duration
 * mixes wall-clock processing time into the displayed value and produces
 * inflated meeting lengths (originally reviewed in PR #38 — see the
 * `meeting_sessions` enrichment block in `hostPlugin.ts`).
 *
 * Reading from the transcript instead means the duration only reflects the
 * actual recorded audio span and is invariant under later metadata writes.
 * Using `Math.max` rather than the last array element is intentional:
 * batch-mode STT polling can deliver segments slightly out of order under
 * the 0.5s sliding-window overlap, so the array is not guaranteed to be
 * strictly monotonic in `endSec`.
 */
import type { PersistedSession } from "./sessionStore.js";

export interface SessionMetadata {
  sessionId: string;
  title: string;
  category: string;
  segmentCount: number;
  durationMs: number;
  hasSummary: boolean;
  actionCount: number;
  highlightCount: number;
  relatedCount: number;
  createdAt: string;
  updatedAt: string;
  readOnlyGuide?: boolean;
}

export function normalizeSessionCategory(raw: unknown): string {
  if (typeof raw !== "string") return "일반";
  const category = raw.trim().replace(/\s+/g, " ").slice(0, 40);
  return category || "일반";
}

export function projectSessionMetadata(s: PersistedSession): SessionMetadata {
  const title = s.context?.title || s.finalSummary?.title || s.sessionId;
  const category = normalizeSessionCategory(s.category || s.context?.category);
  const durationMs = s.transcript.reduce((maxMs, seg) => {
    if (!Number.isFinite(seg.endSec) || seg.endSec < 0) return maxMs;
    return Math.max(maxMs, Math.round(seg.endSec * 1000));
  }, 0);
  return {
    sessionId: s.sessionId,
    title,
    category,
    segmentCount: s.transcript.length,
    durationMs,
    hasSummary: Boolean(s.finalSummary),
    actionCount: s.finalSummary?.actionItems?.length ?? 0,
    highlightCount: s.finalSummary?.highlights?.length ?? 0,
    relatedCount: Array.isArray(s.relatedSessionIds) ? s.relatedSessionIds.length : 0,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    readOnlyGuide: s.readOnlyGuide === true,
  };
}
