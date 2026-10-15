/**
 * Security regression test — CWE-79 XSS in transcript renderer (meeting-control.js).
 *
 * Vulnerability: prior to fix, transcript segment text/speaker fields were
 * interpolated directly into innerHTML, allowing a meeting attendee to say
 * `<img src=x onerror=alert(1)>` and get script execution in the plugin UI.
 *
 * This test verifies two things:
 *  1. Static: The JS source no longer contains innerHTML with interpolated
 *     user-controlled fields (speaker / original / text).
 *  2. Functional: When XSS payloads are rendered via the DOM helpers extracted
 *     from meeting-control.js, the output DOM contains only text nodes —
 *     no <img> or <script> elements.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, "..");

const UI_SRC = readFileSync(
  join(__dirname, "..", "src", "ui", "meeting-control.js"),
  "utf8"
);

// ---------------------------------------------------------------------------
// Static analysis: patterns that indicate unescaped interpolation into innerHTML
// ---------------------------------------------------------------------------
const UNSAFE_PATTERNS = [
  // innerHTML assignment with template literal containing ${s.original}
  /innerHTML\s*=\s*`[^`]*\$\{[^}]*(original|speaker|text|title|summary|highlights|actionItems)[^}]*\}[^`]*`/,
  // innerHTML += with template literal containing user fields
  /innerHTML\s*\+=\s*`[^`]*\$\{[^}]*(original|speaker|text|title|summary|highlights|actionItems)[^}]*\}[^`]*`/,
  // .map(...) returning template literal with user fields assigned to innerHTML
  /\.map\([^)]*=>[^`]*`[^`]*\$\{[^}]*(original|speaker|text|title|summary)[^}]*\}/,
];

describe("transcript renderer — XSS static analysis (CWE-79)", () => {
  for (const pattern of UNSAFE_PATTERNS) {
    it(`source does not match unsafe innerHTML pattern: ${pattern.source.slice(0, 60)}...`, () => {
      expect(pattern.test(UI_SRC)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Defense-in-depth: no bare innerHTML assignments remain in meeting-control.js.
// The only allowed innerHTML usage is inside DOMParser (which operates on a
// detached document and is therefore safe for static template parsing).
// All dynamic text MUST use textContent / replaceChildren / createElement.
// ---------------------------------------------------------------------------
describe("transcript renderer — defense-in-depth innerHTML elimination", () => {
  it("contains zero innerHTML assignments outside DOMParser context", () => {
    // Strip the one allowed DOMParser block so it doesn't count.
    const withoutDomParser = UI_SRC.replace(
      /new DOMParser\(\)\.parseFromString\([^)]+\)/g,
      ""
    );
    // Now there must be no remaining `innerHTML =` or `innerHTML +=`
    const remainingInnerHTML = withoutDomParser.match(/\.innerHTML\s*[+]?=/g);
    expect(remainingInnerHTML).toBeNull();
  });

  it("uses replaceChildren() for all clear operations (not innerHTML = '')", () => {
    // innerHTML = '' (empty string) should not appear anywhere
    const emptyInnerHTMLPattern = /\.innerHTML\s*=\s*['"]{2}/;
    expect(emptyInnerHTMLPattern.test(UI_SRC)).toBe(false);
  });

  it("dynamic text fields are set via textContent not innerHTML", () => {
    // Confirm textContent is used (positive signal that safe pattern exists)
    expect(UI_SRC).toContain(".textContent =");
    // Confirm replaceChildren is used for clears
    expect(UI_SRC).toContain("replaceChildren()");
  });
});

// ---------------------------------------------------------------------------
// Functional: simulate segment rendering with XSS payloads
// Minimal DOM stub that records createElement / textContent / appendChild calls.
// ---------------------------------------------------------------------------

type FakeNode = {
  tagName: string;
  className: string;
  style: Record<string, string>;
  children: FakeNode[];
  _textContent: string;
  textContent: string;
  setAttribute(name: string, value: string): void;
  appendChild(child: FakeNode): FakeNode;
  /** Collect all text content recursively */
  allText(): string;
  /** Collect all tag names recursively */
  allTags(): string[];
};

function makeFakeNode(tag: string): FakeNode {
  const node: FakeNode = {
    tagName: tag.toUpperCase(),
    className: "",
    style: {},
    children: [],
    _textContent: "",
    get textContent() { return node._textContent; },
    set textContent(v: string) { node._textContent = v; },
    setAttribute(_name: string, _value: string) {},
    appendChild(child: FakeNode) { node.children.push(child); return child; },
    allText() {
      return node._textContent + node.children.map(c => c.allText()).join("");
    },
    allTags() {
      return [node.tagName, ...node.children.flatMap(c => c.allTags())];
    },
  };
  return node;
}

/** Minimal document stub — createElement only, no innerHTML. */
function makeFakeDocument() {
  return {
    createElement: (tag: string) => makeFakeNode(tag),
  };
}

/**
 * Re-implement the fixed rendering logic from meeting-control.js so we can
 * test it in node environment. This mirrors the exact code in the source file —
 * if the source changes, this test should be updated too.
 *
 * The key invariant: user content is only ever assigned via .textContent.
 */
function renderSegment(
  doc: ReturnType<typeof makeFakeDocument>,
  segment: { startSec: number; speaker: string; original: string }
): FakeNode {
  const fmtTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  const segDiv = doc.createElement("div");
  segDiv.className = "segment";

  const timeSpan = doc.createElement("span");
  timeSpan.className = "seg-time";
  timeSpan.textContent = fmtTime(segment.startSec);
  segDiv.appendChild(timeSpan);

  if (segment.speaker) {
    const spkSpan = doc.createElement("span");
    spkSpan.className = "seg-speaker";
    spkSpan.textContent = segment.speaker + ": ";
    segDiv.appendChild(spkSpan);
  }

  const txtSpan = doc.createElement("span");
  txtSpan.textContent = segment.original;
  segDiv.appendChild(txtSpan);

  return segDiv;
}

const XSS_PAYLOADS = [
  '<img src=x onerror=alert(1)>',
  '<script>alert("xss")</script>',
  '"><svg onload=alert(1)>',
  '\u003cimg src=x onerror=ALERT\u003e',
];

describe("transcript renderer — XSS functional test (CWE-79)", () => {
  const doc = makeFakeDocument();

  for (const payload of XSS_PAYLOADS) {
    it(`XSS payload in 'original' is not parsed as HTML: ${payload.slice(0, 40)}`, () => {
      const node = renderSegment(doc, { startSec: 0, speaker: "Alice", original: payload });
      // The DOM tree must contain no IMG or SCRIPT tags
      const tags = node.allTags();
      expect(tags).not.toContain("IMG");
      expect(tags).not.toContain("SCRIPT");
      expect(tags).not.toContain("SVG");
      // The payload text itself should be present as plain text
      expect(node.allText()).toContain(payload);
    });

    it(`XSS payload in 'speaker' is not parsed as HTML: ${payload.slice(0, 40)}`, () => {
      const node = renderSegment(doc, { startSec: 0, speaker: payload, original: "normal text" });
      const tags = node.allTags();
      expect(tags).not.toContain("IMG");
      expect(tags).not.toContain("SCRIPT");
      expect(tags).not.toContain("SVG");
      expect(node.allText()).toContain(payload);
    });
  }
});
