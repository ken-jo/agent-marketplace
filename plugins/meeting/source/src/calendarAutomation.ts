import { createHash } from "node:crypto";
import type { PluginStorage } from "@ave/plugin-contract";
import type { MeetingContext } from "./index.js";

/**
 * A calendar row as meeting's own automation sees it. `id` is the automation
 * identity, never the raw Graph id: work-assistant derived
 * `mscal-<stableHash(Graph id)>` for every row it relayed, stored preps under
 * that id and named recordings `wa-<stableHash(automation id)>`. Meeting keeps
 * the same derivation (plugin-alerts design, "Calendar automation,
 * plugin-owned"), so preps and recordings work-assistant registered before its
 * retirement keep their identities under meeting's own subscriptions.
 */
export interface CalendarAutomationEvent {
  id: string;
  subject: string;
  start: string;
  end: string;
  isAllDay?: boolean;
  location?: string;
  bodyText?: string;
  organizer?: { name?: string; address?: string };
  attendees?: Array<{ name?: string; address?: string; status?: string }>;
  webLink?: string;
  isOnlineMeeting?: boolean;
  onlineMeetingUrl?: string;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const asString = (value: unknown): string => typeof value === "string" ? value.trim() : "";

export const stableHash = (value: string): string =>
  createHash("sha256").update(value).digest("base64url").slice(0, 24);

/** The id work-assistant gave a row: its Graph id, or subject|start|end when it has none. */
export function calendarAutomationId(rawId: string, subject: string, start: string, end: string): string {
  return `mscal-${stableHash(rawId || `${subject}|${start}|${end}`)}`;
}

/** The recording session work-assistant asked for at a meeting's start. */
export const calendarRecordingSessionId = (automationId: string): string => `wa-${stableHash(automationId)}`;

function asOrganizer(value: unknown): CalendarAutomationEvent["organizer"] {
  const record = asRecord(value);
  if (!record) return undefined;
  const name = asString(record.name);
  const address = asString(record.address);
  if (!name && !address) return undefined;
  return { ...(name ? { name } : {}), ...(address ? { address } : {}) };
}

function asAttendees(value: unknown): CalendarAutomationEvent["attendees"] {
  if (!Array.isArray(value)) return undefined;
  const attendees = value.flatMap((item) => {
    const attendee = asRecord(item);
    if (!attendee) return [];
    const name = asString(attendee.name);
    const address = asString(attendee.address);
    const status = asString(attendee.status);
    if (!name && !address) return [];
    return [{ ...(name ? { name } : {}), ...(address ? { address } : {}), ...(status ? { status } : {}) }];
  });
  return attendees.length > 0 ? attendees : undefined;
}

/** An ms-graph calendar row, normalised as work-assistant's `asCalendarAutomationEvent` did. */
export function asCalendarAutomationEvent(value: unknown): CalendarAutomationEvent | null {
  const event = asRecord(value);
  if (!event) return null;
  const subject = asString(event.subject) || asString(event.title);
  const start = asString(event.start) || asString(event.scheduledStart);
  const end = asString(event.end) || asString(event.scheduledEnd);
  if (!subject || !start || !end) return null;
  if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))) return null;
  return {
    id: calendarAutomationId(asString(event.id), subject, start, end),
    subject,
    start,
    end,
    ...(typeof event.isAllDay === "boolean" ? { isAllDay: event.isAllDay } : {}),
    ...(asString(event.location) ? { location: asString(event.location) } : {}),
    ...((asString(event.bodyText) || asString(event.description)) ? { bodyText: asString(event.bodyText) || asString(event.description) } : {}),
    ...(asOrganizer(event.organizer) ? { organizer: asOrganizer(event.organizer) } : {}),
    ...(asAttendees(event.attendees) ? { attendees: asAttendees(event.attendees) } : {}),
    ...(asString(event.webLink) ? { webLink: asString(event.webLink) } : {}),
    ...(typeof event.isOnlineMeeting === "boolean" ? { isOnlineMeeting: event.isOnlineMeeting } : {}),
    ...(asString(event.onlineMeetingUrl) ? { onlineMeetingUrl: asString(event.onlineMeetingUrl) } : {}),
  };
}

function isRecordable(event: CalendarAutomationEvent, nowMs: number): boolean {
  if (event.isAllDay) return false;
  return Date.parse(event.end) > nowMs;
}

function inferConferenceType(url: string): "webex" | "zoom" | "teams" | "other" {
  const lower = url.toLowerCase();
  if (lower.includes("webex.")) return "webex";
  if (lower.includes("zoom.")) return "zoom";
  if (lower.includes("teams.microsoft.") || lower.includes("/meetup-join/")) return "teams";
  return "other";
}

export function meetingContextForCalendar(event: CalendarAutomationEvent): MeetingContext {
  const conference = event.onlineMeetingUrl
    ? { type: inferConferenceType(event.onlineMeetingUrl), joinUrl: event.onlineMeetingUrl }
    : event.webLink && event.isOnlineMeeting === true
      ? { type: "other" as const, joinUrl: event.webLink }
      : undefined;
  return {
    id: event.id,
    title: event.subject,
    scheduledStart: event.start,
    scheduledEnd: event.end,
    category: "일반",
    ...(event.location ? { location: event.location } : {}),
    ...(event.bodyText ? { description: event.bodyText } : {}),
    ...(event.organizer ? { organizer: event.organizer.name || event.organizer.address } : {}),
    ...(event.attendees ? { participants: event.attendees.map((a) => a.name || a.address).filter((v): v is string => !!v) } : {}),
    ...(conference ? { conference } : {}),
  };
}

/** The row work-assistant used to put on `work_assistant.calendar.sync.requested`. */
export function rowForRegistration(event: CalendarAutomationEvent): Record<string, unknown> {
  return { ...event, category: "일반" };
}

/** What the claims need of the plugin's storage HostApi. */
export type CalendarClaimStorage = Pick<PluginStorage, "readJson" | "writeJson">;

/** Claims file under the plugin data dir. */
export const CALENDAR_CLAIMS_FILE = "calendar-automation-claims.json";

/** A claim outlives the end of its meeting by this much, then expires. */
export const CALENDAR_CLAIM_GRACE_MS = 60 * 60_000;

type ClaimKind = "prep" | "recording";
const CLAIM_KINDS: readonly ClaimKind[] = ["prep", "recording"];

interface CalendarClaimsFile {
  version: 1;
  /** Automation id → epoch ms at which the claim expires. */
  prep: Record<string, number>;
  recording: Record<string, number>;
}

/**
 * Which meetings already had their prep opened or their recording started.
 *
 * Kept in the plugin's storage HostApi so a plugin restart does not fire a
 * prep or recording a second time for a meeting still inside its window.
 * Every claim carries an expiry (the meeting's end plus
 * {@link CALENDAR_CLAIM_GRACE_MS}); expired claims are dropped when the
 * claims are restored and on every write, so the file holds only meetings
 * that can still fire.
 *
 * Claims are answered from memory, which {@link restore} fills before any
 * calendar event is handled. Writes are serialized; a failed read or write is
 * reported through `onError` and costs at most one repeated prep after the
 * next restart.
 */
export class CalendarClaims {
  private readonly claims: Record<ClaimKind, Map<string, number>> = { prep: new Map(), recording: new Map() };
  private writes: Promise<void> = Promise.resolve();

  private readonly storage: CalendarClaimStorage;

  constructor(
    storage: CalendarClaimStorage | undefined,
    private readonly onError: (operation: "read" | "write", error: unknown) => void,
    private readonly now: () => number = Date.now,
  ) {
    if (typeof storage?.readJson !== "function" || typeof storage.writeJson !== "function") {
      throw new Error("calendar automation requires the storage HostApi (readJson, writeJson)");
    }
    this.storage = storage;
  }

  async restore(): Promise<void> {
    let file: unknown;
    try {
      file = await this.storage.readJson(CALENDAR_CLAIMS_FILE);
    } catch (error) {
      this.onError("read", error);
      return;
    }
    const record = asRecord(file);
    if (!record) return;
    const nowMs = this.now();
    for (const kind of CLAIM_KINDS) {
      const entries = asRecord(record[kind]);
      if (!entries) continue;
      for (const [id, expiresAt] of Object.entries(entries)) {
        if (id && typeof expiresAt === "number" && expiresAt > nowMs) this.claims[kind].set(id, expiresAt);
      }
    }
  }

  /** Claim `id` until `expiresAt`; false when an unexpired claim already holds it. */
  claim(kind: ClaimKind, id: string, expiresAt: number): boolean {
    const held = this.claims[kind].get(id);
    if (held !== undefined && held > this.now()) return false;
    this.claims[kind].set(id, expiresAt);
    this.persist();
    return true;
  }

  release(kind: ClaimKind, id: string): void {
    if (this.claims[kind].delete(id)) this.persist();
  }

  /** Settles once every write issued so far has finished. */
  flush(): Promise<void> {
    return this.writes;
  }

  private persist(): void {
    const nowMs = this.now();
    const file: CalendarClaimsFile = { version: 1, prep: {}, recording: {} };
    for (const kind of CLAIM_KINDS) {
      for (const [id, expiresAt] of this.claims[kind]) {
        if (expiresAt > nowMs) file[kind][id] = expiresAt;
        else this.claims[kind].delete(id);
      }
    }
    this.writes = this.writes
      .then(() => this.storage.writeJson(CALENDAR_CLAIMS_FILE, file))
      .catch((error: unknown) => this.onError("write", error));
  }
}

/** When a claim for `event` expires. */
const claimExpiry = (event: CalendarAutomationEvent): number => Date.parse(event.end) + CALENDAR_CLAIM_GRACE_MS;

export class CalendarAutomation {
  private readonly timers = new Map<string, { prep?: ReturnType<typeof setTimeout>; start: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly actions: {
      /** Bulk registration of resolved calendar rows. */
      registerRows: (rows: Record<string, unknown>[]) => void;
      openPrep: (context: MeetingContext) => void;
      startRecording: (sessionId: string, context: MeetingContext) => Promise<void>;
    },
    private readonly claims: CalendarClaims,
  ) {}

  /** Claims are keyed by the automation id (`context.id` of the prep). */
  claimPrep(id: string, expiresAt: number): boolean {
    if (!id) return true;
    return this.claims.claim("prep", id, expiresAt);
  }

  releasePrep(id: string): void { if (id) this.claims.release("prep", id); }

  claimRecording(id: string, expiresAt: number): boolean {
    if (!id) return true;
    return this.claims.claim("recording", id, expiresAt);
  }

  releaseRecording(id: string): void { if (id) this.claims.release("recording", id); }

  private recordable(raw: unknown[]): CalendarAutomationEvent[] {
    const nowMs = Date.now();
    return raw.flatMap((value) => {
      const event = asCalendarAutomationEvent(value);
      return event && isRecordable(event, nowMs) ? [event] : [];
    });
  }

  private registerAndSchedule(raw: unknown[]): CalendarAutomationEvent[] {
    const events = this.recordable(raw);
    if (events.length === 0) return events;
    for (const event of events) this.schedule(event);
    this.actions.registerRows(events.map(rowForRegistration));
    return events;
  }

  load(raw: unknown): void {
    if (Array.isArray(raw)) this.registerAndSchedule(raw);
  }

  add(raw: unknown): void {
    this.registerAndSchedule([raw]);
  }

  upcoming(raw: unknown): void {
    for (const event of this.recordable([raw])) this.schedule(event);
  }

  starting(raw: unknown): void {
    for (const event of this.registerAndSchedule([raw])) void this.start(event);
  }

  private prep(event: CalendarAutomationEvent): void {
    if (!this.claimPrep(event.id, claimExpiry(event))) return;
    try { this.actions.openPrep(meetingContextForCalendar(event)); }
    catch { this.releasePrep(event.id); }
  }

  private async start(event: CalendarAutomationEvent): Promise<void> {
    if (!this.claimRecording(event.id, claimExpiry(event))) return;
    try { await this.actions.startRecording(calendarRecordingSessionId(event.id), meetingContextForCalendar(event)); }
    catch { this.releaseRecording(event.id); }
  }

  private schedule(event: CalendarAutomationEvent): void {
    const old = this.timers.get(event.id);
    if (old) { if (old.prep) clearTimeout(old.prep); clearTimeout(old.start); this.timers.delete(event.id); }
    const startMs = Date.parse(event.start);
    if (startMs <= Date.now()) return;
    const prepMs = startMs - 5 * 60_000 - Date.now();
    const prep = prepMs <= 0 ? (this.prep(event), undefined)
      : setTimeout(() => this.prep(event), prepMs);
    const start = setTimeout(() => {
      this.timers.delete(event.id);
      void this.start(event);
    }, Math.max(0, startMs - Date.now()));
    this.timers.set(event.id, { prep, start });
  }

  stop(): void {
    for (const timer of this.timers.values()) {
      if (timer.prep) clearTimeout(timer.prep);
      clearTimeout(timer.start);
    }
    this.timers.clear();
  }
}
