/*
 * Recorder card — a slot in the host's floating dock.
 *
 * It used to be a whole window this plugin opened for itself: a frameless,
 * transparent, always-on-top `BrowserWindow` built through a variable-held
 * `require("electron")`, with twelve private `ipcMain` channels behind it.
 * That is ambient axis 2 in the host's routing SOT, and it was the one reason
 * this plugin could not run out of process.
 *
 * The window moved to the host. `hostApi.attachFloatingPanel` gives this card
 * a slot in the ONE dock the host owns — host-drawn chrome around it, host
 * geometry, a host-enforced cap on how much screen it can take — and the
 * feature survives intact, because a recorder you can see while you are
 * looking at the meeting was always the point.
 *
 * WHAT CHANGED HERE, and nothing else: the twelve IPC channels became tool
 * calls over the bridge every plugin card already has, and the document became
 * a `root` element. The timer, the waveform, the notes and the four buttons
 * are the same code they were.
 *
 * NO AUDIO PASSES THROUGH THIS CARD, and none did through the window it
 * replaced. The host captures as first-party code and hands this plugin's main
 * process frames of PCM; every audio decision — which sources to open, when a
 * chunk ends, what a pause means — is made in `hostPlugin.ts` and asked for
 * from here as data.
 *
 * UX (unchanged):
 *   [ Note | Meeting ]   • 00:00
 *   ▁▂▃▅█▇▅▂▁ waveform / Notes text
 *   [× Cancel] [⏸ Pause/Resume] [✓ Done]
 */

// Tokens come from the host's plugin UI shell — the same bridge a sidebar
// card gets, with `getTheme()` and a `host.theme.changed` subscription
// already on it. There is no plugin-owned theme channel any more: two
// sources for one value means one of them can be stale, and the stale one
// would have been the plugin's.
// The vendored ./prime-theme.js (copied from plugin-sdk v6.1.0 — SDK
// v7.0.0 removed its UI surface)
// handles validation + token paint on document.documentElement, so this
// file no longer hand-rolls applyTheme / OS-preference cold-start /
// localStorage persistence dance — primeTheme's getTheme() races
// against the shell's own paint and the first valid payload wins
// idempotently.
//
// Build: bundled by tsup (browser target) — see tsup.config.ts ui entry.
// The document and its CSP belong to the host's plugin UI shell now; this
// file is a module the shell imports and calls `mount()` on, exactly as it
// does for a sidebar card.
import { primeTheme } from "./prime-theme.js";

/**
 * The twelve private IPC channels, as tool calls.
 *
 * Every one of these used to be an `ipcMain.handle("meeting-floating:…")` this
 * plugin registered for itself. They are now ordinary tools the plugin already
 * exposes, reached through the bridge every plugin card has — so the card gets
 * no channel of its own, and the host sees each call the way it sees any other
 * tool invocation.
 *
 * The ones that are not in the model's tool list carry
 * `_meta.ui.visibility: ["app"]` in the manifest: a microphone enumeration is
 * something this card needs and nothing an assistant should be choosing to do.
 */
function hostAdapter(bridge) {
  // Each entry names its tool at the call site rather than through a `call`
  // helper. The indirection read better and made the names invisible to
  // `test/manifest.test.ts`, which scans this file for `callTool("…")` to
  // check every tool it invokes carries app visibility — a tool that does not
  // is rejected by the host with nothing here to say why.
  return {
    getInit: () => bridge.callTool("meeting_recorder_state", {}),
    getDetail: (sessionId) => bridge.callTool("meeting_session_detail", { sessionId }),
    getLevels: () => bridge.callTool("meeting_recorder_levels", {}),
    listMicrophones: () => bridge.callTool("meeting_recorder_microphones", {}),
    restartCapture: (opts) => bridge.callTool("meeting_recorder_restart_capture", opts ?? {}),
    setPaused: (paused) => bridge.callTool("meeting_recorder_set_paused", { paused }),
    // NOT `meeting_start`. That tool is what attaches this card, so calling it
    // from inside the card is the card asking to be created again. Beginning
    // capture is a separate moment and a separate tool — the card cannot ask
    // for audio before it exists.
    //
    // `sessionId` is accepted and dropped: the host plugin acts on the session
    // its one attached panel is for, and honouring an argument here would undo
    // the ACL the old sender-keyed IPC had.
    start: (_sessionId, context, opts) =>
      bridge.callTool("meeting_recorder_begin_capture", { context, ...(opts ?? {}) }),
    stop: (sessionId, opts) => bridge.callTool("meeting_stop", { sessionId, ...(opts ?? {}) }),
    cancel: (sessionId) => bridge.callTool("meeting_cancel", { sessionId }),
    // The card measures its own content and asks; the host clamps and is the
    // only thing that decides. A card cannot grow its slot past the dock cap
    // however large a number it sends.
    resize: (height) => bridge.callTool("meeting_recorder_resize", { height }),
    // Detaching the slot is the plugin's to do — the card asks, and
    // `hostPlugin.ts` releases the handle it holds.
    close: () => bridge.callTool("meeting_recorder_close", {}),
  };
}

/**
 * Build the recorder into `root`.
 *
 * The dock mounts this the same way the sidebar mounts a panel: same
 * `plugin-ui-shell.html`, same bridge, same `mount({ root, bridge })`
 * contract. Nothing here knows it is in a floating window.
 */
export default async function mount({ root, bridge }) {
  const host = hostAdapter(bridge);

// Side-effect: inject `--ave-*` fallback tokens. Replaces the old
// `/* @sdk-tokens */` sentinel substitution that copy-build-assets.mjs used to
// perform on the unbundled file. Without this, cold-start before the shell
// primes would render against `var(--ave-*, #hex)` fallbacks in the STYLES
// block — still legible but missing the SDK's polarity defaults.
const STYLES = `
/* @sdk-tokens */
.shell { --w: 100%; --h: 100%; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; }

.shell {
  /* shadcn-compatible semantic layer backed by host-owned Ave tokens. */
  --background:              var(--ave-bg);
  --foreground:              var(--ave-fg);
  --card:                    var(--ave-surface);
  --card-foreground:         var(--ave-fg);
  --popover:                 var(--ave-surface);
  --popover-foreground:      var(--ave-fg);
  --primary:                 var(--ave-primary);
  --primary-foreground:      var(--ave-primary-fg);
  --secondary:               var(--ave-secondary);
  --secondary-foreground:    var(--ave-secondary-fg);
  --muted:                   var(--ave-secondary);
  --muted-foreground:        var(--ave-fg-muted);
  --accent:                  color-mix(in srgb, var(--ave-primary) 12%, var(--ave-surface));
  --accent-foreground:       var(--ave-fg);
  --destructive:             var(--ave-danger);
  --destructive-foreground:  var(--ave-danger-fg);
  --border:                  var(--ave-border);
  --input:                   var(--ave-border);
  --ring:                    var(--ave-ring);
  --success:                 var(--ave-success);
  --success-foreground:      var(--ave-success-fg);
  --warning:                 var(--ave-warning);
  --warning-foreground:      var(--ave-warning-fg);
  --radius:                  var(--ave-radius,       8px);
  --radius-sm:               var(--ave-radius-sm,    6px);
  --radius-full:             var(--ave-radius-full,  999px);

  /* Legacy aliases kept as a thin compatibility layer while styles converge. */
  --bg:               var(--background);
  --surface:          var(--card);
  --surface-2:        var(--muted);
  --surface-2-hover:  color-mix(in srgb, var(--foreground) 8%, var(--muted));
  --text-1:           var(--foreground);
  --text-2:           var(--muted-foreground);
  --text-3:           var(--muted-foreground);
  --danger:           var(--destructive);
  --danger-bg:        color-mix(in srgb, var(--destructive) 14%, transparent);
  --danger-bg-hover:  color-mix(in srgb, var(--destructive) 26%, transparent);
  --success-bg:       color-mix(in srgb, var(--success) 16%, transparent);
  --success-bg-hover: color-mix(in srgb, var(--success) 28%, transparent);
  --inverse:          var(--primary);
  --inverse-fg:       var(--primary-foreground);
  --toggle-hover-bg:  color-mix(in srgb, var(--primary) 14%, var(--card));
  --toggle-hover-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--ring) 34%, transparent),
    0 1px 3px rgba(0, 0, 0, .08);
  --toggle-selected-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--primary-foreground) 18%, transparent),
    0 2px 8px color-mix(in srgb, var(--primary) 28%, transparent);
  --motion-fast:      var(--ave-motion-fast, 160ms);
  --shadow:           0 12px 32px rgba(0, 0, 0, .18), 0 4px 10px rgba(0, 0, 0, .08);
}

.shell[data-shell="dark"] {
  --background:              var(--ave-bg);
  --foreground:              var(--ave-fg);
  --card:                    var(--ave-surface);
  --card-foreground:         var(--ave-fg);
  --popover:                 var(--ave-surface);
  --popover-foreground:      var(--ave-fg);
  --primary:                 var(--ave-primary);
  --primary-foreground:      var(--ave-primary-fg);
  --secondary:               var(--ave-secondary);
  --secondary-foreground:    var(--ave-secondary-fg);
  --muted:                   var(--ave-secondary);
  --muted-foreground:        var(--ave-fg-muted);
  --accent:                  color-mix(in srgb, var(--ave-primary) 18%, var(--ave-surface));
  --accent-foreground:       var(--ave-fg);
  --destructive:             var(--ave-danger);
  --destructive-foreground:  var(--ave-danger-fg);
  --border:                  var(--ave-border);
  --input:                   var(--ave-border);
  --ring:                    var(--ave-ring);
  --shadow:                  0 14px 36px rgba(0, 0, 0, .55), 0 4px 12px rgba(0, 0, 0, .35);
}

.shell {
  width: 100%;
  height: 100%;
  padding: 14px 18px 16px;
  background: var(--surface);
  border-radius: 18px;
  border: 1px solid var(--border);
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", sans-serif;
  font-size: 12px;
  color: var(--text-1);
  -webkit-app-region: drag;
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  -webkit-app-region: drag;
}
.tabs {
  display: inline-flex;
  background: var(--surface-2);
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  isolation: isolate;
  -webkit-app-region: no-drag;
}
.tab {
  padding: 6px 16px;
  border: none;
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  border-radius: var(--radius-full);
  cursor: pointer;
  font-family: inherit;
  position: relative;
  z-index: 1;
  transform: translateZ(0);
  transition:
    background var(--motion-fast) ease,
    color var(--motion-fast) ease,
    box-shadow var(--motion-fast) ease,
    transform var(--motion-fast) ease;
}
.tab:hover:not([data-state="active"]) {
  background: var(--toggle-hover-bg);
  color: var(--foreground);
  box-shadow: var(--toggle-hover-shadow);
  transform: translateY(-1px);
}
.tab.active,
.tab[data-state="active"] {
  background: var(--primary);
  color: var(--primary-foreground);
  box-shadow: var(--toggle-selected-shadow);
}
.tab.active:hover,
.tab[data-state="active"]:hover {
  background: var(--ring);
  color: var(--primary-foreground);
  transform: translateY(-1px);
}
.tab:active {
  transform: translateY(0) scale(.98);
}
.timer {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--danger); }
.body { min-height: 56px; flex: 1 1 auto; -webkit-app-region: no-drag; }
.wave { height: 56px; width: 100%; display: block; color: var(--text-1); }
.notes {
  background: var(--surface-2);
  border-radius: 12px;
  padding: 12px 14px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-2);
  white-space: pre-wrap;
  /* No fixed max-height — the card measures content and asks the host for a
     taller slot. The host caps the dock, so past that point this overflow rule
     keeps the rest scrollable rather than spilling outside the shell. */
  overflow-y: auto;
  display: none;
}
.notes.has-content { color: var(--text-1); }
.actions {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 8px;
  -webkit-app-region: no-drag;
}
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 9px 10px;
  border-radius: var(--radius-full);
  border: none;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  font-family: inherit;
  transition: background .12s;
}
.tab:focus,
.mode-opt:focus,
.mic-select:focus,
.btn:focus { outline: none; }
.tab:focus-visible,
.mode-opt:focus-visible,
.mic-select:focus-visible,
.btn:focus-visible {
  outline: none;
  box-shadow:
    0 0 0 2px var(--card),
    0 0 0 4px color-mix(in srgb, var(--ring) 62%, transparent);
}
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn--cancel { background: var(--danger-bg); color: var(--danger); }
.btn--cancel:hover:not(:disabled) { background: var(--danger-bg-hover); }
.btn--pause { background: var(--surface-2); color: var(--text-1); }
.btn--pause:hover:not(:disabled) { background: var(--surface-2-hover); }
.btn--done { background: var(--success-bg); color: var(--success); }
.btn--done:hover:not(:disabled) { background: var(--success-bg-hover); }
.error {
  font-size: 12px;
  color: var(--danger);
  text-align: center;
  padding: 6px 0;
}
.capture {
  font-size: 12px;
  color: var(--text-3);
  text-align: center;
  padding: 2px 0 4px;
  font-weight: 500;
  -webkit-app-region: no-drag;
}
.capture.loopback { color: var(--success); }
.capture.mic { color: var(--warning); }

/* Mic device picker + Mic/Mix capture-mode toggle. Compact row above the
   waveform so the user can swap input mid-meeting (we tear down + restart
   the audio chain on change). */
.mic-controls {
  display: flex;
  gap: 6px;
  align-items: center;
  -webkit-app-region: no-drag;
}
.mic-select {
  flex: 1 1 auto;
  min-width: 0;
  font-family: inherit;
  font-size: 12px;
  padding: 4px 6px;
  border-radius: 8px;
  border: 1px solid var(--input);
  background: var(--surface-2);
  color: var(--text-1);
  outline: none;
  transition: border-color .12s, box-shadow .12s, background .12s;
}
.mic-select:focus-visible { border-color: var(--ring); }
.mode-toggle {
  display: inline-flex;
  background: var(--surface-2);
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  flex-shrink: 0;
  isolation: isolate;
}
.mode-opt {
  border: none;
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  padding: 4px 9px;
  border-radius: var(--radius-full);
  cursor: pointer;
  position: relative;
  z-index: 1;
  transform: translateZ(0);
  transition:
    background var(--motion-fast) ease,
    color var(--motion-fast) ease,
    box-shadow var(--motion-fast) ease,
    transform var(--motion-fast) ease;
}
.mode-opt:hover:not([data-state="active"]) {
  background: var(--toggle-hover-bg);
  color: var(--foreground);
  box-shadow: var(--toggle-hover-shadow);
  transform: translateY(-1px);
}
.mode-opt.active,
.mode-opt[data-state="active"] {
  background: var(--primary);
  color: var(--primary-foreground);
  box-shadow: var(--toggle-selected-shadow);
}
.mode-opt.active:hover,
.mode-opt[data-state="active"]:hover {
  background: var(--ring);
  color: var(--primary-foreground);
  transform: translateY(-1px);
}
.mode-opt:active {
  transform: translateY(0) scale(.98);
}

/* Reduced motion is authoritative: collapse the tab/mode-toggle lift and
   shadow transitions to near-zero so selection still registers instantly
   without the motion itself. */
@media (prefers-reduced-motion: reduce) {
  .shell *,
  .shell *::before,
  .shell *::after {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}
`;

const ICONS = {
  pause: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  play:  '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><polygon points="6 4 20 12 6 20"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="5 12 10 17 19 8"/></svg>',
  x:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
};

function el(tag, attrs = {}, text) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v);
  }
  if (text != null) e.textContent = text;
  return e;
}

function svgFromString(s) {
  return new DOMParser().parseFromString(s, "image/svg+xml").documentElement;
}

const styleEl = document.createElement("style");
styleEl.textContent = STYLES;
root.appendChild(styleEl);

const shell = el("div", { class: "shell" });
const header = el("div", { class: "header" });

const tabs = el("div", { class: "tabs", role: "tablist", "aria-label": "Recorder view" });
const noteTab = el("button", {
  type: "button",
  class: "tab",
  role: "tab",
  "aria-selected": "false",
  "data-state": "inactive",
}, "Note");
const meetingTab = el("button", {
  type: "button",
  class: "tab active",
  role: "tab",
  "aria-selected": "true",
  "data-state": "active",
}, "Meeting");
tabs.appendChild(noteTab);
tabs.appendChild(meetingTab);

const timer = el("span", { class: "timer" });
timer.appendChild(el("span", { class: "dot" }));
const timerText = el("span", {}, "00:00");
timer.appendChild(timerText);

header.appendChild(tabs);
header.appendChild(timer);

const captureBadge = el("div", { class: "capture" }, "녹음 시작 중…");

// STT 오류 배너 — `meeting_recorder_levels` 응답의 sttError 필드로 전달된다.
// quota(429) 같은 일반적 실패는 친화 문구로 매핑하고, 그렇지 않은 경우 원문
// 메시지를 잘라서 표시. 성공 청크가 다시 들어오면 호스트가 필드를 지우므로
// 배너도 자동으로 사라진다.
const errorBanner = el("div", { class: "error", style: "display: none" });
let consecutiveSttFailures = 0;
function classifySttError(raw) {
  const msg = String(raw ?? "");
  if (/429|quota|rate.?limit|exceeded/i.test(msg)) {
    return "OpenAI 한도 초과 — STT 일시 중단. platform.openai.com 에서 결제/한도 확인이 필요합니다.";
  }
  if (/401|unauthor|invalid.?api.?key/i.test(msg)) {
    return "OpenAI 인증 실패 — 설정에서 API 키를 확인해주세요.";
  }
  if (/timeout|ECONNRESET|network/i.test(msg)) {
    return "네트워크 오류 — STT 호출 실패. 잠시 후 자동 재시도.";
  }
  // Fallback: surface the raw error head, capped, with control chars stripped.
  return `STT 오류: ${msg.replace(/[\x00-\x1f]/g, " ").slice(0, 120)}`;
}
function showSttError(raw) {
  consecutiveSttFailures++;
  errorBanner.textContent = classifySttError(raw);
  errorBanner.style.display = "";
}
function clearSttError() {
  if (consecutiveSttFailures === 0) return;
  consecutiveSttFailures = 0;
  errorBanner.style.display = "none";
}

// Mic device picker + Mic-only / Mix toggle. Both persist to localStorage
// so the user's preference survives window close/reopen. Inserting the
// controls inline rather than a settings popover keeps the floating
// window single-pane (UX target: no nested modals on a 380x240 surface).
const PREF_MIC_KEY = "ave.meeting.preferredMicId";
const PREF_MODE_KEY = "ave.meeting.captureMode";
let preferredMicId = "";
let captureMode = "mix"; // "mix" | "mic-only"
try {
  preferredMicId = localStorage.getItem(PREF_MIC_KEY) ?? "";
  const savedMode = localStorage.getItem(PREF_MODE_KEY);
  if (savedMode === "mic-only" || savedMode === "mix") captureMode = savedMode;
} catch { /* localStorage may be unavailable in some contexts */ }

const micControls = el("div", { class: "mic-controls" });
const micSelect = document.createElement("select");
micSelect.className = "mic-select";
micSelect.title = "마이크 선택";
const defaultMicOpt = document.createElement("option");
defaultMicOpt.value = "";
defaultMicOpt.textContent = "기본 마이크";
micSelect.appendChild(defaultMicOpt);

const modeToggle = el("div", { class: "mode-toggle", role: "radiogroup", "aria-label": "Capture mode" });
const mixOpt = el("button", {
  type: "button",
  class: "mode-opt",
  role: "radio",
  "aria-checked": "false",
  "data-state": "inactive",
}, "Mix");
const micOnlyOpt = el("button", {
  type: "button",
  class: "mode-opt",
  role: "radio",
  "aria-checked": "false",
  "data-state": "inactive",
}, "Mic only");
modeToggle.appendChild(mixOpt);
modeToggle.appendChild(micOnlyOpt);

function syncModeButtons() {
  const isMix = captureMode === "mix";
  mixOpt.classList.toggle("active", isMix);
  mixOpt.setAttribute("aria-checked", String(isMix));
  mixOpt.dataset.state = isMix ? "active" : "inactive";
  micOnlyOpt.classList.toggle("active", !isMix);
  micOnlyOpt.setAttribute("aria-checked", String(!isMix));
  micOnlyOpt.dataset.state = !isMix ? "active" : "inactive";
}
syncModeButtons();

micControls.appendChild(micSelect);
micControls.appendChild(modeToggle);

const body = el("div", { class: "body" });
const waveCanvas = document.createElement("canvas");
waveCanvas.className = "wave";
const notes = el("div", { class: "notes" }, "회의 요약이 아직 생성되지 않았습니다.\n몇 분간 대화가 누적되면 자동으로 표시됩니다.");
body.appendChild(waveCanvas);
body.appendChild(notes);

const actions = el("div", { class: "actions" });
const cancelBtn = el("button", { type: "button", class: "btn btn--cancel" });
cancelBtn.appendChild(svgFromString(ICONS.x));
cancelBtn.appendChild(document.createTextNode(" Cancel"));
const pauseBtn = el("button", { type: "button", class: "btn btn--pause" });
pauseBtn.appendChild(svgFromString(ICONS.pause));
pauseBtn.appendChild(document.createTextNode(" Pause"));
const doneBtn = el("button", { type: "button", class: "btn btn--done" });
doneBtn.appendChild(svgFromString(ICONS.check));
doneBtn.appendChild(document.createTextNode(" Done"));
actions.appendChild(cancelBtn);
actions.appendChild(pauseBtn);
actions.appendChild(doneBtn);

shell.appendChild(header);
shell.appendChild(captureBadge);
shell.appendChild(errorBanner);
shell.appendChild(micControls);
shell.appendChild(body);
shell.appendChild(actions);
root.appendChild(shell);

/**
 * How many waveform bars the window keeps.
 *
 * All that is left of what used to be a whole audio subsystem here. The
 * chunking rules — minimum length, maximum length, silence tail, force-cut
 * overlap — moved to `hostPlugin.ts`, beside the frames they now act on. This
 * window no longer sees audio at all.
 */
const PEAK_RING_MAX = 100;

let sessionId = null;
let context = null;
let started = false;
let isPaused = false;
let activeTab = "meeting";
let timerInterval = null;
let notesPollInterval = null;
let startTime = 0;
let pausedAccum = 0;
let pausedAt = 0;
let lastNotesCount = -1;
let rafId = 0;

// Cached so the rAF-driven drawWave() doesn't trigger a style resolve
// every frame. Seeded immediately from the canvas's CSS `color`
// (.wave { color: var(--text-1) } → --ave-fg) so the very first paint
// already tracks the host theme; refreshed on theme change and on first
// start().
let waveColor = getComputedStyle(waveCanvas).color || "currentColor";

const peakHistory = [];

function refreshWaveColor() {
  waveColor = getComputedStyle(waveCanvas).color || waveColor;
}

function setCaptureBadge(mode, hint) {
  captureBadge.classList.remove("loopback", "mic");
  if (mode === "loopback") {
    captureBadge.classList.add("loopback");
    captureBadge.textContent = "🔊 + 🎤 시스템 오디오 + 마이크";
  } else if (mode === "mic") {
    captureBadge.classList.add("mic");
    captureBadge.textContent = hint
      ? `🎤 마이크만 — ${hint}`
      : "🎤 마이크만 캡처 중";
  } else {
    captureBadge.textContent = "녹음 시작 중…";
  }
}

function fmtTime(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

function updateTimer() {
  if (!started) return;
  const activePauseMs = isPaused && pausedAt > 0 ? Date.now() - pausedAt : 0;
  const elapsed = Date.now() - startTime - pausedAccum - activePauseMs;
  timerText.textContent = fmtTime(elapsed);
}

function drawWave() {
  if (!started) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = waveCanvas.clientWidth;
  const cssH = waveCanvas.clientHeight;
  if (waveCanvas.width !== cssW * dpr) waveCanvas.width = cssW * dpr;
  if (waveCanvas.height !== cssH * dpr) waveCanvas.height = cssH * dpr;
  const ctx = waveCanvas.getContext("2d");
  ctx.clearRect(0, 0, waveCanvas.width, waveCanvas.height);
  ctx.fillStyle = waveColor;
  const barW = 2 * dpr;
  const gap = 2 * dpr;
  const total = Math.floor(waveCanvas.width / (barW + gap));
  const offset = Math.max(0, peakHistory.length - total);
  for (let i = 0; i < total; i++) {
    const peak = peakHistory[offset + i] ?? 0;
    const barH = Math.max(2 * dpr, Math.min(waveCanvas.height, peak * waveCanvas.height * 4));
    const x = i * (barW + gap);
    ctx.fillRect(x, (waveCanvas.height - barH) / 2, barW, barH);
  }
  rafId = requestAnimationFrame(drawWave);
}

// Default compact size — used when we're on the Meeting tab (waveform only).
const DEFAULT_WINDOW_HEIGHT = 240;
// Shell layout constants — must mirror the .shell CSS rule for the
// element-sum measurement to add up correctly.
const SHELL_PADDING_Y = 14 + 16;     // top + bottom from .shell { padding }
const SHELL_GAP_TOTAL = 10 * 4;      // .shell gap × (children − 1) — 5 children
const SHELL_CHROME_BORDER = 2;       // 1px top + 1px bottom border on .shell

/**
 * Ask for a taller slot to fit current shell content. Called on tab switch and
 * after note content updates. Debounced via rAF so a flurry of DOM mutations
 * coalesces into one round-trip.
 *
 * It ASKS. Width is not negotiable and the height is clamped by the host
 * against the whole dock, so the number that comes back is what was applied —
 * never assume the request was honoured.
 *
 * We sum each child element's rendered height directly rather than
 * reading documentElement.scrollHeight — with .shell pinned at
 * `height: 100vh` and .notes set to `overflow-y: auto`, the document
 * never reports overflow even when notes content exceeds the visible
 * shell, so the document-level measurement was always returning the
 * current viewport height. notes.scrollHeight, by contrast, reports
 * the intrinsic content size regardless of any clipping ancestor.
 */
let resizeRafId = 0;
function requestWindowResize() {
  if (typeof host.resize !== "function") return;
  cancelAnimationFrame(resizeRafId);
  resizeRafId = requestAnimationFrame(() => {
    let height;
    if (activeTab === "note") {
      const chromePx = header.offsetHeight
        + captureBadge.offsetHeight
        + micControls.offsetHeight
        + actions.offsetHeight;
      // notes.scrollHeight is intrinsic content height; falls back to
      // a small min so the very-first call (before refreshNotes lands)
      // doesn't request an absurdly small window.
      const notesPx = Math.max(notes.scrollHeight, 56);
      height = chromePx + notesPx + SHELL_PADDING_Y + SHELL_GAP_TOTAL + SHELL_CHROME_BORDER;
    } else {
      height = DEFAULT_WINDOW_HEIGHT;
    }
    try { host.resize(height); } catch { /* main may be torn down */ }
  });
}

function normalizeIntermediateEntry(entry) {
  const wrappedData = entry && typeof entry === "object" && entry.data && typeof entry.data === "object"
    ? entry.data
    : null;
  const data = wrappedData ?? (entry && typeof entry === "object" ? entry : {});
  const highlights = Array.isArray(data.highlights)
    ? data.highlights.filter((h) => typeof h === "string" && h.trim()).map((h) => h.trim())
    : [];
  return {
    summary: typeof data.summary === "string" ? data.summary.trim() : "",
    highlights,
  };
}

async function refreshNotes() {
  if (!sessionId) return;
  try {
    const detail = await host.getDetail(sessionId);
    const list = Array.isArray(detail?.intermediateSummaries)
      ? detail.intermediateSummaries.map(normalizeIntermediateEntry)
        .filter((entry) => entry.summary || entry.highlights.length > 0)
      : [];
    if (list.length === lastNotesCount) return;
    lastNotesCount = list.length;
    if (list.length === 0) {
      notes.classList.remove("has-content");
      notes.textContent = "회의 요약이 아직 생성되지 않았습니다.\n몇 분간 대화가 누적되면 자동으로 표시됩니다.";
    } else {
      const latest = list[list.length - 1];
      const parts = [];
      if (latest?.summary) parts.push(latest.summary);
      if (Array.isArray(latest?.highlights) && latest.highlights.length > 0) {
        parts.push(latest.highlights.map((h) => `• ${h}`).join("\n"));
      }
      notes.textContent = parts.join("\n\n") || notes.textContent;
      notes.classList.add("has-content");
    }
    // Notes content just changed — resize window to fit (rAF-debounced).
    if (activeTab === "note") requestWindowResize();
  } catch { /* never break recording on poll error */ }
}

function setTab(tab) {
  if (tab === activeTab) return;
  activeTab = tab;
  const isNote = tab === "note";
  noteTab.classList.toggle("active", isNote);
  noteTab.setAttribute("aria-selected", String(isNote));
  noteTab.dataset.state = isNote ? "active" : "inactive";
  meetingTab.classList.toggle("active", !isNote);
  meetingTab.setAttribute("aria-selected", String(!isNote));
  meetingTab.dataset.state = !isNote ? "active" : "inactive";
  if (tab === "note") {
    waveCanvas.style.display = "none";
    notes.style.display = "block";
    lastNotesCount = -1;
    refreshNotes();
    if (!notesPollInterval) notesPollInterval = setInterval(refreshNotes, 5000);
  } else {
    notes.style.display = "none";
    waveCanvas.style.display = "block";
    if (notesPollInterval) { clearInterval(notesPollInterval); notesPollInterval = null; }
  }
  requestWindowResize();
}
noteTab.addEventListener("click", () => setTab("note"));
meetingTab.addEventListener("click", () => setTab("meeting"));

function setBusy(busy) {
  cancelBtn.disabled = busy;
  pauseBtn.disabled = busy;
  doneBtn.disabled = busy;
}

pauseBtn.addEventListener("click", () => {
  isPaused = !isPaused;
  // Main decides what a pause means now. This window used to enforce it by
  // dropping worklet batches on the floor; the audio no longer passes through
  // here, so saying so is the only way to stop it being recorded.
  host.setPaused(isPaused).catch((err) => {
    console.warn("[recorder-card] setPaused failed", err);
  });
  if (isPaused) {
    pausedAt = Date.now();
  } else if (pausedAt) {
    pausedAccum += Date.now() - pausedAt;
    pausedAt = 0;
  }
  pauseBtn.replaceChildren();
  pauseBtn.appendChild(svgFromString(isPaused ? ICONS.play : ICONS.pause));
  pauseBtn.appendChild(document.createTextNode(isPaused ? " Resume" : " Pause"));
});

cancelBtn.addEventListener("click", async () => {
  setBusy(true);
  // No local teardown: `meeting_cancel` ends the host capture, and
  // ending it in two places would be two authorities for one fact.
  try { await host.cancel(sessionId); } catch (err) { console.warn("cancel failed", err); }
  await host.close();
});

doneBtn.addEventListener("click", async () => {
  setBusy(true);
  doneBtn.replaceChildren(document.createTextNode("분석 중…"));
  started = false;
  if (levelsPollInterval) { clearInterval(levelsPollInterval); levelsPollInterval = null; }
  // The tail is flushed by `meeting_stop`, in main, where the buffer
  // now lives. Waiting on anything here would be waiting on a queue this
  // window no longer has.
  // Forward the length tier the user picked on the prep/instant-record
  // screen (carried into this window via init payload context) so the
  // host's meeting_stop sets the matching summarizeFinal verbosity.
  const tier = context && typeof context === "object" ? context.lengthTier : undefined;
  try {
    await host.stop(sessionId, tier ? { lengthTier: tier } : undefined);
  } catch (err) { console.error("stop failed", err); }
  await host.close();
});

// ─── Mic device picker / Mic-only|Mix toggle ─────────────────────────────
//
// `populateMicList` asks the HOST for its audio inputs and rebuilds the
// dropdown. Called twice in normal operation: once on load, when labels are
// still empty because microphone access has not been granted, so the dropdown
// at least shows how many devices there are; and again once recording has
// started and the host has asked for permission, which is what fills the
// labels in. The selected option remains the preferred mic id so the
// "selected" state survives the rebuild.
async function populateMicList() {
  let inputs = [];
  try {
    const res = await host.listMicrophones();
    inputs = Array.isArray(res?.devices) ? res.devices : [];
  } catch (err) {
    console.warn("[recorder-card] listMicrophones failed", err);
    return;
  }
  // Preserve current dropdown value across rebuild — restore it after.
  const desired = preferredMicId;
  micSelect.replaceChildren();
  const def = document.createElement("option");
  def.value = "";
  def.textContent = "기본 마이크";
  micSelect.appendChild(def);
  for (const d of inputs) {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    // Labels come up empty until microphone access has been granted at least
    // once — the browser's rule, and the host reports it as it finds it. Show
    // a placeholder so the dropdown is not a row of identical blank options.
    opt.textContent = d.label || `마이크 (${(d.deviceId || "").slice(0, 6)}…)`;
    micSelect.appendChild(opt);
  }
  // Re-select the user's preferred mic if it's still present.
  if (desired && Array.from(micSelect.options).some((o) => o.value === desired)) {
    micSelect.value = desired;
  } else {
    micSelect.value = "";
  }
}

// Restart the audio chain// Swap microphone or capture mode mid-recording. Main stops the host capture
// and starts a new one; this window only says what it wants.
async function restartCapture() {
  if (!started) return;
  setCaptureBadge("mic", "장치 변경 중…");
  try {
    const res = await host.restartCapture({
      captureMode,
      micId: preferredMicId || "",
    });
    if (!res || res.ok !== true) throw new Error(res?.error || "restart refused");
    setCaptureBadge(res.mode === "loopback" ? "loopback" : "mic");
  } catch (err) {
    setCaptureBadge("mic", (err?.message ?? err).toString().slice(0, 60));
    console.error("[recorder-card] restartCapture failed", err);
  }
}

micSelect.addEventListenermicSelect.addEventListener("change", () => {
  preferredMicId = micSelect.value || "";
  try { localStorage.setItem(PREF_MIC_KEY, preferredMicId); } catch { /* noop */ }
  // If we're already recording, swap the mic by restarting capture.
  // Pre-record changes just persist for next start().
  if (started) restartCapture();
});

function setCaptureMode(mode) {
  if (mode !== "mix" && mode !== "mic-only") return;
  if (mode === captureMode) return;
  captureMode = mode;
  syncModeButtons();
  try { localStorage.setItem(PREF_MODE_KEY, captureMode); } catch { /* noop */ }
  if (started) restartCapture();
}
mixOpt.addEventListener("click", () => setCaptureMode("mix"));
micOnlyOpt.addEventListener("click", () => setCaptureMode("mic-only"));

// Pre-permission population. Labels come up empty until microphone access has
// been granted at least once, so this first pass gives the user a non-zero
// list and `start()` re-runs it once the host has asked for permission.
populateMicList().catch(() => { /* noop */ });

// ─── Waveform ─────────────────────────────────────────────────────────────
//
// The peaks are computed in main from the frames the host captures. This
// window polls for them; it has no audio of its own to measure. `peakHistory`
// is declared above, beside the canvas that draws it.
let levelsPollInterval = null;

async function pollLevels() {
  try {
    const res = await host.getLevels();
    // Whether the last chunk reached the transcriber, on the same response as
    // the peaks. The card used to learn this from the failure reply to the
    // audio it pushed itself; it pushes no audio any more, and a recording
    // that is silently not being transcribed is worth a banner while the
    // meeting is still happening.
    if (typeof res?.sttError === "string" && res.sttError) showSttError(res.sttError);
    else clearSttError();
    const peaks = Array.isArray(res?.peaks) ? res.peaks : [];
    if (peaks.length === 0) return;
    // Replaced wholesale rather than appended: main already keeps the ring,
    // and appending would draw the same peaks again every poll.
    peakHistory.length = 0;
    for (const peak of peaks.slice(-PEAK_RING_MAX)) peakHistory.push(peak);
  } catch { /* a dropped poll costs one frame of the waveform */ }
}

async function start(payload) {
  sessionId = payload?.sessionId;
  context = payload?.context;
  if (!sessionId) {
    setCaptureBadge("mic", "sessionId 없음");
    return;
  }
  try {
    const res = await host.start(sessionId, context, {
      captureMode,
      micId: preferredMicId || "",
    });
    if (!res || res.ok !== true) {
      throw new Error(
        (res && (res.fallbackReason || res.error)) || "host refused to start recording",
      );
    }
    // What actually opened, not what was asked for: a recording that got the
    // microphone but not system audio says so on the badge.
    setCaptureBadge(res.mode === "loopback" ? "loopback" : "mic");
  } catch (err) {
    setCaptureBadge("mic", (err?.message ?? err).toString().slice(0, 60));
    console.warn("[recorder-card] host.start failed", err);
    return;
  }
  started = true;
  startTime = Date.now();
  timerInterval = setInterval(updateTimer, 1000);
  // 100 ms, which is the rate main's ring is filled at. Faster would redraw
  // the same peaks; slower would make the meter lag the room.
  levelsPollInterval = setInterval(() => { void pollLevels(); }, 100);
  refreshWaveColor();
  drawWave();
  // Labels are empty until microphone access has been granted once, and the
  // host has just asked for it — so this second pass is what fills them in.
  populateMicList().catch(() => { /* the list stays as it was */ });
}

// primeTheme subscribes to `host.theme.changed` over the bridge and paints
// validated tokens onto the shell. The TARGET is the shell rather than the
// document: this card shares its document with the dock's own chrome and with
// any other plugin's slot, so painting on `documentElement` would let one
// card's theme decide everyone else's.
primeTheme(bridge, {
  target: shell,
  onPayload: () => refreshWaveColor(),
});

// What session this card is showing. The dock carries no per-slot payload by
// design — a card asks its own plugin — so this is the first thing it does.
try {
  const payload = await host.getInit();
  if (payload) start(payload);
  else setCaptureBadge("mic", "표시할 세션이 없습니다");
} catch (err) {
  setCaptureBadge("mic", (err?.message ?? err).toString().slice(0, 60));
  console.error("[recorder-card] init failed", err);
}

}
