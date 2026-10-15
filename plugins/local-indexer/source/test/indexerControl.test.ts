import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getDocumentEmptyMessage,
  getDocMetricLabel,
  getDocName,
  getDocPath,
  getDocType,
  getLineCount,
  getPageCount,
  getProgressPercent,
  getScanStatusText,
  isScanLocked,
  normalizeScanProgress,
} from "../src/ui/indexer-state.js";
import { STYLES } from "../src/ui/indexer-control.styles.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEXER_CONTROL_STYLES_SOURCE = readFileSync(
  join(__dirname, "..", "src", "ui", "indexer-control.styles.js"),
  "utf8",
);
const INDEXER_CONTROL_UI_SOURCE = readFileSync(
  join(__dirname, "..", "src", "ui", "indexer-control.js"),
  "utf8",
);

describe("indexer-control metadata helpers", () => {
  it("prefers snake_case document metadata from the DB", () => {
    const doc = {
      path: "/docs/notes.md",
      doc_name: "notes.md",
      doc_type: "md",
      line_count: 14,
    };

    expect(getDocName(doc)).toBe("notes.md");
    expect(getDocType(doc)).toBe("md");
    expect(getDocPath(doc)).toBe("/docs/notes.md");
    expect(getLineCount(doc)).toBe(14);
    expect(getDocMetricLabel(doc)).toBe("14 lines");
  });

  it("falls back to camelCase aliases for compatibility", () => {
    const doc = {
      path: "/docs/report.pdf",
      docName: "report.pdf",
      type: "pdf",
      pageCount: 9,
    };

    expect(getDocName(doc)).toBe("report.pdf");
    expect(getDocType(doc)).toBe("pdf");
    expect(getPageCount(doc)).toBe(9);
    expect(getDocMetricLabel(doc)).toBe("9 pages");
  });

  it("shows unknown counts only when the parser truly did not provide one", () => {
    expect(getDocMetricLabel({ doc_type: "txt" })).toBe("? lines");
    expect(getDocMetricLabel({ doc_type: "docx" })).toBe("? pages");
  });
});

describe("indexer-control scan progress helpers", () => {
  it("normalizes missing values into an idle snapshot", () => {
    expect(normalizeScanProgress(null)).toEqual({
      status: "idle",
      total: 0,
      processed: 0,
      indexed: 0,
      failed: 0,
      currentPath: undefined,
      message: undefined,
    });
  });

  it("computes progress percent for running and terminal scans", () => {
    expect(getProgressPercent({ status: "running", total: 10, processed: 4 })).toBe(40);
    expect(getProgressPercent({ status: "done", total: 0, processed: 0 })).toBe(100);
    expect(getProgressPercent({ status: "idle", total: 5, processed: 5 })).toBe(0);
  });

  it("reports locking only while the scan is running", () => {
    expect(isScanLocked({ status: "running" })).toBe(true);
    expect(isScanLocked({ status: "done" })).toBe(false);
    expect(isScanLocked({ status: "canceled" })).toBe(false);
    expect(isScanLocked({ status: "failed" })).toBe(false);
  });

  it("formats running, done, canceled, and failed status text", () => {
    expect(
      getScanStatusText({
        status: "running",
        total: 8,
        processed: 3,
        currentPath: "E:/docs/file.md",
      }),
    ).toContain("처리 완료 3 / 8");
    expect(getScanStatusText({ status: "done", total: 8, processed: 8 })).toBe(
      "스캔 완료. 처리 완료 8 / 8",
    );
    expect(getScanStatusText({ status: "canceled", total: 8, processed: 3 })).toBe(
      "스캔 중단됨. 처리 완료 3 / 8",
    );
    expect(
      getScanStatusText({ status: "failed", failed: 1, message: "실패: boom" }),
    ).toBe(
      "실패: boom",
    );
  });

  it("formats document empty state messages for default, error, and post-scan empty cases", () => {
    expect(getDocumentEmptyMessage()).toContain("No indexed documents yet.\nAdd a folder and run Scan.");
    expect(
      getDocumentEmptyMessage({ hasFolders: true, scanStatus: "done" }),
    ).toContain("인덱싱된 문서가 없습니다");
    expect(
      getDocumentEmptyMessage({ error: "worker unavailable" }),
    ).toContain("\nworker unavailable");
  });
});

describe("indexer-control theme scoping", () => {
  it("keeps fallback tokens scoped to the plugin container instead of :root", () => {
    expect(STYLES).toContain(".ave-local-indexer-ui {");
    expect(STYLES).not.toContain(":root {");
  });

  it("aligns native form-control color-scheme with the host shell", () => {
    expect(STYLES).toMatch(/\.ave-local-indexer-ui\[data-shell="light"\]\s*\{[\s\S]*?color-scheme:\s*light;/);
    expect(STYLES).toMatch(/\.ave-local-indexer-ui\[data-shell="dark"\]\s*\{[\s\S]*?color-scheme:\s*dark;/);
  });

  it("keeps direct UI colors on token-driven expressions only", () => {
    const sourceSansComments = INDEXER_CONTROL_STYLES_SOURCE
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const hardcodedColorPattern = /#[0-9a-fA-F]{3,8}\b|rgba?\(|\bwhite\b(?!-space)|\bblack\b/;
    expect(sourceSansComments).not.toMatch(hardcodedColorPattern);
  });

  it("uses ascii-safe folder status labels for Korean UI copy", () => {
    expect(INDEXER_CONTROL_UI_SOURCE).toContain('images_disabled: "\\uC774\\uBBF8\\uC9C0 \\uCEA1\\uC158 \\uAEBC\\uC9D0"');
    expect(INDEXER_CONTROL_UI_SOURCE).toContain('indexed: "\\uC644\\uB8CC"');
  });

  it("supports collapsible secondary sections so the scan actions stay visible", () => {
    expect(INDEXER_CONTROL_UI_SOURCE).toContain("decorateCollapsibleSection");
    expect(INDEXER_CONTROL_UI_SOURCE).toContain('decorateCollapsibleSection(settingsCardEl, "settings", true)');
    expect(INDEXER_CONTROL_STYLES_SOURCE).toContain('.ave-local-indexer-ui .collapsible-card[data-collapsed="true"] .card-body {');
    expect(INDEXER_CONTROL_STYLES_SOURCE).toContain(".ave-local-indexer-ui .card-head-actions {");
  });

  it("renders cloud-only caption settings in the settings card", () => {
    expect(INDEXER_CONTROL_UI_SOURCE).not.toContain('data-role="imageProviderLocal"');
    expect(INDEXER_CONTROL_UI_SOURCE).not.toContain('data-role="imageProviderCloud"');
    expect(INDEXER_CONTROL_UI_SOURCE).toContain("normalizeCaptionMode");
    expect(INDEXER_CONTROL_UI_SOURCE).toContain("Azure OpenAI (responses)");
    expect(INDEXER_CONTROL_UI_SOURCE).not.toContain("Local (BLIP)");
  });

  it("styles general warnings with stronger danger emphasis", () => {
    expect(INDEXER_CONTROL_UI_SOURCE).toContain('details.classList.add("warning-general")');
    expect(INDEXER_CONTROL_STYLES_SOURCE).toContain(".ave-local-indexer-ui .warning-group.warning-general {");
    expect(INDEXER_CONTROL_STYLES_SOURCE).toContain(".ave-local-indexer-ui .warning-item-general {");
  });

  it("derives button hover states from host semantic tokens", () => {
    expect(STYLES).toContain("--bg-muted: var(--ave-secondary");
    expect(STYLES).toContain("--bg-hover: var(--ave-surface-hover, var(--bg-muted))");
    expect(STYLES).toMatch(/\.ave-local-indexer-ui\[data-shell="light"\]\s*\{/);
    expect(STYLES).toContain("--bg-hover: var(--ave-secondary, var(--bg-muted));");
    expect(STYLES).toContain("--accent-hover: color-mix(in srgb, var(--accent-strong) 92%, var(--bg-card) 8%);");
    expect(STYLES).toContain("button:not(:disabled):hover { background: var(--accent-hover); }");
    expect(STYLES).toContain("button.primary-cta:hover");
    expect(STYLES).toContain("background: var(--accent-hover);");
  });

  it("uses warning semantics for pending folder badges", () => {
    expect(STYLES).toContain(".folder-badge.needs_scan { background: var(--ave-warning-bg-subtle); color: var(--warning); }");
    expect(STYLES).toContain(".folder-badge.images_disabled { background: var(--ave-warning-bg-subtle); color: var(--warning); }");
    expect(STYLES).not.toContain("--li-accent-bg");
    expect(STYLES).not.toContain("--li-success-bg");
    expect(STYLES).not.toContain("--li-warning-bg");
    expect(STYLES).not.toContain("--li-danger-bg");
  });

  it("replaces the problematic top decorative gradients with host token surfaces", () => {
    expect(STYLES).toContain("background: var(--bg-base);");
    expect(STYLES).toContain(".ave-local-indexer-ui .brand-icon {");
    expect(STYLES).toContain("background: var(--bg-hover);");
    expect(STYLES).toContain("button.primary-cta {");
    expect(STYLES).toContain("background: var(--accent-strong);");
    expect(STYLES).toContain("button.primary-cta:hover {");
    expect(STYLES).toContain("background: var(--accent-hover);");
    expect(STYLES).toContain(".ave-local-indexer-ui .scan-card {");
    expect(STYLES).toContain("background: var(--bg-card);");
    expect(STYLES).toContain(".ave-local-indexer-ui .progress-bar {");
    expect(STYLES).toContain("background: var(--accent-strong);");
  });

  it("keeps icon tiles and count pills on neutral host surfaces", () => {
    expect(STYLES).toContain(".ave-local-indexer-ui .brand-icon {");
    expect(STYLES).toContain("background: var(--bg-hover);");
    expect(STYLES).toContain("color: var(--accent);");
    expect(STYLES).toContain(".ave-local-indexer-ui .brand-sub b {");
    expect(STYLES).toContain(".ave-local-indexer-ui .card-title .count {");
    expect(STYLES).toContain(".ave-local-indexer-ui .card-title svg {");
    expect(STYLES).toContain("border: 1px solid var(--border);");
    expect(STYLES).toContain(".ave-local-indexer-ui .folder-icon {");
    expect(STYLES).toContain(".ave-local-indexer-ui .doc-icon-tile {");
    expect(STYLES).toContain(".ave-local-indexer-ui .preview-head svg { width: 16px; height: 16px; color: var(--accent-strong); flex: none; }");
    expect(STYLES).toContain(".ave-local-indexer-ui .preview-meta {");
  });

  it("keeps the running progress shimmer tied to the primary contrast token", () => {
    expect(STYLES).toContain(".ave-local-indexer-ui .scan-card[data-status=\"running\"] .progress-bar::after {");
    expect(STYLES).toContain("color-mix(in srgb, var(--accent-fg) 42%, transparent)");
  });

  it("renders empty messages with line breaks and fills the host shell at a readable density", () => {
    expect(STYLES).toContain(".ave-local-indexer-ui .doc-empty {");
    expect(STYLES).toContain("white-space: pre-line;");
    // Base font matches the meeting UI (13px).
    // so the view reads well whether the host places it inline (narrow sidebar)
    // or detached (wider canvas) — placement is decided by the host appMode.
    expect(STYLES).toContain("font-size: 13px;");
    // The content column fills the shell width and centres with a max-width cap
    // instead of assuming a fixed narrow sidebar column. The cap is 900px, not
    // the old 560px: the host stopped clamping the plugin panel to the chat
    // reading column, so a 560px cap left a wide panel mostly empty. Folder
    // rows and document counts are tabular, not prose — they want the room.
    expect(STYLES).toContain("max-width: 900px;");
    expect(STYLES).toContain("margin-inline: auto;");
    // Long unbreakable runs in the empty/failed state must not push the column
    // wider than the panel. Measured overflowing at 420px before this.
    expect(STYLES).toContain("overflow-wrap: anywhere;");
    expect(STYLES).toContain(".ave-local-indexer-ui .scan-actions button.icon-only { flex: none; }");
  });
});
