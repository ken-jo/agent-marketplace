/**
 * PrepStore — file-size cap, per-store entry cap, atomic write.
 * Pre-fix: a tampered/truncated preps.json silently reset to empty;
 * concurrent bulkUpsert during a crash could leave a corrupt half-written
 * file that the next read silently dropped. This test exercises the
 * size cap (refuse oversize), the entry cap (5000 max with newest-wins
 * eviction), and the atomic write semantics (failure mid-write does not
 * destroy the previous good content).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrepStore } from "../src/persistence/prepStore.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prep-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("PrepStore — atomic write", () => {
  it("upsert + list round-trips through disk", () => {
    const s = new PrepStore(dir);
    s.upsert({ id: "a", title: "Alpha", scheduledStart: "2026-01-01T00:00:00Z" });
    s.upsert({ id: "b", title: "Beta", scheduledStart: "2026-01-02T00:00:00Z" });
    const re = new PrepStore(dir);
    const list = re.list();
    expect(list).toHaveLength(2);
    expect(list.find((x) => x.id === "a")?.title).toBe("Alpha");
  });

  it("does NOT leave a .tmp file behind after a successful write", () => {
    const s = new PrepStore(dir);
    s.upsert({ id: "x", title: "x" });
    expect(existsSync(join(dir, "preps.json"))).toBe(true);
    expect(existsSync(join(dir, "preps.json.tmp"))).toBe(false);
  });

  it("preserves prior content when a tmp file exists from a crashed prior run", () => {
    // Seed a good preps.json
    const path = join(dir, "preps.json");
    writeFileSync(
      path,
      JSON.stringify({ preps: [{ id: "kept", title: "kept" }] }, null, 2),
      "utf-8",
    );
    // Simulate a crashed previous write that left a corrupt tmp behind.
    writeFileSync(join(dir, "preps.json.tmp"), "{ truncated json", "utf-8");
    // New store instance loads the GOOD file (rename-on-write means the
    // previous good content was never overwritten).
    const s = new PrepStore(dir);
    const list = s.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("kept");
  });
});

describe("PrepStore — size + entry cap", () => {
  it("refuses to load a >10MB preps.json (returns empty rather than throw)", () => {
    const path = join(dir, "preps.json");
    // Pad with 11MB of whitespace inside a valid JSON wrapper.
    const padded = `{ "preps": [], "_pad": "${"a".repeat(11 * 1024 * 1024)}" }`;
    writeFileSync(path, padded, "utf-8");
    const s = new PrepStore(dir);
    expect(s.list()).toHaveLength(0);
  });

  it("caps store at 5000 entries, evicting OLDEST scheduledStart on overflow", () => {
    const s = new PrepStore(dir);
    // Insert 5005 entries with monotonically increasing scheduledStart so
    // we can predict which 5 get evicted.
    const items = [];
    for (let i = 0; i < 5005; i++) {
      const yyyy = 2026 + Math.floor(i / 12);
      const mm = String((i % 12) + 1).padStart(2, "0");
      items.push({
        id: `b-${String(i).padStart(5, "0")}`,
        title: `meeting ${i}`,
        scheduledStart: `${yyyy}-${mm}-01T00:00:00Z`,
      });
    }
    s.bulkUpsert(items);
    const list = s.list();
    expect(list.length).toBeLessThanOrEqual(5000);
    // Earliest 5 (lowest i = oldest scheduledStart) should have been
    // evicted. Verify ids 00000–00004 are NOT present.
    const ids = new Set(list.map((b) => b.id));
    for (let i = 0; i < 5; i++) {
      expect(ids.has(`b-${String(i).padStart(5, "0")}`)).toBe(false);
    }
    // Newest entry should be present.
    expect(ids.has("b-05004")).toBe(true);
  });

  it("protects current bulkUpsert batch from eviction even when batch entries are oldest", () => {
    // Pre-fill store with 4999 newer entries — one slot left under the cap.
    const s = new PrepStore(dir);
    const existing = Array.from({ length: 4999 }, (_, i) => ({
      id: `pre-${String(i).padStart(5, "0")}`,
      title: `pre ${i}`,
      // Far-future scheduledStart so these would normally win the eviction
      // sort against an older incoming batch.
      scheduledStart: `2099-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
    }));
    s.bulkUpsert(existing);
    expect(s.list()).toHaveLength(4999);

    // Now bulkUpsert a batch of 10 entries with OLDER scheduledStart that,
    // under the previous "sort all by newest, trim to MAX" eviction, would
    // be the first to drop. Pre-fix: bulkUpsert returns 10 ids, but only
    // 1 survives in storage (the new ids the caller trusted are gone).
    const incoming = Array.from({ length: 10 }, (_, i) => ({
      id: `new-${i}`,
      title: `new ${i}`,
      scheduledStart: `1990-01-01T00:0${i}:00Z`, // older than every existing entry
    }));
    const ids = s.bulkUpsert(incoming);

    // All incoming entries are protected, so they must be retained AND
    // returned — even though they are the oldest in the store.
    expect(ids).toEqual(incoming.map((b) => b.id));
    const persistedIds = new Set(s.list().map((b) => b.id));
    for (const id of ids) {
      expect(persistedIds.has(id)).toBe(true);
    }
    // Store stays under the cap; the overflow came out of the older
    // pool by dropping non-batch entries.
    expect(s.list().length).toBeLessThanOrEqual(5000);
  });

  it("returns only persisted ids when the batch itself overflows MAX_PREPS", () => {
    // 5005 batch items — within-batch eviction must drop the 5 oldest,
    // and the returned ids must reflect what is actually persisted.
    const s = new PrepStore(dir);
    const items = Array.from({ length: 5005 }, (_, i) => ({
      id: `b-${String(i).padStart(5, "0")}`,
      title: `m ${i}`,
      scheduledStart: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
    }));
    // Older items get smaller scheduledStart so the first 5 are evicted.
    items.sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart));
    const ids = s.bulkUpsert(items);
    const persistedIds = new Set(s.list().map((b) => b.id));
    // Every returned id must be persisted (no phantom ids).
    for (const id of ids) {
      expect(persistedIds.has(id)).toBe(true);
    }
    // Filtered down to exactly MAX_PREPS.
    expect(ids.length).toBe(5000);
    expect(s.list().length).toBe(5000);
  });

  it("file on disk reflects the same trimmed state (write applied the cap)", () => {
    const s = new PrepStore(dir);
    const items = Array.from({ length: 5500 }, (_, i) => ({
      id: `n-${i}`,
      title: `m${i}`,
      scheduledStart: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
    }));
    s.bulkUpsert(items);
    const raw = JSON.parse(readFileSync(join(dir, "preps.json"), "utf-8")) as {
      preps: Array<{ id: string }>;
    };
    expect(raw.preps.length).toBeLessThanOrEqual(5000);
  });
});

describe("PrepStore — corrupt-file resilience", () => {
  it("treats invalid JSON as empty (does not throw at load)", () => {
    writeFileSync(join(dir, "preps.json"), "{ broken json", "utf-8");
    const s = new PrepStore(dir);
    expect(s.list()).toHaveLength(0);
  });

  it("filters out entries with missing/invalid id", () => {
    writeFileSync(
      join(dir, "preps.json"),
      JSON.stringify({
        preps: [
          { id: "ok-1", title: "good" },
          { title: "no-id" },
          { id: 42 as unknown as string, title: "non-string-id" },
          { id: "../bad", title: "bad-string-id" },
          { id: "ok-2", title: "good2" },
        ],
      }),
      "utf-8",
    );
    const s = new PrepStore(dir);
    const list = s.list();
    expect(list).toHaveLength(2);
    expect(list.map((b) => b.id).sort()).toEqual(["ok-1", "ok-2"]);
  });

  it("normalizes loaded entries through the same prep validator used on write", () => {
    writeFileSync(
      join(dir, "preps.json"),
      JSON.stringify({
        preps: [
          {
            id: "ok-1",
            title: "a".repeat(700),
            participants: ["alice", { name: "object participant" }, "bob"],
            scheduledStart: "not-a-date",
            conference: {
              type: "teams",
              joinUrl: "file:///tmp/meeting",
              accessCode: "1234",
            },
          },
        ],
      }),
      "utf-8",
    );
    const s = new PrepStore(dir);
    const [loaded] = s.list();
    expect(loaded).toBeDefined();
    if (!loaded) throw new Error("expected normalized prep to load");
    expect(loaded.id).toBe("ok-1");
    expect(loaded.title).toHaveLength(500);
    expect(loaded.participants).toEqual(["alice", "bob"]);
    expect(loaded.scheduledStart).toBeUndefined();
    expect(loaded.conference).toEqual({
      type: "teams",
      joinUrl: "",
      accessCode: "1234",
    });
  });
});

describe("PrepStore — write produces non-zero file", () => {
  it("does not silently truncate when caller stops a single upsert", () => {
    const s = new PrepStore(dir);
    s.upsert({ id: "z", title: "ok" });
    const size = statSync(join(dir, "preps.json")).size;
    expect(size).toBeGreaterThan(20);
  });
});
