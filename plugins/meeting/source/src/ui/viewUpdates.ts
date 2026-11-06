export type ViewChanges = { reset?: boolean; changes: Array<{ kind: string }> };
export type ViewState = { view: string; detailTab?: string; editing?: boolean; dirty?: boolean };

/** Background invalidations must not replace a draft or an unrelated view. */
export function shouldRefreshView(result: ViewChanges, state: ViewState): boolean {
  if (state.editing || state.dirty || state.view === "instant") return false;
  if (result.reset) return true;
  const kinds = new Set(result.changes.map(change => change.kind));
  const shared = ["meeting.ended", "meeting.summary.created", "categories"];
  if (state.view === "pre-meeting") {
    return ["meeting.prep.opened", "meeting.prep.registered", "preps", "categories", "meeting.started", "meeting.ended", "recorder"].some(kind => kinds.has(kind));
  }
  if (state.view === "sessions") return shared.some(kind => kinds.has(kind));
  if (state.view === "session-detail") {
    return shared.some(kind => kinds.has(kind))
      || ((state.detailTab ?? "summary") !== "summary" && kinds.has("meeting.transcript.updated"));
  }
  return false;
}

/** A view acknowledges each process-local error sequence without a write tool. */
export function createErrorConsumer(): (error: { sequence: number } | null | undefined) => boolean {
  let acknowledged = 0;
  return error => {
    if (!error || !Number.isSafeInteger(error.sequence) || error.sequence <= acknowledged) return false;
    acknowledged = error.sequence;
    return true;
  };
}
