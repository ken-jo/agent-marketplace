import { describe, it, expect, vi } from "vitest";
import { ChangeStream } from "../src/changeStream.js";

describe("app change stream", () => {
  it("wakes a wait, delivers ordered invalidations once, and times out without replay", async () => {
    const stream = new ChangeStream();
    let result = await stream.wait({ cursor: "", waitMs: 0 });
    expect(result.reset).toBe(true);
    const pending = stream.wait({ cursor: result.cursor, waitMs: 10000 });
    stream.publish("index.scan.progress", { secret: "not sent" });
    stream.publish("index.warning");
    result = await pending;
    expect(result.changes).toEqual([{ kind: "index.scan.progress" }, { kind: "index.warning" }]);
    expect(await stream.wait({ cursor: result.cursor, waitMs: 1 })).toMatchObject({ changes: [], reset: false });
  });

  it("resets stale, foreign, malformed and future cursors without disclosing payloads", async () => {
    const stream = new ChangeStream();
    const first = await stream.wait({ cursor: "", waitMs: 0 });
    for (let i = 0; i < 300; i++) stream.publish("document.changed");
    for (const cursor of [first.cursor, "foreign:0", first.cursor.replace(/:0$/, ":999999"), first.cursor + "junk"]) {
      expect(await stream.wait({ cursor, waitMs: 10000 })).toMatchObject({ reset: true, changes: [] });
    }
    const fresh = await stream.wait({ cursor: "", waitMs: 0 });
    expect(await new ChangeStream().wait({ cursor: fresh.cursor, waitMs: 0 })).toMatchObject({ reset: true });
  });

  it("caps waits and concurrency and releases outstanding requests on shutdown", async () => {
    const stream = new ChangeStream();
    const { cursor } = await stream.wait({ cursor: "", waitMs: 0 });
    for (const input of [{ cursor, waitMs: -1 }, { cursor, waitMs: 10001 }, { cursor, waitMs: 1.2 }, { cursor: "a".repeat(101), waitMs: 0 }, { cursor, waitMs: 0, other: true }]) {
      await expect(stream.wait(input)).rejects.toThrow();
    }
    const waits = Array.from({ length: 16 }, () => stream.wait({ cursor, waitMs: 10000 }));
    await expect(stream.wait({ cursor, waitMs: 10000 })).rejects.toThrow("Too many");
    stream.close();
    for (const result of await Promise.all(waits)) expect(result.closed).toBe(true);
    expect(await stream.wait({ cursor, waitMs: 10000 })).toMatchObject({ closed: true });
  });
});
