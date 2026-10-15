/**
 * IndexState 스모크 테스트
 *
 * 실제 파일 I/O는 tmpdir를 사용하고, 상태 전이(idle→indexing→complete)를
 * addEntry / getEntry / findStale / findOrphans / removeEntry 로 검증.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { IndexState } from "../src/indexState";

// ─── 픽스처 ──────────────────────────────────────────

let dir: string;
let statePath: string;
let state: IndexState;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ave-indexstate-"));
  statePath = join(dir, "index-state.json");
  state = new IndexState(statePath);
});

afterEach(async () => {
  await rm(dir, { recursive: true });
});

// ─── 테스트 ──────────────────────────────────────────

describe("IndexState", () => {
  it("초기 상태: 항목 없음 (idle)", async () => {
    expect(await state.size()).toBe(0);
    expect(await state.getEntry("/any/path.md")).toBeUndefined();
  });

  it("addEntry → getEntry: 항목 저장 및 조회 (indexing)", async () => {
    await state.addEntry("/docs/a.pdf", "doc-1", 1_000_000, "hash-abc");

    const entry = await state.getEntry("/docs/a.pdf");
    expect(entry).toBeDefined();
    expect(entry?.docId).toBe("doc-1");
    expect(entry?.mtimeMs).toBe(1_000_000);
    expect(entry?.chunkHash).toBe("hash-abc");
    expect(entry?.indexedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("addEntry 여러 번 → 최신 값으로 덮어쓰기 (complete)", async () => {
    await state.addEntry("/docs/a.pdf", "doc-1", 1_000_000, "hash-v1");
    await state.addEntry("/docs/a.pdf", "doc-1", 2_000_000, "hash-v2");

    const entry = await state.getEntry("/docs/a.pdf");
    expect(entry?.mtimeMs).toBe(2_000_000);
    expect(entry?.chunkHash).toBe("hash-v2");
    expect(await state.size()).toBe(1);
  });

  it("findStale: mtime이 커진 파일만 반환", async () => {
    await state.addEntry("/docs/a.pdf", "doc-1", 1000, "h1");
    await state.addEntry("/docs/b.pdf", "doc-2", 2000, "h2");

    const currentMtimes = new Map([
      ["/docs/a.pdf", 9999],
      ["/docs/b.pdf", 2000],
    ]);

    const stale = await state.findStale(currentMtimes);
    expect(stale).toContain("/docs/a.pdf");
    expect(stale).not.toContain("/docs/b.pdf");
  });

  it("findOrphans: 디스크에 없는 경로만 반환", async () => {
    await state.addEntry("/docs/exists.pdf", "doc-1", 1000, "h1");
    await state.addEntry("/docs/deleted.pdf", "doc-2", 1000, "h2");

    const existingPaths = new Set(["/docs/exists.pdf"]);
    const orphans = await state.findOrphans(existingPaths);

    expect(orphans).toContain("/docs/deleted.pdf");
    expect(orphans).not.toContain("/docs/exists.pdf");
  });

  it("removeEntry: 항목 삭제 후 조회 불가", async () => {
    await state.addEntry("/docs/a.pdf", "doc-1", 1000, "h1");
    expect(await state.size()).toBe(1);

    await state.removeEntry("/docs/a.pdf");
    expect(await state.size()).toBe(0);
    expect(await state.getEntry("/docs/a.pdf")).toBeUndefined();
  });

  it("영속화: 새 IndexState 인스턴스로 재로드 후 데이터 보존", async () => {
    await state.addEntry("/docs/persist.md", "doc-persist", 5000, "hash-p");

    const state2 = new IndexState(statePath);
    const entry = await state2.getEntry("/docs/persist.md");
    expect(entry?.docId).toBe("doc-persist");
    expect(entry?.mtimeMs).toBe(5000);
  });

  it("존재하지 않는 파일 경로 → 빈 상태로 시작", async () => {
    const noFile = new IndexState(join(dir, "nonexistent.json"));
    expect(await noFile.size()).toBe(0);
  });
});
