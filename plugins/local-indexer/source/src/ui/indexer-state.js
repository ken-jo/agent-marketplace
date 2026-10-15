// indexer-state.js — 순수 헬퍼 모음.
// indexer-control.js 의 렌더링/IPC 로직과 분리해 단위 테스트(test/indexerControl.test.ts)
// 에서도 import 해서 검증할 수 있도록 별도 모듈로 추출.

export const FILE_ICONS = {
  pdf: "\u{1F4C4}",
  md: "\u{1F4DD}",
  markdown: "\u{1F4DD}",
  txt: "\u{1F4C3}",
  html: "\u{1F310}",
  docx: "\u{1F4C4}",
  pptx: "\u{1F4CA}",
  xlsx: "\u{1F4C8}",
  default: "\u{1F4C1}",
};

export function getDocName(doc) {
  return doc.doc_name || doc.docName || "unknown";
}

export function getDocType(doc) {
  return String(doc.doc_type || doc.type || "default").toLowerCase();
}

export function getDocPath(doc) {
  return doc.path || "";
}

export function getPageCount(doc) {
  return doc.page_count ?? doc.pageCount;
}

export function getLineCount(doc) {
  return doc.line_count ?? doc.lineCount;
}

export function getDocMetricLabel(doc) {
  const type = getDocType(doc);
  if (type === "md" || type === "markdown" || type === "txt") {
    return `${getLineCount(doc) ?? "?"} lines`;
  }
  return `${getPageCount(doc) ?? "?"} pages`;
}

function normalizeFolderCounters(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const out = {};
  for (const [folder, counter] of Object.entries(raw)) {
    if (!counter || typeof counter !== "object") continue;
    out[folder] = {
      total: Number.isFinite(counter.total) ? Number(counter.total) : 0,
      processed: Number.isFinite(counter.processed) ? Number(counter.processed) : 0,
      indexed: Number.isFinite(counter.indexed) ? Number(counter.indexed) : 0,
      failed: Number.isFinite(counter.failed) ? Number(counter.failed) : 0,
    };
  }
  return out;
}

export function normalizeScanProgress(progress) {
  const source = progress && typeof progress === "object" ? progress : {};
  return {
    status: source.status === "running" || source.status === "done" || source.status === "failed" || source.status === "canceled"
      ? source.status
      : "idle",
    total: Number.isFinite(source.total) ? Number(source.total) : 0,
    processed: Number.isFinite(source.processed) ? Number(source.processed) : 0,
    indexed: Number.isFinite(source.indexed) ? Number(source.indexed) : 0,
    failed: Number.isFinite(source.failed) ? Number(source.failed) : 0,
    currentPath: typeof source.currentPath === "string" ? source.currentPath : undefined,
    message: typeof source.message === "string" ? source.message : undefined,
    byFolder: normalizeFolderCounters(source.byFolder),
  };
}

export function isScanLocked(progress) {
  return normalizeScanProgress(progress).status === "running";
}

export function getProgressPercent(progress) {
  const normalized = normalizeScanProgress(progress);
  if (normalized.status === "idle") return 0;
  if (normalized.total <= 0) return normalized.status === "running" ? 0 : 100;
  return Math.max(0, Math.min(100, Math.round((normalized.processed / normalized.total) * 100)));
}

export function getScanStatusText(progress) {
  const normalized = normalizeScanProgress(progress);
  if (normalized.status === "running") {
    const basename = normalized.currentPath ? normalized.currentPath.replace(/^.*[/\\]/, "") : "";
    return basename
      ? `처리 완료 ${normalized.processed} / ${normalized.total} (${basename})`
      : `처리 완료 ${normalized.processed} / ${normalized.total}`;
  }
  if (normalized.status === "done") {
    return `스캔 완료. 처리 완료 ${normalized.processed} / ${normalized.total}`;
  }
  if (normalized.status === "canceled") {
    return `스캔 중단됨. 처리 완료 ${normalized.processed} / ${normalized.total}`;
  }
  if (normalized.status === "failed") {
    return normalized.message || `실패: ${normalized.failed}개 파일 처리 실패`;
  }
  return normalized.message || "Ready";
}

export function getDocumentEmptyMessage({ hasFolders = false, scanStatus, error } = {}) {
  if (error) {
    return `Failed to load indexed documents.\n${String(error)}`;
  }
  if (hasFolders && scanStatus === "idle") {
    return "폴더가 등록됐지만 아직 스캔되지 않았습니다.\nScan 버튼을 눌러 인덱싱을 시작하세요.";
  }
  if (hasFolders) {
    return "인덱싱된 문서가 없습니다.\nScan을 실행하거나 Refresh를 눌러 주세요.";
  }
  return "No indexed documents yet.\nAdd a folder and run Scan.";
}
