/**
 * Hardening helpers — guard functions that gate every untrusted entry
 * point in hostPlugin. Pure functions; tested in isolation so a security
 * regression in any of these surfaces immediately rather than waiting on
 * an integration test.
 */
import { describe, it, expect } from "vitest";
import {
  assertSessionId,
  assertFiniteChunkNumbers,
  CHUNK_NUMERIC_FIELDS,
  safeFileName,
  isBase64WithinCap,
  normaliseUploadFilePayload,
  validateOpenUrl,
  validateSttBaseUrl,
  resolveSttConfiguration,
  isPrivateOrLoopbackHost,
  resolvePythonExecutable,
  assertBundleId,
  sanitizePreview,
  parsePcmWavDurationSec,
} from "../src/hostPlugin.js";

describe("assertSessionId", () => {
  it("accepts standard alphanumeric / dash / underscore ids", () => {
    expect(() => assertSessionId("session-123")).not.toThrow();
    expect(() => assertSessionId("Abc_DE-fg-99")).not.toThrow();
    expect(() => assertSessionId("a")).not.toThrow();
    expect(() => assertSessionId("X".repeat(128))).not.toThrow();
  });

  it("rejects path traversal and absolute paths", () => {
    expect(() => assertSessionId("../escape")).toThrow();
    expect(() => assertSessionId("/etc/passwd")).toThrow();
    expect(() => assertSessionId("C:\\absolute")).toThrow();
    expect(() => assertSessionId("dir/sub")).toThrow();
  });
  it("rejects shell metacharacters", () => {
    expect(() => assertSessionId("a;rm -rf")).toThrow();
    expect(() => assertSessionId("a&b")).toThrow();
    expect(() => assertSessionId("`whoami`")).toThrow();
    expect(() => assertSessionId("$HOME")).toThrow();
  });
  it("rejects whitespace, NUL, CR/LF", () => {
    expect(() => assertSessionId("with space")).toThrow();
    expect(() => assertSessionId("with\ttab")).toThrow();
    expect(() => assertSessionId("with\nnewline")).toThrow();
    expect(() => assertSessionId("with\0nul")).toThrow();
  });
  it("rejects empty / non-string / over-cap inputs", () => {
    expect(() => assertSessionId("")).toThrow();
    expect(() => assertSessionId(null)).toThrow();
    expect(() => assertSessionId(undefined)).toThrow();
    expect(() => assertSessionId(42)).toThrow();
    expect(() => assertSessionId({})).toThrow();
    expect(() => assertSessionId("X".repeat(129))).toThrow();
  });
});

describe("assertFiniteChunkNumbers", () => {
  const wellFormed = () => ({
    pcm16leMono: [0, 1, -1],
    sampleRate: 16_000,
    startSec: 12.5,
    endSec: 15.5,
  });

  it("accepts a well-formed chunk", () => {
    expect(() => assertFiniteChunkNumbers(wellFormed())).not.toThrow();
  });

  it("accepts zero and negative offsets", () => {
    // A meeting can legitimately start at 0, and callers replaying an
    // earlier segment may hand back offsets below the current head.
    expect(() => assertFiniteChunkNumbers({ ...wellFormed(), startSec: 0, endSec: 0 })).not.toThrow();
    expect(() => assertFiniteChunkNumbers({ ...wellFormed(), startSec: -1 })).not.toThrow();
  });

  it("guards every numeric field on the chunk", () => {
    expect([...CHUNK_NUMERIC_FIELDS]).toEqual(["sampleRate", "startSec", "endSec"]);
  });

  for (const field of CHUNK_NUMERIC_FIELDS) {
    it(`rejects a chunk missing ${field}, naming the field`, () => {
      const chunk = wellFormed() as Record<string, unknown>;
      delete chunk[field];
      expect(() => assertFiniteChunkNumbers(chunk)).toThrow(
        `chunk.${field} must be a finite number (received undefined)`,
      );
    });

    it(`rejects NaN on ${field}, naming the field`, () => {
      expect(() => assertFiniteChunkNumbers({ ...wellFormed(), [field]: NaN })).toThrow(
        `chunk.${field} must be a finite number (received NaN)`,
      );
    });

    it(`rejects Infinity on ${field}, naming the field`, () => {
      expect(() => assertFiniteChunkNumbers({ ...wellFormed(), [field]: Infinity })).toThrow(
        `chunk.${field} must be a finite number (received Infinity)`,
      );
      expect(() => assertFiniteChunkNumbers({ ...wellFormed(), [field]: -Infinity })).toThrow(
        `chunk.${field} must be a finite number (received -Infinity)`,
      );
    });

    it(`rejects a non-number ${field} without echoing its contents`, () => {
      expect(() => assertFiniteChunkNumbers({ ...wellFormed(), [field]: "16000" })).toThrow(
        `chunk.${field} must be a finite number (received string)`,
      );
      expect(() => assertFiniteChunkNumbers({ ...wellFormed(), [field]: null })).toThrow(
        `chunk.${field} must be a finite number (received object)`,
      );
    });
  }

  it("reports the first offending field when several are bad", () => {
    expect(() => assertFiniteChunkNumbers({ pcm16leMono: [] })).toThrow(
      "chunk.sampleRate must be a finite number (received undefined)",
    );
  });

  it("rejects a missing chunk body rather than reading through it", () => {
    expect(() => assertFiniteChunkNumbers(undefined)).toThrow(
      "chunk.sampleRate must be a finite number (received undefined)",
    );
  });
});

describe("parsePcmWavDurationSec", () => {
  function makePcmWav(dataBytes: number, junkBytes = 34): Buffer {
    const totalBytes = 12 + 8 + 16 + 8 + junkBytes + 8 + dataBytes;
    const out = Buffer.alloc(totalBytes);
    let offset = 0;
    out.write("RIFF", offset); offset += 4;
    out.writeUInt32LE(totalBytes - 8, offset); offset += 4;
    out.write("WAVE", offset); offset += 4;
    out.write("fmt ", offset); offset += 4;
    out.writeUInt32LE(16, offset); offset += 4;
    out.writeUInt16LE(1, offset); offset += 2;
    out.writeUInt16LE(1, offset); offset += 2;
    out.writeUInt32LE(16_000, offset); offset += 4;
    out.writeUInt32LE(32_000, offset); offset += 4;
    out.writeUInt16LE(2, offset); offset += 2;
    out.writeUInt16LE(16, offset); offset += 2;
    out.write("JUNK", offset); offset += 4;
    out.writeUInt32LE(junkBytes, offset); offset += 4;
    offset += junkBytes;
    out.write("data", offset); offset += 4;
    out.writeUInt32LE(dataBytes, offset);
    return out;
  }

  it("uses the WAV data chunk size instead of assuming a 44-byte header", () => {
    const wav = makePcmWav(32_000);
    expect(parsePcmWavDurationSec(wav)).toBe(1);
  });
});

describe("safeFileName", () => {
  it("strips CR/LF/NUL (header smuggling + log injection vectors)", () => {
    expect(safeFileName("a\r\nb.mp3")).not.toContain("\r");
    expect(safeFileName("a\r\nb.mp3")).not.toContain("\n");
    expect(safeFileName("a\0b.wav")).not.toContain("\0");
  });
  it("takes basename only — directory traversal collapses", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("C:\\Windows\\evil.exe")).toBe("evil.exe");
    expect(safeFileName("/abs/path/foo.mp3")).toBe("foo.mp3");
  });
  it("caps length at 120 chars", () => {
    expect(safeFileName("x".repeat(500)).length).toBeLessThanOrEqual(120);
  });
  it("replaces non-allowlisted chars with underscore", () => {
    expect(safeFileName("a;rm.mp3")).toBe("a_rm.mp3");
    expect(safeFileName("hello;<>$()`.wav")).toMatch(/^[\w.\- ]+$/);
  });
  it("falls back to 'upload' for non-string / empty / all-stripped input", () => {
    expect(safeFileName(null)).toBe("upload");
    expect(safeFileName(undefined)).toBe("upload");
    expect(safeFileName(42)).toBe("upload");
    expect(safeFileName("")).toBe("upload");
    // All chars stripped → falls back via the empty-after-clean guard.
    expect(safeFileName("\r\n\0")).toBe("upload");
  });
});

describe("isBase64WithinCap", () => {
  it("approves strings that decode within the byte cap", () => {
    // 1KB cap → ~1366 base64 chars max. 100 chars decodes to ~75 bytes.
    expect(isBase64WithinCap("a".repeat(100), 1024)).toBe(true);
  });
  it("rejects strings that obviously exceed the cap", () => {
    // 25MB cap → cap*4/3 ≈ 33.3MB. Provide 50MB of base64.
    expect(isBase64WithinCap("a".repeat(50 * 1024 * 1024), 25 * 1024 * 1024)).toBe(false);
  });
  it("allows the exact upper boundary plus the slop", () => {
    const cap = 1000;
    const exactlyAtCap = "a".repeat(Math.ceil((cap * 4) / 3) + 16);
    expect(isBase64WithinCap(exactlyAtCap, cap)).toBe(true);
    const overCap = "a".repeat(Math.ceil((cap * 4) / 3) + 17);
    expect(isBase64WithinCap(overCap, cap)).toBe(false);
  });
});

describe("normaliseUploadFilePayload", () => {
  it("accepts string name/base64 and optional string mimeType", () => {
    expect(
      normaliseUploadFilePayload({
        name: "meeting.wav",
        bytesBase64: "YWJj",
        mimeType: "audio/wav",
      }),
    ).toEqual({
      name: "meeting.wav",
      bytesBase64: "YWJj",
      mimeType: "audio/wav",
    });
  });

  it("rejects non-string truthy name and bytesBase64 values", () => {
    expect(() => normaliseUploadFilePayload({ name: 42, bytesBase64: "YWJj" })).toThrow();
    expect(() => normaliseUploadFilePayload({ name: "a.wav", bytesBase64: {} })).toThrow();
    expect(() => normaliseUploadFilePayload({ name: "", bytesBase64: "YWJj" })).toThrow();
    expect(() => normaliseUploadFilePayload({ name: "a.wav", bytesBase64: "" })).toThrow();
  });

  it("drops non-string mimeType instead of widening the boundary contract", () => {
    expect(
      normaliseUploadFilePayload({
        name: "meeting.wav",
        bytesBase64: "YWJj",
        mimeType: 7,
      }),
    ).toEqual({
      name: "meeting.wav",
      bytesBase64: "YWJj",
      mimeType: undefined,
    });
  });
});

describe("validateOpenUrl", () => {
  it("accepts only https Webex urls with hostname", () => {
    expect(validateOpenUrl("https://webex.com/abc").ok).toBe(true);
    expect(validateOpenUrl("https://example.webex.com/meet/ave-sync").ok).toBe(true);
  });
  it("rejects non-Webex and http urls", () => {
    expect(validateOpenUrl("https://teams.microsoft.com/l/meetup-join/ave-sync").ok).toBe(false);
    const http = validateOpenUrl("http://webex.com/abc");
    expect(http.ok).toBe(false);
    if (!http.ok) expect(http.error).toBe("disallowed-protocol");
  });
  it("rejects file: data: javascript: schemes", () => {
    const cases = ["file:///etc/passwd", "data:text/html,foo", "javascript:alert(1)", "steam://run/123"];
    for (const url of cases) {
      const r = validateOpenUrl(url);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("disallowed-protocol");
    }
  });
  it("rejects URLs with embedded basic-auth credentials", () => {
    const r = validateOpenUrl("https://victim:token@attacker.com/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("credentials-in-url");
    const r2 = validateOpenUrl("https://victim@attacker.com/");
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toBe("credentials-in-url");
  });
  it("rejects empty / non-string / unparseable input", () => {
    expect(validateOpenUrl("").ok).toBe(false);
    expect(validateOpenUrl(null).ok).toBe(false);
    expect(validateOpenUrl(42).ok).toBe(false);
    expect(validateOpenUrl("not a url at all").ok).toBe(false);
  });
});

describe("isPrivateOrLoopbackHost", () => {
  it("flags loopback hosts", () => {
    expect(isPrivateOrLoopbackHost("localhost")).toBe(true);
    expect(isPrivateOrLoopbackHost("dev.localhost")).toBe(true);
    expect(isPrivateOrLoopbackHost("127.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("127.42.0.5")).toBe(true);
    expect(isPrivateOrLoopbackHost("::1")).toBe(true);
  });
  it("flags localhost names with a trailing DNS root dot", () => {
    expect(isPrivateOrLoopbackHost("localhost.")).toBe(true);
    expect(isPrivateOrLoopbackHost("dev.localhost.")).toBe(true);
  });
  it("flags AWS / GCP cloud-metadata addresses", () => {
    expect(isPrivateOrLoopbackHost("169.254.169.254")).toBe(true);
    expect(isPrivateOrLoopbackHost("169.254.0.1")).toBe(true);
  });
  it("flags RFC1918 private ranges", () => {
    expect(isPrivateOrLoopbackHost("10.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("10.255.255.255")).toBe(true);
    expect(isPrivateOrLoopbackHost("172.16.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("172.31.255.254")).toBe(true);
    expect(isPrivateOrLoopbackHost("192.168.1.1")).toBe(true);
  });
  it("does NOT flag 172.15 / 172.32 (just outside RFC1918)", () => {
    expect(isPrivateOrLoopbackHost("172.15.0.1")).toBe(false);
    expect(isPrivateOrLoopbackHost("172.32.0.1")).toBe(false);
  });
  it("flags IPv6 link-local and unique-local", () => {
    expect(isPrivateOrLoopbackHost("fe80::1")).toBe(true);
    expect(isPrivateOrLoopbackHost("fc00::1")).toBe(true);
    expect(isPrivateOrLoopbackHost("fd00::1")).toBe(true);
  });
  it("flags IPv4-mapped IPv6 private and loopback addresses", () => {
    expect(isPrivateOrLoopbackHost("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("::ffff:7f00:1")).toBe(true);
    expect(isPrivateOrLoopbackHost("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateOrLoopbackHost("::ffff:a9fe:a9fe")).toBe(true);
    expect(isPrivateOrLoopbackHost("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("::ffff:8.8.8.8")).toBe(false);
  });
  it("does not flag normal public hosts", () => {
    expect(isPrivateOrLoopbackHost("api.openai.com")).toBe(false);
    expect(isPrivateOrLoopbackHost("example.com")).toBe(false);
    expect(isPrivateOrLoopbackHost("8.8.8.8")).toBe(false);
  });
});

describe("validateSttBaseUrl", () => {
  it("accepts https public endpoints", () => {
    expect(validateSttBaseUrl("https://api.openai.com/v1/audio/transcriptions").ok).toBe(true);
    expect(validateSttBaseUrl("https://my-tenant.openai.azure.com/openai/deployments/x").ok).toBe(true);
  });
  it("rejects http (plaintext bearer would leak)", () => {
    const r = validateSttBaseUrl("http://api.openai.com/v1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("disallowed-protocol");
  });
  it("rejects non-http(s) schemes outright", () => {
    expect(validateSttBaseUrl("file:///etc/passwd").ok).toBe(false);
    expect(validateSttBaseUrl("ws://api.openai.com/").ok).toBe(false);
    expect(validateSttBaseUrl("data:text/plain,foo").ok).toBe(false);
  });
  it("rejects loopback / private / metadata hosts (SSRF guard)", () => {
    for (const url of [
      "https://localhost/v1",
      "https://localhost./v1",
      "https://dev.localhost./v1",
      "https://127.0.0.1/v1",
      "https://169.254.169.254/latest/meta-data/",
      "https://10.0.0.5/v1",
      "https://192.168.1.100/v1",
      "https://172.16.0.1/v1",
      "https://[::1]/v1",
      "https://[::ffff:127.0.0.1]/v1",
      "https://[::ffff:169.254.169.254]/v1",
      "https://[::ffff:10.0.0.1]/v1",
    ]) {
      const r = validateSttBaseUrl(url);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("private-host");
    }
  });
  it("rejects embedded credentials", () => {
    const r = validateSttBaseUrl("https://victim:token@attacker.com/v1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("credentials-in-url");
  });
  it("rejects empty / non-string / unparseable input", () => {
    expect(validateSttBaseUrl("").ok).toBe(false);
    expect(validateSttBaseUrl(null).ok).toBe(false);
    expect(validateSttBaseUrl(42).ok).toBe(false);
    expect(validateSttBaseUrl("not a url").ok).toBe(false);
  });
});

describe("resolveSttConfiguration", () => {
  it("normalizes Azure OpenAI endpoints to the configured deployment transcription route", () => {
    expect(
      resolveSttConfiguration(
        " sk-test ",
        "https://example.openai.azure.com/openai/deployments/gpt-4o-transcribe",
        "gpt-4o-transcribe",
      ),
    ).toEqual({
      ok: true,
      apiKey: "sk-test",
      baseUrl: "https://example.openai.azure.com/openai/deployments/gpt-4o-transcribe/audio/transcriptions?api-version=2025-01-01-preview",
    });
  });

  it("normalizes Azure AI Foundry model roots to Azure OpenAI transcription endpoints", () => {
    expect(
      resolveSttConfiguration(
        "sk-test",
        "https://aif-example.services.ai.azure.com/models",
        "gpt-4o-transcribe",
      ),
    ).toEqual({
      ok: true,
      apiKey: "sk-test",
      baseUrl: "https://aif-example.openai.azure.com/openai/deployments/gpt-4o-transcribe/audio/transcriptions?api-version=2025-01-01-preview",
    });
  });

  it("normalizes Azure OpenAI roots to the selected deployment transcription route", () => {
    expect(
      resolveSttConfiguration(
        "sk-test",
        "https://aif-example.openai.azure.com/",
        "gpt-4o-transcribe-diarize",
      ),
    ).toEqual({
      ok: true,
      apiKey: "sk-test",
      baseUrl: "https://aif-example.openai.azure.com/openai/deployments/gpt-4o-transcribe-diarize/audio/transcriptions?api-version=2025-01-01-preview",
    });
  });

  it("normalizes OpenAI roots to the standard audio transcriptions endpoint", () => {
    expect(
      resolveSttConfiguration(
        "sk-test",
        "https://api.openai.com/v1",
        "gpt-4o-transcribe",
      ),
    ).toEqual({
      ok: true,
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1/audio/transcriptions",
    });
  });

  it("rejects missing API key", () => {
    const r = resolveSttConfiguration("", "https://api.openai.com/v1/audio/transcriptions", "gpt-4o-transcribe");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("missing-api-key");
  });

  it("defaults missing endpoint to the OpenAI public transcription endpoint", () => {
    expect(resolveSttConfiguration("sk-test", "", "gpt-4o-transcribe")).toEqual({
      ok: true,
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1/audio/transcriptions",
    });
  });

  it("rejects invalid endpoint", () => {
    const r = resolveSttConfiguration("sk-test", "http://localhost/v1", "gpt-4o-transcribe");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid-base-url");
  });
});

describe("assertBundleId", () => {
  it("accepts valid lowercase-letter-leading identifiers", () => {
    expect(() => assertBundleId("meeting")).not.toThrow();
    expect(() => assertBundleId("my-plugin")).not.toThrow();
    expect(() => assertBundleId("a")).not.toThrow();
    expect(() => assertBundleId("a" + "b".repeat(63))).not.toThrow(); // 64 chars
  });
  it("rejects identifiers that start with a digit or hyphen", () => {
    expect(() => assertBundleId("1plugin")).toThrow();
    expect(() => assertBundleId("-plugin")).toThrow();
  });
  it("rejects uppercase letters", () => {
    expect(() => assertBundleId("Meeting")).toThrow();
    expect(() => assertBundleId("MEETING")).toThrow();
  });
  it("rejects strings longer than 64 chars", () => {
    expect(() => assertBundleId("a" + "b".repeat(64))).toThrow(); // 65 chars
    expect(() => assertBundleId("a".repeat(200))).toThrow();
  });
  it("rejects strings with shell metacharacters or whitespace", () => {
    expect(() => assertBundleId("plugin;rm")).toThrow();
    expect(() => assertBundleId("plugin space")).toThrow();
    expect(() => assertBundleId("plugin\n")).toThrow();
    expect(() => assertBundleId("plugin/sub")).toThrow();
  });
  it("rejects empty string and non-string values", () => {
    expect(() => assertBundleId("")).toThrow();
    expect(() => assertBundleId(null)).toThrow();
    expect(() => assertBundleId(undefined)).toThrow();
    expect(() => assertBundleId(42)).toThrow();
    expect(() => assertBundleId({})).toThrow();
  });
  it("error message contains a truncated preview of invalid input", () => {
    const longBad = "A".repeat(200);
    expect(() => assertBundleId(longBad)).toThrow(/Invalid bundleId format/);
  });
});

describe("resolvePythonExecutable", () => {
  it("falls back to 'python' when no value supplied", () => {
    expect(resolvePythonExecutable(undefined)).toBe("python");
    expect(resolvePythonExecutable(null)).toBe("python");
    expect(resolvePythonExecutable("")).toBe("python");
  });
  it("accepts the literal interpreter names", () => {
    expect(resolvePythonExecutable("python")).toBe("python");
    expect(resolvePythonExecutable("python3")).toBe("python3");
    expect(resolvePythonExecutable("py")).toBe("py");
  });
  it("rejects shell metacharacters", () => {
    expect(() => resolvePythonExecutable("python && calc.exe")).toThrow();
    expect(() => resolvePythonExecutable("python; rm")).toThrow();
    expect(() => resolvePythonExecutable("python|cat")).toThrow();
    expect(() => resolvePythonExecutable("python$HOME")).toThrow();
    expect(() => resolvePythonExecutable("python`evil`")).toThrow();
    expect(() => resolvePythonExecutable("python\nls")).toThrow();
  });
  it("rejects relative non-literal paths", () => {
    expect(() => resolvePythonExecutable("./python")).toThrow();
    expect(() => resolvePythonExecutable("bin/python")).toThrow();
    expect(() => resolvePythonExecutable("py-custom")).toThrow();
  });
  it("rejects absolute paths that don't exist", () => {
    expect(() => resolvePythonExecutable("/definitely/not/here/python")).toThrow();
    expect(() => resolvePythonExecutable("C:\\nope\\python.exe")).toThrow();
  });
});

describe("sanitizePreview", () => {
  it("passes through clean ASCII strings unchanged", () => {
    expect(sanitizePreview("hello-world")).toBe("hello-world");
    expect(sanitizePreview("meeting-plugin")).toBe("meeting-plugin");
  });
  it("replaces CR, LF, and NUL with '?' (log injection prevention)", () => {
    expect(sanitizePreview("evil\ninjection")).toBe("evil?injection");
    expect(sanitizePreview("evil\rinjection")).toBe("evil?injection");
    expect(sanitizePreview("evil\0injection")).toBe("evil?injection");
    expect(sanitizePreview("line1\r\nline2")).toBe("line1??line2");
  });
  it("replaces all ASCII control chars (0x00–0x1F and 0x7F)", () => {
    expect(sanitizePreview("\x01\x1f\x7f")).toBe("???");
    expect(sanitizePreview("\t")).toBe("?");
  });
  it("truncates output to 64 characters", () => {
    const long = "a".repeat(100);
    expect(sanitizePreview(long)).toHaveLength(64);
  });
  it("JSON-serialises non-string values before sanitizing", () => {
    expect(sanitizePreview(42)).toBe("42");
    expect(sanitizePreview(null)).toBe("null");
    expect(sanitizePreview({ x: 1 })).toBe('{"x":1}');
  });
  it("sanitizes injection embedded in serialized object", () => {
    const result = sanitizePreview({ bad: "val\nue" });
    expect(result).not.toContain("\n");
  });
});
