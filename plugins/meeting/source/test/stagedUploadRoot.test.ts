/**
 * Where staged uploads stage, and what the sweep does when the root is absent.
 *
 * The sweep runs in the plugin's ACTIVATION body. It used to read `tmpdir()`,
 * and a confined plugin child is handed a substituted temp root the sandbox
 * creates nothing at — so the first thing the plugin did on start was throw
 * `ENOENT`. Not a degraded feature: a plugin that does not load. The
 * absent-root case below is that one, reproduced without a sandbox.
 */
import { existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  STAGED_UPLOAD_TTL_MS,
  cleanupStaleStagedUploadDirs,
  stagedUploadRoot,
} from "../src/hostPlugin.js";

const created: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "ave-meeting-staging-test-"));
  created.push(dir);
  return dir;
}

/**
 * Age is driven by moving `now` FORWARD, not by backdating the directory.
 *
 * The sweep takes `Math.max(mtimeMs, ctimeMs, birthtimeMs)`, deliberately: a
 * directory whose mtime was touched back would otherwise look dead while it is
 * still being written to. `utimesSync` moves only atime and mtime, so a test
 * that backdated a directory would find the sweep keeping it — and would read
 * as the age check being broken rather than as the test using the wrong lever.
 */
const LONG_AFTER = () => Date.now() + STAGED_UPLOAD_TTL_MS * 2;

afterEach(async () => {
  while (created.length > 0) await rm(created.pop()!, { recursive: true, force: true });
});

describe("stagedUploadRoot", () => {
  it("hangs the domain off pluginDataDir rather than the machine's temp", () => {
    const dataDir = "/plugins/meeting/data";
    const root = stagedUploadRoot(dataDir);
    expect(root).toBe(join(dataDir, "staged-uploads"));
    // The property that matters is containment, not the literal name: a path
    // outside `pluginDataDir` is refused by the child's write jail, and one
    // sitting directly in it would put this feature's working files among
    // everything else the plugin stores.
    expect(root.startsWith(`${dataDir}/`)).toBe(true);
    expect(root).not.toBe(dataDir);
  });
});

describe("cleanupStaleStagedUploadDirs", () => {
  it("creates the root when it is not there, instead of throwing", () => {
    // The activation-body case. `readdirSync` on an absent directory throws,
    // and the sweep is the first thing the plugin does.
    const root = join(scratch(), "staged-uploads");
    expect(existsSync(root)).toBe(false);
    expect(cleanupStaleStagedUploadDirs(root)).toBe(0);
    expect(existsSync(root)).toBe(true);
    // 0o700, because a staged upload is the user's audio before it has been
    // transcribed.
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it("removes an expired directory but not one an upload still holds", () => {
    const root = join(scratch(), "staged-uploads");
    mkdirSync(root, { recursive: true });

    const expired = join(root, "upload-expired");
    const inFlight = join(root, "upload-in-flight");
    for (const dir of [expired, inFlight]) mkdirSync(dir);

    // BOTH are past the TTL. That is what makes this a test of the protection
    // rather than of the age check — a protected directory that was also young
    // would have survived for the wrong reason.
    const removed = cleanupStaleStagedUploadDirs(root, LONG_AFTER(), new Set([inFlight]));

    expect(removed).toBe(1);
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(inFlight)).toBe(true);
  });

  it("keeps a directory that is still inside the TTL", () => {
    const root = join(scratch(), "staged-uploads");
    mkdirSync(root, { recursive: true });
    const fresh = join(root, "upload-fresh");
    mkdirSync(fresh);

    expect(cleanupStaleStagedUploadDirs(root)).toBe(0);
    expect(existsSync(fresh)).toBe(true);
  });

  it("leaves anything that is not one of its own directories alone", () => {
    const root = join(scratch(), "staged-uploads");
    mkdirSync(root, { recursive: true });
    const neighbour = join(root, "not-an-upload");
    mkdirSync(neighbour);

    // Swept with a `now` that puts everything here past the TTL, so age cannot
    // be the reason the neighbour survives — the prefix is.
    expect(cleanupStaleStagedUploadDirs(root, LONG_AFTER())).toBe(0);
    expect(existsSync(neighbour)).toBe(true);
  });
});
