import type { AlertInput } from "@ave/plugin-contract";

const SESSION_ID = /^[A-Za-z0-9+/=_-]{1,256}$/;
const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, max: number): string =>
  typeof value === "string" ? [...value.slice(0, max * 2).trim()].slice(0, max).join("") : "";
const bullets = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.slice(0, 10).map((entry) => text(entry, 100)).filter(Boolean).slice(0, 3)
    : [];

/** Meeting owns finalized-summary detection; the host owns delivery and cooldown. */
export function summaryReadyAlert(payload: unknown): AlertInput | null {
  const event = asRecord(payload);
  if (!event) return null;
  const sessionId = text(event.sessionId, 257);
  if (!SESSION_ID.test(sessionId)) return null;
  const nested = asRecord(event.finalSummary);
  const final = nested ?? event;
  const highlights = bullets(final.highlights);
  const actionItems = bullets(final.actionItems);
  if (!text(final.summary, 8_000) && highlights.length === 0 && actionItems.length === 0) return null;
  const context = asRecord(event.context);
  const title = text(context?.title, 80) || text(final.title, 80) || "회의 요약";
  return { kind: "summary-ready", key: sessionId, slots: { title, highlights, actionItems, sessionId } };
}
