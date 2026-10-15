/**
 * Sprint 4-B: push_chunk rate limiter unit test.
 *
 * Validates per-session token-bucket semantics for the meeting_push_chunk
 * hardening:
 *   - allows up to maxCalls within windowMs (per session)
 *   - rejects calls beyond the threshold
 *   - recovers once the window slides past old timestamps
 *   - two sessions do NOT share a bucket (M2 fix — previous version was
 *     process-wide and let one window starve another)
 *   - forget() reclaims the per-session entry so the map can't grow
 *     unbounded across long-lived plugin instances
 */
import { describe, it, expect } from "vitest";
import { PushChunkRateLimiter, PUSH_CHUNK_LIMITS } from "../src/hostPlugin.js";

describe("PushChunkRateLimiter", () => {
  it("allows up to maxCalls within the window", () => {
    let now = 1_000_000;
    const limiter = new PushChunkRateLimiter(10_000, 30, () => now);
    for (let i = 0; i < 30; i++) {
      expect(limiter.tryAcquire("session-a")).toBe(true);
    }
    expect(limiter.tryAcquire("session-a")).toBe(false);
  });

  it("recovers after the window slides past", () => {
    let now = 1_000_000;
    const limiter = new PushChunkRateLimiter(10_000, 3, () => now);
    expect(limiter.tryAcquire("session-a")).toBe(true);
    expect(limiter.tryAcquire("session-a")).toBe(true);
    expect(limiter.tryAcquire("session-a")).toBe(true);
    expect(limiter.tryAcquire("session-a")).toBe(false);
    now += 11_000;
    expect(limiter.tryAcquire("session-a")).toBe(true);
  });

  it("does not share buckets across sessions", () => {
    let now = 1_000_000;
    const limiter = new PushChunkRateLimiter(10_000, 3, () => now);
    // Exhaust session A.
    expect(limiter.tryAcquire("session-a")).toBe(true);
    expect(limiter.tryAcquire("session-a")).toBe(true);
    expect(limiter.tryAcquire("session-a")).toBe(true);
    expect(limiter.tryAcquire("session-a")).toBe(false);
    // Session B still has its full budget.
    expect(limiter.tryAcquire("session-b")).toBe(true);
    expect(limiter.tryAcquire("session-b")).toBe(true);
    expect(limiter.tryAcquire("session-b")).toBe(true);
    expect(limiter.tryAcquire("session-b")).toBe(false);
  });

  it("forget() clears a session's bucket so it can immediately reacquire", () => {
    let now = 1_000_000;
    const limiter = new PushChunkRateLimiter(10_000, 2, () => now);
    expect(limiter.tryAcquire("session-a")).toBe(true);
    expect(limiter.tryAcquire("session-a")).toBe(true);
    expect(limiter.tryAcquire("session-a")).toBe(false);
    limiter.forget("session-a");
    expect(limiter.tryAcquire("session-a")).toBe(true);
  });

  it("exposes the canonical 30/10s + 10MB contract", () => {
    expect(PUSH_CHUNK_LIMITS.maxCalls).toBe(30);
    expect(PUSH_CHUNK_LIMITS.windowMs).toBe(10_000);
    expect(PUSH_CHUNK_LIMITS.maxBytes).toBe(10 * 1024 * 1024);
  });
});
