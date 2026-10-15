/**
 * Nightly-rescan Daily Help suggestion.
 *
 * Mirrors the work-assistant wakeup-on-launch precedent: on the plugin
 * lifecycle wakeup, propose (once, ever) a nightly index-rescan routine via
 * `hostApi.triggerConversation`. The user accepts the overlay; the LLM then
 * calls `routine_schedule` with the exact args templated into the prompt below.
 *
 * Idempotency is a 3-AND gate:
 *   (a) the plugin has >= 1 registered folder (nothing to rescan otherwise),
 *   (b) `hostApi.hasRoutineBySource(SOURCE) === false` — authoritative
 *       no-routine probe that catches reinstall / restore / manual creation,
 *   (c) the propose-once ledger has no `proposedAt` — propose once, ever, with
 *       NO re-suggest even after the user deletes the routine.
 *
 * The ledger records `proposedAt` only on staging success (accepted /
 * duplicate / rate_limited); a transient `capability_denied` / `invalid_source`
 * / `loop_unavailable` leaves the ledger untouched so the next wakeup retries.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ConversationTriggerResult,
  PluginHostApi,
} from "@ave/plugin-contract";

/** Routine idempotency marker — `suggestion:<pluginId>:<intent>`. */
export const RESCAN_ROUTINE_SOURCE = "suggestion:local-indexer:nightly-rescan";

/** Overlay trigger source — must match `^overlay:[a-z][a-z0-9-]*$`. */
export const RESCAN_OVERLAY_SOURCE = "overlay:local-indexer-nightly-rescan";

/** Dedupe key for the overlay (stable across wakeups). */
export const RESCAN_OVERLAY_DEDUPE_KEY = "local-indexer:nightly-rescan-suggestion";

/** Ledger filename, written under the plugin data dir. */
export const RESCAN_LEDGER_FILENAME = "rescan-suggestion.json";

/**
 * prePrompt baked into the created routine. Runs at 22:00 even if the user is
 * away and the plugin happens to be disabled — hence the on-demand
 * `request_plugin` activation fallback (session-scoped, non-persistent).
 */
export const RESCAN_ROUTINE_PRE_PROMPT =
  "Nightly index rescan. Call the index_scan tool (no args) to incrementally " +
  "re-index registered folders, then reply with a one-line <summary> of how " +
  "many files changed. If index_scan is not in your available tools (the " +
  "local-indexer plugin may be disabled), FIRST call " +
  "request_plugin({pluginId:'local-indexer'}), then index_scan. If " +
  "request_plugin errors, do NOT retry — stop and report the failure in the " +
  "<summary>. Always emit a <summary>.";

/** Shape of the dismiss-ledger persisted under the plugin data dir. */
export interface RescanLedger {
  /** ISO timestamp of the single proposal. Absence means never proposed. */
  proposedAt?: string;
}

/** Host API surface this module depends on. */
export type RescanHostApi = Pick<
  PluginHostApi,
  "triggerConversation" | "hasRoutineBySource"
>;

export interface ProposeRescanDeps {
  hostApi: RescanHostApi;
  /** Absolute path to the ledger file (under the plugin data dir). */
  ledgerPath: string;
  /** Count of registered folders — plugin-local source, never host routines. */
  countRegisteredFolders: () => Promise<number>;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Scoped logger. */
  log?: (message: string, meta?: unknown) => void;
}

export type RescanProposeOutcome =
  | { proposed: false; reason: "already-proposed" | "no-folders" | "routine-exists" }
  | { proposed: boolean; recorded: boolean; result: ConversationTriggerResult };

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * Next 22:00 in KST (+09:00), as an ISO 8601 string with the explicit offset.
 * Always lands on a `T22:00:00+09:00` instant strictly after `now`.
 */
export function nextDaily2200KstIso(now: Date): string {
  const nowMs = now.getTime();
  const kst = new Date(nowMs + KST_OFFSET_MS);
  const y = kst.getUTCFullYear();
  const m = kst.getUTCMonth();
  const d = kst.getUTCDate();
  let targetMs = Date.UTC(y, m, d, 22, 0, 0) - KST_OFFSET_MS;
  if (targetMs <= nowMs) {
    targetMs = Date.UTC(y, m, d + 1, 22, 0, 0) - KST_OFFSET_MS;
  }
  const t = new Date(targetMs + KST_OFFSET_MS);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T22:00:00+09:00`;
}

/**
 * The overlay prompt the LLM sees after the user accepts. It instructs the LLM
 * to call `routine_schedule` with the exact args (daily 22:00 llm-session,
 * `allowedPlugins:["local-indexer"]` scope, the idempotency `source` marker,
 * and the rescan prePrompt). The host translates `allowedPlugins` into the
 * canonical scope `{ mode:"allow" }`; `forcedPluginIds` is intentionally NOT
 * exposed (no blind force).
 */
export function buildRescanRoutinePrompt(atIso: string): string {
  const args = {
    execution: "llm-session",
    schedule: { at: atIso, repeat: { kind: "daily" } },
    allowedPlugins: ["local-indexer"],
    source: RESCAN_ROUTINE_SOURCE,
    title: "야간 문서 재인덱싱",
    prePrompt: RESCAN_ROUTINE_PRE_PROMPT,
  };
  return [
    "사용자가 매일 밤 문서 자동 재인덱싱(야간 재스캔) 루틴 설정을 수락했습니다.",
    "routine_schedule 도구를 아래 인자 그대로 정확히 한 번 호출하세요 (값을 임의로 바꾸지 마세요):",
    JSON.stringify(args, null, 2),
    "",
    "필수 제약:",
    '- execution 은 반드시 "llm-session" — 매일 밤 22:00 세션을 열어 index_scan 을 실행하고 <summary> 히스토리를 남깁니다.',
    '- schedule.repeat.kind 는 "daily", schedule.at 은 위 ISO(다음 22:00, +09:00 오프셋).',
    '- allowedPlugins 는 ["local-indexer"] 만 — 다른 플러그인 강제 활성 금지.',
    `- source 는 "${RESCAN_ROUTINE_SOURCE}" 그대로 — 멱등 식별자이므로 절대 변경하지 마세요.`,
    "- prePrompt 는 위 문자열을 그대로 전달하세요 (request_plugin 폴백 + <summary> 지시 포함).",
    "routine_schedule 호출이 성공하면 사용자에게 '매일 밤 22:00 자동 재인덱싱을 설정했습니다' 라고 한 줄로 알리세요.",
  ].join("\n");
}

/** Read the ledger; missing / corrupt file is treated as "never proposed". */
export async function readRescanLedger(ledgerPath: string): Promise<RescanLedger> {
  try {
    const raw = await readFile(ledgerPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && "proposedAt" in parsed) {
      const at = (parsed as { proposedAt?: unknown }).proposedAt;
      if (typeof at === "string" && at.length > 0) return { proposedAt: at };
    }
    return {};
  } catch {
    return {};
  }
}

/** Persist the ledger atomically with 0o600 perms. */
export async function writeRescanLedgerProposed(
  ledgerPath: string,
  proposedAt: string,
): Promise<void> {
  await mkdir(dirname(ledgerPath), { recursive: true, mode: 0o700 });
  const tmpPath = `${ledgerPath}.tmp`;
  const payload = JSON.stringify({ proposedAt } satisfies RescanLedger, null, 2);
  await writeFile(tmpPath, payload, { encoding: "utf-8", mode: 0o600 });
  await rename(tmpPath, ledgerPath);
}

/**
 * Staging success = the overlay was actually staged or deduplicated; the ledger
 * is then locked. `rate_limited` is intentionally excluded: a rate-limited
 * trigger may never have surfaced to the user, so locking the propose-once
 * ledger for it would lose the proposal permanently. Rate-limited results fall
 * through to the transient-denial path and leave the ledger untouched so the
 * next wakeup retries.
 */
function isStagingSuccess(result: ConversationTriggerResult): boolean {
  if (result.accepted) return true;
  return result.reason === "duplicate";
}

/**
 * The 3-AND gate + propose + ledger record. Safe to call on every wakeup; it
 * early-returns after the first successful proposal (propose-once-ever).
 */
export async function maybeProposeRescanRoutine(
  deps: ProposeRescanDeps,
): Promise<RescanProposeOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const log = deps.log ?? (() => {});

  // Gate (c): propose-once-ever ledger (cheapest local check first).
  const ledger = await readRescanLedger(deps.ledgerPath);
  if (ledger.proposedAt) {
    log("local-indexer:rescan-suggestion:skip-already-proposed", {
      proposedAt: ledger.proposedAt,
    });
    return { proposed: false, reason: "already-proposed" };
  }

  // Gate (a): plugin must have >= 1 registered folder.
  const folderCount = await deps.countRegisteredFolders();
  if (folderCount < 1) {
    log("local-indexer:rescan-suggestion:skip-no-folders", {});
    return { proposed: false, reason: "no-folders" };
  }

  // Gate (b): authoritative no-routine probe (reinstall / restore / manual).
  const exists = await deps.hostApi.hasRoutineBySource(RESCAN_ROUTINE_SOURCE);
  if (exists) {
    log("local-indexer:rescan-suggestion:skip-routine-exists", {});
    return { proposed: false, reason: "routine-exists" };
  }

  // All three gates pass → propose.
  const atIso = nextDaily2200KstIso(now);
  const result = await deps.hostApi.triggerConversation({
    source: RESCAN_OVERLAY_SOURCE,
    title: "야간 문서 재인덱싱 설정",
    summary: "매일 밤 22:00에 등록된 폴더를 자동으로 다시 인덱싱하도록 설정할까요?",
    prompt: buildRescanRoutinePrompt(atIso),
    primaryActionLabel: "설정하기",
    visibility: "user-visible",
    priority: "normal",
    dedupeKey: RESCAN_OVERLAY_DEDUPE_KEY,
  });

  if (isStagingSuccess(result)) {
    let recorded = false;
    try {
      await writeRescanLedgerProposed(deps.ledgerPath, now.toISOString());
      recorded = true;
    } catch (err) {
      log("local-indexer:rescan-suggestion:ledger-write-failed", {
        error: (err as Error).message,
      });
    }
    log("local-indexer:rescan-suggestion:staged", {
      accepted: result.accepted,
      reason: result.reason,
      recorded,
    });
    return { proposed: result.accepted, recorded, result };
  }

  // Transient denial (capability_denied / invalid_source / loop_unavailable):
  // do NOT record — let the next wakeup retry.
  log("local-indexer:rescan-suggestion:rejected", { reason: result.reason });
  return { proposed: false, recorded: false, result };
}
