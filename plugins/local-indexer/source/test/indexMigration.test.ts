/**
 * The visible rebuild out of `<pluginDataDir>/index`: the old directory is
 * removed only after a verified rebuild, and kept for every lesser outcome.
 * These tests use a real directory on disk so a premature delete is caught.
 */
import { describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyIndex, type IndexMigrationStatus } from "../src/indexMigration";
import type { FolderAutoIndexerResult } from "../src/types";

function scanResult(overrides: Partial<FolderAutoIndexerResult> = {}): FolderAutoIndexerResult {
  return {
    scanned: 3,
    indexed: 3,
    failed: 0,
    totalIndexed: 3,
    ...overrides,
  };
}

async function withLegacy<T>(run: (ctx: { root: string; legacy: string }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ave-li-migrate-"));
  const legacy = join(root, "data", "index");
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, "fts5.sqlite"), "old index");
  try {
    return await run({ root, legacy });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function deps(
  ctx: { root: string; legacy: string },
  overrides: Partial<Parameters<typeof migrateLegacyIndex>[0]> = {},
) {
  const reports: IndexMigrationStatus[] = [];
  const removeDirectory = vi.fn(async (path: string) => {
    await rm(path, { recursive: true, force: true });
  });
  return {
    reports,
    removeDirectory,
    input: {
      location: {
        indexRoot: join(ctx.root, "state", "index"),
        documentCount: 0,
        inStateDirectory: true,
        legacyIndexDir: ctx.legacy,
      },
      workspace: join(ctx.root, "data", ".local-indexer-workspace"),
      runFullScan: async () => scanResult(),
      countDocuments: async () => 3,
      removeDirectory,
      report: (s: IndexMigrationStatus) => reports.push({ ...s }),
      ...overrides,
    },
  };
}

describe("migrateLegacyIndex", () => {
  it("does nothing when there is no old index", async () => {
    await withLegacy(async (ctx) => {
      const d = deps(ctx);
      const result = await migrateLegacyIndex({ ...d.input, location: { ...d.input.location, legacyIndexDir: null } });
      expect(result).toBeNull();
      expect(d.reports).toEqual([]);
      expect(existsSync(ctx.legacy)).toBe(true);
    });
  });

  it("deletes the old directory after a verified rebuild, and reports rebuilding then completed", async () => {
    await withLegacy(async (ctx) => {
      const order: string[] = [];
      const d = deps(ctx, {
        runFullScan: async () => {
          order.push("scan");
          // The old index must still exist while the rebuild runs.
          expect(existsSync(ctx.legacy)).toBe(true);
          return scanResult();
        },
        countDocuments: async () => {
          order.push("count");
          expect(existsSync(ctx.legacy)).toBe(true);
          return 3;
        },
      });
      const result = await migrateLegacyIndex(d.input);
      expect(order).toEqual(["scan", "count"]);
      expect(result?.phase).toBe("completed");
      expect(result?.documentsAfter).toBe(3);
      expect(d.reports.map((r) => r.phase)).toEqual(["rebuilding", "completed"]);
      expect(existsSync(ctx.legacy)).toBe(false);
      // The parent data directory and anything beside the index survive.
      expect(existsSync(join(ctx.root, "data"))).toBe(true);
    });
  });

  const keptCases: Array<[string, Partial<Parameters<typeof migrateLegacyIndex>[0]>, RegExp]> = [
    ["the scan throws", { runFullScan: async () => { throw new Error("worker gone"); } }, /rebuild scan failed: worker gone/],
    ["the scan was cancelled", { runFullScan: async () => scanResult({ canceled: true }) }, /cancelled/],
    ["a file failed", { runFullScan: async () => scanResult({ failed: 1, indexed: 2, totalIndexed: 2 }), countDocuments: async () => 2 }, /1 file\(s\) failed/],
    ["the worker holds fewer documents than indexed", { countDocuments: async () => 2 }, /holds 2 document\(s\) but the scan indexed 3/],
    ["the worker holds more documents than indexed", { countDocuments: async () => 4 }, /holds 4 document\(s\)/],
    ["the count cannot be read", { countDocuments: async () => { throw new Error("timeout"); } }, /did not report its documents: timeout/],
  ];

  for (const [label, overrides, reason] of keptCases) {
    it(`keeps the old directory when ${label}`, async () => {
      await withLegacy(async (ctx) => {
        const d = deps(ctx, overrides);
        const result = await migrateLegacyIndex(d.input);
        expect(result?.phase).toBe("kept-old");
        expect(result?.reason).toMatch(reason);
        expect(d.removeDirectory).not.toHaveBeenCalled();
        expect(existsSync(join(ctx.legacy, "fts5.sqlite"))).toBe(true);
        expect(d.reports.at(-1)?.phase).toBe("kept-old");
      });
    });
  }

  it("reports kept-old when the removal itself fails", async () => {
    await withLegacy(async (ctx) => {
      const d = deps(ctx, { removeDirectory: async () => { throw new Error("EACCES"); } });
      const result = await migrateLegacyIndex(d.input);
      expect(result).toMatchObject({ phase: "kept-old", reason: expect.stringMatching(/could not be removed: EACCES/) });
    });
  });

  it("never deletes a directory that holds the new index or the workspace", async () => {
    await withLegacy(async (ctx) => {
      const scan = vi.fn(async () => scanResult());
      const insideIndex = deps(ctx, { runFullScan: scan });
      const r1 = await migrateLegacyIndex({
        ...insideIndex.input,
        location: { ...insideIndex.input.location, indexRoot: join(ctx.legacy, "nested") },
      });
      expect(r1?.phase).toBe("kept-old");
      const insideWorkspace = deps(ctx, { runFullScan: scan });
      const r2 = await migrateLegacyIndex({ ...insideWorkspace.input, workspace: join(ctx.legacy, "workspace") });
      expect(r2?.phase).toBe("kept-old");
      expect(scan).not.toHaveBeenCalled();
      expect(existsSync(ctx.legacy)).toBe(true);
    });
  });
});
