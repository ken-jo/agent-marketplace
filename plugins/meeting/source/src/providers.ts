import type {
  AudioChunkInput,
  AudioFileInput,
  FinalSummary,
  IntermediateSummary,
  MeetingContext,
  SummaryLengthTier,
  TranscriptSegment,
} from "./types";

export interface SttProvider {
  transcribeChunk(input: AudioChunkInput): Promise<TranscriptSegment[]>;
  /**
   * Optional batch path — transcribe a complete file in one request without
   * the chunked PCM streaming pipeline. Providers that don't support file
   * uploads should leave this undefined; the host will reject upload calls
   * for those providers.
   */
  transcribeFile?(input: AudioFileInput): Promise<TranscriptSegment[]>;
}

export interface SummaryInput {
  sessionId: string;
  transcript: TranscriptSegment[];
  context?: MeetingContext;
}

export interface SummarizeIntermediateOptions {
  signal?: AbortSignal;
}

/** Per-call options for SummaryProvider.summarizeFinal — allows the pipeline
 *  to override the provider's configured default verbosity tier on a single
 *  meeting (e.g. user picked "길게" in the recorder window before pressing Done). */
export interface SummarizeFinalOptions {
  lengthTier?: SummaryLengthTier;
  signal?: AbortSignal;
}

export interface SummaryProvider {
  summarizeIntermediate(input: SummaryInput, opts?: SummarizeIntermediateOptions): Promise<IntermediateSummary>;
  summarizeFinal(input: SummaryInput, opts?: SummarizeFinalOptions): Promise<FinalSummary>;
}
