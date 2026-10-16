// indexer-control.js — Local Indexer 의 webview 진입점.
//
// 이전에는 단일 파일에 CSS/순수 헬퍼/모달/테마 동기화/렌더링/IPC 가 모두
// 들어 있었지만, 책임을 다음 모듈로 분리했다:
//   - indexer-control.styles.js : 모든 CSS 변수/규칙
//   - indexer-state.js          : 순수 헬퍼(getDocName 등) + FILE_ICONS
//   - theme-sync.js             : host.theme.changed 동기화
//   - folder-preview-modal.js   : "폴더 추가" 시 미리보기 모달
// 본 파일에는 createMarkup() 의 HTML 골격, ICONS(SVG 인라인),
// 폴더/문서 렌더링, IPC 라이프사이클, mount() 의 cleanup 패턴만 남는다.

import { STYLES } from "./indexer-control.styles.js";
import {
  FILE_ICONS,
  getDocMetricLabel,
  getDocName,
  getDocPath,
  getDocType,
  getDocumentEmptyMessage,
  getProgressPercent,
  getScanStatusText,
  isScanLocked,
  normalizeScanProgress,
} from "./indexer-state.js";
import { showFolderPreviewModal } from "./folder-preview-modal.js";
import { primeTheme } from "./prime-theme.js";

const ICONS = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>',
  document: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>',
  empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 14.5 9.5 22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5z"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
};

function createMarkup() {
  return `
    <style>${STYLES}</style>
    <div class="ave-local-indexer-ui">
      <div class="wrap">
        <header class="topbar">
          <div class="brand">
            <div class="brand-icon">${ICONS.spark}</div>
            <div class="brand-text">
              <div class="brand-title">Local Indexer</div>
              <div class="brand-sub"><b data-role="docCount">0</b> 문서 색인됨</div>
            </div>
          </div>
        </header>

        <section class="scan-card" data-role="scanCard" data-status="idle">
          <div class="card-head">
            <div class="card-title">${ICONS.spark}<span>스캔 상태</span></div>
            <span class="scan-pill scan-idle" data-role="scanBadge">
              <span class="scan-dot"></span><span data-role="scanBadgeText">대기</span>
            </span>
          </div>
          <div class="scan-summary" data-role="scanSummary">Ready</div>
          <div class="scan-detail" data-role="scanDetail"></div>
          <div class="progress"><div class="progress-bar" data-role="progress"></div></div>
          <div class="scan-actions">
            <button data-role="scanBtn" class="primary-cta">${ICONS.play}<span>인덱싱 시작</span></button>
            <button data-role="stopScanBtn" class="danger">${ICONS.stop}<span>중단</span></button>
            <button data-role="refreshBtn" class="ghost icon-only" title="목록 새로고침" aria-label="목록 새로고침">${ICONS.refresh}</button>
          </div>
        </section>

        <section class="card" data-role="warningBanner" hidden>
          <div class="card-head">
            <div class="card-title">${ICONS.spark}<span>인덱싱 경고</span><span class="count" data-role="warningCount">0</span></div>
            <button data-role="clearWarningsBtn" class="ghost icon-only" title="경고 지우기" aria-label="경고 지우기">${ICONS.trash}</button>
          </div>
          <div class="cost-warning">
            <div class="cost-warning-text" data-role="warningList"></div>
          </div>
        </section>

        <section class="card settings-card">
          <div class="card-head">
            <div class="card-title">${ICONS.spark}<span>이미지 캡션 옵션</span></div>
          </div>
          <label class="settings-toggle">
            <input type="checkbox" data-role="imageEmbeddingToggle" />
            <span class="settings-toggle-label">이미지 캡션 사용</span>
            <span class="settings-toggle-sub" data-role="imageEmbeddingHint">PPTX/PDF/DOCX/XLSX 내부 이미지 + 단독 .jpg/.jpeg/.png — 캡션 모델로 텍스트화 후 텍스트 임베딩</span>
          </label>
          <div class="settings-toggle-sub" data-role="providerNotice" style="margin-top: 4px;">
            현재 캡션 provider: <span data-role="providerSummary">—</span>
          </div>
          <div class="cost-warning">
            <span class="cost-warning-title">⚠ 비용 안내</span>
            <div class="cost-warning-text">
              이미지 1장당 캡셔닝 호출 1회가 추가됩니다 (cloud provider 사용 시 호출당 비용 발생).<br/>
              Provider · endpoint · API 키는 <b>플러그인 설정</b> 에서 관리하세요. 이 화면에서는 토글만 제어합니다.
            </div>
            <div class="api-key-error" data-role="apiKeyError" hidden>
              API 키가 설정되지 않았습니다. 플러그인 설정에서 입력하세요.
            </div>
            <div class="api-key-error" data-role="localProviderWarning" hidden>
              ⚠ <b>local</b> provider 는 HuggingFace hub 에서 BLIP 모델(~990MB)을 다운로드해야 동작합니다. 사내망/방화벽 환경에서는 차단되어 캡션이 실패합니다. 외부 인터넷이 가능한 환경에서만 사용하거나, Azure/OpenAI provider 로 전환하세요.
            </div>
          </div>
        </section>

        <section class="card">
          <div class="card-head">
            <div class="card-title">${ICONS.folder}<span>스캔 폴더</span></div>
            <button data-role="refreshFoldersBtn" class="ghost icon-only" title="폴더 상태 새로고침 및 삭제된 파일 정리" aria-label="폴더 상태 새로고침">${ICONS.refresh}</button>
          </div>
          <div class="folder-add-row">
            <button data-role="addFolderBtn" class="ghost block">${ICONS.folder}<span>폴더 선택하여 추가</span></button>
          </div>
          <div class="ext-row">
            <span class="ext-badge">PDF</span>
            <span class="ext-badge">DOCX</span>
            <span class="ext-badge">PPTX</span>
            <span class="ext-badge">XLSX</span>
            <span class="ext-badge">MD</span>
            <span class="ext-badge">TXT</span>
            <span class="ext-badge">HTML</span>
          </div>
          <div class="folder-group">
            <div class="folder-group-head">
              <span class="group-dot pending"></span>
              <span>대기 / 스캔 필요</span>
              <span class="group-count" data-role="pendingCount">0</span>
            </div>
            <div data-role="pendingFolderList" class="folder-list"></div>
          </div>
          <div class="folder-group">
            <div class="folder-group-head">
              <span class="group-dot indexed"></span>
              <span>인덱싱 완료</span>
              <span class="group-count" data-role="indexedCount">0</span>
            </div>
            <div data-role="indexedFolderList" class="folder-list"></div>
          </div>
        </section>

        <section class="card doc-section">
          <div class="card-head">
            <div class="card-title">${ICONS.document}<span>문서</span><span class="count" data-role="docCountBadge">0</span></div>
          </div>
          <div class="search-input">
            <span class="search-icon">${ICONS.search}</span>
            <input data-role="searchInput" class="input" placeholder="문서 이름 또는 경로로 검색..." />
          </div>
          <div data-role="docList" class="doc-list"></div>
        </section>
      </div>
      <div data-role="status" class="status-bar">Ready</div>
    </div>
  `;
}

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function formatFolderTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

// 캡션 provider 정규화: host 응답이나 stale state 가 unknown 값이면 openai
// 로 fallback. UI 와 worker 의 enum 동기화가 어긋날 때도 안전하게 한 자리.
function normalizeCaptionProvider(value) {
  if (value === "azure-openai-chat" || value === "azure-openai-responses") {
    return value;
  }
  // 옛 "azure" (AI Vision REST) 설정은 새 azure-openai-chat 으로 매핑해
  // schema 검증 실패 / UI 깨짐을 방지. 정상 동작은 사용자가 설정 재입력.
  if (value === "azure") return "azure-openai-chat";
  return "openai";
}

function normalizeCaptionMode() {
  return "cloud";
}

const FOLDER_STATUS_LABELS = Object.freeze({
  indexed: "\uC644\uB8CC",
  scanning: "\uC2A4\uCE94 \uC911",
  needs_scan: "\uC2A4\uCE94 \uD544\uC694",
  images_disabled: "\uC774\uBBF8\uC9C0 \uCEA1\uC158 \uAEBC\uC9D0",
  missing: "\uB204\uB77D",
  empty: "\uBE44\uC5B4 \uC788\uC74C",
  unknown: "\uC54C \uC218 \uC5C6\uC74C",
});

function getFolderStatusLabelUi(status) {
  return FOLDER_STATUS_LABELS[status] ?? FOLDER_STATUS_LABELS.unknown;
}

export async function mount(context) {
  const { root, bridge } = context;
  root.innerHTML = createMarkup();
  const scope = root.querySelector(".ave-local-indexer-ui");
  if (!scope) throw new Error("local-indexer ui mount failed");

  const $ = (sel) => scope.querySelector(sel);
  const statusEl = $("[data-role='status']");
  const docCountEl = $("[data-role='docCount']");
  const docCountBadgeEl = $("[data-role='docCountBadge']");
  const docListEl = $("[data-role='docList']");
  const pendingFolderListEl = $("[data-role='pendingFolderList']");
  const indexedFolderListEl = $("[data-role='indexedFolderList']");
  const pendingCountEl = $("[data-role='pendingCount']");
  const indexedCountEl = $("[data-role='indexedCount']");
  const addFolderBtn = $("[data-role='addFolderBtn']");
  const searchInput = $("[data-role='searchInput']");
  const scanBtn = $("[data-role='scanBtn']");
  const stopScanBtn = $("[data-role='stopScanBtn']");
  const refreshBtn = $("[data-role='refreshBtn']");
  const refreshFoldersBtn = $("[data-role='refreshFoldersBtn']");
  const imageEmbeddingToggle = $("[data-role='imageEmbeddingToggle']");
  const imageProviderLocal = $("[data-role='imageProviderLocal']");
  const imageProviderCloud = $("[data-role='imageProviderCloud']");
  const providerSummaryEl = $("[data-role='providerSummary']");
  const apiKeyErrorEl = $("[data-role='apiKeyError']");
  const warningBannerEl = $("[data-role='warningBanner']");
  const warningListEl = $("[data-role='warningList']");
  const warningCountEl = $("[data-role='warningCount']");
  const clearWarningsBtn = $("[data-role='clearWarningsBtn']");
  const scanCardEl = $("[data-role='scanCard']");
  const scanBadgeEl = $("[data-role='scanBadge']");
  const scanBadgeTextEl = $("[data-role='scanBadgeText']");
  const scanSummaryEl = $("[data-role='scanSummary']");
  const scanDetailEl = $("[data-role='scanDetail']");
  const progressBar = $("[data-role='progress']");
  const settingsCardEl = imageEmbeddingToggle?.closest(".settings-card") || null;
  const foldersCardEl = pendingFolderListEl?.closest(".card") || null;
  const docsCardEl = docListEl?.closest(".doc-section") || null;

  let allDocs = [];
  let registeredFolders = [];
  let folderSummaries = [];
  let scanProgress = normalizeScanProgress();
  // Image-embedding 설정 스냅샷. mount 시 index_get_settings 로 채우고,
  // 토글/라디오 변경 시 index_set_image_embedding 으로 호스트 config store
  // 에 영구화. provider="openai" + hasApiKey=false 면 API 키 안내 표시.
  let settings = {
    imageEmbeddingEnabled: false,
    imageCaptionMode: "cloud",
    imageCaptionProvider: "openai",
    imageCaptionModel: "",
    imageCaptionEndpoint: "",
    hasApiKey: false,
  };
  const cleanups = [];
  let pollTimer = null;

  const on = (el, ev, fn) => {
    if (!el) return;
    el.addEventListener(ev, fn);
    cleanups.push(() => el.removeEventListener(ev, fn));
  };

  const collapsibleSections = new Map();

  const applySectionCollapsed = (sectionEl, toggleBtn, collapsed) => {
    sectionEl.dataset.collapsed = collapsed ? "true" : "false";
    toggleBtn.setAttribute("aria-expanded", String(!collapsed));
    toggleBtn.setAttribute("title", collapsed ? "Expand section" : "Collapse section");
    toggleBtn.setAttribute("aria-label", collapsed ? "Expand section" : "Collapse section");
  };

  const decorateCollapsibleSection = (sectionEl, sectionId, defaultCollapsed = false) => {
    if (!(sectionEl instanceof HTMLElement)) return null;
    const head = sectionEl.querySelector(":scope > .card-head");
    if (!(head instanceof HTMLElement)) return null;

    sectionEl.classList.add("collapsible-card");
    sectionEl.dataset.sectionId = sectionId;

    const body = document.createElement("div");
    body.className = "card-body";
    const bodyChildren = Array.from(sectionEl.children).filter((child) => child !== head);
    body.append(...bodyChildren);
    sectionEl.appendChild(body);

    const headActions = document.createElement("div");
    headActions.className = "card-head-actions";
    const existingActions = Array.from(head.children).filter((child) => !child.classList.contains("card-title"));
    for (const action of existingActions) headActions.appendChild(action);

    const toggleBtn = document.createElement("button");
    toggleBtn.className = "ghost icon-only collapse-toggle";
    toggleBtn.dataset.role = "sectionToggle";
    toggleBtn.dataset.targetSection = sectionId;
    toggleBtn.innerHTML = ICONS.chevron;
    headActions.appendChild(toggleBtn);
    head.appendChild(headActions);

    const api = {
      sectionEl,
      toggleBtn,
      get collapsed() {
        return sectionEl.dataset.collapsed === "true";
      },
      setCollapsed(collapsed) {
        applySectionCollapsed(sectionEl, toggleBtn, collapsed);
      },
      toggle() {
        applySectionCollapsed(sectionEl, toggleBtn, sectionEl.dataset.collapsed !== "true");
      },
    };
    api.setCollapsed(defaultCollapsed);
    collapsibleSections.set(sectionId, api);
    on(toggleBtn, "click", () => api.toggle());
    return api;
  };

  const warningSection = decorateCollapsibleSection(warningBannerEl, "warnings", true);
  decorateCollapsibleSection(settingsCardEl, "settings", true);
  decorateCollapsibleSection(foldersCardEl, "folders", false);
  decorateCollapsibleSection(docsCardEl, "docs", false);
  const warnings = [];
  const dismissedWarningKeys = new Set();
  const MAX_WARNINGS = 50;
  const getWarningKey = (warning) => [
    typeof warning?.kind === "string" ? warning.kind : "warning",
    typeof warning?.path === "string" ? warning.path : "",
    typeof warning?.docId === "string" ? warning.docId : "",
    typeof warning?.reason === "string" ? warning.reason : "",
    typeof warning?.error === "string" ? warning.error : "",
    typeof warning?.message === "string" ? warning.message : "",
  ].join("\0");
  const renderWarnings = () => {
    if (!warningBannerEl || !warningListEl) return;
    if (warnings.length === 0) {
      warningBannerEl.hidden = true;
      if (warningCountEl) warningCountEl.textContent = "0";
      warningListEl.replaceChildren();
      return;
    }
    warningBannerEl.hidden = false;
    if (warningCountEl) warningCountEl.textContent = String(warnings.length);
    const grouped = [];
    const groupedMap = new Map();
    for (const warning of [...warnings].reverse()) {
      const groupKey = warning.path || warning.docId || "__general__";
      let group = groupedMap.get(groupKey);
      if (!group) {
        group = {
          key: groupKey,
          label: warning.path || warning.docId || "일반 경고",
          items: [],
        };
        groupedMap.set(groupKey, group);
        grouped.push(group);
      }
      group.items.push(warning);
    }
    const frag = document.createDocumentFragment();
    for (const group of grouped) {
      const details = document.createElement("details");
      details.className = "warning-group";
      if (group.key === "__general__") {
        details.classList.add("warning-general");
      }
      details.open = true;

      const summary = document.createElement("summary");
      summary.className = "warning-group-summary";
      const title = document.createElement("span");
      title.className = "warning-group-title";
      title.textContent = group.label;
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = String(group.items.length);
      summary.appendChild(title);
      summary.appendChild(count);
      details.appendChild(summary);

      const body = document.createElement("div");
      body.className = "warning-group-body";
      for (const warning of group.items) {
        const item = document.createElement("div");
        item.className = "warning-item";
        if (group.key === "__general__") {
          item.classList.add("warning-item-general");
        }
        const kindTag = document.createElement("span");
        kindTag.className = "type-tag";
        kindTag.style.marginRight = "6px";
        kindTag.textContent = warning.kind || "warning";
        const msg = document.createElement("span");
        msg.className = "warning-message";
        msg.textContent = warning.message || "";
        item.appendChild(kindTag);
        item.appendChild(msg);
        body.appendChild(item);
      }
      details.appendChild(body);
      frag.appendChild(details);
    }
    warningListEl.replaceChildren(frag);
  };
  const replaceWarnings = (items) => {
    if (!Array.isArray(items)) return;
    const next = [];
    const seen = new Set();
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const key = getWarningKey(item);
      if (dismissedWarningKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      next.push(item);
    }
    warnings.length = 0;
    warnings.push(...next.slice(-MAX_WARNINGS));
    if (warnings.length > 0) warningSection?.setCollapsed(false);
    renderWarnings();
  };
  const appendWarning = (item) => {
    if (!item || typeof item !== "object") return;
    const key = getWarningKey(item);
    if (dismissedWarningKeys.has(key)) return;
    if (warnings.some((existing) => getWarningKey(existing) === key)) return;
    warnings.push(item);
    if (warnings.length > MAX_WARNINGS) warnings.splice(0, warnings.length - MAX_WARNINGS);
    if (warnings.length === 1) warningSection?.setCollapsed(false);
    renderWarnings();
  };
  const clearWarningsLocal = ({ dismiss = false, resetDismissed = false } = {}) => {
    if (dismiss) {
      for (const warning of warnings) dismissedWarningKeys.add(getWarningKey(warning));
    }
    if (resetDismissed) {
      dismissedWarningKeys.clear();
    }
    warnings.length = 0;
    renderWarnings();
  };
  const clearWarningsHost = async () => {
    try {
      await bridge.callTool("index_clear_warnings");
    } catch {
      // Best-effort only. Local dismissal still prevents immediate rehydration.
    }
  };

  const setStatus = (text) => {
    if (statusEl) statusEl.textContent = text;
  };

  const setProgress = (pct) => {
    if (progressBar) progressBar.style.width = `${pct}%`;
  };

  const setScanBadge = (status) => {
    if (scanBadgeEl) scanBadgeEl.className = `scan-pill scan-${status}`;
    if (scanBadgeTextEl) {
      scanBadgeTextEl.textContent =
        status === "running" ? "진행 중" :
        status === "done" ? "완료" :
        status === "canceled" ? "중단됨" :
        status === "failed" ? "실패" :
        "대기";
    }
    if (scanCardEl) scanCardEl.dataset.status = status;
  };

  const setScanSummary = (text) => {
    if (scanSummaryEl) scanSummaryEl.textContent = text;
  };

  const setScanDetail = (text) => {
    if (scanDetailEl) scanDetailEl.textContent = text || "";
  };

  const stopScanStatusPolling = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const pollScanStatusOnce = async () => {
    try {
      const latest = await bridge.callTool("index_scan_status");
      applyScanProgress(latest);
      replaceWarnings(latest?.warnings);
    } catch {
      // Ignore transient poll failures and let the next tick retry.
    }
  };

  const ensureScanStatusPolling = () => {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      void pollScanStatusOnce();
    }, 500);
  };

  const syncControls = () => {
    const locked = isScanLocked(scanProgress);
    if (scanBtn) scanBtn.disabled = locked;
    if (stopScanBtn) stopScanBtn.disabled = !locked;
    if (refreshBtn) refreshBtn.disabled = locked;
    if (refreshFoldersBtn) refreshFoldersBtn.disabled = locked;
    if (addFolderBtn) addFolderBtn.disabled = locked;
    scope.querySelectorAll("[data-remove-folder], [data-refresh-folder]").forEach((btn) => {
      btn.disabled = locked;
    });
  };

  const refreshDocuments = async ({ quiet = false } = {}) => {
    const preserveScan = isScanLocked(scanProgress);
    if (!quiet && !preserveScan) {
      setStatus("Refreshing documents...");
      setProgress(30);
    }
    try {
      // host 측 hard cap 과 같은 값 사용. hasMore 면 페이지를 돌아 전체 수집.
      const PAGE_SIZE = 100;
      const collected = [];
      let offset = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // UI 는 page_count / line_count 를 표시하므로 full shape 요청.
        const res = await bridge.callTool("index_documents", { limit: PAGE_SIZE, offset, full: true });
        if (!res || typeof res !== "object" || !Array.isArray(res.documents)) {
          throw new Error("index_documents returned an invalid response.");
        }
        collected.push(...res.documents);
        if (!res.hasMore || res.documents.length === 0) break;
        offset += res.documents.length;
      }
      allDocs = collected;
      renderDocuments(allDocs);
      if (!quiet && !preserveScan) {
        setStatus(`Loaded ${allDocs.length} documents.`);
      }
    } catch (error) {
      allDocs = [];
      renderDocuments([], { error: formatErrorMessage(error) });
      setStatus(`Error: ${formatErrorMessage(error)}`);
    }
    if (!quiet && !preserveScan) {
      setProgress(100);
      setTimeout(() => {
        if (!isScanLocked(scanProgress)) setProgress(0);
      }, 500);
    }
  };

  const applyScanProgress = (incoming) => {
    const previous = scanProgress;
    scanProgress = normalizeScanProgress(incoming);
    setScanBadge(scanProgress.status);
    setScanSummary(getScanStatusText(scanProgress));
    setScanDetail(scanProgress.currentPath || scanProgress.message || "");
    setStatus(getScanStatusText(scanProgress));
    setProgress(getProgressPercent(scanProgress));
    syncControls();
    if (scanProgress.status === "running") {
      ensureScanStatusPolling();
    } else {
      stopScanStatusPolling();
    }
    // Re-render folder cards so live byFolder counters move folders between
    // groups (pending ↔ indexed) and refresh the "X / Y 색인됨" counts
    // without waiting for the post-scan summary refresh.
    if (scanProgress.byFolder) {
      renderFolders(registeredFolders, folderSummaries);
    }
    if (previous.status === "running" && scanProgress.status !== "running") {
      void loadFolders();
      void refreshDocuments({ quiet: true });
    }
  };

  // 폴더 경로처럼 사용자 입력이 attribute / textContent 로 흘러갈 때
  // 따옴표·꺾쇠·HTML 토큰이 그대로 들어와도 DOM 이 깨지지 않도록 모든
  // 사용자 데이터는 createElement + textContent + setAttribute 로 작성한다.
  // innerHTML 은 신뢰된 상수 SVG 아이콘 삽입에만 한정.
  const renderFolderCards = (targetEl, summaries, emptyText, { showRefresh = false } = {}) => {
    if (!targetEl) return;
    if (!summaries.length) {
      const empty = document.createElement("div");
      empty.className = "folder-empty";
      const iconHolder = document.createElement("span");
      iconHolder.innerHTML = ICONS.empty; // trusted constant SVG
      const label = document.createElement("span");
      label.textContent = emptyText;
      empty.appendChild(iconHolder);
      empty.appendChild(label);
      targetEl.replaceChildren(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const summary of summaries) {
      const item = document.createElement("div");
      item.className = "folder-item";
      const ts = formatFolderTimestamp(summary.lastIndexedAt);
      // Prefer the live per-folder counter from the current scan when it
      // has work this cycle; otherwise fall back to the pre-scan summary
      // metrics so the card stays meaningful between scans.
      const liveCounter = scanProgress?.byFolder?.[summary.folder];
      const liveActive = !!liveCounter && liveCounter.total > 0;
      const isInProgress = liveActive
        && liveCounter.processed < liveCounter.total
        && scanProgress.status === "running";
      const displayStatus = isInProgress ? "scanning" : summary.status;
      const displayIndexed = liveActive ? liveCounter.indexed : summary.indexedFiles;
      const displayTotal = liveActive ? liveCounter.total : summary.totalFiles;
      const failedNote = liveActive && liveCounter.failed > 0
        ? ` · 실패 ${liveCounter.failed}`
        : "";
      // Status enum is host-controlled but we still defense-in-depth filter
      // the class-name fragment so unexpected values can't inject classes.
      const statusClass = /^[a-z0-9_-]+$/i.test(String(displayStatus)) ? displayStatus : "unknown";

      const top = document.createElement("div");
      top.className = "folder-top";
      const iconHolder = document.createElement("div");
      iconHolder.className = "folder-icon";
      iconHolder.innerHTML = ICONS.folder; // trusted constant SVG
      top.appendChild(iconHolder);
      const pathSpan = document.createElement("span");
      pathSpan.className = "folder-path";
      pathSpan.title = summary.folder;
      pathSpan.textContent = summary.folder;
      top.appendChild(pathSpan);
      const badge = document.createElement("span");
      badge.className = `folder-badge ${statusClass}`;
      badge.textContent = getFolderStatusLabelUi(displayStatus);
      top.appendChild(badge);
      item.appendChild(top);

      const meta = document.createElement("div");
      meta.className = "folder-meta";
      const countSpan = document.createElement("span");
      countSpan.textContent = `${displayIndexed} / ${displayTotal} 색인됨${failedNote}`;
      meta.appendChild(countSpan);
      if (ts) {
        const dot = document.createElement("span");
        dot.className = "dot-sep";
        dot.textContent = "·";
        meta.appendChild(dot);
        const tsSpan = document.createElement("span");
        tsSpan.textContent = ts;
        meta.appendChild(tsSpan);
      }
      item.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "folder-actions";
      if (showRefresh) {
        const refreshBtn = document.createElement("button");
        refreshBtn.className = "sm ghost";
        refreshBtn.setAttribute("data-refresh-folder", summary.folder);
        refreshBtn.innerHTML = ICONS.refresh; // trusted constant SVG
        const refreshLabel = document.createElement("span");
        refreshLabel.textContent = "다시 스캔";
        refreshBtn.appendChild(refreshLabel);
        actions.appendChild(refreshBtn);
      }
      const removeBtn = document.createElement("button");
      removeBtn.className = "sm danger";
      removeBtn.setAttribute("data-remove-folder", summary.folder);
      removeBtn.innerHTML = ICONS.trash; // trusted constant SVG
      const removeLabel = document.createElement("span");
      removeLabel.textContent = "제거";
      removeBtn.appendChild(removeLabel);
      actions.appendChild(removeBtn);
      item.appendChild(actions);

      frag.appendChild(item);
    }
    targetEl.replaceChildren(frag);
  };

  const bindFolderActions = () => {
    scope.querySelectorAll("[data-remove-folder]").forEach((btn) => {
      btn.onclick = async () => {
        const folder = btn.getAttribute("data-remove-folder");
        if (!folder || isScanLocked(scanProgress)) return;
        setStatus("Removing folder...");
        try {
          const res = await bridge.callTool("index_folders", { action: "remove", folder });
          await loadFolders();
          setStatus(res.message || "Folder removed.");
          void refreshDocuments({ quiet: true });
        } catch (error) {
          setStatus(`Error: ${formatErrorMessage(error)}`);
        }
      };
    });
    scope.querySelectorAll("[data-refresh-folder]").forEach((btn) => {
      btn.onclick = async () => {
        const folder = btn.getAttribute("data-refresh-folder");
        if (!folder || isScanLocked(scanProgress)) return;
        setStatus("Refreshing folder...");
        try {
          const res = await bridge.callTool("index_scan", { folder });
          await loadFolders();
          void refreshDocuments({ quiet: true });
          setStatus(res.message || "Folder refreshed.");
        } catch (error) {
          setStatus(`Error: ${formatErrorMessage(error)}`);
        }
      };
    });
    syncControls();
  };

  const renderFolders = (folders, summaries) => {
    registeredFolders = Array.isArray(folders) ? folders : [];
    folderSummaries = Array.isArray(summaries) ? summaries : [];
    // A folder belongs in the "indexed" group when this scan cycle's per-
    // folder counter shows it finished (`processed >= total`). Without a
    // live counter, fall back to the pre-scan summary status so freshly
    // mounted UI still groups things correctly.
    const isFolderDone = (summary) => {
      const counter = scanProgress?.byFolder?.[summary.folder];
      if (counter && counter.total > 0) return counter.processed >= counter.total;
      return summary.status === "indexed";
    };
    const pending = folderSummaries.filter((summary) => !isFolderDone(summary));
    const indexed = folderSummaries.filter(isFolderDone);
    if (pendingCountEl) pendingCountEl.textContent = String(pending.length);
    if (indexedCountEl) indexedCountEl.textContent = String(indexed.length);
    renderFolderCards(pendingFolderListEl, pending, "스캔 대기 중인 폴더가 없습니다");
    renderFolderCards(indexedFolderListEl, indexed, "인덱싱된 폴더가 없습니다", { showRefresh: true });
    bindFolderActions();
  };

  const loadFolders = async () => {
    try {
      const res = await bridge.callTool("index_folders");
      renderFolders(res?.folders || [], res?.summaries || []);
    } catch {
      renderFolders([], []);
    }
  };

  // 1,000개 이상의 문서를 다시 그릴 때 매 appendChild 마다 layout 이 흔들리는
  // 비용을 피하려고 DocumentFragment 에 모아서 한 번의 replaceChildren 호출로
  // 교체한다 — empty state 도 같은 패턴으로 통일해 innerHTML="" 후에 또 setting
  // 하던 이중 reflow 를 제거.
  // 사용자 입력(문서명·파일 경로)은 createElement + textContent + setAttribute
  // 로만 작성한다. innerHTML 은 신뢰된 상수 SVG 아이콘 삽입에만 한정.
  const renderDocuments = (docs, options = {}) => {
    if (!docListEl) return;
    if (docCountEl) docCountEl.textContent = String(docs.length);
    if (docCountBadgeEl) docCountBadgeEl.textContent = String(docs.length);
    if (docs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "doc-empty";
      const iconHolder = document.createElement("span");
      iconHolder.innerHTML = ICONS.empty; // trusted constant SVG
      empty.appendChild(iconHolder);
      const msg = document.createElement("div");
      msg.textContent = getDocumentEmptyMessage({
        hasFolders: registeredFolders.length > 0,
        scanStatus: scanProgress.status,
        error: options.error,
      });
      empty.appendChild(msg);
      docListEl.replaceChildren(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const doc of docs) {
      const type = getDocType(doc);
      // Defense-in-depth on the class-name fragment — only allow simple
      // alphanumeric type tokens so unexpected getDocType() output can't
      // inject extra classes via the `t-${type}` suffix.
      const safeType = /^[a-z0-9]+$/i.test(String(type)) ? type : "default";
      const icon = FILE_ICONS[type] || FILE_ICONS.default;
      const metric = getDocMetricLabel(doc);
      const fullPath = getDocPath(doc);
      const basename = fullPath ? fullPath.replace(/^.*[/\\]/, "") : "";
      const docName = getDocName(doc);

      const item = document.createElement("div");
      item.className = "doc-item";

      const iconTile = document.createElement("div");
      iconTile.className = `doc-icon-tile t-${safeType}`;
      iconTile.innerHTML = icon; // trusted constant SVG from FILE_ICONS table
      item.appendChild(iconTile);

      const info = document.createElement("div");
      info.className = "doc-info";

      const nameEl = document.createElement("div");
      nameEl.className = "doc-name";
      nameEl.title = docName;
      nameEl.textContent = docName;
      info.appendChild(nameEl);

      const docMeta = document.createElement("div");
      docMeta.className = "doc-meta";
      const typeTag = document.createElement("span");
      typeTag.className = "type-tag";
      typeTag.textContent = String(type).toUpperCase();
      docMeta.appendChild(typeTag);
      const dot1 = document.createElement("span");
      dot1.className = "dot-sep";
      dot1.textContent = "·";
      docMeta.appendChild(dot1);
      const metricEl = document.createElement("span");
      metricEl.textContent = metric;
      docMeta.appendChild(metricEl);
      if (basename) {
        const dot2 = document.createElement("span");
        dot2.className = "dot-sep";
        dot2.textContent = "·";
        docMeta.appendChild(dot2);
        const pathEl = document.createElement("span");
        pathEl.className = "doc-path";
        pathEl.title = fullPath;
        pathEl.textContent = basename;
        docMeta.appendChild(pathEl);
      }
      info.appendChild(docMeta);
      item.appendChild(info);

      frag.appendChild(item);
    }
    docListEl.replaceChildren(frag);
  };

  const renderSettings = () => {
    if (imageEmbeddingToggle) {
      imageEmbeddingToggle.checked = settings.imageEmbeddingEnabled === true;
    }
    const mode = normalizeCaptionMode(settings.imageCaptionMode);
    if (imageProviderLocal) imageProviderLocal.checked = mode === "local";
    const provider = normalizeCaptionProvider(settings.imageCaptionProvider);
    if (providerSummaryEl) {
      const label =
        provider === "azure-openai-responses" ? "Azure OpenAI (responses)"
        : provider === "azure-openai-chat" ? "Azure OpenAI (chat completions)"
        : "OpenAI Vision";
      // Show the human-readable provider name only — endpoint URL stays
      // in the plugin settings panel so the main UI doesn't surface
      // potentially-sensitive config (resource-name URLs, internal proxy
      // hosts, etc.) on the main screen.
      providerSummaryEl.textContent = label;
    }
    // Cloud providers (모두 키 필요). local 만 키 없이 동작.
    const needsApiKey = !settings.hasApiKey;
    if (apiKeyErrorEl) {
      apiKeyErrorEl.hidden = !needsApiKey;
    }
    // local provider 는 HuggingFace hub 접근 필요 — 사내망/방화벽 환경에서
    // BLIP 모델 다운로드 실패. 사용자가 명시적으로 선택했을 때만 경고.
  };

  const loadSettings = async () => {
    try {
      const res = await bridge.callTool("index_get_settings");
      if (res && typeof res === "object") {
        settings = {
          imageEmbeddingEnabled: res.imageEmbeddingEnabled === true,
          imageCaptionMode: normalizeCaptionMode(res.imageCaptionMode),
          imageCaptionProvider: normalizeCaptionProvider(res.imageCaptionProvider),
          imageCaptionModel:
            typeof res.imageCaptionModel === "string" ? res.imageCaptionModel : "",
          imageCaptionEndpoint:
            typeof res.imageCaptionEndpoint === "string" ? res.imageCaptionEndpoint : "",
          hasApiKey: res.hasApiKey === true,
        };
      }
    } catch (error) {
      // 설정 로딩 실패는 fatal 아님 — 디폴트 값으로 진행, 사용자가 토글하면
      // 다시 시도된다.
      setStatus(`설정 로딩 실패: ${formatErrorMessage(error)}`);
    }
    renderSettings();
  };

  // Narrow refresh: only re-pulls hasApiKey from the host. Used after
  // the user clicks the OpenAI radio so a freshly-entered API key shows
  // up in the warning row without clobbering the user's staged toggle/
  // provider changes (which would happen if we called full loadSettings).
  const refreshApiKeyStatus = async () => {
    try {
      const res = await bridge.callTool("index_get_settings");
      if (res && typeof res === "object" && typeof res.hasApiKey === "boolean") {
        settings = { ...settings, hasApiKey: res.hasApiKey };
        renderSettings();
      }
    } catch {
      // No status update — this is a background nicety, not a critical path.
    }
  };

  // Serialise pushSettings so rapid toggle/radio clicks don't fire
  // concurrent index_set_image_embedding calls — concurrent calls were
  // observed to thrash the worker restart loop (port 43129 busy) and
  // wedge the host plugin lifecycle (methodMap getting cleared mid-flight).
  //
  // The earlier coalescer returned the in-flight promise to every caller,
  // which silently DROPPED diverging args (user clicks toggle ON then
  // immediately switches provider — second click was discarded). Replaced
  // with a serial tail: each pushSettings appends to the chain so all
  // intents reach the host in order, but only one runs at a time.
  let pushTail = Promise.resolve();

  const pushSettings = ({ enabled }) => {
    const run = async () => {
      try {
        // The main UI only owns the toggle. The host reads provider /
        // endpoint / model / apiKey from its config + secret store on
        // every push and returns them in the response so we can refresh
        // the read-only summary line.
        const res = await bridge.callTool("index_set_image_embedding", { enabled, mode: "cloud" });
        if (res && typeof res === "object") {
          settings = {
            ...settings,
            imageEmbeddingEnabled: res.imageEmbeddingEnabled === true,
            imageCaptionMode: normalizeCaptionMode(res.imageCaptionMode),
            imageCaptionProvider: normalizeCaptionProvider(res.imageCaptionProvider),
            imageCaptionModel:
              typeof res.imageCaptionModel === "string" ? res.imageCaptionModel : settings.imageCaptionModel,
            imageCaptionEndpoint:
              typeof res.imageCaptionEndpoint === "string" ? res.imageCaptionEndpoint : settings.imageCaptionEndpoint,
            hasApiKey:
              typeof res.hasApiKey === "boolean" ? res.hasApiKey : settings.hasApiKey,
          };
          if (typeof res.message === "string") setStatus(res.message);
        }
        renderSettings();
      } catch (error) {
        setStatus(`설정 저장 실패: ${formatErrorMessage(error)}`);
        // 실패 시 UI 를 직전 상태로 되돌린다 — 사용자가 보는 토글과 호스트
        // 진실값이 어긋난 채로 남지 않도록.
        renderSettings();
        throw error;
      }
    };
    // Append to the chain — `.then(() => run())` ensures `run` only starts
    // after the previous tail settles, and `.catch` on the chain prevents
    // a single failure from poisoning subsequent calls.
    pushTail = pushTail.then(run, run);
    return pushTail;
  };

  // Toggle / radio clicks update LOCAL settings only — they do NOT call
  // index_set_image_embedding on each interaction. The settings are
  // committed in one shot when the user hits "인덱싱 시작" (see scanBtn
  // handler below). This avoids worker restart thrash and matches the
  // "stage then apply on scan" mental model.
  let settingsDirty = false;

  const stageSetting = (patch, label) => {
    settings = { ...settings, ...patch };
    settingsDirty = true;
    renderSettings();
    setStatus(`${label} — 인덱싱 시작 시 적용됩니다.`);
  };

  on(imageEmbeddingToggle, "change", () => {
    const enabled = imageEmbeddingToggle?.checked === true;
    stageSetting(
      { imageEmbeddingEnabled: enabled },
      enabled ? "이미지 캡션 켜짐" : "이미지 캡션 꺼짐",
    );
  });

  on(imageProviderLocal, "change", () => {
    if (imageProviderLocal?.checked !== true) return;
    stageSetting({ imageCaptionMode: "local" }, "로컬 캡션 모드");
  });

  on(imageProviderCloud, "change", () => {
    if (imageProviderCloud?.checked !== true) return;
    stageSetting({ imageCaptionMode: "cloud" }, "Cloud API 캡션 모드");
    void refreshApiKeyStatus();
  });

  // Radio inputs only fire `change` when the selected value flips. The
  // wrapping <label> is the actual click target users hit, so we attach
  // a click listener there — it fires every time, even when the user
  // clicks the already-selected option. Native HTML keeps the input in
  // sync with the label click.
  // Provider / endpoint / API key controls live in the plugin settings
  // panel (Ave side). The main UI only owns the toggle, so there
  // are no click/input handlers for those fields here — they were
  // intentionally removed when settings moved to plugin config.

  on(addFolderBtn, "click", async () => {
    if (isScanLocked(scanProgress)) return;
    setStatus("폴더 선택 중...");
    let picked;
    try {
      picked = await bridge.callTool("index_pick_folder");
    } catch (error) {
      setStatus(`폴더 선택 실패: ${formatErrorMessage(error)}`);
      return;
    }
    const folders = Array.isArray(picked?.folders) ? picked.folders : [];
    if (!picked || picked.canceled || folders.length === 0) {
      setStatus("Ready");
      return;
    }

    setStatus(`폴더 미리보기 중... (${folders.length}개)`);
    let previews;
    try {
      previews = await Promise.all(
        folders.map((folder) =>
          bridge
            .callTool("index_preview_folder", { folder })
            .catch((err) => ({ folder, total: 0, byType: {}, sample: [], error: formatErrorMessage(err) })),
        ),
      );
    } catch (error) {
      setStatus(`미리보기 실패: ${formatErrorMessage(error)}`);
      return;
    }

    const confirmed = await showFolderPreviewModal({ scope, previews, icons: ICONS });
    if (confirmed.length === 0) {
      setStatus("취소됨");
      return;
    }

    setStatus(`폴더 ${confirmed.length}개 추가 중...`);
    let added = 0;
    let skipped = 0;
    const failures = [];
    try {
      const res = await bridge.callTool("index_folders", { action: "add", folders: confirmed });
      added = Array.isArray(res?.added) ? res.added.length : 0;
      skipped = Array.isArray(res?.skipped) ? res.skipped.length : 0;
      if (Array.isArray(res?.failures)) {
        for (const item of res.failures) {
          failures.push(`${item.folder}: ${item.error}`);
        }
      }
    } catch (error) {
      // 배열 자체가 거부된 케이스 — 모든 폴더를 실패로 집계.
      for (const folder of confirmed) {
        failures.push(`${folder}: ${formatErrorMessage(error)}`);
      }
    }
    await loadFolders();
    void refreshDocuments({ quiet: true });
    const parts = [`추가 ${added}개`];
    if (skipped > 0) parts.push(`이미 등록 ${skipped}개`);
    if (failures.length > 0) parts.push(`실패 ${failures.length}개`);
    setStatus(parts.join(", ") + (failures.length > 0 ? ` — ${failures[0]}` : ""));
    // Note: do NOT auto-trigger index_scan here. Per user preference
    // scanning stays manual — folder add only registers the path; the
    // user presses "인덱싱 시작" to actually scan.
  });

  on(searchInput, "input", () => {
    const q = (searchInput?.value || "").toLowerCase().trim();
    if (!q) {
      renderDocuments(allDocs);
      return;
    }
    const filtered = allDocs.filter((doc) => {
      const name = getDocName(doc).toLowerCase();
      const fullPath = getDocPath(doc).toLowerCase();
      const type = getDocType(doc).toLowerCase();
      return name.includes(q) || fullPath.includes(q) || type.includes(q);
    });
    renderDocuments(filtered);
  });

  // Transient errors we will auto-retry the scan call against. The host's
  // plugin runtime briefly empties methodMap during reloads (e.g. after
  // setAllowedRoots or worker restart triggered by a permission grant),
  // so callTool can race that window and come back with "도구를 찾을 수
  // 없습니다" or "Plugin method not found" — both fully recoverable by
  // waiting for the reload to settle.
  const TRANSIENT_ERROR_PATTERNS = [
    /도구를 찾을 수 없습니다/,
    /Plugin method not found/i,
    /plugin not loaded/i,
    /worker not ready/i,
    /ECONNREFUSED/i,
  ];
  const isTransientError = (err) =>
    TRANSIENT_ERROR_PATTERNS.some((re) => re.test(formatErrorMessage(err)));

  const callWithRetry = async (toolName, payload, _label) => {
    const maxAttempts = 4;
    const delaysMs = [400, 900, 1600];
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await bridge.callTool(toolName, payload);
      } catch (error) {
        lastError = error;
        if (attempt === maxAttempts || !isTransientError(error)) {
          throw error;
        }
        // Retry silently — no status bar message during backoff. The
        // optimistic scan-running indicator already painted by the
        // caller stays in place so the user sees "starting" continuously
        // rather than a confusing "preparing... retry" hop.
        await new Promise((r) => setTimeout(r, delaysMs[attempt - 1]));
      }
    }
    throw lastError;
  };

  on(scanBtn, "click", async () => {
    if (isScanLocked(scanProgress)) return;

    // index_scan must visibly start the moment the button is clicked.
    // Paint the optimistic running state first, then commit staged settings
    // before scan dispatch so the host walker and worker captioning state
    // observe the same image-routing decision.
    clearWarningsLocal({ resetDismissed: true });
    void clearWarningsHost();
    applyScanProgress({ status: "running", total: 0, processed: 0, indexed: 0, failed: 0 });

    if (settingsDirty) {
      const dirty = {
        enabled: settings.imageEmbeddingEnabled,
        mode: normalizeCaptionMode(settings.imageCaptionMode),
      };
      try {
        await pushSettings(dirty);
        settingsDirty = false;
      } catch (error) {
        applyScanProgress({
          status: "failed",
          total: 0,
          processed: 0,
          indexed: 0,
          failed: 0,
          message: `이미지 캡션 설정 적용 실패 — 스캔 중단: ${formatErrorMessage(error)}`,
        });
        return;
      }
    }

    try {
      await callWithRetry("index_scan", undefined, "인덱싱");
      await pollScanStatusOnce();
      if (!isScanLocked(scanProgress)) {
        await refreshDocuments({ quiet: true });
      }
    } catch (error) {
      applyScanProgress({
        status: "failed",
        total: scanProgress.total,
        processed: scanProgress.processed,
        indexed: scanProgress.indexed,
        failed: scanProgress.failed,
        message: `실패: ${formatErrorMessage(error)}`,
      });
    }
  });

  on(stopScanBtn, "click", async () => {
    if (!isScanLocked(scanProgress)) return;
    try {
      const res = await bridge.callTool("index_scan_cancel");
      setStatus(res?.message || "스캔 중단 요청 중...");
      await pollScanStatusOnce();
    } catch (error) {
      setStatus(`Error: ${error.message}`);
    }
  });

  on(refreshBtn, "click", () => {
    if (isScanLocked(scanProgress)) return;
    void loadFolders();
    void refreshDocuments();
  });

  on(refreshFoldersBtn, "click", async () => {
    if (isScanLocked(scanProgress)) return;
    if (refreshFoldersBtn) refreshFoldersBtn.disabled = true;
    setStatus("폴더 상태 새로고침 중...");
    try {
      await bridge.callTool("index_folders_purge_orphans");
      await loadFolders();
      await refreshDocuments({ quiet: true });
      setStatus("폴더 상태 새로고침 완료.");
    } catch (error) {
      setStatus(`폴더 새로고침 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (refreshFoldersBtn) refreshFoldersBtn.disabled = false;
      syncControls();
    }
  });

  // Host events reach a plugin panel through the guest bridge, never through
  // `window.aveApi`. The panel runs in a sandboxed <webview> whose preload
  // exposes `avePlugin` only and deliberately withholds the host surface, so
  // `window.aveApi` is always undefined here and every subscription hung off
  // it silently did nothing. Progress still moved and warnings still appeared
  // because `index_scan_status` carries both, which is exactly why this went
  // unnoticed: the panel looked alive.
  //
  // The 경고 지우기 wiring sat inside the same `if`, so the button was dead —
  // visible, enabled, connected to nothing. Registering it next to the other
  // controls, outside any capability check, is the point: an affordance the
  // panel renders unconditionally has to be wired unconditionally.
  cleanups.push(bridge.onEvent("index.scan.progress", (payload) => {
    applyScanProgress(payload);
  }));
  cleanups.push(bridge.onEvent("index.warning", (payload) => {
    appendWarning(payload);
  }));
  if (clearWarningsBtn) {
    on(clearWarningsBtn, "click", () => {
      clearWarningsLocal({ dismiss: true });
      void clearWarningsHost();
    });
  }

  // Theme sync — SDK primeTheme handles cold-boot `getTheme()` pull +
  // `host.theme.changed` subscribe + validated --ave-* token paint to
  // `scope.style` (inline styles win over the static scope-local fallback in
  // ave-tokens.css.js). Mirrors the meeting plugin's pattern: a single
  // call replaces the hand-rolled bundleId/shell attribute mirroring and
  // the cold-boot race window — primeTheme races getTheme() against the
  // initial onEvent broadcast and applies whichever lands first.
  const themeHandle = primeTheme(bridge, { target: scope });
  cleanups.push(() => themeHandle.dispose());

  void (async () => {
    // Settings are independent of folders/scan — load them first so the
    // toggle is consistent before the user can interact with the UI.
    await loadSettings();

    try {
      await loadFolders();
    } catch {
      // loadFolders already normalizes its own failure path.
    }

    try {
      await pollScanStatusOnce();
    } catch (error) {
      setStatus(`Initial scan status failed: ${formatErrorMessage(error)}`);
    }

    try {
      await refreshDocuments({ quiet: true });
      if (!isScanLocked(scanProgress) && scanProgress.status === "idle") {
        setStatus(`Loaded ${allDocs.length} documents.`);
      }
    } catch (error) {
      if (!isScanLocked(scanProgress)) {
        setStatus(`Initial load failed: ${formatErrorMessage(error)}`);
      }
    }
  })();

  return () => {
    stopScanStatusPolling();
    cleanups.forEach((fn) => fn());
    root.replaceChildren();
  };
}

export default mount;
