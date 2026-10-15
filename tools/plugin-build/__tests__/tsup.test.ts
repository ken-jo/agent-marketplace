import { describe, it, expect } from "vitest";
import {
  BUNDLE_EVERYTHING_REGEX,
  defineAvePluginConfig,
  HOST_EXTERNAL_MODULES,
  HOST_BROWSER_EXTERNAL_MODULES,
} from "../tsup.js";

function asSingle(cfg: ReturnType<typeof defineAvePluginConfig>) {
  if (Array.isArray(cfg)) {
    throw new Error("expected single-target config");
  }
  return cfg;
}

function asArray(cfg: ReturnType<typeof defineAvePluginConfig>) {
  if (!Array.isArray(cfg)) {
    throw new Error("expected multi-target config");
  }
  return cfg;
}

function noExternalRegexes(cfg: { noExternal?: unknown }): RegExp[] {
  expect(Array.isArray(cfg.noExternal)).toBe(true);
  const arr = cfg.noExternal as unknown[];
  for (const item of arr) {
    expect(item).toBeInstanceOf(RegExp);
  }
  return arr as RegExp[];
}

describe("defineAvePluginConfig", () => {
  it("emits self-containment defaults when called with no overrides", () => {
    const cfg = asSingle(defineAvePluginConfig());
    expect(cfg.entry).toEqual(["src/hostPlugin.ts"]);
    expect(cfg.format).toEqual(["esm"]);
    expect(cfg.target).toBe("node20");
    expect(cfg.outDir).toBe("dist");
    expect(cfg.dts).toBe(false);
    expect(cfg.clean).toBe(true);
    expect(cfg.splitting).toBe(false);
    expect(cfg.sourcemap).toBe(true);
    expect(cfg.external).toEqual(["electron"]);
    const noExternal = noExternalRegexes(cfg);
    expect("node-ical").toMatch(noExternal[0]);
    expect("@azure/msal-node").toMatch(noExternal[0]);
    // CJS-interop banner is auto-injected on Node builds so esbuild's
    // dynamic-require shim resolves to a real `require`, and CJS-style
    // `__filename`/`__dirname` are reconstructed from `import.meta.url`.
    // Node-target plugins always get this; browser builds opt out.
    expect(cfg.banner).toMatchObject({
      js: expect.stringContaining("createRequire"),
    });
    expect(cfg.banner).toMatchObject({
      js: expect.stringContaining("__filename"),
    });
    expect(cfg.banner).toMatchObject({
      js: expect.stringContaining("__dirname"),
    });
    expect(cfg.banner).toMatchObject({
      js: expect.stringContaining("import.meta.url"),
    });
    // Helpers must use the `__ave*` prefix so they cannot collide with
    // user source's own `createRequire` / `fileURLToPath` / `dirname`
    // imports. A future refactor that drops the prefix would silently
    // break user code — lock the names in.
    expect(cfg.banner).toMatchObject({
      js: expect.stringContaining("__aveCreateRequire"),
    });
    expect(cfg.banner).toMatchObject({
      js: expect.stringContaining("__aveFileURLToPath"),
    });
    expect(cfg.banner).toMatchObject({
      js: expect.stringContaining("__aveDirname"),
    });
    // `var` (not `const`) — bundled deps frequently emit their own
    // `var __filename = ...` preamble; `const` would SyntaxError on
    // redeclaration. Lock the choice in so a future "modernize to const"
    // refactor doesn't reintroduce the regression.
    expect(cfg.banner).toMatchObject({
      js: expect.stringContaining("var __filename"),
    });
    expect(cfg.banner).toMatchObject({
      js: expect.stringContaining("var __dirname"),
    });
    expect(cfg.banner).toMatchObject({
      js: expect.stringContaining("var require"),
    });
  });

  it("preserves user banner.css and prepends CJS-interop to user banner.js (Node build)", () => {
    // BLOCKER regression — naïve { ...baseDefaults, ...override } would
    // let a user-supplied `banner: { css: "..." }` wipe our js, silently
    // re-breaking dynamic require. Verify the merge keeps our js AND
    // user's css.
    const userJs = "/* userPrologue */ globalThis.__aveUserMarker = 1;";
    const cfg = asSingle(
      defineAvePluginConfig({
        banner: {
          css: "/* user-css */",
          js: userJs,
        },
      }),
    );
    expect(cfg.banner).toMatchObject({
      css: "/* user-css */",
    });
    const banner = cfg.banner as { js?: string };
    expect(banner.js).toContain("createRequire");
    expect(banner.js).toContain(userJs);
    // CJS-interop comes BEFORE user js so const require is in scope.
    expect(banner.js!.indexOf("createRequire")).toBeLessThan(
      banner.js!.indexOf(userJs),
    );
  });

  it("css-only user banner does not silently drop CJS-interop js (BLOCKER regression)", () => {
    const cfg = asSingle(
      defineAvePluginConfig({
        banner: { css: "/* css only */" },
      }),
    );
    expect(cfg.banner).toMatchObject({
      css: "/* css only */",
      js: expect.stringContaining("createRequire"),
    });
  });

  it("explicit `banner: undefined` still gets CJS-interop on Node build", () => {
    const cfg = asSingle(defineAvePluginConfig({ banner: undefined }));
    expect(cfg.banner).toMatchObject({
      js: expect.stringContaining("createRequire"),
    });
  });

  it("function-form user banner is wrapped — wrapper invokes user fn and merges CJS-interop", () => {
    const userJs = "/* user-fn-js */";
    const userBannerFn = (ctx: { format: string }) => ({
      js: `${userJs}/*${ctx.format}*/`,
    });
    const cfg = asSingle(
      defineAvePluginConfig({
        banner: userBannerFn,
      }),
    );
    // Result must itself be a function so tsup invokes it per format.
    expect(typeof cfg.banner).toBe("function");
    const wrapped = cfg.banner as (ctx: { format: string }) => {
      js?: string;
      css?: string;
    };
    const result = wrapped({ format: "esm" });
    // CJS-interop is prepended; user's per-format js follows.
    expect(result.js).toContain("createRequire");
    expect(result.js).toContain(userJs);
    expect(result.js).toContain("/*esm*/");
    expect(result.js!.indexOf("createRequire")).toBeLessThan(
      result.js!.indexOf(userJs),
    );
  });

  it("function-form user banner returning null/undefined still gets CJS-interop", () => {
    const cfg = asSingle(
      defineAvePluginConfig({
        banner: () => undefined,
      }),
    );
    const wrapped = cfg.banner as (ctx: { format: string }) => {
      js?: string;
      css?: string;
    };
    const result = wrapped({ format: "esm" });
    expect(result.js).toContain("createRequire");
  });

  it("merges user external with host externals (cannot opt out of electron)", () => {
    const cfg = asSingle(defineAvePluginConfig({ external: ["foo"] }));
    expect(cfg.external).toContain("electron");
    expect(cfg.external).toContain("foo");
  });

  it("ignores attempt to clear host externals via empty external array", () => {
    const cfg = asSingle(defineAvePluginConfig({ external: [] }));
    expect(cfg.external).toEqual(["electron"]);
  });

  it("dedupes string externals", () => {
    const cfg = asSingle(
      defineAvePluginConfig({ external: ["electron", "foo", "foo"] }),
    );
    const externals = cfg.external as string[];
    expect(externals.filter((x) => x === "electron")).toHaveLength(1);
    expect(externals.filter((x) => x === "foo")).toHaveLength(1);
  });

  it("dedupes regex externals by source + flags", () => {
    const cfg = asSingle(
      defineAvePluginConfig({ external: [/^node:/, /^node:/, /^node:/i] }),
    );
    const regexExternals = (cfg.external as (string | RegExp)[]).filter(
      (x): x is RegExp => x instanceof RegExp,
    );
    // Same source/flags collapsed; different flags preserved.
    expect(regexExternals).toHaveLength(2);
  });

  it("auto-adds react/react-dom externals for platform=browser", () => {
    const cfg = asSingle(
      defineAvePluginConfig({
        platform: "browser",
        entry: { "ui/panel": "src/ui/panel.ts" },
      }),
    );
    expect(cfg.external).toContain("electron");
    expect(cfg.external).toContain("react");
    expect(cfg.external).toContain("react-dom");
  });

  it("skips the CJS-interop banner on browser builds (no `module` specifier in browsers)", () => {
    const cfg = asSingle(
      defineAvePluginConfig({
        platform: "browser",
        entry: { "ui/panel": "src/ui/panel.ts" },
      }),
    );
    expect(cfg.banner).toBeUndefined();
  });

  it("does NOT auto-detect browser via target=es* (common for Node builds too)", () => {
    const cfg = asSingle(
      defineAvePluginConfig({
        target: "es2020",
        entry: { "ui/panel": "src/ui/panel.ts" },
      }),
    );
    expect(cfg.external).not.toContain("react");
    expect(cfg.external).not.toContain("react-dom");
  });

  it("auto-detects browser build via target=chrome*", () => {
    const cfg = asSingle(defineAvePluginConfig({ target: "chrome120" }));
    expect(cfg.external).toContain("react");
  });

  it("treats node-prefixed targets as node builds", () => {
    const cfg = asSingle(defineAvePluginConfig({ target: "node18" }));
    expect(cfg.external).not.toContain("react");
    expect(cfg.external).not.toContain("react-dom");
  });

  it("respects platform=node override even with es target", () => {
    const cfg = asSingle(
      defineAvePluginConfig({ target: "es2020", platform: "node" }),
    );
    expect(cfg.external).not.toContain("react");
  });

  it("auto-detects browser when target is an array containing browser-like target", () => {
    const cfg = asSingle(
      defineAvePluginConfig({ target: ["es2020", "chrome120"] }),
    );
    expect(cfg.external).toContain("react");
    expect(cfg.external).toContain("react-dom");
  });

  it("treats array of node-only targets as node build", () => {
    const cfg = asSingle(
      defineAvePluginConfig({ target: ["node18", "node20"] }),
    );
    expect(cfg.external).not.toContain("react");
    expect(cfg.external).not.toContain("react-dom");
  });

  it("supports extending entry with src/index.ts via override", () => {
    const cfg = asSingle(
      defineAvePluginConfig({
        entry: ["src/index.ts", "src/hostPlugin.ts"],
      }),
    );
    expect(cfg.entry).toEqual(["src/index.ts", "src/hostPlugin.ts"]);
  });

  it("supports multi-target overrides as an array", () => {
    const cfgs = asArray(
      defineAvePluginConfig([
        { entry: ["src/hostPlugin.ts"] },
        {
          entry: { "ui/panel": "src/ui/panel.ts" },
          platform: "browser",
          target: "es2020",
          clean: false,
        },
      ]),
    );
    expect(cfgs).toHaveLength(2);
    expect(cfgs[0].external).toEqual(["electron"]);
    expect(cfgs[0].clean).toBe(true);
    expect(cfgs[1].external).toContain("react");
    expect(cfgs[1].external).toContain("react-dom");
    expect(cfgs[1].clean).toBe(false);
    expect(cfgs[1].target).toBe("es2020");
    // Per-target banner — Node target gets CJS-interop, browser target
    // gets nothing (it would otherwise reference unresolvable `module`/
    // `url`/`path` specifiers in the browser).
    expect(cfgs[0].banner).toMatchObject({
      js: expect.stringContaining("createRequire"),
    });
    expect(cfgs[1].banner).toBeUndefined();
  });

  it("forces noExternal — user override is ignored (contract lock)", () => {
    const cfg = asSingle(
      defineAvePluginConfig({ noExternal: ["only-this"] }),
    );
    const noExternal = noExternalRegexes(cfg);
    expect(noExternal[0].source).toBe(BUNDLE_EVERYTHING_REGEX.source);
    // Sanity check: the regex matches typical plugin deps.
    expect("@azure/msal-node").toMatch(noExternal[0]);
    expect("chokidar").toMatch(noExternal[0]);
  });

  it("forces noExternal even when user passes an empty array (contract lock)", () => {
    // The helper ignores user-provided `noExternal` values; the contract
    // is locked to `[BUNDLE_EVERYTHING_REGEX]`. This test guards against
    // a regression where `[]` would slip through and bypass the bundle-
    // everything default.
    const cfg = asSingle(defineAvePluginConfig({ noExternal: [] }));
    const noExternal = noExternalRegexes(cfg);
    expect(noExternal).toHaveLength(1);
    expect(noExternal[0].source).toBe(BUNDLE_EVERYTHING_REGEX.source);
  });

  it("allows user to externalize optional native deps without breaking host externals", () => {
    const cfg = asSingle(
      defineAvePluginConfig({
        external: ["fsevents", "bufferutil", "utf-8-validate"],
      }),
    );
    expect(cfg.external).toContain("electron");
    expect(cfg.external).toContain("fsevents");
    expect(cfg.external).toContain("bufferutil");
    expect(cfg.external).toContain("utf-8-validate");
    // noExternal regex would have matched these; but `external` takes
    // precedence in tsup/esbuild, so they stay external as requested.
    const noExternal = noExternalRegexes(cfg);
    expect("fsevents").toMatch(noExternal[0]); // matches but external wins
  });

  it("exposes HOST_EXTERNAL_MODULES contract", () => {
    expect(HOST_EXTERNAL_MODULES).toContain("electron");
  });

  it("exposes HOST_BROWSER_EXTERNAL_MODULES contract", () => {
    expect(HOST_BROWSER_EXTERNAL_MODULES).toContain("react");
    expect(HOST_BROWSER_EXTERNAL_MODULES).toContain("react-dom");
  });

  it("BUNDLE_EVERYTHING_REGEX matches all package-name shapes", () => {
    expect("foo").toMatch(BUNDLE_EVERYTHING_REGEX);
    expect("@scope/foo").toMatch(BUNDLE_EVERYTHING_REGEX);
    expect("foo/sub/path").toMatch(BUNDLE_EVERYTHING_REGEX);
    expect("foo-bar_baz").toMatch(BUNDLE_EVERYTHING_REGEX);
  });
});
