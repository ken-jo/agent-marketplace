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
  └── ave-plugin-local-indexer
        ├── hostPlugin.ts        — 통합 도구 dispatch, HostApi/설정/egress 관리
        ├── localIndexerPlugin.ts — Python worker 실행 + lifecycle
        ├── workerClient.ts      — Python worker 내부 HTTP 클라이언트
        ├── folderIndexer.ts     — chokidar 파일 감시 + eager indexIfChanged
        └── indexState.ts        — index-state.json 추적

Python Worker (FastAPI + uvicorn, 127.0.0.1:43129)
  ├── local_indexer_worker.py  — FastAPI 진입점 + 라우터
  ├── local_indexer.py — Layer A(파싱) + Layer B(인덱싱) 파이프라인
  ├── local_indexer_search.py  — BM25 + Vector + RRF(k=60) 검색 엔진
  ├── korean_tokenizer.py  — kiwipiepy 패턴 B
  ├── embedding_client.py  — OpenAI / Azure OpenAI 임베딩 클라이언트
  ├── image_extractor.py   — PPTX/PDF/DOCX 이미지 추출
  ├── image_captioner.py   — 이미지 캡션 파이프라인
  ├── user_dict_loader.py  — 사용자 정의 사전
  └── schema.sql           — SQLite 스키마 (WAL + FTS5)

Storage (pluginDataDir/index/)
  ├── fts5.sqlite          — 한국어 content_ko FTS5
  ├── vectors.lance/       — lancedb 1536-dim
  └── index-state.json     — mtime/docId/chunkHash 추적
```

> **스토리지 경로**: `pluginDataDir`은 호스트 앱(`PluginRuntimeContext`)이 주입합니다. 익스텐션은 이 값이 없으면 시작을 거부합니다.

## 내부 API (Python Worker HTTP)

이 API는 익스텐션 프로세스와 Python worker 사이의 loopback 통신용 내부 계약입니다.
Ave에서 사용하는 공개 도구 계약은 위의 **Ave Extension Tools** 표이며, worker HTTP
엔드포인트를 외부 통합 API로 직접 사용하지 않습니다.

| Method | Path | 설명 |
|--------|------|------|
| GET | `/health` | 헬스체크 |
| GET | `/runtime/info` | Python/venv 경로, 라이브러리 버전 |
| POST | `/indexer/reindex` | 단일 파일 강제 재인덱싱 (단일 ingestion 경로) |
| POST | `/indexer/reconcile` | SQLite↔LanceDB 벡터 drift 감지+정규화 (키 불필요 detect; drifted doc 반환) |
| GET | `/documents` | 문서 목록 |
| GET | `/document` | 단일 문서 메타 |
| POST | `/documents/delete` | 문서 인덱스 항목 삭제 (익스텐션 내부 사용) |
| GET | `/structure` | TOC 트리 (agentic 루프) |
| GET | `/page-content` | 페이지 콘텐츠 (agentic 루프) |
| POST | `/search/bm25` | `{query, topK}` → kiwi 토큰화 → FTS5 |
| POST | `/search/vector` | `{query, topK}` → embed → lancedb |
| POST | `/search/hybrid` | BM25 + Vector RRF(k=60) |
| GET | `/metrics` | 카운터 |
| POST | `/shutdown` | graceful — FTS5 checkpoint, lance flush |

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

# Python worker 직접 실행 (디버깅)
cd worker
python local_indexer_worker.py \
  --host 127.0.0.1 --port 43129 \
  --db /path/to/pluginDataDir/index/fts5.sqlite \
  --lance /path/to/pluginDataDir/index/vectors.lance

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
