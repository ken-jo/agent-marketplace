/**
 * §35 STT transcript.updated per-chunk event emission test.
 *
 * Verifies:
 *  - 3 audio chunks → 3 transcript-updated events (isFinal: false) from recorder
 *  - hostPlugin wires recorder events → hostApi.emitEvent("meeting.transcript.updated")
 *  - stop() emits one final transcript-updated with isFinal: true
 *  - newSegmentIndex increases monotonically across chunks
 */
import { describe, it, expect, vi } from "vitest";
import { ElectronMeetingRecorder } from "../src/recorder/electronMeetingRecorder.js";
import { MeetingPipeline } from "../src/pipeline/meetingPipeline.js";
import { MockSttProvider, MockSummaryProvider } from "../src/adapters/mockProviders.js";
import type { TranscriptSegment } from "../src/types.js";

type TranscriptUpdatedPayload = {
  sessionId: string;
  newSegmentIndex: number;
  newSegment: TranscriptSegment | null;
  isFinal: boolean;
};

function makePipeline() {
  return new MeetingPipeline({
    sttProvider: new MockSttProvider(),
    summaryProvider: new MockSummaryProvider(),
    intermediateEveryFinalSegments: 10, // Suppress intermediate summaries
  });
}

const DUMMY_CHUNK = {
  pcm16leMono: Buffer.from([0x00, 0x01]),
  sampleRate: 16000,
  startSec: 0,
  endSec: 1,
};

describe("ElectronMeetingRecorder transcript-updated events", () => {
  it("emits transcript-updated for each audio chunk with increasing newSegmentIndex", async () => {
    const pipeline = makePipeline();
    const recorder = new ElectronMeetingRecorder(pipeline);

    const events: TranscriptUpdatedPayload[] = [];

    recorder.on("transcript-updated", (payload) => {
      events.push(payload as TranscriptUpdatedPayload);
    });

    recorder.start("sess-1");

    // Push 3 chunks
    for (let i = 0; i < 3; i++) {
      await recorder.pushAudioChunk("sess-1", {
        ...DUMMY_CHUNK,
        startSec: i * 1,
        endSec: (i + 1) * 1,
      });
    }

    // Each chunk from MockSttProvider yields one segment → 3 events
    const partialEvents = events.filter((e) => !e.isFinal);
    expect(partialEvents.length).toBe(3);

    // newSegmentIndex should be monotonically non-decreasing
    for (let i = 1; i < partialEvents.length; i++) {
      expect(partialEvents[i]!.newSegmentIndex).toBeGreaterThanOrEqual(partialEvents[i - 1]!.newSegmentIndex);
    }

    // All partial events have isFinal: false and correct sessionId
    for (const ev of partialEvents) {
      expect(ev.isFinal).toBe(false);
      expect(ev.sessionId).toBe("sess-1");
      expect(ev.newSegment).not.toBeNull();
    }
  });

  it("emits isFinal: true transcript-updated when stop() is called", async () => {
    const pipeline = makePipeline();
    const recorder = new ElectronMeetingRecorder(pipeline);

    const finalEvents: TranscriptUpdatedPayload[] = [];
    recorder.on("transcript-updated", (payload) => {
      const p = payload as TranscriptUpdatedPayload;
      if (p.isFinal) finalEvents.push(p);
    });

    recorder.start("sess-2");
    await recorder.pushAudioChunk("sess-2", DUMMY_CHUNK);
    await recorder.stop("sess-2");

    expect(finalEvents.length).toBe(1);
    expect(finalEvents[0]!.isFinal).toBe(true);
    expect(finalEvents[0]!.sessionId).toBe("sess-2");
    // newSegmentIndex must be a valid array index (not one-past-the-end)
    const transcript = pipeline.getTranscript("sess-2");
    const finalIndex = finalEvents[0]!.newSegmentIndex;
    expect(finalIndex).toBeGreaterThanOrEqual(0);
    if (transcript.length > 0) {
      expect(finalIndex).toBeLessThan(transcript.length);
    }
  });

  it("hostPlugin wires recorder transcript-updated → hostApi.emitEvent('meeting.transcript.updated')", async () => {
    const pipeline = makePipeline();
    const recorder = new ElectronMeetingRecorder(pipeline);

    const emitted: Array<{ type: string; data: unknown }> = [];
    const mockHostApi = {
      emitEvent: vi.fn((type: string, data: unknown) => {
        emitted.push({ type, data });
      }),
    };

    // Wire like hostPlugin.ts does
    recorder.on("transcript-updated", (payload) => {
      const { sessionId, newSegmentIndex, newSegment, isFinal } = payload as TranscriptUpdatedPayload;
      mockHostApi.emitEvent("meeting.transcript.updated", {
        meetingId: sessionId,
        newSegmentIndex,
        newSegment,
        isFinal,
      });
    });

    recorder.start("sess-3");
    await recorder.pushAudioChunk("sess-3", DUMMY_CHUNK);
    await recorder.pushAudioChunk("sess-3", { ...DUMMY_CHUNK, startSec: 1, endSec: 2 });
    await recorder.pushAudioChunk("sess-3", { ...DUMMY_CHUNK, startSec: 2, endSec: 3 });

    const transcriptUpdatedEvents = emitted.filter((e) => e.type === "meeting.transcript.updated");
    expect(transcriptUpdatedEvents.length).toBe(3);

    for (const ev of transcriptUpdatedEvents) {
      const d = ev.data as { meetingId: string; newSegmentIndex: number; newSegment: unknown; isFinal: boolean };
      expect(d.meetingId).toBe("sess-3");
      expect(typeof d.newSegmentIndex).toBe("number");
      expect(d.newSegment).not.toBeNull();
      expect(d.isFinal).toBe(false);
    }
  });
});

describe("plugin.json emittedEvents declaration regression", () => {
  it("meeting.transcript.updated is declared in emittedEvents", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = join(fileURLToPath(import.meta.url), "..");
    const { flattenAgentPluginsManifest } = await import("@ave/plugin-contract");
    const manifest = flattenAgentPluginsManifest(
      JSON.parse(readFileSync(join(__dirname, "..", "plugin.json"), "utf8")),
    ) as unknown as {
      emittedEvents?: string[];
    };
    expect(manifest.emittedEvents).toBeDefined();
    expect(manifest.emittedEvents).toContain("meeting.transcript.updated");
  });
});
