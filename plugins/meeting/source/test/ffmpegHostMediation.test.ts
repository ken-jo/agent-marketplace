/**
 * Everything the FFmpeg runtime reaches for, it reaches for THROUGH THE HOST.
 *
 * Two boundaries meet in `ffmpegRuntime`/`hostPlugin` and this file covers
 * both: running the binaries (the host's worker supervisor, not
 * `child_process`) and acquiring them in the first place (the host's mediated
 * fetch, not `node:https`).
 *
 * Both halves are driven by stubs rather than a real binary or a real download,
 * because what is under test is what the plugin ASKS FOR — which command, which
 * grants, which URL, under which redirect policy — and what it does when the
 * answer is not the happy one. A real FFmpeg would prove the arguments parse
 * and nothing about the boundary.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  MediatedSpawnStartError,
  OVERRIDE_ARCHIVE_MAX_BYTES,
  downloadFile,
  ensureFfmpegRuntime,
  pinnedFfmpegArtifacts,
  resolveArchiveSha256,
  runMediatedCommand,
  verifyArchiveSha256,
  type MediatedFetch,
  type MediatedSpawn,
} from "../src/ffmpegRuntime.js";
import type { PluginWorkerSpec, SpawnedPluginWorker } from "@ave/plugin-contract";
import createPlugin, {
  STAGED_UPLOAD_MAX_ACTIVE,
  ffmpegWorkerId,
  runFfmpegSegmenter,
  runFfprobeDurationSec,
  takeFfmpegWorkerSlot,
} from "../src/hostPlugin.js";

type Handle = SpawnedPluginWorker & {
  emitStdout(chunk: string): void;
  emitExit(code: number | null): void;
};

/** A worker handle whose exit the test decides. */
function makeHandle(): Handle {
  const stdout: Array<(chunk: string) => void> = [];
  const exit: Array<(info: { code: number | null; signal: NodeJS.Signals | null }) => void> = [];
  return {
    socketPath: null,
    pid: 4242,
    stop: vi.fn(),
    onStdout: (listener) => { stdout.push(listener); },
    onStderr: () => {},
    onExit: (listener) => { exit.push(listener); },
    emitStdout: (chunk) => { for (const listener of stdout) listener(chunk); },
    emitExit: (code) => { for (const listener of exit) listener({ code, signal: null }); },
  } as Handle;
}

function stubSpawn(drive: (handle: Handle) => void) {
  const specs: PluginWorkerSpec[] = [];
  const handle = makeHandle();
  const spawnWorker = vi.fn(async (spec: PluginWorkerSpec) => {
    specs.push(spec);
    // A macrotask, NOT a microtask. The caller subscribes in the continuation
    // of its own `await` on this promise, and that continuation is a microtask
    // queued after anything scheduled from inside here — so a `queueMicrotask`
    // would emit into a handle nobody is listening to yet, and every case would
    // fail as a timeout that says nothing about the code under test.
    setTimeout(() => drive(handle), 0);
    return handle;
  });
  return { spawnWorker, specs, handle };
}

const originalProbePath = process.env.AVE_MEETING_FFPROBE_PATH;
const originalFfmpegPath = process.env.AVE_MEETING_FFMPEG_PATH;
afterEach(() => {
  if (originalProbePath === undefined) delete process.env.AVE_MEETING_FFPROBE_PATH;
  else process.env.AVE_MEETING_FFPROBE_PATH = originalProbePath;
  if (originalFfmpegPath === undefined) delete process.env.AVE_MEETING_FFMPEG_PATH;
  else process.env.AVE_MEETING_FFMPEG_PATH = originalFfmpegPath;
  vi.useRealTimers();
});

describe("worker slots", () => {
  it("hands out the lowest free slot and refuses when the pool is exhausted", () => {
    expect(takeFfmpegWorkerSlot(new Set())).toBe(0);
    expect(takeFfmpegWorkerSlot(new Set([0]))).toBe(1);
    const full = new Set(Array.from({ length: STAGED_UPLOAD_MAX_ACTIVE }, (_u, i) => i));
    // A throw, not a wait. The pool is sized to the active-upload cap, so an
    // exhausted pool means the two numbers have drifted apart — and queueing
    // would hide that behind a hang.
    expect(() => takeFfmpegWorkerSlot(full)).toThrow(/drifted apart/u);
  });

  it("gives the two tools different ids within one slot", () => {
    // They run one after the other on the same upload, and the host releases a
    // worker's reservation when the process is definitively gone — not
    // necessarily by the time the first call resolves. Different ids make that
    // ordering irrelevant rather than a race that shows up under load.
    expect(ffmpegWorkerId("ffprobe", 1)).not.toBe(ffmpegWorkerId("ffmpeg", 1));
    expect(ffmpegWorkerId("ffmpeg", 0)).not.toBe(ffmpegWorkerId("ffmpeg", 1));
    for (const id of [ffmpegWorkerId("ffmpeg", 0), ffmpegWorkerId("ffprobe", 9)]) {
      // The host sanitizes ids into one path segment; anything outside this
      // shape fails closed there instead of here.
      expect(id).toMatch(/^[a-z0-9][a-z0-9._-]{0,127}$/u);
    }
  });
});

describe("runFfprobeDurationSec", () => {
  it("asks the host to spawn it, and reads the duration off stdout", async () => {
    process.env.AVE_MEETING_FFPROBE_PATH = new URL(import.meta.url).pathname;
    const { spawnWorker, specs } = stubSpawn((handle) => {
      handle.emitStdout("12.5\n");
      handle.emitExit(0);
    });

    await expect(
      runFfprobeDurationSec("/tmp/audio.m4a", { workerId: "meeting-ffprobe-0", spawnWorker }),
    ).resolves.toBe(12.5);

    expect(specs).toHaveLength(1);
    const spec = specs[0]!;
    expect(spec.workerId).toBe("meeting-ffprobe-0");
    expect(spec.args).toContain("/tmp/audio.m4a");
    // Declared, not inferred: the host does not read argv to decide filesystem
    // grants, so an input the plugin did not name is an input the tool cannot
    // open.
    expect(spec.allowReadPaths).toContain("/tmp/audio.m4a");
    expect(spec.allowReadPaths).toContain(process.env.AVE_MEETING_FFPROBE_PATH);
    // Reading a duration writes nothing.
    expect(spec.allowWritePaths).toEqual([]);
  });

  it("refuses an unusable duration rather than passing it on", async () => {
    process.env.AVE_MEETING_FFPROBE_PATH = new URL(import.meta.url).pathname;
    const { spawnWorker } = stubSpawn((handle) => {
      handle.emitStdout("N/A\n");
      handle.emitExit(0);
    });
    // Exit code 0 with an unparseable duration. The cap on upload length is
    // enforced against this number, so accepting `NaN` would remove the cap
    // rather than fail.
    await expect(
      runFfprobeDurationSec("/tmp/audio.m4a", { workerId: "meeting-ffprobe-0", spawnWorker }),
    ).rejects.toThrow(/could not determine audio duration/u);
  });

  it("stops the worker when the run fails, instead of leaving it running", async () => {
    process.env.AVE_MEETING_FFPROBE_PATH = new URL(import.meta.url).pathname;
    const { spawnWorker, handle } = stubSpawn(() => {});
    const pending = runFfprobeDurationSec("/tmp/audio.m4a", {
      workerId: "meeting-ffprobe-0",
      spawnWorker,
      timeoutMs: 5,
    });
    await expect(pending).rejects.toThrow(/timed out/u);
    // The assertion that makes the rejection worth anything: a timeout that
    // left the process alive would be a leak the caller cannot see.
    expect(handle.stop).toHaveBeenCalled();
  });

  it("rejects an already-aborted run without spawning anything", async () => {
    const { spawnWorker } = stubSpawn(() => {});
    const controller = new AbortController();
    controller.abort();
    await expect(
      runFfprobeDurationSec("/tmp/audio.m4a", {
        workerId: "meeting-ffprobe-0",
        spawnWorker,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/u);
    expect(spawnWorker).not.toHaveBeenCalled();
  });
});

describe("runFfmpegSegmenter", () => {
  it("grants the segment DIRECTORY, because the files do not exist yet", async () => {
    process.env.AVE_MEETING_FFMPEG_PATH = new URL(import.meta.url).pathname;
    const { spawnWorker, specs } = stubSpawn((handle) => handle.emitExit(0));

    await runFfmpegSegmenter("/tmp/in.m4a", "/tmp/segments/segment-%05d.wav", {
      workerId: "meeting-ffmpeg-0",
      spawnWorker,
    });

    const spec = specs[0]!;
    expect(spec.allowWritePaths).toEqual(["/tmp/segments"]);
    // Naming the pattern would grant a path that never exists — `%05d` is
    // FFmpeg's, not the filesystem's.
    expect(spec.allowWritePaths).not.toContain("/tmp/segments/segment-%05d.wav");
    expect(spec.allowReadPaths).toContain("/tmp/in.m4a");
  });

  it("carries the tool's exit code into the error", async () => {
    process.env.AVE_MEETING_FFMPEG_PATH = new URL(import.meta.url).pathname;
    const { spawnWorker } = stubSpawn((handle) => handle.emitExit(1));
    await expect(
      runFfmpegSegmenter("/tmp/in.m4a", "/tmp/segments/segment-%05d.wav", {
        workerId: "meeting-ffmpeg-0",
        spawnWorker,
      }),
    ).rejects.toThrow(/exited with code 1/u);
  });
});

describe("ffmpeg runtime download", () => {
  const roots: string[] = [];
  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "meeting-ffmpeg-dl-"));
    roots.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Records every call so "it never asked" is assertable, not assumed. */
  function stubFetch(reply: () => Response) {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const hostFetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return reply();
    });
    return { hostFetch, calls };
  }

  const ARCHIVE = "ffmpeg-bytes-stand-in";

  it("asks the host, under the follow policy, and writes what comes back", async () => {
    const out = join(scratch(), "ffmpeg.zip");
    const { hostFetch, calls } = stubFetch(() => new Response(ARCHIVE, { status: 200 }));

    await downloadFile(hostFetch, "https://github.com/o/r/releases/download/latest/a.zip", out);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://github.com/o/r/releases/download/latest/a.zip");
    // The one init field the boundary depends on. The host reads an absent
    // policy as "error", so an omitted `redirect` would fail this download on
    // the release URL's very first hop — and it would fail in production, not
    // here, which is why it is asserted rather than left to the default.
    expect(calls[0]!.init?.redirect).toBe("follow");
    expect(calls[0]!.init).not.toHaveProperty("auth");
    expect(readFileSync(out, "utf8")).toBe(ARCHIVE);
    // No half-written sibling left behind claiming to be a download in flight.
    expect(existsSync(`${out}.part`)).toBe(false);
  });

  it("leaves nothing at the destination when the host answers non-2xx", async () => {
    const out = join(scratch(), "ffmpeg.zip");
    const { hostFetch } = stubFetch(() => new Response("denied", { status: 403 }));

    await expect(downloadFile(hostFetch, "https://github.com/o/r/a.zip", out)).rejects.toThrow(/403/u);

    // The next run has to try again. A zero-byte or partial file here would be
    // taken for the archive by the short-circuit below and never re-fetched.
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.part`)).toBe(false);
  });

  it("does not reach the network at all when the archive is already cached", async () => {
    const out = join(scratch(), "ffmpeg.zip");
    writeFileSync(out, ARCHIVE);
    const { hostFetch, calls } = stubFetch(() => new Response("SHOULD-NOT-BE-FETCHED"));

    await downloadFile(hostFetch, "https://github.com/o/r/a.zip", out);

    expect(calls).toEqual([]);
    expect(readFileSync(out, "utf8")).toBe(ARCHIVE);
  });

  /**
   * The host side of `hostFetch` as a protocol-3 child meets it: each response
   * is buffered across the boundary and refused above 16 MiB
   * (`WIRE_BYTES_MAX`, HostApi protocol design §8), and `Range` is an ordinary
   * header the host forwards on every hop. A server that honours `Range`
   * answers 206 with `Content-Range`; one that does not answers 200 whole.
   */
  const HOST_RESPONSE_CEILING = 16 * 1024 * 1024;
  function rangeServingHost(bodyFor: () => Uint8Array, etagFor: () => string = () => "\"v1\"") {
    const calls: Array<{ range: string | null }> = [];
    const hostFetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const range = new Headers(init?.headers).get("range");
      calls.push({ range });
      const body = bodyFor();
      const etag = etagFor();
      const match = /^bytes=(\d+)-(\d+)$/u.exec(range ?? "");
      const slice = match
        ? { start: Number(match[1]), end: Math.min(Number(match[2]), body.byteLength - 1) }
        : null;
      const bytes = slice ? body.subarray(slice.start, slice.end + 1) : body;
      if (bytes.byteLength > HOST_RESPONSE_CEILING) {
        throw Object.assign(new Error(`${bytes.byteLength} bytes exceeds the boundary limit`), { code: "payload-too-large" });
      }
      return new Response(bytes.slice(), {
        status: slice ? 206 : 200,
        headers: {
          etag,
          ...(slice ? { "content-range": `bytes ${slice.start}-${slice.end}/${body.byteLength}` } : {}),
        },
      });
    });
    return { hostFetch, calls };
  }
  function archiveOf(size: number): Uint8Array {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + (i >>> 13)) & 0xff;
    return bytes;
  }

  it("brings an archive above the host's 16 MiB response ceiling down in Range slices under it", async () => {
    const out = join(scratch(), "ffmpeg.zip");
    const archive = archiveOf(40 * 1024 * 1024 + 123);
    const { hostFetch, calls } = rangeServingHost(() => archive);

    await downloadFile(hostFetch, "https://github.com/o/r/releases/download/latest/a.zip", out);

    expect(Buffer.compare(readFileSync(out), Buffer.from(archive))).toBe(0);
    expect(existsSync(`${out}.part`)).toBe(false);
    expect(calls.length).toBeGreaterThan(2);
    for (const call of calls) expect(call.range).toMatch(/^bytes=\d+-\d+$/u);
  });

  /**
   * A release asset that can be replaced while it downloads: `versions[n]` is
   * what the server holds after `swapAfter[n]` requests. Each version has its
   * own bytes and its own ETag, as a re-uploaded GitHub asset does.
   */
  function replacingHost(versions: Uint8Array[], swapAfter: number[]) {
    let served = 0;
    const current = () => {
      let at = 0;
      for (const limit of swapAfter) if (served > limit) at += 1;
      return Math.min(at, versions.length - 1);
    };
    const host = rangeServingHost(() => versions[current()]!, () => `"v${current() + 1}"`);
    const hostFetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      served += 1;
      return host.hostFetch(input, init);
    });
    return { hostFetch, calls: host.calls };
  }

  it("starts over once from zero when the asset is replaced mid-download", async () => {
    const out = join(scratch(), "ffmpeg.zip");
    const before = archiveOf(20 * 1024 * 1024);
    const after = archiveOf(20 * 1024 * 1024 + 7).map((byte) => byte ^ 0x5a);
    // The first slice is the old build; every request after it sees the new one.
    const { hostFetch, calls } = replacingHost([before, after], [1]);

    await downloadFile(hostFetch, "https://github.com/o/r/releases/download/latest/a.zip", out);

    // Exactly the new build: no slice of the old one spliced in front of it.
    expect(Buffer.compare(readFileSync(out), Buffer.from(after))).toBe(0);
    expect(calls[1]!.range).toMatch(/^bytes=8388608-/u);
    expect(calls[2]!.range).toMatch(/^bytes=0-/u);
    expect(existsSync(`${out}.part`)).toBe(false);
  });

  it("refuses an asset replaced again after the restart, and leaves nothing behind", async () => {
    const out = join(scratch(), "ffmpeg.zip");
    const versions = [0, 1, 2].map((n) => archiveOf(20 * 1024 * 1024).map((byte) => byte ^ n));
    const { hostFetch } = replacingHost(versions, [1, 3]);

    await expect(downloadFile(hostFetch, "https://github.com/o/r/a.zip", out)).rejects.toThrow(/changed/u);

    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.part`)).toBe(false);
  });

  it("treats a changed total size as a replaced asset too", async () => {
    const out = join(scratch(), "ffmpeg.zip");
    const before = archiveOf(20 * 1024 * 1024);
    const after = archiveOf(24 * 1024 * 1024);
    // Same ETag on both sides: only the size tells them apart.
    let served = 0;
    const { hostFetch, calls } = rangeServingHost(() => (served++ === 0 ? before : after));

    await downloadFile(hostFetch, "https://github.com/o/r/a.zip", out);

    expect(Buffer.compare(readFileSync(out), Buffer.from(after))).toBe(0);
    expect(calls[2]!.range).toMatch(/^bytes=0-/u);
  });

  /** One scripted answer per request, in order. */
  function scriptedHost(answers: Array<() => Response>) {
    const calls: Array<{ range: string | null }> = [];
    const hostFetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      calls.push({ range: new Headers(init?.headers).get("range") });
      const next = answers.shift();
      if (!next) throw new Error("no answer scripted for this request");
      return next();
    });
    return { hostFetch, calls };
  }
  const SLICE = 4;
  const partial = (body: string, range: string, etag: string | null = "\"v1\"") =>
    () => new Response(body, { status: 206, headers: { "content-range": range, ...(etag === null ? {} : { etag }) } });

  it("refuses a 200 after the first slice instead of appending a whole body to it", async () => {
    const out = join(scratch(), "ffmpeg.zip");
    const { hostFetch } = scriptedHost([
      partial("abcd", "bytes 0-3/10"),
      () => new Response("abcdefghij", { status: 200, headers: { etag: "\"v1\"" } }),
    ]);

    await expect(downloadFile(hostFetch, "https://github.com/o/r/a.zip", out, SLICE)).rejects.toThrow(/restarted mid-transfer/u);

    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.part`)).toBe(false);
  });

  it("refuses a slice shorter than the range it claims", async () => {
    const out = join(scratch(), "ffmpeg.zip");
    const { hostFetch } = scriptedHost([partial("abcd", "bytes 0-3/10"), partial("ef", "bytes 4-7/10")]);

    await expect(downloadFile(hostFetch, "https://github.com/o/r/a.zip", out, SLICE)).rejects.toThrow(/short slice/u);

    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.part`)).toBe(false);
  });

  it.each([
    ["starts somewhere other than the offset asked for", "bytes 3-6/10"],
    ["is not a byte range at all", "items 4-7/10"],
    ["has an end before its start", "bytes 4-2/10"],
    ["is missing", null],
  ])("refuses a Content-Range that %s", async (_why, range) => {
    const out = join(scratch(), "ffmpeg.zip");
    const second = range === null
      ? () => new Response("efgh", { status: 206, headers: { etag: "\"v1\"" } })
      : partial("efgh", range);
    const { hostFetch } = scriptedHost([partial("abcd", "bytes 0-3/10"), second]);

    await expect(downloadFile(hostFetch, "https://github.com/o/r/a.zip", out, SLICE)).rejects.toThrow(/unexpected range/u);

    expect(existsSync(`${out}.part`)).toBe(false);
  });

  it("surfaces the host's payload-too-large refusal from a server that ignores Range", async () => {
    const out = join(scratch(), "ffmpeg.zip");
    // Range ignored: the whole archive comes back as one 200, which the host
    // refuses to carry across the boundary.
    const archive = archiveOf(HOST_RESPONSE_CEILING + 1);
    const hostFetch = vi.fn(async () => {
      throw Object.assign(new Error(`${archive.byteLength} bytes exceeds the boundary limit`), { code: "payload-too-large" });
    });

    await expect(downloadFile(hostFetch, "https://github.com/o/r/a.zip", out)).rejects.toMatchObject({ code: "payload-too-large" });

    expect(hostFetch).toHaveBeenCalledTimes(1);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.part`)).toBe(false);
  });

  /**
   * The size limit is decided from the first answer's Content-Range total,
   * before a byte is written: an allowed host can serve an asset of gigabytes,
   * and the sha256 check only comes after the whole of it is on disk.
   */
  it.each([
    ["a pinned archive whose size differs from its pin", { exactBytes: 9 }, /is 10 bytes; its pin says 9/u],
    ["an archive above the size cap", { maxBytes: 9 }, /is 10 bytes, above the 9-byte cap/u],
  ])("refuses %s from the first slice, writing nothing", async (_why, size, error) => {
    const out = join(scratch(), "ffmpeg.zip");
    // A body that records being read: pulled only on demand (highWaterMark 0),
    // so "never read" means the slice never reached the disk.
    let bodyRead = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        bodyRead = true;
        controller.enqueue(new TextEncoder().encode("abcd"));
        controller.close();
      },
    }, { highWaterMark: 0 });
    const { hostFetch, calls } = scriptedHost([
      () => new Response(body, { status: 206, headers: { etag: "\"v1\"", "content-range": "bytes 0-3/10" } }),
      partial("efgh", "bytes 4-7/10"),
    ]);

    await expect(downloadFile(hostFetch, "https://github.com/o/r/a.zip", out, SLICE, size)).rejects.toThrow(error);

    expect(calls).toHaveLength(1);
    expect(bodyRead).toBe(false);
    expect(existsSync(`${out}.part`)).toBe(false);
  });

  it("caps a download at OVERRIDE_ARCHIVE_MAX_BYTES unless told otherwise", async () => {
    const out = join(scratch(), "ffmpeg.zip");
    const total = OVERRIDE_ARCHIVE_MAX_BYTES + 1;
    const { hostFetch, calls } = scriptedHost([partial("abcd", `bytes 0-3/${total}`)]);

    await expect(downloadFile(hostFetch, "https://github.com/o/r/a.zip", out, SLICE)).rejects.toThrow(/above the \d+-byte cap/u);

    expect(calls).toHaveLength(1);
    expect(OVERRIDE_ARCHIVE_MAX_BYTES).toBeLessThan(2 * 1024 * 1024 * 1024);
  });

  it("holds a whole-body 200 to the same limit", async () => {
    const out = join(scratch(), "ffmpeg.zip");
    const { hostFetch } = scriptedHost([() => new Response("abcdefghij", { status: 200 })]);

    await expect(downloadFile(hostFetch, "https://github.com/o/r/a.zip", out, SLICE, { exactBytes: 9 })).rejects.toThrow(/is 10 bytes; its pin says 9/u);

    expect(existsSync(out)).toBe(false);
  });

  /**
   * Splicing slices is only sound when every slice provably comes from one
   * representation, and HTTP gives exactly one way to prove it: the same
   * STRONG validator on each (RFC 9110 §15.3.7.3). Without one, the
   * Content-Range total is all that is left, and two builds of the same size
   * pass it. So a download that needs more than one slice and gets no strong
   * ETag is refused rather than spliced on hope.
   */
  it.each([
    ["no ETag", null],
    ["a weak ETag", "W/\"v1\""],
  ])("refuses to splice slices that carry %s", async (_why, etag) => {
    const out = join(scratch(), "ffmpeg.zip");
    const { hostFetch, calls } = scriptedHost([partial("abcd", "bytes 0-3/10", etag), partial("efgh", "bytes 4-7/10", etag)]);

    await expect(downloadFile(hostFetch, "https://github.com/o/r/a.zip", out, SLICE)).rejects.toThrow(/strong ETag/u);

    // Refused on the first slice, before a second one is asked for.
    expect(calls).toHaveLength(1);
    expect(existsSync(`${out}.part`)).toBe(false);
  });

  it("takes an archive that fits in one slice without asking for a validator", async () => {
    const out = join(scratch(), "ffmpeg.zip");
    const { hostFetch } = scriptedHost([partial("abc", "bytes 0-2/3", null)]);

    await downloadFile(hostFetch, "https://github.com/o/r/a.zip", out, SLICE);

    expect(readFileSync(out, "utf8")).toBe("abc");
  });

  it("takes a whole small archive from a server that ignores Range", async () => {
    const out = join(scratch(), "ffmpeg.zip");
    const { hostFetch, calls } = stubFetch(() => new Response(ARCHIVE, { status: 200 }));

    await downloadFile(hostFetch, "https://github.com/o/r/a.zip", out);

    expect(calls).toHaveLength(1);
    expect(readFileSync(out, "utf8")).toBe(ARCHIVE);
  });

  it("discards a stale .part rather than appending to it", async () => {
    const dir = scratch();
    const out = join(dir, "ffmpeg.zip");
    writeFileSync(`${out}.part`, "interrupted-earlier-run");
    const { hostFetch } = stubFetch(() => new Response(ARCHIVE, { status: 200 }));

    await downloadFile(hostFetch, "https://github.com/o/r/a.zip", out);

    // Exactly the new bytes. Concatenation would produce an archive that
    // extracts to garbage, and the extractor's error would point at the wrong
    // thing entirely.
    expect(readFileSync(out, "utf8")).toBe(ARCHIVE);
  });
});

describe("ffmpeg runtime archive integrity", () => {
  const roots: string[] = [];
  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "meeting-ffmpeg-sum-"));
    roots.push(dir);
    return dir;
  }
  const savedEnv = { ...process.env };
  afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (key.startsWith("AVE_MEETING_FFMPEG")) delete process.env[key];
    for (const [key, value] of Object.entries(savedEnv)) if (key.startsWith("AVE_MEETING_FFMPEG")) process.env[key] = value;
  });

  const ARCHIVE = Buffer.from("pretend this is an FFmpeg archive");
  const ARCHIVE_SHA = createHash("sha256").update(ARCHIVE).digest("hex");
  const MIRROR = "https://github.com/acme/ffmpeg-mirror/releases/download/build-7/ffmpeg-acme.zip";
  const PINNED = { artifactUrl: "https://github.com/o/r/releases/download/t/pinned.zip", sha256: "a".repeat(64) };

  /**
   * A release that serves its `checksums.sha256` and its archive, the way the
   * host hands them to a protocol-3 child. Every request is recorded.
   */
  function releaseHost(checksums: string | null, archive: Buffer = ARCHIVE) {
    const calls: Array<{ url: string; redirect: RequestInit["redirect"] }> = [];
    const hostFetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, redirect: init?.redirect });
      if (url.endsWith("/checksums.sha256")) {
        return checksums === null ? new Response("Not Found", { status: 404 }) : new Response(checksums, { status: 200 });
      }
      return new Response(new Uint8Array(archive), {
        status: 206,
        headers: { etag: "\"v1\"", "content-range": `bytes 0-${archive.byteLength - 1}/${archive.byteLength}` },
      });
    });
    return { hostFetch, calls };
  }

  it("takes a pinned artifact's sha256 from the source, without asking the server", async () => {
    const { hostFetch, calls } = releaseHost(null);

    await expect(resolveArchiveSha256(hostFetch, PINNED.artifactUrl, PINNED)).resolves.toBe(PINNED.sha256);

    expect(calls).toEqual([]);
  });

  it("reads an overridden artifact's sha256 from its release's checksums.sha256, through the host", async () => {
    const { hostFetch, calls } = releaseHost(`${"b".repeat(64)}  other.zip\n${ARCHIVE_SHA}  ffmpeg-acme.zip\n`);

    await expect(resolveArchiveSha256(hostFetch, MIRROR, PINNED)).resolves.toBe(ARCHIVE_SHA);

    expect(calls).toEqual([{
      url: "https://github.com/acme/ffmpeg-mirror/releases/download/build-7/checksums.sha256",
      redirect: "follow",
    }]);
  });

  it.each([
    ["has no entry for the archive", `${"b".repeat(64)}  other.zip\n`, /no sha256 for ffmpeg-acme\.zip/u],
    ["lists the archive twice with different sums", `${ARCHIVE_SHA}  ffmpeg-acme.zip\n${"c".repeat(64)}  ffmpeg-acme.zip\n`, /more than one sha256 for ffmpeg-acme\.zip/u],
    ["is missing", null, /checksums\.sha256 .*\(404\)/u],
  ])("refuses an override whose checksums.sha256 %s", async (_why, checksums, error) => {
    const { hostFetch } = releaseHost(checksums);

    await expect(resolveArchiveSha256(hostFetch, MIRROR, PINNED)).rejects.toThrow(error);
  });

  it("accepts an archive that hashes to its sha256 and refuses one that does not", async () => {
    const archive = join(scratch(), "a.zip");
    writeFileSync(archive, ARCHIVE);

    await expect(verifyArchiveSha256(archive, ARCHIVE_SHA)).resolves.toBeUndefined();
    await expect(verifyArchiveSha256(archive, ARCHIVE_SHA.toUpperCase())).resolves.toBeUndefined();
    await expect(verifyArchiveSha256(archive, "d".repeat(64))).rejects.toThrow(/does not match its sha256/u);
  });

  it("pins every platform to a fixed release tag and a sha256", () => {
    const artifacts = pinnedFfmpegArtifacts();
    expect(artifacts.map((artifact) => artifact.platform).sort()).toEqual(
      ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"],
    );
    for (const artifact of artifacts) {
      // `latest` is re-uploaded daily, so a sum pinned in source could never
      // match it for long. A dated tag holds still.
      expect(artifact.artifactUrl).not.toMatch(/\/releases\/download\/latest\//u);
      expect(artifact.artifactUrl).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+$/u);
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  /** Every process the install asks for fails, so nothing is ever extracted or run. */
  function failingSpawn() {
    const commands: string[] = [];
    const spawnWorker = vi.fn(async (spec: PluginWorkerSpec) => {
      commands.push(spec.command);
      const handle = makeHandle();
      setTimeout(() => handle.emitExit(1), 0);
      return handle;
    });
    return { spawnWorker, commands };
  }
  const EXTRACTORS = ["tar", "unzip", "powershell.exe", "pwsh"];
  function installInto(dataDir: string, hostFetch: MediatedFetch, spawnWorker: MediatedSpawn) {
    process.env.AVE_MEETING_FFMPEG_VENDOR_URL = MIRROR;
    return ensureFfmpegRuntime({ pluginDataDir: dataDir, pluginDistDir: join(dataDir, "dist"), hostFetch, spawnWorker });
  }
  const leftovers = (dataDir: string) => {
    const downloads = join(dataDir, "vendor", "_downloads");
    return existsSync(downloads) ? readdirSync(downloads) : [];
  };

  it("refuses an archive that does not match its sha256 before extracting it, and deletes it", async () => {
    const dataDir = scratch();
    const { hostFetch } = releaseHost(`${"e".repeat(64)}  ffmpeg-acme.zip\n`);
    const { spawnWorker, commands } = failingSpawn();

    await expect(installInto(dataDir, hostFetch, spawnWorker)).rejects.toThrow(/does not match its sha256/u);

    expect(commands.filter((command) => EXTRACTORS.includes(command))).toEqual([]);
    expect(leftovers(dataDir)).toEqual([]);
  });

  it("does not download an archive its release has no sha256 for", async () => {
    const dataDir = scratch();
    const { hostFetch, calls } = releaseHost(`${"b".repeat(64)}  other.zip\n`);
    const { spawnWorker } = failingSpawn();

    await expect(installInto(dataDir, hostFetch, spawnWorker)).rejects.toThrow(/no sha256 for ffmpeg-acme\.zip/u);

    expect(calls.map((call) => call.url)).not.toContain(MIRROR);
    expect(leftovers(dataDir)).toEqual([]);
  });

  it("extracts a verified archive, and deletes it when the extraction fails", async () => {
    const dataDir = scratch();
    const { hostFetch } = releaseHost(`${ARCHIVE_SHA}  ffmpeg-acme.zip\n`);
    const { spawnWorker, commands } = failingSpawn();

    await expect(installInto(dataDir, hostFetch, spawnWorker)).rejects.toThrow(/exited with code 1|could not extract/u);

    // It got as far as the extractor, so the checksum let it through ...
    expect(commands.some((command) => EXTRACTORS.includes(command))).toBe(true);
    // ... and the archive the extractor choked on is not kept for the next run.
    expect(leftovers(dataDir)).toEqual([]);
  });

  it("pins every platform's archive size alongside its sha256", () => {
    for (const artifact of pinnedFfmpegArtifacts()) {
      expect(Number.isSafeInteger(artifact.size) && artifact.size > 0).toBe(true);
      // Every pinned archive fits under the cap an override is held to.
      expect(artifact.size).toBeLessThan(OVERRIDE_ARCHIVE_MAX_BYTES);
    }
  });

  it("holds the pinned archive to its pinned size from the first slice", async () => {
    const dataDir = scratch();
    // No override: the platform's pinned artifact. This server's archive is
    // not that size, which the first Content-Range already says.
    const { hostFetch, calls } = releaseHost(null);
    const { spawnWorker } = failingSpawn();

    await expect(ensureFfmpegRuntime({ pluginDataDir: dataDir, pluginDistDir: join(dataDir, "dist"), hostFetch, spawnWorker }))
      .rejects.toThrow(/its pin says \d+/u);

    expect(calls).toHaveLength(1);
    expect(leftovers(dataDir)).toEqual([]);
  });

  it("refuses an override above the size cap from the first slice", async () => {
    const dataDir = scratch();
    const huge = 2 * 1024 * 1024 * 1024;
    const archiveCalls: string[] = [];
    const hostFetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/checksums.sha256")) return new Response(`${ARCHIVE_SHA}  ffmpeg-acme.zip\n`, { status: 200 });
      archiveCalls.push(url);
      return new Response(new Uint8Array(8), { status: 206, headers: { etag: "\"v1\"", "content-range": `bytes 0-7/${huge}` } });
    });
    const { spawnWorker } = failingSpawn();

    await expect(installInto(dataDir, hostFetch, spawnWorker)).rejects.toThrow(/above the \d+-byte cap/u);

    expect(archiveCalls).toHaveLength(1);
    expect(leftovers(dataDir)).toEqual([]);
  });

  it("runs one install for callers that name one data directory two ways", async () => {
    const dataDir = scratch();
    // The same physical directory, reached through a symlink: path.resolve
    // keeps them apart, the filesystem does not.
    const link = join(scratch(), "data-link");
    symlinkSync(dataDir, link);
    const { hostFetch, calls } = releaseHost(`${ARCHIVE_SHA}  ffmpeg-acme.zip\n`);
    const { spawnWorker } = failingSpawn();

    const results = await Promise.allSettled([
      installInto(dataDir, hostFetch, spawnWorker),
      installInto(link, hostFetch, spawnWorker),
    ]);

    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(calls.map((call) => call.url)).toEqual([
      "https://github.com/acme/ffmpeg-mirror/releases/download/build-7/checksums.sha256",
      MIRROR,
    ]);
  });

  it("runs one install for concurrent callers instead of two on the same archive", async () => {
    const dataDir = scratch();
    const { hostFetch, calls } = releaseHost(`${ARCHIVE_SHA}  ffmpeg-acme.zip\n`);
    const { spawnWorker } = failingSpawn();

    const results = await Promise.allSettled([
      installInto(dataDir, hostFetch, spawnWorker),
      installInto(dataDir, hostFetch, spawnWorker),
    ]);

    // Both callers get the one install's verdict ...
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    // ... and there was one install: one sum looked up, one archive fetched.
    // Two would share _downloads/<archive> — appending to the same .part, or
    // one's cleanup deleting the archive the other is verifying.
    expect(calls.map((call) => call.url)).toEqual([
      "https://github.com/acme/ffmpeg-mirror/releases/download/build-7/checksums.sha256",
      MIRROR,
    ]);
  });
});

describe("FFmpeg runtime check at startup", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * The host as a replacement generation meets it: until the generation is
   * published, `spawnWorker` and `hostFetch` are refused with
   * `plugin_hostapi_denied` ("unavailable while a replacement generation is
   * preparing"), and each refusal is a WARN line in the host log.
   */
  function preparingHost() {
    let published = false;
    let runtimeAvailable = false;
    const denied: string[] = [];
    const deny = (what: string) => {
      denied.push(what);
      return Object.assign(new Error(`${what} unavailable while a replacement generation is preparing`), { code: "plugin_hostapi_denied" });
    };
    const spawnWorker = vi.fn(async (spec: PluginWorkerSpec) => {
      if (!published) throw deny("spawnWorker");
      // Only version probes recover; actual audio work still fails without
      // invoking a real FFmpeg binary or a transcription provider.
      const handle = makeHandle();
      setTimeout(() => handle.emitExit(runtimeAvailable && spec.args?.[0] === "-version" ? 0 : 1), 0);
      return handle;
    });
    const hostFetch = vi.fn(async () => {
      if (!published) throw deny("hostFetch");
      return new Response("not found", { status: 404 });
    });
    const logEvent = vi.fn();
    const root = mkdtempSync(join(tmpdir(), "meeting-ffmpeg-startup-"));
    const context = {
      pluginId: "meeting",
      pluginRoot: root,
      hostRoot: root,
      pluginDataDir: root,
      log: () => { /* no-op */ },
      hostApi: {
        emitEvent: () => { /* no-op */ },
        onEvent: () => { /* no-op */ },
        getSecret: () => null,
        logEvent,
        onShutdown: () => { /* no-op */ },
        spawnWorker,
        hostFetch,
      },
    };
    return {
      context, spawnWorker, hostFetch, logEvent, denied, root,
      publish: () => { published = true; },
      installRuntime: () => { runtimeAvailable = true; },
    };
  }

  it.each(["0", "1"])("defers FFmpeg worker and download calls until publication (auto-install=%s)", async (autoInstall) => {
    // The check is skipped under vitest by default; this case is about when it runs.
    vi.stubEnv("VITEST", "");
    // The download-enabled case must exercise hostFetch too. Its stub returns
    // 404, so both cases settle without network access or an installed binary.
    vi.stubEnv("AVE_MEETING_FFMPEG_AUTO_INSTALL", autoInstall);
    const host = preparingHost();
    const plugin = await createPlugin(host.context as unknown as Parameters<typeof createPlugin>[0]);
    try {
      // The factory has returned; give anything it started a moment to reach the host.
      await new Promise((settle) => setTimeout(settle, 20));

      expect(host.denied).toEqual([]);
      expect(host.spawnWorker).not.toHaveBeenCalled();
      expect(host.hostFetch).not.toHaveBeenCalled();

      host.publish();
      await plugin.onPublished();
      await vi.waitFor(() => {
        expect(host.logEvent).toHaveBeenCalledWith("warn", "meeting_ffmpeg_runtime.unavailable", expect.anything());
      });

      // It did check — the PATH probe went to the host — and nothing it asked
      // for was refused for being too early.
      expect(host.spawnWorker).toHaveBeenCalled();
      expect(host.hostFetch.mock.calls.length).toBe(autoInstall === "1" ? 1 : 0);
      expect(host.denied).toEqual([]);
    } finally {
      await plugin.stop();
      rmSync(host.root, { recursive: true, force: true });
    }
  });

  async function stageAudio(plugin: Awaited<ReturnType<typeof createPlugin>>, sessionId: string) {
    const staged = await plugin.handlers.meeting_stage_upload_begin({
      sessionId,
      file: { name: "meeting.wav", mimeType: "audio/wav", size: 1 },
    });
    if (!staged.ok || !("uploadId" in staged)) throw new Error("could not stage test audio");
    await plugin.handlers.meeting_stage_upload_chunk({
      uploadId: staged.uploadId, offset: 0, bytesBase64: "AA==",
    });
    return staged.uploadId;
  }

  it("checks on first use after activation even if onPublished has not run", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("AVE_MEETING_FFMPEG_AUTO_INSTALL", "0");
    const host = preparingHost();
    const plugin = await createPlugin(host.context as unknown as Parameters<typeof createPlugin>[0]);
    try {
      expect(host.spawnWorker).not.toHaveBeenCalled();
      host.publish();
      const uploadId = await stageAudio(plugin, "first-use");
      await expect(plugin.handlers.meeting_stage_upload_finish({ uploadId })).rejects.toThrow(/FFmpeg runtime is missing/u);
      // One initial attempt and one retry, both after activation.
      expect(host.spawnWorker.mock.calls.map(([spec]) => [spec.command, spec.args])).toEqual([
        ["ffmpeg", ["-version"]], ["ffmpeg", ["-version"]],
      ]);
      expect(host.denied).toEqual([]);
      await plugin.onPublished();
      expect(host.spawnWorker).toHaveBeenCalledTimes(2);
    } finally {
      await plugin.stop();
      rmSync(host.root, { recursive: true, force: true });
    }
  });

  it("shares the startup attempt and a concurrent first-use retry after failure", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("AVE_MEETING_FFMPEG_AUTO_INSTALL", "0");
    const host = preparingHost();
    const plugin = await createPlugin(host.context as unknown as Parameters<typeof createPlugin>[0]);
    try {
      host.publish();
      await plugin.onPublished();
      await plugin.onPublished();
      await vi.waitFor(() => {
        expect(host.logEvent).toHaveBeenCalledWith("warn", "meeting_ffmpeg_runtime.unavailable", expect.anything());
      });
      expect(host.spawnWorker).toHaveBeenCalledTimes(1);

      host.installRuntime();
      const uploads = await Promise.all([stageAudio(plugin, "retry-a"), stageAudio(plugin, "retry-b")]);
      const finished = await Promise.allSettled(uploads.map((uploadId) => plugin.handlers.meeting_stage_upload_finish({ uploadId })));
      for (const result of finished) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") expect(result.reason.message).toMatch(/ffprobe.*exited with code 1/u);
      }
      const probes = host.spawnWorker.mock.calls.filter(([spec]) => spec.args?.[0] === "-version");
      expect(probes.map(([spec]) => spec.command)).toEqual(["ffmpeg", "ffmpeg", "ffprobe"]);
      expect(host.logEvent).toHaveBeenCalledWith("info", "meeting_ffmpeg_runtime.ready", expect.objectContaining({ source: "path" }));
      expect(host.hostFetch).not.toHaveBeenCalled();
      expect(host.denied).toEqual([]);
    } finally {
      await plugin.stop();
      rmSync(host.root, { recursive: true, force: true });
    }
  });
});

describe("ffmpegRuntime source shape", () => {
  const source = readFileSync(new URL("../src/ffmpegRuntime.ts", import.meta.url), "utf8");

  // Axis 1 has no runtime signal in this plugin's tests: a reintroduced
  // `https.get` would succeed against the real internet and every case here
  // would still pass. Only the import form notices.
  it.each(["node:https", "node:http", "undici", "node-fetch"])(
    "does not import %s",
    (mod) => {
      expect(source).not.toMatch(new RegExp(`from\\s+["']${mod}["']`, "u"));
    },
  );

  it("acquires the runtime through the injected host fetch", () => {
    // The positive half. Without it, deleting the download outright would read
    // as a clean pass above while removing the capability entirely.
    expect(source).toContain("await downloadFile(opts.hostFetch,");
  });
});

describe("runMediatedCommand", () => {
  it("hands the host the command, the args and the grants, and nothing implicit", async () => {
    const { spawnWorker, specs } = stubSpawn((handle) => handle.emitExit(0));

    await runMediatedCommand({
      spawnWorker,
      workerId: "meeting-install-tar-1",
      command: "tar",
      args: ["-xf", "/cache/a.tar.xz", "-C", "/dest"],
      readPaths: ["/cache/a.tar.xz"],
      writePaths: ["/dest"],
      timeoutMs: 1_000,
    });

    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      workerId: "meeting-install-tar-1",
      command: "tar",
      args: ["-xf", "/cache/a.tar.xz", "-C", "/dest"],
      allowReadPaths: ["/cache/a.tar.xz"],
      allowWritePaths: ["/dest"],
    });
  });

  it("grants nothing when nothing was named", async () => {
    const { spawnWorker, specs } = stubSpawn((handle) => handle.emitExit(0));

    await runMediatedCommand({
      spawnWorker,
      workerId: "meeting-install-probe-ffmpeg-1",
      command: "ffmpeg",
      args: ["-version"],
      timeoutMs: 1_000,
    });

    // Empty, not absent-and-inferred. The host grants from this list and never
    // from argv, so a run that names no paths gets no reach — which is what
    // makes a `-version` probe safe to run against PATH.
    expect(specs[0]!.allowReadPaths).toEqual([]);
    expect(specs[0]!.allowWritePaths).toEqual([]);
  });

  it("returns what the tool printed", async () => {
    const { spawnWorker } = stubSpawn((handle) => {
      handle.emitStdout("ffmpeg version 6.1.1\n");
      handle.emitExit(0);
    });

    const { stdout } = await runMediatedCommand({
      spawnWorker,
      workerId: "w",
      command: "ffmpeg",
      args: ["-version"],
      timeoutMs: 1_000,
    });

    expect(stdout).toContain("ffmpeg version 6.1.1");
  });

  it("carries a non-zero exit into the error and stops the worker", async () => {
    const { spawnWorker, handle } = stubSpawn((h) => h.emitExit(2));

    await expect(runMediatedCommand({
      spawnWorker,
      workerId: "w",
      command: "unzip",
      args: ["-q", "/cache/a.zip"],
      timeoutMs: 1_000,
      label: "unzip",
    })).rejects.toThrow(/unzip exited with code 2/u);

    // A rejection that leaves the process running turns a failed extraction
    // into a leak the installer cannot see.
    expect(handle.stop).toHaveBeenCalled();
  });

  it("distinguishes a failure to START from a failure to RUN", async () => {
    const spawnWorker = vi.fn(async () => {
      throw new Error("ENOENT");
    });

    const failure = await runMediatedCommand({
      spawnWorker: spawnWorker as never,
      workerId: "w",
      command: "otool",
      args: ["-L", "/x"],
      timeoutMs: 1_000,
    }).catch((err: unknown) => err);

    // The type is the signal, not the message. `runFfmpegTool` turns exactly
    // this case into "please install FFmpeg" and must NOT do that for a tool
    // that ran and rejected its arguments.
    expect(failure).toBeInstanceOf(MediatedSpawnStartError);
    expect(String(failure)).toMatch(/otool failed to start/u);
  });

  it("refuses an already-aborted run without asking the host at all", async () => {
    const { spawnWorker, specs } = stubSpawn((handle) => handle.emitExit(0));

    await expect(runMediatedCommand({
      spawnWorker,
      workerId: "w",
      command: "tar",
      args: [],
      timeoutMs: 1_000,
      signal: AbortSignal.abort(),
    })).rejects.toThrow(/aborted/u);

    // The control. Spawning and then killing would still have started a
    // process, which is the thing an aborted run is supposed to avoid.
    expect(specs).toEqual([]);
  });

  it("stops the worker when the run outlives its timeout", async () => {
    // Never exits: this is the case the timer exists for.
    const { spawnWorker, handle } = stubSpawn(() => {});

    await expect(runMediatedCommand({
      spawnWorker,
      workerId: "w",
      command: "tar",
      args: [],
      timeoutMs: 10,
      label: "tar",
    })).rejects.toThrow(/tar timed out after 10ms/u);

    expect(handle.stop).toHaveBeenCalled();
  });
});

describe("ffmpegRuntime process shape", () => {
  const source = readFileSync(new URL("../src/ffmpegRuntime.ts", import.meta.url), "utf8");

  // Axis 3 has NO runtime signal. ASRT's generated Seatbelt profile carries
  // `(allow process-exec)`, so a reintroduced `spawn` would not fail — it would
  // run inside the same jail, with no grants declared and nothing to notice.
  // Only the import form catches it. Matched as an IMPORT rather than as the
  // word `spawn`, which appears legitimately throughout as `spawnWorker`.
  it("does not import node:child_process", () => {
    expect(source).not.toMatch(/from\s+["']node:child_process["']/u);
  });

  it.each(["tar", "unzip", "otool", "install_name_tool"])(
    "starts %s through the host rather than directly",
    (tool) => {
      // The positive half: deleting the installer outright would satisfy the
      // negative assertion above while removing the capability entirely.
      expect(source).toMatch(new RegExp(`command: "${tool}"`, "u"));
    },
  );
});

describe("the recorder card does not capture", () => {
  const card = readFileSync(new URL("../src/ui/recorder-card.js", import.meta.url), "utf8");

  // This is the axis with no runtime signal at all. A reintroduced
  // `getUserMedia` here would WORK — the card is a renderer, it has the API,
  // and nothing in this suite would go red. What it would cost is the
  // confinement argument: a plugin renderer that captures is a renderer
  // outside the sandbox, which is the whole reason the host took the capture.
  it.each(["getUserMedia", "getDisplayMedia", "AudioContext", "audioWorklet", "AudioWorkletNode"])(
    "does not use %s",
    (api) => {
      expect(card).not.toContain(api);
    },
  );

  it("carries no audio to its plugin", () => {
    // There is no preload bridge left to check — the card reaches its plugin
    // over the host's ordinary tool bridge, and `pushChunk` was the one
    // channel of the twelve that carried a payload. Its absence from the card
    // is what makes "it exchanges UI state, not audio" a fact rather than a
    // description, so the assertion moves here rather than disappearing.
    expect(card).not.toContain("push_chunk");
    expect(card).not.toContain("push-chunk");
    expect(card).not.toContain("enable-loopback-audio");
  });

  it("asks the host for the things it used to take", () => {
    // The positive half: deleting the recorder outright would satisfy every
    // assertion above while removing the feature.
    expect(card).toContain('callTool("meeting_recorder_microphones"');
    expect(card).toContain('callTool("meeting_recorder_levels"');
    expect(card).toContain("host.listMicrophones()");
  });
});
