// Vendored from plugin-sdk v6.1.0 (dist/ui/hooks/primeTheme.js).
//
// SDK v7.0.0 removed its entire UI surface (plugin-sdk/ui/* no longer
// exists — see SDK PR #212 / tag v7.0.0). The host still broadcasts the
// sticky `host.theme.changed` event carrying the `--ave-*` token payload to
// plugin webviews (Ave src/plugin-preload.ts STICKY_EVENT_TYPES), so
// this plugin vendors the small subscriber helper locally to keep following
// the host theme with zero behavior change. Content below is copied as-is
// from the SDK's built output at the v6.1.0 tag; do not hand-edit the
// token/bundle tables unless the SDK's source of truth changes too.

// src/ui/tokens/theme-bundles.ts
var BUNDLE_IDS = Object.freeze([
  "moonstone",
  "gallery",
  "cherry-blossom",
  "tokyo-night",
  "midnight",
  "forest",
  "violet-light",
  "violet-dark",
  "high-contrast",
  "catppuccin-mocha",
  "catppuccin-latte",
  "nord",
  "gruvbox-dark-hard",
  "solarized-light",
  "rose-pine",
  "executive-graphite"
]);
var BUNDLE_ID_SET = new Set(BUNDLE_IDS);
var DEFAULT_VISIBLE_THEME_BUNDLE_IDS = Object.freeze([
  "moonstone",
  "gallery"
]);
var DEFAULT_VISIBLE_THEME_BUNDLE_ID_SET = new Set(
  DEFAULT_VISIBLE_THEME_BUNDLE_IDS
);
var MARKETPLACE_ELIGIBLE_THEME_BUNDLE_IDS = Object.freeze(
  BUNDLE_IDS.filter(
    (bundleId) => !DEFAULT_VISIBLE_THEME_BUNDLE_ID_SET.has(bundleId)
  )
);
var MARKETPLACE_ELIGIBLE_THEME_BUNDLE_ID_SET = new Set(
  MARKETPLACE_ELIGIBLE_THEME_BUNDLE_IDS
);

// src/ui/tokens/index.ts
var AVE_TOKEN_NAMES = [
  "--ave-bg",
  "--ave-surface",
  "--ave-surface-overlay",
  "--ave-fg",
  "--ave-fg-muted",
  "--ave-fg-disabled",
  "--ave-primary",
  "--ave-primary-fg",
  "--ave-secondary",
  "--ave-secondary-fg",
  "--ave-danger",
  "--ave-danger-fg",
  "--ave-warning",
  "--ave-warning-fg",
  "--ave-success",
  "--ave-success-fg",
  "--ave-border",
  "--ave-ring",
  // Derived tinted-surface tokens — pre-computed color-mix values shipped by the host.
  // Plugins use these directly instead of reinventing color-mix derivations.
  "--ave-danger-bg-subtle",
  "--ave-focus-shadow",
  "--ave-primary-bg-strong",
  "--ave-primary-bg-subtle",
  "--ave-success-bg-subtle",
  "--ave-surface-hover",
  "--ave-warning-bg-subtle",
  "--ave-radius-xs",
  "--ave-radius-sm",
  "--ave-radius",
  "--ave-radius-lg",
  "--ave-radius-full",
  "--ave-text-xs",
  "--ave-text-sm",
  "--ave-text-base",
  "--ave-text-lg",
  "--ave-weight-normal",
  "--ave-weight-medium",
  "--ave-weight-semibold",
  "--ave-space-1",
  "--ave-space-2",
  "--ave-space-3",
  "--ave-space-4",
  "--ave-motion-fast",
  "--ave-motion-normal"
];
var AVE_THEME_BUNDLE_IDS = Object.freeze([...BUNDLE_IDS]);

// src/ui/tokens/inject.ts
var _ALLOWED_KEYS = new Set(AVE_TOKEN_NAMES);
var _UNSAFE_VALUE = /url\s*\(|expression\s*\(|<[a-zA-Z]/i;
var _DOC_NODE = 9;
var _ELEMENT_NODE = 1;
function isDocument(value) {
  return typeof value === "object" && value !== null && value.nodeType === _DOC_NODE;
}
function isHtmlElement(value) {
  return typeof value === "object" && value !== null && value.nodeType === _ELEMENT_NODE && typeof value.ownerDocument !== "undefined";
}
function resolveElement(target) {
  if (target == null) {
    return typeof document === "undefined" ? null : document.documentElement;
  }
  if (isHtmlElement(target)) return target;
  if (isDocument(target)) return target.documentElement;
  return null;
}
function applyThemeTokens(tokens, target) {
  const root = resolveElement(target);
  if (!root) return;
  for (const [k, v] of Object.entries(tokens)) {
    if (!_ALLOWED_KEYS.has(k)) continue;
    if (_UNSAFE_VALUE.test(v)) continue;
    root.style.setProperty(k, v);
  }
}
function applyThemeFromHostEvent(event, target) {
  const root = resolveElement(target);
  if (!root) return;
  if (!event) {
    root.removeAttribute("data-theme-bundle");
    root.removeAttribute("data-shell");
    for (const tokenName of AVE_TOKEN_NAMES) {
      root.style.removeProperty(tokenName);
    }
    return;
  }
  if (AVE_THEME_BUNDLE_IDS.includes(event.bundleId)) {
    root.setAttribute("data-theme-bundle", event.bundleId);
  } else {
    root.removeAttribute("data-theme-bundle");
  }
  if (event.shell === "light" || event.shell === "dark") {
    root.setAttribute("data-shell", event.shell);
  } else {
    root.removeAttribute("data-shell");
  }
  if (event.tokens !== null && typeof event.tokens === "object" && !Array.isArray(event.tokens)) {
    applyThemeTokens(event.tokens, target);
  }
}

// src/ui/hooks/primeTheme.ts
function applyPayload(payload, opts) {
  if (!payload || typeof payload !== "object") return;
  const event = payload;
  applyThemeFromHostEvent(event, opts.target);
  if (opts.onPayload && event.bundleId && event.shell && event.tokens) {
    try {
      opts.onPayload(event);
    } catch (err) {
      console.warn("[ave:primeTheme] onPayload callback threw", err);
    }
  }
}
function primeTheme(bridge, opts = {}) {
  const unsub = bridge.onEvent("host.theme.changed", (data) => {
    applyPayload(data, opts);
  });
  if (typeof bridge.getTheme === "function") {
    try {
      Promise.resolve(bridge.getTheme()).then((payload) => {
        if (payload) applyPayload(payload, opts);
      }).catch((err) => {
        console.warn("[ave:primeTheme] getTheme() pull failed", err);
      });
    } catch (err) {
      console.warn("[ave:primeTheme] getTheme() threw synchronously", err);
    }
  }
  return { dispose: unsub };
}
export {
  primeTheme
};
