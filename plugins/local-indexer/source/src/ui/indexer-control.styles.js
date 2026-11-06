// Local Indexer styles, using standard MCP Apps host-context variables.
export const STYLES = `
      .ave-local-indexer-ui {

        --bg-base: var(--color-background-primary);
        --bg-elevated: var(--color-background-secondary);
        --bg-card: var(--color-background-secondary);
        --bg-input: var(--color-background-primary);
        --bg-muted: var(--color-background-tertiary, color-mix(in srgb, var(--color-background-secondary) 88%, var(--color-text-primary) 12%));

        --bg-overlay: var(--color-background-tertiary, var(--color-background-secondary));

        --bg-hover: var(--color-background-tertiary, var(--bg-muted));
        --border: var(--color-border-primary);
        --border-strong: color-mix(in srgb, var(--color-border-primary) 60%, var(--color-text-primary) 40%);
        --text: var(--color-text-primary);
        --text-muted: var(--color-text-secondary);
        --text-faint: color-mix(in srgb, var(--color-text-secondary) 80%, var(--color-background-primary, transparent) 20%);
        --text-dim: var(--color-text-disabled, color-mix(in srgb, var(--color-text-secondary) 55%, var(--color-background-primary, transparent) 45%));
        --accent-strong: var(--color-text-info);
        --accent-fg: var(--color-text-inverse);

        --accent: color-mix(in srgb, var(--accent-strong) 75%, var(--accent-fg) 25%);
        --accent-hover: color-mix(in srgb, var(--accent-strong) 92%, var(--bg-card) 8%);
        --accent-surface-hover: var(--color-background-info, color-mix(in srgb, var(--accent-strong) 28%, var(--bg-card)));

        --accent-glow: var(--color-ring-primary, color-mix(in srgb, var(--accent-strong) 35%, transparent));
        --success: var(--color-text-success);
        --warning: var(--color-text-warning);
        --danger: var(--color-text-danger);
        --info: var(--color-text-info);
        --li-info-bg: var(--color-background-info, color-mix(in srgb, var(--info) 18%, transparent));
        --radius: var(--border-radius-md, 10px);
        --radius-sm: var(--border-radius-sm, 7px);

        margin: 0;
        background: var(--bg-base);
        color: var(--text);
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        font-family: var(--font-sans, sans-serif);

        font-size: 13px;
        line-height: 1.4;

        font-variant-numeric: tabular-nums;
        -webkit-font-smoothing: antialiased;
        transition: background-color 150ms ease, color 150ms ease;
      }
      .ave-local-indexer-ui[data-shell="light"] {
        color-scheme: light;
        --bg-hover: var(--color-background-tertiary, var(--bg-muted));
        --accent-hover: color-mix(in srgb, var(--accent-strong) 90%, var(--bg-card) 10%);
      }
      .ave-local-indexer-ui[data-shell="dark"] { color-scheme: dark; }
      .ave-local-indexer-ui *,
      .ave-local-indexer-ui *::before,
      .ave-local-indexer-ui *::after { box-sizing: border-box; font-family: inherit; }
      .ave-local-indexer-ui svg { display: block; width: 100%; height: 100%; }

      .ave-local-indexer-ui .wrap {
        flex: 1; min-height: 0;
        display: flex; flex-direction: column; gap: 8px;

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

      .ave-local-indexer-ui .wrap > * { flex-shrink: 0; }

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

      .ave-local-indexer-ui button {
        border: 0; cursor: pointer;

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
        color: color-mix(in srgb, var(--danger) 70%, var(--danger-fg) 30%);
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
        box-shadow: 0 0 0 3px var(--color-background-info);
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
        background: var(--color-background-success); color: var(--success);
        border-color: color-mix(in srgb, var(--success) 30%, transparent);
      }
      .ave-local-indexer-ui .scan-pill.scan-failed {
        background: var(--color-background-danger); color: var(--danger);
        border-color: color-mix(in srgb, var(--danger) 30%, transparent);
      }
      .ave-local-indexer-ui .scan-pill.scan-canceled {
        background: var(--color-background-warning); color: var(--warning);
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
      .ave-local-indexer-ui .folder-badge.indexed { background: var(--color-background-success); color: var(--success); }
      .ave-local-indexer-ui .folder-badge.needs_scan { background: var(--color-background-warning); color: var(--warning); }
      .ave-local-indexer-ui .folder-badge.images_disabled { background: var(--color-background-warning); color: var(--warning); }
      .ave-local-indexer-ui .folder-badge.empty { background: var(--bg-input); color: var(--text-faint); }
      .ave-local-indexer-ui .folder-badge.missing { background: var(--color-background-danger); color: var(--danger); }
      .ave-local-indexer-ui .folder-meta {
        font-size: 12px; color: var(--text-faint);
        display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
      }
      .ave-local-indexer-ui .folder-meta .dot-sep { color: var(--text-dim); }
      .ave-local-indexer-ui .folder-actions {
        display: flex; gap: 5px; justify-content: flex-end;
      }

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

      .ave-local-indexer-ui .doc-icon-tile.t-pdf {
        background: color-mix(in srgb, var(--color-text-danger) 15%, transparent);
        color: var(--color-text-danger);
      }
      .ave-local-indexer-ui .doc-icon-tile.t-docx {
        background: color-mix(in srgb, var(--color-text-info) 15%, transparent);
        color: var(--color-text-info);
      }
      .ave-local-indexer-ui .doc-icon-tile.t-pptx {
        background: color-mix(in srgb, var(--color-text-warning) 15%, transparent);
        color: var(--color-text-warning);
      }
      .ave-local-indexer-ui .doc-icon-tile.t-xlsx {
        background: color-mix(in srgb, var(--color-text-success) 15%, transparent);
        color: var(--color-text-success);
      }
      .ave-local-indexer-ui .doc-icon-tile.t-md,
      .ave-local-indexer-ui .doc-icon-tile.t-markdown {
        background: color-mix(in srgb, var(--ring) 15%, transparent);
        color: var(--ring);
      }
      .ave-local-indexer-ui .doc-icon-tile.t-txt {
        background: color-mix(in srgb, var(--color-text-secondary) 15%, transparent);
        color: var(--color-text-secondary);
      }
      .ave-local-indexer-ui .doc-icon-tile.t-html {
        background: color-mix(in srgb, var(--color-text-info) 15%, transparent);
        color: color-mix(in srgb, var(--color-text-info) 80%, var(--ring) 20%);
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

      .ave-local-indexer-ui .preview-overlay {
        position: fixed; inset: 0;
        background: color-mix(in srgb, var(--color-background-primary) 55%, transparent);
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
        box-shadow: var(--shadow-md);
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
        background: var(--color-background-danger, color-mix(in srgb, var(--danger) 12%, var(--bg-base)));
      }
      .ave-local-indexer-ui .warning-group.warning-general .warning-group-summary {
        background: var(--color-background-danger, color-mix(in srgb, var(--danger) 12%, var(--bg-card)));
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

      .ave-local-indexer-ui .status-bar {
        flex-shrink: 0;
        font-size: 12px; color: var(--text-faint);
        border-top: 1px solid var(--border);
        padding: 8px 12px;
        background: var(--bg-card);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }

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
