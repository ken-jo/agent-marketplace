/**
 * Issue #94 — prompt editing must stay on the plugin webview's UI-only
 * config bridge. Reintroducing a prompt-write plugin tool would make the
 * persistent summarizer system prompt reachable from normal LLM/tool flows.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const UI_PATH = join(__dirname, "..", "src", "ui", "meeting-control.js");

describe("meeting prompt editor UI bridge", () => {
  const source = readFileSync(UI_PATH, "utf8");

  it("persists prompts through bridge.config, not bridge.callTool", () => {
    expect(source).toContain('bridge.config.get("customSummaryFinalPrompt")');
    expect(source).toContain('bridge.config.get("customSummaryIntermediatePrompt")');
    expect(source).toContain('bridge.config.set("customSummaryFinalPrompt"');
    expect(source).toContain('bridge.config.set("customSummaryIntermediatePrompt"');
    expect(source).not.toMatch(/callTool\??\.?\(\s*["']meeting_update_ui_config["']/);
  });

  it("keeps UI config and theme relay off bridge.callTool", () => {
    expect(source).toContain('bridge.config.get("transcriptBubbleMaxChars")');
    expect(source).not.toMatch(/callTool\??\.?\(\s*["']meeting_get_ui_config["']/);
    expect(source).not.toMatch(/callTool\??\.?\(\s*["']meeting_propagate_theme["']/);
  });

  it("sanitizes UI-persisted prompt text before saving", () => {
    expect(source).toContain("const sanitized = sanitizeCustomPrompt(rawValue);");
    expect(source).toContain("const nextFinal = toPersistedPromptValue(finalPrompt, defaults.finalPrompt);");
    expect(source).toContain("const nextIntermediate = toPersistedPromptValue(intermediatePrompt, defaults.intermediatePrompt);");
  });
});
