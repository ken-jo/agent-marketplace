/**
 * Unit tests for projectSessionMetadata + SessionStore.finalSummary
 * round-trip — locks the response shape returned by `meeting_sessions`
 * and the persistence contract used by `meeting_session_detail`.
 *
 * Addresses PR #38 Copilot review feedback (L371, L389):
 *  - duration must come from transcript.endSec, not updatedAt
 *  - new payload fields + meeting_session_detail need explicit coverage
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeSessionCategory, projectSessionMetadata } from "../src/persistence/sessionMetadata.js";
import { SessionStore, type PersistedSession } from "../src/persistence/sessionStore.js";
import type { TranscriptSegment, FinalSummary } from "../src/types.js";

function seg(partial: Partial<TranscriptSegment>): TranscriptSegment {
  return {
    id: partial.id ?? "seg-1",
    speaker: partial.speaker ?? "Alice",
    original: partial.original ?? "hello",
    startSec: partial.startSec ?? 0,
    endSec: partial.endSec ?? 1,
    isFinal: partial.isFinal ?? true,
    source: partial.source ?? "batch",
    createdAt: partial.createdAt ?? new Date().toISOString(),
  };
}

function makeFinalSummary(overrides: Partial<FinalSummary> = {}): FinalSummary {
  return {
    title: "Q2 OKR 리뷰",
    summary: "review summary text",
    highlights: ["h1", "h2", "h3"],
    actionItems: ["a1", "a2"],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makePersisted(overrides: Partial<PersistedSession> = {}): PersistedSession {
  const base: PersistedSession = {
    sessionId: "sess-1",
    transcript: [],
    intermediateSummaries: [],
    finalized: true,
    createdAt: "2026-04-29T14:00:00.000Z",
    updatedAt: "2026-04-29T15:00:00.000Z",
  };
  return { ...base, ...overrides };
}

describe("projectSessionMetadata", () => {
  it("derives durationMs from the maximum transcript endSec, not updatedAt", () => {
    // updatedAt - createdAt would suggest 1 hour (3,600,000 ms) but the
    // recorded audio span is only 25 minutes per the transcript.
    const persisted = makePersisted({
      createdAt: "2026-04-29T14:00:00.000Z",
      updatedAt: "2026-04-29T15:00:00.000Z", // 1h after createdAt
      transcript: [
        seg({ id: "s0", startSec: 0, endSec: 10 }),
        seg({ id: "s1", startSec: 10, endSec: 1500 }), // 25min
      ],
    });
    const meta = projectSessionMetadata(persisted);
    expect(meta.durationMs).toBe(1500 * 1000);
  });

  it("returns durationMs=0 for an empty transcript", () => {
    const meta = projectSessionMetadata(makePersisted({ transcript: [] }));
    expect(meta.durationMs).toBe(0);
  });

  it("ignores non-finite or negative endSec values when computing durationMs", () => {
    const persisted = makePersisted({
      transcript: [
        seg({ id: "s0", endSec: 5 }),
        seg({ id: "s1", endSec: Number.NaN as unknown as number }),
        seg({ id: "s2", endSec: -3 }),
        seg({ id: "s3", endSec: 7 }),
      ],
    });
    expect(projectSessionMetadata(persisted).durationMs).toBe(7000);
  });

  it("uses context.title when present, falling back to finalSummary.title then sessionId", () => {
    const withContextTitle = makePersisted({
      context: { title: "ctx-title" },
      finalSummary: makeFinalSummary({ title: "fs-title" }),
    });
    expect(projectSessionMetadata(withContextTitle).title).toBe("ctx-title");

    const onlyFinalSummary = makePersisted({
      finalSummary: makeFinalSummary({ title: "fs-title" }),
    });
    expect(projectSessionMetadata(onlyFinalSummary).title).toBe("fs-title");

    const neither = makePersisted({ sessionId: "fallback-id" });
    expect(projectSessionMetadata(neither).title).toBe("fallback-id");
  });

  it("reports hasSummary=true with action and highlight counts when finalSummary is present", () => {
    const persisted = makePersisted({
      finalSummary: makeFinalSummary({
        highlights: ["a", "b", "c", "d"],
        actionItems: ["x", "y"],
      }),
    });
    const meta = projectSessionMetadata(persisted);
    expect(meta.hasSummary).toBe(true);
    expect(meta.actionCount).toBe(2);
    expect(meta.highlightCount).toBe(4);
  });

  it("reports hasSummary=false and zero counts when finalSummary is absent (legacy session)", () => {
    const meta = projectSessionMetadata(makePersisted({ finalSummary: undefined }));
    expect(meta.hasSummary).toBe(false);
    expect(meta.actionCount).toBe(0);
    expect(meta.highlightCount).toBe(0);
  });

  it("preserves the readOnlyGuide marker for bundled guide sessions", () => {
    const meta = projectSessionMetadata(makePersisted({ readOnlyGuide: true }));
    expect(meta.readOnlyGuide).toBe(true);
  });

  it("projects category with 일반 as the default", () => {
    expect(projectSessionMetadata(makePersisted()).category).toBe("일반");
    expect(projectSessionMetadata(makePersisted({ category: "  프로젝트   킥오프  " })).category).toBe("프로젝트 킥오프");
  });

  it("uses context.category for list metadata when top-level category is absent", () => {
    const meta = projectSessionMetadata(makePersisted({
      context: { title: "ctx-title", category: "  전사   액션  " },
    }));
    expect(meta.category).toBe("전사 액션");
  });

  it("reports relatedCount from linked meeting ids", () => {
    const meta = projectSessionMetadata(makePersisted({
      relatedSessionIds: ["sess-2", "sess-3"],
    }));
    expect(meta.relatedCount).toBe(2);
  });

  it("treats malformed legacy finalSummary arrays as zero counts", () => {
    const meta = projectSessionMetadata(makePersisted({
      finalSummary: { title: "legacy" } as PersistedSession["finalSummary"],
    }));
    expect(meta.hasSummary).toBe(true);
    expect(meta.actionCount).toBe(0);
    expect(meta.highlightCount).toBe(0);
  });
});

describe("normalizeSessionCategory", () => {
  it("trims, collapses whitespace, and falls back to 일반", () => {
    expect(normalizeSessionCategory("  고객   미팅  ")).toBe("고객 미팅");
    expect(normalizeSessionCategory("")).toBe("일반");
    expect(normalizeSessionCategory(null)).toBe("일반");
  });
});

describe("SessionStore.finalSummary round-trip (meeting_session_detail contract)", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ave-meeting-test-"));
    store = new SessionStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists and reloads the finalSummary block intact", () => {
    const persisted = makePersisted({
      finalSummary: makeFinalSummary({
        title: "Round-trip test",
        summary: "body",
        highlights: ["h"],
        actionItems: ["a"],
      }),
    });
    store.save(persisted);

    const loaded = store.load(persisted.sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded?.finalSummary).toEqual(persisted.finalSummary);
  });

  it("loads a record that pre-dates the finalSummary field (BC)", () => {
    // Simulate a legacy persisted record without finalSummary by saving
    // an object that simply omits the field.
    const legacy = makePersisted();
    delete (legacy as Partial<PersistedSession>).finalSummary;
    store.save(legacy);

    const loaded = store.load(legacy.sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded?.finalSummary).toBeUndefined();
  });

  it("returns null for a sessionId not in the store (meeting_session_detail null path)", () => {
    expect(store.load("does-not-exist")).toBeNull();
  });
});
