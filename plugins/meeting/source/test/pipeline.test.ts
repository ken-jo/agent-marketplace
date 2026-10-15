import { describe, expect, it, vi } from "vitest";
import { MeetingPipeline } from "../src/pipeline/meetingPipeline";
import { MockSttProvider, MockSummaryProvider } from "../src/adapters/mockProviders";
import type { AudioChunkInput, AudioFileInput, TranscriptSegment } from "../src/types";
import type { SttProvider, SummaryInput, SummaryProvider, SummarizeFinalOptions } from "../src/providers";

describe("MeetingPipeline", () => {
  it("shares pending STT resolution and never caches a provider returned after abort", async () => {
    let finishFirst!: (provider: SttProvider) => void;
    const factory = vi.fn(() => factory.mock.calls.length === 1
      ? new Promise<SttProvider>((resolve) => { finishFirst = resolve; })
      : new MockSttProvider());
    const pipeline = new MeetingPipeline({
      sttProviderFactory: factory,
      summaryProvider: new MockSummaryProvider(),
      intermediateEveryFinalSegments: 99,
    });
    pipeline.startSession("single-flight");
    const chunk = { pcm16leMono: Buffer.from([0]), sampleRate: 16000, startSec: 0, endSec: 1 };
    const first = pipeline.ingestAudioChunk("single-flight", chunk);
    const second = pipeline.ingestAudioChunk("single-flight", chunk);
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    let closed = false;
    const closing = pipeline.abortSessionAndWait("single-flight").then(() => { closed = true; });
    expect(closed).toBe(false);
    finishFirst(new MockSttProvider());
    await expect(first).rejects.toThrow("Meeting STT session aborted");
    await expect(second).rejects.toThrow("Meeting STT session aborted");
    await closing;
    expect(closed).toBe(true);
    await pipeline.ingestAudioChunk("single-flight", chunk);
    expect(factory).toHaveBeenCalledTimes(2);
  });
  it("final segment threshold를 만족하면 중간 요약을 생성한다", async () => {
    const pipeline = new MeetingPipeline({
      sttProvider: new MockSttProvider(),
      summaryProvider: new MockSummaryProvider(),
      intermediateEveryFinalSegments: 2,
    });

    pipeline.startSession("s1");
    const r1 = await pipeline.ingestAudioChunk("s1", {
      pcm16leMono: Buffer.from([0x00]),
      sampleRate: 16000,
      startSec: 0,
      endSec: 1.5,
    });
    const r2 = await pipeline.ingestAudioChunk("s1", {
      pcm16leMono: Buffer.from([0x01]),
      sampleRate: 16000,
      startSec: 1.5,
      endSec: 3.0,
    });

    expect(r1.intermediateSummary).toBeUndefined();
    expect(r2.intermediateSummary?.summary).toContain("중간 요약");
    expect(pipeline.getTranscript("s1")).toHaveLength(2);
  });

  it("intermediate summary에도 session abort signal을 전달한다", async () => {
    let seenSignal: AbortSignal | undefined;
    const summaryProvider: SummaryProvider = {
      summarizeIntermediate: async (_input, opts) => {
        seenSignal = opts?.signal;
        return {
          summary: "중간 요약",
          highlights: [],
          coveredSegmentIds: [],
          createdAt: new Date().toISOString(),
        };
      },
      summarizeFinal: async () => ({
        title: "회의 요약",
        summary: "요약",
        highlights: [],
        actionItems: [],
        createdAt: new Date().toISOString(),
      }),
    };
    const pipeline = new MeetingPipeline({
      sttProvider: new MockSttProvider(),
      summaryProvider,
      intermediateEveryFinalSegments: 1,
    });

    pipeline.startSession("s-intermediate-signal");
    await pipeline.ingestAudioChunk("s-intermediate-signal", {
      pcm16leMono: Buffer.from([0x00]),
      sampleRate: 16000,
      startSec: 0,
      endSec: 1.5,
    });

    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it("청크 ingest 성공 시 onTranscriptUpdate 콜백이 누적 transcript 와 함께 호출된다", async () => {
    const updates: Array<{ sessionId: string; count: number }> = [];
    const pipeline = new MeetingPipeline({
      sttProvider: new MockSttProvider(),
      summaryProvider: new MockSummaryProvider(),
      intermediateEveryFinalSegments: 10,
      onTranscriptUpdate: (sessionId, transcript) => {
        updates.push({ sessionId, count: transcript.length });
      },
    });

    pipeline.startSession("s-live");
    await pipeline.ingestAudioChunk("s-live", {
      pcm16leMono: Buffer.from([0x00]),
      sampleRate: 16000,
      startSec: 0,
      endSec: 1.5,
    });
    await pipeline.ingestAudioChunk("s-live", {
      pcm16leMono: Buffer.from([0x01]),
      sampleRate: 16000,
      startSec: 1.5,
      endSec: 3.0,
    });

    expect(updates).toHaveLength(2);
    expect(updates[0]?.sessionId).toBe("s-live");
    expect(updates[0]?.count).toBe(1);
    expect(updates[1]?.count).toBe(2);
  });

  it("finalize 시 최종 요약을 반환한다", async () => {
    const pipeline = new MeetingPipeline({
      sttProvider: new MockSttProvider(),
      summaryProvider: new MockSummaryProvider(),
      intermediateEveryFinalSegments: 1,
    });
    pipeline.startSession("s2");
    await pipeline.ingestAudioChunk("s2", {
      pcm16leMono: Buffer.from([0x00]),
      sampleRate: 16000,
      startSec: 0,
      endSec: 2.0,
    });

    const finalSummary = await pipeline.finalizeSession("s2");
    expect(finalSummary.title).toBe("회의 요약");
    expect(finalSummary.summary.length).toBeGreaterThan(0);
  });

  it("finalize signal을 SummaryProvider에 전달한다", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const summaryProvider: SummaryProvider = {
      summarizeIntermediate: async () => ({
        summary: "중간 요약",
        highlights: [],
        coveredSegmentIds: [],
        createdAt: new Date().toISOString(),
      }),
      summarizeFinal: async (_input: SummaryInput, opts?: SummarizeFinalOptions) => {
        seenSignal = opts?.signal;
        return {
          title: "회의 요약",
          summary: "요약",
          highlights: [],
          actionItems: [],
          createdAt: new Date().toISOString(),
        };
      },
    };
    const pipeline = new MeetingPipeline({
      sttProvider: new MockSttProvider(),
      summaryProvider,
      intermediateEveryFinalSegments: 99,
    });
    pipeline.startSession("s-signal");
    await pipeline.ingestAudioChunk("s-signal", {
      pcm16leMono: Buffer.from([0x00]),
      sampleRate: 16000,
      startSec: 0,
      endSec: 2.0,
    });

    await pipeline.finalizeSession("s-signal", { signal: controller.signal });
    expect(seenSignal).toBe(controller.signal);
  });

  it("파일 ingest timing metadata를 STT provider로 전달한다", async () => {
    const seen: AudioFileInput[] = [];
    const sttProvider: SttProvider = {
      transcribeChunk: async (_input: AudioChunkInput) => [],
      transcribeFile: async (input: AudioFileInput) => {
        seen.push(input);
        return [{
          id: "seg-file",
          speaker: "A",
          original: "offset segment",
          startSec: input.startOffsetSec ?? 0,
          endSec: (input.startOffsetSec ?? 0) + (input.durationSec ?? 0),
          isFinal: true,
          source: "batch",
          createdAt: new Date().toISOString(),
        }];
      },
    };
    const pipeline = new MeetingPipeline({
      sttProvider,
      summaryProvider: new MockSummaryProvider(),
      intermediateEveryFinalSegments: 99,
    });

    pipeline.startSession("file-offset");
    await pipeline.ingestAudioFile("file-offset", {
      bytes: Buffer.from([0x52, 0x49, 0x46, 0x46]),
      mimeType: "audio/wav",
      fileName: "part.wav",
      startOffsetSec: 42.5,
      durationSec: 3.25,
    });

    expect(seen[0]?.startOffsetSec).toBe(42.5);
    expect(seen[0]?.durationSec).toBe(3.25);
    const transcript = pipeline.getTranscript("file-offset");
    expect(transcript[0]?.startSec).toBe(42.5);
    expect(transcript[0]?.endSec).toBe(45.75);
  });

  it("파일 ingest는 업로드 중간 요약 예산 안에서 샘플링하고 최종 요약 호출 여유를 남긴다", async () => {
    const intermediateTranscriptSizes: number[] = [];
    let finalCalls = 0;
    const sttProvider: SttProvider = {
      transcribeChunk: async (_input: AudioChunkInput) => [],
      transcribeFile: async (input: AudioFileInput) =>
        Array.from({ length: 40 }, (_, index) => ({
          id: `upload-seg-${index}`,
          speaker: "A",
          original: `upload segment ${index}`,
          startSec: (input.startOffsetSec ?? 0) + index,
          endSec: (input.startOffsetSec ?? 0) + index + 1,
          isFinal: true,
          source: "batch" as const,
          createdAt: new Date().toISOString(),
        })),
    };
    const summaryProvider: SummaryProvider = {
      summarizeIntermediate: async (input) => {
        intermediateTranscriptSizes.push(input.transcript.length);
        return {
          summary: `중간 ${input.transcript.length}`,
          highlights: [],
          coveredSegmentIds: input.transcript.map((segment) => segment.id),
          createdAt: new Date().toISOString(),
        };
      },
      summarizeFinal: async (input) => {
        finalCalls += 1;
        return {
          title: "회의 요약",
          summary: `final ${input.transcript.length}`,
          highlights: [],
          actionItems: [],
          createdAt: new Date().toISOString(),
        };
      },
    };
    const pipeline = new MeetingPipeline({
      sttProvider,
      summaryProvider,
      intermediateEveryFinalSegments: 1,
      uploadIntermediateSummaryBudget: 8,
      summaryRetryAttempts: 1,
    });

    pipeline.startSession("file-budget");
    await pipeline.ingestAudioFile("file-budget", {
      bytes: Buffer.from([0x52, 0x49, 0x46, 0x46]),
      mimeType: "audio/wav",
      fileName: "long.wav",
    });
    await pipeline.finalizeSession("file-budget");

    expect(intermediateTranscriptSizes).toEqual([5, 10, 15, 20, 25, 30, 35, 40]);
    expect(finalCalls).toBe(1);
  });

  it("파일 ingest 업로드 중간 요약 예산은 분할 파일 전체 세션에서 공유된다", async () => {
    let fileIndex = 0;
    let intermediateCalls = 0;
    const sttProvider: SttProvider = {
      transcribeChunk: async (_input: AudioChunkInput) => [],
      transcribeFile: async (input: AudioFileInput) => {
        const index = fileIndex++;
        return [{
          id: `split-${index}`,
          speaker: "A",
          original: `split segment ${index}`,
          startSec: input.startOffsetSec ?? index,
          endSec: (input.startOffsetSec ?? index) + 1,
          isFinal: true,
          source: "batch",
          createdAt: new Date().toISOString(),
        }];
      },
    };
    const summaryProvider: SummaryProvider = {
      summarizeIntermediate: async (input) => {
        intermediateCalls += 1;
        return {
          summary: `중간 ${input.transcript.length}`,
          highlights: [],
          coveredSegmentIds: input.transcript.map((segment) => segment.id),
          createdAt: new Date().toISOString(),
        };
      },
      summarizeFinal: async () => ({
        title: "회의 요약",
        summary: "final",
        highlights: [],
        actionItems: [],
        createdAt: new Date().toISOString(),
      }),
    };
    const pipeline = new MeetingPipeline({
      sttProvider,
      summaryProvider,
      intermediateEveryFinalSegments: 1,
      uploadIntermediateSummaryBudget: 3,
      summaryRetryAttempts: 1,
    });

    pipeline.startSession("split-budget");
    for (let i = 0; i < 6; i += 1) {
      await pipeline.ingestAudioFile("split-budget", {
        bytes: Buffer.from([0x52, 0x49, 0x46, 0x46]),
        mimeType: "audio/wav",
        fileName: `part-${i}.wav`,
        startOffsetSec: i,
        durationSec: 1,
      });
    }

    expect(intermediateCalls).toBe(3);
    expect(pipeline.getIntermediateSummaries("split-budget")).toHaveLength(3);
  });

  it("finalize 실패가 세션을 finalized 상태로 고정하지 않아 재시도할 수 있다", async () => {
    let failFinal = true;
    const summaryProvider: SummaryProvider = {
      summarizeIntermediate: async () => ({
        summary: "중간 요약",
        highlights: [],
        coveredSegmentIds: [],
        createdAt: new Date().toISOString(),
      }),
      summarizeFinal: async () => {
        if (failFinal) throw new Error("final boom");
        return {
          title: "회의 요약",
          summary: "retry succeeded",
          highlights: [],
          actionItems: [],
          createdAt: new Date().toISOString(),
        };
      },
    };
    const pipeline = new MeetingPipeline({
      sttProvider: new MockSttProvider(),
      summaryProvider,
      intermediateEveryFinalSegments: 99,
      summaryRetryAttempts: 1,
    });

    pipeline.startSession("final-retry");
    await pipeline.ingestTranscriptSegments("final-retry", [
      {
        id: "seg-final-retry",
        speaker: "A",
        original: "retryable transcript",
        startSec: 0,
        endSec: 1,
        isFinal: true,
        source: "batch",
        createdAt: new Date().toISOString(),
      },
    ]);

    await expect(pipeline.finalizeSession("final-retry")).rejects.toThrow("final boom");
    expect(pipeline.getSession("final-retry")?.finalized).toBe(false);

    failFinal = false;
    const finalSummary = await pipeline.finalizeSession("final-retry");

    expect(finalSummary.summary).toBe("retry succeeded");
    expect(pipeline.getSession("final-retry")?.finalized).toBe(true);
  });
});

// ─── deduplicateAndMerge 단위 테스트 ────────────────────────────────────────
// deduplicateAndMerge는 private이므로 ingestTranscriptSegments를 통해 간접 테스트.
// 세션에 기존 세그먼트를 직접 주입(restoreSession)한 뒤 새 세그먼트를 ingest해
// transcript 결과로 병합/중복제거 동작을 검증한다.

function makePipeline() {
  return new MeetingPipeline({
    sttProvider: new MockSttProvider(),
    summaryProvider: new MockSummaryProvider(),
    intermediateEveryFinalSegments: 99, // 중간 요약 트리거 방지
  });
}

function seg(
  id: string,
  original: string,
  startSec: number,
  endSec: number,
  speaker = "Speaker A",
  isFinal = true,
): TranscriptSegment {
  return { id, speaker, original, translated: original, startSec, endSec, isFinal, source: "streaming", createdAt: new Date().toISOString() };
}

/**
 * deduplicateAndMerge는 private이므로 any 캐스트로 직접 호출.
 * 이렇게 하면 normalizeSegments나 ingest 경로와 무관하게 순수 로직을 검증할 수 있다.
 */
function dedupe(
  pipeline: MeetingPipeline,
  existing: TranscriptSegment[],
  incoming: TranscriptSegment[],
): TranscriptSegment[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (pipeline as any).deduplicateAndMerge(existing, incoming) as TranscriptSegment[];
}

describe("deduplicateAndMerge (direct private call via any-cast)", () => {
  it("단어 오버랩이 있는 청크 → 앞 세그먼트에 병합되고 텍스트 중복 제거", () => {
    const pipeline = makePipeline();
    // existing: "hello world foo"  (문장 미종결)
    // incoming: "world foo bar baz" (앞 2단어 오버랩)
    // 기대: lastExisting이 "hello world foo bar baz"로 확장, result는 빈 배열 반환
    const existing = [seg("e1", "hello world foo", 0, 2, "Speaker A")];
    const incomingSegs = [seg("i1", "world foo bar baz", 1.5, 4, "Speaker A")];

    const result = dedupe(pipeline, existing, incomingSegs);

    // 병합 경로: result에는 추가되지 않고 existing[0].original이 확장됨
    expect(result).toHaveLength(0);
    expect(existing[0]!.original).toContain("bar baz");
    expect(existing[0]!.original).not.toMatch(/world foo.*world foo/); // 중복 단어 없음
  });

  it("타임스탬프 오버랩만 있고 단어 오버랩 없음 → 별도 세그먼트로 반환 (버그 시나리오)", () => {
    const pipeline = makePipeline();
    // existing ends at 3s, incoming starts at 2s (timestamp overlap)
    // but text is completely different — should NOT be merged
    const existing = [seg("e1", "회의를 시작합니다", 0, 3, "Speaker A")];
    const incomingSegs = [seg("i1", "새로운 주제입니다", 2, 5, "Speaker A")];

    const result = dedupe(pipeline, existing, incomingSegs);

    expect(result).toHaveLength(1);
    expect(result[0]!.original).toBe("새로운 주제입니다");
  });

  it("완전 중복 청크 → 빈 배열 반환 (continue 경로)", () => {
    const pipeline = makePipeline();
    // incoming is a complete subset of existing's tail — all words overlap → cleanedText is empty
    const existing = [seg("e1", "alpha beta gamma delta", 0, 4, "Speaker A")];
    const incomingSegs = [seg("i1", "beta gamma delta", 3, 5, "Speaker A")];

    const result = dedupe(pipeline, existing, incomingSegs);

    // 완전 중복이므로 continue → result is empty
    expect(result).toHaveLength(0);
  });

  it("화자가 다르면 단어 오버랩이 있어도 병합하지 않음", () => {
    const pipeline = makePipeline();
    const existing = [seg("e1", "hello world foo", 0, 2, "Speaker A")];
    const incomingSegs = [seg("i1", "world foo bar", 1.5, 4, "Speaker B")]; // different speaker

    const result = dedupe(pipeline, existing, incomingSegs);

    // 병합 조건(same speaker) 불충족 → result에 새 세그먼트 추가
    // 오버랩 단어(world foo)는 제거되어 "bar"만 남음
    expect(result).toHaveLength(1);
    expect(result[0]!.original).toBe("bar");
  });

  it("문장이 종결된 마지막 세그먼트 → 오버랩이 있어도 병합하지 않음", () => {
    const pipeline = makePipeline();
    // 문장 종결부호로 끝남
    const existing = [seg("e1", "회의를 시작합니다.", 0, 2, "Speaker A")];
    // "합니다" is a 1-word overlap but isSentenceEnd blocks merge
    const incomingSegs = [seg("i1", "합니다 새로운 안건", 1.5, 4, "Speaker A")];

    const result = dedupe(pipeline, existing, incomingSegs);

    // 문장 종결이므로 병합 안 됨 → result에 새 세그먼트 추가
    // overlap은 1단어("합니다")이지만 findSuffixPrefixOverlap은 최소 2단어부터 검출
    // → overlapLen=0 → cleanedText="합니다 새로운 안건" → result에 그대로 추가
    expect(result).toHaveLength(1);
  });
});
