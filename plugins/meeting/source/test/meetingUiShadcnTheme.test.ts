import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RECORDER_JS = readFileSync(join(__dirname, "..", "src", "ui", "recorder-card.js"), "utf8");
const MEETING_CONTROL_JS = readFileSync(join(__dirname, "..", "src", "ui", "meeting-control.js"), "utf8");

describe("meeting UI shadcn theme convergence", () => {
  it("keeps the floating recorder on shadcn-compatible semantic tokens", () => {
    expect(RECORDER_JS).toContain("shadcn-compatible semantic layer");
    for (const token of [
      "--background",
      "--foreground",
      "--card",
      "--primary",
      "--primary-foreground",
      "--muted",
      "--muted-foreground",
      "--input",
      "--ring",
      "--toggle-hover-bg",
      "--toggle-hover-shadow",
      "--toggle-selected-shadow",
      "--motion-fast",
    ]) {
      expect(RECORDER_JS).toContain(token);
    }
  });

  it("renders recorder tab and capture-mode selection with visible primary state", () => {
    expect(RECORDER_JS).toMatch(/\.tab\.active,[\s\S]*?\.tab\[data-state="active"\][\s\S]*?background:\s*var\(--primary\)/);
    expect(RECORDER_JS).toMatch(/\.mode-opt\.active,[\s\S]*?\.mode-opt\[data-state="active"\][\s\S]*?background:\s*var\(--primary\)/);
    expect(RECORDER_JS).toMatch(/\.tab:focus-visible,[\s\S]*?\.btn:focus-visible[\s\S]*?var\(--ring\)/);
  });

  it("keeps recorder toggles visibly animated on hover and press", () => {
    expect(RECORDER_JS).toMatch(/\.tab:hover:not\(\[data-state="active"\]\)[\s\S]*?box-shadow:\s*var\(--toggle-hover-shadow\)[\s\S]*?transform:\s*translateY\(-1px\)/);
    expect(RECORDER_JS).toMatch(/\.mode-opt:hover:not\(\[data-state="active"\]\)[\s\S]*?box-shadow:\s*var\(--toggle-hover-shadow\)[\s\S]*?transform:\s*translateY\(-1px\)/);
    expect(RECORDER_JS).toMatch(/\.tab:active[\s\S]*?transform:\s*translateY\(0\) scale\(\.98\)/);
    expect(RECORDER_JS).toMatch(/transition:[\s\S]*?background var\(--motion-fast\) ease[\s\S]*?transform var\(--motion-fast\) ease/);
  });

  it("exposes recorder selected state through aria and data-state", () => {
    expect(RECORDER_JS).toContain('role: "tab"');
    expect(RECORDER_JS).toContain('"aria-selected": "true"');
    expect(RECORDER_JS).toContain('role: "radio"');
    expect(RECORDER_JS).toContain('"aria-checked": "false"');
    expect(RECORDER_JS).toContain('"data-state": "active"');
  });

  it("keeps the main meeting UI on SOT host tokens (--ave-*) with plugin computed vars (--pm-*)", () => {
    // SOT amendment: shadcn intermediate layer removed. All styling uses --ave-* directly.
    // Plugin-internal computed values use --pm-* prefix (color-mix expressions with no host equivalent).
    expect(MEETING_CONTROL_JS).toContain("Plugin-internal computed vars");
    for (const token of [
      "--ave-bg",
      "--ave-fg",
      "--ave-surface",
      "--ave-primary",
      "--ave-primary-fg",
      "--ave-secondary",
      "--ave-fg-muted",
      "--ave-border",
      "--ave-ring",
      "--pm-toggle-hover-bg",
      "--pm-toggle-hover-shadow",
      "--pm-toggle-selected-shadow",
      "--ave-motion-fast",
    ]) {
      expect(MEETING_CONTROL_JS).toContain(token);
    }
  });

  it("only consumes CSS vars matching the SOT allowlist (--ave-*, --pm-*, --font)", () => {
    // Critic Q4 — negative-presence test only catches the 19 enumerated
    // legacy alias names. An allowlist closes the drift surface entirely:
    // any future var(--whatever) that doesn't match the SOT prefix pattern
    // will fail this test, catching both the old aliases and any new
    // ad-hoc names someone might add (e.g. var(--accent-bg), var(--text-2)).
    //
    // Allowed prefixes:
    //   --ave-*   host SOT tokens (plugin-ui-tokens.ts AVE_TOKEN_NAMES)
    //   --pm-*     plugin-local computed values (color-mix derivations)
    //   --font     legacy font-family declaration (kept for back-compat)
    const ALLOWED_VAR_PREFIX = /^--(ave|pm|font)-?[a-zA-Z0-9-]*$/;
    const varReferences = MEETING_CONTROL_JS.matchAll(/var\((--[a-zA-Z0-9-]+)/g);
    const violations: string[] = [];
    for (const match of varReferences) {
      const name = match[1];
      if (name && !ALLOWED_VAR_PREFIX.test(name)) violations.push(name);
    }
    const unique = [...new Set(violations)];
    expect(unique, `Disallowed CSS var names: ${unique.join(", ")}`).toEqual([]);
  });

  it("uses visible primary state and focus ring for main meeting tabs/radios", () => {
    expect(MEETING_CONTROL_JS).toMatch(/\.ave-meeting-ui \.nav-btn\[data-state="active"\],[\s\S]*?\.ave-meeting-ui \.length-tier-opt\[data-state="active"\][\s\S]*?background:\s*var\(--ave-primary/);
    expect(MEETING_CONTROL_JS).toMatch(/:where\(button, input, textarea, select\):focus-visible[\s\S]*?var\(--ave-ring/);
    expect(MEETING_CONTROL_JS).toContain('role: "tab"');
    expect(MEETING_CONTROL_JS).toContain('role: "radio"');
    expect(MEETING_CONTROL_JS).toContain('"data-state": pickedLengthTier === o.value ? "active" : "inactive"');
  });

  it("sizes the top tabs to their labels instead of dividing the row", () => {
    // The panel is no longer clamped by the host, so a tab bar whose buttons
    // grow fills whatever width the pane has: at the 860px cap two tabs became
    // two ~430px buttons. Parse the declaration rather than grepping for a
    // string, so the assertion is about the grow factor and not about how the
    // shorthand happens to be spelled.
    const block = /\.ave-meeting-ui \.nav-btn \{([^}]*)\}/.exec(MEETING_CONTROL_JS);
    expect(block, "no .ave-meeting-ui .nav-btn rule found").not.toBeNull();
    const flex = /(?:^|;)\s*flex:\s*([^;]+)/.exec(block![1]!);
    expect(flex, "the .nav-btn rule declares no flex").not.toBeNull();
    const grow = flex![1]!.trim().split(/\s+/)[0];
    expect(grow, `.nav-btn flex is "${flex![1]!.trim()}" — a growing tab spreads across the pane`).toBe("0");
    // Shrink + a floor are what wrapping needs; losing them would clip labels.
    expect(block![1]).toMatch(/min-width:\s*\d+px/);
    expect(MEETING_CONTROL_JS).toMatch(/\.ave-meeting-ui \.top-nav \{[^}]*flex-wrap:\s*wrap/);
  });

  it("keeps main meeting toggles visibly animated on hover and press", () => {
    expect(MEETING_CONTROL_JS).toMatch(/\.ave-meeting-ui \.nav-btn:hover:not\(\[data-state="active"\]\),[\s\S]*?\.ave-meeting-ui \.summary-regen-tier:hover:not\(:disabled\)[\s\S]*?box-shadow:\s*var\(--pm-toggle-hover-shadow\)[\s\S]*?transform:\s*translateY\(-1px\)/);
    expect(MEETING_CONTROL_JS).toMatch(/\.ave-meeting-ui \.nav-btn:active,[\s\S]*?\.ave-meeting-ui \.summary-regen-tier:active[\s\S]*?transform:\s*translateY\(0\) scale\(\.98\)/);
    expect(MEETING_CONTROL_JS).toMatch(/transition:[\s\S]*?background var\(--ave-motion-fast/);
  });
});
