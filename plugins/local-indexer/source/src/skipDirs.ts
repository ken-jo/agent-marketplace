// 인덱싱 / 스캔 양쪽에서 재귀 진입을 건너뛸 디렉터리 이름 단일 출처.
// `hostPlugin.ts` (listIndexableFiles) 와 `folderIndexer.ts` (auto-scan
// recursion) 가 각자 동일한 set 을 들고 있으면 한 쪽만 갱신됐을 때 스캔
// 결과와 요약 결과가 어긋난다 — 한 곳에서만 import 하도록 모은다.
//
// 추가 / 변경 시 두 모듈의 동작이 일치하는지 확인할 것.
export const SKIP_DIR_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  ".next",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  "target",
]);
