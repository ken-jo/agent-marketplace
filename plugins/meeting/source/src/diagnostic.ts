/** Stderr only. Arbitrary error text and metadata may contain meeting data. */
export function diagnostic(level: "info" | "warn" | "error", code: string, _data?: unknown): void {
  const safeCode = /^[a-z][a-z0-9_.]+$/.test(code) ? code : "runtime_diagnostic";
  process.stderr.write(JSON.stringify({ plugin: "meeting", level, code: safeCode }) + "\n");
}
