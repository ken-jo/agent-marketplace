/**
 * recorder-card.js theme-paint TARGET invariant.
 *
 * THIS RULE INVERTED when the recorder moved into the host's floating dock,
 * and the inversion is the whole reason the file is worth keeping.
 *
 * It used to require `primeTheme(host, { target: document })`, because the
 * recorder owned a whole detached BrowserWindow: its document was its own, the
 * SDK contract puts `data-shell` on `documentElement`, and a body-scoped write
 * would have matched nothing.
 *
 * The card does not own a document any more. It is one slot in a window the
 * host owns, sharing that document with the dock's own chrome and with any
 * other plugin's slot. Painting `documentElement` there would let whichever
 * card primed last decide everybody's theme — including the host's — and the
 * loser would be a plugin that did nothing wrong.
 *
 * So the target is the card's own shell element, and the CSS is scoped to it.
 * There is no runtime signal for getting this wrong: a card that paints the
 * document works perfectly when it is the only one attached, which is exactly
 * the configuration it will be developed in.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RECORDER_CARD = join(__dirname, "..", "src", "ui", "recorder-card.js");

describe("recorder-card.js — theme paint stays inside the card", () => {
  const src = readFileSync(RECORDER_CARD, "utf8");

  it("does not write theme attrs to the shared document", () => {
    // Either element is somebody else's: `documentElement` is the dock's, and
    // `body` is the dock's too. The card owns neither.
    for (const target of ["documentElement", "body"]) {
      expect(src).not.toMatch(
        new RegExp(`document\\.${target}\\.setAttribute\\(\\s*["']data-(shell|theme-bundle)`, "u"),
      );
      expect(src).not.toMatch(
        new RegExp(`document\\.${target}\\.removeAttribute\\(\\s*["']data-(shell|theme-bundle)`, "u"),
      );
    }
  });

  it("does not write --ave-* tokens onto the shared document", () => {
    for (const target of ["documentElement", "body"]) {
      expect(src).not.toMatch(
        new RegExp(`document\\.${target}\\.style\\.(setProperty|removeProperty)\\(\\s*["']--ave-`, "u"),
      );
    }
  });

  it("scopes its data-shell CSS to the card, not to :root or body", () => {
    // The inverted half of the old assertion. `:root[data-shell]` was correct
    // when the document was the card's; in a shared document it is a rule one
    // plugin writes about everyone's pixels.
    expect(src).not.toMatch(/:root\[data-shell/);
    expect(src).not.toMatch(/body\[data-shell/);
    expect(src).toMatch(/\.shell\[data-shell="dark"\]/);
  });

  it("imports primeTheme from the vendored local module (not hand-rolled)", () => {
    expect(src).toMatch(
      /import\s*\{\s*primeTheme\s*\}\s*from\s*["']\.\/prime-theme\.js["']/,
    );
  });

  it("primes theme against the card's own shell element", () => {
    // The positive half. Every assertion above is satisfied by a card that
    // never primes theme at all — which would render against the `var(--ave-*,
    // #hex)` fallbacks and quietly ignore the user's choice.
    expect(src).toMatch(
      /primeTheme\s*\(\s*bridge\s*,\s*\{[^}]*target\s*:\s*shell\b/,
    );
  });
});
