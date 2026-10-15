/**
 * PrepStore — per-field validation (Sec-H2).
 * Untrusted callers (calendar plugin, agent-hub, manual import) feed into
 * upsert/bulkUpsert; per-field caps + format checks live inside
 * validatePrep so the on-disk record stays bounded and the joinUrl
 * allowlist is enforced before persistence.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrepStore, validatePrep } from "../src/persistence/prepStore.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prep-validate-"));
});

describe("PrepStore getNearest - missing scheduledEnd fallback", () => {
  it("treats a prep without scheduledEnd as in-progress for 1 hour after scheduledStart", () => {
    const s = new PrepStore(dir);
    s.upsert({
      id: "prep-no-end",
      title: "Standup",
      scheduledStart: "2026-05-20T10:00:00.000Z",
    });

    const nearest = s.getNearest(new Date("2026-05-20T10:30:00.000Z"));
    expect(nearest?.id).toBe("prep-no-end");
  });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("validatePrep — id", () => {
  it("rejects an invalid explicit id", () => {
    expect(() => validatePrep({ id: "../../etc/passwd", title: "x" })).toThrow(/invalid prep id/);
  });

  it("rejects an id with NUL bytes", () => {
    expect(() => validatePrep({ id: "ok id", title: "x" })).toThrow();
  });

  it("accepts an id matching the regex", () => {
    const out = validatePrep({ id: "abc-123_XYZ", title: "x" });
    expect(out.id).toBe("abc-123_XYZ");
  });

  it("accepts a missing id (caller relies on derived id)", () => {
    const out = validatePrep({ title: "no-id" });
    expect(out.id).toBeUndefined();
  });
});

describe("validatePrep — string truncation", () => {
  it("truncates an overlong description to 16384 chars", () => {
    const big = "a".repeat(20000);
    const out = validatePrep({ description: big });
    expect(out.description?.length).toBe(16384);
  });

  it("truncates an overlong title to 500 chars", () => {
    const big = "t".repeat(2000);
    const out = validatePrep({ title: big });
    expect(out.title?.length).toBe(500);
  });

  it("truncates previousSummary.summary to 16384 chars", () => {
    const big = "s".repeat(20000);
    const out = validatePrep({ previousSummary: { summary: big } });
    expect(out.previousSummary?.summary.length).toBe(16384);
  });
});

describe("validatePrep — agenda", () => {
  it("caps agenda at 100 items", () => {
    const items = Array.from({ length: 250 }, (_, i) => `item-${i}`);
    const out = validatePrep({ agenda: items });
    expect(out.agenda?.length).toBe(100);
    expect(out.agenda?.[0]).toBe("item-0");
    expect(out.agenda?.[99]).toBe("item-99");
  });

  it("truncates each agenda item to 1024 chars", () => {
    const big = "x".repeat(2000);
    const out = validatePrep({ agenda: [big] });
    expect(out.agenda?.[0]?.length).toBe(1024);
  });
});

describe("validatePrep — conference.joinUrl allowlist", () => {
  it("promotes a legacy top-level webexUrl into conference.joinUrl", () => {
    const out = validatePrep({
      title: "demo",
      webexUrl: "https://example.webex.com/meet/demo",
    });
    expect(out.conference?.type).toBe("webex");
    expect(out.conference?.joinUrl).toBe("https://example.webex.com/meet/demo");
  });

  it("strips a javascript: joinUrl while keeping the rest of the conference object", () => {
    const out = validatePrep({
      title: "demo",
      conference: {
        type: "webex",
        joinUrl: "javascript:alert(1)",
        accessCode: "1234",
      },
    });
    expect(out.conference?.joinUrl).toBe("");
    expect(out.conference?.type).toBe("webex");
    expect(out.conference?.accessCode).toBe("1234");
  });

  it("strips a file: joinUrl", () => {
    const out = validatePrep({
      conference: { type: "zoom", joinUrl: "file:///etc/passwd" },
    });
    expect(out.conference?.joinUrl).toBe("");
  });

  it("preserves an https joinUrl", () => {
    const out = validatePrep({
      conference: { type: "teams", joinUrl: "https://teams.microsoft.com/foo" },
    });
    expect(out.conference?.joinUrl).toBe("https://teams.microsoft.com/foo");
  });

  it("preserves an http joinUrl", () => {
    const out = validatePrep({
      conference: { type: "other", joinUrl: "http://meet.invalid/room" },
    });
    expect(out.conference?.joinUrl).toBe("http://meet.invalid/room");
  });

  it("falls back to type=other on an unknown conference type", () => {
    const out = validatePrep({
      conference: { type: "skype" as unknown as "webex", joinUrl: "https://x.test/m" },
    });
    expect(out.conference?.type).toBe("other");
  });
});

describe("validatePrep — scheduledStart/End", () => {
  it("strips a malformed scheduledStart", () => {
    const out = validatePrep({ scheduledStart: "not-a-date" });
    expect(out.scheduledStart).toBeUndefined();
  });

  it("preserves an ISO scheduledStart", () => {
    const out = validatePrep({ scheduledStart: "2026-05-06T10:00:00Z" });
    expect(out.scheduledStart).toBe("2026-05-06T10:00:00Z");
  });

  it("strips scheduledEnd if it is a non-string", () => {
    const out = validatePrep({ scheduledEnd: 12345 as unknown as string });
    expect(out.scheduledEnd).toBeUndefined();
  });
});

describe("PrepStore — validation integrated into upsert", () => {
  it("upsert rejects an invalid explicit id (does not write)", () => {
    const s = new PrepStore(dir);
    expect(() => s.upsert({ id: "../bad" } as unknown as { id: string })).toThrow();
    expect(s.list()).toHaveLength(0);
  });

  it("upsert truncates oversized fields on the persisted record", () => {
    const s = new PrepStore(dir);
    const big = "z".repeat(20000);
    const id = s.upsert({ id: "ok-1", title: big, description: big });
    const stored = s.get(id);
    expect(stored?.title?.length).toBe(500);
    expect(stored?.description?.length).toBe(16384);
  });

  it("upsert strips a javascript: joinUrl on the persisted record", () => {
    const s = new PrepStore(dir);
    const id = s.upsert({
      id: "ok-2",
      title: "demo",
      conference: { type: "webex", joinUrl: "javascript:alert(1)" },
    });
    const stored = s.get(id);
    expect(stored?.conference?.joinUrl).toBe("");
  });

  it("bulkUpsert applies the agenda cap to every entry", () => {
    const s = new PrepStore(dir);
    s.bulkUpsert([
      { id: "a", agenda: Array.from({ length: 200 }, (_, i) => `i${i}`) },
      { id: "b", agenda: Array.from({ length: 50 }, (_, i) => `j${i}`) },
    ]);
    expect(s.get("a")?.agenda?.length).toBe(100);
    expect(s.get("b")?.agenda?.length).toBe(50);
  });
});

describe("PrepStore — legacy briefings.json migration", () => {
  // v0.4.18 disk format 은 `{ briefings: [...] }`. v0.4.19 의 file rename
  // 만으로는 payload key 가 그대로라서 readMap 이 빈 Map 반환 — v0.4.20 의
  // readMap fallback (`preps ?? briefings`) 까지 통과해야 사용자 데이터 보전.
  it("renames briefings.json to preps.json on first boot and loads data (legacy payload key)", () => {
    const payload = { briefings: [{ id: "abc-1", title: "Legacy Meeting" }] };
    writeFileSync(join(dir, "briefings.json"), JSON.stringify(payload), "utf-8");

    const s = new PrepStore(dir);

    expect(existsSync(join(dir, "preps.json"))).toBe(true);
    expect(existsSync(join(dir, "briefings.json"))).toBe(false);
    expect(s.get("abc-1")?.title).toBe("Legacy Meeting");
  });

  it("writes .prep-migration-done marker and skips rename on second boot", () => {
    const payload = { briefings: [{ id: "abc-2", title: "Legacy 2" }] };
    writeFileSync(join(dir, "briefings.json"), JSON.stringify(payload), "utf-8");

    new PrepStore(dir); // first boot — renames + writes marker
    expect(existsSync(join(dir, ".prep-migration-done"))).toBe(true);

    // Simulate second boot: briefings.json is gone, marker present
    const s2 = new PrepStore(dir);
    expect(s2.get("abc-2")?.title).toBe("Legacy 2");
  });

  it("does not overwrite preps.json when both files exist (preserves the legacy payload key on disk for the briefings.json copy)", () => {
    const legacy = { briefings: [{ id: "old-1", title: "Old" }] };
    const current = { preps: [{ id: "new-1", title: "New" }] };
    writeFileSync(join(dir, "briefings.json"), JSON.stringify(legacy), "utf-8");
    writeFileSync(join(dir, "preps.json"), JSON.stringify(current), "utf-8");

    const s = new PrepStore(dir);

    // preps.json should be untouched; old data preserved
    expect(s.get("new-1")?.title).toBe("New");
    expect(s.get("old-1")).toBeNull();
    // briefings.json still exists (was not moved)
    expect(existsSync(join(dir, "briefings.json"))).toBe(true);
  });

  it("recovers v0.4.19 broken state — preps.json with legacy `briefings` payload + marker present (PR #122 hotfix)", () => {
    // v0.4.19 가 file rename 만 하고 marker 박았는데 payload key 는 그대로
    // legacy 인 *broken* 상태 재현. v0.4.20 의 readMap fallback 으로 자동 복구.
    // fixture 는 단순 {id,title} 만이 아니라 진짜 v0.4.18 disk dump 처럼
    // 캘린더가 채운 풍부 field 보유 — round-trip 시 보전되는지까지 lock.
    const brokenPayload = {
      briefings: [
        {
          id: "broken-1",
          title: "v0.4.19 손실로 보였던 데이터",
          organizer: "alice@example.com",
          participants: ["alice@example.com", "bob@example.com"],
          scheduledStart: "2026-05-20T10:00:00.000Z",
          scheduledEnd: "2026-05-20T11:00:00.000Z",
          agenda: ["주간 회고", "다음 스프린트 계획"],
          conference: {
            type: "webex",
            joinUrl: "https://example.webex.com/meet/abc",
          },
        },
      ],
    };
    writeFileSync(join(dir, "preps.json"), JSON.stringify(brokenPayload), "utf-8");
    writeFileSync(join(dir, ".prep-migration-done"), "", "utf-8");

    const s = new PrepStore(dir);

    // Read fallback 으로 데이터 + 풍부 field 모두 복구
    const recovered = s.get("broken-1");
    expect(recovered?.title).toBe("v0.4.19 손실로 보였던 데이터");
    expect(recovered?.organizer).toBe("alice@example.com");
    expect(recovered?.participants).toEqual(["alice@example.com", "bob@example.com"]);
    expect(recovered?.scheduledStart).toBe("2026-05-20T10:00:00.000Z");
    expect(recovered?.agenda).toEqual(["주간 회고", "다음 스프린트 계획"]);
    expect(recovered?.conference?.joinUrl).toBe("https://example.webex.com/meet/abc");
    expect(s.list().length).toBe(1);

    // 새 entry upsert (write 트리거) → 디스크가 새 key 로 normalize
    s.upsert({ id: "fresh-1", title: "New entry" });
    const onDisk = JSON.parse(readFileSync(join(dir, "preps.json"), "utf-8"));
    expect(onDisk.preps).toBeDefined();
    expect(Array.isArray(onDisk.preps)).toBe(true);
    expect(onDisk.briefings).toBeUndefined();

    // 양쪽 entry 모두 살아있어야 함 (legacy 데이터 보전 + 신규 entry)
    expect(s.get("broken-1")?.title).toBe("v0.4.19 손실로 보였던 데이터");
    expect(s.get("fresh-1")?.title).toBe("New entry");
  });

  it("recovers when marker is absent — v0.4.19 migration died mid-flight (EBUSY) so disk has preps.json with legacy payload but no marker", () => {
    // v0.4.19 의 migrateLegacyFile() 이 marker 쓰기 직전 EBUSY/quota 등으로
    // 죽으면 disk: preps.json 존재 + payload key 는 briefings + marker 부재.
    // 다음 boot 에서는 marker 없으니 migrateLegacyFile 가 다시 진입하지만
    // legacy 원본 (briefings.json) 은 이미 사라진 상태 → migrate 는 no-op.
    // 그러나 readMap fallback 이 직접 preps.json 의 briefings payload 를 살림.
    const brokenPayload = {
      briefings: [{ id: "no-marker-1", title: "marker 없는 broken state" }],
    };
    writeFileSync(join(dir, "preps.json"), JSON.stringify(brokenPayload), "utf-8");
    // 명시: marker 파일 안 만듦
    expect(existsSync(join(dir, ".prep-migration-done"))).toBe(false);

    const s = new PrepStore(dir);

    expect(s.get("no-marker-1")?.title).toBe("marker 없는 broken state");
    // Write 후 normalize 확인
    s.upsert({ id: "fresh-no-marker", title: "After" });
    const onDisk = JSON.parse(readFileSync(join(dir, "preps.json"), "utf-8"));
    expect(onDisk.preps).toBeDefined();
    expect(onDisk.briefings).toBeUndefined();
  });

  it("rejects a briefings.json symlink and skips migration without writing the marker", () => {
    // Plant a symlink at the legacy path — migration must not follow it.
    const targetFile = join(dir, "attacker-target.txt");
    writeFileSync(targetFile, "not json", "utf-8");
    symlinkSync(targetFile, join(dir, "briefings.json"));

    const logCalls: Array<{ level: string; message: string }> = [];
    const logEvent = (level: "info" | "warn" | "error", message: string) => {
      logCalls.push({ level, message });
    };

    // Should not throw and not crash plugin init
    const s = new PrepStore(dir, logEvent);

    // No rename performed
    expect(existsSync(join(dir, "preps.json"))).toBe(false);
    // Symlink still present (was not consumed) — user can clean up manually
    expect(lstatSync(join(dir, "briefings.json")).isSymbolicLink()).toBe(true);
    // Marker NOT written so legitimate later cleanup + re-run can succeed
    expect(existsSync(join(dir, ".prep-migration-done"))).toBe(false);
    // Warn-level log surface for ops visibility
    expect(
      logCalls.some(
        (c) => c.level === "warn" && c.message === "meeting_prep_legacy_file_skipped_not_regular",
      ),
    ).toBe(true);
    expect(s.list()).toEqual([]);
  });
});

describe("PrepStore — delete returns { deleted: boolean }", () => {
  it("delete returns { deleted: true } when the id exists", () => {
    const s = new PrepStore(dir);
    s.upsert({ id: "del-1", title: "To Delete" });
    const result = s.delete("del-1");
    expect(result).toBe(true);
  });

  it("delete returns { deleted: false } for a missing id", () => {
    const s = new PrepStore(dir);
    const result = s.delete("nonexistent");
    expect(result).toBe(false);
  });
});
