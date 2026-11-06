export type ViewChanges = { reset?: boolean; changes: Array<{ kind: string; sessionId?: string }> };
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
export function createErrorConsumer(initial?: { sequence: number } | null): (error: { sequence: number } | null | undefined) => boolean {
  let acknowledged = initial && Number.isSafeInteger(initial.sequence) ? initial.sequence : 0;
  return error => {
    if (!error || !Number.isSafeInteger(error.sequence) || error.sequence <= acknowledged) return false;
    acknowledged = error.sequence;
    return true;
  };
}

/** Coalesce invalidations while a draft is open, then consume them once. */
export function createPendingChanges() {
  let reset = false;
  const changes = new Map<string, {kind: string; sessionId?: string}>();
  return {
    defer(result: ViewChanges) {
      reset ||= result.reset === true;
      for (const change of result.changes) {
        const key = change.kind + ":" + (change.sessionId ?? "");
        changes.delete(key);
        changes.set(key, change);
        if (changes.size > 256) { reset = true; changes.delete(changes.keys().next().value!); }
      }
    },
    take(): ViewChanges | null {
      if (!reset && !changes.size) return null;
      const result = {reset, changes: [...changes.values()]};
      reset = false; changes.clear();
      return result;
    },
  };
}

/** A later end event must never navigate to an earlier recording. */
export function endedSessionToOpen(result: ViewChanges, activeSessionId: string | null): string | null {
  const ended = result.changes.filter(change => change.kind === "meeting.ended").at(-1);
  return ended?.sessionId && ended.sessionId === activeSessionId ? ended.sessionId : null;
}
