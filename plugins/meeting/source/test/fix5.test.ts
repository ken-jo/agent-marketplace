import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import createPlugin from "../src/hostPlugin.js";
import { createErrorConsumer, createPendingChanges, endedSessionToOpen } from "../src/ui/viewUpdates.js";
import { ChangeStream } from "../src/changeStream.js";
import { recorderText } from "../src/ui/recorderI18n.js";
import { diagnostic } from "../src/diagnostic.js";

describe("host-owned meeting defaults", () => {
  it("omitted stop and regeneration tiers use configured long, while explicit choices win", async () => {
    const root = mkdtempSync(join(tmpdir(), "meeting-default-"));
    const callLlm = vi.fn(async () => JSON.stringify({title: "Fixture", summary: "Synthetic summary", highlights: [], actionItems: []}));
    const plugin = await createPlugin({pluginId: "meeting", pluginRoot: root, hostRoot: root, pluginDataDir: root,
      hostApi: {getSecret: () => null, callLlm, config: {get: key => key === "summaryLengthTier" ? "long" : undefined}}});
    try {
      await plugin.handlers.batch_processing_audio({sessionId: "no-tier"});
      expect(await plugin.handlers.meeting_stop({sessionId: "no-tier"})).toMatchObject({lengthTier: "long"});
      await plugin.handlers.batch_processing_audio({sessionId: "explicit", context: {lengthTier: "short"}});
      expect(await plugin.handlers.meeting_stop({sessionId: "explicit"})).toMatchObject({lengthTier: "short"});
      mkdirSync(join(root, "sessions"), {recursive: true});
      writeFileSync(join(root, "sessions", "regenerate.json"), JSON.stringify({sessionId: "regenerate", finalized: true,
        transcript: [{id: "fixture", speaker: "Fixture", original: "Synthetic transcript", startSec: 0, endSec: 1}], intermediateSummaries: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()}));
      expect(await plugin.handlers.meeting_regenerate_summary({sessionId: "regenerate"})).toMatchObject({lengthTier: "long"});
      expect(await plugin.handlers.meeting_regenerate_summary({sessionId: "regenerate", lengthTier: "short"})).toMatchObject({lengthTier: "short"});
    } finally { await plugin.stop(); rmSync(root, {recursive: true, force: true}); }
  });
});

describe("sidebar mount and deferred invalidations", () => {
  it("baselines an old error on each mount and shows only newer sequences", () => {
    const consume = createErrorConsumer({sequence: 8});
    expect(consume({sequence: 8})).toBe(false);
    expect(consume({sequence: 9})).toBe(true);
    expect(consume({sequence: 9})).toBe(false);
    expect(createErrorConsumer({sequence: 9})({sequence: 9})).toBe(false);
  });
  it("flushes skipped changes once when the actual editor renders read mode after save or cancel", () => {
    const source = readFileSync(new URL("../src/ui/meeting-control.mjs", import.meta.url), "utf8");
    const start = source.indexOf("  function render() {", source.indexOf("function buildSummaryCard("));
    const renderSource = source.slice(start, source.indexOf("  function renderToolbar()", start));
    for (const previousMode of ["busy", "edit"]) {
      const pending = createPendingChanges();
      pending.defer({changes: [{kind: "meeting.summary.created"}]});
      pending.defer({changes: [{kind: "meeting.summary.created"}, {kind: "categories"}]});
      const refresh = vi.fn();
      const microtasks: Array<() => void> = [];
      const render = runInNewContext(renderSource + "\nrender", {
        mode: "read", card: {dataset: {summaryMode: previousMode, dirty: "true"}, replaceChildren: () => {}},
        activeMoreDismiss: null, editable: true,
        opts: {onEditClosed: () => { const changes = pending.take(); if (changes) refresh(changes); }},
        queueMicrotask: (callback: () => void) => microtasks.push(callback), renderToolbar: () => {}, renderRead: () => {},
      });
      render(); render();
      microtasks.forEach(callback => callback());
      expect(refresh).toHaveBeenCalledExactlyOnceWith({reset: false, changes: [{kind: "meeting.summary.created"}, {kind: "categories"}]});
      expect(pending.take()).toBeNull();
    }
  });
  it("navigates only for the latest ended session matching the attached recording", () => {
    const first = {kind: "meeting.ended", sessionId: "first"};
    const other = {kind: "meeting.ended", sessionId: "other"};
    expect(endedSessionToOpen({changes: [first]}, "first")).toBe("first");
    expect(endedSessionToOpen({changes: [other]}, "first")).toBeNull();
    expect(endedSessionToOpen({changes: [first, other]}, "first")).toBeNull();
    expect(endedSessionToOpen({reset: true, changes: []}, "first")).toBeNull();
  });
  it("carries only the ended session id, without disclosing event payloads", async () => {
    const stream = new ChangeStream();
    const initial = await stream.wait({cursor: "", waitMs: 0});
    stream.publish("meeting.ended", {sessionId: "fixture", transcript: "private words"});
    expect((await stream.wait({cursor: initial.cursor, waitMs: 0})).changes).toEqual([{kind: "meeting.ended", sessionId: "fixture"}]);
    stream.close();
  });
});

describe("diagnostic and recorder locale contracts", () => {
  it("every literal production diagnostic code passes the code regex", () => {
    const root = new URL("../src/", import.meta.url);
    const files = readdirSync(root, {recursive: true, encoding: "utf8"}).filter(name => /\.(?:ts|mjs|js)$/.test(name));
    const codes = files.flatMap(name => [...readFileSync(new URL(name, root), "utf8").matchAll(/diagnostic(?:\?\.)?\(\s*"(?:info|warn|error)"\s*,\s*"([^"]+)"/g)].map(match => match[1]));
    expect(codes.length).toBeGreaterThan(40);
    for (const code of codes) expect(code).toMatch(/^[a-z][a-z0-9_.]+$/);
  });
  it("stderr diagnostics contain only plugin, level and code", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      diagnostic("warn", "meeting_capture.ingest_failed", {path: "/private/user", text: "private words"});
      expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toEqual({plugin: "meeting", level: "warn", code: "meeting_capture.ingest_failed"});
    } finally { write.mockRestore(); }
  });
  it("localizes unavailable and empty microphone states in ko and en", () => {
    expect(recorderText("ko-KR", "microphonesUnavailable")).toBe("마이크 목록을 불러올 수 없습니다");
    expect(recorderText("ko", "microphonesEmpty")).toBe("마이크를 찾을 수 없습니다");
    expect(recorderText("en", "microphonesUnavailable")).toBe("Microphone list unavailable");
    expect(recorderText("en-US", "microphonesEmpty")).toBe("No microphones found");
  });
});
