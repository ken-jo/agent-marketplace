import type { SttProvider, SummarizeFinalOptions, SummaryInput, SummaryProvider } from "../providers";
import type { AudioChunkInput, FinalSummary, IntermediateSummary, TranscriptSegment } from "../types";

export class MockSttProvider implements SttProvider {
  async transcribeChunk(input: AudioChunkInput): Promise<TranscriptSegment[]> {
    const duration = Math.max(0.1, input.endSec - input.startSec);
    return [
      {
        id: `${input.sessionId}-${Math.round(input.startSec * 1000)}`,
        speaker: "Speaker A",
        original: `audio-chunk(${duration.toFixed(1)}s)`,
        translated: `audio-chunk(${duration.toFixed(1)}s)`,
        startSec: input.startSec,
        endSec: input.endSec,
        isFinal: true,
        source: "streaming",
        createdAt: new Date().toISOString(),
      },
    ];
  }
}

export class MockSummaryProvider implements SummaryProvider {
  async summarizeIntermediate(input: SummaryInput): Promise<IntermediateSummary> {
    const covered = input.transcript.filter((x) => x.isFinal);
    return {
      summary: `중간 요약 (${covered.length} segments)`,
      highlights: covered.slice(-3).map((s) => s.original),
      coveredSegmentIds: covered.map((x) => x.id),
      createdAt: new Date().toISOString(),
    };
  }

  async summarizeFinal(input: SummaryInput, opts?: SummarizeFinalOptions): Promise<FinalSummary> {
    const allText = input.transcript.map((x) => x.original).join(" ");
    // Mock varies summary length by tier so tests can assert tier propagation.
    const tier = opts?.lengthTier ?? "medium";
    const cap = tier === "short" ? 120 : tier === "long" ? 600 : 280;
    return {
      title: "회의 요약",
      summary: allText.slice(0, cap),
      highlights: input.transcript.slice(-5).map((x) => x.original),
      actionItems: [],
      createdAt: new Date().toISOString(),
      lengthTier: tier,
    };
  }
}
