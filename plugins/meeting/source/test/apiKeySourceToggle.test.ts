/**
 * STT key resolution unit tests — apiKeySource SOT + SDK v5.13 resolveApiKey contract.
 *
 * Validates the meeting plugin's two supported STT key paths:
 *   - apiKeySource=plugin reads plugin.<id>.sttApiKey from host keychain
 *   - apiKeySource=host uses host resolveApiKey, key is bearer()'d into fetch
 *   - resolveApiKey absent (v5.4 host) + host mode → hard fail (no MockSttProvider)
 *   - resolveApiKey ok:false → meeting.error emitted with reason
 *   - signal wired into Whisper fetch (abort propagates)
 *   - release() called when meeting finalizes
 *   - sttDiagnostic shape — no key material or secret paths
 *
 * Note: createPlugin selects OpenAIWhisperSttProvider when a key resolves
 * (plugin sttApiKey or resolveApiKey). MockSttProvider is no longer auto-selected;
 * pipeline-level instance fixtures still use it explicitly.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import createPlugin from "../src/hostPlugin.js";
import type { HostFetchInit, PluginHostApi, PluginWorkerSpec, ResolveApiKeyResult, SpawnedPluginWorker } from "@ave/plugin-contract";

type HostApi = {
  emitEvent: (type: string, data?: unknown) => void;
  onEvent: (type: string, handler: (data: unknown) => void) => void;
  getSecret: (key: string) => string | null | Promise<string | null>;
  logEvent?: (level: "error" | "info" | "warn", message: string, data?: unknown) => void;
  onShutdown?: (h: () => void | Promise<void>) => void;
  config?: {
    get: (key: string) => unknown;
    onChange?: <T = unknown>(key: string, callback: (value: T | undefined) => void) => () => void;
  };
  resolveApiKey?: PluginHostApi["resolveApiKey"];
  callLlm?: (prompt: string, options?: { maxTokens?: number; systemPrompt?: string }) => Promise<string>;
  hostFetch?: PluginHostApi["hostFetch"];
  spawnWorker?: PluginHostApi["spawnWorker"];
};

function makeContext(opts: {
  config?: Record<string, unknown>;
  resolveApiKey?: HostApi["resolveApiKey"];
  emitEvent?: (type: string, data?: unknown) => void;
  secrets?: Record<string, string>;
  /**
   * Model the host resolving the keychain asynchronously. The plugin must read
   * the same value either way — reading without awaiting yields a Promise,
   * which the `typeof value === "string"` guard silently discards as "no key".
   */
  asyncSecrets?: boolean;
  callLlm?: (prompt: string, options?: { maxTokens?: number; systemPrompt?: string }) => Promise<string>;
  logSink?: (msg: string) => void;
  spawnWorker?: PluginHostApi["spawnWorker"];
}) {
  let shutdownHandler: (() => void | Promise<void>) | undefined;
  const root = mkdtempSync(join(tmpdir(), "ave-meeting-resolveApiKey-"));
  mkdirSync(join(root, "sessions"), { recursive: true });
  const logEvent = vi.fn<(level: "error" | "info" | "warn", message: string, data?: unknown) => void>();
  const logEventFn: (level: "error" | "info" | "warn", message: string, data?: unknown) => void =
    (level, message, data) => logEvent(level, message, data);
  const emitEvent = opts.emitEvent ?? (() => {});

  const hostApi: HostApi = {
    emitEvent,
    onEvent: () => {},
    getSecret: (key) =>
      opts.asyncSecrets
        ? Promise.resolve(opts.secrets?.[key] ?? null)
        : (opts.secrets?.[key] ?? null),
    logEvent: logEventFn,
    onShutdown: (handler) => { shutdownHandler = handler; },
    config: {
      get: (key: string) => opts.config?.[key],
      onChange: () => () => {},
    },
    ...(opts.resolveApiKey ? { resolveApiKey: opts.resolveApiKey } : {}),
    ...(opts.callLlm ? { callLlm: opts.callLlm } : {}),
    ...(opts.spawnWorker ? { spawnWorker: opts.spawnWorker } : {}),
    // Tier A: STT egresses ONLY through hostApi.hostFetch (no direct net). The
    // real host backs this with Electron net; here it delegates to the spied
    // globalThis.fetch so existing url/init/bearer assertions still observe the
    // STT request. Read globalThis.fetch at call time so per-test spies apply.
    hostFetch: (input, init) =>
      globalThis.fetch(input as Parameters<typeof fetch>[0], init),
  };

  return {
    root,
    logEvent,
    shutdown: async () => { await shutdownHandler?.(); },
    context: {
      pluginId: "meeting",
      pluginRoot: root,
      hostRoot: root,
      pluginDataDir: root,
      log: opts.logSink ?? ((_msg: string) => {}),
      hostApi,
    },
  };
}

describe("STT key resolution — resolveApiKey contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("attaches one host lease without a caller credential header", async () => {
    const requests: HostFetchInit[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init) requests.push(init);
      return {
        ok: true,
        json: async () => ({ segments: [{ id: 1, start: 0, end: 1, text: "host" }] }),
      } as Response;
    });

    const resolveApiKey = vi.fn(async (_opts: { purpose: string; vendor?: string; signal?: AbortSignal }): Promise<ResolveApiKeyResult> => ({
      ok: true,
      vendor: "openai",
      exposure: "lease", leaseId: "lease-test", onClosed: () => () => {},
      release: vi.fn(async () => {}),
    }));

    const { context } = makeContext({ resolveApiKey });
    const plugin = await createPlugin(context);

    await plugin.handlers.batch_processing_audio({ sessionId: "s-host" });
    await plugin.handlers.meeting_push_chunk({
      sessionId: "s-host",
      chunk: {
        pcm16leMono: Array.from({ length: 320 }, () => 0),
        sampleRate: 16000,
        startSec: 0,
        endSec: 0.02,
      },
    });

    expect(resolveApiKey).toHaveBeenCalledTimes(1);
    expect(resolveApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "stt" }),
    );
    // vendor MUST NOT be passed — host defaults to user's active LLM
    // provider so Azure-only users aren't silently routed to OpenAI public.
    const callArg = resolveApiKey.mock.calls[0]?.[0] as { vendor?: string; signal?: AbortSignal } | undefined;
    expect(callArg?.vendor).toBeUndefined();
    expect(callArg?.signal).toBeInstanceOf(AbortSignal);

    expect(requests[0]?.auth).toEqual({ lease: "lease-test" });
    expect(requests[0]?.headers).toBeUndefined();
  }, 20_000);

  it("segments direct and staged uploads before leased file STT", async () => {
    const priorFfmpeg = process.env.AVE_MEETING_FFMPEG_PATH;
    const priorFfprobe = process.env.AVE_MEETING_FFPROBE_PATH;
    process.env.AVE_MEETING_FFMPEG_PATH = new URL(import.meta.url).pathname;
    process.env.AVE_MEETING_FFPROBE_PATH = new URL(import.meta.url).pathname;
    try {
      const requests: HostFetchInit[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        if (init) requests.push(init);
        return new Response(JSON.stringify({ text: "transcribed" }), { status: 200 });
      });
      const spawnWorker = vi.fn(async (spec: PluginWorkerSpec): Promise<SpawnedPluginWorker> => {
        const stdout: Array<(chunk: string) => void> = [];
        const exit: Array<(info: { code: number | null; signal: NodeJS.Signals | null }) => void> = [];
        const worker: SpawnedPluginWorker = {
          socketPath: null, pid: 12345,
          stop: async () => {},
          onStdout: (listener) => { stdout.push(listener); },
          onStderr: () => {},
          onExit: (listener) => { exit.push(listener); },
        };
        setTimeout(() => {
          if (spec.workerId.includes("ffprobe")) {
            for (const listener of stdout) listener("1\n");
          } else {
            const segment = (spec.args?.at(-1) ?? "").replace("%05d", "00000");
            const wav = Buffer.alloc(46);
            wav.write("RIFF", 0, "ascii");
            wav.writeUInt32LE(38, 4);
            wav.write("WAVEfmt ", 8, "ascii");
            wav.writeUInt32LE(16, 16);
            wav.writeUInt16LE(1, 20);
            wav.writeUInt16LE(1, 22);
            wav.writeUInt32LE(16_000, 24);
            wav.writeUInt32LE(32_000, 28);
            wav.writeUInt16LE(2, 32);
            wav.writeUInt16LE(16, 34);
            wav.write("data", 36, "ascii");
            wav.writeUInt32LE(2, 40);
            writeFileSync(segment, wav);
          }
          for (const listener of exit) listener({ code: 0, signal: null });
        }, 0);
        return worker;
      });
      const resolveApiKey = vi.fn(async (): Promise<ResolveApiKeyResult> => ({
        ok: true, exposure: "lease", leaseId: "lease-upload", vendor: "openai",
        release: async () => {}, onClosed: () => () => {},
      }));
      const { context } = makeContext({ resolveApiKey, spawnWorker });
      const plugin = await createPlugin(context);
      const result = await plugin.handlers.meeting_upload_file({
        sessionId: "direct-17mb",
        file: { name: "recording.wav", bytesBase64: Buffer.alloc(17 * 1024 * 1024).toString("base64") },
      });
      expect(result).toMatchObject({ sessionId: "direct-17mb", mode: "upload" });
      expect(spawnWorker).toHaveBeenCalledTimes(2);
      expect(resolveApiKey).toHaveBeenCalledTimes(1);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.auth).toEqual({ lease: "lease-upload" });
      expect(requests[0]?.headers).toBeUndefined();
      const body = requests[0]?.body;
      expect(body).toBeInstanceOf(FormData);
      expect((body as FormData).get("file")).toBeInstanceOf(Blob);
      expect(((body as FormData).get("file") as Blob).size).toBeLessThan(15 * 1024 * 1024);

      const stagedBytes = Buffer.alloc(26 * 1024 * 1024);
      const begin = await plugin.handlers.meeting_stage_upload_begin({
        sessionId: "staged-26mb", file: { name: "long.wav", size: stagedBytes.length },
      });
      expect(begin).toMatchObject({ ok: true });
      const uploadId = (begin as { uploadId: string }).uploadId;
      for (let offset = 0; offset < stagedBytes.length; offset += 2 * 1024 * 1024) {
        await plugin.handlers.meeting_stage_upload_chunk({
          uploadId, offset,
          bytesBase64: stagedBytes.subarray(offset, offset + 2 * 1024 * 1024).toString("base64"),
        });
      }
      const staged = await plugin.handlers.meeting_stage_upload_finish({ uploadId });
      expect(staged).toMatchObject({ sessionId: "staged-26mb", mode: "upload" });
      expect(spawnWorker).toHaveBeenCalledTimes(4);
      expect(resolveApiKey).toHaveBeenCalledTimes(2);
      expect(requests).toHaveLength(2);
      expect(requests[1]?.auth).toEqual({ lease: "lease-upload" });
    } finally {
      if (priorFfmpeg === undefined) delete process.env.AVE_MEETING_FFMPEG_PATH;
      else process.env.AVE_MEETING_FFMPEG_PATH = priorFfmpeg;
      if (priorFfprobe === undefined) delete process.env.AVE_MEETING_FFPROBE_PATH;
      else process.env.AVE_MEETING_FFPROBE_PATH = priorFfprobe;
    }
  }, 30_000);

  it("apiKeySource=plugin uses plugin.<id>.sttApiKey and never calls host resolveApiKey", async () => {
    const capturedHeaders: Record<string, string>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers) capturedHeaders.push(headers);
      return {
        ok: true,
        json: async () => ({ segments: [{ id: 1, start: 0, end: 1, text: "plugin" }] }),
      } as Response;
    });

    // resolveApiKey would succeed but must not be called in plugin key mode.
    const resolveApiKey = vi.fn(async (): Promise<ResolveApiKeyResult> => ({
      ok: true,
      vendor: "openai",
      exposure: "lease", leaseId: "lease-test", onClosed: () => () => {},
      release: vi.fn(async () => {}),
    }));

    const { context } = makeContext({
      config: { apiKeySource: "plugin" },
      resolveApiKey,
      secrets: { "plugin.meeting.sttApiKey": "plugin-stt-key-abc" },
    });
    const plugin = await createPlugin(context);

    await plugin.handlers.batch_processing_audio({ sessionId: "s-plugin" });
    await plugin.handlers.meeting_push_chunk({
      sessionId: "s-plugin",
      chunk: {
        pcm16leMono: Array.from({ length: 320 }, () => 0),
        sampleRate: 16000,
        startSec: 0,
        endSec: 0.02,
      },
    });

    expect(resolveApiKey).not.toHaveBeenCalled();
    const authHeader = capturedHeaders[0]?.["Authorization"] ?? capturedHeaders[0]?.["authorization"];
    expect(authHeader).toBe("Bearer plugin-stt-key-abc");
  });

  it("apiKeySource=plugin resolves sttApiKey when the host returns it asynchronously", async () => {
    const capturedHeaders: Record<string, string>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers) capturedHeaders.push(headers);
      return {
        ok: true,
        json: async () => ({ segments: [{ id: 1, start: 0, end: 1, text: "async" }] }),
      } as Response;
    });

    const { context, logEvent } = makeContext({
      config: { apiKeySource: "plugin" },
      asyncSecrets: true,
      secrets: { "plugin.meeting.sttApiKey": "async-plugin-stt-key" },
    });
    const plugin = await createPlugin(context);

    await plugin.handlers.batch_processing_audio({ sessionId: "s-plugin-async-secret" });
    await plugin.handlers.meeting_push_chunk({
      sessionId: "s-plugin-async-secret",
      chunk: {
        pcm16leMono: Array.from({ length: 320 }, () => 0),
        sampleRate: 16000,
        startSec: 0,
        endSec: 0.02,
      },
    });

    const authHeader = capturedHeaders[0]?.["Authorization"] ?? capturedHeaders[0]?.["authorization"];
    expect(authHeader).toBe("Bearer async-plugin-stt-key");

    // The boot-time diagnostic reads the same secret; an unawaited Promise
    // would report the key as absent even though the session start found it.
    const diagnostic = logEvent.mock.calls.find(
      ([, message]) => message === "meeting_stt_provider_selection",
    )?.[2] as { pluginSttKeyPresent?: boolean } | undefined;
    expect(diagnostic?.pluginSttKeyPresent).toBe(true);
  });

  it("apiKeySource=plugin rejects endpoint URLs saved as sttApiKey before upload", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ segments: [] }),
    } as Response);
    const emitted: Array<{ type: string; data?: unknown }> = [];
    const { context } = makeContext({
      config: { apiKeySource: "plugin" },
      emitEvent: (type, data) => emitted.push({ type, data }),
      secrets: {
        "plugin.meeting.sttApiKey": "https://example.openai.azure.com/openai/deployments/gpt-4o-transcribe/audio/transcriptions",
      },
    });
    const plugin = await createPlugin(context);

    await plugin.handlers.batch_processing_audio({ sessionId: "s-plugin-url-secret" });
    await expect(
      plugin.handlers.meeting_push_chunk({
        sessionId: "s-plugin-url-secret",
        chunk: {
          pcm16leMono: Array.from({ length: 320 }, () => 0),
          sampleRate: 16000,
          startSec: 0,
          endSec: 0.02,
        },
      }),
    ).rejects.toThrow(/sttApiKey contains an endpoint URL/);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(emitted.find((e) => e.type === "meeting.error")?.data).toMatchObject({
      sessionId: "s-plugin-url-secret",
      reason: "stt-key-unavailable:plugin-stt-key-is-url",
    });
  });
  it("apiKeySource=plugin reads sttApiKey at session start so a just-saved secret works without restart", async () => {
    const capturedHeaders: Record<string, string>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers) capturedHeaders.push(headers);
      return {
        ok: true,
        json: async () => ({ segments: [{ id: 1, start: 0, end: 1, text: "late" }] }),
      } as Response;
    });

    const secrets: Record<string, string> = {};
    const { context } = makeContext({
      config: { apiKeySource: "plugin" },
      secrets,
    });
    const plugin = await createPlugin(context);
    secrets["plugin.meeting.sttApiKey"] = "late-saved-plugin-key";

    await plugin.handlers.batch_processing_audio({ sessionId: "s-plugin-late-secret" });
    await plugin.handlers.meeting_push_chunk({
      sessionId: "s-plugin-late-secret",
      chunk: {
        pcm16leMono: Array.from({ length: 320 }, () => 0),
        sampleRate: 16000,
        startSec: 0,
        endSec: 0.02,
      },
    });

    const authHeader = capturedHeaders[0]?.["Authorization"] ?? capturedHeaders[0]?.["authorization"];
    expect(authHeader).toBe("Bearer late-saved-plugin-key");
  });

  it("apiKeySource=host ignores plugin sttApiKey and uses host resolver", async () => {
    const requests: HostFetchInit[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init) requests.push(init);
      return {
        ok: true,
        json: async () => ({ segments: [{ id: 1, start: 0, end: 1, text: "host" }] }),
      } as Response;
    });

    const resolveApiKey = vi.fn(async (): Promise<ResolveApiKeyResult> => ({
      ok: true,
      vendor: "openai",
      exposure: "lease", leaseId: "lease-test", onClosed: () => () => {},
      release: vi.fn(async () => {}),
    }));

    const { context } = makeContext({
      config: { apiKeySource: "host" },
      resolveApiKey,
      secrets: { "plugin.meeting.sttApiKey": "must-not-be-used" },
    });
    const plugin = await createPlugin(context);

    await plugin.handlers.batch_processing_audio({ sessionId: "s-host-explicit" });
    await plugin.handlers.meeting_push_chunk({
      sessionId: "s-host-explicit",
      chunk: {
        pcm16leMono: Array.from({ length: 320 }, () => 0),
        sampleRate: 16000,
        startSec: 0,
        endSec: 0.02,
      },
    });

    expect(resolveApiKey).toHaveBeenCalledTimes(1);
    expect(requests[0]?.auth).toEqual({ lease: "lease-test" });
    expect(requests[0]?.headers).toBeUndefined();
  });

  it("apiKeySource=plugin fails without plugin sttApiKey and does not fall back to host", async () => {
    const emitted: Array<{ type: string; data?: unknown }> = [];
    const resolveApiKey = vi.fn(async (): Promise<ResolveApiKeyResult> => ({
      ok: true,
      vendor: "openai",
      exposure: "lease", leaseId: "lease-test", onClosed: () => () => {},
      release: vi.fn(async () => {}),
    }));

    const { context } = makeContext({
      config: { apiKeySource: "plugin" },
      resolveApiKey,
      emitEvent: (type, data) => emitted.push({ type, data }),
    });
    const plugin = await createPlugin(context);

    await plugin.handlers.batch_processing_audio({ sessionId: "s-plugin-missing" });
    await expect(
      plugin.handlers.meeting_push_chunk({
        sessionId: "s-plugin-missing",
        chunk: {
          pcm16leMono: Array.from({ length: 320 }, () => 0),
          sampleRate: 16000,
          startSec: 0,
          endSec: 0.02,
        },
      }),
    ).rejects.toThrow(/plugin sttApiKey is not configured/);

    expect(resolveApiKey).not.toHaveBeenCalled();
    expect(emitted.find((e) => e.type === "meeting.error")?.data).toMatchObject({
      sessionId: "s-plugin-missing",
      reason: "stt-key-unavailable:plugin-stt-key-missing",
    });
  });

  it("hard-fails on invalid configured sttBaseUrl instead of falling back to OpenAI public", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const emitted: Array<{ type: string; data?: unknown }> = [];
    const { context } = makeContext({
      config: { apiKeySource: "plugin", sttBaseUrl: "http://localhost/v1" },
      secrets: { "plugin.meeting.sttApiKey": "plugin-key" },
      emitEvent: (type, data) => emitted.push({ type, data }),
    });
    const plugin = await createPlugin(context);

    await plugin.handlers.batch_processing_audio({ sessionId: "s-invalid-stt-url" });
    await expect(
      plugin.handlers.meeting_push_chunk({
        sessionId: "s-invalid-stt-url",
        chunk: {
          pcm16leMono: Array.from({ length: 320 }, () => 0),
          sampleRate: 16000,
          startSec: 0,
          endSec: 0.02,
        },
      }),
    ).rejects.toThrow(/STT endpoint invalid/);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(emitted.find((e) => e.type === "meeting.error")?.data).toMatchObject({
      sessionId: "s-invalid-stt-url",
      reason: "stt-base-url-invalid:disallowed-protocol",
    });
  });

  it("emits meeting.error and throws when resolveApiKey returns ok:false", async () => {
    const emitted: Array<{ type: string; data?: unknown }> = [];

    const resolveApiKey = vi.fn(async (): Promise<ResolveApiKeyResult> => ({
      ok: false,
      reason: "no-host-vendor",
    }));

    const { context } = makeContext({
      resolveApiKey,
      emitEvent: (type, data) => emitted.push({ type, data }),
    });

    const plugin = await createPlugin(context);
    await plugin.handlers.batch_processing_audio({ sessionId: "s-fail" });

    await expect(
      plugin.handlers.meeting_push_chunk({
        sessionId: "s-fail",
        chunk: {
          pcm16leMono: Array.from({ length: 320 }, () => 0),
          sampleRate: 16000,
          startSec: 0,
          endSec: 0.02,
        },
      }),
    ).rejects.toThrow(/stt-key-unavailable.*no-host-vendor|STT key unavailable.*no-host-vendor/i);

    const errorEvents = emitted.filter((e) => e.type === "meeting.error");
    expect(errorEvents.length).toBeGreaterThan(0);
    expect(errorEvents[0]?.data).toMatchObject({
      sessionId: "s-fail",
      reason: "stt-key-unavailable:no-host-vendor",
    });
  });

  it("hard-fails on v5.4 host when apiKeySource is host and resolveApiKey is missing — no MockSttProvider fallback", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const emitted: Array<{ type: string; data?: unknown }> = [];

    // No resolveApiKey on hostApi at all (legacy v5.4 host).
    const { context } = makeContext({
      resolveApiKey: undefined,
      emitEvent: (type, data) => emitted.push({ type, data }),
    });
    const plugin = await createPlugin(context);

    await plugin.handlers.batch_processing_audio({ sessionId: "s-v54" });
    await expect(
      plugin.handlers.meeting_push_chunk({
        sessionId: "s-v54",
        chunk: {
          pcm16leMono: Array.from({ length: 320 }, () => 0),
          sampleRate: 16000,
          startSec: 0,
          endSec: 0.02,
        },
      }),
    ).rejects.toThrow(/STT key unavailable/);

    // No Whisper fetch ever fired.
    expect(fetchSpy).not.toHaveBeenCalled();
    // meeting.error surfaced to UI (no silent fallback).
    expect(emitted.some((e) => e.type === "meeting.error")).toBe(true);
  });

  it("AbortSignal threaded into resolveApiKey is the same one fed to the session — meeting_stop aborts it", async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => ({
      ok: true,
      json: async () => ({ segments: [{ id: 1, start: 0, end: 1, text: "x" }] }),
    } as Response));

    const releaseFn = vi.fn(async () => {});
    const resolveApiKey = vi.fn(async (opts: { signal?: AbortSignal }): Promise<ResolveApiKeyResult> => {
      capturedSignal = opts.signal;
      return {
        ok: true,
        vendor: "openai",
        exposure: "lease", leaseId: "lease-test", onClosed: () => () => {},
        release: releaseFn,
      };
    });

    const { context } = makeContext({ resolveApiKey });
    const plugin = await createPlugin(context);

    await plugin.handlers.batch_processing_audio({ sessionId: "s-abort" });
    await plugin.handlers.meeting_push_chunk({
      sessionId: "s-abort",
      chunk: {
        pcm16leMono: Array.from({ length: 320 }, () => 0),
        sampleRate: 16000,
        startSec: 0,
        endSec: 0.02,
      },
    });

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);
    expect(releaseFn).not.toHaveBeenCalled();

    // meeting_stop should abort the session — fire release listener via the
    // AbortController held in MeetingPipeline.abortSession.
    await plugin.handlers.meeting_stop({ sessionId: "s-abort" });

    expect(capturedSignal?.aborted).toBe(true);
    expect(releaseFn).toHaveBeenCalledTimes(1);
  });

  it("shares one lease across concurrent first chunks", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => ({
      ok: true,
      json: async () => ({ segments: [{ id: 1, start: 0, end: 1, text: "x" }] }),
    } as Response));
    let resumeResolve!: () => void;
    const resolveGate = new Promise<void>((resolve) => { resumeResolve = resolve; });
    const releaseFn = vi.fn(async () => {});
    const resolveApiKey = vi.fn(async (): Promise<ResolveApiKeyResult> => {
      await resolveGate;
      return {
        ok: true, vendor: "openai", exposure: "lease", leaseId: "lease-once",
        onClosed: () => () => {}, release: releaseFn,
      };
    });
    const { context } = makeContext({ resolveApiKey });
    const plugin = await createPlugin(context);
    const sessionId = "s-concurrent-first";
    await plugin.handlers.batch_processing_audio({ sessionId });
    const chunk = { pcm16leMono: Array.from({ length: 320 }, () => 0), sampleRate: 16000, startSec: 0, endSec: 0.02 };
    const first = plugin.handlers.meeting_push_chunk({ sessionId, chunk });
    const second = plugin.handlers.meeting_push_chunk({ sessionId, chunk });
    await vi.waitFor(() => expect(resolveApiKey).toHaveBeenCalledTimes(1));
    resumeResolve();
    await Promise.all([first, second]);
    expect(resolveApiKey).toHaveBeenCalledTimes(1);
    await plugin.handlers.meeting_stop({ sessionId });
    expect(releaseFn).toHaveBeenCalledTimes(1);
  });

  it("waits for a late lease resolution before cancel completes", async () => {
    let finishResolve!: (result: ResolveApiKeyResult) => void;
    const releaseFn = vi.fn(async () => {});
    const resolveApiKey = vi.fn(() => new Promise<ResolveApiKeyResult>((resolve) => { finishResolve = resolve; }));
    const { context } = makeContext({ resolveApiKey });
    const plugin = await createPlugin(context);
    const sessionId = "s-cancel-pending-resolve";
    await plugin.handlers.batch_processing_audio({ sessionId });
    const pendingChunk = plugin.handlers.meeting_push_chunk({
      sessionId,
      chunk: { pcm16leMono: Array.from({ length: 320 }, () => 0), sampleRate: 16000, startSec: 0, endSec: 0.02 },
    });
    await vi.waitFor(() => expect(resolveApiKey).toHaveBeenCalledTimes(1));
    let cancelSettled = false;
    const cancelling = plugin.handlers.meeting_cancel({ sessionId }).then(() => { cancelSettled = true; });
    expect(cancelSettled).toBe(false);
    finishResolve({
      ok: true, vendor: "openai", exposure: "lease", leaseId: "lease-after-cancel",
      onClosed: () => () => {}, release: releaseFn,
    });
    await expect(pendingChunk).rejects.toThrow("Meeting STT session aborted");
    await cancelling;
    expect(releaseFn).toHaveBeenCalledTimes(1);
  });

  it("releases a lease after failed final summary and again guards shutdown failure", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => ({
      ok: true,
      json: async () => ({ segments: [{ id: 1, start: 0, end: 1, text: "x" }] }),
    } as Response));
    const signals: AbortSignal[] = [];
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    let finishSecondRelease!: () => void;
    const secondReleaseGate = new Promise<void>((resolve) => { finishSecondRelease = resolve; });
    const resolveApiKey = vi.fn(async (opts: { signal?: AbortSignal }): Promise<ResolveApiKeyResult> => {
      signals.push(opts.signal!);
      const leaseIndex = releases.length;
      const release = vi.fn(async () => { if (leaseIndex === 1) await secondReleaseGate; });
      releases.push(release);
      return {
        ok: true, vendor: "openai", exposure: "lease", leaseId: `lease-${releases.length}`,
        onClosed: () => () => {}, release,
      };
    });
    const { context, shutdown } = makeContext({
      resolveApiKey,
      callLlm: async () => { throw new Error("summary failed"); },
    });
    const plugin = await createPlugin(context);
    const chunk = { pcm16leMono: Array.from({ length: 320 }, () => 0), sampleRate: 16000, startSec: 0, endSec: 0.02 };

    await plugin.handlers.batch_processing_audio({ sessionId: "s-summary-fails" });
    await plugin.handlers.meeting_push_chunk({ sessionId: "s-summary-fails", chunk });
    await expect(plugin.handlers.meeting_stop({ sessionId: "s-summary-fails" })).rejects.toThrow("summary failed");
    expect(signals[0]?.aborted).toBe(true);
    await vi.waitFor(() => expect(releases[0]).toHaveBeenCalledTimes(1));
    await plugin.handlers.meeting_cancel({ sessionId: "s-summary-fails" });

    await plugin.handlers.batch_processing_audio({ sessionId: "s-shutdown-fails" });
    await plugin.handlers.meeting_push_chunk({ sessionId: "s-shutdown-fails", chunk });
    let shutdownSettled = false;
    const closing = shutdown().then(() => { shutdownSettled = true; });
    await vi.waitFor(() => expect(releases[1]).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    expect(shutdownSettled).toBe(false);
    finishSecondRelease();
    await closing;
    expect(signals[1]?.aborted).toBe(true);
    expect(releases[0]).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("sttDiagnostic exposes only redacted fields (no key material or paths)", async () => {
    const { context, logEvent } = makeContext({
      config: { apiKeySource: "plugin" },
      resolveApiKey: undefined,
      secrets: { "plugin.meeting.sttApiKey": "secret-key-xyz" },
    });
    await createPlugin(context);

    const diagCalls = logEvent.mock.calls.filter(
      (call) => call[1] === "meeting_stt_provider_selection",
    );
    expect(diagCalls.length).toBeGreaterThan(0);
    const diagData = diagCalls[0]?.[2] as unknown as Record<string, unknown>;

    // Sensitive fields must NEVER appear in the diagnostic.
    expect(diagData).not.toHaveProperty("sttApiKeyLen");
    expect(diagData).not.toHaveProperty("secretStorePresent");
    expect(diagData).not.toHaveProperty("legacySecretPresent");
    expect(diagData).not.toHaveProperty("sidecarPath");
    expect(diagData).not.toHaveProperty("sidecarExists");
    expect(diagData).not.toHaveProperty("sttApiKey");

    // Required redacted fields.
    expect(diagData).toHaveProperty("pluginSttKeyPresent");
    expect(diagData).toHaveProperty("sttKeySource");
    expect(diagData).toHaveProperty("resolveApiKeyAvailable");
    expect(diagData).toHaveProperty("sttModel");
    expect(diagData.pluginSttKeyPresent).toBe(true);
    expect(diagData.sttKeySource).toBe("plugin");
    expect(diagData.resolveApiKeyAvailable).toBe(false);
  });
});

describe("host vendor inherit (#955)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // L1 — resolveApiKey contract: the meeting plugin MUST NOT hardcode
  // vendor when requesting an STT key. The host then defaults to the
  // user's active LLM provider (e.g. Azure AI Foundry) instead of
  // silently forcing OpenAI public.
  it("calls hostApi.resolveApiKey WITHOUT a vendor argument so host can map to active provider", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => ({
      ok: true,
      json: async () => ({ segments: [{ id: 1, start: 0, end: 1, text: "x" }] }),
    } as Response));

    const resolveApiKey = vi.fn(async (_opts: { purpose: string; vendor?: string; signal?: AbortSignal }): Promise<ResolveApiKeyResult> => ({
      ok: true,
      vendor: "azure",
      exposure: "lease", leaseId: "lease-test", onClosed: () => () => {},
      release: vi.fn(async () => {}),
    }));

    const { context } = makeContext({ resolveApiKey });
    const plugin = await createPlugin(context);

    await plugin.handlers.batch_processing_audio({ sessionId: "s-no-vendor" });
    await plugin.handlers.meeting_push_chunk({
      sessionId: "s-no-vendor",
      chunk: {
        pcm16leMono: Array.from({ length: 320 }, () => 0),
        sampleRate: 16000,
        startSec: 0,
        endSec: 0.02,
      },
    });

    expect(resolveApiKey).toHaveBeenCalledTimes(1);
    const callArg = resolveApiKey.mock.calls[0]?.[0] as
      | { purpose?: string; vendor?: string }
      | undefined;
    // Contract: vendor key is OMITTED entirely (not undefined-set, not
    // "openai"). resolve-api-key.ts:204 maps an omitted vendor to the
    // user's active LLM provider.
    expect(callArg?.purpose).toBe("stt");
    expect(callArg?.vendor).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(callArg ?? {}, "vendor")).toBe(false);
  });

  // L3 — Summary fallback removal: when host does NOT expose callLlm AND
  // a plugin-local STT key IS present, the plugin MUST select
  // MockSummaryProvider, NOT the deleted OpenAISummaryProvider path. The
  // manifest declares `llmKeySource: "host"`, so reusing the BYO STT key
  // for summary calls against OpenAI public is a user-consent violation.
  it("selects Mock summary when callLlm is absent — does NOT reuse plugin STT key for summary", async () => {
    const logs: string[] = [];
    const { context } = makeContext({
      config: { apiKeySource: "plugin" },
      secrets: { "plugin.meeting.sttApiKey": "plugin-stt-only" },
      // callLlm intentionally NOT provided.
      logSink: (msg) => logs.push(msg),
    });
    await createPlugin(context);

    const summaryLog = logs.find((l) => l.includes("[meeting] summary via"));
    expect(summaryLog).toBeDefined();
    // Must be Mock — the legacy "summary via OpenAI (legacy direct SDK)"
    // path is removed.
    expect(summaryLog).toContain("Mock");
    expect(summaryLog).not.toContain("OpenAI");
  });

  it("uses HostLlmSummaryProvider when callLlm is exposed (regardless of plugin STT key)", async () => {
    const logs: string[] = [];
    const callLlm = vi.fn(async () => "ok");
    const { context } = makeContext({
      config: { apiKeySource: "plugin" },
      secrets: { "plugin.meeting.sttApiKey": "plugin-stt-only" },
      callLlm,
      logSink: (msg) => logs.push(msg),
    });
    await createPlugin(context);

    const summaryLog = logs.find((l) => l.includes("[meeting] summary via"));
    expect(summaryLog).toBeDefined();
    expect(summaryLog).toContain("host callLlm");
  });

  // ralph round-1 follow-up — M1: Mock summary fallback was a silent UX
  // degradation. When the host does NOT expose callLlm the plugin must:
  //   1) log a warning so on-disk logs reflect the degraded state
  //   2) emit a structured event (`meeting.summary.degraded`) so the host UI
  //      / proactive engine can surface it instead of users receiving a
  //      placeholder summary without realising real LLM access is missing.
  it("emits meeting.summary.degraded when callLlm is missing (M1 — round-1)", async () => {
    const emitted: Array<{ type: string; data?: unknown }> = [];
    const { context, logEvent } = makeContext({
      // callLlm intentionally omitted — triggers Mock summary path.
      emitEvent: (type, data) => emitted.push({ type, data }),
    });
    await createPlugin(context);

    const degraded = emitted.filter((e) => e.type === "meeting.summary.degraded");
    expect(degraded.length).toBe(1);
    expect(degraded[0]?.data).toMatchObject({
      reason: "host-callLlm-unavailable",
    });
    // Timestamp present and ISO-8601 shaped.
    const data = degraded[0]?.data as { at?: string; title?: string; body?: string };
    expect(typeof data?.at).toBe("string");
    expect(data?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // ralph round-2 (architect Minor): title/body fields back the
    // plugin.json notificationEvents → host OS notification surface.
    expect(typeof data?.title).toBe("string");
    expect(data?.title?.length).toBeGreaterThan(0);
    expect(typeof data?.body).toBe("string");
    expect(data?.body?.length).toBeGreaterThan(0);

    // logEvent records the degradation at warn severity for host log sinks.
    const warnCalls = logEvent.mock.calls.filter(
      (call) => call[0] === "warn" && call[1] === "meeting_summary_degraded",
    );
    expect(warnCalls.length).toBe(1);
    expect(warnCalls[0]?.[2]).toMatchObject({
      reason: "host-callLlm-unavailable",
    });
  });

  it("does NOT emit meeting.summary.degraded when callLlm is exposed (M1 — round-1)", async () => {
    const emitted: Array<{ type: string; data?: unknown }> = [];
    const callLlm = vi.fn(async () => "ok");
    const { context } = makeContext({
      callLlm,
      emitEvent: (type, data) => emitted.push({ type, data }),
    });
    await createPlugin(context);

    expect(emitted.find((e) => e.type === "meeting.summary.degraded")).toBeUndefined();
  });

  // L2 — handle.baseUrl host inherit: when plugin sttBaseUrl is not
  // configured but the host resolveApiKey handle exposes a baseUrl (e.g.
  // Azure AI Foundry endpoint), the plugin derives the transcriptions URL
  // automatically via normalizeKnownSttEndpoint.
  it("uses handle.baseUrl to derive Azure transcriptions URL when no plugin sttBaseUrl is set", async () => {
    const capturedUrls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, _init) => {
      capturedUrls.push(String(url));
      return {
        ok: true,
        json: async () => ({ segments: [{ id: 1, start: 0, end: 1, text: "azure" }] }),
      } as Response;
    });

    const resolveApiKey = vi.fn(async (): Promise<ResolveApiKeyResult> => ({
      ok: true,
      vendor: "azure",
      exposure: "lease", leaseId: "lease-test", onClosed: () => () => {},
      baseUrl: "https://myresource.services.ai.azure.com/models",
      release: vi.fn(async () => {}),
    }));

    const { context } = makeContext({ resolveApiKey });
    const plugin = await createPlugin(context);

    await plugin.handlers.batch_processing_audio({ sessionId: "s-azure-inherit" });
    await plugin.handlers.meeting_push_chunk({
      sessionId: "s-azure-inherit",
      chunk: {
        pcm16leMono: Array.from({ length: 320 }, () => 0),
        sampleRate: 16000,
        startSec: 0,
        endSec: 0.02,
      },
    });

    // The fetch URL must be the Azure transcriptions path derived from the handle baseUrl.
    expect(capturedUrls.length).toBeGreaterThan(0);
    const fetchedUrl = capturedUrls[0] ?? "";
    expect(fetchedUrl).toContain("myresource.openai.azure.com");
    expect(fetchedUrl).toContain("/audio/transcriptions");
    expect(fetchedUrl).toContain("api-version=2025-01-01-preview");
  });

  it("host handle.baseUrl takes priority over configured sttBaseUrl in host mode", async () => {
    const capturedUrls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, _init) => {
      capturedUrls.push(String(url));
      return {
        ok: true,
        json: async () => ({ segments: [{ id: 1, start: 0, end: 1, text: "host-url" }] }),
      } as Response;
    });

    const resolveApiKey = vi.fn(async (): Promise<ResolveApiKeyResult> => ({
      ok: true,
      vendor: "azure",
      exposure: "lease", leaseId: "lease-test", onClosed: () => () => {},
      // handle.baseUrl would produce a different Azure endpoint.
      baseUrl: "https://handle-resource.openai.azure.com/",
      release: vi.fn(async () => {}),
    }));

    // In host mode the host-provided endpoint should win over configured plugin STT URL.
    const { context } = makeContext({
      resolveApiKey,
      config: { sttBaseUrl: "https://plugin-resource.openai.azure.com/" },
    });
    const plugin = await createPlugin(context);

    await plugin.handlers.batch_processing_audio({ sessionId: "s-host-url-priority" });
    await plugin.handlers.meeting_push_chunk({
      sessionId: "s-host-url-priority",
      chunk: {
        pcm16leMono: Array.from({ length: 320 }, () => 0),
        sampleRate: 16000,
        startSec: 0,
        endSec: 0.02,
      },
    });

    expect(capturedUrls.length).toBeGreaterThan(0);
    const fetchedUrl = capturedUrls[0] ?? "";
    // Must use host handle URL, not the stale plugin-configured URL.
    expect(fetchedUrl).toContain("handle-resource.openai.azure.com");
    expect(fetchedUrl).not.toContain("plugin-resource.openai.azure.com");
  });

  it("falls back to provider default when handle.baseUrl is absent", async () => {
    const capturedUrls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, _init) => {
      capturedUrls.push(String(url));
      return {
        ok: true,
        json: async () => ({ segments: [{ id: 1, start: 0, end: 1, text: "default" }] }),
      } as Response;
    });

    // handle has no baseUrl — provider default should be used (undefined → OpenAI default).
    const resolveApiKey = vi.fn(async (): Promise<ResolveApiKeyResult> => ({
      ok: true,
      vendor: "openai",
      exposure: "lease", leaseId: "lease-test", onClosed: () => () => {},
      release: vi.fn(async () => {}),
    }));

    const { context } = makeContext({ resolveApiKey });
    const plugin = await createPlugin(context);

    await plugin.handlers.batch_processing_audio({ sessionId: "s-no-baseurl" });
    await plugin.handlers.meeting_push_chunk({
      sessionId: "s-no-baseurl",
      chunk: {
        pcm16leMono: Array.from({ length: 320 }, () => 0),
        sampleRate: 16000,
        startSec: 0,
        endSec: 0.02,
      },
    });

    // Fetch was made — no crash. baseUrl resolution did not throw.
    expect(capturedUrls.length).toBeGreaterThan(0);
  });
});
