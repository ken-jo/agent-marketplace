import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import createPlugin from "../src/hostPlugin.js";

type EventHandler = (payload: unknown) => void;

// work-assistant (0.11.3) registered preps under `mscal-<stableHash(Graph id)>`
// and named recordings `wa-<stableHash(mscal id)>`. Meeting's own calendar path
// keeps that identity, so preps registered before the relay was retired are the
// same entries meeting now registers and claims.
const stableHash = (value: string) => createHash("sha256").update(value).digest("base64url").slice(0, 24);
const automationId = (graphId: string) => `mscal-${stableHash(graphId)}`;

/** The plugin's storage HostApi, rooted at its data dir, as the host provides it. */
function storageAt(root: string) {
  return {
    readJson: async (relPath: string) => {
      try { return JSON.parse(readFileSync(join(root, relPath), "utf8")) as unknown; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    },
    writeJson: async (relPath: string, value: unknown) => {
      writeFileSync(join(root, relPath), JSON.stringify(value, null, 2));
    },
  };
}

async function harness(existingRoot?: string) {
  const root = existingRoot ?? mkdtempSync(join(tmpdir(), "meeting-calendar-dedupe-test-"));
  if (!existingRoot) mkdirSync(join(root, "sessions"));
  const handlers = new Map<string, EventHandler>();
  const emitted: Array<{ type: string; payload: unknown }> = [];
  let attachments = 0;
  let finishAttachment: () => void = () => {};
  const pendingAttachment = new Promise<void>((resolve) => { finishAttachment = resolve; });
  const plugin = await createPlugin({
    pluginId: "meeting", pluginRoot: root, hostRoot: root, pluginDataDir: root, log: () => {},
    hostApi: {
      emitEvent: (type: string, payload?: unknown) => { emitted.push({ type, payload }); },
      onEvent: (type: string, handler: EventHandler) => { handlers.set(type, handler); return () => {}; },
      getSecret: () => null, logEvent: () => {}, onShutdown: () => {},
      storage: storageAt(root),
      config: { get: (key: string) => key === "calendarAutomationEnabled" ? true : undefined, onChange: () => () => {} },
      attachFloatingPanel: async () => {
        attachments++;
        await pendingAttachment;
        return { height: 240, onDetached: () => {}, detach: async () => {} };
      },
    },
  } as never);
  // A calendar provider's Graph event id: base64 with `=`, `+` and `/`.
  const event = {
    id: "AAMkAGI2TG93AAA+test/event=", subject: "Planning", isAllDay: false,
    start: new Date(Date.now() + 4 * 60_000).toISOString(),
    end: new Date(Date.now() + 60 * 60_000).toISOString(),
    bodyText: "Agenda\n- Review the plan",
  };
  const emit = (type: string, payload: unknown) => {
    const handler = handlers.get(type);
    if (!handler) throw new Error(`missing handler for ${type}`);
    handler(payload);
  };
  const of = (type: string) => emitted.filter((entry) => entry.type === type).map((entry) => entry.payload as Record<string, unknown>);
  return {
    root, event, emit, of, hasHandler: (type: string) => handlers.has(type),
    get attachments() { return attachments; },
    /** Stop the plugin as a restart does, keeping its data dir. */
    async stop() {
      finishAttachment();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await plugin.stop?.();
    },
    async close() {
      await this.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const registeredIds = (payloads: Array<Record<string, unknown>>) => new Set(payloads.flatMap((payload) =>
  Array.isArray(payload.ids) ? payload.ids as string[] : typeof payload.id === "string" ? [payload.id] : []));

describe("calendar automation without retired relays", () => {
  it("does not register the three work-assistant relay handlers", async () => {
    const h = await harness();
    try {
      for (const event of [
        "work_assistant.calendar.sync.requested",
        "work_assistant.meeting.prep.requested",
        "work_assistant.meeting.recording.requested",
      ]) expect(h.hasHandler(event), event).toBe(false);
    } finally { await h.close(); }
  });

  it("opens one prep for duplicate calendar events, under work-assistant's identity", async () => {
    const h = await harness();
    try {
      h.emit("calendar.event.upcoming", { event: h.event });
      h.emit("calendar.event.upcoming", { event: h.event });
      expect(h.of("meeting.prep.opened").map((payload) => (payload.context as { id?: string }).id))
        .toEqual([automationId(h.event.id)]);
    } finally { await h.close(); }
  });

  it("does not reopen a prep after a plugin restart inside the 5-minute window", async () => {
    const first = await harness();
    let second: Awaited<ReturnType<typeof harness>> | undefined;
    try {
      first.emit("calendar.event.upcoming", { event: first.event });
      expect(first.of("meeting.prep.opened")).toHaveLength(1);
      await first.stop();
      second = await harness(first.root);
      second.emit("calendar.event.upcoming", { event: first.event });
      expect(second.of("meeting.prep.opened")).toEqual([]);
    } finally {
      if (second) await second.stop();
      rmSync(first.root, { recursive: true, force: true });
    }
  });

  it("requests one panel for duplicate calendar events while attachment is pending", async () => {
    const h = await harness();
    try {
      h.emit("calendar.event.starting", { event: h.event });
      h.emit("calendar.event.starting", { event: h.event });
      expect(h.attachments).toBe(1);
    } finally { await h.close(); }
  });

  it("registers loaded rows under work-assistant's identity", async () => {
    const h = await harness();
    try {
      h.emit("calendar.events.loaded", { events: [h.event], reason: "first-load" });
      expect([...registeredIds(h.of("meeting.prep.registered"))]).toEqual([automationId(h.event.id)]);
    } finally { await h.close(); }
  });

  it("registers a loaded row and the same row added later as one prep", async () => {
    const h = await harness();
    try {
      h.emit("calendar.events.loaded", { events: [h.event], reason: "first-load" });
      h.emit("calendar.event.added", { event: h.event });
      expect([...registeredIds(h.of("meeting.prep.registered"))]).toEqual([automationId(h.event.id)]);
    } finally { await h.close(); }
  });
});
