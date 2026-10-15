import { describe, expect, it } from "vitest";
import { summaryReadyAlert } from "../src/alerts/meeting-summary-detector.js";

describe("meeting summary alert", () => {
  it("accepts a finalized flat summary and bounds its slots", () => {
    const alert = summaryReadyAlert({ sessionId: "session-1", title: "Review", summary: "Decisions", highlights: ["x".repeat(200), "second", "third", "fourth"] });
    expect(alert).toEqual({ kind: "summary-ready", key: "session-1", slots: { sessionId: "session-1", title: "Review", highlights: ["x".repeat(100), "second", "third"], actionItems: [] } });
  });

  it("accepts nested finalized summaries and prefers the user's context title", () => {
    expect(summaryReadyAlert({ sessionId: "s2", context: { title: "My meeting" }, finalSummary: { title: "Generated", actionItems: ["Follow up"] } })?.slots)
      .toMatchObject({ title: "My meeting", actionItems: ["Follow up"] });
  });

  it("rejects unsafe ids and empty finalized content", () => {
    expect(summaryReadyAlert({ sessionId: "a.b", summary: "done" })).toBeNull();
    expect(summaryReadyAlert({ sessionId: "s3", title: "Only title", highlights: ["  "] })).toBeNull();
    expect(summaryReadyAlert({ sessionId: "s4" })).toBeNull();
  });
});
