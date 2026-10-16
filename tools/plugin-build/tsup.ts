import {
  BUNDLE_EVERYTHING_REGEX,
  HOST_BROWSER_EXTERNAL_MODULES,
  HOST_EXTERNAL_MODULES,
} from "@ave/plugin-contract";

// The host owns these values (Ave `src/plugins/public-contract.ts`); the
// helper reads them from the vendored contract and re-exports them for
// plugin build tests.
export { BUNDLE_EVERYTHING_REGEX, HOST_BROWSER_EXTERNAL_MODULES, HOST_EXTERNAL_MODULES };

type Banner = { js?: string; css?: string };

/**
 * The tsup options this helper reads or enforces, plus any other tsup option
 * passed through unchanged. The helper does not import tsup's own `Options`:
 * a plugin resolves this file through a link to `tools/plugin-build`, so a
 * type imported here would come from a different tsup install than the
 * plugin's, and a plugin that emits declarations for its `tsup.config.ts`
 * could not name it (TS2883).
 */
export interface TsupOptions {
  entry?: string[] | Record<string, string>;
  format?: string[];
  platform?: "node" | "browser" | "neutral";
  target?: string | string[];
  external?: (string | RegExp)[];
  noExternal?: (string | RegExp)[];
  banner?: Banner | ((ctx: { format: string }) => Banner | undefined);
  [option: string]: unknown;
}

/**
 * Build a tsup configuration for an Ave marketplace plugin.
 *
 * ## Self-contained plugin contract
 *
 * Ave marketplace plugins are distributed as signed zip archives containing
 * `dist/`, `plugin.json`, and every manifest-declared `skills`, `hooks`, and
 * `mcpServers` path. The publish workflow excludes `node_modules/` from the
 * zip, and the host plugin loader uses strict
 * `pluginRoot` containment (no sibling-repo escape since 2026-05). So
 * plugins cannot fall back to the host's `node_modules/` at runtime.
 *
 * Therefore: every runtime dependency MUST be bundled into `dist/`.
 *
 * This helper enforces the contract via:
 * - `external: HOST_EXTERNAL_MODULES` (+ HOST_BROWSER_EXTERNAL_MODULES
 *   for browser builds) — host-provided modules stay external.
 * - `noExternal: [BUNDLE_EVERYTHING_REGEX]` — every other import (deps,
 *   devDeps, transitive) gets bundled into `dist/`. This field is NOT
 *   overridable: the contract is the helper's reason to exist.
 *
 * ## Defaults
 *
 * - `entry`: `["src/hostPlugin.ts"]` — the marketplace contract entry
 *   referenced by `plugin.json`. Plugins that also publish a separate
 *   `src/index.ts` for npm-package consumption should override:
 *   `entry: ["src/index.ts", "src/hostPlugin.ts"]`.
 * - `format`: `["esm"]`
 * - `target`: `"node20"`
 * - `clean`: `true`
 * - `sourcemap`: `true`
 * - `splitting`: `false`
 * - `dts`: `false` (use `tsc --emitDeclarationOnly` separately —
 *   tsup v8.5.x injects a hardcoded `baseUrl: "."` that triggers TS5101
 *   under TypeScript 6).
 * - `outDir`: `"dist"`
 * - `external`: HOST_EXTERNAL_MODULES (+ HOST_BROWSER_EXTERNAL_MODULES
 *   when the build is browser-targeted — see below).
 * - `noExternal`: `[BUNDLE_EVERYTHING_REGEX]` (forced, not overridable).
 *
 * Any other default can be overridden via the `overrides` argument. The
 * `external` array is always merged with the host externals so the
 * contract cannot be silently bypassed — passing `external: []` does
 * NOT clear the host externals.
 *
 * ## Browser-build detection
 *
 * A target is considered a browser build when ANY of the following hold:
 * - `platform === "browser"`
 * - `target` is `"chrome*"` / `"firefox*"` / `"safari*"` / `"edge*"`
 *   (case-insensitive). Array targets are checked element-wise.
 *
 * `target: "es2020"` / `"es2022"` is NOT auto-detected as browser:
 * those targets are commonly used for modern Node builds too, and
 * silently adding `react` / `react-dom` externals to a Node build that
 * imports React would break runtime resolution. For browser UI bundles,
 * set `platform: "browser"` explicitly.
 *
 * ## Optional native dependencies
 *
 * `noExternal: [BUNDLE_EVERYTHING_REGEX]` follows ALL imports including
 * `optionalDependencies` (e.g., `chokidar` → `fsevents` on macOS,
 * `ws` → `bufferutil`/`utf-8-validate`). esbuild errors when a referenced
 * optional dep is not installed (typical on cross-platform CI).
 *
 * If your plugin transitively pulls in optional native deps, add them to
 * `external` explicitly:
 *
 * ```ts
 * defineAvePluginConfig({
 *   external: ["fsevents", "bufferutil", "utf-8-validate"],
 * });
 * ```
 *
 * The host's plugin loader will still resolve these against the consumer
 * machine's optional installs — they're treated as best-effort enhancements,
 * not hard requirements.
 *
 * ## Usage
 *
 * Single-target (most plugins):
 * ```ts
 * import { defineAvePluginConfig } from "@ave/plugin-build";
 * export default defineAvePluginConfig();
 * ```
 *
 * Override defaults:
 * ```ts
 * export default defineAvePluginConfig({
 *   entry: ["src/main.ts"],
 *   target: "node18",
 *   format: ["esm", "cjs"],
 * });
 * ```
 *
 * Multi-target (host + browser UI). The browser entry must set
 * `platform: "browser"` explicitly. The helper still adds
 * `react` / `react-dom` to the `external` list for forward-compat
 * (future host-injected React anchor), but `noExternal:
 * [BUNDLE_EVERYTHING_REGEX]` actually wins — React is bundled
 * per-plugin. See the JSDoc on `HOST_BROWSER_EXTERNAL_MODULES`
 * for the design discussion and trade-offs.
 * ```ts
 * export default defineAvePluginConfig([
 *   { entry: ["src/hostPlugin.ts"] },
 *   {
 *     entry: { "ui/panel": "src/ui/panel.ts" },
 *     platform: "browser",
 *     target: "es2020",
 *     clean: false,
 *   },
 * ]);
 * ```
 */
export function defineAvePluginConfig(
  overrides: TsupOptions | TsupOptions[] = {},
): TsupOptions | TsupOptions[] {
  if (Array.isArray(overrides)) {
    return overrides.map(applyDefaults);
  }
  return applyDefaults(overrides);
}

function isBrowserBuild(override: TsupOptions): boolean {
  if (override.platform === "browser") return true;
  if (override.platform === "node") return false;
  // tsup `target` is `string | string[] | undefined`. Treat any element
  // that looks like a browser target as evidence of a browser build.
  const targets =
    typeof override.target === "string"
      ? [override.target]
      : Array.isArray(override.target)
      ? override.target
      : [];
  return targets.some((t) => looksLikeBrowserTarget(t));
}

function looksLikeBrowserTarget(target: unknown): boolean {
  if (typeof target !== "string") return false;
  const lower = target.toLowerCase();
  // ES targets (es2020 / es2022) are intentionally excluded — they are
  // commonly used for modern Node builds too, and auto-adding react /
  // react-dom externals on a Node build that happens to import React
  // would silently break runtime resolution. Only browser-vendor target
  // names are unambiguous enough to auto-detect; for any other case the
  // plugin author should set `platform: "browser"` explicitly.
  return (
    lower.startsWith("chrome") ||
    lower.startsWith("firefox") ||
    lower.startsWith("safari") ||
    lower.startsWith("edge")
  );
}

function applyDefaults(override: TsupOptions): TsupOptions {
  const isBrowser = isBrowserBuild(override);
  const hostExternals: (string | RegExp)[] = isBrowser
    ? [...HOST_EXTERNAL_MODULES, ...HOST_BROWSER_EXTERNAL_MODULES]
    : [...HOST_EXTERNAL_MODULES];

  const baseDefaults: TsupOptions = {
    // The marketplace contract entry is `src/hostPlugin.ts` — `plugin.json`
    // points at `dist/hostPlugin.js`. Plugins that ALSO ship a separate
    // `src/index.ts` (e.g., for npm-package consumption) should override
    // `entry` explicitly: `entry: ["src/index.ts", "src/hostPlugin.ts"]`.
    entry: ["src/hostPlugin.ts"],
    format: ["esm"],
    target: "node20",
    clean: true,
    sourcemap: true,
    splitting: false,
    dts: false,
    outDir: "dist",
  };

  const userExternals: (string | RegExp)[] = Array.isArray(override.external)
    ? override.external
    : [];

  // CJS-interop banner — bundled CJS deps in the ESM output need three
  // CJS globals re-injected so they don't crash at runtime:
  //   `require`     — esbuild's dynamic-require shim falls back to a
  //                   throwing Proxy ("Dynamic require of "fs" is not
  //                   supported") when no real `require` is in scope.
  //                   `createRequire(import.meta.url)` provides one.
  //   `__filename`  — referenced by some deps (e.g. parts of
  //                   `node-ical`, `msal-node`) at module load time.
  //                   `fileURLToPath(import.meta.url)` reconstructs it.
  //   `__dirname`   — same — derived from `__filename`.
  //
  // Without this banner the ESM output throws on first import.
  //
  // Skipped for browser builds: `import.meta.url` and `"module"`/`"url"`/
  // `"path"` specifiers aren't browser-resolvable. Browser UI bundles
  // shouldn't pull in Node CJS deps anyway.
  //
  // Helper imports are prefixed with `__ave` so they cannot collide with
  // user source's own `createRequire`/`fileURLToPath`/`dirname` imports.
  // The CJS-style identifiers (`require`/`__filename`/`__dirname`) are
  // intentionally unprefixed because bundled CJS deps reference them by
  // those exact names.
  //
  // `var` (NOT `const`) is critical: bundled deps frequently emit their
  // own ESM-to-CJS interop preamble like
  //   var __filename = fileURLToPath(import.meta.url);
  // — using `const` here would `SyntaxError: Identifier '__filename'
  // has already been declared`. `var` permits redeclaration (even under
  // strict mode), so multiple definitions coexist; both compute the
  // same value so the final binding is correct regardless of order.
  const cjsInteropJs =
    'import { createRequire as __aveCreateRequire } from "module";' +
    'import { fileURLToPath as __aveFileURLToPath } from "url";' +
    'import { dirname as __aveDirname } from "path";' +
    "var require = __aveCreateRequire(import.meta.url);" +
    "var __filename = __aveFileURLToPath(import.meta.url);" +
    "var __dirname = __aveDirname(__filename);";

  // Banner merge — preserve any user-supplied banner fields (e.g. `css`
  // for browser UI bundles, or extra `js` prologue) while ALWAYS keeping
  // our CJS-interop js on Node builds. Naïve `{...baseDefaults, ...override}`
  // would let `banner: { css: "..." }` silently drop our `js` and reintroduce
  // the dynamic-require crash — that's the bug this PR fixes, so the merge
  // here closes the loophole. User's own `js` is appended after ours so the
  // CJS globals are in scope when user code runs.
  //
  // tsup's `banner` option accepts either an object OR a per-format
  // function `(ctx) => banner | undefined`. Both are handled.
  const userBanner = override.banner;
  const mergeWithCjsInterop = (
    user: { js?: string; css?: string } | undefined,
  ): { js?: string; css?: string } => ({
    ...user,
    js: cjsInteropJs + (user?.js ?? ""),
  });
  const mergedBanner = isBrowser
    ? userBanner
    : typeof userBanner === "function"
      ? (ctx: { format: string }) =>
          mergeWithCjsInterop(userBanner(ctx) || undefined)
      : mergeWithCjsInterop(userBanner);

  return {
    ...baseDefaults,
    ...override,
    external: dedupeExternals([...hostExternals, ...userExternals]),
    // noExternal is contract-locked: the helper exists to enforce
    // self-containment. User overrides for noExternal are intentionally
    // ignored.
    noExternal: [BUNDLE_EVERYTHING_REGEX],
    // banner is also contract-locked on Node builds: dropping the
    // CJS-interop js would re-break dynamic require. We merge instead of
    // overwrite so legitimate banner overrides (css, extra js prologue)
    // still work.
    banner: mergedBanner,
  };
}

function dedupeExternals(items: (string | RegExp)[]): (string | RegExp)[] {
  const seenStrings = new Set<string>();
  const seenRegexSources = new Set<string>();
  const out: (string | RegExp)[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      if (seenStrings.has(item)) continue;
      seenStrings.add(item);
    } else if (item instanceof RegExp) {
      const key = `${item.source}/${item.flags}`;
      if (seenRegexSources.has(key)) continue;
      seenRegexSources.add(key);
    }
    out.push(item);
  }
  return out;
}
