import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CALENDAR_CLAIMS_FILE,
  CALENDAR_CLAIM_GRACE_MS,
  CalendarAutomation,
  CalendarClaims,
  type CalendarClaimStorage,
} from "../src/calendarAutomation.js";
import type { MeetingContext } from "../src/index.js";

const NOW = new Date("2026-09-26T00:00:00Z");
const event = {
  id: "graph-event-1", subject: "Planning",
  start: new Date(NOW.getTime() + 6 * 60_000).toISOString(),
  end: new Date(NOW.getTime() + 66 * 60_000).toISOString(),
  isAllDay: false,
  bodyText: "Agenda\n- Review",
  organizer: { name: "Colleague", address: "c@example.com" },
  attendees: [{ name: "Guest", address: "g@example.com", status: "accepted" }],
};
// work-assistant 0.11.3: `mscal-<stableHash(Graph id)>` for the row, `wa-<stableHash(row id)>` for the session.
const stableHash = (value: string) => createHash("sha256").update(value).digest("base64url").slice(0, 24);
const automationId = `mscal-${stableHash(event.id)}`;

/** The storage HostApi's JSON methods over an in-memory file map. */
function memoryStorage(files = new Map<string, string>()): CalendarClaimStorage & { files: Map<string, string> } {
  return {
    files,
    readJson: async <T>(relPath: string) => (files.has(relPath) ? JSON.parse(files.get(relPath)!) as T : null),
    writeJson: async (relPath: string, value: unknown) => { files.set(relPath, JSON.stringify(value)); },
  };
}

async function automation(storage: CalendarClaimStorage = memoryStorage(), onError = vi.fn()) {
  const registerRows = vi.fn();
  const openPrep = vi.fn();
  const startRecording = vi.fn(async (_sessionId: string, _context: MeetingContext) => {});
  const claims = new CalendarClaims(storage, onError);
  await claims.restore();
  return { registerRows, openPrep, startRecording, claims, onError, automation: new CalendarAutomation({ registerRows, openPrep, startRecording }, claims) };
}

describe("calendar automation", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it("registers the full row and triggers prep then recording once", async () => {
    const { registerRows, openPrep, startRecording, automation: subject } = await automation();
    subject.load([event]);
    expect(registerRows).toHaveBeenCalledWith([expect.objectContaining({
      id: automationId, subject: event.subject, bodyText: event.bodyText, category: "일반",
      organizer: event.organizer, attendees: event.attendees,
    })]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(openPrep).toHaveBeenCalledOnce();
    expect(openPrep.mock.calls[0]?.[0]).toMatchObject({
      id: automationId, title: event.subject, organizer: "Colleague", participants: ["Guest"],
    });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(startRecording).toHaveBeenCalledOnce();
    expect(startRecording.mock.calls[0]?.[0]).toBe(`wa-${stableHash(automationId)}`);
    subject.stop();
  });

  it("derives work-assistant's identity from subject and times when a row has no id", async () => {
    const { registerRows, automation: subject } = await automation();
    const { id: _id, ...withoutId } = event;
    subject.load([withoutId]);
    expect(registerRows.mock.calls[0]?.[0]?.[0]?.id).toBe(`mscal-${stableHash(`${event.subject}|${event.start}|${event.end}`)}`);
    subject.stop();
  });

  it("honors an already claimed prep and recording for the same event", async () => {
    const { openPrep, startRecording, automation: subject } = await automation();
    subject.load([event]);
    // Claims are keyed by the automation id, not the raw Graph id.
    const until = Date.parse(event.end);
    expect(subject.claimPrep(automationId, until)).toBe(true);
    expect(subject.claimRecording(automationId, until)).toBe(true);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(openPrep).not.toHaveBeenCalled();
    expect(startRecording).not.toHaveBeenCalled();
    subject.stop();
  });

  it("registers and records a meeting that is starting", async () => {
    const { registerRows, startRecording, automation: subject } = await automation();
    vi.setSystemTime(new Date(event.start));
    subject.starting(event);
    await vi.advanceTimersByTimeAsync(0);
    expect(registerRows).toHaveBeenCalledOnce();
    expect(startRecording).toHaveBeenCalledOnce();
    subject.stop();
  });

  it("ignores all-day and finished rows", async () => {
    const { registerRows, automation: subject } = await automation();
    subject.load([{ ...event, isAllDay: true }, { ...event, id: "past", end: new Date(NOW.getTime() - 1).toISOString() }]);
    expect(registerRows).not.toHaveBeenCalled();
    subject.stop();
  });

  it("keeps prep and recording claims across a restart until the meeting ends", async () => {
    const storage = memoryStorage();
    const soon = { ...event, start: new Date(NOW.getTime() + 4 * 60_000).toISOString() };
    const first = await automation(storage);
    first.automation.upcoming(soon);
    expect(first.openPrep).toHaveBeenCalledOnce();
    first.automation.stop();
    await first.claims.flush();
    const saved = JSON.parse(storage.files.get(CALENDAR_CLAIMS_FILE)!);
    expect(saved.prep).toEqual({ [automationId]: Date.parse(soon.end) + CALENDAR_CLAIM_GRACE_MS });

    // Restarted inside the 5-minute window: the prep is not opened again,
    // and the recording still starts once at the meeting's start.
    const second = await automation(storage);
    second.automation.upcoming(soon);
    expect(second.openPrep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(second.startRecording).toHaveBeenCalledOnce();
    second.automation.stop();
    await second.claims.flush();

    const third = await automation(storage);
    third.automation.starting(soon);
    await vi.advanceTimersByTimeAsync(0);
    expect(third.startRecording).not.toHaveBeenCalled();
    third.automation.stop();

    // Once the meeting ended and the grace passed, the claims expire and leave the file.
    vi.setSystemTime(Date.parse(soon.end) + CALENDAR_CLAIM_GRACE_MS + 1);
    const later = await automation(storage);
    expect(later.automation.claimPrep(automationId, Date.now() + 60_000)).toBe(true);
    await later.claims.flush();
    expect(JSON.parse(storage.files.get(CALENDAR_CLAIMS_FILE)!).recording).toEqual({});
  });

  it("releases a persisted claim when the prep cannot be opened", async () => {
    const storage = memoryStorage();
    const soon = { ...event, start: new Date(NOW.getTime() + 4 * 60_000).toISOString() };
    const first = await automation(storage);
    first.openPrep.mockImplementation(() => { throw new Error("no panel"); });
    first.automation.upcoming(soon);
    first.automation.stop();
    await first.claims.flush();
    expect(JSON.parse(storage.files.get(CALENDAR_CLAIMS_FILE)!).prep).toEqual({});
    const second = await automation(storage);
    second.automation.upcoming(soon);
    expect(second.openPrep).toHaveBeenCalledOnce();
    second.automation.stop();
  });

  it("reports an unreadable or unwritable claims file and keeps claiming in memory", async () => {
    const storage = memoryStorage(new Map([[CALENDAR_CLAIMS_FILE, "{not json"]]));
    storage.writeJson = async () => { throw new Error("disk full"); };
    const soon = { ...event, start: new Date(NOW.getTime() + 4 * 60_000).toISOString() };
    const subject = await automation(storage);
    subject.automation.upcoming(soon);
    subject.automation.upcoming(soon);
    await subject.claims.flush();
    expect(subject.openPrep).toHaveBeenCalledOnce();
    expect(subject.onError.mock.calls.map(([operation]) => operation)).toEqual(["read", "write"]);
    subject.automation.stop();
  });

  it("refuses to run without the storage HostApi", () => {
    expect(() => new CalendarClaims(undefined, () => {})).toThrow(/storage HostApi/u);
  });
});
