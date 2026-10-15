/**
 * Opening a link goes through the host, not through Electron's `shell`.
 *
 * WHY THIS IS A SOURCE-SHAPE TEST. Axis 2 — Electron's main-process API by any
 * resolution path — has no runtime signal here. A reintroduced
 * `require("electron").shell.openExternal` would WORK in a normal host process
 * and every behavioural case would still pass; it only fails once the plugin
 * runs confined, which is exactly the state this is meant to reach.
 *
 * And a literal grep for `electron` would not have caught the shape that was
 * here: the specifier was held in a variable and resolved through
 * `createRequire`, which is the construct a naive scan misses. So the guard is
 * on the RESOLUTION FORM, and it is paired with a positive assertion — without
 * one, deleting the capability outright would read as a clean pass.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/hostPlugin.ts", import.meta.url), "utf8");

/**
 * The same source with its COMMENTS removed.
 *
 * Needed because these guards match source text, and the file now carries a
 * header explaining what it no longer resolves — prose that names the very
 * construct being forbidden. Without this, documenting the absence would be
 * indistinguishable from the presence.
 *
 * Deliberately conservative: block comments, and `//` lines that start one.
 * A trailing `//` after code is left alone, because stripping to end-of-line
 * would also swallow anything following a `//` inside a string literal — and
 * that direction hides violations, which is the one failure this file cannot
 * afford. A guard that reports clean because it stopped looking is worse than
 * no guard.
 */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//"))
  .join("\n");

describe("hostPlugin does not reach Electron at all", () => {
  it("has no module-resolution path for the electron package", () => {
    // THE WHOLE AXIS, not just `shell`. Both users are gone — the link opener
    // through `hostApi.openExternalUrl`, and the recorder's own BrowserWindow
    // plus its twelve ipcMain channels through `hostApi.attachFloatingPanel` —
    // so the resolver they shared has nothing left to serve.
    //
    // Guarding the RESOLUTION FORM rather than the identifiers is what catches
    // it: the specifier was held in a variable and resolved through
    // `createRequire`, which is exactly the construct a literal grep for
    // "electron" misses.
    expect(code).not.toContain("createRequire");
    expect(code).not.toMatch(/require\s*\(\s*["']electron["']\s*\)/u);
    for (const api of ["BrowserWindow", "ipcMain", "getPrimaryDisplay", "fromPartition"]) {
      expect(code, `${api} is Electron main-process API`).not.toContain(api);
    }
  });

  it("gets its floating surface from the host instead of building one", () => {
    // The positive half, and the one that matters most here: every assertion
    // above is satisfied by deleting the floating recorder outright, which
    // would remove the feature rather than confine it.
    expect(source).toContain("hostApi.attachFloatingPanel");
    expect(source).toContain("RECORDER_PANEL_EXTENSION_ID");
  });

  it("refuses rather than falling back when the host has no dock", () => {
    const accessor = source.slice(
      source.indexOf("const attach = hostApi.attachFloatingPanel;"),
      source.indexOf("recorderPanel = { sessionId"),
    );
    expect(accessor).toContain("throw new Error");
    expect(accessor).not.toContain("require(");
  });

  it("never names openExternal", () => {
    // The method itself. If this string is back, so is the axis.
    expect(code).not.toContain("openExternal(");
  });

  it("has no lazy electron-shell accessor left", () => {
    for (const gone of ["getElectronShell", "_electronShell"]) {
      expect(code).not.toContain(gone);
    }
  });

  it("opens the link through the host member instead", () => {
    // The positive half. `meeting_open_url` must still DO something — a guard
    // that only checks for absence passes just as well on a deleted feature.
    expect(source).toContain("requireOpenExternalUrl()(result.url.toString())");
  });

  it("refuses rather than falling back when the host lacks the member", () => {
    // No-fallback, stated at the one place it could be violated. A branch that
    // reached Electron when `openExternalUrl` was missing would hand the axis
    // straight back on exactly the hosts that matter.
    const accessor = source.slice(
      source.indexOf("function requireOpenExternalUrl"),
      source.indexOf("function requireSpawnWorker"),
    );
    expect(accessor).toContain("throw new Error");
    expect(accessor).not.toContain("require(");
  });

  it("still declares the URL validator between the caller and the host", () => {
    // The host member is not a licence to pass anything through: the plugin's
    // own protocol/shape check runs first and rejects before the call.
    const site = source.slice(
      source.indexOf("meeting_open_url: async"),
      source.indexOf("requireOpenExternalUrl()(result.url.toString())"),
    );
    expect(site).toContain("validateOpenUrl(body.url)");
    expect(site).toContain("throw new Error(result.error)");
  });
});
