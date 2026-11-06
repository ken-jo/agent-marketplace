import { describe, it, expect } from "vitest";
import { createErrorConsumer, shouldRefreshView } from "../src/ui/viewUpdates.js";

const change = (kind: string) => ({ changes: [{ kind }] });

describe("sidebar background updates", () => {
  it("refreshes only the views affected by a change kind", () => {
    expect(shouldRefreshView(change("meeting.prep.registered"), { view: "pre-meeting" })).toBe(true);
    expect(shouldRefreshView(change("meeting.prep.registered"), { view: "sessions" })).toBe(false);
    expect(shouldRefreshView(change("meeting.transcript.updated"), { view: "sessions" })).toBe(false);
    expect(shouldRefreshView(change("meeting.transcript.updated"), { view: "session-detail", detailTab: "summary" })).toBe(false);
    expect(shouldRefreshView(change("meeting.transcript.updated"), { view: "session-detail", detailTab: "transcript" })).toBe(true);
    expect(shouldRefreshView(change("meeting.summary.created"), { view: "sessions" })).toBe(true);
    expect(shouldRefreshView(change("meeting.error"), { view: "pre-meeting" })).toBe(false);
    expect(shouldRefreshView(change("settings"), { view: "session-detail", detailTab: "summary" })).toBe(false);
    expect(shouldRefreshView({ reset: true, changes: [] }, { view: "sessions" })).toBe(true);
    expect(shouldRefreshView({ reset: true, changes: [] }, { view: "instant" })).toBe(false);
  });

  it("never replaces an open or dirty edit even for relevant changes and resets", () => {
    for (const result of [change("meeting.summary.created"), change("meeting.ended"), { reset: true, changes: [] }]) {
      expect(shouldRefreshView(result, { view: "session-detail", editing: true })).toBe(false);
      expect(shouldRefreshView(result, { view: "session-detail", dirty: true })).toBe(false);
    }
  });

  it("acknowledges each error sequence once across later unrelated changes", () => {
    const consume = createErrorConsumer();
    expect(consume(null)).toBe(false);
    expect(consume({ sequence: 1 })).toBe(true);
    for (const _kind of ["settings", "categories", "meeting.summary.created", "meeting.transcript.updated"]) {
      expect(consume({ sequence: 1 })).toBe(false);
    }
    expect(consume({ sequence: 2 })).toBe(true);
    expect(consume({ sequence: 1 })).toBe(false);
    expect(consume({ sequence: 2 })).toBe(false);
  });
});
