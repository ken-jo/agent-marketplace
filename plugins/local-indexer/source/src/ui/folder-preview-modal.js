// folder-preview-modal.js — "폴더 추가" 시 사용자가 선택한 폴더들의
// 인덱싱 가능 파일 미리보기를 보여주는 모달.
//
// 사용자 입력(폴더 경로·파일명·오류 메시지)이 attribute / textContent 로만
// 흘러가도록 DOM API 만 사용한다. innerHTML 은 신뢰된 상수 SVG 아이콘
// 삽입에만 한정 — 따옴표/꺾쇠가 들어간 파일명이 와도 DOM 구조가 깨지지
// 않는다.

// previews: [{ folder, total, byType, sample, error }] 구조의 배열.
// 사용자가 확정한 폴더 경로 배열을 resolve 한다 — 취소 시 빈 배열.
export function showFolderPreviewModal({ scope, previews, icons }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "preview-overlay";

    const checked = new Set(previews.filter((p) => p.total > 0 && !p.error).map((p) => p.folder));
    const totalIndexable = previews.reduce((sum, p) => sum + (p.total || 0), 0);

    const buildRow = (preview, idx) => {
      const isDisabled = preview.error || preview.total === 0;
      const isChecked = checked.has(preview.folder);

      const label = document.createElement("label");
      label.className = "preview-row" + (isDisabled && !isChecked ? " disabled" : "");

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.idx = String(idx);
      cb.checked = isChecked;
      if (isDisabled) cb.disabled = true;

      const body = document.createElement("div");
      body.className = "preview-row-body";

      const folderEl = document.createElement("div");
      folderEl.className = "preview-folder";
      folderEl.title = preview.folder;
      folderEl.textContent = preview.folder;
      body.appendChild(folderEl);

      const metaEl = document.createElement("div");
      metaEl.className = "preview-meta" + (preview.error ? " error" : preview.total === 0 ? " empty" : "");
      if (preview.error) {
        metaEl.textContent = `오류: ${preview.error}`;
      } else if (preview.total === 0) {
        metaEl.textContent = "인덱싱 가능 파일 없음";
      } else {
        metaEl.textContent = Object.entries(preview.byType)
          .sort((a, b) => b[1] - a[1])
          .map(([ext, n]) => `${ext} ${n}`)
          .join(", ");
      }
      body.appendChild(metaEl);

      if (preview.sample.length > 0) {
        const filesEl = document.createElement("div");
        filesEl.className = "preview-files";
        for (const name of preview.sample) {
          const fileLine = document.createElement("div");
          fileLine.className = "preview-file-name";
          fileLine.title = name;
          fileLine.textContent = `▸ ${name}`;
          filesEl.appendChild(fileLine);
        }
        if (preview.total > preview.sample.length) {
          const more = document.createElement("div");
          more.className = "preview-file-name more";
          more.textContent = `… 외 ${preview.total - preview.sample.length}개`;
          filesEl.appendChild(more);
        }
        body.appendChild(filesEl);
      }

      label.appendChild(cb);
      label.appendChild(body);
      return label;
    };

    // Shell — role/aria attrs + SVG icons are trusted constants. SVG
    // strings come from indexer-control.js ICONS table (compile-time).
    const modal = document.createElement("div");
    modal.className = "preview-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "폴더 미리보기");
    modal.tabIndex = -1;

    const head = document.createElement("div");
    head.className = "preview-head";
    const headIcon = document.createElement("span");
    headIcon.innerHTML = icons.folder; // trusted constant SVG
    head.appendChild(headIcon);
    const headTitle = document.createElement("div");
    headTitle.className = "preview-title";
    headTitle.textContent = `선택한 폴더 미리보기 (${previews.length}개 · 인덱싱 가능 ${totalIndexable}개)`;
    head.appendChild(headTitle);

    const bodyEl = document.createElement("div");
    bodyEl.className = "preview-body";
    previews.forEach((preview, idx) => bodyEl.appendChild(buildRow(preview, idx)));

    const foot = document.createElement("div");
    foot.className = "preview-foot";
    const summarySpan = document.createElement("span");
    summarySpan.className = "summary";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "ghost";
    cancelBtn.dataset.action = "cancel";
    cancelBtn.textContent = "취소";
    const confirmBtn = document.createElement("button");
    confirmBtn.className = "primary-cta";
    confirmBtn.dataset.action = "confirm";
    confirmBtn.innerHTML = icons.plus; // trusted constant SVG (no user data)
    const confirmLabel = document.createElement("span");
    confirmLabel.textContent = "선택 폴더 추가";
    confirmBtn.appendChild(confirmLabel);
    foot.appendChild(summarySpan);
    foot.appendChild(cancelBtn);
    foot.appendChild(confirmBtn);

    modal.appendChild(head);
    modal.appendChild(bodyEl);
    modal.appendChild(foot);
    overlay.appendChild(modal);

    const updateFooter = () => {
      summarySpan.textContent = `${checked.size} / ${previews.length}개 폴더 선택됨`;
      confirmBtn.disabled = checked.size === 0;
    };

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const getFocusable = () => {
      const nodes = overlay.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      return Array.from(nodes).filter((el) => el instanceof HTMLElement && el.offsetParent !== null);
    };

    const close = (result) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      if (previousFocus && document.contains(previousFocus)) previousFocus.focus();
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        close([]);
        return;
      }
      if (e.key === "Tab") {
        const focusables = getFocusable();
        if (focusables.length === 0) {
          e.preventDefault();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !overlay.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !overlay.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);

    overlay.addEventListener("change", (e) => {
      const cb = e.target;
      if (cb instanceof HTMLInputElement && cb.type === "checkbox") {
        const idx = Number(cb.dataset.idx);
        const preview = previews[idx];
        if (!preview) return;
        if (preview.error || preview.total === 0) {
          cb.checked = false;
          return;
        }
        if (cb.checked) checked.add(preview.folder);
        else checked.delete(preview.folder);
        updateFooter();
      }
    });

    overlay.addEventListener("click", (e) => {
      const target = e.target;
      const action = target?.closest?.("[data-action]")?.dataset?.action;
      if (action === "cancel") close([]);
      else if (action === "confirm") close([...checked]);
      else if (target === overlay) close([]);
    });

    scope.appendChild(overlay);
    updateFooter();
    cancelBtn.focus();
  });
}
