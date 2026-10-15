/**
 * Host-LLM Summary Provider — `hostApi.callLlm` 경유 요약 생성.
 *
 * 이 provider 는 벤더/모델/API 키를 직접 보유하지 않는다 (plugin-tool-schema-design.md §1 원칙 1).
 * 호스트에 주입된 `callLlm` 이 현재 설정된 LLM 으로 텍스트 생성을 위임.
 * STT (Whisper) 는 binary audio 라 callLlm surface 밖이므로 별도 OpenAIWhisperSttProvider 유지.
 */
import type {
  SummarizeFinalOptions,
  SummarizeIntermediateOptions,
  SummaryInput,
  SummaryProvider,
} from "../providers.js";
import type { FinalSummary, IntermediateSummary, SummaryLengthTier } from "../types.js";
import {
  buildIntermediateUserPrompt,
  buildFinalUserPrompt,
  extractJson,
  safeParseSummaryJson,
  tierToMaxTokens,
  resolveFinalSystemPrompt,
  resolveIntermediateSystemPrompt,
} from "./summaryPrompts.js";

export type CallLlmFn = (
  prompt: string,
  options?: { maxTokens?: number; systemPrompt?: string; signal?: AbortSignal },
) => Promise<string>;

export type LogEventFn = (
  level: "info" | "warn" | "error",
  message: string,
  data?: unknown,
) => void;

export interface HostLlmSummaryProviderOptions {
  callLlm: CallLlmFn;
  /** Cap for intermediate-summary calls (kept short by design — UI hint
   *  card). Final-summary token cap is derived from `lengthTier`. */
  maxTokens?: number;
  logEvent?: LogEventFn;
  /** Default verbosity tier for `summarizeFinal`. Per-call `opts.lengthTier`
   *  overrides this. Default "medium". */
  defaultLengthTier?: SummaryLengthTier;
  /** Admin-set system prompt override for final summary (configSchema's
   *  customSummaryFinalPrompt). Empty/whitespace falls through to the
   *  tiered built-in. Used verbatim — caller is responsible for embedding
   *  any length-tier instructions inside their custom string.
   *
   *  Pass a getter function (instead of a plain string) when the value
   *  can change at runtime without a plugin restart — the host plugin
   *  uses this so the 회의록 ⋯ menu's prompt edit takes effect on the
   *  next summarize call without recreating the provider. */
  customFinalSystem?: string | (() => string | undefined);
  /** Same pattern for intermediate summary. */
  customIntermediateSystem?: string | (() => string | undefined);
}

/** Cap raw LLM output that survives a JSON-parse failure. The fallback
 *  path used to surface the entire response (potentially many KB of
 *  malformed text) directly into the persisted summary; truncating here
 *  keeps the on-disk payload bounded. */
const RAW_SUMMARY_TRUNCATE_CHARS = 2000;

function truncateRawSummary(raw: unknown): string {
  if (typeof raw !== "string") return "";
  if (raw.length <= RAW_SUMMARY_TRUNCATE_CHARS) return raw;
  return raw.slice(0, RAW_SUMMARY_TRUNCATE_CHARS) + "…";
}

export class HostLlmSummaryProvider implements SummaryProvider {
  private readonly callLlm: CallLlmFn;
  private readonly intermediateMaxTokens: number;
  private readonly logEvent?: LogEventFn;
  private readonly defaultLengthTier: SummaryLengthTier;
  private readonly customFinalSystem?: string | (() => string | undefined);
  private readonly customIntermediateSystem?: string | (() => string | undefined);

  constructor(options: HostLlmSummaryProviderOptions) {
    this.callLlm = options.callLlm;
    // Intermediate summaries are short hint cards — keep the token cap
    // modest (default 600) so progressive in-meeting summaries stay cheap
    // and fast regardless of the final-summary length tier.
    this.intermediateMaxTokens = options.maxTokens ?? 600;
    this.logEvent = options.logEvent;
    this.defaultLengthTier = options.defaultLengthTier ?? "medium";
    this.customFinalSystem = options.customFinalSystem;
    this.customIntermediateSystem = options.customIntermediateSystem;
  }

  async summarizeIntermediate(
    input: SummaryInput,
    opts?: SummarizeIntermediateOptions,
  ): Promise<IntermediateSummary> {
    const result = await this.callLlm(buildIntermediateUserPrompt(input), {
      maxTokens: this.intermediateMaxTokens,
      signal: opts?.signal,
      systemPrompt: resolveIntermediateSystemPrompt(
        typeof this.customIntermediateSystem === "function"
          ? this.customIntermediateSystem()
          : this.customIntermediateSystem,
      ),
    });

    const parsed = safeParseSummaryJson(extractJson(result)) as
      | { summary?: unknown; highlights?: unknown }
      | null;
    if (parsed && (typeof parsed.summary === "string" || Array.isArray(parsed.highlights))) {
      return {
        summary: typeof parsed.summary === "string" ? parsed.summary : "",
        highlights: Array.isArray(parsed.highlights)
          ? parsed.highlights.filter((h) => typeof h === "string")
          : [],
        coveredSegmentIds: input.transcript.map((s) => s.id),
        createdAt: new Date().toISOString(),
      };
    }
    this.logEvent?.("warn", "summary parse failed (intermediate)", {
      length: typeof result === "string" ? result.length : 0,
    });
    return {
      summary: truncateRawSummary(result),
      highlights: [],
      coveredSegmentIds: input.transcript.map((s) => s.id),
      createdAt: new Date().toISOString(),
    };
  }

  async summarizeFinal(input: SummaryInput, opts?: SummarizeFinalOptions): Promise<FinalSummary> {
    const tier = opts?.lengthTier ?? this.defaultLengthTier;
    // Duration in minutes from the transcript spans drives the dynamic
    // length scaling — longer meetings get proportionally longer summaries
    // even at the same user-picked tier. Falls back to 0 (no scaling) when
    // the transcript is empty or its timestamps are degenerate.
    const first = input.transcript[0];
    const last = input.transcript[input.transcript.length - 1];
    const durationMin = first && last && last.endSec > first.startSec
      ? Math.max(0, (last.endSec - first.startSec) / 60)
      : 0;
    const result = await this.callLlm(buildFinalUserPrompt(input), {
      maxTokens: tierToMaxTokens(tier, { durationMin }),
      signal: opts?.signal,
      systemPrompt: resolveFinalSystemPrompt(
        tier,
        typeof this.customFinalSystem === "function"
          ? this.customFinalSystem()
          : this.customFinalSystem,
        { durationMin },
      ),
    });

    const parsed = safeParseSummaryJson(extractJson(result)) as
      | { title?: unknown; summary?: unknown; highlights?: unknown; actionItems?: unknown }
      | null;
    if (parsed && (
      typeof parsed.title === "string"
      || typeof parsed.summary === "string"
      || Array.isArray(parsed.highlights)
    )) {
      return {
        title: typeof parsed.title === "string" && parsed.title.trim()
          ? parsed.title.trim()
          : "회의 요약",
        summary: typeof parsed.summary === "string" ? parsed.summary : "",
        highlights: Array.isArray(parsed.highlights)
          ? parsed.highlights.filter((h) => typeof h === "string")
          : [],
        actionItems: Array.isArray(parsed.actionItems)
          ? parsed.actionItems.filter((a) => typeof a === "string")
          : [],
        createdAt: new Date().toISOString(),
        lengthTier: tier,
      };
    }
    this.logEvent?.("warn", "summary parse failed (final)", {
      length: typeof result === "string" ? result.length : 0,
    });
    return {
      title: "회의 요약",
      summary: truncateRawSummary(result),
      highlights: [],
      actionItems: [],
      createdAt: new Date().toISOString(),
      lengthTier: tier,
    };
  }
}
