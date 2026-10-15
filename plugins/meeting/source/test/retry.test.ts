import { describe, expect, it, vi } from "vitest";
import { withRetry } from "../src/utils/retry";

describe("withRetry", () => {
  it("does not retry abort errors", async () => {
    const fn = vi.fn(async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });

    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toThrow("aborted");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("aborts retry sleep immediately", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce("ok");
    const retrying = withRetry(fn, {
      maxAttempts: 2,
      baseDelayMs: 10_000,
      signal: controller.signal,
    });

    await Promise.resolve();
    controller.abort();
    await expect(retrying).rejects.toThrow("operation aborted");
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
