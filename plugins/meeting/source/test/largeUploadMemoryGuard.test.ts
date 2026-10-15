import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flattenAgentPluginsManifest } from "@ave/plugin-contract";

describe("large upload memory guard", () => {
  it("does not use whole-file WebAudio decode for >25MB uploads", () => {
    const ui = readFileSync(new URL("../src/ui/meeting-control.js", import.meta.url), "utf8");

    expect(ui).not.toContain("decodeAudioData");
    expect(ui).not.toContain("file.arrayBuffer()");
    expect(ui).not.toContain("file.stream");
    expect(ui).toContain("file.slice(offset, offset + chunkBytes).arrayBuffer()");
    expect(ui).toContain("meeting_stage_upload_chunk");
    expect(ui).toContain("uploadLargeFileViaStagedChunks");
    expect(ui).toContain("LARGE_UPLOAD_CHUNK_MIN_INTERVAL_MS");
    expect(ui).toContain("waitForUploadPace");
  });

  it("keeps staged upload methods UI-callable but not LLM-callable", () => {
    const manifest = flattenAgentPluginsManifest(
      JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8")),
    ) as unknown as {
      tools: Array<{ name: string; description?: string; _meta?: { ui?: { visibility?: string[] } } }>;
    };
    const tools = manifest.tools ?? [];
    const toolByName = new Map(tools.map((t) => [t.name, t]));
    const uiActions = tools.filter((t) => t._meta?.ui?.visibility?.includes("app")).map((t) => t.name);
    const llmTools = tools.filter((t) => t._meta?.ui?.visibility?.includes("model")).map((t) => t.name);
    const stagedTools = [
      "meeting_stage_upload_begin",
      "meeting_stage_upload_chunk",
      "meeting_stage_upload_finish",
      "meeting_stage_upload_cancel",
    ];

    for (const tool of stagedTools) {
      expect(uiActions).toContain(tool);
      expect(llmTools).not.toContain(tool);
      expect(toolByName.get(tool)?.description).toBeUndefined();
    }
  });

  it("bounds staged ffmpeg work before segmenting", () => {
    const host = readFileSync(new URL("../src/hostPlugin.ts", import.meta.url), "utf8");

    expect(host).toContain("runFfprobeDurationSec");
    expect(host).toContain("STAGED_UPLOAD_MAX_DURATION_SEC");
    expect(host).toContain("STAGED_UPLOAD_FFMPEG_TIMEOUT_MS");
    expect(host).toContain("parsePcmWavDurationSec");
    expect(host).toContain("resolveFfmpegExecutable");
    expect(host).toContain("dist/vendor/ffmpeg");
    expect(host).toContain("expected plugin-managed binary");
    expect(host).toContain("runFfmpegSegmenter");
    expect(host).toContain('"-threads"');
    expect(host).toContain("cleanupStaleStagedUploads");
    expect(host).toContain("protectedDirs.has(dir)");
    expect(host).toContain("now - state.lastActivityAt");
    expect(host).toContain("state.lastActivityAt = Date.now()");
    expect(host.indexOf("statSync(filePath).size")).toBeLessThan(host.indexOf("readFileSync(filePath)"));
  });
  it("bootstraps FFmpeg runtime per platform at plugin boot", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
    };
    const build = pkg.scripts.build;
    expect(build).not.toContain("scripts/install-ffmpeg-vendor.mjs");
    expect(build).toContain("scripts/copy-ffmpeg-vendor.mjs");

    const host = readFileSync(new URL("../src/hostPlugin.ts", import.meta.url), "utf8");
    expect(host).toContain("scheduleFfmpegRuntimeCheck();");
    expect(host).toContain("await requireFfmpegRuntime();");
    expect(host).toContain("managedFfmpegPlatformDir(context.pluginDataDir)");
    expect(host).toContain("ffmpegRuntimeLibraryEnv(executable)");

    const runtime = readFileSync(new URL("../src/ffmpegRuntime.ts", import.meta.url), "utf8");
    for (const platform of ["win32-x64", "win32-arm64", "linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]) {
      expect(runtime).toContain(`"${platform}"`);
    }
    expect(runtime).toContain("AVE_MEETING_FFMPEG_AUTO_INSTALL");
    expect(runtime).toContain("pluginDataDir");
    expect(runtime).toContain("BtbN/FFmpeg-Builds");
    expect(runtime).toContain("ColorsWind/FFmpeg-macOS");

    const copyScript = readFileSync(new URL("../scripts/copy-ffmpeg-vendor.mjs", import.meta.url), "utf8");
    expect(copyScript).toContain("skipped; no local FFmpeg vendor");
    expect(copyScript).not.toContain("REQUIRED_PLATFORMS");

    const installScript = readFileSync(new URL("../scripts/install-ffmpeg-vendor.mjs", import.meta.url), "utf8");
    expect(installScript).toContain("darwin-arm64");
    expect(installScript).toContain("linux-arm64");
    expect(installScript).not.toContain("only Windows x64 is supported");
  });});
