/**
 * Retry with exponential backoff — STT/Summary API 호출 안정성
 */
export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const baseDelay = options?.baseDelayMs ?? 1000;
  const maxDelay = options?.maxDelayMs ?? 10000;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfAborted(options?.signal);
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (options?.signal?.aborted || isAbortError(lastError)) {
        throw lastError;
      }

      if (attempt >= maxAttempts) break;

      // Rate limit (429) → longer wait
      const isRateLimit = lastError.message.includes("429");
      const delay = Math.min(
        maxDelay,
        baseDelay * Math.pow(2, attempt - 1) * (isRateLimit ? 3 : 1),
      );

      options?.onRetry?.(attempt, lastError, delay);
      await sleep(delay, options?.signal);
    }
  }

  throw lastError!;
}

function isAbortError(error: Error): boolean {
  return error.name === "AbortError" || /\babort(?:ed)?\b/i.test(error.message);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("operation aborted");
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("operation aborted"));
      return;
    }
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(new Error("operation aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
