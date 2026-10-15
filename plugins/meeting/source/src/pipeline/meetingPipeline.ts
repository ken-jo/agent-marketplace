/**
 * Meeting Pipeline — 오디오 청크 → STT → 요약 파이프라인
 *
 * 개선사항 (claw-code 패턴):
 * - STT 호출에 retry with exponential backoff
 * - Summary 실패가 ingest를 차단하지 않도록 격리
 * - 세션 상태 변경 시 persistence 콜백 호출
 */
import type { AudioFileInput, MeetingContext, IngestResult, TranscriptSegment, FinalSummary, IntermediateSummary, SummaryLengthTier } from "../types.js";
import type { SttProvider, SummaryProvider } from "../providers.js";
import { withRetry } from "../utils/retry.js";

// ─── Types ──────────────────────────────────────────

export type SessionState = {
  sessionId: string;
  context?: MeetingContext;
  transcript: TranscriptSegment[];
  intermediateSummaries: Array<{
    coveredSegmentCount: number;
    data: IntermediateSummary;
  }>;
  finalized: boolean;
  createdAt: string;
  updatedAt: string;
};

export interface MeetingPipelineOptions {
  /**
   * STT provider 인스턴스를 직접 전달하거나 factory 를 전달한다.
   * factory 는 startSession 시점에 호출되어 per-session AbortSignal 을
   * 받아 provider 에 주입한다 (SDK v5.13 resolveApiKey + in-flight cancel).
   * sttProviderFactory 가 있으면 sttProvider 는 무시된다.
   *
   * factory 는 Promise 반환 가능 — hostApi.resolveApiKey 는 async.
   */
  sttProvider?: SttProvider;
  /** @see sttProvider */
  sttProviderFactory?: (ctx: { sessionId: string; signal: AbortSignal }) => SttProvider | Promise<SttProvider>;
  summaryProvider: SummaryProvider;
  intermediateEveryFinalSegments?: number;
  /**
   * 마지막 intermediate summary 생성 후 이 시간이 지나기 전까지는 재호출 안 함.
   * 호스트 callLlm 의 전역 rate limit (기본 600s 에 20콜) 과 충돌을 피한다.
   * 기본 60_000ms. 0 또는 음수면 비활성.
   */
  intermediateMinIntervalMs?: number;
  /**
   * File-upload sessions can transcribe many batches back-to-back. Cap the
   * upload path's intermediate summaries per session so it cannot exhaust the
   * host callLlm budget before the final summary. 0 disables upload
   * intermediates while preserving the final summary.
   */
  uploadIntermediateSummaryBudget?: number;
  /**
   * Master switch — false 이면 intermediate summary 가 절대 생성되지 않음.
   * 사용자가 비용/노이즈 이유로 끄고 싶을 때. 기본 true.
   */
  intermediateSummariesEnabled?: boolean;
  /**
   * Final summary 의 default verbosity tier. `finalizeSession(_, { lengthTier })`
   * per-call override가 없을 때 사용. 기본 "medium".
   */
  defaultLengthTier?: SummaryLengthTier;
  /** 세션 상태 변경 시 호출 — 영속화에 사용 */
  onSessionUpdate?: (session: SessionState) => void;
  /**
   * 청크 STT 성공으로 transcript 가 갱신될 때마다 호출 — UI 라이브 업데이트용.
   * transcript 는 현재까지 누적된 전체 세그먼트의 스냅샷.
   */
  onTranscriptUpdate?: (sessionId: string, transcript: TranscriptSegment[]) => void;
  /** STT retry 설정 */
  sttRetryAttempts?: number;
  /** Summary retry 설정 */
  summaryRetryAttempts?: number;
  /** 로그 함수 */
  log?: (message: string, meta?: unknown) => void;
}

// ─── Pipeline ───────────────────────────────────────

export class MeetingPipeline {
  /**
   * factory 기반 모드: 첫 ingest 시 per-session 으로 provider 를 해석.
   * factory 가 없으면 construction time 에 고정된 instance 를 사용 (하위 호환).
   */
  private readonly sttProviderFactory:
    | ((ctx: { sessionId: string; signal: AbortSignal }) => SttProvider | Promise<SttProvider>)
    | undefined;
  private readonly _sttProviderInstance: SttProvider | undefined;
  private readonly sttProviderBySession = new Map<string, SttProvider>();
  private readonly pendingSttProviderBySession = new Map<string, Promise<SttProvider>>();
  private readonly abortBySession = new Map<string, AbortController>();
  private ensureAbortController(sessionId: string): AbortController {
    let controller = this.abortBySession.get(sessionId);
    if (!controller) {
      controller = new AbortController();
      this.abortBySession.set(sessionId, controller);
    }
    return controller;
  }
  private async resolveSttProvider(sessionId: string): Promise<SttProvider> {
    const cached = this.sttProviderBySession.get(sessionId);
    if (cached) return cached;
    if (this.sttProviderFactory) {
      const pending = this.pendingSttProviderBySession.get(sessionId);
      if (pending) return pending;
      const controller = this.ensureAbortController(sessionId);
      const resolving = Promise.resolve().then(async () => {
        if (controller.signal.aborted) throw new Error("Meeting STT session aborted");
        const provider = await this.sttProviderFactory!({ sessionId, signal: controller.signal });
        if (controller.signal.aborted) throw new Error("Meeting STT session aborted");
        this.sttProviderBySession.set(sessionId, provider);
        return provider;
      }).finally(() => {
        if (this.pendingSttProviderBySession.get(sessionId) === resolving) {
          this.pendingSttProviderBySession.delete(sessionId);
        }
      });
      this.pendingSttProviderBySession.set(sessionId, resolving);
      return resolving;
    }
    if (this._sttProviderInstance) return this._sttProviderInstance;
    throw new Error("MeetingPipeline: sttProvider 또는 sttProviderFactory 가 필요합니다");
  }
  /**
   * Synchronous accessor — used by non-ingest paths (e.g. capability check
   * for transcribeFile). Throws if a factory-mode provider hasn't been
   * resolved yet. Most callers should use {@link resolveSttProvider}.
   */
  private get sttProvider(): SttProvider {
    if (this._sttProviderInstance) return this._sttProviderInstance;
    throw new Error("MeetingPipeline: sttProvider 가 instance 모드가 아닙니다");
  }
  /**
   * Aborts the session's in-flight STT fetch (if any) and releases the
   * key handle owned by hostPlugin via the AbortSignal listener.
   */
  abortSession(sessionId: string): void {
    const controller = this.abortBySession.get(sessionId);
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
    this.abortBySession.delete(sessionId);
    this.sttProviderBySession.delete(sessionId);
  }
  /** Drain a resolution that was already in flight when this session closed. */
  async abortSessionAndWait(sessionId: string): Promise<void> {
    const pending = this.pendingSttProviderBySession.get(sessionId);
    this.abortSession(sessionId);
    if (pending) await pending.catch(() => {});
  }
  private readonly summaryProvider: SummaryProvider;
  private readonly intermediateEveryFinalSegments: number;
  private readonly intermediateMinIntervalMs: number;
  private readonly uploadIntermediateSummaryBudget: number;
  private readonly intermediateSummariesEnabled: boolean;
  private readonly defaultLengthTier: SummaryLengthTier;
  private readonly lastIntermediateAt = new Map<string, number>();
  private readonly uploadIntermediateSummaryAttempts = new Map<string, number>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly onSessionUpdate?: (session: SessionState) => void;
  private readonly onTranscriptUpdate?: (sessionId: string, transcript: TranscriptSegment[]) => void;
  private readonly sttRetryAttempts: number;
  private readonly summaryRetryAttempts: number;
  private readonly log: (message: string, meta?: unknown) => void;

  constructor(options: MeetingPipelineOptions) {
    if (!options.sttProviderFactory && !options.sttProvider) {
      throw new Error("MeetingPipeline: sttProvider 또는 sttProviderFactory 중 하나가 필요합니다");
    }
    this.sttProviderFactory = options.sttProviderFactory;
    this._sttProviderInstance = options.sttProvider;
    this.summaryProvider = options.summaryProvider;
    this.intermediateEveryFinalSegments = Math.max(1, options.intermediateEveryFinalSegments ?? 6);
    this.intermediateMinIntervalMs = Math.max(0, options.intermediateMinIntervalMs ?? 60_000);
    this.uploadIntermediateSummaryBudget = Math.max(
      0,
      Math.floor(options.uploadIntermediateSummaryBudget ?? 8),
    );
    this.intermediateSummariesEnabled = options.intermediateSummariesEnabled !== false;
    this.defaultLengthTier = options.defaultLengthTier ?? "medium";
    this.onSessionUpdate = options.onSessionUpdate;
    this.onTranscriptUpdate = options.onTranscriptUpdate;
    this.sttRetryAttempts = options.sttRetryAttempts ?? 3;
    this.summaryRetryAttempts = options.summaryRetryAttempts ?? 2;
    this.log = options.log ?? console.log.bind(console, "[meeting-pipeline]");
  }

  startSession(sessionId: string, context?: MeetingContext): void {
    if (this.sessions.has(sessionId)) return;
    const now = new Date().toISOString();
    const session: SessionState = {
      sessionId,
      context,
      transcript: [],
      intermediateSummaries: [],
      finalized: false,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(sessionId, session);
    this.persistSession(session);
  }

  /** 외부에서 세션 복원 (크래시 복구) */
  restoreSession(session: SessionState): void {
    if (!this.sessions.has(session.sessionId)) {
      this.sessions.set(session.sessionId, session);
    }
    // Repopulate the in-memory throttle floor from persisted state so
    // a session recovered mid-recording doesn't immediately trigger an
    // intermediate summary that would breach the host callLlm rate
    // window (the prior pipeline instance had already burned the
    // budget for the last few minutes).
    const lastSummary =
      session.intermediateSummaries[session.intermediateSummaries.length - 1];
    if (lastSummary) {
      const lastAt = Date.parse(lastSummary.data.createdAt);
      if (Number.isFinite(lastAt)) {
        this.lastIntermediateAt.set(session.sessionId, lastAt);
      }
    }
  }

  getTranscript(sessionId: string): TranscriptSegment[] {
    return [...this.requireSession(sessionId).transcript];
  }

  getIntermediateSummaries(sessionId: string) {
    return this.requireSession(sessionId).intermediateSummaries.map((x) => x.data);
  }

  getSession(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  async ingestAudioChunk(
    sessionId: string,
    chunk: { pcm16leMono: Buffer; sampleRate: number; startSec: number; endSec: number },
  ): Promise<IngestResult> {
    const session = this.requireSession(sessionId);
    this.assertNotFinalized(session);

    // STT with retry (P1-2). Resolve the per-session provider lazily on
    // first ingest so the host's resolveApiKey + AbortSignal contract is
    // attached to all in-flight Whisper fetches for THIS session.
    const controller = this.ensureAbortController(sessionId);
    const sttProvider = await this.resolveSttProvider(sessionId);
    if (controller.signal.aborted) throw new Error("Meeting STT session aborted");
    const segments = await withRetry(
      () => sttProvider.transcribeChunk({ sessionId, ...chunk }),
        {
          maxAttempts: this.sttRetryAttempts,
          baseDelayMs: 1000,
          signal: controller.signal,
          onRetry: (attempt, error, delay) => {
          this.log(`STT retry ${attempt}: ${error.message}, waiting ${delay}ms`);
        },
      },
    );

    const normalized = this.normalizeSegments(sessionId, segments);
    // 슬라이딩 윈도우 오버랩에 의한 중복 텍스트 제거 + 문장 경계 병합
    const baseIndex = session.transcript.length;
    const deduped = this.deduplicateAndMerge(session.transcript, normalized);
    session.transcript.push(...deduped);
    session.updatedAt = new Date().toISOString();

    // 청크 STT 성공 → UI 라이브 업데이트 신호 (Summary 실패 전에 emit 해야 청크당 1회 보장)
    this.fireTranscriptUpdate(session);

    // Summary 실패 격리: ingest 성공과 독립적으로 처리 (claw-code 패턴)
    let intermediateSummary: IntermediateSummary | undefined;
    try {
      intermediateSummary = (await this.maybeCreateIntermediateSummary(session, {
        signal: controller.signal,
      })) ?? undefined;
    } catch (err) {
      this.log("intermediate summary failed (non-blocking)", err);
      // Summary 실패해도 ingest는 성공 — 트랜스크립트 데이터 보존
    }

    this.persistSession(session);

    return { sessionId, addedSegments: deduped, baseIndex, intermediateSummary };
  }

  async ingestTranscriptSegments(
    sessionId: string,
    segments: TranscriptSegment[],
  ): Promise<IngestResult> {
    const session = this.requireSession(sessionId);
    this.assertNotFinalized(session);
    const normalized = this.normalizeSegments(sessionId, segments);
    const baseIndex = session.transcript.length;
    session.transcript.push(...normalized);
    session.updatedAt = new Date().toISOString();

    let intermediateSummary: IntermediateSummary | undefined;
    try {
      intermediateSummary = (await this.maybeCreateIntermediateSummary(session, {
        signal: this.ensureAbortController(sessionId).signal,
      })) ?? undefined;
    } catch (err) {
      this.log("intermediate summary failed (non-blocking)", err);
    }

    this.persistSession(session);
    return { sessionId, addedSegments: normalized, baseIndex, intermediateSummary };
  }

  /**
   * Batch upload path — transcribes a complete audio/video file in one shot
   * via SttProvider.transcribeFile and pushes results through the standard
   * ingest pipeline. No PCM streaming, no chunk dedup. Throws if the
   * configured STT provider does not implement transcribeFile.
   */
  async ingestAudioFile(
    sessionId: string,
    file: Omit<AudioFileInput, "sessionId">,
  ): Promise<IngestResult> {
    const session = this.requireSession(sessionId);
    this.assertNotFinalized(session);

    const controller = this.ensureAbortController(sessionId);
    const sttProvider = await this.resolveSttProvider(sessionId);
    if (controller.signal.aborted) throw new Error("Meeting STT session aborted");
    if (typeof sttProvider.transcribeFile !== "function") {
      throw new Error("Configured STT provider does not support file uploads");
    }

    const segments = await withRetry(
      () => sttProvider.transcribeFile!({ sessionId, ...file }),
        {
          maxAttempts: this.sttRetryAttempts,
          baseDelayMs: 2000,
          signal: controller.signal,
          onRetry: (attempt, error, delay) => {
          this.log(`STT file upload retry ${attempt}: ${error.message}, waiting ${delay}ms`);
        },
      },
    );

    // Ingest in intermediateEveryFinalSegments-sized batches so the upload
    // path can still produce a bounded set of intermediate summaries. Uploads
    // are processed back-to-back, so applying the live wall-clock throttle
    // would make intermediate summaries depend on CPU/network timing. Instead
    // we sample evenly across this file and enforce a per-session upload
    // budget, reserving host callLlm capacity for the final summary.
    const normalized = this.normalizeSegments(sessionId, segments);
    const baseIndex = session.transcript.length;
    const batchSize = Math.max(1, this.intermediateEveryFinalSegments);
    const totalBatches = Math.max(1, Math.ceil(normalized.length / batchSize));
    const maxSummariesForFile = Math.min(
      totalBatches,
      this.remainingUploadIntermediateSummaryBudget(sessionId),
    );
    let attemptedForFile = 0;
    let lastIntermediate: IntermediateSummary | undefined;
    for (let i = 0, batchNumber = 1; i < normalized.length; i += batchSize, batchNumber += 1) {
      const batch = normalized.slice(i, i + batchSize);
      session.transcript.push(...batch);
      session.updatedAt = new Date().toISOString();
      const nextCheckpoint = maxSummariesForFile > 0
        ? Math.ceil(((attemptedForFile + 1) * totalBatches) / maxSummariesForFile)
        : Number.POSITIVE_INFINITY;

      if (
        this.intermediateSummariesEnabled &&
        attemptedForFile < maxSummariesForFile &&
        batchNumber >= nextCheckpoint &&
        this.hasEnoughSegmentsForIntermediate(session) &&
        this.consumeUploadIntermediateSummaryBudget(sessionId)
      ) {
        attemptedForFile += 1;
        try {
          const summary = await this.maybeCreateIntermediateSummary(session, {
            bypassThrottle: true,
            signal: controller.signal,
          });
          if (summary) lastIntermediate = summary;
        } catch (err) {
          this.log("intermediate summary failed (non-blocking)", err);
        }
      }
      this.persistSession(session);
    }

    return {
      sessionId,
      addedSegments: normalized,
      baseIndex,
      intermediateSummary: lastIntermediate,
    };
  }

  async finalizeSession(sessionId: string, opts?: { lengthTier?: SummaryLengthTier; signal?: AbortSignal }): Promise<FinalSummary> {
    const session = this.requireSession(sessionId);
    this.assertNotFinalized(session);

    // Resolve tier — per-call > pipeline default. Persisted onto the
    // returned FinalSummary by the provider for UI display + audit.
    const lengthTier = opts?.lengthTier ?? this.defaultLengthTier;

    // 40분 초과 회의는 전체 transcript 대신 누적된 intermediateSummaries 로
    // 최종 요약 — 토큰/비용 절감. 임계값 이하이거나 intermediate 가 없으면
    // 기존 전체 transcript 경로. provider/타입 변경 없이 합성된
    // TranscriptSegment[] 로 주입해 prompt 빌더가 그대로 동작하게 함.
    const LONG_MEETING_THRESHOLD_SEC = 40 * 60;
    const lastSeg = session.transcript[session.transcript.length - 1];
    const totalDurationSec = lastSeg?.endSec ?? 0;
    const useIntermediateOnly =
      totalDurationSec > LONG_MEETING_THRESHOLD_SEC &&
      session.intermediateSummaries.length > 0;
    const transcriptForFinal: TranscriptSegment[] = useIntermediateOnly
      ? session.intermediateSummaries.map((s, i, arr) => ({
          id: `intermediate-${i}`,
          speaker: "중간요약",
          original: s.data.summary,
          startSec: (i / arr.length) * totalDurationSec,
          endSec: ((i + 1) / arr.length) * totalDurationSec,
          isFinal: true,
          source: "batch" as const,
          createdAt: new Date().toISOString(),
        }))
      : [...session.transcript];

    // Final summary with retry
    try {
      const result = await withRetry(
        () => this.summaryProvider.summarizeFinal(
          {
            sessionId,
            transcript: transcriptForFinal,
            context: session.context,
          },
          { lengthTier, signal: opts?.signal },
        ),
        {
          maxAttempts: this.summaryRetryAttempts,
          baseDelayMs: 2000,
          signal: opts?.signal,
          onRetry: (attempt, error, delay) => {
            this.log(`final summary retry ${attempt}: ${error.message}, waiting ${delay}ms`);
          },
        },
      );

      session.finalized = true;
      session.updatedAt = new Date().toISOString();
      this.persistSession(session);
      return result;
    } finally {
      // A failed or cancelled summary still ends this STT lease. The session
      // transcript remains available for a summary retry or regeneration.
      this.abortSession(sessionId);
    }
  }

  resetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.lastIntermediateAt.delete(sessionId);
    this.uploadIntermediateSummaryAttempts.delete(sessionId);
    this.abortSession(sessionId);
  }

  // ─── Private ──────────────────────────────────────

  private async maybeCreateIntermediateSummary(
    session: SessionState,
    opts?: { bypassThrottle?: boolean; signal?: AbortSignal },
  ): Promise<IntermediateSummary | null> {
    // Master switch — user can disable intermediate summaries entirely via
    // configSchema.intermediateSummariesEnabled (e.g. cost minimisation, or
    // when the live-update card is more noise than signal for short meetings).
    if (!this.intermediateSummariesEnabled) return null;

    if (!this.hasEnoughSegmentsForIntermediate(session)) return null;

    // Time-based throttle: skip if last intermediate ran too recently.
    // Host callLlm enforces a global rate window (default 600s / 20 calls) that
    // we easily trip when meetings stream dozens of 5-second chunks. Combining
    // a segment-count gate with a wall-clock floor keeps us safely under it.
    //
    // bypassThrottle is used by ingestAudioFile (batch upload analysis) where
    // wall-clock spacing has no UX meaning — the audio is a finished
    // recording so multiple intermediates produced back-to-back is the
    // intended behaviour (matches streaming cadence after the fact).
    if (
      !opts?.bypassThrottle &&
      this.intermediateMinIntervalMs > 0 &&
      Date.now() - (this.lastIntermediateAt.get(session.sessionId) ?? 0) <
        this.intermediateMinIntervalMs
    ) {
      return null;
    }

    const summary = await withRetry(
      () => this.summaryProvider.summarizeIntermediate(
        {
          sessionId: session.sessionId,
          transcript: [...session.transcript],
          context: session.context,
        },
        { signal: opts?.signal },
      ),
      {
        maxAttempts: this.summaryRetryAttempts,
        baseDelayMs: 1500,
        signal: opts?.signal,
        onRetry: (attempt, error, delay) => {
          this.log(`intermediate summary retry ${attempt}: ${error.message}, waiting ${delay}ms`);
        },
      },
    );

    session.intermediateSummaries.push({
      coveredSegmentCount: this.finalizedSegmentCount(session),
      data: summary,
    });
    this.lastIntermediateAt.set(session.sessionId, Date.now());
    return summary;
  }

  private remainingUploadIntermediateSummaryBudget(sessionId: string): number {
    const used = this.uploadIntermediateSummaryAttempts.get(sessionId) ?? 0;
    return Math.max(0, this.uploadIntermediateSummaryBudget - used);
  }

  private consumeUploadIntermediateSummaryBudget(sessionId: string): boolean {
    const remaining = this.remainingUploadIntermediateSummaryBudget(sessionId);
    if (remaining <= 0) return false;
    const used = this.uploadIntermediateSummaryAttempts.get(sessionId) ?? 0;
    this.uploadIntermediateSummaryAttempts.set(sessionId, used + 1);
    return true;
  }

  private hasEnoughSegmentsForIntermediate(session: SessionState): boolean {
    const finalizedCount = this.finalizedSegmentCount(session);
    const lastCoveredCount =
      session.intermediateSummaries[session.intermediateSummaries.length - 1]?.coveredSegmentCount ?? 0;
    return finalizedCount - lastCoveredCount >= this.intermediateEveryFinalSegments;
  }

  private finalizedSegmentCount(session: SessionState): number {
    return session.transcript.filter((s) => s.isFinal).length;
  }

  private fireTranscriptUpdate(session: SessionState): void {
    try {
      this.onTranscriptUpdate?.(session.sessionId, [...session.transcript]);
    } catch (err) {
      this.log("onTranscriptUpdate failed (non-blocking)", err);
    }
  }

  private persistSession(session: SessionState): void {
    try {
      this.onSessionUpdate?.(session);
    } catch (err) {
      this.log("session persist failed (non-blocking)", err);
    }
  }

  /**
   * 슬라이딩 윈도우 오버랩에 의한 중복 제거 + 문장 경계 병합
   *
   * Distil-Whisper LCS 패턴 적용:
   * 1. 새 세그먼트의 시작 단어들이 기존 마지막 세그먼트의 끝 단어들과 겹치면 제거
   * 2. 기존 마지막 세그먼트가 문장 중간에서 잘렸으면 새 세그먼트와 병합
   */
  private deduplicateAndMerge(
    existing: TranscriptSegment[],
    incoming: TranscriptSegment[],
  ): TranscriptSegment[] {
    if (incoming.length === 0) return [];
    if (existing.length === 0) return incoming;

    const lastExisting = existing[existing.length - 1];
    if (!lastExisting) return incoming;

    const result: TranscriptSegment[] = [];
    const lastWords = tokenizeWords(lastExisting.original);

    for (const seg of incoming) {
      const segWords = tokenizeWords(seg.original);

      // 1. LCS 기반 오버랩 제거: 기존 마지막 세그먼트의 끝 N단어와 새 세그먼트의 처음 N단어 비교
      const overlapLen = findSuffixPrefixOverlap(lastWords, segWords);

      let cleanedText: string;
      if (overlapLen > 0) {
        cleanedText = segWords.slice(overlapLen).join(" ");
        if (!cleanedText.trim()) continue; // 완전 중복 → 스킵
      } else {
        cleanedText = seg.original;
      }

      // 2. 문장 경계 병합: 텍스트 오버랩이 실제로 감지된 경우에만 병합
      // (타임스탬프 오버랩만으로는 병합하지 않음 — 슬라이딩 윈도우에서 새 텍스트가 손실됨)
      const hasTimeOverlap = seg.startSec < lastExisting.endSec;
      if (
        result.length === 0 &&
        overlapLen > 0 &&
        hasTimeOverlap &&
        !isSentenceEnd(lastExisting.original) &&
        lastExisting.speaker === seg.speaker
      ) {
        lastExisting.original = `${lastExisting.original} ${cleanedText}`.trim();
        lastExisting.endSec = seg.endSec;
        continue;
      }

      result.push({ ...seg, original: cleanedText.trim() });
    }

    return result.filter((s) => s.original.length > 0);
  }

  private normalizeSegments(sessionId: string, segments: TranscriptSegment[]): TranscriptSegment[] {
    return segments.map((segment, index) => ({
      ...segment,
      id: segment.id || `${sessionId}-${Math.round(segment.startSec * 1000)}-${Math.round(segment.endSec * 1000)}-${index}`,
      createdAt: segment.createdAt || new Date().toISOString(),
      source: segment.source ?? "streaming",
    }));
  }

  private requireSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }

  private assertNotFinalized(session: SessionState): void {
    if (session.finalized) throw new Error(`Session already finalized: ${session.sessionId}`);
  }
}

// ─── Deduplication Helpers ─────────────────────────

/** 텍스트를 단어 단위로 분리 (한국어/영어 공통) */
function tokenizeWords(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/**
 * suffix-prefix 오버랩 길이 계산 (LCS 변형)
 * a의 끝 N단어가 b의 처음 N단어와 일치하는 최대 N을 반환
 */
function findSuffixPrefixOverlap(a: string[], b: string[]): number {
  const maxCheck = Math.min(a.length, b.length, 8); // 최대 8단어까지 비교
  for (let len = maxCheck; len >= 2; len--) {
    const suffix = a.slice(-len);
    const prefix = b.slice(0, len);
    if (suffix.every((w, i) => normalize(w) === normalize(prefix[i] ?? ""))) {
      return len;
    }
  }
  return 0;
}

/** 비교용 정규화: 소문자 + 구두점 제거 */
function normalize(word: string): string {
  return word.toLowerCase().replace(/[.,!?;:'"()]/g, "");
}

/** 문장 종결 판정 (한국어 종결어미 + 영어 문장부호) */
function isSentenceEnd(text: string): boolean {
  const trimmed = text.trim();
  // 영어 문장부호
  if (/[.!?]$/.test(trimmed)) return true;
  // 한국어 종결어미 패턴
  if (/(?:니다|세요|어요|아요|습니다|합니다|됩니다|입니다|해요|네요|군요|거든요|잖아요|ㄴ다|는다|였다|했다|이다)\.?$/.test(trimmed)) return true;
  return false;
}
