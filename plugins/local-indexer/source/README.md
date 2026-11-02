# @ave/plugin-local-indexer

Ave 데스크톱 앱의 **로컬 문서 인덱싱 + 하이브리드 검색** 익스텐션 (v0.7.0).

## 특징

- **완전 자동 셋업** — uv standalone binary가 Python 3.12 + venv + 의존성을 자동으로 설치. 사용자가 직접 Python을 설치할 필요 없음
- **한국어 검색** — kiwipiepy 형태소 분석 + SQLite FTS5 unicode61 (패턴 B). "규정"으로 "규정집/규정은/규정한다" 모두 검색 가능
- **하이브리드 검색** — BM25 (FTS5) + Vector (lancedb) RRF(k=60) 결합. R4 8쿼리 8/8 hit
- **자연어 사용** — 채팅에 "작년 연차 규정이 어떻게 바뀌었어?" 입력 시 function calling으로 자동 문서 탐색
- **이미지 캡션** — 이미지 임베딩 파이프라인 (이미지→캡션→텍스트) 선택적 활성화 가능

## 설치

사용자가 따로 설치할 것은 없습니다. Ave 앱을 처음 실행하면 자동으로:

1. `uv` standalone binary 실행
2. Python 3.12 설치 (`~/.ave/runtime/python/`)
3. venv 생성 (`~/.ave/runtime/venv/`)
4. 의존성 설치 (`uv pip sync --frozen python-requirements.lock`)
5. `.ready` sentinel 생성 → 이후 부팅 시 즉시 skip

**소요 시간**: 첫 부팅 ~40-50초 (macOS Apple Silicon 기준), 이후 <1.5초

## 사용법

Ave 채팅에서 자연어로 사용합니다:

```
"연차 규정 검색해줘"
"출장 품의서 양식 어디 있어?"
"Q3 마케팅 보고서 내용 요약해줘"
"규정집에서 보안 정책 찾아줘"
```

또는 사이드바의 **Local Indexer 컨트롤**에서:
- 인덱싱할 폴더 추가/제거
- 현재 인덱싱 상태 확인
- 수동 재스캔

### Ave 익스텐션 도구

| 도구 | 설명 |
|------|------|
| `index_search` | BM25/벡터/하이브리드 모드로 문서 청크 검색 (기본: 하이브리드) |
| `index_scan` | 등록 폴더 전체 스캔, 한 폴더의 증분 갱신(`folder`), 또는 일회성 경로 인덱싱(`paths`) |
| `index_folders` | `list`(기본) / `add` / `remove` 액션으로 감시 폴더 관리 |
| `index_documents` | 인덱싱된 문서 메타데이터 목록 반환 (페이지네이션) |
| `index_get_document` | 특정 문서 메타데이터와 선택적 본문(`pages`/`includeContent`)·인덱싱된 페이지 목록(`includeStructure`) 조회 |
| `index_scan_status` | 현재 또는 마지막 스캔 진행 상태 조회 |
| `index_scan_cancel` | 진행 중인 스캔 중단 요청 |
| `index_clear_warnings` | Local Indexer UI의 최근 경고 목록 초기화 |
| `index_folders_purge_orphans` | 삭제·이동된 폴더의 고아 인덱스 항목 정리 |
| `index_pick_folder` | OS 폴더 선택 다이얼로그 열기 |
| `index_preview_folder` | 등록 전 폴더의 인덱싱 대상 파일 통계와 샘플 미리보기 |
| `index_get_settings` | 현재 임베딩·이미지 캡션 설정 조회 |
| `index_set_image_embedding` | 이미지 캡션 파이프라인 활성화 여부 변경 |

### 알림

`index-scan-completed`와 `index-folders-changed`는 스캔 종료와 등록 폴더 변경을 요약에 반영하는 알림입니다. 두 종류 모두 기본적으로 꺼져 있으며, 사용자가 알림 설정에서 각각 켤 수 있습니다. 문서 내용과 폴더 경로는 알림에 포함되지 않습니다. 야간 재스캔 루틴 제안은 기존의 일회성 제안으로 유지됩니다.

## 지원 포맷

| 포맷 | 파서 | 비고 |
|------|------|------|
| PDF | `pymupdf4llm` | 한국어 폰트 깨짐 우회 |
| DOCX | stdlib XML 직접 파싱 | 표 + 단락 추출 (python-docx 미사용) |
| PPTX | stdlib ZIP+XML 직접 파싱 | 슬라이드 텍스트 추출 |
| XLSX | Microsoft `markitdown` | 셀 내용 추출 |
| MD / MARKDOWN / TXT | 직접 읽기 | |

> 이미지 내 텍스트(OCR)는 이미지 캡션 파이프라인(`index_set_image_embedding`)으로 PDF/PPTX/DOCX/XLSX 내 이미지를 처리할 수 있습니다.

## 한국어 검색 품질

**패턴 B** (kiwipiepy + FTS5 unicode61) 적용:

```
원문: "회사 연차 규정에 따라 직원은 연간 15일의 연차를 사용할 수 있다."
토큰: 회사 연차 규정 따라 직원 연간 일 연차 사용 있다
FTS5: "규정" 검색 → "규정집", "규정은", "규정한다" 모두 hit
```

검증: R4 벤치마크 8쿼리 8/8 hit (목표 4/8 초과)

## Architecture

```
Ave Client (Electron/TypeScript)
  └── local-indexer plugin
        ├── hostPlugin.ts        — 통합 도구 dispatch, HostApi/설정/egress 관리
        ├── localIndexerPlugin.ts — Python worker 실행 + lifecycle
        ├── workerClient.ts      — worker stdio control v1 요청 클라이언트
        ├── egressBroker.ts      — 워커의 egress_embedding / egress_caption 요청을 hostFetch 로 중계
        ├── indexMigration.ts    — 0.8.0 인덱스 위치 이동 시 재구축 + 이전 인덱스 정리
        ├── folderIndexer.ts     — chokidar 파일 감시 + eager indexIfChanged
        └── indexState.ts        — index-state.json 추적

Python Worker (stdin/stdout 위 worker stdio control v1, 로그는 stderr)
  ├── local_indexer_worker.py  — 진입점 + 요청 메서드 표 (asyncio, 무거운 작업은 스레드)
  ├── stdio_control.py     — NDJSON JSON-RPC 2.0 피어 (hello, cancel, shutdown, EOF)
  ├── stdio_egress.py      — provider SDK 요청을 플러그인 egress 요청으로 넘기는 httpx2 트랜스포트
  ├── local_indexer.py — Layer A(파싱) + Layer B(인덱싱) 파이프라인
  ├── local_indexer_search.py  — BM25 + Vector + RRF(k=60) 검색 엔진
  ├── korean_tokenizer.py  — kiwipiepy 패턴 B
  ├── embedding_client.py  — OpenAI / Azure OpenAI 임베딩 클라이언트
  ├── image_extractor.py   — PPTX/PDF/DOCX 이미지 추출
  ├── image_captioner.py   — 이미지 캡션 파이프라인
  ├── user_dict_loader.py  — 사용자 정의 사전
  └── schema.sql           — SQLite 스키마 (WAL + FTS5)

Storage (AVE_WORKER_STATE_DIR/index/, 또는 사용자가 지정한 indexStorageRoot)
  ├── fts5.sqlite          — 한국어 content_ko FTS5
  └── vectors.lance/       — lancedb 1536-dim

Workspace (pluginDataDir/.local-indexer-workspace/)
  ├── folders.json         — 등록 폴더
  └── index-state.json     — mtime/docId 추적
```

> **스토리지 경로**: 인덱스는 호스트가 워커에게만 만들어 주는 상태 디렉터리
> (`~/.ave/plugins/local-indexer/workers/local-indexer-worker/`, 워커 환경의
> `AVE_WORKER_STATE_DIR`)에 있습니다. 플러그인 프로세스는 이 디렉터리에 쓸 수 없습니다.
> `indexStorageRoot` 를 지정하면 그 경로를 쓰고, 그 경로의 쓰기 권한은 manifest
> `sandbox.write` 로 유지됩니다. `pluginDataDir` 은 호스트 앱(`PluginRuntimeContext`)이
> 주입하며, 없으면 익스텐션이 시작을 거부합니다.
>
> **0.8.0 업그레이드**: 이전 버전은 인덱스를 `pluginDataDir/index/` 에 두었습니다.
> 이 인덱스는 상태 디렉터리로 복사할 수 없으므로 첫 시작 때 등록 폴더 전체를
> 다시 인덱싱합니다. 진행률과 `index-migration` 경고가 표시되고
> `index_scan_status.indexMigration` 에 상태가 남습니다. 이전 디렉터리는 새 인덱스가
> 이전 인덱스의 내용을 덮을 때에만 지우며, 판정은 닫힌 쪽으로 실패합니다: 이전 문서는
> 정해진 제외 사유가 확인될 때만 필수 목록에서 빠지고, 벡터 요구는 설정이 임베딩을
> 끈 경우에만 면제되며, 판단할 수 없는 것은 모두 이전 디렉터리를 남기고 개수를 표시합니다.
> 스캔 전에 이전 인덱스의 목록(문서마다 경로, 읽은 시점의 mtime, 벡터가 있었는지)과
> 그때의 저장된 폴더 목록을 읽어 `index-migration-manifest.json` 에 보관합니다. 워커는
> 작업 공간에 복사한 `fts5.sqlite`·`-wal`·`-shm` 을 읽으며(먼저 `PRAGMA quick_check`),
> 복사는 앞뒤로 세 파일의 크기·mtime 이 같을 때만 인정하고(최대 3회), 디스크 공간이
> 모자라거나 계속 바뀌면 시도 횟수에 넣지 않고 다음 시작 때 다시 읽습니다. 경로는 폴더의
> 여러 형태(등록된 그대로, 실제 경로, NFC)로 비교하되 정확한 경로가 먼저이고, 대소문자는
> 폴더가 실제로 대소문자를 무시하는지 측정된 경우에만 무시합니다(플랫폼 기본값으로
> 가정하지 않음). 제외 사유: 파일이 사라짐(파일이 보이는 폴더에서), 목록을 읽을 때 등록돼
> 있다가 지금은 빠진 폴더(현재 폴더가 모두 실제 경로로 확인될 때), 지금 설정으로는
> 인덱싱하지 않는 형식, 이전 인덱스가 읽은 뒤 바뀌지 않았고 두 번의 별도 파싱이 모두
> `unparseable` 로 판정한 파일(완료 메시지에 표시). 등록 폴더 밖에서 따로 인덱싱한
> 문서(끌어다 놓은 파일 등)는 필수로 남아 재구축이 직접 다시 인덱싱하며, 그 디렉터리가
> 남아 있을 때만 사라진 것으로 제외합니다. 낮춘 파일 크기 상한에 걸린 문서도 필수로
> 남고, 상태에 개수와 앞의 몇 경로를 표시합니다. 나머지 문서는 모두 새 인덱스에 있어야 하고, 벡터가
> 있었다면 새 인덱스에도 있어야 합니다(플러그인 키 모드에서 키가 없거나 호스트 키가
> 막힌 사용자 지정 endpoint 인 경우만 면제, 호스트 lease 거부·키 저장소 오류는 판단
> 불가로 남김). 재구축 중 벡터 없이 들어간 문서는 확인 전에 다시 임베딩하며 3개 연속
> 실패하면 멈춥니다. 읽거나 실제 경로로 확인할 수 없는 폴더, 예전 문서가 있었는데
> 파일이 하나도 보이지 않는 폴더, 어느 폴더에도 속하지 않는 문서, stat 오류, 기본
> 폴더로 대신한 스캔은 이전 디렉터리를 남깁니다. 실패가 다시 하면 될 수 있는
> 것인지(`retryable`)는 상태 문구에만 쓰입니다. 남기는 경우 상태에 빠진 문서 수와
> 벡터가 빠진 문서 수를 표시하고 다음 시작 때 다시 시도하며, 5회 뒤에는 자동
> 재시도를 멈추고 이유를 표시합니다. 취소된 스캔은 시도로 세지 않고, 사용자가 전체
> 스캔을 실행하면 횟수가 초기화되며 재시도가 멈춘 상태였다면 재구축을 한 번 더
> 시도합니다. 시작 때의 복구 단계는 벡터 없이 들어간 문서(`embed_failed`)도 임베딩
> 키가 있으면 시작마다 최대 50개씩 다시 임베딩하고, 3번 연속 실패하면 멈추며, 계속
> 실패하는 문서는 순서를 뒤로 미룹니다(`heal-attempts.json`).

## 내부 API (worker stdio control v1)

익스텐션 프로세스와 Python worker 사이의 내부 계약입니다. 워커의 stdout 에는
줄 단위 JSON-RPC 2.0 프레임만 흐르고(프레임당 최대 16 MiB, 방향별 동시 요청 64개),
로그는 stderr 로 갑니다. 워커는 호스트의 `$/ave/hello` 에 먼저 답하고(호스트가
알린 `frameBytesMax` 를 양방향 상한으로 씀),
`$/ave/cancel` 을 받으면 해당 요청을 -32800 으로 끝내며, stdin EOF 또는
`$/ave/shutdown` 에 종료합니다. Ave에서 사용하는 공개 도구 계약은 위의
**Ave Extension Tools** 표이며, 이 메서드들을 외부 통합 API로 쓰지 않습니다.

플러그인 → 워커 요청:

| Method | 설명 |
|--------|------|
| `worker_health` | 헬스체크 |
| `runtime_info` | Python 경로, 인덱스 위치(index root, 상태 디렉터리, SQLite/lance 경로, workspace), 설정, 문서 수 |
| `runtime_allowed_roots` | 인덱싱 허용 루트 갱신 |
| `indexer_reindex` | 단일 파일 강제 재인덱싱 (단일 ingestion 경로) |
| `indexer_reconcile` | SQLite↔LanceDB 벡터 drift 감지+정규화 |
| `documents_list` | 문서 목록, 페이지 단위 (`{limit≤1000, after}` → `{documents, next_after}`; 페이지는 협상된 프레임 상한의 3/4 안에서 끊김) |
| `legacy_index_manifest` | 0.8.0 이전 인덱스 사본(작업 공간 안의 `fts5.sqlite`)이 인덱싱해 둔 문서 목록과 벡터 여부, `documents_list` 와 같은 방식으로 페이지 단위 (`{sqlite_path, limit≤1000, after}`) |
| `document_get` | 단일 문서 메타 |
| `documents_delete` | 문서 인덱스 항목 삭제 |
| `document_structure` | TOC 트리 (agentic 루프) |
| `page_content` | 페이지 콘텐츠 (agentic 루프) |
| `search_bm25` | `{query, topK}` → kiwi 토큰화 → FTS5 |
| `search_vector` | `{query, topK}` → embed → lancedb |
| `search_hybrid` | BM25 + Vector RRF(k=60) |
| `indexer_set_image_captioning` | 이미지 캡션 설정 (자격 증명 없음) |
| `indexer_set_embedding_egress` | 임베딩 요청을 보내도 되는지 알림 (자격 증명 없음) |
| `indexer_caption_image` | 이미지 한 장 캡션 (11 MiB 이하) |
| `metrics` | 카운터 |
| `worker_shutdown` | 저장소 정리 — FTS5 checkpoint, lance flush |

워커 → 플러그인 요청: `egress_embedding`, `egress_caption`. 워커는 키도 네트워크도
갖지 않으며 `{method, path, headers, body}` 만 보냅니다. 플러그인의 egress broker 가
업스트림과 자격 증명을 호스트 쪽에서 정해 `hostFetch` 로 보내고
`{status, headers, body}` 로 답합니다.

## 임베딩 설정

기본 `apiKeySource`는 `host`입니다. 이 경우 익스텐션은 Ave 앱의 활성 OpenAI 또는
Azure 계열 자격 증명을 우선 사용하고, 실제 provider 호출은 호스트 egress 경로를
통해 수행합니다. 별도 provider 또는 custom endpoint가 필요한 경우에만 plugin
자격 증명 소스를 명시적으로 선택합니다.

임베딩 프로바이더와 모델은 익스텐션 설정에서 조정할 수 있습니다:

| 설정 | 값 | 비고 |
|------|-----|------|
| `embeddingProvider` | `openai` \| `azure` | 기본값: `openai` |
| `embeddingModel` | 모델 ID 또는 deployment 이름 | 예: `text-embedding-3-small` |
| `embeddingEndpoint` | Azure 전용 endpoint URL | Azure 사용 시 필수 |

사용 가능한 임베딩 자격 증명이 없으면 FTS5 BM25만 동작합니다 (degraded 모드).

### 사내망 TLS (corporate CA)

임베딩 트래픽은 항상 TLS 인증서 검증을 수행합니다 (요청에 API key 가 실리므로
verification 을 끄지 않습니다). 사내망이 corporate CA 로 TLS 를 intercept 하는
경우, 검증을 비활성화하지 말고 표준 환경변수로 사내 root CA 를 신뢰시키세요:

- `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` — 사내 CA bundle (PEM) 경로
- `SSL_CERT_DIR` — 신뢰 CA 인증서 디렉토리

## 알려진 한계

- **문서 수 권장 상한**: 5,000개 (lancedb + FTS5 성능 기준)
- **임베딩 자격 증명 필요**: 임베딩 생성 시 필요. 기본 host 자격 증명을 사용할 수 없고 익스텐션 자격 증명도 없으면 FTS5 BM25만 동작 (degraded 모드)
- **첫 부팅 소요**: ~40-50초 (Python 환경 구성)
- **DOCX 페이지 경계**: DOCX XML에 페이지 경계 정보가 없으므로 전체 문서를 page=1로 인덱싱

## 로드맵

| 단계 | 내용 | 상태 |
|------|------|------|
| Phase 1 | uv 자동 셋업 + BM25 + Vector + RRF + LLM agentic | ✅ 완료 |
| Phase 1.5 | LightRAG knowledge graph (feature flag) | 3개 조건 충족 시 |
| Phase 2 | BAAI/bge-m3 로컬 임베딩 + 사내 ES/Milvus | 후속 |

## 개발

```bash
# 의존성 설치
bun install

# 빌드
bun run build

# 테스트
bun run test                                # TypeScript (vitest)
uv venv --python 3.12 .venv                  # Python (pytest) — what CI runs
uv pip install --python .venv -r python-requirements.lock -r python-test-requirements.txt
uv run pytest test/

# Python worker 직접 실행 (디버깅): stdin 으로 프레임을 보내고 stdout 으로 답을 받는다.
# 워커는 stdin EOF 에 바로 끝나므로 답을 받을 동안 stdin 을 열어 둔다 (sleep).
cd worker
{ printf '%s\n' \
    '{"jsonrpc":"2.0","id":0,"method":"$/ave/hello","params":{"protocol":"ave-worker-stdio-control","versions":["1"],"frameBytesMax":16777216}}' \
    '{"jsonrpc":"2.0","id":1,"method":"runtime_info"}'; sleep 10; } \
  | AVE_WORKER_STATE_DIR=/tmp/li-state python local_indexer_worker.py --workspace /tmp/li-workspace

# Python 의존성 lock 파일 갱신
bun run lock:python
```

## 요구사항

- Ave App (Electron host) — `PluginRuntimeContext.pluginDataDir` 주입 필요
- 앱의 활성 OpenAI/Azure 계열 자격 증명 또는 명시적으로 설정한 익스텐션 자격 증명 (임베딩 사용 시)
- 인터넷 연결 (첫 부팅 시 Python 환경 구성, 임베딩 API 호출)

## Marketplace publishing

Extension builds do not create local sidecar signatures. Upload the build artifact
to the Ave marketplace; the marketplace validates and signs the final artifact,
and the host verifies that signed envelope during install.
