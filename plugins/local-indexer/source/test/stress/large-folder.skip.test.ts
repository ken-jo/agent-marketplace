/**
 * Sprint 3-C stress test — 10,000-file scan.
 *
 * This test is SKIPPED by default. It creates 10,000 tiny synthetic
 * files and asserts the FolderAutoIndexer initial scan completes
 * within 20 seconds on a dev machine. It is not meant for CI: it
 * touches the disk heavily and its timing assertion is machine-dependent.
 *
 * To run manually:
 *
 *     STRESS=1 bunx vitest run test/stress/large-folder.skip.test.ts
 *
 * Without STRESS=1, the whole suite is skipped via describe.skipIf so
 * `npm test` stays green and fast.
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { FolderAutoIndexer } from "../../src/folderIndexer";

const STRESS_ENABLED = process.env.STRESS === "1";
const FILE_COUNT = 10_000;
const BUDGET_MS = 20_000;

describe.skipIf(!STRESS_ENABLED)("stress: 10k-file folder scan", () => {
  it(`indexes ${FILE_COUNT} files within ${BUDGET_MS}ms`, async () => {
    const root = await mkdtemp(join(tmpdir(), "ave-stress-"));
    try {
      // Spread files across 100 subdirs to mimic real folders.
      const subdirs = 100;
      for (let d = 0; d < subdirs; d++) {
        await mkdir(join(root, `d${d}`), { recursive: true });
      }
      // Throttle to 100 concurrent writes to avoid EMFILE on dev machines.
      const CONCURRENCY = 100;
      let active = 0;
      let next = 0;
      await new Promise<void>((resolve, reject) => {
        function dispatch() {
          while (active < CONCURRENCY && next < FILE_COUNT) {
            const i = next++;
            active++;
            const sub = `d${i % subdirs}`;
            writeFile(join(root, sub, `f${i}.md`), `# doc ${i}\nbody-${i}\n`)
              .then(() => {
                active--;
                if (next < FILE_COUNT) {
                  dispatch();
                } else if (active === 0) {
                  resolve();
                }
              })
              .catch(reject);
          }
          if (next >= FILE_COUNT && active === 0) resolve();
        }
        dispatch();
      });

      const client = {
        indexDocument: vi.fn(async () => "doc"),
        removeDocument: vi.fn(async () => {}),
      };
      const indexer = new FolderAutoIndexer({
        client,
        folders: [root],
        extensions: [".md"],
      });

      const started = Date.now();
      const result = await indexer.scanOnce();
      const elapsed = Date.now() - started;

      expect(result.scanned).toBeGreaterThanOrEqual(FILE_COUNT);
      expect(elapsed).toBeLessThan(BUDGET_MS);

      await indexer.stop?.();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, BUDGET_MS + 30_000);
});
