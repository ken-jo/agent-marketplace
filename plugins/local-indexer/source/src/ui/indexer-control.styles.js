// indexer-control.styles.js — UI 의 CSS 블록을 모은 모듈.
// indexer-control.js 의 createMarkup() 안에 인라인되어 있던 <style> 본문을
// 별도 모듈로 분리해 마크업 로직과 시각 정의를 깔끔하게 나눈다.
// v2 theme-bundle/shell selectors only — atomic cutover (PR #102). v1 data-theme removed.
//
// SDK 토큰 인라인: ave-tokens.css.js 는 SDK v6.1.0 의 토큰 팔레트에서
// 생성된 정적 스냅샷이다 (SDK v7.0.0 에서 @ave/plugin-sdk/ui/* 전체가
// 제거되어 더 이상 SDK 로부터 직접 생성할 수 없다). 본 STYLES 앞에
// 합쳐 webview 스코프 안에서 --ave-* 토큰이 활성화되도록 한다. 본 시트의
// semantic vars (--bg-base, --accent-strong, ...) 는 var(--ave-*, fallback)
// 로 이 스냅샷 값에 연결되고, 실제 색은 호스트가 프라임/브로드캐스트한
// 토큰이 덮어쓴다. bundle-specific 블록들 (violet-light/dark, tokyo-night,
// midnight, forest) 은 기존대로 스냅샷 디폴트 위에 직접 override.

import { AVE_TOKENS_CSS } from "./ave-tokens.css.js";

export const STYLES = AVE_TOKENS_CSS + `
      /*
       * Theme palette mirrors the Ave host's two-axis system (v2):
       *   data-theme-bundle = bundle id ("tokyo-night", "violet-dark", …)
       *   data-shell        = "light" | "dark"
       * v1 data-theme / data-chat-theme fully removed — atomic cutover.
       * Bundle selectors carry all accent information.
       * The plugin webview is a separate document, so host CSS does NOT
       * cascade in. We receive host.theme.changed via bridge.onEvent and
       * mirror those attributes onto our scope element (theme-sync.js).
       */
      .ave-local-indexer-ui {
        /* All semantic vars derive from SDK --ave-* tokens (scoped on
           by the inlined ave-tokens.css and overridden by the host's
           per-bundle token broadcast via plugin-ui-shell pre-paint /
           theme-sync). Fallbacks preserve the plugin's original look when
           SDK tokens are missing (older host build with no broadcast). */
        --bg-base: var(--ave-bg);
        --bg-elevated: var(--ave-surface);
        --bg-card: var(--ave-surface);
        --bg-input: var(--ave-bg);
        --bg-muted: var(--ave-secondary, color-mix(in srgb, var(--ave-surface) 88%, var(--ave-fg) 12%));
        /* v5.7+: dedicated popover/modal surface (mirrors bundle.popover);
           older hosts fall back to --ave-surface so modals still render. */
        --bg-overlay: var(--ave-surface-overlay, var(--ave-surface));
        /* v5.7+: host derives the hover tint via bundleToPluginTokens (varies
           by shell / high-contrast). Fall back to the plugin's original
           formula when the host hasn't shipped v5.7 yet. */
        --bg-hover: var(--ave-surface-hover, var(--bg-muted));
        --border: var(--ave-border);
        --border-strong: color-mix(in srgb, var(--ave-border) 60%, var(--ave-fg) 40%);
        --text: var(--ave-fg);
        --text-muted: var(--ave-fg-muted);
        --text-faint: color-mix(in srgb, var(--ave-fg-muted) 80%, var(--ave-bg, transparent) 20%);
        --text-dim: var(--ave-fg-disabled, color-mix(in srgb, var(--ave-fg-muted) 55%, var(--ave-bg, transparent) 45%));
        --accent-strong: var(--ave-primary);
        --accent-fg: var(--ave-primary-fg);
        /* Derived from --accent-strong so chat-theme overrides only need
           to set the strong color and the rest follow automatically. */
        --accent: color-mix(in srgb, var(--accent-strong) 75%, var(--accent-fg) 25%);
        --accent-hover: color-mix(in srgb, var(--accent-strong) 92%, var(--bg-card) 8%);
        --accent-surface-hover: var(--ave-primary-bg-strong, color-mix(in srgb, var(--accent-strong) 28%, var(--bg-card)));
        /* v5.7+: --ave-{primary,danger,warning,success}-bg-subtle and
           --ave-focus-shadow ship pre-mixed (formula owned by the host's
           plugin-token-map.ts:bundleToPluginTokens). Use them as the
           primary source; the inline color-mix fallback keeps the plugin
           rendering correctly on hosts that haven't broadcast v5.7 tokens. */
        --accent-glow: var(--ave-focus-shadow, color-mix(in srgb, var(--accent-strong) 35%, transparent));
        --success: var(--ave-success);
        --warning: var(--ave-warning);
        --danger: var(--ave-danger);
        --info: var(--ave-primary);
        --li-info-bg: var(--ave-primary-bg-subtle, color-mix(in srgb, var(--info) 18%, transparent));
        --radius: var(--ave-radius, 10px);
        --radius-sm: var(--ave-radius-sm, 7px);

        margin: 0;
        background: var(--bg-base);
        color: var(--text);
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        font-family: "Pretendard Variable", "Pretendard", "Noto Sans KR", "Noto Sans CJK KR", Inter, -apple-system, BlinkMacSystemFont, sans-serif;
        /* Base readable size, consistent with the meeting UI (13px).
           The view fills the host plugin-ui-shell at
           100% width/height; placement (inline sidebar vs detached pane) is
           decided by the host appMode, so the layout must read well at both
           a narrow ~300px column and a wider detached canvas. */
        font-size: 13px;
        line-height: 1.4;
        /* Counters and progress numbers (doc counts, "3 / 8 색인됨", scan %)
           tick live during a scan. Without tabular-nums each digit has a
           different width, so the surrounding label reflows on every tick. */
        font-variant-numeric: tabular-nums;
        -webkit-font-smoothing: antialiased;
        transition: background-color 150ms ease, color 150ms ease;
      }
      .ave-local-indexer-ui[data-shell="light"] {
        color-scheme: light;
        --bg-hover: var(--ave-secondary, var(--bg-muted));
        --accent-hover: color-mix(in srgb, var(--accent-strong) 90%, var(--bg-card) 10%);
      }
      .ave-local-indexer-ui[data-shell="dark"] { color-scheme: dark; }
      .ave-local-indexer-ui *,
      .ave-local-indexer-ui *::before,
      .ave-local-indexer-ui *::after { box-sizing: border-box; font-family: inherit; }
      .ave-local-indexer-ui svg { display: block; width: 100%; height: 100%; }

      /* No per-bundle / per-shell overrides here.
         The host's ThemeProvider broadcasts the full --ave-* token map
         for every bundle (forest/violet-light/violet-dark/tokyo-night/midnight/
         high-contrast) via plugin-token-map.ts:bundleToPluginTokens. The
         tokens land as inline styles on documentElement (plugin-ui-shell
         pre-paint + theme-sync onEvent), which the base block above
         resolves through var(--ave-*, fallback).
         Hardcoded bundle blocks were removed because they overrode the
         host's tokens and locked the plugin to a stale palette (e.g.
         forest = dark in the old block but the host's actual forest
         bundle is light shell). */

      .ave-local-indexer-ui .wrap {
        flex: 1; min-height: 0;
        display: flex; flex-direction: column; gap: 8px;
        /* Centered content column, fluid up to a cap. The cap was 560px, which
           left a wide panel mostly empty: folder rows and document counts are
           tabular content that reads better with room, not a prose measure. */
        width: 100%; max-width: 900px;
        margin-inline: auto;
        padding: 12px;
        overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-color: var(--border-strong) transparent;
      }
      .ave-local-indexer-ui .wrap::-webkit-scrollbar { width: 6px; }
      .ave-local-indexer-ui .wrap::-webkit-scrollbar-thumb {
        background: var(--border-strong); border-radius: 3px;
      }
      /* The wrap is a flex column that scrolls (overflow-y:auto). Flex items
         default to flex-shrink:1, so when the stacked cards are taller than the
         wrap — which happens in a narrow inline panel where card content wraps
         to more rows — they SHRINK to fit instead of the wrap scrolling, and the
         first card (scan status) collapses to a clipped sliver. Pin the direct
         children so they keep their natural height and the wrap scrolls. */
      .ave-local-indexer-ui .wrap > * { flex-shrink: 0; }

      /* ───── Topbar ───── */
      .ave-local-indexer-ui .topbar {
        display: flex; align-items: center; justify-content: space-between;
        gap: 4px; padding: 0 0 1px;
      }
      .ave-local-indexer-ui .brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .ave-local-indexer-ui .brand-icon {
        width: 28px; height: 28px; flex: none;
        display: grid; place-items: center;
        border-radius: 8px;
        background: var(--bg-hover);
        color: var(--accent);
        border: 1px solid var(--border);
      }
      .ave-local-indexer-ui .brand-icon svg { width: 15px; height: 15px; }
      .ave-local-indexer-ui .brand-text { min-width: 0; }
      .ave-local-indexer-ui .brand-title {
        font-size: 14px; font-weight: 700; color: var(--text);
        letter-spacing: -0.01em;
      }
      .ave-local-indexer-ui .brand-sub {
        font-size: 12px; color: var(--text-faint);
        display: flex; align-items: center; gap: 4px;
      }
      .ave-local-indexer-ui .brand-sub b {
        color: var(--accent-strong); font-weight: 700;
      }

      /* ───── Buttons ───── */
      .ave-local-indexer-ui button {
        border: 0; cursor: pointer;
        /* Button labels are Korean action verbs (인덱싱 시작, 폴더 선택하여 추가,
           다시 스캔, 제거…) — operational body text, not metadata, so they sit
           at the same 13px readable tier as the rest of the panel rather than
           the 12px reserved for badges/counts/timestamps. */
        font-size: 13px; font-weight: 600;
        display: inline-flex; align-items: center; justify-content: center; gap: 5px;
        padding: 6px 11px; border-radius: var(--radius-sm);
        background: var(--accent-strong); color: var(--accent-fg);
        transition: background 0.15s, color 0.15s, border-color 0.15s, transform 0.1s, box-shadow 0.15s, opacity 0.15s;
      }
      .ave-local-indexer-ui button:not(:disabled):hover { background: var(--accent-hover); }
      .ave-local-indexer-ui button:active { transform: translateY(1px); }
      .ave-local-indexer-ui button:disabled {
        cursor: not-allowed; opacity: 0.45; transform: none;
      }
      .ave-local-indexer-ui button:focus-visible,
      .ave-local-indexer-ui input[type="checkbox"]:focus-visible,
      .ave-local-indexer-ui input[type="radio"]:focus-visible {
        outline: 2px solid var(--accent-strong);
        outline-offset: 2px;
      }
      .ave-local-indexer-ui button svg { width: 14px; height: 14px; flex: none; }
      .ave-local-indexer-ui button.ghost {
        background: transparent; color: var(--text-muted);
        border: 1px solid var(--border);
      }
      .ave-local-indexer-ui button.ghost:hover {
        background: var(--bg-hover); color: var(--text); border-color: var(--border-strong);
      }
      .ave-local-indexer-ui button.danger {
        background: color-mix(in srgb, var(--danger) 16%, transparent);
        color: var(--danger);
        border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
      }
      .ave-local-indexer-ui button.danger:hover {
        background: color-mix(in srgb, var(--danger) 28%, transparent);
        color: color-mix(in srgb, var(--danger) 70%, var(--ave-danger-fg) 30%);
        border-color: color-mix(in srgb, var(--danger) 55%, transparent);
      }
      .ave-local-indexer-ui button.sm { padding: 5px 10px; font-size: 13px; }
      .ave-local-indexer-ui button.icon-only {
        padding: 0; width: 30px; height: 30px; flex: none;
      }
      .ave-local-indexer-ui button.icon-only svg { width: 15px; height: 15px; }
      .ave-local-indexer-ui button.block { width: 100%; padding: 10px 12px; font-size: 13px; }
      .ave-local-indexer-ui button.primary-cta {
        background: var(--accent-strong);
        color: var(--accent-fg);
        border: 1px solid var(--accent-strong);
        box-shadow: 0 6px 18px -4px var(--accent-glow);
      }
      .ave-local-indexer-ui button.primary-cta:hover {
        background: var(--accent-hover);
        box-shadow: 0 8px 22px -4px var(--accent-glow);
      }

      /* ───── Inputs ───── */
      .ave-local-indexer-ui .input {
        width: 100%;
        border: 1px solid var(--border); border-radius: var(--radius-sm);
        background: var(--bg-input); color: var(--text);
        font-size: 13px; padding: 8px 11px;
        outline: none;
        transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
      }
      .ave-local-indexer-ui .input::placeholder { color: var(--text-dim); }
      .ave-local-indexer-ui .input:focus {
        border-color: var(--accent-strong);
        background: var(--bg-card);
        box-shadow: 0 0 0 3px var(--ave-primary-bg-subtle);
      }
      .ave-local-indexer-ui .input:disabled { opacity: 0.5; cursor: not-allowed; }
      .ave-local-indexer-ui .search-input {
        position: relative;
      }
      .ave-local-indexer-ui .search-input .input { padding-left: 28px; }
      .ave-local-indexer-ui .search-input .search-icon {
        position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
        width: 12px; height: 12px; color: var(--text-faint); pointer-events: none;
      }

      /* ───── Cards ───── */
      /* A card carries display:flex, which outranks the UA default the hidden
         attribute relies on — so hiding one had no effect, and the 인덱싱 경고
         section stayed on screen as an empty card reading 0 whenever there was
         nothing to warn about. Scoped to .card because that is the only rule
         in this sheet that sets display on something the UI hides. */
      .ave-local-indexer-ui .card[hidden] { display: none; }
      .ave-local-indexer-ui .card {
        background: var(--bg-card);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        padding: 10px;
        display: flex; flex-direction: column; gap: 6px;
      }
      .ave-local-indexer-ui .card-head {
        display: flex; align-items: center; justify-content: space-between;
        gap: 6px;
      }
      .ave-local-indexer-ui .card-head-actions {
        margin-left: auto;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        flex: none;
      }
      .ave-local-indexer-ui .card-title {
        display: flex; align-items: center; gap: 6px;
        font-size: 12px; font-weight: 700; color: var(--text-muted);
        text-transform: uppercase; letter-spacing: 0.06em;
      }
      .ave-local-indexer-ui .card-title svg {
        width: 15px; height: 15px; color: var(--accent-strong);
      }
      .ave-local-indexer-ui .card-title .count {
        text-transform: none; letter-spacing: 0;
        font-size: 12px; font-weight: 600;
        padding: 1px 6px; border-radius: 999px;
        background: var(--bg-hover);
        color: var(--accent);
        border: 1px solid var(--border);
      }
      .ave-local-indexer-ui .collapsible-card .card-body {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }
      .ave-local-indexer-ui .collapsible-card[data-collapsed="true"] .card-body {
        display: none;
      }
      .ave-local-indexer-ui .collapsible-card.doc-section[data-collapsed="true"] {
        flex: 0 0 auto;
        min-height: 0;
      }
      .ave-local-indexer-ui .collapse-toggle {
        color: var(--text-faint);
      }
      .ave-local-indexer-ui .collapse-toggle svg {
        transition: transform 0.15s ease;
      }
      .ave-local-indexer-ui .collapsible-card[data-collapsed="true"] .collapse-toggle svg {
        transform: rotate(90deg);
      }

      /* ───── Scan card ───── */
      .ave-local-indexer-ui .scan-card {
        position: relative;
        background: var(--bg-card);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        padding: 10px;
        display: flex; flex-direction: column; gap: 5px;
        overflow: hidden;
      }
      .ave-local-indexer-ui .scan-pill {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 4px 10px; border-radius: 999px;
        font-size: 12px; font-weight: 600;
        background: var(--bg-hover); color: var(--text-muted);
        border: 1px solid var(--border);
        transition: 0.2s;
      }
      .ave-local-indexer-ui .scan-pill .scan-dot {
        width: 6px; height: 6px; border-radius: 50%;
        background: currentColor;
      }
      .ave-local-indexer-ui .scan-pill.scan-running {
        background: var(--li-info-bg); color: var(--info);
        border-color: color-mix(in srgb, var(--info) 30%, transparent);
      }
      .ave-local-indexer-ui .scan-pill.scan-running .scan-dot {
        animation: pulse 1.4s ease-in-out infinite;
      }
      .ave-local-indexer-ui .scan-pill.scan-done {
        background: var(--ave-success-bg-subtle); color: var(--success);
        border-color: color-mix(in srgb, var(--success) 30%, transparent);
      }
      .ave-local-indexer-ui .scan-pill.scan-failed {
        background: var(--ave-danger-bg-subtle); color: var(--danger);
        border-color: color-mix(in srgb, var(--danger) 30%, transparent);
      }
      .ave-local-indexer-ui .scan-pill.scan-canceled {
        background: var(--ave-warning-bg-subtle); color: var(--warning);
        border-color: color-mix(in srgb, var(--warning) 30%, transparent);
      }
      @keyframes pulse {
        0%, 100% { opacity: 1; box-shadow: 0 0 0 0 currentColor; }
        50% { opacity: 0.4; box-shadow: 0 0 0 4px transparent; }
      }
      .ave-local-indexer-ui .scan-summary {
        font-size: 13px; font-weight: 600; color: var(--text);
        line-height: 1.4;
      }
      .ave-local-indexer-ui .scan-detail {
        font-size: 12px; color: var(--text-faint);
        min-height: 12px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .ave-local-indexer-ui .progress {
        height: 5px; background: var(--bg-input);
        border-radius: 999px; overflow: hidden;
        border: 1px solid var(--border);
      }
      .ave-local-indexer-ui .progress-bar {
        height: 100%; width: 0%;
        background: var(--accent-strong);
        border-radius: 999px;
        transition: width 0.3s ease;
        position: relative;
      }
      .ave-local-indexer-ui .scan-card[data-status="running"] .progress-bar::after {
        content: ""; position: absolute; inset: 0;
         /* Use the host's primary-foreground token so the moving highlight
           stays legible without turning into a dark band on light shells. */
        background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent-fg) 42%, transparent), transparent);
        animation: shimmer 1.5s linear infinite;
      }
      @keyframes shimmer {
        from { transform: translateX(-100%); }
        to { transform: translateX(100%); }
      }
      .ave-local-indexer-ui .scan-actions { display: flex; gap: 5px; }
      .ave-local-indexer-ui .scan-actions button { flex: 1; min-width: 0; }
      .ave-local-indexer-ui .scan-actions button.icon-only { flex: none; }

      /* ───── Folders ───── */
      .ave-local-indexer-ui .folder-add-row { display: flex; gap: 6px; }
      .ave-local-indexer-ui .folder-add-row .input { flex: 1; }
      .ave-local-indexer-ui .ext-row {
        display: flex; flex-wrap: wrap; gap: 4px;
      }
      .ave-local-indexer-ui .ext-badge {
        font-size: 12px; font-weight: 700;
        padding: 3px 8px; border-radius: 4px;
        background: var(--bg-input); color: var(--text-faint);
        letter-spacing: 0.04em;
        border: 1px solid var(--border);
      }
      .ave-local-indexer-ui .folder-group {
        display: flex; flex-direction: column; gap: 4px;
      }
      .ave-local-indexer-ui .folder-group-head {
        display: flex; align-items: center; gap: 6px;
        font-size: 12px; font-weight: 700; color: var(--text-faint);
        text-transform: uppercase; letter-spacing: 0.05em;
        padding: 2px 0;
      }
      .ave-local-indexer-ui .folder-group-head .group-dot {
        width: 6px; height: 6px; border-radius: 50%;
      }
      .ave-local-indexer-ui .folder-group-head .group-dot.pending { background: var(--warning); }
      .ave-local-indexer-ui .folder-group-head .group-dot.indexed { background: var(--success); }
      .ave-local-indexer-ui .folder-group-head .group-count {
        margin-left: auto; color: var(--text-dim); font-weight: 600;
      }
      .ave-local-indexer-ui .folder-list {
        display: flex; flex-direction: column; gap: 4px;
        max-height: 168px; overflow-y: auto;
      }
      .ave-local-indexer-ui .folder-list::-webkit-scrollbar { width: 4px; }
      .ave-local-indexer-ui .folder-list::-webkit-scrollbar-thumb {
        background: var(--border-strong); border-radius: 2px;
      }
      .ave-local-indexer-ui .folder-empty {
        display: flex; align-items: center; gap: 8px;
        padding: 12px; border: 1px dashed var(--border-strong); border-radius: 8px;
        color: var(--text-dim); font-size: 13px;
      }
      .ave-local-indexer-ui .folder-empty svg {
        width: 18px; height: 18px; flex: none; color: var(--text-dim);
      }
      .ave-local-indexer-ui .folder-item {
        display: flex; flex-direction: column; gap: 4px;
        padding: 7px;
        background: var(--bg-elevated);
        border: 1px solid var(--border); border-radius: 6px;
        font-size: 12px;
        transition: border-color 0.15s, background 0.15s;
      }
      .ave-local-indexer-ui .folder-item:hover {
        border-color: var(--border-strong);
        background: var(--bg-hover);
      }
      .ave-local-indexer-ui .folder-top {
        display: flex; align-items: center; gap: 8px;
      }
      .ave-local-indexer-ui .folder-icon {
        width: 26px; height: 26px; flex: none;
        display: grid; place-items: center;
        border-radius: 6px;
        background: var(--bg-hover);
        color: var(--accent);
        border: 1px solid var(--border);
      }
      .ave-local-indexer-ui .folder-icon svg { width: 14px; height: 14px; }
      .ave-local-indexer-ui .folder-path {
        flex: 1; min-width: 0;
        font-size: 13px; font-weight: 500; color: var(--text);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        direction: rtl; text-align: left;
      }
      .ave-local-indexer-ui .folder-badge {
        flex: none;
        font-size: 12px; font-weight: 700;
        padding: 3px 8px; border-radius: 999px;
        background: var(--bg-input); color: var(--text-muted);
        letter-spacing: 0.02em;
      }
      .ave-local-indexer-ui .folder-badge.indexed { background: var(--ave-success-bg-subtle); color: var(--success); }
      .ave-local-indexer-ui .folder-badge.needs_scan { background: var(--ave-warning-bg-subtle); color: var(--warning); }
      .ave-local-indexer-ui .folder-badge.images_disabled { background: var(--ave-warning-bg-subtle); color: var(--warning); }
      .ave-local-indexer-ui .folder-badge.empty { background: var(--bg-input); color: var(--text-faint); }
      .ave-local-indexer-ui .folder-badge.missing { background: var(--ave-danger-bg-subtle); color: var(--danger); }
      .ave-local-indexer-ui .folder-meta {
        font-size: 12px; color: var(--text-faint);
        display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
      }
      .ave-local-indexer-ui .folder-meta .dot-sep { color: var(--text-dim); }
      .ave-local-indexer-ui .folder-actions {
        display: flex; gap: 5px; justify-content: flex-end;
      }

      /* ───── Documents ───── */
      .ave-local-indexer-ui .doc-section {
        flex: 1; min-height: 72px;
        display: flex; flex-direction: column; gap: 4px;
      }
      .ave-local-indexer-ui .doc-list {
        display: flex; flex-direction: column; gap: 5px;
        min-height: 0;
      }
      .ave-local-indexer-ui .doc-item {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 8px;
        background: var(--bg-elevated);
        border: 1px solid var(--border); border-radius: 6px;
        cursor: default;
        transition: border-color 0.15s, background 0.15s;
      }
      .ave-local-indexer-ui .doc-item:hover {
        /* Hover is a subtle semantic surface tint only — no positional shift
           (the row previously translated 2px on hover, which reads as a
           layout nudge rather than a state tint). */
        border-color: var(--border-strong);
        background: var(--bg-hover);
      }
      .ave-local-indexer-ui .doc-icon-tile {
        width: 32px; height: 32px; flex: none;
        display: grid; place-items: center;
        border-radius: 7px;
        font-size: 15px;
        background: var(--bg-hover); color: var(--accent);
        border: 1px solid var(--border);
      }
         /* Document-type tile palette.
            Keep the mapping semantic and token-driven so host bundles own
            the actual hue values. */
      .ave-local-indexer-ui .doc-icon-tile.t-pdf {
        background: color-mix(in srgb, var(--ave-danger) 15%, transparent);
        color: var(--ave-danger);
      }
      .ave-local-indexer-ui .doc-icon-tile.t-docx {
        background: color-mix(in srgb, var(--ave-primary) 15%, transparent);
        color: var(--ave-primary);
      }
      .ave-local-indexer-ui .doc-icon-tile.t-pptx {
        background: color-mix(in srgb, var(--ave-warning) 15%, transparent);
        color: var(--ave-warning);
      }
      .ave-local-indexer-ui .doc-icon-tile.t-xlsx {
        background: color-mix(in srgb, var(--ave-success) 15%, transparent);
        color: var(--ave-success);
      }
      .ave-local-indexer-ui .doc-icon-tile.t-md,
      .ave-local-indexer-ui .doc-icon-tile.t-markdown {
        background: color-mix(in srgb, var(--ave-ring) 15%, transparent);
        color: var(--ave-ring);
      }
      .ave-local-indexer-ui .doc-icon-tile.t-txt {
        background: color-mix(in srgb, var(--ave-fg-muted) 15%, transparent);
        color: var(--ave-fg-muted);
      }
      .ave-local-indexer-ui .doc-icon-tile.t-html {
        background: color-mix(in srgb, var(--ave-primary) 15%, transparent);
        color: color-mix(in srgb, var(--ave-primary) 80%, var(--ave-ring) 20%);
      }
      .ave-local-indexer-ui .doc-info { flex: 1; min-width: 0; }
      .ave-local-indexer-ui .doc-name {
        font-size: 13px; font-weight: 600; color: var(--text);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .ave-local-indexer-ui .doc-meta {
        font-size: 12px; color: var(--text-faint);
        margin-top: 3px;
        display: flex; align-items: center; gap: 6px; flex-wrap: nowrap;
        overflow: hidden;
      }
      .ave-local-indexer-ui .doc-meta .type-tag {
        font-weight: 700; color: var(--text-muted);
        letter-spacing: 0.04em;
      }
      .ave-local-indexer-ui .doc-meta .doc-path {
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        min-width: 0; flex: 1;
      }
      /* min-width:0 + overflow-wrap keep this from pushing past the panel.
         As a flex item it defaults to min-width:auto, so it refuses to shrink
         below its own min-content width — one unbreakable run (an error string
         or a file path in the empty/failed state) then makes the whole box
         wider than the column. Measured overflowing at a 420px panel. */
      .ave-local-indexer-ui .doc-empty {
        padding: 22px 16px; text-align: center;
        color: var(--text-dim); font-size: 13px; line-height: 1.5;
        border: 1px dashed var(--border-strong); border-radius: 10px;
        display: flex; flex-direction: column; align-items: center; gap: 10px;
        white-space: pre-line;
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .ave-local-indexer-ui .doc-empty svg {
        width: 24px; height: 24px; color: var(--text-dim);
      }

      /* ───── Folder preview modal ───── */
      .ave-local-indexer-ui .preview-overlay {
        position: fixed; inset: 0;
        background: color-mix(in srgb, var(--ave-bg) 55%, transparent);
        backdrop-filter: blur(3px);
        z-index: 1000;
        display: flex; align-items: center; justify-content: center;
        padding: 16px;
        animation: fade-in 0.12s ease-out;
      }
      @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
      .ave-local-indexer-ui .preview-modal {
        background: var(--bg-overlay);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        width: 100%; max-width: 480px; max-height: 90vh;
        display: flex; flex-direction: column;
        box-shadow: var(--ave-shadow-md);
        overflow: hidden;
      }
      .ave-local-indexer-ui .preview-head {
        padding: 14px 16px;
        border-bottom: 1px solid var(--border);
        display: flex; align-items: center; gap: 8px;
      }
      .ave-local-indexer-ui .preview-head svg { width: 16px; height: 16px; color: var(--accent-strong); flex: none; }
      .ave-local-indexer-ui .preview-title {
        font-size: 13px; font-weight: 700; color: var(--text);
      }
      .ave-local-indexer-ui .preview-body {
        flex: 1; overflow-y: auto;
        padding: 8px;
        display: flex; flex-direction: column; gap: 6px;
        scrollbar-width: thin;
        scrollbar-color: var(--border-strong) transparent;
      }
      .ave-local-indexer-ui .preview-body::-webkit-scrollbar { width: 6px; }
      .ave-local-indexer-ui .preview-body::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 3px; }
      .ave-local-indexer-ui .preview-row {
        display: flex; gap: 10px;
        padding: 10px;
        background: var(--bg-elevated);
        border: 1px solid var(--border);
        border-radius: 8px;
        cursor: pointer;
        transition: border-color 0.15s, background 0.15s;
      }
      .ave-local-indexer-ui .preview-row:hover {
        border-color: var(--border-strong);
        background: var(--bg-hover);
      }
      .ave-local-indexer-ui .preview-row.disabled {
        opacity: 0.55; cursor: not-allowed;
      }
      .ave-local-indexer-ui .preview-row input[type="checkbox"] {
        flex: none; margin-top: 2px;
        width: 15px; height: 15px;
        accent-color: var(--accent-strong);
        cursor: pointer;
      }
      .ave-local-indexer-ui .preview-row.disabled input[type="checkbox"] { cursor: not-allowed; }
      .ave-local-indexer-ui .preview-row-body { flex: 1; min-width: 0; }
      .ave-local-indexer-ui .preview-folder {
        /* Same content as .folder-path (a registered/candidate folder path) —
           keep the two at the same 13px tier instead of drifting to 12px
           just because this one renders inside the preview modal. */
        font-size: 13px; font-weight: 600; color: var(--text);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        direction: rtl; text-align: left;
      }
      .ave-local-indexer-ui .preview-meta {
        font-size: 12px; color: var(--accent-strong);
        margin-top: 3px;
        font-weight: 600;
      }
      .ave-local-indexer-ui .preview-meta.empty { color: var(--text-faint); font-weight: 500; }
      .ave-local-indexer-ui .preview-meta.error { color: var(--danger); }
      .ave-local-indexer-ui .preview-files {
        margin-top: 6px;
        font-size: 12px; color: var(--text-faint);
        line-height: 1.5;
      }
      .ave-local-indexer-ui .preview-files .preview-file-name {
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .ave-local-indexer-ui .preview-files .more { color: var(--text-dim); font-style: italic; }
      .ave-local-indexer-ui .preview-foot {
        padding: 12px 14px;
        border-top: 1px solid var(--border);
        display: flex; gap: 8px; justify-content: flex-end;
        background: var(--bg-card);
      }
      .ave-local-indexer-ui .preview-foot .summary {
        margin-right: auto; align-self: center;
        font-size: 12px; color: var(--text-faint);
      }

      /* ───── Embedding settings card ───── */
      .ave-local-indexer-ui .settings-toggle {
        display: flex; align-items: flex-start; gap: 8px;
        flex-wrap: wrap;
        padding: 6px 4px 3px;
        cursor: pointer;
        user-select: none;
      }
      .ave-local-indexer-ui .settings-toggle input[type="checkbox"] {
        flex: none; width: 14px; height: 14px;
        margin-top: 1px;
        accent-color: var(--accent-strong);
        cursor: pointer;
      }
      .ave-local-indexer-ui .settings-toggle .settings-toggle-label {
        flex: 1 1 auto;
        min-width: 0;
        font-size: 13px; font-weight: 600; color: var(--text);
      }
      .ave-local-indexer-ui .settings-toggle .settings-toggle-sub {
        flex: 1 0 100%;
        margin-left: 22px;
        margin-top: -1px;
        /* Full-sentence Korean copy ("PPTX/PDF/DOCX/XLSX 내부 이미지 …") is
           body text, not metadata — keep it at the panel's 13px readable
           tier rather than the 12px reserved for badges/counts/timestamps. */
        font-size: 13px;
        line-height: 1.35;
        color: var(--text-faint);
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .ave-local-indexer-ui [data-role="providerNotice"] {
        margin-top: 2px !important;
        font-size: 13px;
        line-height: 1.35;
      }
      .ave-local-indexer-ui .provider-row {
        display: flex; gap: 8px;
        padding: 2px 4px 8px;
      }
      .ave-local-indexer-ui .provider-row label {
        flex: 1;
        display: inline-flex; align-items: center; gap: 6px;
        padding: 6px 10px;
        border: 1px solid var(--border); border-radius: var(--radius-sm);
        background: var(--bg-input);
        font-size: 12px; font-weight: 500; color: var(--text-muted);
        cursor: pointer;
        transition: border-color 0.15s, background 0.15s, color 0.15s, box-shadow 0.15s;
      }
      .ave-local-indexer-ui .provider-row label:hover {
        border-color: var(--border-strong); background: var(--bg-hover); color: var(--text);
      }
      .ave-local-indexer-ui .provider-row input[type="radio"] {
        flex: none; accent-color: var(--accent-strong);
        cursor: pointer;
      }
      .ave-local-indexer-ui .provider-row label.selected {
        border-color: var(--accent-strong);
        background: var(--accent-strong);
        color: var(--accent-fg);
        box-shadow: 0 6px 18px -4px var(--accent-glow);
      }
      .ave-local-indexer-ui .provider-row label.selected:hover {
        border-color: var(--accent-hover);
        background: var(--accent-hover);
        color: var(--accent-fg);
      }
      .ave-local-indexer-ui .provider-row label.selected input[type="radio"] {
        accent-color: var(--accent-fg);
      }
      .ave-local-indexer-ui .provider-row label.disabled {
        opacity: 0.5; cursor: not-allowed;
      }
      /* 빨간 underline + 경고 텍스트 — 이미지 임베딩이 OpenAI 비용 또는 모델 다운로드를
         수반함을 사용자가 토글 전후로 모두 인지하도록 항상 표시한다. */
      .ave-local-indexer-ui .cost-warning {
        padding-top: 6px;
        border-top: 2px solid var(--danger);
        display: flex; flex-direction: column; gap: 4px;
      }
      .ave-local-indexer-ui .cost-warning-title {
        font-size: 12px; font-weight: 700; color: var(--danger);
        display: inline-flex; align-items: center; gap: 4px;
        letter-spacing: 0.02em;
      }
      .ave-local-indexer-ui .cost-warning-text {
        font-size: 13px; color: var(--text-muted); line-height: 1.4;
      }
      .ave-local-indexer-ui .cost-warning-text b {
        color: var(--text); font-weight: 600;
      }
      .ave-local-indexer-ui .cost-warning .api-key-error {
        font-size: 13px; color: var(--danger); font-weight: 600; line-height: 1.4;
      }
      .ave-local-indexer-ui .warning-group {
        margin-top: 8px;
        border: 1px solid var(--border);
        border-radius: 10px;
        background: var(--bg-base);
        overflow: hidden;
      }
      .ave-local-indexer-ui .warning-group-summary {
        cursor: pointer;
        list-style: none;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 8px 10px;
        font-size: 12px;
        color: var(--text);
        background: var(--bg-card);
      }
      .ave-local-indexer-ui .warning-group.warning-general {
        border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
        background: var(--ave-danger-bg-subtle, color-mix(in srgb, var(--danger) 12%, var(--bg-base)));
      }
      .ave-local-indexer-ui .warning-group.warning-general .warning-group-summary {
        background: var(--ave-danger-bg-subtle, color-mix(in srgb, var(--danger) 12%, var(--bg-card)));
        color: var(--danger);
        font-size: 13px;
        font-weight: 800;
      }
      .ave-local-indexer-ui .warning-group-summary::-webkit-details-marker {
        display: none;
      }
      .ave-local-indexer-ui .warning-group-title {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ave-local-indexer-ui .warning-group-body {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 8px 10px 10px;
      }
      .ave-local-indexer-ui .warning-item {
        /* Match .warning-item-general's 13px — both render the same kind of
           warning message text, just grouped differently. */
        font-size: 13px;
        color: var(--text-muted);
        line-height: 1.4;
        word-break: break-word;
      }
      .ave-local-indexer-ui .warning-item .warning-message {
        word-break: break-word;
      }
      .ave-local-indexer-ui .warning-item-general {
        font-size: 13px;
        color: var(--danger);
        font-weight: 800;
        line-height: 1.5;
      }

      /* ───── Status bar ───── */
      .ave-local-indexer-ui .status-bar {
        flex-shrink: 0;
        font-size: 12px; color: var(--text-faint);
        border-top: 1px solid var(--border);
        padding: 8px 12px;
        background: var(--bg-card);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }

      /* ───── Reduced motion ─────
         The running-scan pulse/shimmer, the modal fade-in, the button press
         and doc-item hover transitions, and the collapse-toggle chevron
         rotation are all confirmation/enhancement motion, not carriers of
         information the state text does not already say. Collapse them to
         near-zero duration under reduced-motion, per the panel mandate. */
      @media (prefers-reduced-motion: reduce) {
        .ave-local-indexer-ui *,
        .ave-local-indexer-ui *::before,
        .ave-local-indexer-ui *::after {
          animation-duration: 0.001ms !important;
          animation-iteration-count: 1 !important;
          transition-duration: 0.001ms !important;
          scroll-behavior: auto !important;
        }
      }
    `;
