export type SegmentSource = "streaming" | "batch";

export interface TranscriptSegmentSttMetadata {
  provider?: string;
  model?: string;
  language?: string;
  confidence?: number;
  avgLogprob?: number;
  noSpeechProb?: number;
  compressionRatio?: number;
  temperature?: number;
}

export interface TranscriptSegment {
  id: string;
  speaker: string;
  original: string;
  translated?: string;
  startSec: number;
  endSec: number;
  isFinal: boolean;
  source: SegmentSource;
  stt?: TranscriptSegmentSttMetadata;
  createdAt: string;
}

export interface IntermediateSummary {
  summary: string;
  highlights: string[];
  coveredSegmentIds: string[];
  createdAt: string;
}

/**
 * Summary length tier — controls final-summary verbosity.
 * - short: 1-2 핵심 결정사항 문장
 * - medium: 3-5 문장 (기본)
 * - long: 5-10 문장 + 상세 하이라이트
 */
export type SummaryLengthTier = "short" | "medium" | "long";

export interface FinalSummary {
  title: string;
  summary: string;
  highlights: string[];
  actionItems: string[];
  createdAt: string;
  /** Generated with this length tier (recorded for UI display + audit). */
  lengthTier?: SummaryLengthTier;
}

/**
 * Conference call info — grouped under MeetingContext.conference so future
 * Zoom/Teams variants don't pollute the top-level shape with vendor-specific
 * keys. UI dispatches on `type` (icon, button label, deeplink scheme).
 */
export interface ConferenceInfo {
  type: "webex" | "zoom" | "teams" | "other";
  joinUrl: string;
  accessCode?: string;
  password?: string;
  hostDisplayName?: string;
}

export interface MeetingContext {
  /** Stable identifier — required for PrepStore upserts so re-imports of
   * the same calendar event update rather than duplicate. Optional at
   * meeting_start time (recorder generates one). */
  id?: string;

  /** Meeting title supplied at meeting_start. Surfaced as the session list
   * label and as the detail-view header when finalSummary is missing. */
  title?: string;
  locale?: string;
  /** Hint passed to the LLM summary prompt — NOT shown in the UI. */
  contextHint?: string;
  /** Free-text body of the calendar invite. Shown in the UI; not used by LLM. */
  description?: string;
  /** Required-by-policy meeting category. Registration asks the user when omitted. */
  category?: string;
  participants?: string[];
  organizer?: string;

  // ─── Pre-meeting prep fields (optional) ───
  // Populated by external callers (calendar plugin, agent-hub, or user) so
  // the pre-meeting UI can render schedule, location, agenda, last summary,
  // and a one-click conference launcher. None of these affect STT/summary.
  scheduledStart?: string;
  scheduledEnd?: string;
  location?: string;
  conference?: ConferenceInfo;
  agenda?: string[];
  previousSummary?: {
    title?: string;
    summary: string;
  };
}

export interface AudioChunkInput {
  sessionId: string;
  pcm16leMono: Buffer;
  sampleRate: number;
  startSec: number;
  endSec: number;
}

export interface AudioFileInput {
  sessionId: string;
  /** Raw audio/video file bytes — NOT converted to PCM. */
  bytes: Buffer;
  /** MIME type. Used as Blob type when sent as multipart. */
  mimeType?: string;
  /** Original filename (with extension) — used in multipart filename param. */
  fileName: string;
  /** Seconds to add to provider-relative timestamps when a large file is split. */
  startOffsetSec?: number;
  /** Approximate file duration for providers that return only plain text. */
  durationSec?: number;
}

export interface IngestResult {
  sessionId: string;
  addedSegments: TranscriptSegment[];
  /** Index of the first added segment in the full transcript (pre-ingest length). */
  baseIndex: number;
  intermediateSummary?: IntermediateSummary;
}
