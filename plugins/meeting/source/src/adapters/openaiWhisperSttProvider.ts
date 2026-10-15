/**
 * OpenAI Whisper STT Provider — 실시간 음성 전사 + Speaker Diarization
 *
 * 지원 모델:
 * - whisper-1: 기본 전사
 * - gpt-4o-mini-transcribe: 최적화 전사
 * - gpt-4o-transcribe: 고품질 전사
 * - gpt-4o-transcribe-diarize: 화자 분리 (diarization)
 *
 * 핵심 원칙:
 * - 에러 시 throw (절대 빈 배열로 삼키지 않음)
 * - verbose_json으로 세그먼트 단위 타임스탬프 확보
 * - diarization 모델 사용 시 화자별 라벨링
 * - retry는 파이프라인 레벨에서 처리 (provider는 단일 시도)
 */
import type { SttProvider } from "../providers.js";
import type { ApiKeyLease, HostFetchInit } from "@ave/plugin-contract";
import type {
  AudioChunkInput,
  AudioFileInput,
  TranscriptSegment,
  TranscriptSegmentSttMetadata,
} from "../types.js";

// ─── Options ────────────────────────────────────────

export interface OpenAIWhisperSttProviderOptions {
  /** Plugin-owned key. Host-owned credentials are represented only by lease. */
  apiKey?: string;
  lease?: ApiKeyLease;
  model?: string;
  language?: string;
  prompt?: string;
  baseUrl?: string;
  /** 화자 분리 시 알려진 참석자 이름 */
  knownSpeakerNames?: string[];
  /** 화자 분리 시 참조 오디오 (data URL). knownSpeakerNames와 1:1 매핑. */
  knownSpeakerReferences?: string[];
  /**
   * Whisper segment 의 `no_speech_prob` 가 이 임계값 이상이면 drop.
   * 0~1. 기본 0.7 (Whisper 권장과 일치). 높이면 더 보수적(노이즈 더 잘 거름),
   * 낮추면 더 적극적(짧은 말도 살림).
   */
  noSpeechThreshold?: number;
  /**
   * 이보다 짧은 segment 는 인접한 같은 화자의 segment 와 merge.
   * 0 이면 비활성. 기본 0 (현행 유지). 1.5 정도가 짧은 발화 흡수에 적합.
   */
  minSegmentSec?: number;
  /**
   * 인접 segment 사이의 무음 갭이 이 값 이하이면 merge.
   * 0 이면 비활성. 기본 0 (현행 유지). 0.5~0.8 정도가 자연스러운 문장 결합.
   */
  maxGapSec?: number;
  fetch?: (input: string | URL, init?: HostFetchInit) => Promise<Response>;
  /**
   * Aborts in-flight Whisper fetch when fired. Plumbed from the meeting
   * session's AbortController so meeting_stop / handle.release() propagates
   * to any pending transcription request. Combined (via AbortSignal.any)
   * with the per-call request timeout so either source can cancel.
   */
  signal?: AbortSignal;
}

// ─── OpenAI Response Types ──────────────────────────

interface WhisperVerboseResponse {
  task?: string;
  language?: string;
  duration?: number;
  text?: string;
  segments?: WhisperSegment[];
}

interface WhisperSegment {
  id: number | string;
  start: number;
  end: number;
  text: string;
  speaker?: string; // diarization 모델에서 반환
  avg_logprob?: number;
  no_speech_prob?: number;
  compression_ratio?: number;
  temperature?: number;
}

// ─── Utilities ─────────────────────────────────────

/** Buffer를 audio/wav data URL로 변환 (diarization 참조 오디오용) */
function redactCredentialEcho(body: string): string {
  return body.replace(/(Incorrect API key provided:\s*)[^"\s]+/gi, "$1[redacted]");
}
export function toAudioDataUrl(buffer: Buffer): string {
  return `data:audio/wav;base64,${buffer.toString("base64")}`;
}

// ─── Provider ───────────────────────────────────────

export class OpenAIWhisperSttProvider implements SttProvider {
  private readonly apiKey: string | undefined;
  private readonly lease: ApiKeyLease | undefined;
  private readonly model: string;
  private readonly language: string;
  private readonly prompt: string | undefined;
  private readonly baseUrl: string;
  private readonly knownSpeakerNames: string[];
  private readonly knownSpeakerReferences: string[];
  private readonly isDiarizationModel: boolean;
  private readonly noSpeechThreshold: number;
  private readonly minSegmentSec: number;
  private readonly maxGapSec: number;
  private readonly fetchImpl: (input: string | URL, init?: HostFetchInit) => Promise<Response>;
  private readonly externalSignal: AbortSignal | undefined;

  constructor(options: OpenAIWhisperSttProviderOptions) {
    if (Boolean(options.apiKey) === Boolean(options.lease)) {
      throw new Error("STT requires exactly one credential source");
    }
    this.apiKey = options.apiKey;
    this.lease = options.lease;
    this.model = options.model ?? "gpt-4o-mini-transcribe";
    this.language = options.language ?? "ko";
    this.prompt = options.prompt;
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1/audio/transcriptions";
    this.knownSpeakerNames = options.knownSpeakerNames ?? [];
    this.knownSpeakerReferences = options.knownSpeakerReferences ?? [];
    this.isDiarizationModel = this.model.includes("diarize");
    // Clamp into safe ranges. noSpeechThreshold defaults to 0.7 (current behaviour).
    // minSegmentSec / maxGapSec default to 0 (no merging) so unconfigured callers
    // see the original Whisper segmentation.
    this.noSpeechThreshold = clamp(options.noSpeechThreshold ?? 0.7, 0, 1);
    this.minSegmentSec = Math.max(0, options.minSegmentSec ?? 0);
    this.maxGapSec = Math.max(0, options.maxGapSec ?? 0);
    this.fetchImpl = options.fetch ?? fetch;
    this.externalSignal = options.signal;
  }

  /**
   * Combine the meeting-session AbortSignal (from hostApi.resolveApiKey →
   * AbortController held by hostPlugin) with a per-request timeout signal.
   * Whichever fires first cancels the in-flight fetch.
   */
  private combinedSignal(timeoutMs: number): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    if (!this.externalSignal) return timeoutSignal;
    const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
    if (typeof anyFn === "function") {
      return anyFn([this.externalSignal, timeoutSignal]);
    }
    // Fallback for runtimes without AbortSignal.any — relay via a controller.
    const controller = new AbortController();
    const abortNow = () => controller.abort();
    if (this.externalSignal.aborted) controller.abort();
    else this.externalSignal.addEventListener("abort", abortNow, { once: true });
    if (timeoutSignal.aborted) controller.abort();
    else timeoutSignal.addEventListener("abort", abortNow, { once: true });
    return controller.signal;
  }

  private requestAuth(): Pick<HostFetchInit, "auth" | "headers"> {
    return this.lease
      ? { auth: { lease: this.lease.leaseId } }
      : { headers: { Authorization: `Bearer ${this.apiKey}` } };
  }

  private assertMultipartBudget(form: FormData, audioBytes: number): void {
    const limit = 16 * 1024 * 1024;
    const audioLimit = 15 * 1024 * 1024;
    // The reference runtime generates a boundary. Reserve 16 KiB per part
    // for boundaries and headers, including non-ASCII filenames and MIME.
    let estimatedBytes = 0;
    let parts = 0;
    for (const [key, value] of form.entries()) {
      parts += 1;
      estimatedBytes += new TextEncoder().encode(key).byteLength;
      if (typeof value === "string") {
        estimatedBytes += new TextEncoder().encode(value).byteLength;
      } else {
        estimatedBytes += value.size;
        estimatedBytes += new TextEncoder().encode(value.name).byteLength;
        estimatedBytes += new TextEncoder().encode(value.type).byteLength;
      }
    }
    if (audioBytes > audioLimit || estimatedBytes + parts * 16 * 1024 >= limit) {
      throw new Error("file-too-large: serialized multipart request exceeds 16 MiB");
    }
  }

  async transcribeChunk(input: AudioChunkInput): Promise<TranscriptSegment[]> {
    // Diarization 모델: names와 references 길이 일치 검증
    if (
      this.isDiarizationModel &&
      this.knownSpeakerReferences.length > 0 &&
      this.knownSpeakerNames.length !== this.knownSpeakerReferences.length
    ) {
      throw new Error("knownSpeakerNames 와 knownSpeakerReferences 의 길이는 같아야 합니다.");
    }

    const wav = pcm16leMonoToWav(input.pcm16leMono, input.sampleRate);

    // 모델별 응답 포맷: whisper-1은 verbose_json, 신규 모델은 json만 지원
    const isLegacyWhisper = this.model.startsWith("whisper");
    const responseFormat = isLegacyWhisper ? "verbose_json" : "json";

    const form = new FormData();
    form.append("model", this.model);
    form.append("language", this.language);
    form.append("response_format", responseFormat);
    if (isLegacyWhisper) {
      form.append("timestamp_granularities[]", "segment");
    }
    // Diarization models (gpt-4o-transcribe-diarize) reject any request that
    // omits chunking_strategy. The streaming chunk path sends short PCM
    // (≤6s) so "auto" lets the server pick a sensible default.
    if (this.isDiarizationModel) {
      form.append("chunking_strategy", "auto");
    }

    if (this.prompt) {
      form.append("prompt", this.prompt);
    } else if (this.isDiarizationModel && this.knownSpeakerNames.length > 0) {
      form.append("prompt", `Speakers: ${this.knownSpeakerNames.join(", ")}`);
    }

    // TS 6.0: Buffer<ArrayBufferLike> is no longer assignable to BlobPart;
    // copy into a plain Uint8Array<ArrayBuffer> to satisfy the stricter constraint.
    const wavBytes = new Uint8Array(wav);
    form.append("file", new Blob([wavBytes], { type: "audio/wav" }), "chunk.wav");
    this.assertMultipartBudget(form, wavBytes.byteLength);

    const res = await this.fetchImpl(this.baseUrl, {
      method: "POST",
      ...this.requestAuth(),
      body: form,
      signal: this.combinedSignal(30_000),
    });

    if (!res.ok) {
      let errorBody = "";
      try { errorBody = await res.text(); } catch { /* Response.text() 미지원 환경 대비 */ }
      throw new Error(
        `Whisper request failed: ${res.status} ${errorBody.slice(0, 200) || res.statusText}`,
      );
    }

    const data = (await res.json()) as WhisperVerboseResponse;

    // segments 우선 처리 (top-level text 없이 segments만 올 수 있음)
    if (data.segments && data.segments.length > 0) {
      const segs = data.segments
        .filter((seg) => seg.text.trim().length > 0)
        .filter((seg) => (seg.no_speech_prob ?? 0) < this.noSpeechThreshold)
        .map((seg) => ({
          id: `${input.sessionId}-${seg.id}`,
          speaker: resolveSpeaker(seg, this.knownSpeakerNames),
          original: seg.text.trim(),
          startSec: input.startSec + seg.start,
          endSec: input.startSec + seg.end,
          isFinal: true,
          source: "batch" as const,
          stt: buildSttMetadata(this.model, data.language, seg),
          createdAt: new Date().toISOString(),
        }));
      return mergeAdjacentSegments(segs, this.minSegmentSec, this.maxGapSec);
    }

    // segments 없는 경우 text 필드 확인
    if (!data.text || data.text.trim().length < 2) {
      return []; // 무음 — 정상적인 빈 반환 (에러가 아님)
    }

    // 전체 텍스트를 단일 세그먼트로
    return [{
      id: `${input.sessionId}-${Date.now()}`,
      speaker: this.knownSpeakerNames[0] ?? "참석자",
      original: data.text.trim(),
      startSec: input.startSec,
      endSec: input.endSec,
      isFinal: true,
      source: "batch" as const,
      stt: { provider: "openai", model: this.model, language: data.language },
      createdAt: new Date().toISOString(),
    }];
  }

  /**
   * Batch file upload path — sends the file bytes directly as multipart
   * (no PCM/WAV conversion). Whisper REST accepts mp3/mp4/mpeg/mpga/m4a/
   * wav/webm. Caller is responsible for size/mime validation.
   *
   * Returned segment timestamps are absolute (start at 0) since the file is
   * a complete recording. Larger timeout (5 min) — file uploads can be much
   * slower than 3-second chunks.
   */
  async transcribeFile(input: AudioFileInput): Promise<TranscriptSegment[]> {
    if (
      this.isDiarizationModel &&
      this.knownSpeakerReferences.length > 0 &&
      this.knownSpeakerNames.length !== this.knownSpeakerReferences.length
    ) {
      throw new Error("knownSpeakerNames 와 knownSpeakerReferences 의 길이는 같아야 합니다.");
    }

    const isLegacyWhisper = this.model.startsWith("whisper");
    const responseFormat = isLegacyWhisper ? "verbose_json" : "json";

    const form = new FormData();
    form.append("model", this.model);
    form.append("language", this.language);
    form.append("response_format", responseFormat);
    if (isLegacyWhisper) {
      form.append("timestamp_granularities[]", "segment");
    }
    // Diarization models reject the request without chunking_strategy.
    // "auto" lets the server segment the full uploaded file.
    if (this.isDiarizationModel) {
      form.append("chunking_strategy", "auto");
    }

    if (this.prompt) {
      form.append("prompt", this.prompt);
    } else if (this.isDiarizationModel && this.knownSpeakerNames.length > 0) {
      form.append("prompt", `Speakers: ${this.knownSpeakerNames.join(", ")}`);
    }

    // Build a zero-copy Uint8Array view over the same bytes the input Buffer
    // already owns. The previous `new Uint8Array(input.bytes)` allocated a
    // fresh same-size copy (~25 MB for a Whisper-sized upload) only because
    // TypeScript's `BlobPart` rejects `Buffer<ArrayBufferLike>` (the buffer
    // pool's underlying ArrayBuffer is typed wider than `ArrayBuffer`). The
    // narrow `as ArrayBuffer` is the minimum cast needed to skip the copy;
    // Node Buffers in this code path always back onto a plain ArrayBuffer
    // (`Buffer.from(string, "base64")` allocates fresh, never shared).
    const view = new Uint8Array(
      input.bytes.buffer as ArrayBuffer,
      input.bytes.byteOffset,
      input.bytes.byteLength,
    );
    const mime = input.mimeType ?? guessMimeFromName(input.fileName) ?? "application/octet-stream";
    form.append("file", new Blob([view], { type: mime }), input.fileName);
    this.assertMultipartBudget(form, input.bytes.byteLength);

    const res = await this.fetchImpl(this.baseUrl, {
      method: "POST",
      ...this.requestAuth(),
      body: form,
      signal: this.combinedSignal(300_000),
    });

    if (!res.ok) {
      let errorBody = "";
      try { errorBody = await res.text(); } catch { /* ignore */ }
      const safeErrorBody = redactCredentialEcho(errorBody).slice(0, 200);
      throw new Error(
        `Whisper file upload failed: ${res.status} ${safeErrorBody || res.statusText}`,
      );
    }

    const data = (await res.json()) as WhisperVerboseResponse;
    const startOffsetSec = input.startOffsetSec ?? 0;
    const startOffsetMs = Math.round(startOffsetSec * 1000);
    const segmentIdPrefix = startOffsetMs === 0 ? input.sessionId : `${input.sessionId}-${startOffsetMs}`;

    if (data.segments && data.segments.length > 0) {
      const segs = data.segments
        .filter((seg) => seg.text.trim().length > 0)
        .filter((seg) => (seg.no_speech_prob ?? 0) < this.noSpeechThreshold)
        .map((seg) => ({
          id: `${segmentIdPrefix}-${seg.id}`,
          speaker: resolveSpeaker(seg, this.knownSpeakerNames),
          original: seg.text.trim(),
          startSec: startOffsetSec + seg.start,
          endSec: startOffsetSec + seg.end,
          isFinal: true,
          source: "batch" as const,
          stt: buildSttMetadata(this.model, data.language, seg),
          createdAt: new Date().toISOString(),
        }));
      return mergeAdjacentSegments(segs, this.minSegmentSec, this.maxGapSec);
    }

    if (!data.text || data.text.trim().length < 2) return [];

    // Some model + chunking_strategy combinations (notably diarization
    // models with chunking_strategy: auto) return plain text without
    // per-utterance segments. Splitting into sentence-sized segments here
    // lets the upload path's intermediate-summary batching fire as
    // designed (single artificial segment is < 6-segment threshold so
    // 중간 리파인 tab would otherwise stay empty) and gives the
    // transcript view actual line breaks instead of one wall of text.
    const text = data.text.trim();
    const totalDuration = typeof data.duration === "number" && data.duration > 0
      ? data.duration
      : typeof input.durationSec === "number" && input.durationSec > 0
        ? input.durationSec
        : 0;
    const sentences = splitIntoSentences(text);
    const baseSpeaker = this.knownSpeakerNames[0] ?? "참석자";
    const sttMeta = { provider: "openai" as const, model: this.model, language: data.language };
    const now = Date.now();

    if (sentences.length <= 1) {
      // Genuinely one sentence — keep the original single-segment behaviour.
      return [{
        id: `${segmentIdPrefix}-${now}`,
        speaker: baseSpeaker,
        original: text,
        startSec: startOffsetSec,
        endSec: startOffsetSec + totalDuration,
        isFinal: true,
        source: "batch" as const,
        stt: sttMeta,
        createdAt: new Date().toISOString(),
      }];
    }

    // Distribute the total duration across sentences proportionally to
    // character count — Whisper doesn't give us per-sentence timing in
    // this path so a length-weighted estimate is the best we can do.
    const totalChars = sentences.reduce((s, x) => s + x.length, 0) || 1;
    let elapsed = 0;
    const createdAt = new Date().toISOString();
    return sentences.map((sentence, i) => {
      const seg = totalDuration * (sentence.length / totalChars);
      const startSec = elapsed;
      const endSec = i === sentences.length - 1 ? totalDuration : elapsed + seg;
      elapsed = endSec;
      return {
        id: `${segmentIdPrefix}-${i}-${now}`,
        speaker: baseSpeaker,
        original: sentence,
        startSec: startOffsetSec + startSec,
        endSec: startOffsetSec + endSec,
        isFinal: true,
        source: "batch" as const,
        stt: sttMeta,
        createdAt,
      };
    });
  }
}

function guessMimeFromName(name: string): string | undefined {
  const ext = name.toLowerCase().split(".").pop();
  switch (ext) {
    case "mp3": return "audio/mpeg";
    case "mpga": return "audio/mpeg";
    case "wav": return "audio/wav";
    case "m4a": return "audio/mp4";
    case "mp4": return "video/mp4";
    case "webm": return "audio/webm";
    case "ogg": return "audio/ogg";
    case "flac": return "audio/flac";
    default: return undefined;
  }
}

// ─── Helpers ────────────────────────────────────────

/** 화자 결정: diarization API → known names fallback → 기본 라벨 */
function resolveSpeaker(seg: WhisperSegment, knownNames: string[]): string {
  // Diarization 모델이 speaker를 반환한 경우
  if (seg.speaker) {
    // "speaker_0" 같은 라벨을 knownNames로 매핑 시도
    const speakerIdx = parseInt(seg.speaker.replace(/\D/g, ""), 10);
    if (!isNaN(speakerIdx) && knownNames[speakerIdx]) {
      return knownNames[speakerIdx];
    }
    return seg.speaker;
  }
  // Diarization 없으면 기본 라벨
  return knownNames[0] ?? "참석자";
}

function buildSttMetadata(
  model: string,
  language: string | undefined,
  seg: WhisperSegment,
): TranscriptSegmentSttMetadata {
  const meta: TranscriptSegmentSttMetadata = {
    provider: "openai",
    model,
    language,
  };

  if (seg.avg_logprob !== undefined) {
    meta.avgLogprob = seg.avg_logprob;
    meta.confidence = Math.min(1, Math.max(0, Math.exp(seg.avg_logprob)));
  }
  if (seg.no_speech_prob !== undefined) meta.noSpeechProb = seg.no_speech_prob;
  if (seg.compression_ratio !== undefined) meta.compressionRatio = seg.compression_ratio;
  if (seg.temperature !== undefined) meta.temperature = seg.temperature;

  return meta;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * Coalesce adjacent transcript segments to suppress over-fragmentation.
 *
 * Whisper returns clean per-VAD-window slices, which on Korean meeting audio
 * often produces 0.5–1.5s shards (a head nod, a "네", a paused ramble). The
 * downstream summary cost grows with segment count, and the UI list reads as
 * choppy nonsense. We merge two adjacent segments when EITHER:
 *   - the gap between them is ≤ maxGapSec (continuous speech across pause), OR
 *   - the previous segment is shorter than minSegmentSec (snap to neighbour)
 * AND the speaker labels match (preserves diarization boundaries even at the
 * cost of visible fragmentation across a switch).
 *
 * Both knobs default to 0 in the constructor, in which case this function
 * is effectively a passthrough (loop runs once per segment, never merges).
 */
export function mergeAdjacentSegments(
  segments: TranscriptSegment[],
  minSegmentSec: number,
  maxGapSec: number,
): TranscriptSegment[] {
  if (segments.length === 0) return segments;
  if (minSegmentSec <= 0 && maxGapSec <= 0) return segments;

  const out: TranscriptSegment[] = [];
  for (const seg of segments) {
    const last = out[out.length - 1];
    if (!last) {
      out.push({ ...seg });
      continue;
    }
    const gap = seg.startSec - last.endSec;
    const lastDur = Math.max(0, last.endSec - last.startSec);
    const sameSpeaker = last.speaker === seg.speaker;
    const closeEnough = maxGapSec > 0 && gap <= maxGapSec;
    const lastTooShort = minSegmentSec > 0 && lastDur < minSegmentSec;
    if (sameSpeaker && (closeEnough || lastTooShort)) {
      // Concat text with a single space; preserve last's id so downstream
      // dedup keys stay stable (the merged segment's id is the FIRST of the
      // run). Update endSec to the right edge.
      last.original = `${last.original} ${seg.original}`.replace(/\s+/g, " ").trim();
      last.endSec = seg.endSec;
      // For metadata, prefer the lower noSpeechProb (more confident).
      const lastNs = last.stt?.noSpeechProb ?? 1;
      const segNs = seg.stt?.noSpeechProb ?? 1;
      if (last.stt && segNs < lastNs) last.stt.noSpeechProb = segNs;
      continue;
    }
    out.push({ ...seg });
  }
  return out;
}

/**
 * Split a transcript text blob into sentence-sized pieces. Used when
 * Whisper returns plain text without per-utterance segments — without
 * splitting, the entire upload becomes a single transcript segment,
 * which is below the intermediate-summary segment threshold and reads
 * as a wall of unbroken text in the transcript tab.
 *
 * Falls back to fixed-width character chunks when no sentence-ending
 * punctuation is found (rare: stream-of-thought monologue with no
 * delimiters, or non-period languages).
 */
function splitIntoSentences(text: string): string[] {
  // Sentence-ending punctuation followed by whitespace. Covers Korean
  // (다., 요., ?, !), Chinese/Japanese fullwidth (。？！), and Latin
  // (. ? !). Lookbehind keeps the punctuation with its sentence.
  const parts = text
    .split(/(?<=[.!?。？！…])\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length > 1) return parts;
  // No sentence boundaries — chunk by character so we still get
  // multiple segments out of a long text blob.
  const CHUNK_LEN = 240;
  if (text.length <= CHUNK_LEN) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_LEN) {
    const piece = text.slice(i, i + CHUNK_LEN).trim();
    if (piece.length > 0) chunks.push(piece);
  }
  return chunks.length > 0 ? chunks : [text];
}

/** PCM16LE mono → WAV (RIFF header + raw data) */
function pcm16leMonoToWav(pcm16leMono: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcm16leMono.length;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm16leMono]);
}
