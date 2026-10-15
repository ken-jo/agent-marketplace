import { EventEmitter } from "node:events";
import type { MeetingContext, SummaryLengthTier, TranscriptSegment } from "../types";
import { MeetingPipeline } from "../pipeline/meetingPipeline";

export interface RecorderEvents {
  segment: (payload: { sessionId: string; count: number }) => void;
  "transcript-updated": (payload: {
    sessionId: string;
    newSegmentIndex: number;
    newSegment: TranscriptSegment | null;
    isFinal: boolean;
  }) => void;
  "intermediate-summary": (payload: { sessionId: string; summary: string }) => void;
  "final-summary": (payload: {
    sessionId: string;
    title: string;
    summary: string;
    highlights: string[];
    actionItems: string[];
    startedAt: string;
    endedAt: string;
    durationMs: number;
    participants?: string[];
    lengthTier?: SummaryLengthTier;
  }) => void;
  error: (payload: { sessionId: string; error: Error }) => void;
}

export class ElectronMeetingRecorder extends EventEmitter {
  constructor(private readonly pipeline: MeetingPipeline) {
    super();
  }

  start(sessionId: string, context?: MeetingContext): void {
    this.pipeline.startSession(sessionId, context);
  }

  async pushAudioChunk(
    sessionId: string,
    chunk: { pcm16leMono: Buffer; sampleRate: number; startSec: number; endSec: number },
  ): Promise<void> {
    try {
      const result = await this.pipeline.ingestAudioChunk(sessionId, chunk);
      this.emit("segment", { sessionId, count: result.addedSegments.length });

      // Emit delta per-chunk: only newSegmentIndex + newSegment (O(1) payload).
      // Use baseIndex (pre-ingest length) to avoid drift if ingestAudioChunk is ever concurrent.
      for (let i = 0; i < result.addedSegments.length; i++) {
        const seg = result.addedSegments[i];
        if (!seg) continue;
        const newSegmentIndex = result.baseIndex + i;
        this.emit("transcript-updated", {
          sessionId,
          newSegmentIndex,
          newSegment: seg,
          isFinal: false,
        });
      }

      if (result.intermediateSummary) {
        this.emit("intermediate-summary", {
          sessionId,
          summary: result.intermediateSummary.summary,
        });
      }
    } catch (error) {
      this.emit("error", { sessionId, error: error as Error });
      throw error;
    }
  }

  async stop(sessionId: string, opts?: { lengthTier?: SummaryLengthTier; signal?: AbortSignal }): Promise<void> {
    try {
      if (opts?.signal?.aborted) throw new Error("meeting stop aborted");
      // Capture session start BEFORE finalize (session may be mutated during summarization).
      const session = this.pipeline.getSession(sessionId);
      const startedAt = session?.createdAt ?? new Date().toISOString();
      const participants = session?.context?.participants;

      // Emit final transcript-updated with isFinal=true before summary.
      // newSegmentIndex points to the last valid segment (length - 1), or 0 for empty transcripts,
      // consistent with delta semantics (never one-past-the-end).
      const finalTranscript = this.pipeline.getTranscript(sessionId);
      const lastSeg = finalTranscript[finalTranscript.length - 1] ?? null;
      this.emit("transcript-updated", {
        sessionId,
        newSegmentIndex: Math.max(0, finalTranscript.length - 1),
        newSegment: lastSeg,
        isFinal: true,
      });

      const finalSummary = await this.pipeline.finalizeSession(sessionId, opts);
      if (opts?.signal?.aborted) throw new Error("meeting stop aborted");
      const endedAt = new Date().toISOString();
      const durationMs = Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime());

      this.emit("final-summary", {
        sessionId,
        title: finalSummary.title,
        summary: finalSummary.summary,
        highlights: finalSummary.highlights ?? [],
        actionItems: finalSummary.actionItems ?? [],
        startedAt,
        endedAt,
        durationMs,
        participants,
        lengthTier: finalSummary.lengthTier,
      });
    } catch (error) {
      this.emit("error", { sessionId, error: error as Error });
      throw error;
    }
  }
}
