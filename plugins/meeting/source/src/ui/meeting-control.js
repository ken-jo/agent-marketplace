/*
 * Ave Meeting Plugin — Sidebar UI Controller
 *
 * Design constraints (CLAUDE.md §4, managed deployment policy):
 *   - Zero external runtime dependencies (no CDN fonts, no remote icons).
 *   - No `innerHTML` with interpolated values. Static templates parsed via
 *     DOMParser; all dynamic text is set through `textContent`.
 *
 * Layout — single sidebar slot, internal view router:
 *   Top-level views: "pre-meeting" | "instant" | "sessions" | "session-detail"
 *   Top-level nav (2 tabs): [📅 예정 회의] [≡ 회의록]
 *   instant is a nested sub-view reachable from 예정 회의's empty-state CTA;
 *   the 예정 회의 pill stays lit while inside it for navigation continuity.
 *   session-detail sub-tabs: "summary" | "intermediate" | "transcript"
 *   The detail view consumes meeting_session_detail in a single call so the
 *   three sub-tabs render from one snapshot of the SessionStore record.
 *
 * Visual: shadcn-aligned via host --ave-* tokens (single SOT) — the surface
 *   palette, radius scale, focus ring, and motion timing all derive from the
 *   host plugin-ui-tokens contract so the plugin reads as part of Ave's
 *   visual system rather than a standalone widget.
 *
 * Streaming STT (batch-only):
 *   - Client windows raw mic PCM into 3s frames with 0.5s overlap and a VAD
 *     gate, pushes each window to the host, and polls `meeting_transcript`.
 *   - The UI accumulates text into a sentence-boundary aware buffer
 *     (SOFT=100 / HARD=200 chars) and flushes along Korean sentence breaks.
 *
 * Theme:
 *   - The vendored ./prime-theme.js (copied from plugin-sdk v6.1.0 —
 *     SDK v7.0.0 removed its UI surface) owns host.theme.changed subscribe +
 *     getTheme() pull + validated token paint to the .ave-meeting-ui
 *     scope div. Floating recorder windows receive the same host theme
 *     through the plugin host service loop; the sidebar no longer exposes
 *     or calls internal theme relay tools. The previous applyHostTheme /
 *     applyOsThemeFallback / localStorage persistence dance is gone —
 *     primeTheme's getTheme() pull races the cold-boot broadcast and the
 *     first valid payload wins idempotently.
 *   - Build: bundled by tsup (browser target) — see tsup.config.ts ui
 *     entry. SDK fallback module side-effect-injects :root --ave-*
 *     defaults so cold-start before the first IPC push still has a
 *     sensible palette.
 */

import { primeTheme } from "./prime-theme.js";
import {
  CUSTOM_PROMPT_MAX_BYTES,
  buildFinalSystem,
  INTERMEDIATE_SYSTEM,
  sanitizeCustomPrompt,
} from "../adapters/summaryPrompts";

// Single icon registry for all UI areas. stroke-width="2" throughout except
// arrowLeft/arrowRight (2.4 — nav affordance) and filled icons (square, pause, play).
const ICONS = {
  mic: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>`,
  square: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`,
  sparkles: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 4.8L18.6 9.7l-4.7 1.9L12 16.4l-1.9-4.8L5.4 9.7l4.7-1.9L12 3z"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>`,
  list: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="20" y2="12"/><line x1="8" y1="18" x2="20" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg>`,
  target: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></svg>`,
  checkCircle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><polyline points="22 4 12 14 9 11"/></svg>`,
  waveform: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="3" y2="12"/><line x1="7" y1="8" x2="7" y2="16"/><line x1="11" y1="5" x2="11" y2="19"/><line x1="15" y1="9" x2="15" y2="15"/><line x1="19" y1="7" x2="19" y2="17"/></svg>`,
  // Pre-meeting / nav icons (merged from former ICON_INLINE registry)
  arrowLeft: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><polyline points="15 18 9 12 15 6"/></svg>`,
  arrowRight: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><polyline points="9 18 15 12 9 6"/></svg>`,
  x: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  calendar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
  mapPin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 7-8 12-8 12s-8-5-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>`,
  docText: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>`,
  clipboard: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/></svg>`,
  upload: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
  video: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`,
  pause: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" width="14" height="14"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>`,
  play: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" width="14" height="14"><polygon points="6 4 20 12 6 20"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="5 12 10 17 19 8"/></svg>`,
};

// Styles are scoped under `.ave-meeting-ui`. Tokens align with the calendar
// plugin so the sidebar reads as a single visual system rather than a one-off
// glassmorphism surface — the previous design felt like a different app.
const STYLES = `
.ave-meeting-ui {
  /* Tokens flow from Ave's host.theme.changed broadcast (applied to
     scope.style as --ave-* CSS variables). Fallback values are the static
     light palette used when the host hasn't broadcast yet (cold start) or
     when running outside Ave (e.g. dev iframe). The accent-bg /
     danger-bg / accent-bg-hover tints use color-mix so they track the
     primary/danger hue automatically as the chat-theme overlay changes
     (purple → orange → blue → lg-red). color-mix is supported in
     Chromium 111+ which Ave's Electron 41 ships. */
  /* Plugin-internal computed vars — only kept where no host token equivalent exists.
     All other styling uses --ave-* tokens directly (SOT: plugin-ui-tokens.ts).
     Tinted-surface tokens (accent-bg, danger-bg, success-bg, warning-bg, surface-hover)
     are now provided by the host as --ave-*-bg-subtle/strong.
     Remaining --pm-* entries: darker danger variant, toggle-specific shadow/hover
     (offset+blur box-shadow has no host elevation-token equivalent yet). */
  --pm-danger-active:      color-mix(in srgb, var(--ave-danger) 80%, black);
  /* Speaker-avatar chips. Five visually-distinct slots cycled by speaker
     index (avatarClassFor → a0…a4). Each slot is a soft tint of one host
     accent hue so the chips track the active theme bundle (light/dark/
     high-contrast) instead of staying frozen as light-mode pastels. The
     bg is the accent mixed into the surface, fg is the accent itself for
     contrast, and the border is a stronger tint of the same hue. */
  --pm-avatar-0-bg:     color-mix(in srgb, var(--ave-primary)   16%, var(--ave-surface));
  --pm-avatar-0-fg:     var(--ave-primary);
  --pm-avatar-0-border: color-mix(in srgb, var(--ave-primary)   38%, var(--ave-surface));
  --pm-avatar-1-bg:     color-mix(in srgb, var(--ave-success)   16%, var(--ave-surface));
  --pm-avatar-1-fg:     var(--ave-success);
  --pm-avatar-1-border: color-mix(in srgb, var(--ave-success)   38%, var(--ave-surface));
  --pm-avatar-2-bg:     color-mix(in srgb, var(--ave-warning)   16%, var(--ave-surface));
  --pm-avatar-2-fg:     var(--ave-warning);
  --pm-avatar-2-border: color-mix(in srgb, var(--ave-warning)   38%, var(--ave-surface));
  --pm-avatar-3-bg:     color-mix(in srgb, var(--ave-danger)    16%, var(--ave-surface));
  --pm-avatar-3-fg:     var(--ave-danger);
  --pm-avatar-3-border: color-mix(in srgb, var(--ave-danger)    38%, var(--ave-surface));
  --pm-avatar-4-bg:     color-mix(in srgb, var(--ave-ring)      16%, var(--ave-surface));
  --pm-avatar-4-fg:     var(--ave-ring);
  --pm-avatar-4-border: color-mix(in srgb, var(--ave-ring)      38%, var(--ave-surface));
  --pm-toggle-hover-bg:    color-mix(in srgb, var(--ave-primary) 14%, var(--ave-surface));
  --pm-toggle-hover-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--ave-ring) 34%, transparent),
    0 1px 3px rgba(0, 0, 0, .08);
  --pm-toggle-selected-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--ave-primary-fg) 18%, transparent),
    0 2px 8px color-mix(in srgb, var(--ave-primary) 28%, transparent);
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", sans-serif;

  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--ave-bg);
  color: var(--ave-fg);
  font-family: var(--font);
  font-size: 13px;
  line-height: 1.5;
  letter-spacing: 0;
  overflow: hidden;
  box-sizing: border-box;
}
.ave-meeting-ui *,
.ave-meeting-ui *::before,
.ave-meeting-ui *::after { box-sizing: border-box; }

/* Inner column: fluid, centered, capped at a readable measure. The root stays
   full-width (its background fills the panel); this column is centered via
   align-self.

   The cap is max-width, never a fixed width. A fixed width made every layout
   below it dead to the panel size: the tab bar measured 580px whether the
   panel was 928px or 1960px, so widening the window changed nothing. The cap
   now only stops the measure from growing past readability; everything from a
   narrow sidebar up to the cap fills the space it is given.

   container-type makes the @container queries below resolve against THIS
   column rather than the webview viewport. Those are equal today, but the
   panel is the axis that actually governs the layout — a host-side split pane
   would desync the viewport from it. */
.ave-meeting-ui .mc-inner {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  align-self: center;
  min-height: 0;
  width: 100%;
  max-width: 860px;
  overflow: hidden;
  container-type: inline-size;
}

/* Tabs are sized by their labels and wrap when the row runs out — they do not
   divide the row. An earlier version gave every tab flex-grow:1, which reads
   as harmless in a narrow panel but is the whole reason the host used to clamp
   this panel: at full pane width two tabs each stretched to ~430px, a tab bar
   made of two enormous buttons. Shrink and min-width are what the wrapping
   behaviour actually needs; grow was never part of it. */
.ave-meeting-ui .top-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--ave-border);
  background: var(--ave-bg);
  flex-shrink: 0;
}
.ave-meeting-ui .nav-btn {
  flex: 0 1 auto;
  min-width: 96px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: var(--ave-radius-sm, 6px);
  border: 1px solid var(--ave-border);
  background: var(--ave-surface);
  color: var(--ave-fg-muted);
  font-size: var(--ave-text-sm, 12px);
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  transition: background .15s, color .15s, border-color .15s;
}
.ave-meeting-ui .nav-btn:hover {
  background: var(--ave-secondary);
  color: var(--ave-fg-muted);
}
.ave-meeting-ui .nav-btn.active {
  background: var(--ave-primary-bg-subtle);
  border-color: var(--ave-ring);
  color: var(--ave-primary);
}
.ave-meeting-ui .nav-btn svg { width: 14px; height: 14px; }

.ave-meeting-ui .view {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.ave-meeting-ui .recorder {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px;
  min-height: 0;
}
.ave-meeting-ui .session-row {
  display: flex;
  gap: 8px;
  align-items: center;
  background: var(--ave-surface);
  border: 1px solid var(--ave-border);
  border-radius: var(--ave-radius, 8px);
  padding: 8px 10px;
}
.ave-meeting-ui .session-label {
  font-size: var(--ave-text-xs, 10px);
  color: var(--ave-fg-muted);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: .04em;
  flex-shrink: 0;
}
.ave-meeting-ui .session-input {
  flex: 1 1 auto;
  min-width: 0;
  background: transparent;
  border: none;
  color: var(--ave-fg);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: var(--ave-text-xs, 10px);
  outline: none;
  padding: 2px 4px;
  border-radius: var(--ave-radius-xs, 4px);
}
.ave-meeting-ui .session-input:focus { background: var(--ave-secondary); }
.ave-meeting-ui .session-input:disabled { opacity: 0.5; cursor: not-allowed; }

.ave-meeting-ui .meter {
  background: var(--ave-surface);
  border: 1px solid var(--ave-border);
  border-radius: var(--ave-radius, 8px);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ave-meeting-ui .meter-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.ave-meeting-ui .timer {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 19px;
  font-weight: 600;
  color: var(--ave-fg);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
}
.ave-meeting-ui .meter[data-active="true"] .timer { color: var(--ave-primary); }
.ave-meeting-ui .stats { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.ave-meeting-ui .stat {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--ave-text-xs, 10px);
  color: var(--ave-fg-muted);
}
.ave-meeting-ui .stat b {
  color: var(--ave-fg-muted);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.ave-meeting-ui .stat svg { width: 11px; height: 11px; }
.ave-meeting-ui .mode-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: var(--ave-text-xs, 10px);
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  background: var(--ave-secondary);
  border: 1px solid var(--ave-border);
  color: var(--ave-fg-muted);
}
.ave-meeting-ui .mode-badge[data-mode="batch"] {
  color: var(--ave-warning);
  background: var(--ave-warning-bg-subtle);
  border-color: color-mix(in srgb, var(--ave-warning) 25%, transparent);
}

.ave-meeting-ui .status-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--ave-secondary);
  border: 1px solid var(--ave-border);
  font-size: var(--ave-text-xs, 10px);
  font-weight: 600;
  color: var(--ave-fg-muted);
  white-space: nowrap;
}
.ave-meeting-ui .status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ave-fg-muted);
}
.ave-meeting-ui .status-pill[data-state="recording"] { color: var(--ave-danger); background: var(--ave-danger-bg-subtle); border-color: color-mix(in srgb, var(--ave-danger) 25%, transparent); }
.ave-meeting-ui .status-pill[data-state="recording"] .status-dot { background: var(--ave-danger); }
.ave-meeting-ui .status-pill[data-state="analyzing"] { color: var(--ave-primary); background: var(--ave-primary-bg-subtle); border-color: color-mix(in srgb, var(--ave-primary) 25%, transparent); }
.ave-meeting-ui .status-pill[data-state="analyzing"] .status-dot { background: var(--ave-primary); }
.ave-meeting-ui .status-pill[data-state="done"] { color: var(--ave-success); background: var(--ave-success-bg-subtle); border-color: color-mix(in srgb, var(--ave-success) 25%, transparent); }
.ave-meeting-ui .status-pill[data-state="done"] .status-dot { background: var(--ave-success); }
.ave-meeting-ui .status-pill[data-state="error"] { color: var(--ave-danger); background: var(--ave-danger-bg-subtle); border-color: color-mix(in srgb, var(--ave-danger) 25%, transparent); }
.ave-meeting-ui .status-pill[data-state="error"] .status-dot { background: var(--ave-danger); }

.ave-meeting-ui .waveform {
  height: 48px;
  background: var(--ave-secondary);
  border: 1px solid var(--ave-border);
  border-radius: var(--ave-radius-sm, 6px);
  overflow: hidden;
}
.ave-meeting-ui .waveform canvas {
  display: block;
  width: 100%;
  height: 100%;
  /* Canvas bars read this color via getComputedStyle at draw time so the
     waveform tracks the active theme bundle's primary hue. */
  color: var(--ave-primary);
}

.ave-meeting-ui .controls { display: flex; gap: 6px; }
.ave-meeting-ui .btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 12px;
  border-radius: var(--ave-radius-sm, 6px);
  border: 1px solid var(--ave-border);
  background: var(--ave-secondary);
  color: var(--ave-fg-muted);
  font-family: inherit;
  font-size: var(--ave-text-sm, 12px);
  font-weight: 600;
  cursor: pointer;
  transition: background .15s, border-color .15s, color .15s, opacity .15s;
}
.ave-meeting-ui .btn:disabled { opacity: 0.45; cursor: not-allowed; }
.ave-meeting-ui .btn:not(:disabled):hover {
  background: var(--ave-surface);
  border-color: var(--ave-fg-muted);
}
.ave-meeting-ui .btn svg { width: 14px; height: 14px; }
.ave-meeting-ui .btn-primary {
  background: var(--ave-primary);
  border-color: var(--ave-primary);
  color: var(--ave-primary-fg);
}
.ave-meeting-ui .btn-primary:not(:disabled):hover { background: var(--ave-ring); border-color: var(--ave-ring); }
.ave-meeting-ui .btn-danger {
  background: var(--ave-danger);
  border-color: var(--ave-danger);
  color: var(--ave-danger-fg);
}
.ave-meeting-ui .btn-danger:not(:disabled):hover { background: var(--pm-danger-active); border-color: var(--pm-danger-active); }

.ave-meeting-ui .transcript {
  flex: 1 1 auto;
  min-height: 80px;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--ave-surface);
  border: 1px solid var(--ave-border);
  border-radius: var(--ave-radius, 8px);
  scrollbar-width: thin;
  scrollbar-color: var(--ave-border) transparent;
}
.ave-meeting-ui .transcript::-webkit-scrollbar { width: 6px; }
.ave-meeting-ui .transcript::-webkit-scrollbar-thumb {
  background: var(--ave-border);
  border-radius: 3px;
}

/* .empty base defined in the Polish layer below (bigger, friendlier version). */

.ave-meeting-ui .segment {
  display: flex;
  gap: 8px;
}
.ave-meeting-ui .avatar {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--ave-text-xs, 10px);
  font-weight: 700;
}
.ave-meeting-ui .avatar.a0 { background: var(--pm-avatar-0-bg); color: var(--pm-avatar-0-fg); border: 1px solid var(--pm-avatar-0-border); }
.ave-meeting-ui .avatar.a1 { background: var(--pm-avatar-1-bg); color: var(--pm-avatar-1-fg); border: 1px solid var(--pm-avatar-1-border); }
.ave-meeting-ui .avatar.a2 { background: var(--pm-avatar-2-bg); color: var(--pm-avatar-2-fg); border: 1px solid var(--pm-avatar-2-border); }
.ave-meeting-ui .avatar.a3 { background: var(--pm-avatar-3-bg); color: var(--pm-avatar-3-fg); border: 1px solid var(--pm-avatar-3-border); }
.ave-meeting-ui .avatar.a4 { background: var(--pm-avatar-4-bg); color: var(--pm-avatar-4-fg); border: 1px solid var(--pm-avatar-4-border); }
.ave-meeting-ui .segment-body { flex: 1 1 auto; min-width: 0; }
.ave-meeting-ui .segment-meta {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 3px;
  font-size: var(--ave-text-xs, 10px);
}
.ave-meeting-ui .segment-speaker { color: var(--ave-fg); font-weight: 700; }
.ave-meeting-ui .segment-time {
  color: var(--ave-fg-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
}
.ave-meeting-ui .bubble {
  background: var(--ave-secondary);
  border: 1px solid var(--ave-border);
  border-radius: var(--ave-radius-xs, 4px);
  padding: 6px 9px;
  font-size: var(--ave-text-sm, 12px);
  color: var(--ave-fg);
  word-break: break-word;
  line-height: 1.5;
}
.ave-meeting-ui .segment[data-streaming="1"] .bubble {
  border-color: var(--ave-ring);
  background: var(--ave-primary-bg-subtle);
}

.ave-meeting-ui .summary {
  margin-top: 4px;
  padding: 12px;
  border-radius: var(--ave-radius, 8px);
  background: var(--ave-secondary);
  border: 1px solid var(--ave-ring);
}
.ave-meeting-ui .summary-title {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ave-primary);
  font-size: 13px;
  font-weight: 700;
  margin-bottom: 6px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--ave-border);
}
.ave-meeting-ui .summary-title svg { width: 14px; height: 14px; }
.ave-meeting-ui .summary-body {
  font-size: var(--ave-text-sm, 12px);
  line-height: 1.6;
  color: var(--ave-fg);
  white-space: pre-wrap;
}
.ave-meeting-ui .summary-section { margin-top: 10px; }
.ave-meeting-ui .summary-section-label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: var(--ave-text-xs, 10px);
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--ave-fg-muted);
  margin-bottom: 5px;
}
.ave-meeting-ui .summary-section-label svg { width: 12px; height: 12px; }
.ave-meeting-ui .summary-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.ave-meeting-ui .summary-item {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  font-size: var(--ave-text-sm, 12px);
  color: var(--ave-fg);
  padding: 5px 8px;
  background: var(--ave-surface);
  border-radius: var(--ave-radius-xs, 4px);
  border-left: 2px solid var(--ave-primary);
}
.ave-meeting-ui .summary-item.action { border-left-color: var(--ave-warning); }
.ave-meeting-ui .summary-item-marker {
  color: var(--ave-fg-muted);
  flex-shrink: 0;
  font-weight: 700;
}

/* Inline-edit + regenerate UI for the 회의록 sub-tab */
.ave-meeting-ui .summary-toolbar {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
  justify-content: flex-end;
}
.ave-meeting-ui .summary-action-btn {
  background: var(--ave-secondary);
  color: var(--ave-fg);
  border: 1px solid var(--ave-border);
  border-radius: 6px;
  padding: 5px 10px;
  font-size: var(--ave-text-xs, 10px);
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: background .12s, border-color .12s;
}
.ave-meeting-ui .summary-action-btn:hover {
  background: var(--ave-surface);
  border-color: var(--ave-border);
}
.ave-meeting-ui .summary-action-regen {
  background: var(--ave-primary-bg-subtle);
  border-color: var(--ave-ring);
  color: var(--ave-primary);
}
.ave-meeting-ui .summary-action-regen:hover {
  background: var(--ave-primary-bg-strong);
}
/* ⋯ overflow menu in the summary toolbar. Anchor is the toolbar itself
   (position: relative on .summary-toolbar). Popover floats below the
   ⋯ button, dismissed by outside-click or by selecting an item. */
.ave-meeting-ui .summary-toolbar { position: relative; }
.ave-meeting-ui .summary-action-more {
  padding: 5px 8px;
  font-size: 12px;
  line-height: 1;
  letter-spacing: 0.05em;
}
.ave-meeting-ui .summary-more-popover {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 30;
  min-width: 200px;
  background: var(--ave-surface);
  border: 1px solid var(--ave-border);
  border-radius: 8px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.12);
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ave-meeting-ui .summary-more-item {
  text-align: left;
  background: transparent;
  border: 0;
  padding: 7px 10px;
  border-radius: 6px;
  font-family: inherit;
  font-size: var(--ave-text-sm, 12px);
  color: var(--ave-fg);
  cursor: pointer;
}
.ave-meeting-ui .summary-more-item:hover {
  background: var(--ave-secondary);
}
.ave-meeting-ui .summary-more-item:disabled {
  color: var(--ave-fg-muted);
  cursor: not-allowed;
  background: transparent;
}
.ave-meeting-ui .prompt-overlay {
  position: absolute;
  inset: 0;
  z-index: 100;
  background: rgba(0, 0, 0, 0.32);
  display: flex;
  align-items: stretch;
  justify-content: stretch;
}
.ave-meeting-ui .prompt-overlay.category-dialog {
  align-items: center;
  justify-content: center;
  padding: 18px;
}
.ave-meeting-ui .prompt-overlay-card {
  flex: 1 1 auto;
  background: var(--ave-bg);
  display: flex;
  flex-direction: column;
  padding: 14px;
  overflow: hidden;
}
.ave-meeting-ui .category-dialog-card {
  flex: 0 1 360px;
  max-width: min(360px, 100%);
  border: 1px solid var(--ave-border);
  border-radius: 14px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, .18);
}
.ave-meeting-ui .prompt-overlay-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.ave-meeting-ui .prompt-overlay-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--ave-fg);
  flex: 1 1 auto;
}
.ave-meeting-ui .prompt-overlay-close {
  background: transparent;
  border: 0;
  color: var(--ave-fg-muted);
  font-size: 14px;
  line-height: 1;
  padding: 4px 8px;
  border-radius: 6px;
  cursor: pointer;
}
.ave-meeting-ui .prompt-overlay-close:hover { background: var(--ave-secondary); }
.ave-meeting-ui .prompt-overlay-note {
  font-size: var(--ave-text-xs, 10px);
  color: var(--ave-fg-muted);
  background: var(--ave-warning-bg-subtle);
  border-left: 3px solid var(--ave-warning);
  padding: 6px 8px;
  border-radius: 4px;
  margin-bottom: 10px;
  line-height: 1.45;
}
.ave-meeting-ui .prompt-overlay-body {
  flex: 1 1 auto;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ave-meeting-ui .prompt-overlay-field-label {
  font-size: var(--ave-text-xs, 10px);
  font-weight: 700;
  color: var(--ave-fg-muted);
  display: flex;
  align-items: center;
  gap: 6px;
}
.ave-meeting-ui .prompt-overlay-field-reset {
  background: transparent;
  border: 0;
  color: var(--ave-primary);
  font-family: inherit;
  font-size: var(--ave-text-xs, 10px);
  padding: 0;
  cursor: pointer;
  text-decoration: underline;
}
.ave-meeting-ui .prompt-overlay-textarea {
  width: 100%;
  min-height: 140px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--ave-text-sm, 12px);
  padding: 8px;
  border-radius: 6px;
  border: 1px solid var(--ave-border);
  background: var(--ave-surface);
  color: var(--ave-fg);
  outline: none;
  resize: vertical;
}
.ave-meeting-ui .prompt-overlay-textarea:focus { border-color: var(--ave-primary); }
.ave-meeting-ui .category-dialog-input {
  width: 100%;
  font-family: inherit;
  font-size: var(--ave-text-sm, 12px);
  padding: 9px 10px;
  border-radius: 8px;
  border: 1px solid var(--ave-border);
  background: var(--ave-surface);
  color: var(--ave-fg);
  outline: none;
}
.ave-meeting-ui .category-dialog-input:focus {
  border-color: var(--ave-primary);
}
.ave-meeting-ui .category-dialog-error {
  min-height: 16px;
  font-size: var(--ave-text-xs, 10px);
  color: var(--ave-danger);
}
.ave-meeting-ui .prompt-overlay-footer {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding-top: 10px;
  border-top: 1px solid var(--ave-border);
  margin-top: 10px;
}
.ave-meeting-ui .prompt-overlay-save,
.ave-meeting-ui .prompt-overlay-cancel {
  border-radius: 6px;
  padding: 6px 14px;
  font-family: inherit;
  font-size: var(--ave-text-sm, 12px);
  cursor: pointer;
}
.ave-meeting-ui .prompt-overlay-save {
  background: var(--ave-primary);
  color: var(--ave-primary-fg);
  border: 0;
  font-weight: 600;
}
.ave-meeting-ui .prompt-overlay-save:disabled,
.ave-meeting-ui .prompt-overlay-cancel:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.ave-meeting-ui .prompt-overlay-cancel {
  background: var(--ave-surface);
  color: var(--ave-fg);
  border: 1px solid var(--ave-border);
}
.ave-meeting-ui .prompt-overlay-busy {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--ave-bg) 92%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ave-fg-muted);
  font-size: var(--ave-text-sm, 12px);
}
.ave-meeting-ui .summary-edit {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  background: var(--ave-primary-bg-subtle);
  border: 1px solid var(--ave-ring);
  border-radius: 8px;
}
.ave-meeting-ui .summary-edit-banner {
  font-size: var(--ave-text-xs, 10px);
  font-weight: 600;
  color: var(--ave-primary);
  padding: 4px 0;
}
.ave-meeting-ui .summary-edit-label {
  font-size: var(--ave-text-xs, 10px);
  font-weight: 700;
  color: var(--ave-fg-muted);
  letter-spacing: 0.02em;
  margin-top: 4px;
}
.ave-meeting-ui .summary-edit-input,
.ave-meeting-ui .summary-edit-textarea {
  width: 100%;
  font-family: inherit;
  font-size: var(--ave-text-sm, 12px);
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid var(--ave-border);
  background: var(--ave-secondary);
  color: var(--ave-fg);
  outline: none;
  resize: vertical;
}
.ave-meeting-ui .summary-edit-input:focus,
.ave-meeting-ui .summary-edit-textarea:focus { border-color: var(--ave-primary); }
.ave-meeting-ui .summary-edit-list { display: flex; flex-direction: column; gap: 4px; }
.ave-meeting-ui .summary-edit-row { display: flex; gap: 6px; align-items: center; }
.ave-meeting-ui .summary-edit-row-input {
  flex: 1 1 auto;
  font-family: inherit;
  font-size: var(--ave-text-sm, 12px);
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid var(--ave-border);
  background: var(--ave-secondary);
  color: var(--ave-fg);
  outline: none;
}
.ave-meeting-ui .summary-edit-row-input:focus { border-color: var(--ave-primary); }
.ave-meeting-ui .summary-edit-row-remove {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  border: 1px solid var(--ave-border);
  background: transparent;
  color: var(--ave-fg-muted);
  cursor: pointer;
  font-size: var(--ave-text-xs, 10px);
  font-family: inherit;
}
.ave-meeting-ui .summary-edit-row-remove:hover {
  background: var(--ave-danger-bg-subtle);
  color: var(--ave-danger);
  border-color: var(--ave-danger);
}
.ave-meeting-ui .summary-edit-add {
  align-self: flex-start;
  background: transparent;
  color: var(--ave-fg-muted);
  border: 1px dashed var(--ave-border);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: var(--ave-text-xs, 10px);
  font-family: inherit;
  cursor: pointer;
  margin-top: 2px;
}
.ave-meeting-ui .summary-edit-add:hover { color: var(--ave-fg); border-color: var(--ave-fg-muted); }
.ave-meeting-ui .summary-edit-buttons {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
  margin-top: 8px;
}
.ave-meeting-ui .summary-edit-save {
  background: var(--ave-primary);
  color: var(--ave-primary-fg);
  border: none;
  border-radius: 6px;
  padding: 6px 14px;
  font-size: var(--ave-text-sm, 12px);
  font-weight: 700;
  font-family: inherit;
  cursor: pointer;
}
.ave-meeting-ui .summary-edit-save:hover { background: var(--ave-ring); }
.ave-meeting-ui .summary-edit-cancel {
  background: transparent;
  color: var(--ave-fg-muted);
  border: 1px solid var(--ave-border);
  border-radius: 6px;
  padding: 6px 14px;
  font-size: var(--ave-text-sm, 12px);
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
}
.ave-meeting-ui .summary-edit-cancel:hover { color: var(--ave-fg); border-color: var(--ave-fg-muted); }
.ave-meeting-ui .summary-regen { display: flex; flex-direction: column; gap: 8px; }
.ave-meeting-ui .summary-regen-tiers {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 6px;
}
.ave-meeting-ui .summary-regen-tier {
  background: var(--ave-secondary);
  color: var(--ave-fg);
  border: 1px solid var(--ave-border);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: var(--ave-text-sm, 12px);
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
}
.ave-meeting-ui .summary-regen-tier:hover {
  background: var(--ave-primary-bg-subtle);
  border-color: var(--ave-ring);
  color: var(--ave-primary);
}
.ave-meeting-ui .summary-regen-cancel { align-self: flex-end; }
.ave-meeting-ui .summary-busy {
  padding: 16px;
  text-align: center;
  color: var(--ave-fg-muted);
  font-size: var(--ave-text-sm, 12px);
}

.ave-meeting-ui .session-list {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  scrollbar-width: thin;
  scrollbar-color: var(--ave-border) transparent;
}
.ave-meeting-ui .session-list::-webkit-scrollbar { width: 6px; }
.ave-meeting-ui .session-list::-webkit-scrollbar-thumb {
  background: var(--ave-border);
  border-radius: 3px;
}
.ave-meeting-ui .session-card {
  background: var(--ave-surface);
  border: 1px solid var(--ave-border);
  border-radius: var(--ave-radius, 8px);
  color: inherit;
  font: inherit;
  padding: 10px 12px;
  cursor: pointer;
  text-align: left;
  transition: background .12s, border-color .12s;
  width: 100%;
}
.ave-meeting-ui .session-card:hover {
  background: var(--ave-secondary);
  border-color: var(--ave-border);
}
.ave-meeting-ui .session-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.ave-meeting-ui .session-card-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--ave-text-base, 14px);
  font-weight: 600;
  color: var(--ave-fg);
  margin-bottom: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ave-meeting-ui .session-card-meta {
  font-size: var(--ave-text-xs, 10px);
  color: var(--ave-primary);
  margin-bottom: 4px;
}
.ave-meeting-ui .session-card-meta .dot { color: var(--ave-fg-muted); margin: 0 4px; }
.ave-meeting-ui .session-card-stats {
  display: flex;
  gap: 8px;
  font-size: var(--ave-text-xs, 10px);
  color: var(--ave-fg-muted);
}
.ave-meeting-ui .session-card-stats b {
  color: var(--ave-fg-muted);
  font-weight: 700;
}

.ave-meeting-ui .detail {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.ave-meeting-ui .detail-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--ave-border);
  background: var(--ave-bg);
  flex-shrink: 0;
}
.ave-meeting-ui .back-btn {
  background: transparent;
  border: 1px solid var(--ave-border);
  color: var(--ave-fg-muted);
  border-radius: var(--ave-radius-sm, 6px);
  padding: 4px 9px;
  cursor: pointer;
  font-size: var(--ave-text-sm, 12px);
  font-family: inherit;
  flex-shrink: 0;
}
.ave-meeting-ui .back-btn:hover {
  background: var(--ave-surface);
  color: var(--ave-fg);
}
.ave-meeting-ui .detail-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--ave-text-base, 14px);
  font-weight: 600;
  color: var(--ave-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ave-meeting-ui .detail-time {
  font-size: var(--ave-text-xs, 10px);
  color: var(--ave-fg-muted);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.ave-meeting-ui .sub-tabs {
  display: flex;
  gap: 4px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--ave-border);
  background: var(--ave-bg);
  flex-shrink: 0;
}
.ave-meeting-ui .sub-tab {
  flex: 1;
  padding: 5px 8px;
  border-radius: var(--ave-radius-sm, 6px);
  border: 1px solid transparent;
  background: transparent;
  color: var(--ave-fg-muted);
  font-family: inherit;
  font-size: var(--ave-text-xs, 10px);
  font-weight: 500;
  cursor: pointer;
  transition: background .12s, color .12s, border-color .12s;
}
.ave-meeting-ui .sub-tab:hover {
  background: var(--ave-surface);
  color: var(--ave-fg-muted);
}
.ave-meeting-ui .sub-tab.active {
  background: var(--ave-primary-bg-subtle);
  border-color: var(--ave-ring);
  color: var(--ave-primary);
}

.ave-meeting-ui .detail-body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  scrollbar-width: thin;
  scrollbar-color: var(--ave-border) transparent;
}
.ave-meeting-ui .detail-body::-webkit-scrollbar { width: 6px; }
.ave-meeting-ui .detail-body::-webkit-scrollbar-thumb {
  background: var(--ave-border);
  border-radius: 3px;
}

.ave-meeting-ui .intermediate-card {
  background: var(--ave-surface);
  border: 1px solid var(--ave-border);
  border-radius: var(--ave-radius, 8px);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ave-meeting-ui .intermediate-card-meta {
  font-size: var(--ave-text-xs, 10px);
  color: var(--ave-fg-muted);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: .04em;
  display: flex;
  justify-content: space-between;
}
.ave-meeting-ui .intermediate-card-summary {
  font-size: var(--ave-text-sm, 12px);
  color: var(--ave-fg);
  line-height: 1.5;
  white-space: pre-wrap;
}
.ave-meeting-ui .intermediate-card-highlights {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.ave-meeting-ui .intermediate-card-highlight {
  font-size: var(--ave-text-sm, 12px);
  color: var(--ave-fg-muted);
  padding: 4px 8px;
  background: var(--ave-secondary);
  border-radius: var(--ave-radius-xs, 4px);
  border-left: 2px solid var(--ave-primary);
}

.ave-meeting-ui .error-banner {
  padding: 8px 10px;
  background: var(--ave-danger-bg-subtle);
  border: 1px solid color-mix(in srgb, var(--ave-danger) 25%, transparent);
  border-radius: var(--ave-radius-sm, 6px);
  color: var(--ave-danger);
  font-size: var(--ave-text-sm, 12px);
  margin: 10px;
}
.ave-meeting-ui .toast-error {
  position: fixed; right: 16px; z-index: 9999;
  padding: 8px 14px; border-radius: var(--ave-radius, 8px);
  background: var(--ave-danger-bg-subtle);
  color: var(--ave-danger);
  border: 1px solid var(--ave-danger);
  font-size: var(--ave-text-sm, 12px); animation: pm-fade-out 3s forwards;
}
.ave-meeting-ui .toast-success {
  position: fixed; right: 16px; z-index: 9999;
  padding: 8px 14px; border-radius: var(--ave-radius, 8px);
  background: var(--ave-success-bg-subtle);
  color: var(--ave-success);
  border: 1px solid var(--ave-success);
  font-size: var(--ave-text-sm, 12px); animation: pm-fade-out 3s forwards;
}
@keyframes pm-fade-out { 0%, 80% { opacity: 1; } 100% { opacity: 0; } }

.ave-meeting-ui .transcript-pane {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* ─── Pre-meeting prep view ─────────────────────────── */
/* All colors flow from the shared :root palette so this view stays in
   lockstep with recorder + sessions when the theme changes. */
.ave-meeting-ui .pre-meeting {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  background: var(--ave-bg);
  color: var(--ave-fg);
  padding: 18px 22px 22px;
  gap: 14px;
}
.ave-meeting-ui .pre-meeting .pm-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.ave-meeting-ui .pre-meeting .pm-topbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 700;
  color: var(--ave-fg);
}
.ave-meeting-ui .pre-meeting .pm-icon-btn {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--ave-fg);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font: inherit;
}
.ave-meeting-ui .pre-meeting .pm-icon-btn:hover { background: var(--ave-secondary); }
.ave-meeting-ui .pre-meeting .pm-icon-btn:focus-visible {
  /* Designer C: tight 2px solid ring without bg-offset gap — the global
     focus-ring at line 1716 uses a 2px bg-offset + 4px shadow which clips
     visually against the bg on small (28×28) icon buttons. Single solid
     ring keeps the affordance visible for keyboard nav. */
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ave-ring) 80%, transparent);
}
.ave-meeting-ui .pre-meeting .pm-topbar-left .pm-icon-btn {
  color: var(--ave-primary);
  background: var(--ave-primary-bg-subtle);
  border: 1px solid color-mix(in srgb, var(--ave-ring) 42%, transparent);
}
.ave-meeting-ui .pre-meeting .pm-topbar-left .pm-icon-btn:hover {
  background: var(--ave-primary);
  border-color: var(--ave-primary);
  color: var(--ave-primary-fg);
}
.ave-meeting-ui .pre-meeting .pm-nav {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px 5px;
  border-radius: 999px;
  background: var(--ave-primary-bg-subtle);
  border: 1px solid color-mix(in srgb, var(--ave-ring) 42%, transparent);
}
.ave-meeting-ui .pre-meeting .pm-nav-btn {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  /* Use the chat-theme accent (purple/orange/blue/lg whichever the user
     selected in Ave) so the arrows always render in the same colour
     family as the active chat highlight. SVG icons use currentColor for
     their stroke, so setting the color property is enough. */
  color: var(--ave-primary);
  background: color-mix(in srgb, var(--ave-primary-bg-subtle) 65%, transparent);
}
.ave-meeting-ui .pre-meeting .pm-nav-btn:hover {
  background: var(--ave-primary);
  color: var(--ave-primary-fg);
}
.ave-meeting-ui .pre-meeting .pm-nav-btn svg { width: 14px; height: 14px; }
.ave-meeting-ui .pre-meeting .pm-nav-count {
  font-size: var(--ave-text-sm, 12px);
  font-weight: 700;
  color: var(--ave-primary);
  font-variant-numeric: tabular-nums;
  min-width: 36px;
  text-align: center;
  padding: 0 2px;
}
.ave-meeting-ui .pre-meeting .pm-title {
  font-size: 22px;
  font-weight: 800;
  color: var(--ave-fg);
  line-height: 1.3;
  margin-top: 4px;
}
.ave-meeting-ui .pre-meeting .pm-subtitle {
  font-size: var(--ave-text-base, 14px);
  color: var(--ave-fg-muted);
  margin-top: -6px;
}
.ave-meeting-ui .pre-meeting .pm-description {
  font-size: var(--ave-text-base, 14px);
  line-height: 1.6;
  color: var(--ave-fg-muted);
  background: var(--ave-surface);
  border: 1px solid var(--ave-border);
  border-radius: var(--ave-radius-sm, 6px);
  padding: 10px 12px;
  white-space: pre-wrap;
}
.ave-meeting-ui .pre-meeting .pm-meta-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: space-between;
}
.ave-meeting-ui .pre-meeting .pm-chips { display: flex; gap: 8px; flex-wrap: wrap; }
.ave-meeting-ui .pre-meeting .pm-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 999px;
  background: var(--ave-surface);
  border: 1px solid var(--ave-border);
  font-size: var(--ave-text-base, 14px);
  color: var(--ave-fg-muted);
}
.ave-meeting-ui .pre-meeting .pm-chip svg { width: 14px; height: 14px; opacity: .7; }
.ave-meeting-ui .pre-meeting .pm-avatars {
  display: inline-flex;
  align-items: center;
}
.ave-meeting-ui .pre-meeting .pm-avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--ave-fg-muted);
  color: var(--ave-surface);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--ave-text-xs, 10px);
  font-weight: 700;
  margin-left: -6px;
  border: 2px solid var(--ave-bg);
}
.ave-meeting-ui .pre-meeting .pm-avatar:first-child { margin-left: 0; }
.ave-meeting-ui .pre-meeting .pm-avatar.more { background: var(--ave-primary); color: var(--ave-primary-fg); }
.ave-meeting-ui .pre-meeting .pm-webex {
  background: transparent;
  font-size: var(--ave-text-sm, 12px);
  color: var(--ave-fg-muted);
  line-height: 1.6;
  word-break: break-all;
}
.ave-meeting-ui .pre-meeting .pm-webex b { color: var(--ave-fg); font-weight: 700; }
.ave-meeting-ui .pre-meeting .pm-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
  gap: 18px;
  align-items: start;
}
@container (max-width: 720px) {
  .ave-meeting-ui .pre-meeting .pm-grid { grid-template-columns: 1fr; }
}
.ave-meeting-ui .pre-meeting .pm-section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--ave-text-base, 14px);
  font-weight: 700;
  color: var(--ave-fg);
  margin-bottom: 8px;
}
.ave-meeting-ui .pre-meeting .pm-section-title svg { width: 16px; height: 16px; }
.ave-meeting-ui .pre-meeting .pm-card {
  background: var(--ave-surface);
  border-radius: 14px;
  padding: 18px 20px;
  border: 1px solid var(--ave-border);
  box-shadow: 0 1px 2px rgba(0,0,0,.03);
}
.ave-meeting-ui .pre-meeting .pm-card + .pm-section-title {
  margin-top: 16px;
}
.ave-meeting-ui .pre-meeting .pm-card-title {
  font-size: var(--ave-text-base, 14px);
  font-weight: 700;
  color: var(--ave-fg);
  margin-bottom: 10px;
}
.ave-meeting-ui .pre-meeting .pm-card-body {
  font-size: var(--ave-text-base, 14px);
  line-height: 1.65;
  color: var(--ave-fg-muted);
  white-space: pre-wrap;
}
.ave-meeting-ui .pre-meeting .pm-card-body .hi {
  font-weight: 700;
  color: var(--ave-fg);
}
.ave-meeting-ui .pre-meeting .pm-agenda-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ave-meeting-ui .pre-meeting .pm-agenda-item {
  display: grid;
  grid-template-columns: 22px 1fr;
  gap: 10px;
  align-items: start;
  font-size: var(--ave-text-base, 14px);
  color: var(--ave-fg);
  line-height: 1.45;
}
.ave-meeting-ui .pre-meeting .pm-agenda-num {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: var(--ave-primary);
  color: var(--ave-primary-fg);
  font-size: var(--ave-text-xs, 10px);
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.ave-meeting-ui .pre-meeting .pm-actions {
  margin-top: 16px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.ave-meeting-ui .pre-meeting .pm-actions.pm-actions-stack {
  grid-template-columns: 1fr;
}
.ave-meeting-ui .pre-meeting .pm-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 12px 14px;
  border-radius: 10px;
  border: none;
  font-size: var(--ave-text-base, 14px);
  font-weight: 700;
  cursor: pointer;
  font-family: inherit;
}
/* pm-btn-primary / pm-btn-dark / pm-btn-webex color rules live in the Polish
   layer below (with correct :not(:disabled) hover guards). */
.ave-meeting-ui .pre-meeting .pm-btn svg { width: 16px; height: 16px; }
.ave-meeting-ui .pre-meeting .pm-btn:disabled { opacity: .5; cursor: not-allowed; }
.ave-meeting-ui .pre-meeting input[type="file"] { display: none; }
.ave-meeting-ui .pre-meeting .pm-status {
  font-size: var(--ave-text-sm, 12px);
  color: var(--ave-fg-muted);
  margin-top: 8px;
  text-align: center;
}
.ave-meeting-ui .pre-meeting .pm-status.error { color: var(--ave-danger); }

/* (The floating recorder's CSS is not here — the recorder is its own card,
   styled in src/ui/recorder-card.js, mounted into the host's floating dock.) */

/* ─────────────────────────────────────────────────────── */
/*  Polish layer — appended last so it wins specificity       */
/*  ties without restructuring earlier rules. Intent: gentle  */
/*  elevation, smoother hovers, more breathing room.          */
/* ─────────────────────────────────────────────────────── */

.ave-meeting-ui {
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  font-feature-settings: "tnum" 1, "calt" 0;
  letter-spacing: 0;
}

/* Top nav — pill-shaped tabs (no border outline, accent fill on active). */
.ave-meeting-ui .top-nav {
  gap: 6px;
  padding: 10px 12px 8px;
  border-bottom: 1px solid var(--ave-border);
  background: var(--ave-bg);
}
.ave-meeting-ui .nav-btn {
  border: none;
  background: transparent;
  color: var(--ave-fg-muted);
  font-size: var(--ave-text-base, 14px);
  font-weight: 600;
  padding: 8px 14px;
  border-radius: 999px;
  transition: background .12s ease, color .12s ease, transform .12s ease;
}
.ave-meeting-ui .nav-btn:hover {
  background: var(--ave-secondary);
  color: var(--ave-fg);
}
.ave-meeting-ui .nav-btn.active {
  background: var(--ave-primary);
  color: var(--ave-primary-fg);
  border-color: transparent;
  box-shadow: 0 1px 3px color-mix(in srgb, var(--ave-primary) 25%, transparent);
}
.ave-meeting-ui .nav-btn.active:hover {
  background: var(--ave-ring);
  color: var(--ave-primary-fg);
}
.ave-meeting-ui .nav-btn svg { width: 15px; height: 15px; }

/* Session list cards — clearer elevation + hover lift. */
.ave-meeting-ui .session-list {
  gap: 12px;
  padding: 18px;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--ave-surface) 45%, transparent), transparent 180px),
    var(--ave-bg);
}
.ave-meeting-ui .session-list-shell {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--ave-surface) 45%, transparent), transparent 180px),
    var(--ave-bg);
}
.ave-meeting-ui .session-list-toolbar {
  flex: 0 0 auto;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  padding: 14px 18px 0;
}
.ave-meeting-ui .session-list-filter {
  min-width: 150px;
  max-width: 220px;
  border: 1px solid color-mix(in srgb, var(--ave-ring) 48%, var(--ave-border));
  border-radius: 999px;
  background: var(--ave-surface);
  color: var(--ave-primary);
  font-family: inherit;
  font-size: 12px;
  font-weight: 800;
  padding: 7px 10px;
  cursor: pointer;
}
.ave-meeting-ui .session-list-shell .session-list {
  background: transparent;
  padding-top: 12px;
}
.ave-meeting-ui .session-card {
  display: block;
  width: 100%;
  padding: 18px 20px;
  border-radius: 16px;
  border: 1px solid var(--ave-border);
  background: var(--ave-surface);
  color: var(--ave-fg);
  font-family: inherit;
  transition: background .12s ease, border-color .12s ease;
  text-align: left;
  cursor: pointer;
}
.ave-meeting-ui .session-card:hover {
  background: var(--ave-secondary);
  border-color: var(--ave-fg-muted);
}
.ave-meeting-ui .session-card:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ave-ring) 70%, transparent);
}
.ave-meeting-ui .session-card-title {
  font-size: 15px;
  font-weight: 800;
  line-height: 1.35;
  margin-bottom: 0;
  letter-spacing: -0.01em;
}
.ave-meeting-ui .session-card-meta {
  font-size: 12px;
  line-height: 1.45;
  color: var(--ave-fg-muted);
}
.ave-meeting-ui .session-card-category-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  min-width: 0;
}
.ave-meeting-ui .session-card-category {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 999px;
  background: var(--ave-primary-bg-subtle);
  border: 1px solid color-mix(in srgb, var(--ave-ring) 42%, transparent);
  color: var(--ave-primary);
  font-size: 12px;
  font-weight: 800;
}
.ave-meeting-ui .session-card-category-select {
  min-width: 124px;
  max-width: 180px;
  border: 1px solid color-mix(in srgb, var(--ave-ring) 48%, var(--ave-border));
  border-radius: 999px;
  background: var(--ave-surface);
  color: var(--ave-primary);
  font-family: inherit;
  font-size: 12px;
  font-weight: 800;
  padding: 5px 9px;
  cursor: pointer;
}
.ave-meeting-ui .session-card-head + .session-card-meta {
  margin-top: 4px;
}
.ave-meeting-ui .session-card-category-select:hover {
  background: var(--ave-primary-bg-subtle);
}
.ave-meeting-ui .session-card-stats {
  gap: 8px;
  margin-top: 14px;
  font-size: 12px;
  color: var(--ave-fg-muted);
}
.ave-meeting-ui .session-card-stats span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 999px;
  background: var(--ave-secondary);
  border: 1px solid var(--ave-border);
}
.ave-meeting-ui .session-card-transcript-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 14px;
  padding: 7px 11px;
  border-radius: 999px;
  border: 1px solid var(--ave-primary);
  background: transparent;
  color: var(--ave-primary);
  font-size: 12px;
  font-weight: 700;
  font-family: inherit;
  cursor: pointer;
  transition: background .12s, color .12s;
}
.ave-meeting-ui .session-card-transcript-link:hover {
  background: var(--ave-primary);
  color: var(--ave-primary-fg);
}

/* Empty state — single definition (consolidated from earlier draft). */
.ave-meeting-ui .empty {
  margin: auto;
  text-align: center;
  color: var(--ave-fg-muted);
  font-size: var(--ave-text-sm, 12px);
  padding: 48px 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.ave-meeting-ui .empty svg { width: 36px; height: 36px; opacity: 0.4; color: var(--ave-fg-muted); }
.ave-meeting-ui .empty b {
  display: block;
  color: var(--ave-fg-muted);
  font-weight: var(--ave-weight-semibold, 600);
  font-size: 13px;
  margin-bottom: 2px;
}
.ave-meeting-ui .empty-subtitle {
  display: block;
  font-size: 12px;
  color: var(--ave-fg-muted);
  margin-top: 4px;
  line-height: 1.4;
}

/* Pre-meeting — tighten title block, bump card elevation. */
.ave-meeting-ui .pre-meeting { padding: 22px 24px 26px; gap: 16px; }
.ave-meeting-ui .pre-meeting .pm-title {
  font-size: 22px;
  font-weight: 800;
  letter-spacing: 0;
  margin-top: 6px;
}
.ave-meeting-ui .pre-meeting .pm-subtitle { font-size: 13px; color: var(--ave-fg-muted); }
.ave-meeting-ui .pre-meeting .pm-chip {
  background: var(--ave-surface);
  border: 1px solid var(--ave-border);
  box-shadow: 0 1px 2px rgba(0, 0, 0, .02);
  padding: 7px 14px;
  font-size: 12.5px;
}
.ave-meeting-ui .pre-meeting .pm-card {
  border-radius: 16px;
  border: 1px solid var(--ave-border);
  box-shadow: 0 2px 8px rgba(0, 0, 0, .04);
  padding: 20px 22px;
}
.ave-meeting-ui .pre-meeting .pm-card-title {
  font-size: 13px;
  font-weight: 700;
  margin-bottom: 12px;
}
.ave-meeting-ui .pre-meeting .pm-section-title {
  font-size: 13px;
  font-weight: 700;
  margin-bottom: 10px;
  letter-spacing: 0;
}
/* Buttons — shadcn-style hierarchy.
   녹음(primary token) > 업로드(secondary surface) > Webex(tertiary brand). */
.ave-meeting-ui .pre-meeting .pm-btn {
  padding: 12px 14px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0;
  border: 1px solid transparent;
  box-shadow: none;
  transition: background .12s ease, border-color .12s ease, color .12s ease;
}
.ave-meeting-ui .pre-meeting .pm-btn:not(:disabled):hover {
  transform: none;
}

/* Primary — uses --accent (= ave-primary) so it picks up the chat-theme
   overlay (purple / blue / orange / lg-red). Hover darkens via --accent-active. */
.ave-meeting-ui .pre-meeting .pm-btn-primary {
  background: var(--ave-surface);
  color: var(--ave-fg);
  border-color: var(--ave-ring);
  box-shadow: none;
}
.ave-meeting-ui .pre-meeting .pm-btn-primary svg {
  color: var(--ave-ring) !important;
  stroke: var(--ave-ring) !important;
  fill: none !important;
  filter: none;
}
.ave-meeting-ui .pre-meeting .pm-btn-primary svg :where(path, line, polyline, polygon, rect, circle) {
  stroke: var(--ave-ring) !important;
}
.ave-meeting-ui .pre-meeting .pm-btn-primary:not(:disabled):hover {
  background: var(--ave-secondary);
  border-color: var(--ave-ring);
}

/* Secondary — surface fill with strong border. Theme-aware. */
.ave-meeting-ui .pre-meeting .pm-btn-dark {
  background: var(--ave-surface);
  color: var(--ave-fg);
  border-color: var(--ave-border);
}
.ave-meeting-ui .pre-meeting .pm-btn-dark svg {
  color: var(--ave-primary);
  stroke: currentColor;
}
.ave-meeting-ui .pre-meeting .pm-btn-dark:not(:disabled):hover {
  background: var(--ave-secondary);
}

/* Webex — Cisco brand green, intentionally fixed across themes since it's
   a brand affordance ("this is Webex"), not a UI surface. */
.ave-meeting-ui .pre-meeting .pm-btn-webex {
  background: var(--ave-primary);
  color: var(--ave-primary-fg);
  border-color: var(--ave-primary);
}
.ave-meeting-ui .pre-meeting .pm-btn-webex svg,
.ave-meeting-ui .pre-meeting .pm-btn-webex svg :where(path, line, polyline, polygon, rect, circle) {
  color: var(--ave-primary-fg) !important;
  stroke: var(--ave-primary-fg) !important;
  fill: none !important;
}
.ave-meeting-ui .pre-meeting .pm-btn-webex:not(:disabled):hover {
  background: var(--ave-ring);
  border-color: var(--ave-ring);
}
.ave-meeting-ui .pre-meeting .pm-actions { gap: 10px; margin-top: 18px; }
.ave-meeting-ui .pre-meeting .pm-agenda-num {
  background: var(--ave-primary);
  color: var(--ave-primary-fg);
  width: 24px;
  height: 24px;
  font-size: var(--ave-text-xs, 10px);
}
.ave-meeting-ui .pre-meeting .pm-agenda-item { gap: 12px; }
.ave-meeting-ui .pre-meeting .pm-webex {
  background: var(--ave-secondary);
  padding: 12px 14px;
  border-radius: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: var(--ave-text-xs, 10px);
  border: 1px solid var(--ave-border);
}
.ave-meeting-ui .pre-meeting .pm-description {
  border-radius: 10px;
  padding: 12px 14px;
  font-size: 13px;
}
.ave-meeting-ui .pre-meeting .pm-card-body,
.ave-meeting-ui .pre-meeting .pm-agenda-item {
  font-size: 13px;
}

/* Sub-tabs (session detail header) — pill style matching top nav. */
.ave-meeting-ui .sub-tabs {
  padding: 0;
  gap: 6px;
  border-bottom: none;
}
.ave-meeting-ui .sub-tab {
  border: none;
  background: transparent;
  padding: 6px 14px;
  border-radius: 999px;
  font-size: var(--ave-text-sm, 12px);
  font-weight: 600;
  color: var(--ave-fg-muted);
  transition: background .12s ease, color .12s ease;
}
.ave-meeting-ui .sub-tab:hover { background: var(--ave-secondary); color: var(--ave-fg); }
.ave-meeting-ui .sub-tab.active {
  background: var(--ave-primary-bg-subtle);
  color: var(--ave-primary);
  border: none;
  box-shadow: none;
}

/* Detail header: compact nav, metadata, and tabs in the top strip. */
.ave-meeting-ui .detail-header {
  padding: 8px 12px;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  row-gap: 6px;
}
.ave-meeting-ui .detail-title-stack {
  flex: 1 1 160px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.ave-meeting-ui .detail-title {
  font-size: 13px;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ave-meeting-ui .detail-time {
  font-size: 12px;
  line-height: 1.2;
}
.ave-meeting-ui .detail-meta-strip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 1 auto;
  min-width: 0;
  white-space: nowrap;
}
.ave-meeting-ui .detail-meta-chip {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 3px 8px;
  border: 1px solid var(--ave-border);
  border-radius: var(--ave-radius-full, 999px);
  background: var(--ave-surface);
  color: var(--ave-fg-muted);
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
}
.ave-meeting-ui .detail-meta-category {
  background: var(--ave-primary-bg-subtle);
  border-color: var(--ave-ring);
  color: var(--ave-primary);
}
.ave-meeting-ui .back-btn {
  border-radius: 8px;
  padding: 7px 12px;
  font-weight: 600;
  border: 1px solid var(--ave-border);
}
.ave-meeting-ui .back-btn:hover { background: var(--ave-secondary); border-color: var(--ave-border); }

.ave-meeting-ui .detail-body {
  padding: 18px;
  gap: 16px;
  align-items: center;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--ave-surface) 35%, transparent), transparent 220px),
    var(--ave-bg);
}
.ave-meeting-ui .detail-body > .summary,
.ave-meeting-ui .detail-body > .transcript-pane,
.ave-meeting-ui .detail-body > .intermediate-card {
  width: 100%;
  max-width: 760px;
}
.ave-meeting-ui .summary {
  margin-top: 0;
  padding: 22px 24px 24px;
  border-radius: 18px;
  background: var(--ave-surface);
  border: 1px solid var(--ave-border);
}
.ave-meeting-ui .summary-title {
  gap: 9px;
  font-size: 16px;
  line-height: 1.3;
  letter-spacing: -0.02em;
  margin-bottom: 14px;
  padding-bottom: 14px;
}
.ave-meeting-ui .summary-title svg {
  width: 18px;
  height: 18px;
}
.ave-meeting-ui .summary-body {
  font-size: 14px;
  line-height: 1.8;
}
.ave-meeting-ui .summary-section {
  margin-top: 22px;
}
.ave-meeting-ui .summary-section-label {
  gap: 7px;
  font-size: var(--ave-text-sm, 12px);
  letter-spacing: 0.06em;
  margin-bottom: 9px;
}
.ave-meeting-ui .summary-section-label svg {
  width: 14px;
  height: 14px;
}
.ave-meeting-ui .summary-list {
  gap: 8px;
}
.ave-meeting-ui .summary-item {
  gap: 9px;
  font-size: 14px;
  line-height: 1.65;
  padding: 10px 12px;
  border-radius: 10px;
  border-left-width: 3px;
}
.ave-meeting-ui .summary-toolbar {
  margin-bottom: 12px;
}
.ave-meeting-ui .summary-action-btn {
  padding: 7px 11px;
  border-radius: 999px;
  font-size: var(--ave-text-sm, 12px);
}
.ave-meeting-ui .related-meetings {
  width: 100%;
  max-width: 760px;
  margin-top: -4px;
  padding: 14px 16px;
  border-radius: 14px;
  border: 1px solid var(--ave-border);
  background: var(--ave-surface);
}
.ave-meeting-ui .related-meetings-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
  font-weight: 800;
  color: var(--ave-fg);
  margin-bottom: 10px;
}
.ave-meeting-ui .related-meetings-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.ave-meeting-ui .related-meeting-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--ave-secondary);
  border: 1px solid var(--ave-border);
}
.ave-meeting-ui .related-meeting-link {
  border: 0;
  background: transparent;
  padding: 0;
  text-align: left;
  color: var(--ave-primary);
  font-family: inherit;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}
.ave-meeting-ui .related-meeting-meta {
  margin-top: 2px;
  color: var(--ave-fg-muted);
  font-size: 12px;
}
.ave-meeting-ui .related-meeting-unlink {
  border: 1px solid var(--ave-border);
  background: var(--ave-surface);
  color: var(--ave-fg-muted);
  border-radius: 999px;
  padding: 5px 8px;
  font-family: inherit;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}
.ave-meeting-ui .related-meeting-unlink:hover {
  color: var(--ave-danger);
  border-color: color-mix(in srgb, var(--ave-danger) 35%, var(--ave-border));
}
.ave-meeting-ui .related-meetings-form {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  margin-top: 10px;
}
.ave-meeting-ui .related-meetings-select {
  min-width: 0;
  border: 1px solid var(--ave-border);
  border-radius: 9px;
  background: var(--ave-bg);
  color: var(--ave-fg);
  font-family: inherit;
  font-size: 12px;
  padding: 7px 9px;
}
.ave-meeting-ui .related-meetings-add {
  border: 1px solid var(--ave-primary);
  border-radius: 999px;
  background: transparent;
  color: var(--ave-primary);
  font-family: inherit;
  font-size: 12px;
  font-weight: 800;
  padding: 7px 11px;
  cursor: pointer;
}
.ave-meeting-ui .related-meetings-add:hover {
  background: var(--ave-primary);
  color: var(--ave-primary-fg);
}
.ave-meeting-ui .intermediate-card {
  border-radius: 14px;
  padding: 16px 18px;
}
.ave-meeting-ui .intermediate-card-summary,
.ave-meeting-ui .intermediate-card-highlight {
  font-size: 14px;
  line-height: 1.65;
}
.ave-meeting-ui .transcript-pane {
  gap: 12px;
}

/* Transcript bubbles — slightly softer. */
.ave-meeting-ui .bubble {
  border-radius: 12px;
  padding: 10px 12px;
  font-size: 14px;
  line-height: 1.65;
}
.ave-meeting-ui .segment { gap: 10px; }
.ave-meeting-ui .segment-meta {
  margin-bottom: 5px;
  font-size: 12px;
}
.ave-meeting-ui .avatar {
  width: 28px;
  height: 28px;
  font-size: 12px;
}

/* ─────────────────────────────────────────────────────── */
/* Theme alias layer removed — SOT cutover.                               */
/* Previously this block redefined --background / --foreground / etc.      */
/* under [data-shell="dark"], but it had no [data-shell="light"] mirror,   */
/* leaving consumers unresolvable on light theme. All call sites now read  */
/* var(--ave-*) directly; the host SDK applies the correct token values   */
/* per theme bundle on every host.theme.changed event. Plugin-internal     */
/* computed values (e.g. tinted hover surfaces) live under the --pm-*      */
/* prefix and stay scoped to this file.                                    */

/* ── Instant-record view (new) — minimal "no-prep" entry point.
   Reuses the .pm-* card visual language so it reads as a sibling
   surface to the prep screen rather than a one-off design. */
.ave-meeting-ui .instant-view {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  gap: 16px;
  padding: 28px 20px;
  overflow-y: auto;
}
.ave-meeting-ui .instant-card {
  width: 100%;
  max-width: 420px;
  background: var(--ave-surface);
  border: 1px solid var(--ave-border);
  border-radius: 14px;
  padding: 22px 22px 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.ave-meeting-ui .instant-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--ave-fg);
  margin: 0;
}
.ave-meeting-ui .instant-subtitle {
  font-size: 12px;
  color: var(--ave-fg-muted);
  margin: -8px 0 0;
}
.ave-meeting-ui .instant-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ave-meeting-ui .instant-field-label {
  font-size: var(--ave-text-xs, 10px);
  font-weight: 600;
  color: var(--ave-fg-muted);
  letter-spacing: 0.02em;
}
.ave-meeting-ui .instant-input {
  width: 100%;
  font-family: inherit;
  font-size: 14px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--ave-border);
  background: var(--ave-secondary);
  color: var(--ave-fg);
  outline: none;
}
.ave-meeting-ui .instant-input:focus { border-color: var(--ave-primary); }
.ave-meeting-ui select.instant-input {
  cursor: pointer;
}
.ave-meeting-ui .instant-record-btn {
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--ave-ring);
  background: var(--ave-surface);
  color: var(--ave-fg);
  font-size: 12.5px;
  font-weight: 700;
  cursor: pointer;
  font-family: inherit;
  transition: background .12s;
}
.ave-meeting-ui .instant-record-btn svg {
  width: 15px;
  height: 15px;
  color: var(--ave-ring) !important;
  stroke: var(--ave-ring) !important;
  fill: none !important;
  filter: none;
}
.ave-meeting-ui .instant-record-btn svg :where(path, line, polyline, polygon, rect, circle) {
  stroke: var(--ave-ring) !important;
}
.ave-meeting-ui .instant-record-btn:hover:not(:disabled) { background: var(--ave-secondary); border-color: var(--ave-ring); }
.ave-meeting-ui .instant-record-btn:disabled { opacity: .55; cursor: not-allowed; }
.ave-meeting-ui .instant-upload-btn {
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid var(--ave-border);
  background: transparent;
  color: var(--ave-fg);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  margin-top: 8px;
  transition: background .12s, border-color .12s;
}
.ave-meeting-ui .instant-upload-btn svg {
  width: 15px;
  height: 15px;
  color: var(--ave-primary);
  stroke: currentColor;
}
.ave-meeting-ui .instant-upload-btn:hover:not(:disabled) {
  background: var(--ave-surface-hover);
  border-color: var(--ave-fg-muted);
}
.ave-meeting-ui .instant-upload-btn:disabled { opacity: .55; cursor: not-allowed; }
/* Outlined-accent CTA for empty-state navigation entries (e.g. "녹음 시작"
   on the prep-empty card). Keeps the accent identity ("this leads to
   recording") while signalling secondary visual weight — the press routes
   to a setup screen, not an immediate record start, so a primary green
   surface would over-promise the action. */
.ave-meeting-ui .pm-card-cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid var(--ave-primary);
  background: transparent;
  color: var(--ave-primary);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  transition: background .12s, color .12s;
}
.ave-meeting-ui .pm-card-cta svg {
  width: 15px;
  height: 15px;
  /* White/outlined CTA: line icons need the SDK highlight colour directly. */
  color: var(--ave-primary);
  stroke: currentColor;
}
.ave-meeting-ui .pm-card-cta:hover svg {
  color: var(--ave-primary-fg);
}
.ave-meeting-ui .pm-card-cta:hover { background: var(--ave-primary); color: var(--ave-primary-fg); }
.ave-meeting-ui .pm-card-cta:focus-visible {
  /* Designer A: match the global shadcn double-ring (line 1716) so all
     buttons share one focus affordance family. The raw outline form
     produced a visually thinner ring out of sync with peers. */
  outline: none;
  box-shadow:
    0 0 0 2px var(--ave-bg),
    0 0 0 4px color-mix(in srgb, var(--ave-ring) 62%, transparent);
}
.ave-meeting-ui .pm-card-actions { margin-top: 16px; display: flex; justify-content: center; }
.ave-meeting-ui .instant-back-row { padding: 12px 16px 0; display: flex; align-items: center; }
.ave-meeting-ui .instant-settings-btn {
  margin-left: auto;
  margin-right: -8px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: var(--ave-radius-sm, 6px);
  border: none;
  background: transparent;
  color: var(--ave-fg-muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background var(--ave-motion-fast, 160ms);
}
.ave-meeting-ui .instant-settings-btn:hover {
  background: var(--ave-surface-hover);
  color: var(--ave-fg);
}
.ave-meeting-ui .instant-settings-btn:focus-visible {
  outline: none;
  box-shadow:
    0 0 0 2px var(--ave-bg),
    0 0 0 4px color-mix(in srgb, var(--ave-ring) 70%, transparent);
}
/* shadcn ghost-button back: text + chevron icon, no border, hover bg, focus ring.
   margin-left -8px aligns the visible text baseline with the card interior edge
   (instant-back-row padding 16px – margin 8px = 8px effective inset from window). */
.ave-meeting-ui .instant-back-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px 6px 8px;
  margin-left: -8px;
  border-radius: var(--ave-radius-sm, 6px);
  border: none;
  background: transparent;
  color: var(--ave-fg-muted);
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: background .12s, color .12s;
  -webkit-app-region: no-drag;
}
.ave-meeting-ui .instant-back-btn:hover {
  background: var(--ave-surface-hover);
  color: var(--ave-fg);
}
.ave-meeting-ui .instant-back-btn:active {
  background: color-mix(in srgb, var(--ave-fg) 12%, var(--ave-secondary));
}
.ave-meeting-ui .instant-back-btn:focus-visible {
  /* Match the global shadcn double-ring (line ~1768) used by every other
     interactive element in the plugin — 2px bg-offset + 4px color-mix. */
  outline: none;
  box-shadow:
    0 0 0 2px var(--ave-bg),
    0 0 0 4px color-mix(in srgb, var(--ave-ring) 62%, transparent);
}
.ave-meeting-ui .instant-back-btn svg { width: 16px; height: 16px; flex-shrink: 0; }
.ave-meeting-ui .instant-upload-hint {
  font-size: var(--ave-text-xs, 10px);
  color: var(--ave-fg-muted);
  text-align: center;
  margin-top: 4px;
}
.ave-meeting-ui .instant-status {
  font-size: var(--ave-text-sm, 12px);
  color: var(--ave-fg-muted);
  text-align: center;
  min-height: 16px;
}
.ave-meeting-ui .instant-status.error { color: var(--ave-danger); }

/* Length-tier radio group — shared between prep card and instant view. */
.ave-meeting-ui .length-tier {
  display: flex;
  gap: 4px;
  padding: 3px;
  background: var(--ave-secondary);
  border-radius: 999px;
  border: 1px solid var(--ave-border);
  flex-wrap: wrap;
}
.ave-meeting-ui .length-tier-opt {
  flex: 1 1 0;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--ave-fg-muted);
  font-family: inherit;
  font-size: var(--ave-text-xs, 10px);
  font-weight: 600;
  padding: 6px 8px;
  border-radius: 999px;
  cursor: pointer;
  transition: background .12s, color .12s;
  white-space: nowrap;
}
.ave-meeting-ui .length-tier-opt:hover { color: var(--ave-fg); }
.ave-meeting-ui .length-tier-opt.active {
  background: var(--ave-primary);
  color: var(--ave-primary-fg);
}

/* shadcn interaction layer: selected state and focus rings are visible on
   every themed surface, including beige/light host bundles. */
.ave-meeting-ui :where(button, input, textarea, select):focus {
  outline: none;
}
.ave-meeting-ui :where(button, input, textarea, select):focus-visible {
  outline: none;
  box-shadow:
    0 0 0 2px var(--ave-bg),
    0 0 0 4px color-mix(in srgb, var(--ave-ring) 62%, transparent);
}
.ave-meeting-ui .nav-btn,
.ave-meeting-ui .sub-tab,
.ave-meeting-ui .length-tier-opt,
.ave-meeting-ui .summary-regen-tier {
  border-radius: var(--ave-radius-full, 999px);
  position: relative;
  z-index: 1;
  transform: translateZ(0);
  transition:
    background var(--ave-motion-fast, 160ms) ease,
    border-color var(--ave-motion-fast, 160ms) ease,
    color var(--ave-motion-fast, 160ms) ease,
    box-shadow var(--ave-motion-fast, 160ms) ease,
    transform var(--ave-motion-fast, 160ms) ease;
}
.ave-meeting-ui .nav-btn:hover:not([data-state="active"]),
.ave-meeting-ui .sub-tab:hover:not([data-state="active"]),
.ave-meeting-ui .length-tier-opt:hover:not([data-state="active"]),
.ave-meeting-ui .summary-regen-tier:hover:not(:disabled) {
  background: var(--pm-toggle-hover-bg);
  border-color: color-mix(in srgb, var(--ave-ring) 34%, var(--ave-border));
  color: var(--ave-fg);
  box-shadow: var(--pm-toggle-hover-shadow);
  transform: translateY(-1px);
}
.ave-meeting-ui .nav-btn.active,
.ave-meeting-ui .nav-btn[data-state="active"],
.ave-meeting-ui .sub-tab.active,
.ave-meeting-ui .sub-tab[data-state="active"],
.ave-meeting-ui .length-tier-opt.active,
.ave-meeting-ui .length-tier-opt[data-state="active"] {
  background: var(--ave-primary);
  color: var(--ave-primary-fg);
  border-color: var(--ave-primary);
  box-shadow: var(--pm-toggle-selected-shadow);
}
.ave-meeting-ui .nav-btn.active:hover,
.ave-meeting-ui .nav-btn[data-state="active"]:hover,
.ave-meeting-ui .sub-tab.active:hover,
.ave-meeting-ui .sub-tab[data-state="active"]:hover,
.ave-meeting-ui .length-tier-opt.active:hover,
.ave-meeting-ui .length-tier-opt[data-state="active"]:hover {
  background: var(--ave-ring);
  color: var(--ave-primary-fg);
  transform: translateY(-1px);
}
.ave-meeting-ui .nav-btn:active,
.ave-meeting-ui .sub-tab:active,
.ave-meeting-ui .length-tier-opt:active,
.ave-meeting-ui .summary-regen-tier:active {
  transform: translateY(0) scale(.98);
}
.ave-meeting-ui .length-tier {
  border-color: var(--ave-border);
  background: var(--ave-secondary);
  isolation: isolate;
}
.ave-meeting-ui .top-nav,
.ave-meeting-ui .sub-tabs,
.ave-meeting-ui .summary-regen-tiers {
  isolation: isolate;
}
.ave-meeting-ui .detail .sub-tabs {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 4px;
  padding: 0;
  border-bottom: none;
  background: transparent;
}
.ave-meeting-ui .detail .sub-tab {
  flex: 0 0 auto;
  min-height: 26px;
  padding: 4px 10px;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
}
.ave-meeting-ui .instant-input:focus-visible,
.ave-meeting-ui .summary-edit-input:focus-visible,
.ave-meeting-ui .summary-edit-textarea:focus-visible,
.ave-meeting-ui .summary-edit-row-input:focus-visible,
.ave-meeting-ui .prompt-overlay-textarea:focus-visible {
  border-color: var(--ave-ring);
}
.ave-meeting-ui .pre-meeting .pm-title,
.ave-meeting-ui .pre-meeting .pm-btn {
  letter-spacing: 0;
}

/* Compact type pass: keep the meeting plugin readable without feeling zoomed-in. */
.ave-meeting-ui :where(button, input, textarea, select) {
  font-size: 12.5px;
}
.ave-meeting-ui :where(
  .summary-body,
  .summary-item,
  .bubble,
  .intermediate-card-summary,
  .intermediate-card-highlight,
  .pm-card-body,
  .pm-agenda-item,
  .pm-description
) {
  font-size: 12.5px;
}
.ave-meeting-ui :where(
  .nav-btn,
  .sub-tab,
  .session-card-meta,
  .session-card-transcript-link,
  .pm-chip,
  .pm-btn,
  .instant-input,
  .instant-record-btn,
  .instant-upload-btn,
  .pm-card-cta
) {
  font-size: 12px;
}
.ave-meeting-ui :where(
  .detail-time,
  .segment-meta,
  .session-card-stats,
  .pm-nav-count,
  .pm-status,
  .empty-subtitle
) {
  font-size: 12px;
}
.ave-meeting-ui .pre-meeting .pm-title { font-size: 22px; }
.ave-meeting-ui .detail-title,
.ave-meeting-ui .summary-title { font-size: 16px; }

/* Reduced motion is authoritative: collapse every animation/transition to
   near-zero so state changes still register (no flash-of-nothing) without
   the motion itself. Covers the pm-fade-out keyframe, the session-card and
   button transitions, and any future addition scoped under .ave-meeting-ui. */
@media (prefers-reduced-motion: reduce) {
  .ave-meeting-ui *,
  .ave-meeting-ui *::before,
  .ave-meeting-ui *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
`;

const STATUS_STATES = {
  idle: "대기 중",
  recording: "청취 중",
  analyzing: "분석 중",
  done: "완료",
  error: "오류",
};

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0초";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}초`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (s === 0) return `${m}분`;
  return `${m}분 ${s}초`;
}

const KST_FMT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function fmtDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return KST_FMT.format(d);
}

function speakerInitials(name) {
  if (!name) return "?";
  const s = String(name).trim();
  if (!s) return "?";
  const words = s.split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return Array.from(s)[0].toUpperCase();
}

// Parse a trusted SVG icon string into a live <svg> node without using raw
// innerHTML writes. CWE-79 policy bans innerHTML in this file (transcriptXss
// regression test enforces this).
function svgNodeFromIcon(iconStr, toneToken) {
  const parsed = new DOMParser().parseFromString(iconStr, "image/svg+xml");
  const svg = parsed.documentElement;
  if (typeof toneToken === "string" && toneToken.startsWith("--ave-")) {
    const tokenValue = `var(${toneToken})`;
    svg.setAttribute("style", `color: ${tokenValue}; stroke: ${tokenValue}; fill: none;`);
    svg.setAttribute("stroke", tokenValue);
    svg.setAttribute("fill", "none");
    svg.querySelectorAll("path,line,polyline,polygon,rect,circle").forEach((node) => {
      node.setAttribute("style", `stroke: ${tokenValue};`);
      node.setAttribute("stroke", tokenValue);
      if (node.getAttribute("fill") !== "currentColor") return;
      node.setAttribute("style", `stroke: ${tokenValue}; fill: ${tokenValue};`);
      node.setAttribute("fill", tokenValue);
    });
  }
  return svg;
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "style") e.style.cssText = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

function showToast(msg, variant = "error") {
  const klass = variant === "success" ? "toast-success" : "toast-error";
  const existing = document.querySelectorAll(".toast-error, .toast-success").length;
  const t = el("div", {
    class: klass,
    role: variant === "success" ? "status" : "alert",
    style: `bottom: ${16 + existing * 56}px;`,
  }, msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3100);
}

function showErrorToast(msg) {
  showToast(msg, "error");
}

function showSuccessToast(msg) {
  showToast(msg, "success");
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(ta);
  if (!ok) throw new Error("clipboard copy failed");
}

function formatListSection(label, items) {
  if (!Array.isArray(items) || items.length === 0) return "";
  return [
    label,
    ...items.map((item) => `- ${String(item).trim()}`),
  ].join("\n");
}

function formatMeetingMinutesForClipboard(finalSummary, fallbackTitle, meta = {}) {
  const title = String(finalSummary?.title || fallbackTitle || "회의록").trim();
  const createdAt = meta.createdAt ? fmtDateTime(meta.createdAt) : "";
  const participants = Array.isArray(meta.participants)
    ? meta.participants.map((x) => String(x).trim()).filter(Boolean)
    : [];
  const summary = String(finalSummary?.summary || "").trim();
  const highlights = Array.isArray(finalSummary?.highlights) ? finalSummary.highlights : [];
  const actionItems = Array.isArray(finalSummary?.actionItems) ? finalSummary.actionItems : [];
  const lines = [
    title || "회의록",
    createdAt ? `일시: ${createdAt}` : "",
    participants.length > 0 ? `참석자: ${participants.join(", ")}` : "",
    "",
    "요약",
    summary || "-",
  ];

  const highlightSection = formatListSection("핵심 포인트", highlights);
  if (highlightSection) lines.push("", highlightSection);

  const actionSection = formatListSection("액션 아이템", actionItems);
  if (actionSection) lines.push("", actionSection);

  return lines.filter((line, idx, arr) => {
    if (line !== "") return true;
    return idx > 0 && idx < arr.length - 1 && arr[idx - 1] !== "";
  }).join("\n").trim();
}

function avatarClassFor(name, cache) {
  if (!name) return "a0";
  if (cache.has(name)) return cache.get(name);
  const klass = `a${cache.size % 5}`;
  cache.set(name, klass);
  return klass;
}

// `autoscroll` default true preserves the live-recorder's tail behaviour.
// Bulk renders (e.g. session-detail transcript sub-tab) should pass false
// so a long transcript doesn't trigger a layout/reflow per segment during
// the initial paint (PR #38 Copilot review L754).
function renderSegmentInto({
  parent,
  key,
  original,
  speaker,
  startSec,
  streaming,
  speakerColourCache,
  autoscroll = true,
}) {
  let seg = null;
  if (key !== undefined && key !== null) {
    seg = parent.querySelector(`.segment[data-key="${CSS.escape(String(key))}"]`);
  }
  if (seg) {
    if (streaming) seg.setAttribute("data-streaming", "1");
    else seg.removeAttribute("data-streaming");
    const bubble = seg.querySelector(".bubble");
    if (bubble) bubble.textContent = original ?? "";
    const spk = seg.querySelector(".segment-speaker");
    if (spk && speaker) spk.textContent = speaker;
    const tm = seg.querySelector(".segment-time");
    if (tm && Number.isFinite(startSec)) tm.textContent = fmtTime(startSec);
    if (autoscroll) parent.scrollTop = parent.scrollHeight;
    return seg;
  }

  seg = document.createElement("div");
  seg.className = "segment";
  if (key !== undefined && key !== null) seg.setAttribute("data-key", String(key));
  if (streaming) seg.setAttribute("data-streaming", "1");

  const klass = speakerColourCache ? avatarClassFor(speaker, speakerColourCache) : "a0";
  const avatar = document.createElement("div");
  avatar.className = `avatar ${klass}`;
  avatar.textContent = speaker ? speakerInitials(speaker) : "?";
  seg.appendChild(avatar);

  const body = document.createElement("div");
  body.className = "segment-body";
  const meta = document.createElement("div");
  meta.className = "segment-meta";
  const spk = document.createElement("span");
  spk.className = "segment-speaker";
  spk.textContent = speaker || "화자";
  meta.appendChild(spk);
  const tm = document.createElement("span");
  tm.className = "segment-time";
  tm.textContent = fmtTime(startSec ?? 0);
  meta.appendChild(tm);
  body.appendChild(meta);

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = original ?? "";
  body.appendChild(bubble);

  seg.appendChild(body);
  parent.appendChild(seg);
  if (autoscroll) parent.scrollTop = parent.scrollHeight;
  return seg;
}

/**
 * Coalesce consecutive transcript segments by same speaker into a single
 * "thought" bubble for display. Whisper batch STT emits micro-segments
 * (1–3s each, often mid-sentence) which read as choppy when one bubble
 * per segment is rendered. Joining within a small gap window restores
 * sentence-level readability without touching persisted storage.
 *
 * Diarization-aware: when the transcript only contains a single distinct
 * speaker label (= the configured STT model didn't return per-speaker
 * tags, or the user is on the non-diarize default `gpt-4o-transcribe`),
 * we DO NOT merge — collapsing every segment into one giant bubble
 * would hide the natural sentence breaks Whisper already produced and
 * make a multi-person conversation read as one monologue. Diarization
 * presence is detected by counting distinct speaker labels in the full
 * transcript.
 *
 * Threshold tuning notes:
 *   - GAP_SEC=2.0 keeps natural sentence pauses together but breaks
 *     when the speaker actually changes thoughts (>2s silence).
 *   - Speaker boundary always wins — diarized two-party dialogue stays
 *     as visually distinct bubbles even when interleaved closely.
 */
// Module-level mutable so a runtime config fetch on mount can adjust
// it without rewriting the function. Default mirrors the configSchema
// `transcriptBubbleMaxChars` default (320 chars ≈ 3-5 Korean sentences).
let transcriptBubbleMaxChars = 320;
let customSummaryFinalPrompt = "";
let customSummaryIntermediatePrompt = "";
let summaryPromptPreviewTier = "medium";
const DEFAULT_SESSION_CATEGORY = "일반";
const CATEGORY_CREATE_VALUE = "__create_category__";
const SESSION_CATEGORY_OPTIONS = [
  DEFAULT_SESSION_CATEGORY,
  "프로젝트",
  "정기회의",
  "1:1",
  "고객/외부",
  "의사결정",
  "회고",
];

function normalizeSummaryLengthTier(raw) {
  return raw === "short" || raw === "long" ? raw : "medium";
}

function normalizeSessionCategoryForUi(raw) {
  if (typeof raw !== "string") return DEFAULT_SESSION_CATEGORY;
  const category = raw.trim().replace(/\s+/g, " ").slice(0, 40);
  return category || DEFAULT_SESSION_CATEGORY;
}

function uniqueSessionCategoriesForUi(rawOptions) {
  const source = Array.isArray(rawOptions) && rawOptions.length > 0
    ? rawOptions
    : SESSION_CATEGORY_OPTIONS;
  return source
    .map(normalizeSessionCategoryForUi)
    .filter((category, index, arr) => arr.indexOf(category) === index);
}

function populateCategorySelect(select, rawOptions, selectedValue, opts = {}) {
  const selected = selectedValue ? normalizeSessionCategoryForUi(selectedValue) : "";
  const options = uniqueSessionCategoriesForUi(rawOptions);
  select.replaceChildren();
  if (opts.placeholder) {
    const placeholder = el("option", { value: "" }, opts.placeholder);
    placeholder.disabled = Boolean(opts.requiredPlaceholder);
    placeholder.selected = !selected;
    select.appendChild(placeholder);
  }
  if (opts.allLabel) {
    const all = el("option", { value: "__all__" }, opts.allLabel);
    all.selected = selectedValue === "__all__" || !selectedValue;
    select.appendChild(all);
  }
  for (const optionValue of options) {
    const opt = el("option", { value: optionValue }, optionValue);
    if (optionValue === selected) opt.selected = true;
    select.appendChild(opt);
  }
  if (opts.allowCreate) {
    const createOpt = el("option", { value: CATEGORY_CREATE_VALUE }, "+ 새 카테고리 추가...");
    select.appendChild(createOpt);
  }
}

function getBuiltInPromptDefaults() {
  return {
    finalPrompt: buildFinalSystem(summaryPromptPreviewTier),
    intermediatePrompt: INTERMEDIATE_SYSTEM,
  };
}

function toPersistedPromptValue(rawValue, builtInValue) {
  const sanitized = sanitizeCustomPrompt(rawValue);
  return sanitized === sanitizeCustomPrompt(builtInValue) ? "" : sanitized;
}

async function refreshPromptConfigFromBridge(bridge) {
  if (!bridge?.config || typeof bridge.config.get !== "function") {
    throw new Error("프롬프트 설정 bridge가 없습니다.");
  }
  const [finalPrompt, intermediatePrompt, summaryLengthTier] = await Promise.all([
    bridge.config.get("customSummaryFinalPrompt"),
    bridge.config.get("customSummaryIntermediatePrompt"),
    bridge.config.get("summaryLengthTier"),
  ]);
  customSummaryFinalPrompt = typeof finalPrompt === "string" ? finalPrompt : "";
  customSummaryIntermediatePrompt = typeof intermediatePrompt === "string" ? intermediatePrompt : "";
  summaryPromptPreviewTier = normalizeSummaryLengthTier(summaryLengthTier);
}

async function persistPromptConfigWithBridge(bridge, finalPrompt, intermediatePrompt) {
  if (!bridge?.config || typeof bridge.config.set !== "function") {
    throw new Error("프롬프트 설정 bridge가 없습니다.");
  }
  const defaults = getBuiltInPromptDefaults();
  const nextFinal = toPersistedPromptValue(finalPrompt, defaults.finalPrompt);
  const nextIntermediate = toPersistedPromptValue(intermediatePrompt, defaults.intermediatePrompt);
  await bridge.config.set("customSummaryFinalPrompt", nextFinal);
  await bridge.config.set("customSummaryIntermediatePrompt", nextIntermediate);
  customSummaryFinalPrompt = nextFinal;
  customSummaryIntermediatePrompt = nextIntermediate;
  return { nextFinal, nextIntermediate };
}

function openPromptEditOverlay(anchorNode, bridge) {
  const scope = anchorNode?.closest?.(".ave-meeting-ui");
  if (!scope) return;
  if (scope.querySelector(".prompt-overlay")) return;

  const overlay = el("div", { class: "prompt-overlay" });
  const cardEl = el("div", { class: "prompt-overlay-card" });
  overlay.appendChild(cardEl);

  const header = el("div", { class: "prompt-overlay-header" });
  const titleEl = el("div", { class: "prompt-overlay-title" });
  titleEl.textContent = "회의록 프롬프트 편집";
  const closeBtn = el("button", { type: "button", class: "prompt-overlay-close", "aria-label": "닫기" });
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => overlay.remove());
  header.appendChild(titleEl);
  header.appendChild(closeBtn);
  cardEl.appendChild(header);

  const note = el("div", { class: "prompt-overlay-note" });
  note.textContent = `프롬프트는 모든 회의에 공통 적용됩니다. 저장 즉시 다음 회의록 생성부터 적용되며 ${CUSTOM_PROMPT_MAX_BYTES} bytes로 제한됩니다.`;
  cardEl.appendChild(note);
  note.textContent = `프롬프트는 모든 회의에 공통 적용됩니다. 기본 프롬프트를 미리 채워 보여주며, 그대로 저장하면 내장 기본값을 계속 사용합니다. 저장 즉시 다음 회의록 생성부터 적용되며 ${CUSTOM_PROMPT_MAX_BYTES} bytes로 제한됩니다.`;

  const body = el("div", { class: "prompt-overlay-body" });
  cardEl.appendChild(body);

  const mkField = (labelText, placeholder, getResetValue) => {
    const label = el("div", { class: "prompt-overlay-field-label" });
    const labelSpan = document.createElement("span");
    labelSpan.textContent = labelText;
    const reset = el("button", { type: "button", class: "prompt-overlay-field-reset" });
    reset.textContent = "기본값으로";
    label.appendChild(labelSpan);
    label.appendChild(reset);
    const area = document.createElement("textarea");
    area.className = "prompt-overlay-textarea";
    area.placeholder = placeholder;
    area.maxLength = 16000;
    reset.addEventListener("click", () => {
      area.value = typeof getResetValue === "function"
        ? getResetValue()
        : (area.dataset.resetTo ?? "");
      area.focus();
    });
    body.appendChild(label);
    body.appendChild(area);
    return area;
  };

  const finalArea = mkField(
    "최종 회의록 프롬프트",
    "비워두면 내장 기본 프롬프트 사용 (한국어 회의 최적화 + 길이 tier 자동 반영)",
  );
  const intermediateArea = mkField(
    "중간 요약 프롬프트",
    "비워두면 내장 기본 프롬프트 사용",
  );

  finalArea.placeholder = "기본 프롬프트를 불러오는 중입니다.";
  intermediateArea.placeholder = "기본 프롬프트를 불러오는 중입니다.";
  const finalHint = el("div", { class: "prompt-overlay-note" });
  finalHint.textContent = "최종 프롬프트는 현재 기본 길이 설정 기준의 내장 프롬프트를 미리 보여줍니다. 수정해서 저장하면 이후에는 그 문구가 그대로 사용됩니다.";
  body.appendChild(finalHint);

  const footer = el("div", { class: "prompt-overlay-footer" });
  const cancelBtn = el("button", { type: "button", class: "prompt-overlay-cancel" });
  cancelBtn.textContent = "취소";
  cancelBtn.addEventListener("click", () => overlay.remove());
  const saveBtn = el("button", { type: "button", class: "prompt-overlay-save" });
  saveBtn.textContent = "저장";
  saveBtn.disabled = true;
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);
  cardEl.appendChild(footer);

  const setBusy = (text) => {
    let busy = cardEl.querySelector(".prompt-overlay-busy");
    if (!text) {
      busy?.remove();
      return null;
    }
    if (!busy) {
      busy = el("div", { class: "prompt-overlay-busy" });
      cardEl.appendChild(busy);
    }
    busy.textContent = text;
    return busy;
  };

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    setBusy("저장 중…");
    try {
      const { nextFinal, nextIntermediate } = await persistPromptConfigWithBridge(
        bridge,
        finalArea.value,
        intermediateArea.value,
      );
      finalArea.value = nextFinal;
      intermediateArea.value = nextIntermediate;
      overlay.remove();
    } catch (err) {
      setBusy(null);
      saveBtn.disabled = false;
      cancelBtn.disabled = false;
      showErrorToast(`저장 실패: ${(err?.message ?? err).toString().slice(0, 200)}`);
    }
  });

  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) overlay.remove();
  });
  scope.appendChild(overlay);

  setBusy("설정 불러오는 중…");
  refreshPromptConfigFromBridge(bridge)
    .then(() => {
      const defaults = getBuiltInPromptDefaults();
      finalArea.value = customSummaryFinalPrompt || defaults.finalPrompt;
      intermediateArea.value = customSummaryIntermediatePrompt || defaults.intermediatePrompt;
      finalArea.dataset.resetTo = defaults.finalPrompt;
      intermediateArea.dataset.resetTo = defaults.intermediatePrompt;
      setBusy(null);
      saveBtn.disabled = false;
      finalArea.focus();
    })
    .catch((err) => {
      setBusy(null);
      showErrorToast(`설정 불러오기 실패: ${(err?.message ?? err).toString().slice(0, 200)}`);
      overlay.remove();
    });
}

/**
 * Strip Whisper's chunk-boundary "..." / "…" artifacts. STT runs on
 * 3-second slices independently, so words spanning a chunk boundary
 * end up as e.g. "...회의를 시..." in chunk N and "...작하기 전에..."
 * in chunk N+1 — which displays as "실..." style truncation. We trim
 * those markers when rendering. Genuine mid-sentence pauses also lose
 * their "..." indicator, but legibility wins by a wide margin.
 *
 * Trailing/leading whitespace also stripped so the join doesn't yield
 * doubled spaces.
 */
function cleanTranscriptText(raw) {
  if (typeof raw !== "string") return "";
  // Only strip ELLIPSIS markers (3+ dots or unicode "…"), not single
  // periods — a normal sentence ending in "." should keep that period.
  // Run leading + trailing strip iteratively to remove combinations
  // like "  ...  " safely.
  let t = raw;
  for (;;) {
    const before = t;
    t = t.replace(/^\s+|\s+$/gu, "")
         .replace(/^(?:\.{3,}|…+)/u, "")
         .replace(/(?:\.{3,}|…+)$/u, "");
    if (t === before) break;
  }
  return t.replace(/\s+/gu, " ").trim();
}

function findSplitBoundary(text, preferredStart, preferredEnd, matcher) {
  const end = Math.min(text.length, preferredEnd);
  const start = Math.max(1, preferredStart);
  for (let i = end; i >= start; i--) {
    if (matcher.test(text[i - 1] ?? "")) return i;
  }
  return -1;
}

function pickSplitBoundary(text, preferredStart, preferredEnd, matchers) {
  for (const matcher of matchers) {
    const cut = findSplitBoundary(text, preferredStart, preferredEnd, matcher);
    if (cut > 0) return cut;
  }
  return -1;
}

function splitLongBubbleText(text, maxChars) {
  const cleaned = cleanTranscriptText(text);
  if (!cleaned) return [];
  const splitThreshold = Math.round(maxChars * 1.25);
  if (cleaned.length <= splitThreshold) return [cleaned];

  const minChunkChars = Math.max(120, Math.floor(maxChars * 0.55));
  const preferredMaxChars = Math.max(minChunkChars + 40, maxChars);
  const hardMaxChars = Math.max(preferredMaxChars + 80, Math.round(maxChars * 1.6));
  const sentencePunc = /[.!?。？！…]/u;
  const clausePunc = /[,;:，、]/u;
  const whitespace = /\s/u;
  const out = [];
  let remaining = cleaned;

  while (remaining.length > 0) {
    if (remaining.length <= splitThreshold) {
      out.push(remaining);
      break;
    }

    let cut = pickSplitBoundary(
      remaining,
      minChunkChars,
      preferredMaxChars,
      [sentencePunc, clausePunc, whitespace],
    );

    if (cut <= 0) {
      cut = pickSplitBoundary(
        remaining,
        preferredMaxChars,
        hardMaxChars,
        [sentencePunc, clausePunc, whitespace],
      );
    }
    if (cut <= 0) cut = Math.min(remaining.length, hardMaxChars);

    const piece = cleanTranscriptText(remaining.slice(0, cut));
    if (piece.length === 0) break;
    out.push(piece);
    remaining = cleanTranscriptText(remaining.slice(cut));
  }

  return out.length > 0 ? out : [cleaned];
}

function splitDisplayGroupIfNeeded(group, maxChars) {
  const pieces = splitLongBubbleText(group.text, maxChars);
  if (pieces.length <= 1) return [group];

  const totalDuration = Math.max(0, (group.endSec ?? group.startSec ?? 0) - (group.startSec ?? 0));
  const totalChars = pieces.reduce((sum, piece) => sum + piece.length, 0) || 1;
  let elapsed = group.startSec ?? 0;

  return pieces.map((piece, idx) => {
    const duration = totalDuration * (piece.length / totalChars);
    const startSec = elapsed;
    const endSec = idx === pieces.length - 1 ? (group.endSec ?? startSec) : startSec + duration;
    elapsed = endSec;
    return {
      speaker: group.speaker,
      startSec,
      endSec,
      text: piece,
    };
  });
}

function groupTranscriptForDisplay(segments) {
  const distinctSpeakers = new Set();
  for (const s of segments) {
    const sp = (s?.speaker ?? "").trim();
    if (sp) distinctSpeakers.add(sp);
  }
  const hasDiarization = distinctSpeakers.size >= 2;

  // GAP threshold scales with diarization signal:
  //   - Multi-speaker: 2.0s — speaker change is the natural break, so we
  //     can be tighter on time.
  //   - Single-speaker: 6.0s — without speaker tags, only real silence
  //     justifies a break. Whisper's batch slicing produces ~0s gaps
  //     between adjacent segments mid-sentence, so a tight threshold
  //     would leave every micro-segment alone.
  const GAP_SEC = hasDiarization ? 2.0 : 6.0;
  // Soft length cap — only break trigger besides speaker/gap. Korean
  // STT typically yields complete utterances per ~3s segment, so a
  // sentence-end heuristic ends up matching almost every segment and
  // collapses grouping back to one-bubble-per-segment. We rely on
  // length alone instead: bubbles grow until they're paragraph-sized,
  // then a new one starts.
  const MAX_BUBBLE_CHARS = transcriptBubbleMaxChars;

  const groups = [];
  for (const s of segments) {
    // Strip chunk-boundary ellipsis artifacts before deciding bubble
    // boundaries — keeps trailing/leading "..." from polluting the
    // merged text and avoids "실..." style mid-word fragments.
    const text = cleanTranscriptText(s.original ?? s.text ?? "");
    if (!text) continue;
    const last = groups[groups.length - 1];
    const sameSpeaker = last && (s.speaker ?? "") === (last.speaker ?? "");
    const closeEnough = last && Number.isFinite(s.startSec) && Number.isFinite(last.endSec)
      && (s.startSec - last.endSec) <= GAP_SEC;
    const lengthOk = last && last.text.length < MAX_BUBBLE_CHARS;

    if (last && sameSpeaker && closeEnough && lengthOk) {
      last.text = cleanTranscriptText(`${last.text} ${text}`);
      if (Number.isFinite(s.endSec)) last.endSec = s.endSec;
      continue;
    }
    groups.push({
      speaker: s.speaker || "화자",
      startSec: Number.isFinite(s.startSec) ? s.startSec : 0,
      endSec: Number.isFinite(s.endSec) ? s.endSec : (Number.isFinite(s.startSec) ? s.startSec : 0),
      text,
    });
  }
  return groups.flatMap((group) => splitDisplayGroupIfNeeded(group, MAX_BUBBLE_CHARS));
}

function normalizeIntermediateEntry(entry) {
  const wrappedData = entry && typeof entry === "object" && entry.data && typeof entry.data === "object"
    ? entry.data
    : null;
  const data = wrappedData ?? (entry && typeof entry === "object" ? entry : {});
  const highlights = Array.isArray(data.highlights)
    ? data.highlights.filter((h) => typeof h === "string" && h.trim()).map((h) => h.trim())
    : [];
  const coveredFromEntry = Number.isFinite(entry?.coveredSegmentCount)
    ? entry.coveredSegmentCount
    : null;
  const coveredFromIds = Array.isArray(data.coveredSegmentIds)
    ? data.coveredSegmentIds.length
    : null;
  return {
    summary: typeof data.summary === "string" ? data.summary.trim() : "",
    highlights,
    coveredSegmentCount: coveredFromEntry ?? coveredFromIds,
  };
}

function getIntermediateEntries(snapshot) {
  const raw = Array.isArray(snapshot?.intermediateSummaries)
    ? snapshot.intermediateSummaries
    : [];
  return raw
    .map(normalizeIntermediateEntry)
    .filter((entry) => entry.summary || entry.highlights.length > 0);
}

function makeEmpty(iconKey, title, subtitle) {
  const empty = el("div", { class: "empty" });
  if (title) {
    const b = document.createElement("b");
    b.textContent = title;
    empty.appendChild(b);
  }
  if (subtitle) {
    const sub = el("span", { class: "empty-subtitle" }, subtitle);
    empty.appendChild(sub);
  }
  return empty;
}

// Build the final-summary card DOM. Shared between the live recorder view
// (rendered into the transcript area when meeting_stop returns) and the
// session-detail "회의록" sub-tab (rendered from PersistedSession.finalSummary).
//
// Optional `opts.sessionId` + `opts.bridge` enable inline editing and
// "다시 생성" — when both are present, an action toolbar appears at the
// top and the card swaps between read/edit/regen/busy modes. Live-view
// callers omit opts to keep it read-only.
function buildSummaryCard(finalSummary, fallbackTitle, opts) {
  const sessionId = opts?.sessionId;
  const bridge = opts?.bridge;
  const onChanged = opts?.onChanged;
  const clipboardMeta = opts?.clipboardMeta ?? {};
  const readOnly = opts?.readOnly === true;
  const editable = typeof sessionId === "string"
    && bridge && typeof bridge.callTool === "function"
    && !readOnly;

  let snapshot = finalSummary;
  let mode = "read";   // "read" | "edit" | "regen" | "busy"
  let busyText = "";
  const card = el("div", { class: "summary" });
  let activeMoreDismiss = null;

  async function handleCopySummary() {
    const text = formatMeetingMinutesForClipboard(snapshot, fallbackTitle, clipboardMeta);
    await copyTextToClipboard(text);
    showSuccessToast("회의록을 복사했습니다.");
  }

  function render() {
    if (typeof activeMoreDismiss === "function") activeMoreDismiss();
    card.replaceChildren();
    if (mode === "busy") return renderBusy();
    if (editable) renderToolbar();
    if (mode === "edit") return renderEdit();
    if (mode === "regen") return renderRegenPicker();
    renderRead();
  }

  function renderToolbar() {
    if (mode !== "read") return;
    const tb = el("div", { class: "summary-toolbar" });
    const editBtn = el("button", { type: "button", class: "summary-action-btn" });
    editBtn.textContent = "✏️ 편집";
    editBtn.addEventListener("click", () => { mode = "edit"; render(); });
    const regenBtn = el("button", { type: "button", class: "summary-action-btn summary-action-regen" });
    regenBtn.textContent = "🔄 다시 생성";
    regenBtn.addEventListener("click", () => { mode = "regen"; render(); });
    const moreBtn = el("button", { type: "button", class: "summary-action-btn summary-action-more" });
    moreBtn.textContent = "⋯";
    moreBtn.setAttribute("aria-label", "더 보기");
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMorePopover(tb, moreBtn);
    });
    tb.appendChild(editBtn);
    tb.appendChild(regenBtn);
    tb.appendChild(moreBtn);
    card.appendChild(tb);
  }

  // Toggle the ⋯ overflow popover. Anchored to the toolbar (`tb`). The
  // document-level outside-click listener MUST be removed on every
  // dismissal path, including render() replacing the toolbar.
  function toggleMorePopover(toolbarEl, anchorBtn) {
    const existing = toolbarEl.querySelector(".summary-more-popover");
    if (existing) {
      // Re-click on ⋯: trigger the existing popover's teardown which
      // also unregisters its onDocClick listener.
      existing.dispatchEvent(new CustomEvent("ave-popover-dismiss"));
      return;
    }
    const pop = el("div", { class: "summary-more-popover" });
    const dismiss = () => {
      document.removeEventListener("click", onDocClick, true);
      if (pop.parentNode) pop.remove();
      if (activeMoreDismiss === dismiss) activeMoreDismiss = null;
    };
    activeMoreDismiss = dismiss;
    pop.addEventListener("ave-popover-dismiss", dismiss);
    const editPromptItem = el("button", { type: "button", class: "summary-more-item" });
    editPromptItem.textContent = "프롬프트 편집…";
    editPromptItem.addEventListener("click", () => {
      dismiss();
      openPromptEditOverlay(card, bridge);
    });
    const regenSameItem = el("button", { type: "button", class: "summary-more-item" });
    regenSameItem.textContent = "이 프롬프트로 다시 생성";
    regenSameItem.addEventListener("click", () => {
      dismiss();
      // No lengthTier override — host falls back to the persisted
      // finalSummary.lengthTier (see meeting_regenerate_summary).
      doRegenerate(undefined);
    });
    pop.appendChild(editPromptItem);
    pop.appendChild(regenSameItem);
    const copyItem = el("button", { type: "button", class: "summary-more-item" });
    copyItem.textContent = "복사하기";
    copyItem.addEventListener("click", async () => {
      dismiss();
      try {
        await handleCopySummary();
      } catch (err) {
        showErrorToast(`복사 실패: ${(err?.message ?? err).toString().slice(0, 200)}`);
      }
    });
    pop.appendChild(copyItem);
    toolbarEl.appendChild(pop);
    const onDocClick = (ev) => {
      if (!pop.contains(ev.target) && ev.target !== anchorBtn) {
        dismiss();
      }
    };
    document.addEventListener("click", onDocClick, true);
  }

  function renderRead() {
    const titleRow = el("div", { class: "summary-title" });
    const titleText = document.createElement("span");
    titleText.textContent = snapshot?.title || fallbackTitle;
    titleRow.appendChild(titleText);
    card.appendChild(titleRow);

    if (snapshot?.summary) {
      const bodyEl = el("div", { class: "summary-body" });
      bodyEl.textContent = snapshot.summary;
      card.appendChild(bodyEl);
    }

    const addSection = (iconKey, label, items, variant) => {
      if (!Array.isArray(items) || items.length === 0) return;
      const section = el("div", { class: "summary-section" });
      const lbl = el("div", { class: "summary-section-label" });
      const lblText = document.createElement("span");
      lblText.textContent = label;
      lbl.appendChild(lblText);
      section.appendChild(lbl);
      const list = el("div", { class: "summary-list" });
      items.forEach((it) => {
        const row = el("div", { class: "summary-item" + (variant ? ` ${variant}` : "") });
        const mk = el("span", { class: "summary-item-marker" });
        mk.textContent = variant === "action" ? "▸" : "•";
        row.appendChild(mk);
        const txt = document.createElement("span");
        txt.textContent = String(it);
        row.appendChild(txt);
        list.appendChild(row);
      });
      section.appendChild(list);
      card.appendChild(section);
    };
    addSection("target", "핵심 포인트", snapshot?.highlights);
    addSection("checkCircle", "액션 아이템", snapshot?.actionItems, "action");
  }

  function renderEdit() {
    const form = el("div", { class: "summary-edit" });
    // Mode banner — makes the inline transition unambiguous (user
    // otherwise can mistake the swap for "nothing happened").
    const banner = el("div", { class: "summary-edit-banner" });
    banner.textContent = "✏️ 편집 모드 — 수정 후 저장 누르면 회의록이 덮어써집니다";
    form.appendChild(banner);

    const mkLabel = (t) => {
      const lbl = el("div", { class: "summary-edit-label" });
      lbl.textContent = t;
      return lbl;
    };
    // Title input — pre-filled from current saved title (or fallback).
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.className = "summary-edit-input";
    titleInput.value = snapshot?.title ?? fallbackTitle ?? "";
    titleInput.maxLength = 200;
    // Summary textarea
    const summaryArea = document.createElement("textarea");
    summaryArea.className = "summary-edit-textarea";
    summaryArea.value = snapshot?.summary || "";
    summaryArea.rows = 6;
    // List editors
    const hlEditor = makeListEditor(snapshot?.highlights || [], "핵심 포인트", 30);
    const aiEditor = makeListEditor(snapshot?.actionItems || [], "액션 아이템", 50);
    // Action buttons
    const btnRow = el("div", { class: "summary-edit-buttons" });
    const saveBtn = el("button", { type: "button", class: "summary-edit-save" });
    saveBtn.textContent = "저장";
    saveBtn.addEventListener("click", async () => {
      busyText = "저장 중…"; mode = "busy"; render();
      try {
        const updated = await bridge.callTool("meeting_update_summary", {
          sessionId,
          title: titleInput.value.trim(),
          summary: summaryArea.value.trim(),
          highlights: hlEditor.getValues(),
          actionItems: aiEditor.getValues(),
        });
        snapshot = updated;
        if (typeof onChanged === "function") onChanged(updated);
        mode = "read"; render();
      } catch (err) {
        showErrorToast(`저장 실패: ${(err?.message ?? err).toString().slice(0, 200)}`);
        mode = "edit"; render();
      }
    });
    const cancelBtn = el("button", { type: "button", class: "summary-edit-cancel" });
    cancelBtn.textContent = "취소";
    cancelBtn.addEventListener("click", () => { mode = "read"; render(); });
    btnRow.appendChild(saveBtn);
    btnRow.appendChild(cancelBtn);

    form.appendChild(mkLabel("제목"));
    form.appendChild(titleInput);
    form.appendChild(mkLabel("요약"));
    form.appendChild(summaryArea);
    form.appendChild(mkLabel("핵심 포인트"));
    form.appendChild(hlEditor.root);
    form.appendChild(mkLabel("액션 아이템"));
    form.appendChild(aiEditor.root);
    form.appendChild(btnRow);

    card.appendChild(form);
  }

  function renderRegenPicker() {
    const wrap = el("div", { class: "summary-regen" });
    const lbl = el("div", { class: "summary-edit-label" });
    lbl.textContent = "회의록 길이 선택 후 다시 생성합니다";
    wrap.appendChild(lbl);
    const tierRow = el("div", { class: "summary-regen-tiers" });
    const tiers = [
      { value: "short",  label: "짧게 (1-2문장)" },
      { value: "medium", label: "보통 (3-5문장)" },
      { value: "long",   label: "길게 (5-10문장)" },
    ];
    for (const t of tiers) {
      const b = el("button", { type: "button", class: "summary-regen-tier" });
      b.textContent = t.label;
      b.addEventListener("click", () => doRegenerate(t.value));
      tierRow.appendChild(b);
    }
    wrap.appendChild(tierRow);
    const cancel = el("button", { type: "button", class: "summary-edit-cancel summary-regen-cancel" });
    cancel.textContent = "취소";
    cancel.addEventListener("click", () => { mode = "read"; render(); });
    wrap.appendChild(cancel);
    card.appendChild(wrap);
  }

  async function doRegenerate(tier) {
    busyText = "회의록 다시 생성 중… (LLM 호출)";
    mode = "busy"; render();
    try {
      const updated = await bridge.callTool("meeting_regenerate_summary", {
        sessionId, lengthTier: tier,
      });
      snapshot = updated;
      if (typeof onChanged === "function") onChanged(updated);
      mode = "read"; render();
    } catch (err) {
      showErrorToast(`재생성 실패: ${(err?.message ?? err).toString().slice(0, 200)}`);
      mode = "read"; render();
    }
  }

  function renderBusy() {
    const b = el("div", { class: "summary-busy" });
    b.textContent = busyText || "처리 중…";
    card.appendChild(b);
  }

  /**
   * Make an inline-editable list of strings with add/remove rows.
   * Returns { root, getValues } — getValues collects current input
   * values, trims, and drops empties.
   *
   * Layout invariant: `addBtn` is appended to `root` FIRST so that
   * `root.insertBefore(row, addBtn)` always succeeds. (Earlier ordering
   * had insertBefore running before addBtn was attached, throwing
   * NotFoundError and silently aborting the whole renderEdit chain —
   * which manifested as an empty card after clicking 편집.)
   */
  function makeListEditor(initial, label, max) {
    const root = el("div", { class: "summary-edit-list" });
    const rows = [];
    const addBtn = el("button", { type: "button", class: "summary-edit-add" });
    addBtn.textContent = `+ ${label} 추가`;
    addBtn.addEventListener("click", () => {
      if (rows.length >= max) return;
      appendRow("");
    });
    // Attach addBtn FIRST — see invariant above.
    root.appendChild(addBtn);

    function appendRow(value) {
      const row = el("div", { class: "summary-edit-row" });
      const input = document.createElement("input");
      input.type = "text";
      input.value = value;
      input.maxLength = 500;
      input.className = "summary-edit-row-input";
      const rm = el("button", { type: "button", class: "summary-edit-row-remove", "aria-label": "제거" });
      const rmGlyph = document.createElement("span");
      rmGlyph.textContent = "✕";
      rmGlyph.setAttribute("aria-hidden", "true");
      rm.appendChild(rmGlyph);
      rm.addEventListener("click", () => {
        const idx = rows.indexOf(input);
        if (idx >= 0) rows.splice(idx, 1);
        row.remove();
      });
      row.appendChild(input);
      row.appendChild(rm);
      rows.push(input);
      root.insertBefore(row, addBtn);
    }

    initial.forEach((it) => appendRow(String(it)));

    return {
      root,
      getValues: () => rows.map((i) => i.value.trim()).filter((v) => v.length > 0),
    };
  }

  render();
  return card;
}

// Throttled to ~20 Hz (50 ms/frame) instead of vsync-locked 60 Hz — the old
// loop felt dizzying on high-refresh displays. 32 bars fits the narrow sidebar
// (was 48). Solid blue colour replaces the multi-stop purple gradient.
function createWaveform(canvas) {
  const ctx = canvas.getContext("2d");
  const BAR_COUNT = 32;
  const FRAME_INTERVAL_MS = 50;
  const bars = new Float32Array(BAR_COUNT);
  let rafId = 0;
  let lastFrameAt = 0;
  let latestPeak = 0;
  let writeIdx = 0;
  let dpr = Math.max(1, window.devicePixelRatio || 1);
  let running = false;
  // Resolved from the canvas's CSS `color` (var(--ave-primary)) so the bars
  // track the host theme. Cached so drawOnce() doesn't trigger a style
  // resolve every frame; refreshed on resize (which also reflows on a
  // host.theme.changed broadcast) and on start().
  let barColor = "";
  const refreshBarColor = () => {
    barColor = getComputedStyle(canvas).color || barColor;
  };

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    refreshBarColor();
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  const drawOnce = () => {
    bars[writeIdx] = latestPeak;
    writeIdx = (writeIdx + 1) % BAR_COUNT;
    latestPeak *= 0.82;

    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const gap = 2 * dpr;
    const barW = Math.max(1, (W - gap * (BAR_COUNT - 1)) / BAR_COUNT);
    const midY = H / 2;
    ctx.fillStyle = barColor;

    for (let i = 0; i < BAR_COUNT; i++) {
      const srcIdx = (writeIdx + i) % BAR_COUNT;
      const v = Math.min(1, bars[srcIdx] * 3.2);
      const h = Math.max(2 * dpr, v * H * 0.9);
      const x = i * (barW + gap);
      const y = midY - h / 2;
      ctx.fillRect(x, y, barW, h);
    }
  };

  const frame = (now) => {
    if (!running) {
      rafId = 0;
      return;
    }
    if (now - lastFrameAt >= FRAME_INTERVAL_MS) {
      lastFrameAt = now;
      drawOnce();
    }
    rafId = requestAnimationFrame(frame);
  };

  return {
    start() {
      if (running) return;
      running = true;
      lastFrameAt = 0;
      refreshBarColor();
      rafId = requestAnimationFrame(frame);
    },
    push(peak) {
      if (peak > latestPeak) latestPeak = peak;
    },
    stop() {
      running = false;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      for (let i = 0; i < BAR_COUNT; i++) bars[i] = 0;
      latestPeak = 0;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
    dispose() {
      this.stop();
      ro.disconnect();
    },
  };
}

// ICON_INLINE merged into ICONS above.

const PM_DATE_FMT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const PM_TIME_FMT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatPrepDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // ko-KR locale uses dot separator with a trailing dot — strip the trailing dot.
  return PM_DATE_FMT.format(d).replace(/\.\s*$/, "").replace(/\.\s/g, ".").replace(/\./g, ".");
}

function formatPrepTimeRange(startIso, endIso) {
  if (!startIso) return "";
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return "";
  const startStr = PM_TIME_FMT.format(start);
  if (!endIso) return startStr;
  const end = new Date(endIso);
  if (Number.isNaN(end.getTime())) return startStr;
  return `${startStr} - ${PM_TIME_FMT.format(end)}`;
}

const DEFAULT_PREP_DURATION_MS = 60 * 60 * 1000;

function inferPrepEndMs(prep) {
  const start = prep?.scheduledStart ? new Date(prep.scheduledStart).getTime() : NaN;
  if (!Number.isFinite(start)) return NaN;
  const explicitEnd = prep?.scheduledEnd ? new Date(prep.scheduledEnd).getTime() : NaN;
  if (Number.isFinite(explicitEnd) && explicitEnd >= start) return explicitEnd;
  return start + DEFAULT_PREP_DURATION_MS;
}

/** Sort preps ascending by scheduledStart (no-date last). Stable. */
function sortPreps(list) {
  return [...list].sort((a, b) => {
    const ta = a?.scheduledStart ? new Date(a.scheduledStart).getTime() : Infinity;
    const tb = b?.scheduledStart ? new Date(b.scheduledStart).getTime() : Infinity;
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return ta - tb;
  });
}

/**
 * Drop preps whose scheduled window has already ended. Past meetings
 * live in the 회의록 tab (PersistedSession + finalSummary) — keeping them
 * in the pre-meeting navigator just clutters the 1/N counter. Preps
 * without a date are kept (treated as upcoming-unknown).
 */
function filterPreMeetingVisible(list, now = Date.now()) {
  return list.filter((b) => {
    const start = b?.scheduledStart ? new Date(b.scheduledStart).getTime() : NaN;
    if (!Number.isFinite(start)) return true;
    const end = inferPrepEndMs(b);
    return Number.isFinite(end) ? end >= now : true;
  });
}

function prepSignature(prep) {
  return JSON.stringify({
    id: prep?.id ?? null,
    scheduledStart: prep?.scheduledStart ?? null,
    scheduledEnd: prep?.scheduledEnd ?? null,
    title: prep?.title ?? null,
    organizer: prep?.organizer ?? null,
    location: prep?.location ?? null,
    description: prep?.description ?? null,
    contextHint: prep?.contextHint ?? null,
    agenda: Array.isArray(prep?.agenda) ? prep.agenda : [],
    participants: Array.isArray(prep?.participants) ? prep.participants : [],
    conference: prep?.conference ?? null,
    previousSummary: prep?.previousSummary ?? null,
  });
}

/** Display diff — equal lengths and identical visible prep payloads. */
function prepsChanged(a, b) {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (prepSignature(a[i]) !== prepSignature(b[i])) return true;
  }
  return false;
}

/**
 * Pick the index of the prep whose scheduledStart is closest to now,
 * preferring in-progress > upcoming > past. Returns 0 if no scoring possible.
 */
function pickNearestIndex(list) {
  if (list.length === 0) return 0;
  const t = Date.now();
  let bestIdx = 0;
  let bestScore = Infinity;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    const start = b?.scheduledStart ? new Date(b.scheduledStart).getTime() : NaN;
    if (!Number.isFinite(start)) continue;
    const end = inferPrepEndMs(b);
    if (t >= start && t <= end) return i;
    const delta = start - t;
    const score = delta >= 0 ? delta : -delta * 1.5;
    if (score < bestScore) { bestScore = score; bestIdx = i; }
  }
  return bestIdx;
}


function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      // result is "data:<mime>;base64,<payload>" — strip the prefix.
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

// ─── Large-file upload (>25MB) ─────────────────────────────────────────────
// Stream file bytes to the host staged-upload path. The host owns splitting,
// ffmpeg/ffprobe probing, STT, and summary so the renderer avoids full decode.
const LARGE_UPLOAD_INLINE_MAX_BYTES = 25 * 1024 * 1024;
const LARGE_UPLOAD_RAW_MAX_BYTES = 500 * 1024 * 1024;
const LARGE_UPLOAD_TRANSFER_CHUNK_BYTES = 2 * 1024 * 1024;
const LARGE_UPLOAD_CHUNK_MIN_INTERVAL_MS = 1050;

function bytesToBase64(bytes) {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function throwIfUploadAborted(signal) {
  if (signal?.aborted) {
    throw new Error("업로드가 취소되었습니다");
  }
}

function waitForUploadPace(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  throwIfUploadAborted(signal);

  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("업로드가 취소되었습니다"));
    };

    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

async function* readFileTransferChunks(file, chunkBytes, signal, paceMs = 0) {
  let index = 0;
  for (let offset = 0; offset < file.size; offset += chunkBytes) {
    if (index > 0) {
      await waitForUploadPace(paceMs, signal);
    }
    throwIfUploadAborted(signal);
    const buf = await file.slice(offset, offset + chunkBytes).arrayBuffer();
    throwIfUploadAborted(signal);
    yield new Uint8Array(buf);
    index += 1;
  }
}

async function uploadLargeFileViaStagedChunks(file, ctx, statusEl, bridge, opts = {}) {
  const sessionId = (crypto.randomUUID?.() ?? `upload-${Date.now()}`);
  let uploadId = null;

  try {
    throwIfUploadAborted(opts.signal);
    statusEl.textContent = "대형 파일 스트리밍 준비 중…";
    const begin = await bridge.callTool("meeting_stage_upload_begin", {
      sessionId,
      context: ctx,
      file: { name: file.name, mimeType: file.type, size: file.size },
    });
    if (begin?.ok === false) {
      throw new Error(begin.error ?? "staged upload begin failed");
    }
    uploadId = begin?.uploadId;
    if (!uploadId) throw new Error("staged upload id missing");
    opts.onUploadId?.(uploadId);

    const hostChunkMax = Number(begin?.chunkMaxBytes);
    const chunkBytes = Math.min(
      LARGE_UPLOAD_TRANSFER_CHUNK_BYTES,
      Number.isFinite(hostChunkMax) && hostChunkMax > 0 ? Math.floor(hostChunkMax) : LARGE_UPLOAD_TRANSFER_CHUNK_BYTES,
    );
    if (chunkBytes <= 0) throw new Error("host chunk cap is invalid");
    const totalChunks = Math.max(1, Math.ceil(file.size / chunkBytes));
    let offset = 0;
    let index = 0;

    for await (const chunk of readFileTransferChunks(file, chunkBytes, opts.signal, LARGE_UPLOAD_CHUNK_MIN_INTERVAL_MS)) {
      throwIfUploadAborted(opts.signal);
      const bytesBase64 = bytesToBase64(chunk);
      const res = await bridge.callTool("meeting_stage_upload_chunk", {
        uploadId,
        offset,
        bytesBase64,
      });
      if (res?.ok === false) {
        throw new Error(`업로드 청크 ${index + 1}/${totalChunks} 실패: ${res.error ?? "unknown"}`);
      }
      offset += chunk.byteLength;
      index += 1;
      const pct = Math.min(100, Math.round((offset / file.size) * 100));
      statusEl.textContent = `파일 전송 중… ${pct}% (${index}/${totalChunks})`;
    }

    if (offset !== file.size) {
      throw new Error(`파일 전송 크기가 맞지 않습니다 (${offset}/${file.size})`);
    }

    throwIfUploadAborted(opts.signal);
    statusEl.textContent = "오디오 분할 + 전사 + 요약 중…";
    const result = await bridge.callTool("meeting_stage_upload_finish", {
      uploadId,
    });
    if (result?.ok === false) {
      throw new Error(result.error ?? "staged upload finish failed");
    }
    return sessionId;
  } catch (err) {
    if (uploadId) {
      try {
        await bridge.callTool("meeting_stage_upload_cancel", {
          uploadId,
        });
      } catch (_e) {}
    }
    throw err;
  } finally {
    opts.onUploadId?.(null);
  }
}

export default async function mount(context) {
  const { root, bridge } = context;

  root.replaceChildren();
  const styleEl = document.createElement("style");
  styleEl.setAttribute("data-ave-meeting-ui", "");
  styleEl.textContent = STYLES;
  root.appendChild(styleEl);

  const scope = document.createElement("div");
  scope.className = "ave-meeting-ui";
  root.appendChild(scope);

  // Theme wiring — primeTheme handles getTheme() cold-boot pull +
  // host.theme.changed subscribe + validated token paint to scope.style
  // (target: HTMLElement). Floating windows receive host theme changes
  // through the plugin host service loop, not through a UI-invoked tool.
  const themeHandle = primeTheme(bridge, {
    target: scope,
  });

  // Pull render-time UI config through the UI-only config bridge. This keeps
  // display preferences out of the LLM/tool-call surface.
  if (typeof bridge?.config?.get === "function") {
    bridge.config.get("transcriptBubbleMaxChars")
      .then((cfg) => {
        if (typeof cfg === "number" && Number.isFinite(cfg)) {
          transcriptBubbleMaxChars = Math.min(2000, Math.max(80, Math.floor(cfg)));
          // If the user is currently looking at the transcript sub-tab,
          // re-render so the new cap takes effect immediately.
          if (currentView === "session-detail") renderCurrentView();
        }
      })
      .catch(() => { /* default already in place */ });
  }

  // Inner column caps the panel content at a comfortable reading width and
  // centers it. The plugin used to open in an ~800px detached window; inline
  // (host PageShell caps the panel near the chat column width) the content would
  // otherwise stretch edge to edge — the two-tab nav in particular ballooning
  // across the full width. The root stays full-width so its background fills the
  // panel in both themes while `.mc-inner` centers the tabs + views. Overlays
  // (`.prompt-overlay`) still mount on `scope`, so they keep covering the whole
  // panel.
  const inner = document.createElement("div");
  inner.className = "mc-inner";
  scope.appendChild(inner);

  const topNav = document.createElement("div");
  topNav.className = "top-nav";
  topNav.setAttribute("role", "tablist");
  topNav.setAttribute("aria-label", "회의 뷰");
  inner.appendChild(topNav);

  const viewArea = document.createElement("div");
  viewArea.className = "view";
  inner.appendChild(viewArea);

  // Plugin opens onto the prep screen — that's the user's primary
  // entry point (회의 시작 전 안내 + 녹음/업로드/Webex actions).
  let currentView = "pre-meeting";
  let selectedSessionId = null;
  let pendingSubTab = null; // consumed once by renderSessionDetail
  // Prep list state. Populated on demand by renderPreMeeting via
  // meeting_list_preps, sorted ascending by scheduledStart. The
  // navigator (◀ N/M ▶) cycles through them by mutating prepIndex
  // and re-painting; nothing else (no mock fallback).
  let prepList = [];
  let prepIndex = 0;
  // Active session that has a recorder card in the dock. Acts as a singleton
  // guard so a fast double-click on 녹음 doesn't fire two attaches — the host
  // plugin refuses the second anyway, but refusing it here keeps the button
  // from flashing an error the user did nothing to cause. Cleared on
  // meeting.ended (subscribed below).
  let activeFloatingSessionId = null;
  // Subscribe to meeting.ended so we can navigate to session-detail when
  // the user presses Done in the floating window. Cancelled meetings
  // also fire meeting.ended (with cancelled: true) — we only navigate
  // when there's a real summary to show.
  let unsubMeetingEnded = () => {};
  let unsubMeetingPrepRegistered = () => {};
  if (typeof bridge?.onEvent === "function") {
    try {
      const sub = bridge.onEvent("meeting.ended", (payload) => {
        if (!payload || typeof payload !== "object") return;
        const { sessionId: sid, cancelled } = payload;
        if (sid && sid === activeFloatingSessionId) {
          activeFloatingSessionId = null;
          if (!cancelled && typeof sid === "string") {
            setView("session-detail", sid);
          }
        }
      });
      if (typeof sub === "function") unsubMeetingEnded = sub;
    } catch { /* bridge missing onEvent — singleton guard still works */ }
    try {
      const sub = bridge.onEvent("meeting.prep.registered", () => {
        if (currentView === "pre-meeting") renderPreMeeting();
      });
      if (typeof sub === "function") unsubMeetingPrepRegistered = sub;
    } catch { /* optional live refresh only */ }
  }

  // Top nav is intentionally 2 tabs only — "예정 회의" + "회의록".
  // The instant-record view is reachable from the empty state of "예정 회의"
  // (when no upcoming meetings exist) instead of being a peer tab. This keeps
  // the nav lean and frames recording as a fallback for the no-prep case
  // rather than the primary entry point.
  const navPrepBtn = el("button", {
    type: "button",
    class: "nav-btn",
    role: "tab",
    "aria-selected": "false",
    "data-state": "inactive",
    onClick: () => setView("pre-meeting"),
  });
  navPrepBtn.appendChild(document.createTextNode("예정 회의"));
  topNav.appendChild(navPrepBtn);

  const navSessionsBtn = el("button", {
    type: "button",
    class: "nav-btn",
    role: "tab",
    "aria-selected": "false",
    "data-state": "inactive",
    onClick: () => setView("sessions"),
  });
  navSessionsBtn.appendChild(document.createTextNode("회의록"));
  topNav.appendChild(navSessionsBtn);

  function syncNav() {
    // Visual highlight ≠ ARIA selection. The pill lights up to give visual
    // continuity ("you came from 예정 회의") but `aria-selected` must reflect
    // truth: when the user is inside the `instant` sub-view, no tab's
    // panel is currently presented, so both pills report aria-selected=false.
    // Otherwise screen readers announce navPrep as selected while a
    // different view is on screen — a misleading state.
    const sync = (button, visuallyActive, ariaSelected) => {
      button.classList.toggle("active", visuallyActive);
      button.setAttribute("aria-selected", String(ariaSelected));
      button.dataset.state = visuallyActive ? "active" : "inactive";
    };
    const inInstant = currentView === "instant";
    sync(
      navPrepBtn,
      currentView === "pre-meeting" || inInstant,
      currentView === "pre-meeting", // not selected when nested in instant
    );
    sync(
      navSessionsBtn,
      currentView === "sessions" || currentView === "session-detail",
      currentView === "sessions" || currentView === "session-detail",
    );
  }

  // Set true while a file upload is mid-flight (chunked or inline). Guards
  // against the user clicking 회의록 / 예정회의 mid-upload and tearing down
  // the renderer-driven chunk loop / abandoning the in-flight IPC call —
  // session-detail target is always allowed so the auto-jump from
  // handleFileChosen completion still works.
  let uploadInFlight = false;
  let activeStagedUploadId = null;
  let activeUploadAbortController = null;

  function cancelActiveStagedUpload(reason = "ui-teardown") {
    if (activeUploadAbortController && !activeUploadAbortController.signal.aborted) {
      activeUploadAbortController.abort();
    }
    const uploadId = activeStagedUploadId;
    activeStagedUploadId = null;
    if (uploadId) {
      bridge.callTool("meeting_stage_upload_cancel", { uploadId }).catch((err) => {
        console.warn("[meeting-ui] staged upload cancel failed", err);
      });
    }
  }

  const handlePageHide = () => cancelActiveStagedUpload("pagehide");
  window.addEventListener("pagehide", handlePageHide);

  function setView(view, sessionId) {
    if (uploadInFlight && view !== "session-detail") {
      showErrorToast("업로드 처리 중입니다. 완료 후 이동해주세요.");
      return;
    }
    // Defensive: pendingSubTab is consumed by renderSessionDetail; on any
    // other view transition it would be stale and must be cleared.
    if (view !== "session-detail") pendingSubTab = null;
    currentView = view;
    if (view === "session-detail") selectedSessionId = sessionId ?? selectedSessionId;
    else selectedSessionId = null;
    syncNav();
    renderCurrentView();
  }

  function renderCurrentView() {
    if (currentView === "instant") renderInstant();
    else if (currentView === "pre-meeting") renderPreMeeting();
    else if (currentView === "sessions") renderSessionList();
    else if (currentView === "session-detail") renderSessionDetail(selectedSessionId);
  }

  // ─── Length-tier shared state + radio helper ──────────
  // Persists across view switches in this session. Default "medium"
  // matches plugin.json's configSchema default; the plugin settings UI
  // can change the configSchema default but this in-memory value is
  // the per-window picked tier (carried into meeting_start
  // context.lengthTier and ultimately into summarizeFinal).
  const LENGTH_TIER_KEY = "ave.meeting.summaryLengthTier";
  const SESSION_CATEGORY_FILTER_KEY = "ave.meeting.sessionCategoryFilter";
  let pickedLengthTier = "medium";
  let pickedInstantCategory = "";
  let sessionCategoryFilter = "__all__";
  try {
    const saved = localStorage.getItem(LENGTH_TIER_KEY);
    if (saved === "short" || saved === "medium" || saved === "long") pickedLengthTier = saved;
  } catch { /* localStorage unavailable */ }
  try {
    const savedFilter = localStorage.getItem(SESSION_CATEGORY_FILTER_KEY);
    if (savedFilter) sessionCategoryFilter = savedFilter;
  } catch { /* localStorage unavailable */ }

  function setPickedLengthTier(tier) {
    if (tier !== "short" && tier !== "medium" && tier !== "long") return;
    pickedLengthTier = tier;
    try { localStorage.setItem(LENGTH_TIER_KEY, tier); } catch { /* noop */ }
  }

  function requestCategoryName() {
    return new Promise((resolve) => {
      const overlay = el("div", { class: "prompt-overlay category-dialog" });
      const card = el("div", { class: "prompt-overlay-card category-dialog-card", role: "dialog", "aria-modal": "true" });
      const header = el("div", { class: "prompt-overlay-header" });
      header.appendChild(el("div", { class: "prompt-overlay-title" }, "새 카테고리 추가"));
      const closeBtn = el("button", { type: "button", class: "prompt-overlay-close", "aria-label": "닫기" }, "×");
      header.appendChild(closeBtn);

      const body = el("div", { class: "prompt-overlay-body" });
      body.appendChild(el("label", { class: "prompt-overlay-field-label", for: "new-category-input" }, "카테고리 이름"));
      const input = el("input", {
        id: "new-category-input",
        class: "category-dialog-input",
        type: "text",
        maxlength: "40",
        placeholder: "예: 로봇 프로젝트",
      });
      const error = el("div", { class: "category-dialog-error", role: "alert" });
      body.appendChild(input);
      body.appendChild(error);

      const footer = el("div", { class: "prompt-overlay-footer" });
      const cancelBtn = el("button", { type: "button", class: "prompt-overlay-cancel" }, "취소");
      const saveBtn = el("button", { type: "button", class: "prompt-overlay-save" }, "추가");
      footer.appendChild(cancelBtn);
      footer.appendChild(saveBtn);

      const cleanup = (value) => {
        overlay.remove();
        resolve(value);
      };
      const submit = () => {
        const raw = input.value.trim();
        if (!raw) {
          error.textContent = "카테고리 이름을 입력하세요.";
          input.focus();
          return;
        }
        cleanup(raw);
      };

      closeBtn.addEventListener("click", () => cleanup(null));
      cancelBtn.addEventListener("click", () => cleanup(null));
      saveBtn.addEventListener("click", submit);
      input.addEventListener("input", () => { error.textContent = ""; });
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          submit();
        } else if (ev.key === "Escape") {
          ev.preventDefault();
          cleanup(null);
        }
      });
      overlay.addEventListener("click", (ev) => {
        if (ev.target === overlay) cleanup(null);
      });

      card.appendChild(header);
      card.appendChild(body);
      card.appendChild(footer);
      overlay.appendChild(card);
      scope.appendChild(overlay);
      window.setTimeout(() => input.focus(), 0);
    });
  }

  async function promptAndRegisterCategory() {
    const raw = await requestCategoryName();
    if (raw === null) return null;
    const category = raw.trim() ? normalizeSessionCategoryForUi(raw) : "";
    if (!category) return null;
    const result = await bridge.callTool("meeting_register_category", { category });
    return {
      category: normalizeSessionCategoryForUi(result?.category || category),
      categories: Array.isArray(result?.categories) ? result.categories : null,
    };
  }

  // Build a 3-button radio group; calls onChange after updating internal
  // state. Returned root is appended where needed.
  function makeLengthTierRadio() {
    const wrap = el("div", { class: "length-tier", role: "radiogroup", "aria-label": "회의록 길이" });
    const opts = [
      { value: "short",  label: "짧게" },
      { value: "medium", label: "보통" },
      { value: "long",   label: "길게" },
    ];
    const buttons = [];
    for (const o of opts) {
      const b = el("button", {
        type: "button",
        class: "length-tier-opt",
        role: "radio",
        "aria-checked": String(pickedLengthTier === o.value),
        "data-state": pickedLengthTier === o.value ? "active" : "inactive",
        onClick: () => {
          setPickedLengthTier(o.value);
          for (const x of buttons) {
            const selected = x.dataset.value === o.value;
            x.classList.toggle("active", selected);
            x.setAttribute("aria-checked", String(selected));
            x.dataset.state = selected ? "active" : "inactive";
          }
        },
      }, o.label);
      b.dataset.value = o.value;
      if (pickedLengthTier === o.value) b.classList.add("active");
      buttons.push(b);
      wrap.appendChild(b);
    }
    return wrap;
  }

  // ─── Instant-record view ───────────────────────────────
  // No-prep-required entry point. The user types an optional title,
  // picks length tier, and presses 녹음 시작 — same handleStartRecording
  // path as the prep card, just with a minimal MeetingContext.
  function renderInstant() {
    const root = el("div", { class: "instant-view" });

    // Back row — only path back to "예정 회의" now that the standalone 녹음
    // tab is gone. Mirrors the pre-meeting top-bar arrow so the affordance
    // reads consistently across both views.
    const backRow = el("div", { class: "instant-back-row" });
    const backBtn = el("button", {
      type: "button",
      class: "instant-back-btn",
      "aria-label": "예정 회의로 돌아가기",
      onClick: () => setView("pre-meeting"),
    });
    backBtn.appendChild(document.createTextNode("예정 회의"));
    backRow.appendChild(backBtn);

    // Settings entry point — opens the prompt-edit overlay. Without this,
    // prompt editing is only reachable from a completed meeting's "⋯"
    // menu, so the first-run user has no way to customize prompts before
    // recording.
    const settingsBtn = el("button", {
      type: "button",
      class: "instant-settings-btn",
      "aria-label": "회의록 프롬프트 설정",
      title: "회의록 프롬프트 설정",
      onClick: () => openPromptEditOverlay(root, bridge),
    });
    settingsBtn.appendChild(document.createTextNode("⚙ 설정"));
    backRow.appendChild(settingsBtn);

    root.appendChild(backRow);

    const card = el("div", { class: "instant-card" });
    const title = el("h2", { class: "instant-title" }, "지금 바로 녹음");
    const subtitle = el("div", { class: "instant-subtitle" }, "예약된 회의가 없어도 즉석에서 녹음을 시작할 수 있습니다.");
    card.appendChild(title);
    card.appendChild(subtitle);

    // Title input (optional)
    const titleField = el("div", { class: "instant-field" });
    titleField.appendChild(el("label", { class: "instant-field-label", for: "instant-title-input" }, "회의 제목 (선택)"));
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.className = "instant-input";
    titleInput.id = "instant-title-input";
    titleInput.placeholder = "예: 4분기 기획 미팅";
    titleInput.maxLength = 120;
    titleField.appendChild(titleInput);
    card.appendChild(titleField);

    const categoryField = el("div", { class: "instant-field" });
    categoryField.appendChild(el("label", { class: "instant-field-label", for: "instant-category-select" }, "카테고리"));
    const categorySelect = document.createElement("select");
    categorySelect.className = "instant-input";
    categorySelect.id = "instant-category-select";
    populateCategorySelect(categorySelect, SESSION_CATEGORY_OPTIONS, pickedInstantCategory, {
      placeholder: "카테고리 선택",
      requiredPlaceholder: true,
      allowCreate: true,
    });
    let instantCategoryOptions = SESSION_CATEGORY_OPTIONS;
    categorySelect.addEventListener("change", async () => {
      if (categorySelect.value === CATEGORY_CREATE_VALUE) {
        const previous = pickedInstantCategory;
        try {
          const created = await promptAndRegisterCategory(previous);
          if (created?.category) {
            instantCategoryOptions = created.categories || [...instantCategoryOptions, created.category];
            pickedInstantCategory = created.category;
          }
        } catch (err) {
          showErrorToast(`카테고리 추가 실패: ${(err?.message ?? err).toString().slice(0, 120)}`);
        }
        populateCategorySelect(categorySelect, instantCategoryOptions, pickedInstantCategory || previous, {
          placeholder: "카테고리 선택",
          requiredPlaceholder: true,
          allowCreate: true,
        });
        return;
      }
      pickedInstantCategory = categorySelect.value
        ? normalizeSessionCategoryForUi(categorySelect.value)
        : "";
    });
    bridge.callTool("meeting_categories", {})
      .then((payload) => {
        const selected = categorySelect.value || pickedInstantCategory;
        instantCategoryOptions = payload?.categories || SESSION_CATEGORY_OPTIONS;
        populateCategorySelect(categorySelect, payload?.categories, selected, {
          placeholder: "카테고리 선택",
          requiredPlaceholder: true,
          allowCreate: true,
        });
      })
      .catch(() => {});
    categoryField.appendChild(categorySelect);
    card.appendChild(categoryField);

    // Length tier radio
    const tierField = el("div", { class: "instant-field" });
    tierField.appendChild(el("label", { class: "instant-field-label" }, "회의록 길이"));
    tierField.appendChild(makeLengthTierRadio());
    card.appendChild(tierField);

    // Status line — surfaces "이미 녹음 중" / 에러 메시지.
    const statusEl = el("div", { class: "instant-status", role: "status" });

    // Big record button
    const recordBtn = el("button", { type: "button", class: "instant-record-btn" });
    recordBtn.appendChild(document.createTextNode("녹음 시작"));
    recordBtn.addEventListener("click", async () => {
      // Self-heal a stale guard. `meeting.ended` is the canonical clear
      // signal for activeFloatingSessionId, but on rare bridge hiccups
      // (event drop, mount race) the variable can stay pinned to a
      // finished session forever — turning the singleton guard into a
      // permanent block. Verify the session via the host before
      // refusing the click.
      activeFloatingSessionId = await reconcileActiveSession(activeFloatingSessionId);
      if (activeFloatingSessionId) {
        statusEl.classList.add("error");
        statusEl.textContent = "이미 다른 회의를 녹음 중입니다.";
        return;
      }
      statusEl.classList.remove("error");
      statusEl.textContent = "녹음 창을 여는 중…";
      recordBtn.disabled = true;
      const titleVal = titleInput.value.trim();
      const categoryVal = categorySelect.value
        ? normalizeSessionCategoryForUi(categorySelect.value)
        : "";
      if (!categoryVal) {
        statusEl.classList.add("error");
        statusEl.textContent = "카테고리를 먼저 선택하세요.";
        recordBtn.disabled = false;
        categorySelect.focus();
        return;
      }
      pickedInstantCategory = categoryVal;
      const ctx = {
        title: titleVal || undefined,
        category: categoryVal,
        lengthTier: pickedLengthTier,
      };
      // Bypass handleStartRecording (which swallows errors and shows a
      // misleading success status) — call the tool directly so any
      // failure in the host's meeting_start surfaces
      // verbatim into the UI status. Mirrors handleStartRecording's
      // singleton/cleanup contract so the prep-card flow still works.
      const sessionId = (typeof crypto?.randomUUID === "function")
        ? crypto.randomUUID()
        : `session-${Date.now()}`;
      activeFloatingSessionId = sessionId;
      try {
        const result = await bridge.callTool("meeting_start", {
          sessionId, context: ctx,
        });
        console.log("[meeting-ui] meeting_start →", result);
        statusEl.textContent = "녹음 창이 열렸습니다.";
      } catch (err) {
        console.error("[meeting-ui] meeting_start failed:", err);
        statusEl.classList.add("error");
        statusEl.textContent = `오류: ${(err?.message ?? err).toString().slice(0, 200)}`;
        try { await bridge.callTool("meeting_cancel", { sessionId }); }
        catch { /* best-effort */ }
        activeFloatingSessionId = null;
      } finally {
        recordBtn.disabled = false;
      }
    });
    card.appendChild(recordBtn);

    // 첨부파일 업로드 — 사전 녹음된 오디오/비디오 파일을 그대로 STT + 요약
    // 파이프라인에 흘려넣는 경로. handleFileChosen 은 prep 카드와 공유 —
    // bridge.callTool("meeting_upload_file", ...) → 완료 후 session-detail 로 이동.
    const uploadBtn = el("button", { type: "button", class: "instant-upload-btn" });
    uploadBtn.appendChild(document.createTextNode("파일 업로드"));
    const fileInput = el("input", {
      type: "file",
      accept: "audio/*,video/*,.mp3,.wav,.m4a,.mp4,.webm,.ogg,.flac",
      style: "display: none",
    });
    uploadBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", (e) => {
      const titleVal = titleInput.value.trim();
      const categoryVal = categorySelect.value
        ? normalizeSessionCategoryForUi(categorySelect.value)
        : "";
      if (!categoryVal) {
        statusEl.classList.add("error");
        statusEl.textContent = "카테고리를 먼저 선택하세요.";
        fileInput.value = "";
        categorySelect.focus();
        return;
      }
      pickedInstantCategory = categoryVal;
      const uploadCtx = {
        title: titleVal || undefined,
        category: categoryVal,
        lengthTier: pickedLengthTier,
      };
      handleFileChosen(e, uploadCtx, statusEl, uploadBtn);
    });
    card.appendChild(uploadBtn);
    card.appendChild(fileInput);
    card.appendChild(el(
      "div",
      { class: "instant-upload-hint" },
      "mp3 · wav · m4a · mp4 · webm · ogg · flac (최대 25MB)",
    ));

    card.appendChild(statusEl);

    root.appendChild(card);
    viewArea.replaceChildren(root);
  }


  // ─── Pre-meeting prep ─────────────────────────────
  // Renders the layout from the pre-meeting screenshot:
  //   header / title / meta chips / webex info / 2-col grid
  //   left: 지난 회의 요약 + 오늘 회의 안건   right: [녹음][업로드][Webex] buttons
  // Data source: prepList (full list from meeting_list_preps),
  // sorted ascending by scheduledStart. Initial index = nearest upcoming
  // meeting (진행 중 우선, 그다음 임박한 미래). The navigator cycles
  // through the list. Empty state shown when no preps exist.
  function renderPreMeeting() {
    // Fetch on each pre-meeting view entry/render and repaint only when the
    // returned prep list differs from the currently displayed list.
    bridge
      .callTool("meeting_list_preps", {})
      .then((list) => {
        const arr = Array.isArray(list) ? list : [];
        // Hide already-finished meetings — they belong to the 회의록 tab.
        const next = sortPreps(filterPreMeetingVisible(arr));
        // Only repaint when the list actually changed (length or any id) to
        // avoid render churn on identical responses.
        if (prepsChanged(prepList, next)) {
          // Preserve the user's current selection across refreshes by id.
          const prevId = prepList[prepIndex]?.id;
          prepList = next;
          prepIndex = next.findIndex((b) => b.id === prevId);
          if (prepIndex < 0) prepIndex = pickNearestIndex(next);
          if (currentView === "pre-meeting") paintPreMeeting();
        }
      })
      .catch(() => { /* getter must never break the view */ });

    paintPreMeeting();
  }

  function paintPreMeeting() {
    if (prepList.length === 0) {
      const empty = el("div", { class: "pre-meeting" });
      const card = el("div", { class: "pm-card", style: "max-width: 420px; margin: 80px auto; text-align: center;" });
      const title = el("div", { class: "pm-card-title" });
      title.textContent = "예정된 회의 없이 회의가 시작되었나요?";
      const body = el("div", { class: "pm-card-body" });
      body.textContent = "회의 녹음을 진행하여 기록을 남겨보세요.";
      const actions = el("div", { class: "pm-card-actions" });
      const startBtn = el("button", {
        type: "button",
        class: "pm-card-cta",
        "aria-label": "녹음 시작",
        onClick: () => setView("instant"),
      });
      startBtn.appendChild(document.createTextNode("녹음 시작"));
      actions.appendChild(startBtn);
      card.appendChild(title);
      card.appendChild(body);
      card.appendChild(actions);
      empty.appendChild(card);
      viewArea.replaceChildren(empty);
      return;
    }
    if (prepIndex < 0 || prepIndex >= prepList.length) prepIndex = 0;
    const ctx = prepList[prepIndex];
    const root = el("div", { class: "pre-meeting" });

    // Top bar
    const topbar = el("div", { class: "pm-topbar" });
    // Navigator — only when 2+ preps exist. ◀ 1 / N ▶ pattern.
    if (prepList.length > 1) {
      const nav = el("div", { class: "pm-nav" });
      const prevBtn = el("button", {
        type: "button",
        class: "pm-icon-btn pm-nav-btn",
        title: "이전 회의",
        onClick: () => { prepIndex = (prepIndex - 1 + prepList.length) % prepList.length; paintPreMeeting(); },
      });
      prevBtn.textContent = "<";
      const counter = el("span", { class: "pm-nav-count" });
      counter.textContent = `${prepIndex + 1} / ${prepList.length}`;
      const nextBtn = el("button", {
        type: "button",
        class: "pm-icon-btn pm-nav-btn",
        title: "다음 회의",
        onClick: () => { prepIndex = (prepIndex + 1) % prepList.length; paintPreMeeting(); },
      });
      nextBtn.textContent = ">";
      nav.appendChild(prevBtn);
      nav.appendChild(counter);
      nav.appendChild(nextBtn);
      topbar.appendChild(nav);
    }

    if (prepList.length > 1) root.appendChild(topbar);

    // Title
    const title = el("div", { class: "pm-title" });
    title.textContent = ctx.title || "회의";
    root.appendChild(title);

    // Organizer subtitle — only when present, sits directly under the title.
    if (ctx.organizer) {
      const sub = el("div", { class: "pm-subtitle" });
      sub.textContent = `주최: ${ctx.organizer}`;
      root.appendChild(sub);
    }

    // Meta row
    const metaRow = el("div", { class: "pm-meta-row" });
    const chips = el("div", { class: "pm-chips" });
    const dateText = formatPrepDate(ctx.scheduledStart);
    const timeText = formatPrepTimeRange(ctx.scheduledStart, ctx.scheduledEnd);
    if (dateText) chips.appendChild(makePmChip(null, dateText));
    if (timeText) chips.appendChild(makePmChip(null, timeText));
    chips.appendChild(makePmChip(null, `카테고리: ${normalizeSessionCategoryForUi(ctx.category)}`));
    if (ctx.location) chips.appendChild(makePmChip(null, ctx.location));
    metaRow.appendChild(chips);

    // Avatars
    if (Array.isArray(ctx.participants) && ctx.participants.length > 0) {
      const avatars = el("div", { class: "pm-avatars" });
      const visible = ctx.participants.slice(0, 3);
      for (const p of visible) {
        const a = el("div", { class: "pm-avatar" });
        a.textContent = speakerInitials(p);
        avatars.appendChild(a);
      }
      if (ctx.participants.length > visible.length) {
        const more = el("div", { class: "pm-avatar more" });
        more.textContent = `+${ctx.participants.length - visible.length}`;
        avatars.appendChild(more);
      }
      metaRow.appendChild(avatars);
    }
    root.appendChild(metaRow);

    // Conference info (text block — links rendered as plain text per the
    // "no innerHTML with interpolated values" rule; the bottom button is
    // the actual launcher).
    const conf = ctx.conference;
    if (isOpenableWebexConference(conf)) {
      const block = el("div", { class: "pm-webex" });
      const label = (conf.type ?? "other").toUpperCase();
      const lines = [
        `JOIN ${label} MEETING`,
        `JOIN URL : ${conf.joinUrl}`,
      ];
      if (conf.accessCode) lines.push(`Meeting Key (access code) : ${conf.accessCode}`);
      if (conf.password) lines.push(`Meeting Password : ${conf.password}`);
      if (conf.hostDisplayName) lines.push(`Host : ${conf.hostDisplayName}`);
      block.textContent = lines.join("\n");
      block.style.whiteSpace = "pre-line";
      root.appendChild(block);
    }

    // Description (calendar invite body) — rendered after conference info,
    // before the 2-col grid. Only when non-empty.
    if (ctx.description && ctx.description.trim().length > 0) {
      const desc = el("div", { class: "pm-description" });
      desc.textContent = ctx.description;
      root.appendChild(desc);
    }

    // Two-column grid
    const grid = el("div", { class: "pm-grid" });

    // Left: 지난 회의 요약 + 오늘 회의 안건
    const leftCol = el("div", {});
    const lastTitle = el("div", { class: "pm-section-title" });
    lastTitle.appendChild(document.createTextNode("지난 회의 요약"));
    leftCol.appendChild(lastTitle);

    const lastCard = el("div", { class: "pm-card" });
    const lastCardTitle = el("div", { class: "pm-card-title" });
    lastCardTitle.textContent = ctx.previousSummary?.title
      ? `주제 : ${ctx.previousSummary.title}`
      : "지난 회의가 없습니다";
    lastCard.appendChild(lastCardTitle);
    if (ctx.previousSummary?.summary) {
      const lastBody = el("div", { class: "pm-card-body" });
      lastBody.textContent = ctx.previousSummary.summary;
      lastCard.appendChild(lastBody);
    }
    leftCol.appendChild(lastCard);

    const agendaTitle = el("div", { class: "pm-section-title" });
    agendaTitle.appendChild(document.createTextNode("오늘 회의 안건"));
    leftCol.appendChild(agendaTitle);

    const agendaCard = el("div", { class: "pm-card" });
    const agendaList = el("div", { class: "pm-agenda-list" });
    const agendaItems = Array.isArray(ctx.agenda) ? ctx.agenda : [];
    if (agendaItems.length === 0) {
      agendaCard.appendChild(makeEmpty("list", "안건이 없습니다", ""));
    } else {
      agendaItems.forEach((item, idx) => {
        const row = el("div", { class: "pm-agenda-item" });
        const num = el("div", { class: "pm-agenda-num" });
        num.textContent = String(idx + 1);
        const txt = el("div", {});
        txt.textContent = item;
        row.appendChild(num);
        row.appendChild(txt);
        agendaList.appendChild(row);
      });
      agendaCard.appendChild(agendaList);
    }
    leftCol.appendChild(agendaCard);
    grid.appendChild(leftCol);

    // Right: actions
    const rightCol = el("div", {});
    const actionTitle = el("div", { class: "pm-section-title" });
    actionTitle.appendChild(document.createTextNode("회의록 작업"));
    rightCol.appendChild(actionTitle);

    const actionCard = el("div", { class: "pm-card" });

    // 회의록 길이 라디오 — 녹음 시작 시 ctx 에 머지되어 floating window의
    // context 로 전달되고, meeting_stop 단계에서 final summary 분량을 결정.
    const tierField = el("div", { class: "instant-field", style: "margin-top: 4px;" });
    tierField.appendChild(el("label", { class: "instant-field-label" }, "회의록 길이"));
    tierField.appendChild(makeLengthTierRadio());
    actionCard.appendChild(tierField);

    // Action buttons (record / upload / webex stacked)
    const actions = el("div", { class: "pm-actions" });

    const recordBtn = el("button", { type: "button", class: "pm-btn pm-btn-primary" });
    recordBtn.appendChild(document.createTextNode("녹음"));
    recordBtn.addEventListener("click", () => handleStartRecording({ ...ctx, lengthTier: pickedLengthTier }));

    const uploadBtn = el("button", { type: "button", class: "pm-btn pm-btn-dark" });
    uploadBtn.appendChild(document.createTextNode("업로드"));
    const fileInput = el("input", {
      type: "file",
      accept: "audio/*,video/*,.mp3,.wav,.m4a,.mp4,.webm,.ogg,.flac",
    });
    const statusEl = el("div", { class: "pm-status", role: "status" });
    uploadBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", (e) => {
      handleFileChosen(e, ctx, statusEl, uploadBtn);
    });

    actions.appendChild(recordBtn);
    actions.appendChild(uploadBtn);
    actionCard.appendChild(actions);
    actionCard.appendChild(fileInput);

    // Conference launcher stacked under upload. Button label dispatches on
    // conference.type; the raw URL is intentionally not repeated below it.
    //
    // Note on link opening: Ave sandboxes plugin webviews, so direct
    // window.open and <a href> navigation are blocked. handleOpenConference
    // first asks the host to open the URL externally when supported, and
    // falls back to copying the URL to the clipboard while surfacing status.
    if (isOpenableWebexConference(ctx.conference)) {
      const confLabel = conferenceLabelFor(ctx.conference.type);
      const confRow = el("div", { class: "pm-actions pm-actions-stack" });
      const confBtn = el("button", { type: "button", class: "pm-btn pm-btn-webex" });
      confBtn.appendChild(document.createTextNode(`${confLabel} 회의 참여`));
      confBtn.addEventListener("click", () => handleOpenConference(ctx, statusEl));
      confRow.appendChild(confBtn);
      actionCard.appendChild(confRow);
    }

    actionCard.appendChild(statusEl);

    rightCol.appendChild(actionCard);
    grid.appendChild(rightCol);

    root.appendChild(grid);
    viewArea.replaceChildren(root);
  }

  function makePmChip(iconNode, text) {
    const chip = el("span", { class: "pm-chip" });
    if (iconNode) chip.appendChild(iconNode);
    chip.appendChild(document.createTextNode(text));
    return chip;
  }

  // 녹음 button → `meeting_start`, which attaches the recorder card to the
  // host's floating dock. The card asks for capture itself once it is mounted
  // (meeting_recorder_begin_capture); no audio passes through either UI, since
  // the host owns the capture and hands the plugin's main process PCM frames.
  // The card owns the recording lifecycle from there; this sidebar only
  // navigates to session-detail when meeting.ended fires (subscribed below).
  //
  // Reentrancy guard: `startInFlight` blocks a second click while the
  // first call's promise chain is still settling. Without it, a fast
  // double-click could clear activeFloatingSessionId in the catch handler
  // BEFORE meeting_cancel awaits, leaving the second click free to run
  // a new meeting_start even though the cancel of the
  // first session is still racing in the background.
  /**
   * Recover from a stuck `activeFloatingSessionId`. The variable is the
   * singleton guard preventing two concurrent floating recorders, and is
   * normally cleared by the meeting.ended subscription above. If that
   * event ever fails to land (bridge race, event-bus drop), the guard
   * stays set forever and every subsequent 녹음 시작 click hits the
   * "이미 다른 회의를 녹음 중" error even though no session is actually
   * running. This helper asks the host whether the lingering sid points
   * to a session that's already finished or gone, and clears the guard
   * if so. Returns the next value the caller should write back.
   */
  async function reconcileActiveSession(currentSid) {
    if (!currentSid) return null;
    if (typeof bridge?.callTool !== "function") return currentSid;
    try {
      const detail = await bridge.callTool("meeting_session_detail", { sessionId: currentSid });
      // null   → never persisted (cancelled / never existed) → clear
      // finalized OR finalSummary → already completed → clear
      // otherwise → recording really is in flight → keep the guard
      if (!detail || detail.finalized || detail.finalSummary) return null;
      return currentSid;
    } catch {
      // Tool call failed (host gone? rare). Fail-open and clear so the
      // user isn't permanently locked out — the worst case is a stale
      // host-side session, which is recoverable via meeting_cancel.
      return null;
    }
  }

  let startInFlight = false;
  async function handleStartRecording(ctx) {
    activeFloatingSessionId = await reconcileActiveSession(activeFloatingSessionId);
    if (activeFloatingSessionId || startInFlight) return; // already recording / starting
    startInFlight = true;
    const sessionId = (typeof crypto?.randomUUID === "function")
      ? crypto.randomUUID()
      : `session-${Date.now()}`;
    activeFloatingSessionId = sessionId;
    // Merge in the user's currently-picked length tier when the caller
    // hasn't supplied one. Centralises tier propagation so legacy call
    // sites (handleOpenConference fire-and-forget) also pick it up.
    const ctxWithTier = ctx && typeof ctx === "object" && ctx.lengthTier
      ? ctx
      : { ...(ctx ?? {}), lengthTier: pickedLengthTier };
    try {
      await bridge.callTool("meeting_start", { sessionId, context: ctxWithTier });
    } catch (err) {
      console.error("[meeting-ui] failed to open floating window", err);
      // Best-effort cleanup if the window failed mid-spawn — await so
      // the next click sees a clean state rather than racing the cancel.
      try {
        await bridge.callTool("meeting_cancel", { sessionId });
      } catch (e2) {
        console.warn("[meeting-ui] orphan cancel failed", e2);
      }
      activeFloatingSessionId = null;
    } finally {
      startInFlight = false;
    }
  }

  async function handleFileChosen(event, ctx, statusEl, uploadBtn) {
    const file = event.target?.files?.[0];
    if (!file) return;
    statusEl.classList.remove("error");
    statusEl.textContent = `업로드 준비 중… (${file.name}, ${(file.size / 1024 / 1024).toFixed(1)}MB)`;
    uploadBtn.disabled = true;
    uploadInFlight = true;
    navPrepBtn.disabled = true;
    navSessionsBtn.disabled = true;
    try {
      if (file.size > LARGE_UPLOAD_RAW_MAX_BYTES) {
        throw new Error(`파일이 너무 큽니다 (최대 ${LARGE_UPLOAD_RAW_MAX_BYTES / 1024 / 1024}MB)`);
      }
      let sessionId;
      if (file.size <= LARGE_UPLOAD_INLINE_MAX_BYTES) {
        // ≤25MB: 기존 inline base64 + meeting_upload_file 경로 그대로.
        const bytesBase64 = await fileToBase64(file);
        sessionId = (crypto.randomUUID?.() ?? `upload-${Date.now()}`);
        statusEl.textContent = "업로드 + 전사 + 요약 중…";
        const result = await bridge.callTool("meeting_upload_file", {
          sessionId,
          context: ctx,
          file: { name: file.name, mimeType: file.type, bytesBase64 },
        });
        if (result?.ok === false) {
          statusEl.classList.add("error");
          statusEl.textContent = `업로드 실패: ${result.error ?? "unknown"}`;
          return;
        }
      } else {
        activeUploadAbortController = new AbortController();
        sessionId = await uploadLargeFileViaStagedChunks(file, ctx, statusEl, bridge, {
          signal: activeUploadAbortController.signal,
          onUploadId: (uploadId) => {
            activeStagedUploadId = uploadId;
          },
        });
      }
      statusEl.textContent = "완료 — 회의록으로 이동합니다";
      setView("session-detail", sessionId);
    } catch (err) {
      statusEl.classList.add("error");
      statusEl.textContent = `오류: ${(err?.message ?? err).toString().slice(0, 120)}`;
    } finally {
      uploadInFlight = false;
      activeUploadAbortController = null;
      activeStagedUploadId = null;
      navPrepBtn.disabled = false;
      navSessionsBtn.disabled = false;
      uploadBtn.disabled = false;
      event.target.value = "";
    }
  }

  async function handleOpenConference(ctx, statusEl) {
    const url = ctx.conference?.joinUrl;
    if (!isOpenableWebexConference(ctx.conference)) return;
    const setStatus = (msg, isError = false) => {
      if (!statusEl) return;
      statusEl.classList.toggle("error", isError);
      statusEl.textContent = msg;
      // Auto-clear after 3.5s so the status doesn't pile up across clicks.
      window.setTimeout(() => {
        if (statusEl.textContent === msg) statusEl.textContent = "";
      }, 3500);
    };

    // Joining a Webex meeting almost always means we want to
    // record it too, so spawn the floating recorder alongside the URL
    // open. handleStartRecording is idempotent (singleton-guarded with
    // both activeFloatingSessionId AND startInFlight), so this is safe
    // even if the user already pressed 녹음 first. Fire-and-forget
    // because the URL-open path shouldn't block on window spawn.
    handleStartRecording(ctx).catch((err) => {
      console.warn("[meeting-ui] background recorder start failed:", err);
    });

    // Primary path: hostPlugin's meeting_open_url calls Electron
    // shell.openExternal in the main process. Plugin webviews can't open
    // URLs themselves (sandboxed), but the host plugin can.
    try {
      await bridge.callTool("meeting_open_url", { url });
      setStatus("브라우저에서 회의를 엽니다…");
      return;
    } catch (err) {
      console.warn("[meeting] meeting_open_url failed, falling back to clipboard:", err);
    }

    // Fallback: clipboard copy. Two write paths — navigator.clipboard
    // (may fail in insecure contexts) → execCommand legacy.
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        setStatus("브라우저 자동 열기 실패 — URL을 복사했습니다 (붙여넣어 참여)", true);
        return;
      }
    } catch { /* fall through */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) {
        setStatus("브라우저 자동 열기 실패 — URL을 복사했습니다 (붙여넣어 참여)", true);
        return;
      }
    } catch { /* noop */ }
    setStatus("URL 열기/복사 모두 실패 — 위 주소를 직접 복사하세요", true);
  }

  function conferenceLabelFor(type) {
    switch (type) {
      case "webex": return "Webex";
      case "zoom": return "Zoom";
      case "teams": return "Teams";
      default: return "화상";
    }
  }

  function isOpenableWebexConference(conf) {
    if (!conf || conf.type !== "webex" || typeof conf.joinUrl !== "string") return false;
    try {
      const parsed = new URL(conf.joinUrl);
      const host = parsed.hostname.toLowerCase().replace(/\.+$/u, "");
      return parsed.protocol === "https:" && (host === "webex.com" || host.endsWith(".webex.com"));
    } catch {
      return false;
    }
  }

  function renderSessionList() {
    const shell = el("div", { class: "session-list-shell" });
    const toolbar = el("div", { class: "session-list-toolbar" });
    const filterSelect = document.createElement("select");
    filterSelect.className = "session-list-filter";
    filterSelect.setAttribute("aria-label", "회의록 카테고리 필터");
    populateCategorySelect(filterSelect, SESSION_CATEGORY_OPTIONS, sessionCategoryFilter, {
      allLabel: "전체 카테고리",
    });
    filterSelect.addEventListener("change", () => {
      sessionCategoryFilter = filterSelect.value || "__all__";
      try { localStorage.setItem(SESSION_CATEGORY_FILTER_KEY, sessionCategoryFilter); } catch { /* noop */ }
      renderSessionList();
    });
    toolbar.appendChild(filterSelect);
    const list = el("div", { class: "session-list" });
    shell.appendChild(toolbar);
    shell.appendChild(list);
    viewArea.replaceChildren(shell);

    Promise.all([
      bridge.callTool("meeting_sessions", {}),
      bridge.callTool("meeting_categories", {}).catch(() => ({ categories: SESSION_CATEGORY_OPTIONS })),
    ])
      .then(([sessions, categoryPayload]) => {
        const categoryOptions = Array.isArray(categoryPayload?.categories)
          ? categoryPayload.categories.map(normalizeSessionCategoryForUi)
          : SESSION_CATEGORY_OPTIONS;
        populateCategorySelect(filterSelect, categoryOptions, sessionCategoryFilter, {
          allLabel: "전체 카테고리",
        });
        if (sessionCategoryFilter !== "__all__" && !categoryOptions.includes(sessionCategoryFilter)) {
          sessionCategoryFilter = "__all__";
          populateCategorySelect(filterSelect, categoryOptions, sessionCategoryFilter, {
            allLabel: "전체 카테고리",
          });
        }
        const arr = (Array.isArray(sessions) ? [...sessions] : [])
          .filter((s) => (
            sessionCategoryFilter === "__all__"
            || normalizeSessionCategoryForUi(s?.category) === sessionCategoryFilter
          ));
        if (arr.length === 0) {
          list.replaceChildren(
            makeEmpty("list", "아직 회의록이 없습니다", "녹음을 종료하면 여기에 표시됩니다"),
          );
          return;
        }
        // Sort by createdAt (the timestamp shown on each card) descending so
        // the newest meeting sits at the top — matches user-visible time.
        arr.sort((a, b) => {
          if (a?.readOnlyGuide === true && b?.readOnlyGuide !== true) return 1;
          if (b?.readOnlyGuide === true && a?.readOnlyGuide !== true) return -1;
          const ta = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
          const tb = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
          return tb - ta;
        });
        list.replaceChildren();
        for (const s of arr) {
          const openSessionDetail = () => setView("session-detail", s.sessionId);
          const card = el("div", {
            role: "button",
            tabindex: "0",
            class: "session-card",
            onClick: openSessionDetail,
            onKeyDown: (ev) => {
              if (ev.key !== "Enter" && ev.key !== " ") return;
              ev.preventDefault();
              openSessionDetail();
            },
          });
          const head = el("div", { class: "session-card-head" });
          const titleEl = el("div", { class: "session-card-title" });
          titleEl.textContent = s.title || s.sessionId;
          head.appendChild(titleEl);

          const category = normalizeSessionCategoryForUi(s.category);
          const categoryRow = el("div", { class: "session-card-category-row" });
          const categoryBadge = el("span", { class: "session-card-category" }, category);
          if (s.readOnlyGuide === true || typeof bridge?.callTool !== "function") {
            categoryRow.appendChild(categoryBadge);
          } else {
            const select = el("select", {
              class: "session-card-category-select",
              "aria-label": `${s.title || s.sessionId} 카테고리 변경`,
              onClick: (ev) => ev.stopPropagation(),
              onPointerDown: (ev) => ev.stopPropagation(),
              onKeyDown: (ev) => ev.stopPropagation(),
              onChange: async (ev) => {
                ev.stopPropagation();
                let nextCategory = normalizeSessionCategoryForUi(select.value);
                let nextOptions = categoryOptions;
                let createdCategory = false;
                if (select.value === CATEGORY_CREATE_VALUE) {
                  try {
                    const created = await promptAndRegisterCategory(category);
                    if (!created?.category) {
                      populateCategorySelect(select, categoryOptions, category, { allowCreate: true });
                      return;
                    }
                    nextCategory = created.category;
                    nextOptions = created.categories || [...categoryOptions, nextCategory];
                    createdCategory = true;
                    populateCategorySelect(select, nextOptions, nextCategory, { allowCreate: true });
                  } catch (err) {
                    showErrorToast(`카테고리 추가 실패: ${(err?.message ?? err).toString().slice(0, 120)}`);
                    populateCategorySelect(select, categoryOptions, category, { allowCreate: true });
                    return;
                  }
                }
                select.disabled = true;
                try {
                  const result = await bridge.callTool("meeting_update_session_category", {
                    sessionId: s.sessionId,
                    category: nextCategory,
                  });
                  s.category = result?.category || nextCategory;
                  if (createdCategory || (sessionCategoryFilter !== "__all__" && normalizeSessionCategoryForUi(s.category) !== sessionCategoryFilter)) {
                    renderSessionList();
                  }
                } catch (err) {
                  showErrorToast(`카테고리 변경 실패: ${(err?.message ?? err).toString().slice(0, 120)}`);
                  select.value = category;
                } finally {
                  select.disabled = false;
                }
              },
            });
            const options = categoryOptions.includes(category)
              ? categoryOptions
              : [category, ...categoryOptions];
            populateCategorySelect(select, options, category, { allowCreate: true });
            categoryRow.appendChild(select);
          }
          head.appendChild(categoryRow);
          card.appendChild(head);

          const meta = el("div", { class: "session-card-meta" });
          meta.textContent = s.readOnlyGuide ? "처음 사용자를 위한 샘플" : fmtDateTime(s.createdAt);
          if (s.durationMs > 0) {
            const dot = el("span", { class: "dot" });
            dot.textContent = "·";
            meta.appendChild(dot);
            meta.appendChild(document.createTextNode(fmtDuration(s.durationMs)));
          }
          card.appendChild(meta);

          list.appendChild(card);
        }
      })
      .catch((err) => {
        const banner = el("div", { class: "error-banner" });
        banner.textContent = `회의록 목록을 불러오지 못했습니다: ${(err?.message ?? err).toString().slice(0, 80)}`;
        list.replaceChildren(banner);
      });
  }

  function renderSessionDetail(sessionId) {
    if (!sessionId) {
      setView("sessions");
      return;
    }
    const detail = el("div", { class: "detail" });
    viewArea.replaceChildren(detail);

    const header = el("div", { class: "detail-header" });
    const backBtn = el("button", {
      type: "button",
      class: "back-btn",
      onClick: () => setView("sessions"),
    });
    backBtn.textContent = "← 뒤로";
    header.appendChild(backBtn);
    const titleStack = el("div", { class: "detail-title-stack" });
    const titleEl = el("div", { class: "detail-title" });
    titleEl.textContent = "로딩 중…";
    titleStack.appendChild(titleEl);
    const timeEl = el("div", { class: "detail-time" });
    timeEl.textContent = "";
    titleStack.appendChild(timeEl);
    header.appendChild(titleStack);

    const metaStrip = el("div", { class: "detail-meta-strip", "aria-label": "회의록 정보" });
    const categoryChip = el("span", { class: "detail-meta-chip detail-meta-category" });
    categoryChip.textContent = "카테고리 -";
    const transcriptChip = el("span", { class: "detail-meta-chip" });
    transcriptChip.textContent = "전사 0";
    const actionChip = el("span", { class: "detail-meta-chip" });
    actionChip.textContent = "액션 0";
    const highlightChip = el("span", { class: "detail-meta-chip" });
    highlightChip.textContent = "하이라이트 0";
    metaStrip.append(categoryChip, transcriptChip, actionChip, highlightChip);
    header.appendChild(metaStrip);

    const subTabs = el("div", { class: "sub-tabs", role: "tablist", "aria-label": "세션 상세" });
    const subSummaryBtn = el("button", {
      type: "button",
      class: "sub-tab",
      role: "tab",
      "aria-selected": "true",
      "data-state": "active",
    });
    subSummaryBtn.textContent = "회의록";
    const subIntermediateBtn = el("button", {
      type: "button",
      class: "sub-tab",
      role: "tab",
      "aria-selected": "false",
      "data-state": "inactive",
    });
    subIntermediateBtn.textContent = "중간 리파인";
    const subTranscriptBtn = el("button", {
      type: "button",
      class: "sub-tab",
      role: "tab",
      "aria-selected": "false",
      "data-state": "inactive",
    });
    subTranscriptBtn.textContent = "전사";
    subTabs.appendChild(subSummaryBtn);
    subTabs.appendChild(subIntermediateBtn);
    subTabs.appendChild(subTranscriptBtn);
    header.appendChild(subTabs);
    detail.appendChild(header);

    const body = el("div", { class: "detail-body" });
    detail.appendChild(body);

    let subTab = "summary";
    let snapshot = null;

    function syncSubTabs() {
      const sync = (button, selected) => {
        button.classList.toggle("active", selected);
        button.setAttribute("aria-selected", String(selected));
        button.dataset.state = selected ? "active" : "inactive";
      };
      sync(subSummaryBtn, subTab === "summary");
      sync(subIntermediateBtn, subTab === "intermediate");
      sync(subTranscriptBtn, subTab === "transcript");
    }
    function syncDetailMeta() {
      const category = normalizeSessionCategoryForUi(
        snapshot?.category || snapshot?.context?.category || "",
      );
      const transcriptCount = Array.isArray(snapshot?.transcript) ? snapshot.transcript.length : 0;
      const actionCount = Array.isArray(snapshot?.finalSummary?.actionItems)
        ? snapshot.finalSummary.actionItems.length
        : 0;
      const highlightCount = Array.isArray(snapshot?.finalSummary?.highlights)
        ? snapshot.finalSummary.highlights.length
        : 0;
      categoryChip.textContent = `카테고리 ${category || "-"}`;
      transcriptChip.textContent = `전사 ${transcriptCount}`;
      actionChip.textContent = `액션 ${actionCount}`;
      highlightChip.textContent = `하이라이트 ${highlightCount}`;
    }
    function setSubTab(t) {
      subTab = t;
      syncSubTabs();
      renderSubTab();
    }
    subSummaryBtn.addEventListener("click", () => setSubTab("summary"));
    subIntermediateBtn.addEventListener("click", () => setSubTab("intermediate"));
    subTranscriptBtn.addEventListener("click", () => setSubTab("transcript"));

    function renderSubTab() {
      if (!snapshot) {
        body.replaceChildren(makeEmpty("clock", "데이터를 불러오는 중입니다", ""));
        return;
      }
      if (subTab === "summary") renderSubSummary();
      else if (subTab === "intermediate") renderSubIntermediate();
      else renderSubTranscript();
    }

    function renderSubSummary() {
      body.replaceChildren();
      const fs = snapshot.finalSummary;
      if (!fs) {
        // No summary yet — offer regenerate as recovery if a transcript exists
        // (covers "회의 비정상 종료 후 요약 안 만들어짐" case).
        const empty = makeEmpty(
          "sparkles",
          "최종 요약이 아직 생성되지 않았습니다",
          "회의가 비정상 종료되었거나 요약 생성에 실패한 경우입니다",
        );
        body.appendChild(empty);
        if (Array.isArray(snapshot.transcript) && snapshot.transcript.length > 0
            && typeof bridge?.callTool === "function") {
          const regenBtn = el("button", {
            type: "button",
            class: "summary-action-btn summary-action-regen",
            style: "margin-top: 10px;",
          });
          regenBtn.textContent = "🔄 지금 회의록 생성";
          regenBtn.addEventListener("click", async () => {
            regenBtn.disabled = true;
            regenBtn.textContent = "생성 중…";
            try {
              const created = await bridge.callTool("meeting_regenerate_summary", {
                sessionId,
              });
              snapshot.finalSummary = created;
              renderSubTab();
            } catch (err) {
              showErrorToast(`생성 실패: ${(err?.message ?? err).toString().slice(0, 200)}`);
              regenBtn.disabled = false;
              regenBtn.textContent = "🔄 지금 회의록 생성";
            }
          });
          body.appendChild(regenBtn);
        }
        return;
      }
      body.appendChild(buildSummaryCard(fs, "회의록", {
        sessionId,
        bridge,
        readOnly: snapshot.readOnlyGuide === true,
        clipboardMeta: {
          createdAt: snapshot.createdAt,
          participants: snapshot.context?.participants,
        },
        // Update local snapshot so subsequent sub-tab switches read the
        // new summary without forcing a full meeting_session_detail
        // refetch (server-side persisted state already updated).
        onChanged: (updated) => {
          snapshot.finalSummary = updated;
          syncDetailMeta();
        },
      }));
      renderRelatedSection();
    }

    function renderRelatedSection() {
      const related = Array.isArray(snapshot.relatedSessions) ? snapshot.relatedSessions : [];
      const relatedIds = new Set([
        ...(Array.isArray(snapshot.relatedSessionIds) ? snapshot.relatedSessionIds : []),
        ...related.map((s) => s?.sessionId).filter(Boolean),
      ]);
      const section = el("div", { class: "related-meetings" });
      const title = el("div", { class: "related-meetings-title" });
      title.appendChild(document.createTextNode(`연결된 회의 ${related.length}개`));
      section.appendChild(title);

      if (related.length > 0) {
        const list = el("div", { class: "related-meetings-list" });
        for (const item of related) {
          const row = el("div", { class: "related-meeting-row" });
          const main = el("div", {});
          const link = el("button", {
            type: "button",
            class: "related-meeting-link",
            onClick: () => setView("session-detail", item.sessionId),
          }, item.title || item.sessionId);
          main.appendChild(link);
          const meta = el("div", { class: "related-meeting-meta" });
          meta.textContent = fmtDateTime(item.createdAt);
          main.appendChild(meta);
          row.appendChild(main);
          if (snapshot.readOnlyGuide !== true) {
            const unlink = el("button", {
              type: "button",
              class: "related-meeting-unlink",
              onClick: async () => {
                unlink.disabled = true;
                try {
                  await bridge.callTool("meeting_unlink_sessions", {
                    sessionId,
                    targetSessionId: item.sessionId,
                  });
                  snapshot = await bridge.callTool("meeting_session_detail", { sessionId });
                  syncDetailMeta();
                  renderSubSummary();
                } catch (err) {
                  showErrorToast(`연결 해제 실패: ${(err?.message ?? err).toString().slice(0, 120)}`);
                  unlink.disabled = false;
                }
              },
            }, "해제");
            row.appendChild(unlink);
          }
          list.appendChild(row);
        }
        section.appendChild(list);
      } else {
        const empty = el("div", { class: "related-meeting-meta" });
        empty.textContent = "아직 연결된 회의가 없습니다.";
        section.appendChild(empty);
      }

      if (snapshot.readOnlyGuide !== true && typeof bridge?.callTool === "function") {
        const form = el("div", { class: "related-meetings-form" });
        const select = el("select", { class: "related-meetings-select" });
        select.appendChild(el("option", { value: "" }, "연결할 회의 불러오는 중..."));
        const add = el("button", {
          type: "button",
          class: "related-meetings-add",
          disabled: true,
          onClick: async () => {
            const targetSessionId = select.value;
            if (!targetSessionId) return;
            add.disabled = true;
            try {
              await bridge.callTool("meeting_link_sessions", { sessionId, targetSessionId });
              snapshot = await bridge.callTool("meeting_session_detail", { sessionId });
              syncDetailMeta();
              renderSubSummary();
            } catch (err) {
              showErrorToast(`회의 연결 실패: ${(err?.message ?? err).toString().slice(0, 120)}`);
              add.disabled = false;
            }
          },
        }, "연결");
        form.appendChild(select);
        form.appendChild(add);
        section.appendChild(form);

        bridge.callTool("meeting_sessions", {})
          .then((sessions) => {
            const options = (Array.isArray(sessions) ? sessions : [])
              .filter((s) => s?.sessionId && s.sessionId !== sessionId)
              .filter((s) => s.readOnlyGuide !== true)
              .filter((s) => !relatedIds.has(s.sessionId));
            select.replaceChildren();
            if (options.length === 0) {
              select.appendChild(el("option", { value: "" }, "연결 가능한 다른 회의가 없습니다"));
              add.disabled = true;
              return;
            }
            select.appendChild(el("option", { value: "" }, "연결할 회의 선택"));
            for (const s of options) {
              const option = el("option", { value: s.sessionId });
              option.textContent = `${s.title || s.sessionId} · ${fmtDateTime(s.createdAt)}`;
              select.appendChild(option);
            }
            add.disabled = false;
          })
          .catch(() => {
            select.replaceChildren(el("option", { value: "" }, "회의 목록을 불러오지 못했습니다"));
            add.disabled = true;
          });
      }

      body.appendChild(section);
    }

    function renderSubIntermediate() {
      body.replaceChildren();
      const items = getIntermediateEntries(snapshot);
      if (items.length === 0) {
        const transcriptCount = Array.isArray(snapshot.transcript) ? snapshot.transcript.length : 0;
        const hint = transcriptCount > 0
          ? `현재 저장된 전사 세그먼트는 ${transcriptCount}개입니다. 중간 요약은 설정된 세그먼트 임계값에 도달해야 생성됩니다.`
          : "전사 데이터가 아직 없거나, 중간 요약이 저장되기 전에 회의가 종료된 상태입니다.";
        body.appendChild(
          makeEmpty(
            "sparkles",
            "이 회의는 중간 요약이 생성되지 않았습니다",
            hint,
          ),
        );
        return;
      }
      items.forEach((entry, i) => {
        const card = el("div", { class: "intermediate-card" });
        const meta = el("div", { class: "intermediate-card-meta" });
        const left = document.createElement("span");
        left.textContent = `중간 요약 #${i + 1}`;
        meta.appendChild(left);
        const right = document.createElement("span");
        right.textContent = entry.coveredSegmentCount
          ? `세그먼트 ${entry.coveredSegmentCount}개 시점`
          : "저장된 중간 시점";
        meta.appendChild(right);
        card.appendChild(meta);
        if (entry.summary) {
          const sm = el("div", { class: "intermediate-card-summary" });
          sm.textContent = entry.summary;
          card.appendChild(sm);
        }
        if (entry.highlights.length > 0) {
          const hlList = el("div", { class: "intermediate-card-highlights" });
          for (const h of entry.highlights) {
            const hl = el("div", { class: "intermediate-card-highlight" });
            hl.textContent = String(h);
            hlList.appendChild(hl);
          }
          card.appendChild(hlList);
        }
        body.appendChild(card);
      });
    }

    function renderSubTranscript() {
      body.replaceChildren();
      const segs = Array.isArray(snapshot.transcript) ? snapshot.transcript : [];
      if (segs.length === 0) {
        body.appendChild(makeEmpty("mic", "전사가 비어 있습니다", ""));
        return;
      }
      const cache = new Map();
      const transcriptParent = el("div", { class: "transcript-pane" });
      body.appendChild(transcriptParent);
      // Display-time grouping: Whisper returns micro-segments (1–3s each)
      // so every short utterance becomes its own bubble — reads as
      // fragmented "잘려있는" text. We merge adjacent segments by the same
      // speaker when separated by a short gap, into a single readable
      // bubble. Storage is untouched (raw STT segments preserved for
      // retry/audit); this is purely a render-time concatenation that
      // benefits both old and new recordings.
      const groups = groupTranscriptForDisplay(segs);
      groups.forEach((g, idx) => {
        renderSegmentInto({
          parent: transcriptParent,
          key: `seg-${idx}`,
          original: g.text,
          speaker: g.speaker,
          startSec: g.startSec,
          streaming: false,
          speakerColourCache: cache,
          autoscroll: false,
        });
      });
    }

    setSubTab(pendingSubTab ?? "summary");
    pendingSubTab = null;

    bridge
      .callTool("meeting_session_detail", { sessionId })
      .then((res) => {
        if (!res) {
          titleEl.textContent = "(회의록을 찾을 수 없습니다)";
          body.replaceChildren(
            makeEmpty("list", "이 회의록이 존재하지 않습니다", "다른 회의록을 선택해 주세요"),
          );
          return;
        }
        snapshot = res;
        const title = res.context?.title || res.finalSummary?.title || res.sessionId;
        titleEl.textContent = title;
        timeEl.textContent = fmtDateTime(res.createdAt);
        syncDetailMeta();
        renderSubTab();
      })
      .catch((err) => {
        titleEl.textContent = "오류";
        const banner = el("div", { class: "error-banner" });
        banner.textContent = `회의록을 불러오지 못했습니다: ${(err?.message ?? err).toString().slice(0, 80)}`;
        body.replaceChildren(banner);
      });
  }


  syncNav();
  renderCurrentView();

  return () => {
    window.removeEventListener("pagehide", handlePageHide);
    cancelActiveStagedUpload("mount-dispose");
    themeHandle.dispose();
    if (typeof unsubMeetingEnded === "function") unsubMeetingEnded();
    if (typeof unsubMeetingPrepRegistered === "function") unsubMeetingPrepRegistered();
  };
}
