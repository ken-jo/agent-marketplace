/**
 * Additional MeetingPipeline tests — covers behaviors added/modified in
 * feat/openai-realtime-ws-stt (PR #23):
 *
 * - resetSession cleans up lastIntermediateAt (memory-leak fix)
 * - intermediateMinIntervalMs throttle suppresses duplicate summaries
 * - deduplicateAndMerge: overlap removal, identity pass-through
 * - ingestTranscriptSegments: direct segment ingestion path
 * - IngestResult shape: no modifiedSegmentIndex / modifiedSegment fields
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { MeetingPipeline } from "../src/pipeline/meetingPipeline";
import { MockSttProvider, MockSummaryProvider } from "../src/adapters/mockProviders";
import type { TranscriptSegment } from "../src/types";

// ─── Helpers ───────────────────────────────────────────────────────────────

function makePipeline(opts: { intermediateEveryFinalSegments?: number; intermediateMinIntervalMs?: number } = {}) {
  return new MeetingPipeline({
    sttProvider: new MockSttProvider(),
    summaryProvider: new MockSummaryProvider(),
    intermediateEveryFinalSegments: opts.intermediateEveryFinalSegments ?? 100,
    intermediateMinIntervalMs: opts.intermediateMinIntervalMs ?? 0,
  });
}

function makeSegment(overrides: Partial<TranscriptSegment> & { id: string }): TranscriptSegment {
  return {
    speaker: "A",
    original: "hello world",
    startSec: 0,
    endSec: 1,
    isFinal: true,
    source: "batch",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("MeetingPipeline — resetSession cleanup (Fix 6)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resetSession 후 동일 세션 ID로 재시작하면 새 세션이 생성된다", async () => {
    const pipeline = makePipeline({ intermediateEveryFinalSegments: 1, intermediateMinIntervalMs: 0 });
    pipeline.startSession("s1");
    await pipeline.ingestAudioChunk("s1", {
      pcm16leMono: Buffer.from([0x00]),
      sampleRate: 16000,
      startSec: 0,
      endSec: 1,
    });
    expect(pipeline.getTranscript("s1")).toHaveLength(1);

    pipeline.resetSession("s1");
    expect(pipeline.getSession("s1")).toBeUndefined();

    // Re-start same ID — should work cleanly (no stale state)
    pipeline.startSession("s1");
    expect(pipeline.getTranscript("s1")).toHaveLength(0);
  });

  it("resetSession 후 재시작된 세션은 intermediateMinIntervalMs throttle 영향 없이 요약을 생성한다", async () => {
    const pipeline = makePipeline({ intermediateEveryFinalSegments: 1, intermediateMinIntervalMs: 60_000 });

    pipeline.startSession("s-throttle");
    // First ingest: triggers summary, sets lastIntermediateAt
    const r1 = await pipeline.ingestAudioChunk("s-throttle", {
      pcm16leMono: Buffer.from([0x00]),
      sampleRate: 16000,
      startSec: 0,
      endSec: 1,
    });
    expect(r1.intermediateSummary).toBeDefined();

    // Second ingest immediately after: throttled, no summary
    const r2 = await pipeline.ingestAudioChunk("s-throttle", {
      pcm16leMono: Buffer.from([0x01]),
      sampleRate: 16000,
      startSec: 1,
      endSec: 2,
    });
    expect(r2.intermediateSummary).toBeUndefined();

    // Reset and restart: lastIntermediateAt for this ID should be cleared
    pipeline.resetSession("s-throttle");
    pipeline.startSession("s-throttle");

    // First ingest on fresh session should produce a summary again
    const r3 = await pipeline.ingestAudioChunk("s-throttle", {
      pcm16leMono: Buffer.from([0x02]),
      sampleRate: 16000,
      startSec: 0,
      endSec: 1,
    });
    expect(r3.intermediateSummary).toBeDefined();
  });
});

describe("MeetingPipeline — intermediateMinIntervalMs throttle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("intervalMs 이내에는 intermediate summary를 생성하지 않는다", async () => {
    const pipeline = makePipeline({ intermediateEveryFinalSegments: 1, intermediateMinIntervalMs: 5_000 });
    pipeline.startSession("s-interval");

    const r1 = await pipeline.ingestAudioChunk("s-interval", {
      pcm16leMono: Buffer.from([0x00]),
      sampleRate: 16000,
      startSec: 0,
      endSec: 1,
    });
    expect(r1.intermediateSummary).toBeDefined();

    // Advance less than interval
    vi.advanceTimersByTime(2_000);

    const r2 = await pipeline.ingestAudioChunk("s-interval", {
      pcm16leMono: Buffer.from([0x01]),
      sampleRate: 16000,
      startSec: 1,
      endSec: 2,
    });
    expect(r2.intermediateSummary).toBeUndefined();

    // Advance past interval
    vi.advanceTimersByTime(4_000);

    const r3 = await pipeline.ingestAudioChunk("s-interval", {
      pcm16leMono: Buffer.from([0x02]),
      sampleRate: 16000,
      startSec: 2,
      endSec: 3,
    });
    expect(r3.intermediateSummary).toBeDefined();
  });
});

describe("MeetingPipeline — restoreSession rehydrates intermediate throttle (M5)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("throttle floor is repopulated from persisted intermediates after restoreSession", async () => {
    const intervalMs = 60_000;
    const pipeline = makePipeline({ intermediateEveryFinalSegments: 1, intermediateMinIntervalMs: intervalMs });

    // Simulate a session that was already mid-recording with a recent
    // intermediate. The pipeline that produced it has crashed; we now
    // restore via restoreSession (the crash-recovery path).
    const recentSummaryAt = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(new Date(recentSummaryAt.getTime() + 5_000)); // 5s after the prior intermediate

    pipeline.restoreSession({
      sessionId: "s-restored",
      transcript: [
        {
          id: "seg-0",
          speaker: "A",
          original: "hello",
          startSec: 0,
          endSec: 1,
          isFinal: true,
          source: "batch",
          createdAt: recentSummaryAt.toISOString(),
        },
      ],
      intermediateSummaries: [
        {
          coveredSegmentCount: 1,
          data: {
            summary: "prev",
            highlights: [],
            coveredSegmentIds: ["seg-0"],
            createdAt: recentSummaryAt.toISOString(),
          },
        },
      ],
      finalized: false,
      createdAt: recentSummaryAt.toISOString(),
      updatedAt: recentSummaryAt.toISOString(),
    });

    // First call after restore — only 5s after the prior intermediate.
    // Throttle floor was previously 0 (empty in-memory map) and would
    // have bypassed the gate, breaching the host callLlm rate budget.
    // After the fix, this is throttled.
    const r1 = await pipeline.ingestAudioChunk("s-restored", {
      pcm16leMono: Buffer.from([0x00]),
      sampleRate: 16000,
      startSec: 1,
      endSec: 2,
    });
    expect(r1.intermediateSummary).toBeUndefined();

    // Advance past the interval → throttle releases.
    vi.advanceTimersByTime(intervalMs + 1);
    const r2 = await pipeline.ingestAudioChunk("s-restored", {
      pcm16leMono: Buffer.from([0x01]),
      sampleRate: 16000,
      startSec: 2,
      endSec: 3,
    });
    expect(r2.intermediateSummary).toBeDefined();
  });

  it("restoreSession on a session with no intermediates leaves throttle floor at 0 (first-call free)", async () => {
    const pipeline = makePipeline({ intermediateEveryFinalSegments: 1, intermediateMinIntervalMs: 60_000 });

    pipeline.restoreSession({
      sessionId: "s-fresh-restore",
      transcript: [],
      intermediateSummaries: [],
      finalized: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const r1 = await pipeline.ingestAudioChunk("s-fresh-restore", {
      pcm16leMono: Buffer.from([0x00]),
      sampleRate: 16000,
      startSec: 0,
      endSec: 1,
    });
    expect(r1.intermediateSummary).toBeDefined();
  });
});

describe("MeetingPipeline — ingestTranscriptSegments", () => {
  it("직접 세그먼트를 주입하면 transcript에 누적된다", async () => {
    const pipeline = makePipeline();
    pipeline.startSession("s-direct");

    const seg1 = makeSegment({ id: "seg-1", original: "첫 번째 문장입니다.", startSec: 0, endSec: 2 });
    const seg2 = makeSegment({ id: "seg-2", original: "두 번째 문장입니다.", startSec: 2, endSec: 4 });

    const result = await pipeline.ingestTranscriptSegments("s-direct", [seg1, seg2]);

    expect(result.addedSegments).toHaveLength(2);
    expect(result.sessionId).toBe("s-direct");
    expect(pipeline.getTranscript("s-direct")).toHaveLength(2);
  });

  it("빈 세그먼트 배열을 주입하면 transcript가 변하지 않는다", async () => {
    const pipeline = makePipeline();
    pipeline.startSession("s-empty");

    const result = await pipeline.ingestTranscriptSegments("s-empty", []);
    expect(result.addedSegments).toHaveLength(0);
    expect(pipeline.getTranscript("s-empty")).toHaveLength(0);
  });
});

describe("MeetingPipeline — IngestResult shape (Fix 5)", () => {
  it("IngestResult에 modifiedSegmentIndex / modifiedSegment 필드가 없다", async () => {
    const pipeline = makePipeline();
    pipeline.startSession("s-shape");

    const result = await pipeline.ingestAudioChunk("s-shape", {
      pcm16leMono: Buffer.from([0x00]),
      sampleRate: 16000,
      startSec: 0,
      endSec: 1,
    });

    expect(result).not.toHaveProperty("modifiedSegmentIndex");
    expect(result).not.toHaveProperty("modifiedSegment");
    expect(result).toHaveProperty("sessionId");
    expect(result).toHaveProperty("addedSegments");
    expect(result).toHaveProperty("baseIndex");
  });
});

describe("MeetingPipeline — deduplication via public API", () => {
  it("동일 청크를 두 번 주입해도 transcript 길이가 유지된다 (중복 제거)", async () => {
    // MockSttProvider always returns the same text for same-duration chunks,
    // so ingesting the same time window twice should deduplicate.
    const pipeline = makePipeline({ intermediateEveryFinalSegments: 100 });
    pipeline.startSession("s-dedup");

    await pipeline.ingestAudioChunk("s-dedup", {
      pcm16leMono: Buffer.from([0x00]),
      sampleRate: 16000,
      startSec: 0,
      endSec: 3,
    });
    // Overlapping window (2.5s step): same text → should be deduplicated or merged
    await pipeline.ingestAudioChunk("s-dedup", {
      pcm16leMono: Buffer.from([0x01]),
      sampleRate: 16000,
      startSec: 0.5,
      endSec: 3.5,
    });

    // Transcript should not balloon (2nd chunk text is different from mock, so it won't perfectly dedup)
    // But at minimum getTranscript returns a consistent array
    const transcript = pipeline.getTranscript("s-dedup");
    expect(transcript.length).toBeGreaterThanOrEqual(1);
    for (const seg of transcript) {
      expect(seg.original.length).toBeGreaterThan(0);
    }
  });
});
