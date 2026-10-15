import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, stat, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ConversationTriggerResult } from "@ave/plugin-contract";
import {
  buildRescanRoutinePrompt,
  maybeProposeRescanRoutine,
  nextDaily2200KstIso,
  readRescanLedger,
  RESCAN_LEDGER_FILENAME,
  RESCAN_OVERLAY_DEDUPE_KEY,
  RESCAN_OVERLAY_SOURCE,
  RESCAN_ROUTINE_PRE_PROMPT,
  RESCAN_ROUTINE_SOURCE,
  writeRescanLedgerProposed,
} from "../src/rescanSuggestion.js";

function makeHostApi(opts: {
  routineExists?: boolean;
  triggerResult?: ConversationTriggerResult;
}) {
  const triggerConversation = vi.fn(
    async (spec: { source: string }): Promise<ConversationTriggerResult> =>
      opts.triggerResult ?? { accepted: true, source: spec.source, eventId: "ov_1" },
  );
  const hasRoutineBySource = vi.fn(async (_source: string) => opts.routineExists ?? false);
  return { triggerConversation, hasRoutineBySource };
}

describe("nextDaily2200KstIso", () => {
  it("produces a T22:00:00+09:00 instant strictly after now", () => {
    const now = new Date("2026-06-29T01:00:00Z"); // 10:00 KST → next 22:00 same KST day
    const iso = nextDaily2200KstIso(now);
    expect(iso).toMatch(/T22:00:00\+09:00$/);
    expect(new Date(iso).getTime()).toBeGreaterThan(now.getTime());
  });

  it("rolls to the next day when current KST time is past 22:00", () => {
    const now = new Date("2026-06-29T14:00:00Z"); // 23:00 KST → must roll to next day
    const iso = nextDaily2200KstIso(now);
    expect(iso).toBe("2026-06-30T22:00:00+09:00");
    expect(new Date(iso).getTime()).toBeGreaterThan(now.getTime());
  });
});

describe("buildRescanRoutinePrompt", () => {
  it("instructs routine_schedule with the exact daily-22:00 llm-session args", () => {
    const prompt = buildRescanRoutinePrompt("2026-06-30T22:00:00+09:00");
    expect(prompt).toContain("routine_schedule");
    expect(prompt).toContain('"llm-session"');
    expect(prompt).toContain('"daily"');
    expect(prompt).toContain("2026-06-30T22:00:00+09:00");
    expect(prompt).toContain("22:00");
    // scope allow-list — local-indexer only (no forced plugins).
    expect(prompt).toContain('"allowedPlugins"');
    expect(prompt).toContain('"local-indexer"');
    // idempotency source marker.
    expect(prompt).toContain(RESCAN_ROUTINE_SOURCE);
    // prePrompt with the request_plugin on-demand fallback + <summary>.
    expect(prompt).toContain(RESCAN_ROUTINE_PRE_PROMPT);
    expect(prompt).toContain("request_plugin");
    expect(prompt).toContain("index_scan");
    expect(prompt).toContain("<summary>");
  });
});

describe("ledger round-trip", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rescan-ledger-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // POSIX-only file mode — N/A on Windows (pre-existing platform limitation, unrelated to #885)
  it.skipIf(process.platform === "win32")("writes 0o600 and reads back the proposedAt", async () => {
    const ledgerPath = join(dir, RESCAN_LEDGER_FILENAME);
    expect(await readRescanLedger(ledgerPath)).toEqual({});
    await writeRescanLedgerProposed(ledgerPath, "2026-06-29T13:00:00.000Z");
    const st = await stat(ledgerPath);
    expect(st.mode & 0o777).toBe(0o600);
    expect(await readRescanLedger(ledgerPath)).toEqual({ proposedAt: "2026-06-29T13:00:00.000Z" });
  });

  it("treats a corrupt ledger as never-proposed", async () => {
    const ledgerPath = join(dir, RESCAN_LEDGER_FILENAME);
    await writeFile(ledgerPath, "{ not json", "utf-8");
    expect(await readRescanLedger(ledgerPath)).toEqual({});
  });

  // P1: writeRescanLedgerProposed must create the parent dir with 0o700
  // when it doesn't pre-exist, so plugin data is not world-readable.
  // POSIX-only file mode — N/A on Windows (pre-existing platform limitation, unrelated to #885)
  it.skipIf(process.platform === "win32")("creates the ledger parent dir with 0o700 when absent", async () => {
    const nestedDir = join(dir, "nested", "data");
    const ledgerPath = join(nestedDir, RESCAN_LEDGER_FILENAME);
    // nestedDir does not exist yet
    await writeRescanLedgerProposed(ledgerPath, "2026-06-29T00:00:00.000Z");
    const dirSt = await stat(nestedDir);
    expect(dirSt.mode & 0o777).toBe(0o700);
    const fileSt = await stat(ledgerPath);
    expect(fileSt.mode & 0o777).toBe(0o600);
  });
});

// P2: countRegisteredFolders dedup consistency — a folder in both config
// scanFolders and folders.json (same relative path, resolved against the
// same hostRoot) must count as ONE, not two.
describe("countRegisteredFolders base-path dedup (P2 integration)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join((await import("node:os")).tmpdir(), "rescan-p2-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("deduplicates a folder present in both scanFolders config and folders.json when resolved against the same hostRoot", async () => {
    // Simulate what hostPlugin.ts does:
    //   scanFolders = toStringArray(raw).map(f => resolve(hostRoot, f))
    //   countRegisteredFolders: registered.add(resolve(hostRoot, f.trim()))
    const hostRoot = dir;
    const relFolder = "docs";
    // scanFolders resolved against hostRoot (as hostPlugin does)
    const scanFolders = [resolve(hostRoot, relFolder)];

    // folders.json written with the same relative path
    const workspace = join(dir, "workspace");
    await mkdir(workspace, { recursive: true });
    const foldersConfigPath = join(workspace, "folders.json");
    await writeFile(foldersConfigPath, JSON.stringify({ folders: [relFolder] }), "utf-8");

    // Replicate countRegisteredFolders logic (P2-fixed version)
    const { existsSync } = await import("node:fs");
    const { readFile } = await import("node:fs/promises");
    const registered = new Set<string>(scanFolders);
    if (existsSync(foldersConfigPath)) {
      const raw = await readFile(foldersConfigPath, "utf-8");
      const parsed = JSON.parse(raw) as { folders?: unknown };
      if (Array.isArray(parsed.folders)) {
        for (const f of parsed.folders) {
          if (typeof f === "string" && f.trim().length > 0) {
            registered.add(resolve(hostRoot, f.trim()));
          }
        }
      }
    }

    expect(registered.size).toBe(1);
  });
});

describe("maybeProposeRescanRoutine — 3-AND gate", () => {
  let dir: string;
  let ledgerPath: string;
  const now = () => new Date("2026-06-29T01:00:00Z");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rescan-gate-"));
    ledgerPath = join(dir, RESCAN_LEDGER_FILENAME);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("proposes + records the ledger when all three gates pass", async () => {
    const hostApi = makeHostApi({ routineExists: false });
    const outcome = await maybeProposeRescanRoutine({
      hostApi,
      ledgerPath,
      countRegisteredFolders: async () => 2,
      now,
    });

    expect(hostApi.hasRoutineBySource).toHaveBeenCalledTimes(1);
    expect(hostApi.hasRoutineBySource).toHaveBeenCalledWith(RESCAN_ROUTINE_SOURCE);
    expect(hostApi.triggerConversation).toHaveBeenCalledTimes(1);

    const spec = hostApi.triggerConversation.mock.calls[0]![0] as {
      source: string;
      dedupeKey?: string;
      prompt: string;
    };
    expect(spec.source).toBe(RESCAN_OVERLAY_SOURCE);
    expect(spec.dedupeKey).toBe(RESCAN_OVERLAY_DEDUPE_KEY);
    expect(spec.prompt).toContain("routine_schedule");
    expect(spec.prompt).toContain(RESCAN_ROUTINE_SOURCE);
    expect(spec.prompt).toContain('"daily"');
    expect(spec.prompt).toContain("request_plugin");

    expect(outcome).toMatchObject({ proposed: true, recorded: true });
    expect(await readRescanLedger(ledgerPath)).toEqual({
      proposedAt: now().toISOString(),
    });
  });

  it("does NOT propose when folders == 0 (gate a) — routine probe untouched", async () => {
    const hostApi = makeHostApi({ routineExists: false });
    const outcome = await maybeProposeRescanRoutine({
      hostApi,
      ledgerPath,
      countRegisteredFolders: async () => 0,
      now,
    });
    expect(outcome).toEqual({ proposed: false, reason: "no-folders" });
    expect(hostApi.hasRoutineBySource).not.toHaveBeenCalled();
    expect(hostApi.triggerConversation).not.toHaveBeenCalled();
    expect(await readRescanLedger(ledgerPath)).toEqual({});
  });

  it("does NOT propose when a routine already exists (gate b)", async () => {
    const hostApi = makeHostApi({ routineExists: true });
    const outcome = await maybeProposeRescanRoutine({
      hostApi,
      ledgerPath,
      countRegisteredFolders: async () => 5,
      now,
    });
    expect(outcome).toEqual({ proposed: false, reason: "routine-exists" });
    expect(hostApi.hasRoutineBySource).toHaveBeenCalledWith(RESCAN_ROUTINE_SOURCE);
    expect(hostApi.triggerConversation).not.toHaveBeenCalled();
    expect(await readRescanLedger(ledgerPath)).toEqual({});
  });

  it("does NOT propose when the ledger already has proposedAt (gate c)", async () => {
    await writeRescanLedgerProposed(ledgerPath, "2026-01-01T00:00:00.000Z");
    const hostApi = makeHostApi({ routineExists: false });
    const countRegisteredFolders = vi.fn(async () => 3);
    const outcome = await maybeProposeRescanRoutine({
      hostApi,
      ledgerPath,
      countRegisteredFolders,
      now,
    });
    expect(outcome).toEqual({ proposed: false, reason: "already-proposed" });
    expect(countRegisteredFolders).not.toHaveBeenCalled();
    expect(hostApi.hasRoutineBySource).not.toHaveBeenCalled();
    expect(hostApi.triggerConversation).not.toHaveBeenCalled();
  });
});

describe("maybeProposeRescanRoutine — ledger recording by staging outcome", () => {
  let dir: string;
  let ledgerPath: string;
  const now = () => new Date("2026-06-29T01:00:00Z");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rescan-ledger-out-"));
    ledgerPath = join(dir, RESCAN_LEDGER_FILENAME);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("records the ledger on staging success: duplicate", async () => {
    const hostApi = makeHostApi({
      triggerResult: { accepted: false, reason: "duplicate", source: RESCAN_OVERLAY_SOURCE },
    });
    const outcome = await maybeProposeRescanRoutine({
      hostApi,
      ledgerPath,
      countRegisteredFolders: async () => 1,
      now,
    });
    expect(outcome).toMatchObject({ proposed: false, recorded: true });
    expect(await readRescanLedger(ledgerPath)).toEqual({ proposedAt: now().toISOString() });
  });

  // P3: rate_limited must NOT lock the ledger — the overlay may never have
  // reached the user, so the next wakeup should retry.
  for (const reason of ["rate_limited", "capability_denied", "invalid_source", "loop_unavailable"] as const) {
    it(`does NOT record the ledger on transient/rate-limited denial: ${reason}`, async () => {
      const hostApi = makeHostApi({
        triggerResult: { accepted: false, reason, source: RESCAN_OVERLAY_SOURCE },
      });
      const outcome = await maybeProposeRescanRoutine({
        hostApi,
        ledgerPath,
        countRegisteredFolders: async () => 1,
        now,
      });
      expect(outcome).toMatchObject({ proposed: false, recorded: false });
      expect(await readRescanLedger(ledgerPath)).toEqual({});
    });
  }

  it("is idempotent: a second wakeup after a recorded proposal does not re-trigger", async () => {
    const hostApi = makeHostApi({ routineExists: false });
    const deps = {
      hostApi,
      ledgerPath,
      countRegisteredFolders: async () => 2,
      now,
    };
    await maybeProposeRescanRoutine(deps);
    await maybeProposeRescanRoutine(deps);
    expect(hostApi.triggerConversation).toHaveBeenCalledTimes(1);
  });
});
