import { describe, expect, it, vi } from "vitest";
import { LruCache } from "../src/lruCache";

describe("LruCache", () => {
  it("기본 get/set 동작", () => {
    const cache = new LruCache<string>({ maxSize: 3 });
    cache.set("a", "hello");
    cache.set("b", "world");
    expect(cache.get("a")).toBe("hello");
    expect(cache.get("b")).toBe("world");
    expect(cache.get("c")).toBeUndefined();
  });

  it("maxSize 초과 시 가장 오래된 항목 제거", () => {
    const cache = new LruCache<number>({ maxSize: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3); // "a" 제거됨
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  it("접근한 항목은 LRU 갱신되어 제거되지 않음", () => {
    const cache = new LruCache<number>({ maxSize: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a"); // "a"를 최근으로 갱신
    cache.set("c", 3); // "b" 제거됨 (가장 오래됨)
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
  });

  it("TTL 만료된 항목 반환 안 함", () => {
    vi.useFakeTimers();
    const cache = new LruCache<string>({ ttlMs: 100 });
    cache.set("k", "v");
    expect(cache.get("k")).toBe("v");

    vi.advanceTimersByTime(150);
    expect(cache.get("k")).toBeUndefined();
    vi.useRealTimers();
  });

  it("invalidate로 prefix 매칭 항목 제거", () => {
    const cache = new LruCache<string>({ maxSize: 10 });
    cache.set("doc1:structure", "s1");
    cache.set("doc1:pages:1-3", "p1");
    cache.set("doc2:structure", "s2");

    cache.invalidate("doc1");
    expect(cache.get("doc1:structure")).toBeUndefined();
    expect(cache.get("doc1:pages:1-3")).toBeUndefined();
    expect(cache.get("doc2:structure")).toBe("s2");
  });

  it("clear로 전체 초기화", () => {
    const cache = new LruCache<number>({ maxSize: 5 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });
});
