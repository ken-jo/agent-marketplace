import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIWhisperSttProvider, toAudioDataUrl } from "../src/adapters/openaiWhisperSttProvider";
import type { ApiKeyLease, HostFetchInit } from "@ave/plugin-contract";

describe("OpenAIWhisperSttProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses a lease on both STT request paths without a credential header", async () => {
    const requests: HostFetchInit[] = [];
    const lease: ApiKeyLease = {
      exposure: "lease", leaseId: "lease-meeting-session", vendor: "openai",
      release: async () => {}, onClosed: () => () => {},
    };
    const provider = new OpenAIWhisperSttProvider({
      lease,
      fetch: async (_url, init) => {
        if (init) requests.push(init);
        return new Response(JSON.stringify({ text: "hello" }), { status: 200 });
      },
    });
    await provider.transcribeChunk({
      sessionId: "s", pcm16leMono: Buffer.from([0, 0]), sampleRate: 16000,
      startSec: 0, endSec: 1,
    });
    await provider.transcribeFile({
      sessionId: "s", bytes: Buffer.from([1, 2, 3]), fileName: "sample.wav",
    });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.auth).toEqual({ lease: lease.leaseId });
      expect(request.headers).toBeUndefined();
      expect(request.body).toBeInstanceOf(FormData);
    }
  });

  it("rejects oversized audio and non-file fields before hostFetch", async () => {
    const hostFetch = vi.fn(async () => new Response(JSON.stringify({ text: "hello" })));
    const provider = new OpenAIWhisperSttProvider({ apiKey: "plugin-key", fetch: hostFetch });
    await expect(provider.transcribeFile({
      sessionId: "s", bytes: Buffer.alloc(15 * 1024 * 1024 + 1), fileName: "large.wav",
    })).rejects.toThrow(/file-too-large/);
    const largePromptProvider = new OpenAIWhisperSttProvider({
      apiKey: "plugin-key", prompt: "x".repeat(1024 * 1024), fetch: hostFetch,
    });
    await expect(largePromptProvider.transcribeFile({
      sessionId: "s", bytes: Buffer.alloc(15 * 1024 * 1024), fileName: "large.wav",
    })).rejects.toThrow(/file-too-large/);
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it("Whisper segment 응답을 TranscriptSegment로 변환한다", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        segments: [
          { id: 1, start: 0.0, end: 1.2, text: "안녕하세요" },
          { id: 2, start: 1.2, end: 2.3, text: "회의 시작하겠습니다" },
        ],
      }),
    } as Response);

    const provider = new OpenAIWhisperSttProvider({
      apiKey: "test-key",
    });

    const result = await provider.transcribeChunk({
      sessionId: "s1",
      pcm16leMono: Buffer.from([0x00, 0x01]),
      sampleRate: 16000,
      startSec: 10,
      endSec: 12.3,
    });

    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe("s1-1");
    expect(result[0]?.startSec).toBe(10);
    expect(result[0]?.endSec).toBe(11.2);
    expect(result[0]?.original).toBe("안녕하세요");
    expect(result[0]?.source).toBe("batch");
    expect(result[0]?.stt?.provider).toBe("openai");
    expect(result[0]?.stt?.model).toBe("gpt-4o-mini-transcribe");
    expect(result[1]?.id).toBe("s1-2");
  });

  it("파일 전사 세그먼트에 startOffsetSec를 반영한다", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        segments: [
          { id: 1, start: 0.5, end: 1.75, text: "중간 구간입니다" },
        ],
      }),
    } as Response);

    const provider = new OpenAIWhisperSttProvider({
      apiKey: "test-key",
    });

    const result = await provider.transcribeFile({
      sessionId: "large-upload",
      bytes: Buffer.from([0x52, 0x49, 0x46, 0x46]),
      mimeType: "audio/wav",
      fileName: "part-00002.wav",
      startOffsetSec: 30,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("large-upload-30000-1");
    expect(result[0]?.startSec).toBe(30.5);
    expect(result[0]?.endSec).toBe(31.75);
  });

  it("파일 업로드 오류에서 echoed API key material을 redacts 한다", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => JSON.stringify({
        error: { message: "Incorrect API key provided: https://example.openai.azure.com" },
      }),
    } as Response);

    const provider = new OpenAIWhisperSttProvider({
      apiKey: "https://example.openai.azure.com",
    });

    await expect(
      provider.transcribeFile({
        sessionId: "large-upload-redact",
        bytes: Buffer.from([0x52, 0x49, 0x46, 0x46]),
        mimeType: "audio/wav",
        fileName: "part.wav",
      }),
    ).rejects.toThrow(/Incorrect API key provided: \[redacted\]/);
  });
  it("세그먼트가 없으면 text 필드로 단일 세그먼트를 생성한다", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        text: "요약 없는 단일 전사 텍스트",
      }),
    } as Response);

    const provider = new OpenAIWhisperSttProvider({
      apiKey: "test-key",
    });

    const result = await provider.transcribeChunk({
      sessionId: "s2",
      pcm16leMono: Buffer.from([0x00, 0x01]),
      sampleRate: 16000,
      startSec: 0,
      endSec: 1.5,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.original).toBe("요약 없는 단일 전사 텍스트");
    expect(result[0]?.source).toBe("batch");
    expect(result[0]?.isFinal).toBe(true);
    expect(result[0]?.stt?.provider).toBe("openai");
  });

  it("HTTP 에러면 예외를 던진다", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    } as Response);

    const provider = new OpenAIWhisperSttProvider({
      apiKey: "invalid",
    });

    await expect(
      provider.transcribeChunk({
        sessionId: "s3",
        pcm16leMono: Buffer.from([0x00]),
        sampleRate: 16000,
        startSec: 0,
        endSec: 1,
      }),
    ).rejects.toThrow("Whisper request failed: 401 Unauthorized");
  });

  it("diarized 응답의 speaker 정보를 세그먼트에 반영한다", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        segments: [
          { id: "seg_1", start: 0.0, end: 1.0, text: "안녕하세요", speaker: "agent" },
          { id: "seg_2", start: 1.0, end: 2.4, text: "네 반갑습니다", speaker: "customer" },
        ],
        text: "안녕하세요 네 반갑습니다",
      }),
    } as Response);

    const provider = new OpenAIWhisperSttProvider({
      apiKey: "test-key",
      model: "gpt-4o-transcribe-diarize",
      knownSpeakerNames: ["agent", "customer"],
      knownSpeakerReferences: [toAudioDataUrl(Buffer.from([0x01])), toAudioDataUrl(Buffer.from([0x02]))],
    });

    const result = await provider.transcribeChunk({
      sessionId: "s4",
      pcm16leMono: Buffer.from([0x00, 0x01]),
      sampleRate: 16000,
      startSec: 0,
      endSec: 2.4,
    });

    expect(result).toHaveLength(2);
    expect(result[0]?.speaker).toBe("agent");
    expect(result[1]?.speaker).toBe("customer");
    expect(result[0]?.stt?.model).toBe("gpt-4o-transcribe-diarize");
  });

  it("diarization 옵션 길이가 다르면 요청 전에 예외를 던진다", async () => {
    const provider = new OpenAIWhisperSttProvider({
      apiKey: "test-key",
      model: "gpt-4o-transcribe-diarize",
      knownSpeakerNames: ["agent", "customer"],
      knownSpeakerReferences: [toAudioDataUrl(Buffer.from([0x01]))],
    });

    await expect(
      provider.transcribeChunk({
        sessionId: "s5",
        pcm16leMono: Buffer.from([0x00]),
        sampleRate: 16000,
        startSec: 0,
        endSec: 1,
      }),
    ).rejects.toThrow("knownSpeakerNames 와 knownSpeakerReferences 의 길이는 같아야 합니다.");
  });
});
