// HAND-MAINTAINED — regenerate by syncing to host SoT (see header notes).
//
// A fixed fallback palette: dark, snapshotted from the former "tokyo-night"
// default through the host's derivation (Ave
// src/ui/renderer/theme/plugin-token-map.ts, bundleToPluginTokens), with an OS
// light override. Token names follow Ave src/shared/plugin-ui-tokens.ts
// (AVE_TOKEN_NAMES).
//
// Why this file exists at all:
//   The host primes plugin BrowserWindows with the active theme tokens BEFORE
//   mount, and its host.theme.changed broadcast overwrites these inline, so
//   this sheet paints only when the primed payload is missing — test
//   harnesses, host bugs, isolated render contexts. It does not track the
//   host's default bundle (src/shared/theme-bundles.ts DEFAULT_BUNDLE_ID).
//
// Static tokens (--ave-shadow-*, --ave-easing) are plugin-owned: the host's
// safety regex rejects values containing parentheses, so they were never sent
// over IPC. They live here unchanged from the v5.0 SDK sheet.

export const AVE_TOKENS_CSS = `/* Plugin UI tokens — fallback only; the host-primed theme overwrites them. */

/* ─── Dark (default fallback) ─────── */
.ave-local-indexer-ui {
  --ave-bg:                hsl(222.2, 84%, 4.9%);
  --ave-surface:           hsl(222.2, 84%, 7%);
  --ave-surface-overlay:   hsl(222.2, 84%, 4.9%);
  --ave-fg:                hsl(210, 40%, 98%);
  --ave-fg-muted:          hsl(215, 20%, 65%);
  --ave-fg-disabled:       hsl(215, 20%, 65%);
  --ave-primary:           hsl(217.2, 91.2%, 59.8%);
  --ave-primary-fg:        hsl(210, 40%, 98%);
  --ave-secondary:         hsl(217, 33%, 17%);
  --ave-secondary-fg:      hsl(210, 40%, 98%);
  --ave-danger:            hsl(0, 78%, 58%);
  --ave-danger-fg:         hsl(210, 40%, 98%);
  --ave-warning:           hsl(38, 92%, 62%);
  --ave-warning-fg:        hsl(0, 0%, 10%);
  --ave-success:           hsl(142, 71%, 45%);
  --ave-success-fg:        hsl(210, 40%, 98%);
  --ave-border:            hsl(217, 33%, 17%);
  --ave-ring:              hsl(224.3, 76.3%, 48%);
  --ave-radius:            0.6rem;
  --ave-radius-sm:         0.25rem;

  /* ─── Derived tinted-surface tokens (bundleToPluginTokens) ─── */
  --ave-primary-bg-subtle: color-mix(in srgb, hsl(217.2, 91.2%, 59.8%) 18%, hsl(222.2, 84%, 7%));
  --ave-primary-bg-strong: color-mix(in srgb, hsl(217.2, 91.2%, 59.8%) 32%, hsl(222.2, 84%, 7%));
  --ave-danger-bg-subtle:  color-mix(in srgb, hsl(0, 78%, 58%) 14%, transparent);
  --ave-warning-bg-subtle: color-mix(in srgb, hsl(38, 92%, 62%) 14%, transparent);
  --ave-success-bg-subtle: color-mix(in srgb, hsl(142, 71%, 45%) 14%, transparent);
  --ave-surface-hover:     color-mix(in srgb, hsl(210, 40%, 98%) 10%, hsl(217, 33%, 17%));
  --ave-focus-shadow:      color-mix(in srgb, hsl(224.3, 76.3%, 48%) 62%, transparent);

  /* ─── Shape (invariant) ───────────────────────────────── */
  --ave-radius-xs:   0.15rem;
  --ave-radius-lg:   0.75rem;
  --ave-radius-full: 9999px;

  /* ─── Typography (invariant) ──────────────────────────── */
  --ave-text-xs:         0.75rem;
  --ave-text-sm:         0.875rem;
  --ave-text-base:       1rem;
  --ave-text-lg:         1.125rem;
  --ave-weight-normal:   400;
  --ave-weight-medium:   500;
  --ave-weight-semibold: 600;

  /* ─── Spacing (invariant) ─────────────────────────────── */
  --ave-space-1: 0.25rem;
  --ave-space-2: 0.5rem;
  --ave-space-3: 0.75rem;
  --ave-space-4: 1rem;

  /* ─── Motion (invariant) ──────────────────────────────── */
  --ave-motion-fast:   150ms;
  --ave-motion-normal: 200ms;

  /* ─── Static tokens (plugin-owned; CSS-only, never IPC) ── */
  --ave-shadow-sm: 0 1px 3px hsl(222, 84%, 5%, 0.4);
  --ave-shadow-md: 0 4px 12px hsl(222, 84%, 5%, 0.6);
  --ave-easing:    cubic-bezier(0.4, 0, 0.2, 1);
  color-scheme: dark;
}

/* OS prefers-color-scheme fallback — activates when host hasn't yet
   primed --ave-* tokens (test harness, isolated render contexts). Inline
   styles set by theme-sync.js still win after host.theme.changed fires. */
@media (prefers-color-scheme: light) {
  .ave-local-indexer-ui {
    --ave-bg:           #f8f8fc;
    --ave-surface:      #ffffff;
    --ave-fg:           #1a1a22;
    --ave-fg-muted:     #666677;
    --ave-primary:      #734dff;
    --ave-primary-fg:   #ffffff;
    --ave-secondary:    #ebebf5;
    --ave-secondary-fg: #1a1a22;
    --ave-danger:       #e02020;
    --ave-danger-fg:    #ffffff;
    --ave-warning:      #d97706;
    --ave-warning-fg:   #ffffff;
    --ave-success:      #16a34a;
    --ave-border:       #d4d4e0;
    --ave-ring:         #734dff;
    color-scheme: light;
  }
}
`;
