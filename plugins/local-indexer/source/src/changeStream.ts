import { randomUUID } from "node:crypto";

/** Per-process invalidations only; domain data stays in the snapshot tools. */
export class ChangeStream {
  private readonly epoch = randomUUID();
  private sequence = 0;
  private readonly history: Array<{ sequence: number; kind: string }> = [];
  private readonly waiting = new Set<() => void>();
  private closed = false;

  publish(kind: string, _payload?: unknown): void {
    if (this.closed) return;
    this.history.push({ sequence: ++this.sequence, kind });
    if (this.history.length > 256) this.history.shift();
    for (const wake of [...this.waiting]) wake();
  }

  private result(cursor: string) {
    const current = `${this.epoch}:${this.sequence}`;
    const prefix = `${this.epoch}:`;
    const suffix = cursor.startsWith(prefix) ? cursor.slice(prefix.length) : "";
    const sequence = /^\d+$/.test(suffix) ? Number(suffix) : NaN;
    const oldest = this.history[0]?.sequence ?? this.sequence + 1;
    if (!Number.isSafeInteger(sequence) || sequence < oldest - 1 || sequence > this.sequence) {
      return { cursor: current, reset: true, changes: [], closed: this.closed };
    }
    return { cursor: current, reset: false, changes: this.history.filter(item => item.sequence > sequence).map(item => ({ kind: item.kind })), closed: this.closed };
  }

  async wait(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected cursor and waitMs");
    const { cursor, waitMs, ...extra } = input as Record<string, unknown>;
    if (typeof cursor !== "string" || cursor.length > 100 || !Number.isInteger(waitMs) || (waitMs as number) < 0 || (waitMs as number) > 10000 || Object.keys(extra).length) {
      throw new Error("cursor must be a bounded string and waitMs an integer from 0 to 10000");
    }
    const ready = this.result(cursor);
    if (ready.reset || ready.changes.length || this.closed || waitMs === 0) return ready;
    if (this.waiting.size >= 16) throw new Error("Too many outstanding change waits");
    await new Promise<void>(resolve => {
      const wake = () => { clearTimeout(timer); this.waiting.delete(wake); resolve(); };
      const timer = setTimeout(wake, waitMs as number);
      this.waiting.add(wake);
    });
    return this.result(cursor);
  }

  close(): void {
    this.closed = true;
    for (const wake of [...this.waiting]) wake();
  }
}
