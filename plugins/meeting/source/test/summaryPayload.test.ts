/**
 * Sprint 4-D T2 — meeting.summary.created payload enrichment.
 *
 * Locks the contract: the recorder's `final-summary` event carries
 * startedAt/endedAt/durationMs/participants so the calendar plugin can
 * correlate against an Outlook event (±15min window).
 */
import { describe, it, expect } from "vitest";
import { MeetingPipeline } from "../src/pipeline/meetingPipeline.js";
import { ElectronMeetingRecorder } from "../src/recorder/electronMeetingRecorder.js";
import { MockSttProvider, MockSummaryProvider } from "../src/adapters/mockProviders.js";

function makeRecorder(): ElectronMeetingRecorder {
  const pipeline = new MeetingPipeline({
    sttProvider: new MockSttProvider(),
    summaryProvider: new MockSummaryProvider(),
    log: () => {},
  });
  return new ElectronMeetingRecorder(pipeline);
}

describe("final-summary event (Sprint 4-D T2)", () => {
  it("emits startedAt, endedAt, durationMs, and participants", async () => {
    const recorder = makeRecorder();
    const received: unknown[] = [];
    recorder.on("final-summary", (payload) => received.push(payload));

    const sessionId = "test-4d-t2";
    recorder.start(sessionId, { participants: ["alice", "bob"] });
    // small delay so durationMs > 0
    await new Promise((r) => setTimeout(r, 10));
    await recorder.stop(sessionId);

    expect(received).toHaveLength(1);
    const p = received[0] as Record<string, unknown>;
    expect(p.sessionId).toBe(sessionId);
    expect(typeof p.title).toBe("string");
    expect(typeof p.summary).toBe("string");
    expect(Array.isArray(p.highlights)).toBe(true);
    expect(Array.isArray(p.actionItems)).toBe(true);
    // New fields:
    expect(typeof p.startedAt).toBe("string");
    expect(typeof p.endedAt).toBe("string");
    expect(typeof p.durationMs).toBe("number");
    expect(p.durationMs as number).toBeGreaterThanOrEqual(0);
    expect(p.participants).toEqual(["alice", "bob"]);
    // startedAt <= endedAt
    expect(new Date(p.startedAt as string).getTime()).toBeLessThanOrEqual(
      new Date(p.endedAt as string).getTime(),
    );
  });

  it("participants is undefined when context has none", async () => {
    const recorder = makeRecorder();
    const received: unknown[] = [];
    recorder.on("final-summary", (payload) => received.push(payload));

    const sessionId = "test-4d-t2-no-ctx";
    recorder.start(sessionId);
    await recorder.stop(sessionId);

    const p = received[0] as Record<string, unknown>;
    expect(p.participants).toBeUndefined();
  });
});
