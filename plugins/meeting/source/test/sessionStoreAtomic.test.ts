/**
 * SessionStore — atomic write semantics.
 *
 * save() is on the hot path (called from MeetingPipeline.persistSession on
 * every chunk, every intermediate summary, and finalize). Pre-fix it wrote
 * JSON.stringify(session) directly over the live file, so a crash/power loss
 * mid-write left truncated JSON that load()/listUnfinished()/listFinished()
 * silently dropped — total loss of a multi-hour transcript + summary. This
 * test pins the tmp-sibling + renameSync semantics: an interrupted write
 * leaves the previous good file intact and never leaves a torn .tmp behind.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type PersistedSession } from "../src/persistence/sessionStore.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "session-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeSession(id: string, overrides: Partial<PersistedSession> = {}): PersistedSession {
  const now = new Date().toISOString();
  return {
    sessionId: id,
    transcript: [],
    intermediateSummaries: [],
    finalized: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("SessionStore — atomic write", () => {
  it("save + load round-trips through disk", () => {
    const s = new SessionStore(dir);
    s.save(makeSession("alpha", { category: "standup" }));
    const re = new SessionStore(dir);
    const loaded = re.load("alpha");
    expect(loaded?.sessionId).toBe("alpha");
    expect(loaded?.category).toBe("standup");
  });

  it("does NOT leave a .tmp file behind after a successful write", () => {
    const s = new SessionStore(dir);
    s.save(makeSession("x"));
    expect(existsSync(join(dir, "x.json"))).toBe(true);
    expect(existsSync(join(dir, "x.json.tmp"))).toBe(false);
  });

  it("an interrupted write leaves the previous good file intact and rethrows", () => {
    const s = new SessionStore(dir);
    // Seed a known-good session on disk.
    const good = makeSession("sess", { category: "kept", finalized: true });
    s.save(good);
    const beforeBytes = readFileSync(join(dir, "sess.json"), "utf-8");

    // Force JSON.stringify to throw mid-save (a circular reference is the
    // simplest interruption that exercises the error path before the
    // renameSync onto the live file can happen).
    const torn = makeSession("sess", { category: "corrupt-attempt" }) as PersistedSession & {
      self?: unknown;
    };
    torn.self = torn; // circular → JSON.stringify throws

    expect(() => s.save(torn)).toThrow();

    // The previous good file must be byte-identical (never overwritten).
    const afterBytes = readFileSync(join(dir, "sess.json"), "utf-8");
    expect(afterBytes).toBe(beforeBytes);
    const reloaded = new SessionStore(dir).load("sess");
    expect(reloaded?.category).toBe("kept");
    expect(reloaded?.finalized).toBe(true);
  });

  it("leaves no torn .tmp file after a failed write", () => {
    const s = new SessionStore(dir);
    s.save(makeSession("sess"));

    const torn = makeSession("sess") as PersistedSession & { self?: unknown };
    torn.self = torn;
    expect(() => s.save(torn)).toThrow();

    // No leftover *.tmp sibling — cleanup unlinked it on the error path.
    const stray = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(stray).toEqual([]);
    // And the .tmp is invisible to the listing helpers (filtered by .json).
    expect(existsSync(join(dir, "sess.json.tmp"))).toBe(false);
  });

  it("a torn .tmp from a crashed prior run is ignored by load/list (never the live file)", () => {
    // Seed a good file + a corrupt leftover tmp as a crashed prior write would.
    const s = new SessionStore(dir);
    s.save(makeSession("sess", { finalized: false, category: "live" }));
    writeFileSync(join(dir, "sess.json.tmp"), "{ truncated json", "utf-8");

    const re = new SessionStore(dir);
    // load reads the real .json, not the .tmp.
    expect(re.load("sess")?.category).toBe("live");
    // listUnfinished only globs *.json, so the torn .tmp can't poison it.
    const unfinished = re.listUnfinished();
    expect(unfinished).toHaveLength(1);
    expect(unfinished[0]?.sessionId).toBe("sess");
  });
});
