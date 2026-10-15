"""Layer A+B indexing pipeline for Ave Local Indexer worker.

Pipeline stages
---------------
1. Layer A parse
   - PDF              -> pymupdf4llm (Korean-aware markdown)
   - DOCX/PPTX/XLSX   -> markitdown
   - MD/MARKDOWN/TXT  -> raw read
   - HTML             -> markitdown (best-effort)
2. Chunk sentences with kiwi split_into_sents (target 256 token, 32
   overlap). Token count is approximated from word count when tiktoken
   is unavailable.
3. Kiwi morpheme tokenise each chunk for FTS5 ``content_ko``.
4. OpenAI embedding (batched) -> lancedb vectors.

Transactions
------------
All SQLite writes for one file happen inside a single ``BEGIN ...
COMMIT``. If any step fails after rows were inserted we ``ROLLBACK`` and
mark the document status as ``failed`` in a fresh transaction.
"""

from __future__ import annotations
import hashlib
import logging
import os
import re
import sqlite3
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

try:  # pragma: no cover - optional
    import structlog  # type: ignore

    log = structlog.get_logger(__name__)
except Exception:  # pragma: no cover
    log = logging.getLogger(__name__)


_SCHEMA_PATH = Path(__file__).with_name("schema.sql")
_SUPPORTED_EXT = {
    ".pdf": "pdf",
    ".md": "md",
    ".markdown": "md",
    ".txt": "txt",
    ".html": "html",
    ".htm": "html",
    ".docx": "docx",
    ".pptx": "pptx",
    ".xlsx": "xlsx",
}

_DEFAULT_TARGET_TOKENS = 256
_DEFAULT_OVERLAP_TOKENS = 32
_DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024  # 50 MB
_DEFAULT_MAX_CHUNKS_PER_DOC = 2000

_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


@dataclass
class Chunk:
    chunk_id: str
    doc_id: str
    chunk_index: int
    page: Optional[int]
    raw_text: str
    token_count: int
    chunk_hash: str
    content_ko: str = ""


@dataclass
class IndexResult:
    doc_id: str
    doc_name: str
    doc_type: str
    chunk_count: int
    status: str
    page_count: Optional[int] = None
    line_count: Optional[int] = None
    errors: List[str] = field(default_factory=list)
    # True 면 vector(임베딩) 까지 성공적으로 생성. False 면 BM25 / chunk 까지는
    # 가능했지만 임베딩이 생략됐다는 뜻 (caption rejected, embedding client
    # unavailable, network 실패 등). 플러그인은 이 값이 False 면 사용자
    # 입장에선 사실상 인덱싱 실패로 봐야 하므로 indexDocument 가 throw.
    embedded: Optional[bool] = None
    # 3-state content quality, independent of `status`. 'ok' = text + vectors,
    # 'empty' = parsed but no extractable text, 'embed_failed' = text indexed
    # but embeddings missing. Mirrors the documents.content_state column so the
    # host/LLM can distinguish a degraded doc from a clean one.
    content_state: str = "ok"
    # True when index_file short-circuited because the document's content hash
    # matched the stored hash and the prior content_state was 'ok' — no embed
    # call and no re-persist happened, only the mtime was advanced. The existing
    # chunks/vectors/embeddings are reused as-is.
    unchanged: bool = False


# ----------------------------------------------------------------------
# LocalIndexer
# ----------------------------------------------------------------------
class LocalIndexer:
    """Orchestrate Layer A parsing + Layer B indexing."""

    def __init__(
        self,
        workspace: str,
        sqlite_path: str,
        lance_path: str,
        openai_api_key: Optional[str],
        *,
        # Embeddings are produced by a cloud provider (openai | azure).
        embedding_provider: str = "openai",
        embedding_model: str = "text-embedding-3-small",
        embedding_dimensions: Optional[int] = None,  # None = auto from client
        # Optional OpenAI-compatible / Azure OpenAI endpoint URL. Required
        # when embedding_provider == "azure"; for "openai" it's an
        # optional base URL override.
        embedding_endpoint: str = "",
        embedding_api_version: str = "",
        # Host-mediated egress broker base URL (P3 ⑬). When set, all provider
        # egress (embeddings + captioning) is routed through the broker and the
        # worker holds only the per-session token, never the provider key.
        egress_broker_url: str = "",
        egress_broker_uds: str = "",
        target_rpm: int = 400,
        target_tokens: int = _DEFAULT_TARGET_TOKENS,
        overlap_tokens: int = _DEFAULT_OVERLAP_TOKENS,
        # Operational guardrails — exposed as plugin config.
        # Files exceeding max_file_size bytes are rejected with status='failed'
        # (explicit failure surfaced to the user, not a silent skip).
        # Documents whose chunk count exceeds max_chunks_per_doc are truncated
        # to the cap and indexed with a recorded warning in errors[].
        max_file_size: int = _DEFAULT_MAX_FILE_SIZE,
        max_chunks_per_doc: int = _DEFAULT_MAX_CHUNKS_PER_DOC,
        # Dependency injection hooks for tests
        tokenizer: Optional[Any] = None,
        embedding_client: Optional[Any] = None,
        vector_store: Optional[Any] = None,
        parser_overrides: Optional[
            Dict[str, Callable[[str], Tuple[List[Tuple[int, str]], Optional[int]]]]
        ] = None,
    ) -> None:
        self.workspace = os.path.abspath(os.path.expanduser(workspace))
        self.sqlite_path = os.path.abspath(os.path.expanduser(sqlite_path))
        self.lance_path = os.path.abspath(os.path.expanduser(lance_path))
        self.embedding_provider = embedding_provider
        self.embedding_model = embedding_model
        # embedding_dimensions: None이면 client에서 lazy resolve (lance schema 시점)
        self.embedding_dimensions: Optional[int] = embedding_dimensions
        self.embedding_endpoint = embedding_endpoint or ""
        self.embedding_api_version = embedding_api_version or ""
        # Egress broker (P3 ⑬). The two channel URLs are derived from the single
        # base so the worker never needs the real provider endpoints.
        self._egress_broker_base = (egress_broker_url or "").rstrip("/")
        # The socket the broker actually listens on. The base above is only an
        # authority the provider SDKs insist on parsing; nothing dials it.
        self._egress_broker_uds = egress_broker_uds or ""
        self.target_tokens = target_tokens
        self.overlap_tokens = overlap_tokens
        self.target_rpm = target_rpm
        self.max_file_size = max(0, int(max_file_size))
        self.max_chunks_per_doc = max(1, int(max_chunks_per_doc))
        self._openai_api_key = openai_api_key
        self._tokenizer = tokenizer
        self._embedding_client = embedding_client
        self._vector_store = vector_store
        self._parser_overrides = parser_overrides or {}

        # Image-embedding toggle is *call-time* mutable so the host's UI
        # toggle takes effect without restarting the worker process.
        # set_image_captioning() updates these in place; index_file reads
        # them every call. Default off — legacy behaviour.
        self._image_caption_enabled: bool = False
        self._image_caption_provider: str = "openai"
        self._image_caption_model: str = ""
        # Captioning endpoint URL — shared across cloud providers. Azure
        # requires it (resource root); OpenAI treats it as an optional
        # OpenAI-compatible base URL. The api_key here is provider-
        # specific (Azure subscription key OR OpenAI key) — the host
        # sends the one matching the active provider.
        self._image_caption_endpoint: str = ""
        self._image_caption_api_key: str = ""
        # Azure OpenAI-only: api-version 쿼리 값 (예: "2024-08-01-preview").
        # endpoint 가 root URL 일 때만 사용; full URL 이면 endpoint 의 쿼리가
        # 우선. 빈 값이면 image_captioner 의 provider 별 모듈 디폴트 적용.
        self._image_caption_api_version: str = ""

        self._ensure_storage_dirs()

        self._init_schema()

    # ------------------------------------------------------------------
    # Egress broker channel URLs (P3 ⑬)
    # ------------------------------------------------------------------
    @property
    def egress_brokered(self) -> bool:
        return bool(self._egress_broker_base)

    @property
    def egress_embedding_url(self) -> str:
        return f"{self._egress_broker_base}/egress/embedding" if self._egress_broker_base else ""

    @property
    def egress_caption_url(self) -> str:
        return f"{self._egress_broker_base}/egress/caption" if self._egress_broker_base else ""

    # ------------------------------------------------------------------
    # Schema / connection
    # ------------------------------------------------------------------
    def _ensure_storage_dirs(self) -> None:
        os.makedirs(self.workspace, exist_ok=True)
        sqlite_dir = os.path.dirname(self.sqlite_path)
        lance_dir = os.path.dirname(self.lance_path)
        if sqlite_dir:
            os.makedirs(sqlite_dir, exist_ok=True)
        if lance_dir:
            os.makedirs(lance_dir, exist_ok=True)

    def _connect(self) -> sqlite3.Connection:
        self._ensure_storage_dirs()
        sqlite_existed = os.path.exists(self.sqlite_path)
        try:
            conn = sqlite3.connect(self.sqlite_path)
        except sqlite3.OperationalError as exc:
            # Plugin updates / runtime cleanup can remove the parent data dir
            # while the worker is still alive. Recreate the storage root once
            # and retry so read-only endpoints like /documents recover cleanly.
            if "unable to open database file" not in str(exc).lower():
                raise
            self._ensure_storage_dirs()
            sqlite_existed = os.path.exists(self.sqlite_path)
            conn = sqlite3.connect(self.sqlite_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        if not sqlite_existed:
            schema_sql = _SCHEMA_PATH.read_text(encoding="utf-8")
            conn.executescript(schema_sql)
        return conn

    def _init_schema(self) -> None:
        schema_sql = _SCHEMA_PATH.read_text(encoding="utf-8")
        with self._connect() as conn:
            conn.executescript(schema_sql)
            self._migrate_content_state(conn)
            self._migrate_content_hash(conn)

    def close(self) -> None:
        """Release storage handles before worker shutdown."""
        store = self._vector_store
        self._vector_store = None
        if store is not None:
            close = getattr(store, "close", None)
            if callable(close):
                close()

        conn = self._connect()
        try:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            conn.close()

    def _migrate_content_state(self, conn: sqlite3.Connection) -> None:
        """Idempotently add the documents.content_state column to legacy DBs.

        CREATE TABLE IF NOT EXISTS never alters an existing table, so databases
        created before this column shipped lack it. ALTER ... ADD COLUMN with a
        NOT NULL DEFAULT backfills every existing row to 'ok' without dropping
        any data. Guarded by PRAGMA table_info so re-runs are no-ops.
        """
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(documents)")}
        if "content_state" not in columns:
            conn.execute(
                "ALTER TABLE documents ADD COLUMN content_state TEXT NOT NULL DEFAULT 'ok'"
            )

    def _migrate_content_hash(self, conn: sqlite3.Connection) -> None:
        """Idempotently add the documents.content_hash column to legacy DBs.

        Mirrors _migrate_content_state. The column is nullable with no default:
        legacy rows backfill to NULL, which index_file treats as "changed" so the
        first reindex after upgrade recomputes and stores the hash. Guarded by
        PRAGMA table_info so re-runs are no-ops and no rows are dropped.
        """
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(documents)")}
        if "content_hash" not in columns:
            conn.execute("ALTER TABLE documents ADD COLUMN content_hash TEXT")

    # ------------------------------------------------------------------
    # Public
    # ------------------------------------------------------------------
    def index_file(self, file_path: str, mode: str = "auto") -> IndexResult:
        abs_path = os.path.abspath(os.path.expanduser(file_path))
        if not os.path.exists(abs_path):
            raise FileNotFoundError(f"File not found: {abs_path}")

        doc_type = self._resolve_type(abs_path, mode)
        doc_name = os.path.basename(abs_path)
        mtime_ms = int(os.path.getmtime(abs_path) * 1000)
        doc_id = self._resolve_existing_doc_id(abs_path) or str(uuid.uuid4())

        # Guardrail: reject files that exceed the configured size limit before
        # any parsing. Files over the limit are recorded as status='failed' so
        # the failure is visible to the user rather than silently skipped.
        if self.max_file_size > 0:
            try:
                file_bytes = os.path.getsize(abs_path)
            except OSError as exc:
                file_bytes = 0
                _info(log, "indexer.file.size.error", doc_id=doc_id, path=abs_path, error=str(exc))
            if file_bytes > self.max_file_size:
                reason = (
                    f"file size {file_bytes} bytes exceeds maxFileSize {self.max_file_size} bytes "
                    f"({file_bytes // (1024 * 1024)} MB / limit {self.max_file_size // (1024 * 1024)} MB)"
                )
                _info(log, "indexer.file.oversize", doc_id=doc_id, path=abs_path,
                      size_bytes=file_bytes, max_bytes=self.max_file_size)
                self._mark_failed(doc_id, abs_path, doc_name, doc_type, mtime_ms)
                return IndexResult(
                    doc_id=doc_id,
                    doc_name=doc_name,
                    doc_type=doc_type,
                    chunk_count=0,
                    status="failed",
                    errors=[reason],
                )

        _info(log, "indexer.file.start", doc_id=doc_id, path=abs_path, type=doc_type)

        # Step 1 — Layer A parse
        # CaptionError 는 캡션 단계의 명시적 API/설정 실패 (404 / 401 /
        # allowed_roots 거부 등) 라 사용자에게 정확한 사유를 보여줘야 한다.
        # generic "Layer A parse failed" 로 감싸지 말고 그대로 errors[] 로
        # 반환해 호스트 UI 가 캡션 endpoint 도메인 / 키 같은 구체적 안내를
        # 사용자에게 노출할 수 있게 한다.
        try:
            from worker.image_captioner import CaptionError  # type: ignore
        except Exception:  # pragma: no cover - dep guard
            CaptionError = type("CaptionError", (Exception,), {})  # type: ignore[misc,assignment]
        try:
            paged_content, page_count = self._parse(abs_path, doc_type)
        except CaptionError as exc:
            self._mark_failed(doc_id, abs_path, doc_name, doc_type, mtime_ms)
            return IndexResult(
                doc_id=doc_id,
                doc_name=doc_name,
                doc_type=doc_type,
                chunk_count=0,
                status="failed",
                errors=[str(exc)],
            )
        except Exception as exc:  # pragma: no cover - parser runtime error
            self._mark_failed(doc_id, abs_path, doc_name, doc_type, mtime_ms)
            raise RuntimeError(f"Layer A parse failed: {exc}") from exc

        # 빈 doc 은 에러 아님 — 캡션 모델이 description 못 만들었거나 (정상
        # 응답으로 빈 문자열), 텍스트 추출 결과가 비었어도 doc 자체는 등록한다.
        # 사용자가 BM25 로 doc_name (파일명) 검색해 접근 가능. 명시적 실패
        # (CaptionError 등) 는 위 catch 에서 이미 status=failed 처리됨.
        raw_text = "\n\n".join(text for _, text in paged_content)
        is_empty = not raw_text.strip()
        if is_empty:
            _info(log, "indexer.file.empty", doc_id=doc_id, path=abs_path)

        # Step 2 — chunking. 빈 입력이면 chunks = [] 가 되고 embedding 단계는
        # 자연스럽게 skip. status="indexed" 로 빈 doc 등록.
        chunks = self._chunk(doc_id, paged_content) if paged_content else []

        # Guardrail: cap chunk count at max_chunks_per_doc. Truncation is
        # chosen over outright failure because the leading chunks are still
        # fully indexable and searchable. The truncation is recorded explicitly
        # in errors[] so it surfaces to the user — this is not a silent drop.
        chunk_warnings: List[str] = []
        if len(chunks) > self.max_chunks_per_doc:
            original_count = len(chunks)
            chunks = chunks[: self.max_chunks_per_doc]
            warning = (
                f"chunk count {original_count} exceeds maxChunksPerDoc {self.max_chunks_per_doc}; "
                f"truncated to {self.max_chunks_per_doc} chunks"
            )
            chunk_warnings.append(warning)
            _info(log, "indexer.file.chunks.truncated", doc_id=doc_id, path=abs_path,
                  original=original_count, cap=self.max_chunks_per_doc)

        if not chunks:
            # 빈 doc 도 SQLite documents 테이블에는 한 줄 등록해 둬 폴더
            # summary 가 indexed 로 카운트한다. embedding 은 없으므로
            # embedded=False, chunk_count=0.
            line_count = 0
            # Tear down any prior index rows (a doc that previously had content
            # and is now empty) — chunks_fts + lance vectors are not reached by
            # the documents-row cascade. reindex() used to do this up front.
            self._purge_existing_index_rows(abs_path)
            try:
                self._persist_sqlite(
                    doc_id=doc_id,
                    abs_path=abs_path,
                    doc_name=doc_name,
                    doc_type=doc_type,
                    mtime_ms=mtime_ms,
                    page_count=page_count or 0,
                    line_count=line_count,
                    chunks=[],
                    embedded=False,
                    content_state="empty",
                )
            except Exception as exc:
                _info(log, "indexer.file.persist.error", doc_id=doc_id, error=str(exc))
                self._mark_failed(doc_id, abs_path, doc_name, doc_type, mtime_ms)
                raise
            _info(
                log,
                "indexer.file.done",
                doc_id=doc_id,
                chunks=0,
                embedded=False,
                empty=True,
            )
            return IndexResult(
                doc_id=doc_id,
                doc_name=doc_name,
                doc_type=doc_type,
                chunk_count=0,
                status="indexed",
                page_count=page_count,
                line_count=line_count,
                embedded=False,
                content_state="empty",
            )

        # Step 3 — kiwi tokenise
        tokenizer = self._get_tokenizer()
        for chunk in chunks:
            chunk.content_ko = tokenizer.tokenize_for_index(chunk.raw_text)

        # Step 3.5 — doc-level content-hash short-circuit. The most common
        # re-index trigger is an mtime bump with byte-identical visible content
        # (editor save without edits, metadata-only write, cloud-sync touch).
        # The host re-indexes on any mtime change, which would otherwise re-pay
        # the embedding API cost for unchanged text. If the freshly chunked
        # content hashes to the stored value AND the prior run embedded cleanly
        # (content_state == 'ok'), reuse the existing chunks/vectors: skip the
        # embed call and the re-persist, advancing only mtime.
        #
        # Guard: 'embed_failed' is NOT short-circuited — those docs have text
        # but no vectors, so an unchanged-content re-index must retry embedding.
        # A NULL stored hash (legacy row predating content_hash) is treated as
        # changed, forcing exactly one reindex that backfills the hash.
        doc_content_hash = self._compute_doc_content_hash(chunks)
        stored_hash, stored_state = self._read_doc_hash_state(doc_id)
        if stored_hash is not None and stored_hash == doc_content_hash and stored_state == "ok":
            self._touch_document_mtime(doc_id, mtime_ms)
            _info(
                log,
                "indexer.file.unchanged",
                doc_id=doc_id,
                path=abs_path,
                chunks=len(chunks),
            )
            return IndexResult(
                doc_id=doc_id,
                doc_name=doc_name,
                doc_type=doc_type,
                chunk_count=len(chunks),
                status="indexed",
                page_count=page_count,
                line_count=raw_text.count("\n") + 1,
                embedded=True,
                content_state="ok",
                unchanged=True,
                errors=chunk_warnings,
            )

        # Content changed (or never embedded cleanly / legacy NULL hash) — tear
        # down the prior index rows before re-embedding. _persist_sqlite only
        # cascades the documents-row delete to chunks + embeddings_meta; the
        # chunks_fts virtual table and external lance vectors are not reached,
        # so they must be purged here to avoid stale rows. For a brand-new doc
        # this is a no-op. (reindex() used to do this unconditionally up front,
        # which destroyed the existing row before the short-circuit could read
        # its stored hash — hence the move to here, gated on the check failing.)
        self._purge_existing_index_rows(abs_path)

        # Step 4 — embeddings. graceful BM25-only fallback when embedding is unavailable.
        #   - api_key 부재 (openai) 또는 endpoint/key 부재 (azure) 시
        #     client=None → vectors=[] → BM25만.
        #   - 임베딩 endpoint 가 도달 불가하면 첫 embed_corpus 호출이 실패 →
        #     vectors=[] → BM25만.
        # 어떤 경우에도 indexing은 진행되어 (BM25 + FTS5) plugin이 boot 성공.
        vectors: List[List[float]] = []
        client = self._get_embedding_client()
        if client is not None:
            try:
                vectors = client.embed_corpus([c.raw_text for c in chunks])
            except Exception as exc:
                # 실패 원인을 구분한다 — sandbox-egress 차단(연결 거부/차단)과
                # 인증 실패(API 키 부재/무효)는 운영 대응이 전혀 다르다. 둘 다
                # 같은 "BM25-only fallback" 으로 뭉뚱그리면 strict-union egress
                # deny 가 단순 BM25 폴백으로 위장돼 진단 불가능해진다.
                failure_kind = _classify_embedding_failure(exc)
                _info(
                    log,
                    "indexer.embed.failed",
                    doc_id=doc_id,
                    provider=self.embedding_provider,
                    model=self.embedding_model,
                    error=str(exc),
                    failure_kind=failure_kind,
                    note=_embedding_failure_note(failure_kind),
                )
                vectors = []
        else:
            _info(
                log,
                "indexer.file.embed.skipped",
                doc_id=doc_id,
                reason=f"embedding client unavailable (provider={self.embedding_provider})",
            )

        # Step 5 — persist sqlite (transactional)
        line_count = raw_text.count("\n") + 1
        # status stays 'indexed' (BM25/FTS5 is searchable either way); content_state
        # records whether vectors made it in so the host can flag degraded docs.
        content_state = "ok" if vectors else "embed_failed"
        # content_hash is intentionally NOT written here — it is written ONLY after
        # the lance vector insert succeeds in Step 6. This ordering guarantees that a
        # SIGKILL / OOM between the sqlite commit and the lance upsert leaves
        # content_hash=NULL in the row. The short-circuit (Step 3.5) treats NULL as
        # 'changed', so the next reindex re-embeds and self-heals the missing vectors.
        # A row with content_hash set + content_state='ok' but no lance vectors is
        # therefore impossible through any production code path (including crashes).
        try:
            self._persist_sqlite(
                doc_id=doc_id,
                abs_path=abs_path,
                doc_name=doc_name,
                doc_type=doc_type,
                mtime_ms=mtime_ms,
                page_count=page_count,
                line_count=line_count,
                chunks=chunks,
                embedded=bool(vectors),
                content_state=content_state,
                # content_hash=None (default) — written after lance in Step 6.
            )
        except Exception as exc:
            _info(log, "indexer.file.persist.error", doc_id=doc_id, error=str(exc))
            self._mark_failed(doc_id, abs_path, doc_name, doc_type, mtime_ms)
            raise

        # Step 6 — lance insert. If this fails we have a split-brain:
        # sqlite shows the document as "indexed" but lance has no vectors.
        # Roll the SQLite row back to status='failed' before re-raising so
        # the caller sees a consistent state and retry will re-embed.
        if vectors:
            try:
                self._persist_vectors(chunks=chunks, vectors=vectors)
            except Exception as exc:  # pragma: no cover - rare
                _info(log, "indexer.file.lance.error", doc_id=doc_id, error=str(exc))
                self._mark_failed(doc_id, abs_path, doc_name, doc_type, mtime_ms)
                raise RuntimeError(f"vector persistence failed: {exc}") from exc
            # Lance succeeded — now safe to write content_hash. Only a fully
            # persisted doc (sqlite chunks + lance vectors both committed) carries
            # a non-NULL content_hash, so the short-circuit invariant holds.
            self._set_doc_content_hash(doc_id, doc_content_hash)

        _info(
            log,
            "indexer.file.done",
            doc_id=doc_id,
            chunks=len(chunks),
            embedded=bool(vectors),
        )
        return IndexResult(
            doc_id=doc_id,
            doc_name=doc_name,
            doc_type=doc_type,
            chunk_count=len(chunks),
            status="indexed",
            page_count=page_count,
            line_count=line_count,
            embedded=bool(vectors),
            content_state=content_state,
            errors=chunk_warnings,
        )

    def list_documents(self) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT doc_id, path, doc_name, doc_type, page_count, line_count, "
                "       mtime_ms, indexed_at, status, content_state "
                "FROM documents ORDER BY indexed_at DESC"
            ).fetchall()
        return [dict(row) for row in rows]

    def get_document(self, doc_id: str) -> Optional[Dict[str, Any]]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM documents WHERE doc_id = ?", (doc_id,)
            ).fetchone()
        return dict(row) if row else None

    def remove_document(self, doc_id: str) -> bool:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT doc_id FROM documents WHERE doc_id = ?",
                (doc_id,),
            ).fetchone()
            if row is None:
                return False
            self._delete_document_rows(conn, doc_id=doc_id)
            conn.commit()
        return True

    def reindex(self, file_path: str, mode: str = "auto") -> IndexResult:
        # Delegate to index_file rather than deleting the existing rows up front.
        # index_file resolves the existing doc_id and runs the content-hash
        # short-circuit; it tears the prior rows down itself only when the
        # content actually changed (see Step 3.5). Deleting here would destroy
        # the row before the short-circuit could read its stored hash, so an
        # unchanged doc would always be torn down and re-embedded.
        return self.index_file(file_path, mode=mode)

    def reconcile(self) -> Dict[str, Any]:
        """Detect + normalise SQLite↔LanceDB vector drift at startup (key-free).

        Crash signature this heals: ``index_file`` Step 5 commits
        ``content_state='ok'`` + the ``embeddings_meta`` rows BEFORE the Lance
        upsert in Step 6. A SIGKILL / OOM / power-loss between the sqlite commit
        and the Lance upsert leaves ``embeddings_meta`` rows whose ``chunk_id``
        has NO vector in Lance. ``content_hash`` is NULL there (it is written
        only after Step 6), so the short-circuit already treats the doc as
        'changed' — but until something touches the file, the doc silently has
        no vectors. ``reconcile`` closes that residual window at boot.

        Bidirectional, comparing the ``embeddings_meta`` chunk_id set against
        the Lance chunk_id set:

        - **meta-without-vector** → the owning doc is marked for re-embed:
          ``content_hash`` is forced NULL (so a reindex does not short-circuit)
          and ``content_state`` is set to ``'embed_failed'`` (it currently has
          text but no usable vectors — the honest state). The drifted doc ids +
          paths are RETURNED so the host can heal them with a bounded reindex
          (re-embed needs the pushed embedding key, so it runs after warmup).
        - **orphan vector** (a Lance chunk_id with NO ``embeddings_meta`` row)
          → deleted from Lance.

        Honest ``embed_failed`` docs carry NO ``embeddings_meta`` rows, so they
        are never flagged here (no false positive). This is detect + normalise
        ONLY: no embedding API call happens, so it is safe to run with no key.
        """
        store = self._get_vector_store()
        if store is None or not hasattr(store, "list_chunk_ids"):
            # No vector backend (lancedb missing / disabled / store without the
            # enumeration capability). We cannot compare, so skip rather than
            # flag every embedded doc as drift.
            _info(log, "indexer.reconcile.skipped", reason="vector store unavailable")
            return {
                "checked": False,
                "drifted_docs": [],
                "drifted_doc_count": 0,
                "orphan_vectors_deleted": 0,
            }

        # O(1) fast-path: compare row counts before committing to a full id-set
        # scan (O(total-chunks)).  When counts match, the index is virtually
        # always consistent — the only exception is the aliased-drift case where
        # a crash leaves exactly one meta-without-vector AND simultaneously
        # creates exactly one orphan vector so the counts cancel out.  That
        # scenario requires two independent failure modes at the same instant
        # and is accepted as a documented caveat: on the next file touch the
        # affected doc is re-indexed naturally, so drift would self-heal.
        # When counts DIFFER, we fall through to the full enumeration below.
        if hasattr(store, "count_rows"):
            with self._connect() as conn:
                _meta_count = conn.execute(
                    "SELECT COUNT(*) AS n FROM embeddings_meta"
                ).fetchone()
            meta_count = int(_meta_count["n"] or 0)
            lance_count = store.count_rows()
            if meta_count == lance_count:
                _info(
                    log,
                    "indexer.reconcile.clean",
                    meta_chunks=meta_count,
                    note="counts match — skipped full id-set enumeration",
                )
                return {
                    "checked": True,
                    "drifted_docs": [],
                    "drifted_doc_count": 0,
                    "orphan_vectors_deleted": 0,
                }

        lance_ids = {str(cid) for cid in store.list_chunk_ids()}

        with self._connect() as conn:
            meta_rows = conn.execute(
                """
                SELECT em.chunk_id AS chunk_id, c.doc_id AS doc_id, d.path AS path
                FROM embeddings_meta em
                JOIN chunks c ON c.chunk_id = em.chunk_id
                JOIN documents d ON d.doc_id = c.doc_id
                """
            ).fetchall()
        meta_ids = {str(row["chunk_id"]) for row in meta_rows}

        # Direction 1 — meta-without-vector: owning docs need a re-embed.
        missing_chunk_ids = meta_ids - lance_ids
        drifted: Dict[str, str] = {}
        for row in meta_rows:
            if str(row["chunk_id"]) in missing_chunk_ids:
                drifted[str(row["doc_id"])] = row["path"]
        drifted_docs = [
            {"doc_id": doc_id, "path": path}
            for doc_id, path in sorted(drifted.items())
        ]

        if drifted_docs:
            # Force content_hash NULL + content_state='embed_failed' so the next
            # reindex re-embeds (neither short-circuit branch fires). The crash
            # window already leaves content_hash NULL; this normalises defensively
            # and records the honest degraded state.
            with self._connect() as conn:
                conn.executemany(
                    "UPDATE documents SET content_hash = NULL, "
                    "content_state = 'embed_failed' WHERE doc_id = ?",
                    [(d["doc_id"],) for d in drifted_docs],
                )
                conn.commit()

        # Direction 2 — orphan vectors: Lance chunk_ids with no meta row.
        orphan_ids = sorted(lance_ids - meta_ids)
        if orphan_ids:
            self._delete_vectors(orphan_ids)

        _info(
            log,
            "indexer.reconcile.done",
            drifted_docs=len(drifted_docs),
            orphan_vectors=len(orphan_ids),
        )
        return {
            "checked": True,
            "drifted_docs": drifted_docs,
            "drifted_doc_count": len(drifted_docs),
            "orphan_vectors_deleted": len(orphan_ids),
        }

    # ------------------------------------------------------------------
    # Layer A parsers
    # ------------------------------------------------------------------
    def set_image_captioning(
        self,
        *,
        enabled: bool,
        provider: str = "openai",
        model: Optional[str] = None,
        endpoint: Optional[str] = None,
        api_key: str = "",
        api_version: Optional[str] = None,
    ) -> None:
        """Update image-embedding settings without restarting the worker.

        Called from the worker HTTP endpoint when the host UI toggle
        flips. The next ``index_file`` call observes the new state, so
        re-indexing existing docs with the toggle on (re-scan) brings
        their image captions into the index without process churn.

        ``model`` / ``endpoint`` / ``api_version`` are tri-state: ``None``
        keeps the current value, ``""`` resets it to the provider default
        (an empty stored value, which the captioner resolves per provider
        at call time), and a non-empty string sets it. The host owns
        these values (its config is the source of truth) and pushes every
        one of them on each call, so a provider switch that arrives with
        ``model=""`` clears the previous provider's model instead of
        carrying it across.

        ``api_key`` is the egress session token the host mints for the
        caption channel (in broker mode the worker never holds a provider
        key). ``""`` keeps the current token: the host omits it on
        toggle-only pushes, and a credential is set, rotated, and cleared
        through ``/indexer/set_egress_token`` — pushing ``""`` here is
        never a clear.
        """
        if provider not in ("openai", "azure-openai-chat", "azure-openai-responses"):
            raise ValueError(f"unknown caption provider: {provider!r}")
        self._image_caption_enabled = bool(enabled)
        self._image_caption_provider = provider
        if model is not None:
            self._image_caption_model = model
        if endpoint is not None:
            self._image_caption_endpoint = endpoint
        if api_key != "":
            self._image_caption_api_key = api_key
        if api_version is not None:
            self._image_caption_api_version = api_version

    def get_image_captioning(self) -> Dict[str, Any]:
        return {
            "enabled": self._image_caption_enabled,
            "provider": self._image_caption_provider,
            "model": self._image_caption_model,
            "endpoint": self._image_caption_endpoint,
            "apiVersion": self._image_caption_api_version,
            "hasApiKey": bool(self._image_caption_api_key),
        }

    def set_embedding_api_key(self, api_key: str) -> None:
        """Update the embedding API key without restarting the worker.

        Called from the host at index_scan entry to lock in the key that was
        captured once at scan start — prevents mid-scan toggle changes from
        reloading the embedding client with a different credential.

        Resets the cached ``_embedding_client`` so the next ``index_file``
        call picks up the new key via ``get_embedding_client``.
        """
        if not isinstance(api_key, str) or not api_key:
            return
        self._openai_api_key = api_key
        # Invalidate the lazy client so get_embedding_client rebuilds with the
        # new key on the next index_file call.
        self._embedding_client = None

    def clear_embedding_key(self) -> None:
        """Drop the embedding key reference (shutdown / rotation).

        Best-effort: rebinds our attribute and nulls the cached client.
        Python string immutability means the original bytes are NOT zeroed
        in place; copies held inside the OpenAI SDK object are released only
        when _embedding_client is set to None. Do not rely on this as a
        secure-erase. Invoked on /shutdown — NOT at scan end — so the key
        stays resident while search can run.
        """
        if isinstance(self._openai_api_key, str) and self._openai_api_key:
            self._openai_api_key = "\x00" * len(self._openai_api_key)
        self._openai_api_key = None
        self._embedding_client = None

    def _resolve_type(self, path: str, mode: str) -> str:
        ext = os.path.splitext(path)[1].lower()
        # If the caller explicitly asks for "image", verify the extension
        # actually is an image. Otherwise a stale walker / future refactor
        # could route a .pdf through the captioning pipeline (which would
        # then fail at Pillow.open with a confusing error).
        if mode == "image":
            if ext not in (".jpg", ".jpeg", ".png"):
                return _SUPPORTED_EXT.get(ext, "txt")
            return "image"
        if mode and mode != "auto":
            return mode
        if ext in (".jpg", ".jpeg", ".png"):
            return "image"
        return _SUPPORTED_EXT.get(ext, "txt")

    def _parse(self, path: str, doc_type: str) -> Tuple[List[Tuple[int, str]], Optional[int]]:
        """Returns ([(page_num, page_text), ...], total_page_count).
        page_num is 1-indexed. Files without real page concepts return [(1, full_text)].

        When image captioning is enabled, embedded images in PPTX/PDF/DOCX/
        XLSX are extracted, captioned via the configured provider, and
        their captions are appended to the host page's text under a
        marker so search can locate them alongside surrounding prose.
        Standalone images (doc_type='image') return a single page whose
        content is the caption itself.
        """
        override = self._parser_overrides.get(doc_type)
        if override is not None:
            return override(path)
        if doc_type == "image":
            return self._parse_image(path)
        if doc_type == "pdf":
            pages, count = self._parse_pdf(path)
        elif doc_type in ("md", "markdown", "txt"):
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                pages, count = [(1, handle.read())], None
        elif doc_type == "docx":
            pages, count = self._parse_docx(path)
        elif doc_type == "pptx":
            pages, count = self._parse_pptx(path)
        elif doc_type == "xlsx":
            pages, count = self._parse_xlsx(path)
        elif doc_type == "html":
            pages, count = self._parse_via_markitdown(path)
        else:
            # Fallback — treat as plain text
            with open(path, "rb") as handle:
                data = handle.read()
            text = data.decode("utf-8", errors="replace")
            pages, count = [(1, text)], None

        if self._image_caption_enabled and doc_type in ("pdf", "pptx", "docx", "xlsx"):
            pages = self._merge_image_captions(path, doc_type, pages)
        return pages, count

    def _parse_image(self, path: str) -> Tuple[List[Tuple[int, str]], Optional[int]]:
        """Caption a standalone image and return its caption as the doc's
        only page.

        에러 처리 정책:
        - 캡션 API 가 명시적으로 실패 (404 / 401 / 네트워크 / allowed_roots
          거부 등) → ``_caption_one`` 이 ``CaptionError`` 를 raise → caller
          (``index_file``) 가 catch 해 status="failed" + 원본 에러를 errors[]
          에 담아 반환. 사용자는 정확한 사유를 보게 된다.
        - 캡션이 성공적으로 빈 문자열 반환 (모델이 description 안 만듦 등)
          → 빈 doc 으로 인덱싱. 에러 아님. file.empty / failed 처리하지 않음.
          BM25 검색은 doc_name(파일명) 으로 가능.
        """
        caption = self._caption_one(path)
        return [(1, caption)], 1

    def _caption_one(self, image_path: str) -> str:
        """Return caption text for an image.

        에러 처리 정책 (사용자 요청):
        - 캡션 API/설정이 명시적으로 실패 (404 / 401 / 네트워크 / allowed_
          roots 거부 / SDK 미설치 등) → ``CaptionError`` 를 raise. 이전엔
          빈 문자열로 swallow 해서 실패 사유가 "empty content" 라는 무의미한
          메시지로 surface 됐다. 이제는 호출 측 (``_parse_image``,
          ``_merge_image_captions``) 이 직접 catch 해 의미있는 에러 메시지로
          처리.
        - 모델이 성공적으로 빈 응답 반환 (description 못 만듦) → ``""``.
          이건 에러 아님 — caller 가 빈 doc 으로 그대로 인덱싱.
        """
        try:
            from worker.image_captioner import caption_image, CaptionError  # type: ignore
        except Exception as exc:  # pragma: no cover - dep guard
            _info(log, "indexer.caption.import_failed", error=str(exc))
            raise RuntimeError(
                f"image_captioner 모듈 import 실패: {exc}"
            ) from exc

        # Path validation: the HTTP `/indexer/caption_image` endpoint applies
        # `_validate_file_path_within_roots`, but `_caption_one` is also called
        # from the in-process `index_file` path for extracted images and
        # standalone image docs. Re-validate here so a path that bypassed the
        # HTTP gate (e.g. a corrupt extractor output pointing outside the
        # workspace) can never reach Pillow / the OpenAI uploader.
        try:
            from local_indexer_worker import _validate_file_path_within_roots  # type: ignore
        except Exception:
            # Tests can run this module standalone; the validator is best-effort.
            _validate_file_path_within_roots = None  # type: ignore[assignment]
        try:
            safe_path = (
                _validate_file_path_within_roots(image_path)
                if _validate_file_path_within_roots is not None
                else os.path.abspath(image_path)
            )
        except Exception as exc:
            _info(log, "indexer.caption.rejected_path", path=image_path, error=str(exc))
            raise CaptionError(
                f"이미지 경로가 워커 allowed_roots 밖입니다: {exc}"
            ) from exc

        # The host pushes the api_key matching the active provider via
        # ``set_image_captioning``. For back-compat with the in-process
        # path (worker boot before any UI push) fall back to the worker's
        # stored OpenAI key — the captioner will reject if Azure was
        # selected without a pushed key, which is the right signal.
        provider_api_key = (
            self._image_caption_api_key or self._openai_api_key or None
        )
        caption_endpoint = self._image_caption_endpoint or None
        egress_token = None
        if self.egress_brokered:
            # Route captioning through the broker (P3 ⑬): the credential becomes
            # the egress token (carried as x-ave-egress-token), the endpoint
            # becomes the broker caption channel, and the real provider auth is
            # injected host-side. The worker never holds the caption key.
            egress_token = provider_api_key
            provider_api_key = None
            caption_endpoint = self.egress_caption_url

        try:
            result = caption_image(
                safe_path,
                provider=self._image_caption_provider,  # type: ignore[arg-type]
                model=self._image_caption_model or None,
                api_key=provider_api_key,
                endpoint=caption_endpoint,
                api_version=self._image_caption_api_version or None,
                egress_token=egress_token,
                egress_uds=self._egress_broker_uds or None,
            )
        except CaptionError as exc:
            _info(log, "indexer.caption.failed", path=safe_path, error=str(exc))
            raise
        except Exception as exc:  # pragma: no cover - defensive
            # Unexpected SDK / I/O failure — re-raise as CaptionError so the
            # error policy is uniform (caller catches CaptionError once).
            _info(log, "indexer.caption.unexpected", path=safe_path, error=str(exc))
            raise CaptionError(f"이미지 캡션 예기치 못한 실패: {exc}") from exc
        return result.caption or ""

    def _merge_image_captions(
        self,
        path: str,
        doc_type: str,
        pages: List[Tuple[int, str]],
    ) -> List[Tuple[int, str]]:
        """Caption every embedded image and append to its host page.

        Image text is appended under "[이미지 설명 #N]" markers so search
        snippets stay readable and the boundary between OCR-free text and
        image-derived text is greppable in raw chunks.

        Parsers like PDF can emit MULTIPLE chunks per logical page number
        (split paragraphs, repeated headers); the merge must preserve them
        all instead of dict-collapsing on `page`. We build an order-preserving
        list keyed by page and append image captions to the *last* chunk of
        that page so the caption stays adjacent to nearby text in the index.
        """
        try:
            from worker.image_extractor import extract_images  # type: ignore
        except Exception as exc:  # pragma: no cover - dep guard
            _info(log, "indexer.extract.import_failed", error=str(exc))
            return pages
        images = extract_images(path, doc_type, self.workspace)
        if not images:
            return pages

        # Original (page, text) tuples preserved in order. Track the index
        # of the LAST tuple for each page so captions append to the right
        # slot when multiple chunks share a page number.
        ordered: List[Tuple[int, str]] = list(pages)
        last_idx_for_page: Dict[int, int] = {}
        for i, (p, _) in enumerate(ordered):
            last_idx_for_page[p] = i

        # Per-image caption 실패 (API 4xx / 네트워크 / allowed_roots 거부 등)
        # 는 문서 단위 실패가 아니라 그 이미지 하나만 skip. 본문 텍스트는
        # 살아있어 검색 가능. 캡션 에러 사유는 _caption_one 이 이미
        # caption.failed / caption.rejected_path 이벤트로 emit 했고 호스트
        # parser → UI 경고 배너에 노출됨.
        for img in images:
            try:
                caption = self._caption_one(img.path)
            except Exception as exc:
                _info(
                    log,
                    "indexer.caption.inline_skipped",
                    path=img.path,
                    error=str(exc),
                )
                continue
            if not caption:
                continue
            marker = f"\n\n[이미지 설명 #{img.index_in_page + 1}]\n{caption}"
            target_idx = last_idx_for_page.get(img.page)
            if target_idx is None:
                # No text chunk for this page yet — synthesise one. Track
                # the new tuple as the page's "last" so subsequent images
                # on the same page also append here.
                ordered.append((img.page, marker.lstrip()))
                last_idx_for_page[img.page] = len(ordered) - 1
            else:
                page_num, existing = ordered[target_idx]
                ordered[target_idx] = (page_num, existing + marker)

        # Stable sort by page; same-page duplicates keep their relative order
        # because Python's sort is stable.
        return [(p, t) for p, t in sorted(ordered, key=lambda x: x[0]) if t.strip()]

    def _parse_pdf(self, path: str) -> Tuple[List[Tuple[int, str]], Optional[int]]:
        try:  # pragma: no cover - optional dependency
            import pymupdf4llm  # type: ignore

            page_chunks = pymupdf4llm.to_markdown(path, page_chunks=True)
            pages: List[Tuple[int, str]] = []
            for idx, chunk in enumerate(page_chunks):
                meta = chunk.get("metadata") or {}
                raw_page = meta.get("page")
                page_num = (raw_page if raw_page is not None else idx) + 1  # 0-indexed → 1-indexed
                text = chunk.get("text", "")
                if text.strip():
                    pages.append((page_num, text))
            page_count = len(page_chunks) if page_chunks else None
            return pages, page_count
        except Exception as exc:  # pragma: no cover
            raise RuntimeError(f"pymupdf4llm unavailable: {exc}") from exc

    def _parse_docx(self, path: str) -> Tuple[List[Tuple[int, str]], Optional[int]]:
        """Parse DOCX using python-docx >= 1.2.0, bucketing content into pages.

        Detects two sources of page boundaries in document order:

        - **Rendered breaks** (``w:lastRenderedPageBreak``): written by Microsoft
          Word when saving. Detected via ``Run.iter_inner_content()`` which yields
          ``RenderedPageBreak`` objects interspersed with text.
        - **Hard breaks**: ``paragraph.paragraph_format.page_break_before`` or
          ``<w:br w:type="page"/>`` elements inside runs. Produced by programmatic
          DOCX generators (python-docx ``add_page_break()``, LibreOffice export,
          Google Docs export).

        Paragraphs and tables are processed in document order (body children).
        Table cell text is concatenated per row (``cell1 | cell2``) and assigned
        to the current page; page-break detection inside table cells is not
        performed.

        Fallback: if zero page breaks of either type are found — e.g. a single-page
        or freshly generated DOCX with no explicit breaks — the entire document is
        returned as a single page. This condition is logged so it is not silent.

        EDR note: python-docx is a pure-Python wheel. The ``default.docx``
        template bundled inside the wheel is an XML-based resource file, not a
        native binary. Installation succeeds under standard corporate EDR policies
        that scan wheel contents.
        """
        try:
            from docx import Document  # type: ignore
            from docx.text.paragraph import Paragraph as _DParagraph  # type: ignore
            from docx.table import Table as _DTable  # type: ignore
            from docx.text.pagebreak import RenderedPageBreak  # type: ignore
            from docx.oxml.ns import qn  # type: ignore
        except ImportError as exc:
            raise RuntimeError(f"python-docx unavailable: {exc}") from exc

        try:
            doc = Document(path)
        except Exception as exc:
            raise RuntimeError(f"docx parse failed: {exc}") from exc

        W_P = qn("w:p")
        W_TBL = qn("w:tbl")

        current_page = 1
        page_parts: Dict[int, List[str]] = {}
        break_count = 0

        def _handle_paragraph(para: Any) -> None:
            nonlocal current_page, break_count
            # Hard break: page-break-before paragraph format property
            try:
                if para.paragraph_format.page_break_before:
                    current_page += 1
                    break_count += 1
            except Exception:
                pass
            # Scan runs for rendered breaks (Word) and explicit hard breaks
            for run in para.runs:
                # Rendered page breaks — python-docx 1.2.0 iter_inner_content() API
                try:
                    for obj in run.iter_inner_content():
                        if isinstance(obj, RenderedPageBreak):
                            current_page += 1
                            break_count += 1
                except Exception:
                    pass
                # Explicit hard break: <w:br w:type="page"/>
                try:
                    if 'w:type="page"' in run._element.xml:
                        current_page += 1
                        break_count += 1
                except Exception:
                    pass
            text = para.text.strip()
            if text:
                page_parts.setdefault(current_page, []).append(text)

        body = doc.element.body
        for child in body:
            if child.tag == W_P:
                _handle_paragraph(_DParagraph(child, body))
            elif child.tag == W_TBL:
                tbl = _DTable(child, body)
                for row in tbl.rows:
                    cell_texts: List[str] = []
                    for cell in row.cells:
                        cell_text = " ".join(
                            p.text.strip() for p in cell.paragraphs if p.text.strip()
                        )
                        if cell_text:
                            cell_texts.append(cell_text)
                    if cell_texts:
                        page_parts.setdefault(current_page, []).append(
                            " | ".join(cell_texts)
                        )

        if break_count == 0:
            _info(
                log,
                "indexer.docx.no_page_breaks",
                path=path,
                note=(
                    "no rendered or hard page breaks detected — "
                    "treating entire document as a single page"
                ),
            )

        if not page_parts:
            return [(1, "")], None

        max_page = max(page_parts)
        pages = [(p, "\n\n".join(texts)) for p, texts in sorted(page_parts.items())]
        return pages, max_page

    def _parse_pptx(self, path: str) -> Tuple[List[Tuple[int, str]], Optional[int]]:
        """zipfile + ElementTree로 PPTX 파싱. 슬라이드별 텍스트를 추출하여 page=slide_num.

        python-pptx 의존성을 피하기 위해 stdlib만 사용한다. PPTX는 ZIP 컨테이너이고
        각 슬라이드 본문은 ``ppt/slides/slideN.xml`` 한 파일에 들어 있어 직접 파싱이
        가능하다. 사내 EDR이 wheel 안의 ``templates/default.pptx`` 추출을 차단해
        설치 자체가 실패하는 환경에서도 동작한다.

        슬라이드 순서는 파일명 끝의 숫자로 정렬한다 — 일반 저장 시 PowerPoint가
        프레젠테이션 순서대로 번호를 재부여하므로 대부분의 경우와 일치한다.
        """
        import re
        import zipfile
        from xml.etree import ElementTree as ET

        A = "http://schemas.openxmlformats.org/drawingml/2006/main"
        P_TAG = f"{{{A}}}p"
        T_TAG = f"{{{A}}}t"

        slide_re = re.compile(r"^ppt/slides/slide(\d+)\.xml$")

        try:
            with zipfile.ZipFile(path) as zf:
                indexed: List[Tuple[int, str]] = []
                for name in zf.namelist():
                    m = slide_re.match(name)
                    if m:
                        indexed.append((int(m.group(1)), name))
                indexed.sort(key=lambda x: x[0])

                pages: List[Tuple[int, str]] = []
                for slide_num, name in (
                    (idx + 1, entry[1]) for idx, entry in enumerate(indexed)
                ):
                    with zf.open(name) as src:
                        tree = ET.parse(src)
                    paras: List[str] = []
                    for p in tree.iter(P_TAG):
                        text = "".join(t.text or "" for t in p.iter(T_TAG)).strip()
                        if text:
                            paras.append(text)
                    if paras:
                        pages.append((slide_num, "\n".join(paras)))
                return pages, len(indexed)
        except Exception as exc:
            raise RuntimeError(f"pptx parse failed: {exc}") from exc

    def _parse_xlsx(self, path: str) -> Tuple[List[Tuple[int, str]], Optional[int]]:
        """openpyxl로 XLSX 파싱. 시트별 텍스트를 추출하여 page=sheet_index.

        read_only=True + data_only=True 조합은 수식 캐시가 없는 파일에서
        모든 셀을 None으로 반환하는 문제가 있어 일반 로드 방식을 사용한다.
        data_only=True(캐시된 수식 값) → 빈 결과면 data_only=False(수식 문자열) 폴백.
        병합 셀·텍스트박스 등 openpyxl이 누락하는 경우 XML 직접 읽기로 최종 폴백.
        """
        import openpyxl  # type: ignore

        def _extract_pages(wb: Any) -> Tuple[List[Tuple[int, str]], int]:
            sheet_names = wb.sheetnames
            pages: List[Tuple[int, str]] = []
            for sheet_num, name in enumerate(sheet_names, start=1):
                ws = wb[name]
                rows: List[str] = []
                # values_only=True 대신 Cell 객체로 직접 접근
                # — MergedCell의 top-left 셀 값도 안전하게 읽기 위함
                for row in ws.iter_rows():
                    cells = [
                        str(cell.value).strip()
                        for cell in row
                        if cell.value is not None and str(cell.value).strip()
                    ]
                    if cells:
                        rows.append(" | ".join(cells))
                if rows:
                    pages.append((sheet_num, f"[{name}]\n" + "\n".join(rows)))
            return pages, len(sheet_names)

        try:
            wb = openpyxl.load_workbook(path, data_only=True)
            try:
                pages, sheet_count = _extract_pages(wb)
            finally:
                wb.close()
        except Exception as exc:
            raise RuntimeError(f"openpyxl(data_only=True) 실패: {exc}") from exc

        if not pages:
            # 수식 캐시 없는 파일: 수식 문자열로 폴백
            try:
                wb2 = openpyxl.load_workbook(path, data_only=False)
                try:
                    pages, sheet_count = _extract_pages(wb2)
                finally:
                    wb2.close()
            except Exception as exc:
                raise RuntimeError(f"openpyxl(data_only=False) 실패: {exc}") from exc

        if not pages:
            # openpyxl 모델이 내용을 누락하는 경우(텍스트박스, 특수 병합 등):
            # xlsx ZIP 내 XML을 직접 파싱하는 최후 폴백
            try:
                pages, sheet_count = self._extract_xlsx_via_xml(path)
            except Exception as xml_exc:
                raise RuntimeError(f"xlsx 파싱 실패 (openpyxl + XML 폴백 모두 실패): {xml_exc}") from xml_exc

        return pages, sheet_count

    def _extract_xlsx_via_xml(self, path: str) -> Tuple[List[Tuple[int, str]], int]:
        """xlsx ZIP 내 XML을 직접 파싱해 셀 값과 텍스트박스 내용을 추출하는 폴백.

        셀 값(공유 문자열·인라인 문자열·숫자)과 DrawingML 텍스트박스를 모두 추출한다.
        시트 파일은 숫자 기준 정렬로 workbook.xml 순서와 일치시킨다(C-1 수정).
        """
        import re
        import zipfile
        import xml.etree.ElementTree as ET

        SS_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
        DML_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"

        with zipfile.ZipFile(path, "r") as z:
            names_in_zip = z.namelist()

            # 공유 문자열 테이블 로드
            shared: List[str] = []
            if "xl/sharedStrings.xml" in names_in_zip:
                with z.open("xl/sharedStrings.xml") as f:
                    ss_root = ET.parse(f).getroot()
                for si in ss_root.findall(f"{{{SS_NS}}}si"):
                    text = "".join(t.text or "" for t in si.iter(f"{{{SS_NS}}}t"))
                    shared.append(text)

            # workbook.xml에서 시트 이름 순서 확인
            sheet_names: List[str] = []
            if "xl/workbook.xml" in names_in_zip:
                with z.open("xl/workbook.xml") as f:
                    wb_root = ET.parse(f).getroot()
                for sheet_el in wb_root.findall(f".//{{{SS_NS}}}sheet"):
                    sheet_names.append(sheet_el.get("name", ""))

            def _sheet_num(name: str) -> int:
                m = re.search(r"sheet(\d+)\.xml$", name)
                return int(m.group(1)) if m else 0

            # 시트 파일을 숫자 기준 정렬 — lexicographic 정렬 시 10개 이상에서 오염 방지
            sheet_files = sorted(
                (n for n in names_in_zip if n.startswith("xl/worksheets/sheet") and n.endswith(".xml")),
                key=_sheet_num,
            )

            pages: List[Tuple[int, str]] = []
            for sheet_num, sheet_file in enumerate(sheet_files, start=1):
                label = sheet_names[sheet_num - 1] if sheet_num - 1 < len(sheet_names) else f"Sheet{sheet_num}"
                with z.open(sheet_file) as f:
                    ws_root = ET.parse(f).getroot()

                texts: List[str] = []

                # 셀 값 추출
                for c in ws_root.findall(f".//{{{SS_NS}}}c"):
                    t_attr = c.get("t", "")
                    v_el = c.find(f"{{{SS_NS}}}v")
                    is_el = c.find(f"{{{SS_NS}}}is")
                    value = ""
                    if t_attr == "s" and v_el is not None and v_el.text is not None:
                        idx = int(v_el.text)
                        if 0 <= idx < len(shared):
                            value = shared[idx]
                    elif t_attr == "inlineStr" and is_el is not None:
                        value = "".join(t.text or "" for t in is_el.iter(f"{{{SS_NS}}}t"))
                    elif v_el is not None and v_el.text:
                        value = v_el.text
                    value = value.strip()
                    if value:
                        texts.append(value)

                # DrawingML 텍스트박스 추출 — 셀처럼 보이지만 실제론 drawing인 경우 대응
                drawing_ref = ws_root.find(f".//{{{SS_NS}}}drawing")
                if drawing_ref is not None:
                    # sheet와 동일 번호의 drawing 파일 추론
                    drawing_file = f"xl/drawings/drawing{_sheet_num(sheet_file)}.xml"
                    if drawing_file not in names_in_zip:
                        # rId 참조를 직접 찾는 대신 같은 번호 파일만 시도
                        pass
                    else:
                        with z.open(drawing_file) as df:
                            draw_root = ET.parse(df).getroot()
                        for t_el in draw_root.iter(f"{{{DML_NS}}}t"):
                            text = (t_el.text or "").strip()
                            if text:
                                texts.append(text)

                if texts:
                    pages.append((sheet_num, f"[{label}]\n" + " | ".join(texts)))

            return pages, max(len(sheet_files), 1)

    def _parse_via_markitdown(self, path: str) -> Tuple[List[Tuple[int, str]], Optional[int]]:
        try:  # pragma: no cover - optional
            from markitdown import MarkItDown  # type: ignore

            converter = MarkItDown()
            result = converter.convert(path)
            text = (
                getattr(result, "text_content", None)
                or getattr(result, "markdown", "")
                or ""
            )
            return [(1, text)], None
        except Exception as exc:  # pragma: no cover
            raise RuntimeError(f"markitdown unavailable: {exc}") from exc

    # ------------------------------------------------------------------
    # Chunking
    # ------------------------------------------------------------------
    def _chunk(self, doc_id: str, paged_content: List[Tuple[int, str]]) -> List[Chunk]:
        tokenizer = self._get_tokenizer()
        chunks: List[Chunk] = []
        index = 0

        # Buffer persists across page boundaries so overlap carries through.
        buffer: List[str] = []
        buffer_tokens = 0
        last_page_num: Optional[int] = None

        for page_num, page_text in paged_content:
            last_page_num = page_num
            sentences = tokenizer.split_sents(page_text)
            if not sentences:
                sentences = [line.strip() for line in page_text.splitlines() if line.strip()]
            if not sentences:
                continue

            for sent in sentences:
                sent_tokens = _approx_token_count(sent)
                if buffer and (buffer_tokens + sent_tokens) > self.target_tokens:
                    text = " ".join(buffer).strip()
                    if text:
                        chunks.append(self._make_chunk(doc_id, index, text, page_num))
                        index += 1
                    buffer, buffer_tokens = _apply_overlap(buffer, self.overlap_tokens)
                buffer.append(sent)
                buffer_tokens += sent_tokens

        if buffer and last_page_num is not None:
            text = " ".join(buffer).strip()
            if text:
                chunks.append(self._make_chunk(doc_id, index, text, last_page_num))
                index += 1

        return chunks

    def _make_chunk(self, doc_id: str, index: int, text: str, page: Optional[int] = None) -> Chunk:
        chunk_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
        return Chunk(
            chunk_id=str(uuid.uuid4()),
            doc_id=doc_id,
            chunk_index=index,
            page=page,
            raw_text=text,
            token_count=_approx_token_count(text),
            chunk_hash=chunk_hash,
        )

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------
    def _persist_sqlite(
        self,
        *,
        doc_id: str,
        abs_path: str,
        doc_name: str,
        doc_type: str,
        mtime_ms: int,
        page_count: Optional[int],
        line_count: Optional[int],
        chunks: Sequence[Chunk],
        embedded: bool,
        content_state: str = "ok",
        content_hash: Optional[str] = None,
    ) -> None:
        now_ms = int(time.time() * 1000)
        conn = self._connect()
        try:
            conn.execute("BEGIN")
            conn.execute("DELETE FROM documents WHERE doc_id = ?", (doc_id,))
            conn.execute("DELETE FROM documents WHERE path = ?", (abs_path,))
            conn.execute(
                """
                INSERT INTO documents (doc_id, path, doc_name, doc_type, page_count,
                                       line_count, mtime_ms, indexed_at, status,
                                       content_state, content_hash)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    doc_id,
                    abs_path,
                    doc_name,
                    doc_type,
                    page_count,
                    line_count,
                    mtime_ms,
                    now_ms,
                    "indexed",
                    content_state,
                    content_hash,
                ),
            )
            conn.executemany(
                """
                INSERT INTO chunks (chunk_id, doc_id, chunk_index, page, raw_text,
                                    token_count, chunk_hash)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        c.chunk_id,
                        c.doc_id,
                        c.chunk_index,
                        c.page,
                        c.raw_text,
                        c.token_count,
                        c.chunk_hash,
                    )
                    for c in chunks
                ],
            )
            conn.executemany(
                """
                INSERT INTO chunks_fts (chunk_id, doc_id, raw_text, content_ko)
                VALUES (?, ?, ?, ?)
                """,
                [(c.chunk_id, c.doc_id, c.raw_text, c.content_ko) for c in chunks],
            )
            if embedded:
                conn.executemany(
                    """
                    INSERT INTO embeddings_meta (chunk_id, model, dimensions, embedded_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    [
                        (
                            c.chunk_id,
                            self.embedding_model,
                            self._resolve_dimensions(),
                            now_ms,
                        )
                        for c in chunks
                    ],
                )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _delete_document_rows(
        self,
        conn: sqlite3.Connection,
        *,
        doc_id: Optional[str] = None,
        abs_path: Optional[str] = None,
    ) -> None:
        params: Tuple[str, ...]
        chunk_ids: List[str] = []
        if doc_id is not None:
            params = (doc_id,)
            chunk_rows = conn.execute(
                "SELECT chunk_id FROM chunks WHERE doc_id = ?",
                params,
            ).fetchall()
            conn.execute("DELETE FROM chunks_fts WHERE doc_id = ?", params)
            conn.execute("DELETE FROM documents WHERE doc_id = ?", params)
        elif abs_path is not None:
            params = (abs_path,)
            chunk_rows = conn.execute(
                """
                SELECT chunks.chunk_id
                FROM chunks
                JOIN documents ON documents.doc_id = chunks.doc_id
                WHERE documents.path = ?
                """,
                params,
            ).fetchall()
            conn.execute(
                """
                DELETE FROM chunks_fts
                WHERE chunk_id IN (
                    SELECT chunks.chunk_id
                    FROM chunks
                    JOIN documents ON documents.doc_id = chunks.doc_id
                    WHERE documents.path = ?
                )
                """,
                params,
            )
            conn.execute("DELETE FROM documents WHERE path = ?", params)
        else:
            raise ValueError("doc_id or abs_path is required")

        for row in chunk_rows:
            chunk_id = row["chunk_id"]
            if chunk_id is None:
                continue
            chunk_ids.append(str(chunk_id))

        if chunk_ids:
            self._delete_vectors(chunk_ids)

    def _persist_vectors(
        self,
        *,
        chunks: Sequence[Chunk],
        vectors: Sequence[Sequence[float]],
    ) -> None:
        store = self._get_vector_store()
        if store is None:
            return
        rows = [
            {
                "chunk_id": chunk.chunk_id,
                "doc_id": chunk.doc_id,
                "vector": list(vectors[i]),
                "raw_text": chunk.raw_text,
            }
            for i, chunk in enumerate(chunks)
        ]
        store.upsert(rows)

    def _delete_vectors(self, chunk_ids: Sequence[str]) -> None:
        if not chunk_ids:
            return
        store = self._get_vector_store()
        if store is None:
            return
        try:
            store.delete_by_chunk_ids(list(chunk_ids))
        except Exception as exc:  # pragma: no cover - defensive cleanup path
            _info(log, "indexer.vector.delete.warn", error=str(exc), chunk_count=len(chunk_ids))

    def _set_doc_content_hash(self, doc_id: str, content_hash: str) -> None:
        """Write content_hash ONLY after the lance vector insert has succeeded.

        Invariant: a non-NULL content_hash means both the sqlite chunks and the
        lance vectors for this doc are fully committed. _persist_sqlite writes
        content_hash=None (NULL); this method is called only on the success path
        after _persist_vectors. A SIGKILL/OOM between the two steps therefore
        leaves content_hash=NULL, which the short-circuit (Step 3.5) treats as
        'changed' → the next reindex re-embeds and self-heals the missing vectors.
        """
        with self._connect() as conn:
            conn.execute(
                "UPDATE documents SET content_hash = ? WHERE doc_id = ?",
                (content_hash, doc_id),
            )
            conn.commit()

    def _mark_failed(
        self,
        doc_id: str,
        abs_path: str,
        doc_name: str,
        doc_type: str,
        mtime_ms: int,
    ) -> None:
        # INSERT OR REPLACE omits content_hash intentionally — SQLite sets it to
        # NULL (the column has no DEFAULT). A NULL content_hash is treated by the
        # short-circuit as 'changed', so a retry always re-embeds. Never add
        # content_hash here: preserving a stale hash across a failure would let the
        # short-circuit skip re-embedding on the next reindex, leaving vectors absent.
        now_ms = int(time.time() * 1000)
        try:
            with self._connect() as conn:
                conn.execute(
                    """
                    INSERT OR REPLACE INTO documents
                    (doc_id, path, doc_name, doc_type, page_count, line_count,
                     mtime_ms, indexed_at, status)
                    VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, 'failed')
                    """,
                    (doc_id, abs_path, doc_name, doc_type, mtime_ms, now_ms),
                )
                conn.commit()
        except Exception:
            log.exception("failed to mark document as failed")

    def _resolve_existing_doc_id(self, abs_path: str) -> Optional[str]:
        try:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT doc_id FROM documents WHERE path = ?", (abs_path,)
                ).fetchone()
            return row["doc_id"] if row else None
        except Exception:
            return None

    # ------------------------------------------------------------------
    # Content-hash short-circuit helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _compute_doc_content_hash(chunks: Sequence[Chunk]) -> str:
        """Stable sha256 over the document's chunked text.

        Normalization collapses each chunk's internal whitespace runs to single
        spaces and strips the ends, then joins chunks with a single newline. This
        keeps the hash invariant to whitespace-only differences (line-ending or
        trailing-space churn from editors / cloud sync) so byte-identical visible
        content always yields the same digest. The chunking pipeline is
        deterministic, so identical file content produces identical chunks and
        therefore an identical hash.
        """
        normalized = "\n".join(" ".join(c.raw_text.split()) for c in chunks)
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()

    def _read_doc_hash_state(self, doc_id: str) -> Tuple[Optional[str], Optional[str]]:
        """Return (content_hash, content_state) for an existing doc row.

        Returns (None, None) when no row exists (brand-new doc) or on any read
        error — both of which fall through to a full (re)index.
        """
        try:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT content_hash, content_state FROM documents WHERE doc_id = ?",
                    (doc_id,),
                ).fetchone()
            if row is None:
                return None, None
            return row["content_hash"], row["content_state"]
        except Exception:
            return None, None

    def _touch_document_mtime(self, doc_id: str, mtime_ms: int) -> None:
        """Advance only the stored mtime for an unchanged-content short-circuit.

        No chunks/vectors/embeddings are touched — the existing index rows are
        reused as-is; this just records that we observed the new file mtime so a
        later scan does not re-trigger on the same timestamp.
        """
        with self._connect() as conn:
            conn.execute(
                "UPDATE documents SET mtime_ms = ? WHERE doc_id = ?",
                (mtime_ms, doc_id),
            )
            conn.commit()

    def _purge_existing_index_rows(self, abs_path: str) -> None:
        """Remove all prior index rows for a path before re-persisting.

        _persist_sqlite cascades the documents-row delete to chunks +
        embeddings_meta, but the chunks_fts virtual table (no FK) and the
        external lance vectors are not reached by the cascade. This purges all of
        them. A brand-new path matches nothing, so it is a safe no-op.
        """
        with self._connect() as conn:
            self._delete_document_rows(conn, abs_path=abs_path)
            conn.commit()

    # ------------------------------------------------------------------
    # Lazy dependencies
    # ------------------------------------------------------------------
    def _get_tokenizer(self) -> Any:
        if self._tokenizer is not None:
            return self._tokenizer
        from korean_tokenizer import get_tokenizer  # type: ignore

        self._tokenizer = get_tokenizer()
        return self._tokenizer

    def _get_embedding_client(self) -> Any:
        """Lazy getter — delegates to get_embedding_client (public)."""
        return self.get_embedding_client()

    def get_embedding_client(self) -> Any:
        """Public getter for the lazily created embedding client.

        Uses the ``create_embedding_client`` factory to build an
        ``OpenAIEmbeddingClient`` for the configured provider (``openai`` or
        ``azure``).

        Two failure classes are kept distinct:

        - A ``ValueError`` from the factory means the requested provider is
          outside the supported ``{openai, azure}`` set — a config-contract
          bug, not a runtime condition. It is re-raised so the misconfiguration
          surfaces loudly instead of silently degrading to BM25-only.
        - Any other exception (e.g. the SDK failing to construct a client at
          runtime) is a genuine runtime degrade: it returns ``None`` and the
          call site falls through to BM25-only indexing so the plugin still
          boots when the embedding endpoint is unreachable.
        """
        if self._embedding_client is not None:
            return self._embedding_client
        if self.egress_brokered:
            # Broker mode: the credential is the per-session token (held in
            # _openai_api_key, pushed via /indexer/set_egress_token). Without it
            # the worker cannot authenticate to the broker yet → BM25-only until
            # the host pushes it. The real key/endpoint live host-side only.
            if not self._openai_api_key:
                return None
        # OpenAI 시 key 필수
        elif self.embedding_provider == "openai" and not self._openai_api_key:
            return None
        # Azure 시 endpoint + key 둘 다 필수.
        elif self.embedding_provider == "azure" and (
            not self.embedding_endpoint or not self._openai_api_key
        ):
            return None
        from embedding_client import create_embedding_client  # type: ignore

        try:
            client = create_embedding_client(
                provider=self.embedding_provider,
                model=self.embedding_model,
                api_key=None if self.egress_brokered else self._openai_api_key,
                endpoint=None if self.egress_brokered else (self.embedding_endpoint or None),
                api_version=self.embedding_api_version or None,
                dimensions=self.embedding_dimensions,
                target_rpm=self.target_rpm,
                egress_broker_url=self.egress_embedding_url or None,
                egress_broker_uds=self._egress_broker_uds or None,
                egress_token=self._openai_api_key if self.egress_brokered else None,
            )
            # IMPORTANT: client construction is cheap; the first network call
            # happens lazily on embed_batch. A failure at that point is handled
            # by index_file's try/except as a graceful BM25-only fallback.
            self._embedding_client = client
            return self._embedding_client
        except ValueError:
            # Unsupported provider — a config-contract violation, not a
            # network/runtime condition. Surface it instead of masking it as a
            # benign BM25-only degrade.
            _exception(
                log,
                "embedding_client.config_error",
                provider=self.embedding_provider,
                model=self.embedding_model,
            )
            raise
        except Exception as exc:
            _info(
                log,
                "embedding_client.unavailable",
                provider=self.embedding_provider,
                model=self.embedding_model,
                error=str(exc),
                note="indexing이 BM25-only로 진행됩니다 (vector 비활성). 임베딩 endpoint 가 다시 도달 가능해지면 재인덱싱 시 vector 활성.",
            )
            return None

    def _resolve_dimensions(self) -> int:
        """embedding_dimensions가 명시되어 있으면 그대로, 아니면 client default 사용.

        client가 없으면(disable_vector + key 부재) OpenAI default(1536)로 fallback —
        단 그 경우 _get_vector_store도 None을 반환하므로 schema에 사용 안 됨.
        """
        if self.embedding_dimensions is not None:
            return int(self.embedding_dimensions)
        client = self._get_embedding_client()
        if client is None:
            return 1536
        return int(client.dimensions)

    def _get_vector_store(self) -> Any:
        if self._vector_store is not None:
            return self._vector_store
        try:  # pragma: no cover - optional
            import lancedb  # type: ignore

            self._vector_store = _LanceVectorStore(
                self.lance_path, dimensions=self._resolve_dimensions()
            )
            return self._vector_store
        except Exception:
            return None


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------
def _approx_token_count(text: str) -> int:
    """Rough token estimate used when tiktoken is unavailable.

    Korean/Mixed text: ~1 token per 2-3 chars. English: ~0.75 tokens per
    word. We pick the larger of word-count * 1.0 and char-count / 2.5
    which is close enough for chunk bucketing.
    """
    if not text:
        return 0
    words = text.split()
    word_estimate = len(words)
    char_estimate = int(len(text) / 2.5)
    return max(word_estimate, char_estimate, 1)


def _apply_overlap(buffer: List[str], overlap_tokens: int) -> Tuple[List[str], int]:
    if overlap_tokens <= 0 or not buffer:
        return [], 0
    tail: List[str] = []
    total = 0
    for sent in reversed(buffer):
        t = _approx_token_count(sent)
        if total + t > overlap_tokens and tail:
            break
        tail.insert(0, sent)
        total += t
    return tail, total


def _classify_embedding_failure(exc: BaseException) -> str:
    """임베딩 egress 실패의 원인을 구분한다.

    sandbox-egress deny(연결 거부/차단)와 인증 실패(키 부재/무효)는 운영 대응이
    전혀 다르다 — 전자는 host egress allow-list/private-endpoint 라우팅 문제,
    후자는 사용자 API 키 설정 문제다. 두 경우를 같은 BM25-only fallback 으로
    뭉뚱그리면 strict-union 하의 egress deny 가 단순 폴백으로 위장돼 진단이 불가능.

    OpenAI SDK 를 import 하지 않고(워커 egress no-growth gate + SDK 부재 환경 대비)
    예외 클래스 이름 체인과 메시지로 duck-type 분류한다. 반환값:
      - "egress-denied"  : 연결 자체가 차단/거부 (APIConnectionError/Timeout, ECONNREFUSED 등)
      - "auth-failed"    : 인증/권한 실패 (AuthenticationError/PermissionDenied, HTTP 401/403)
      - "unknown"        : 위 어느 쪽으로도 단정할 수 없음
    """
    names = {type(b).__name__.lower() for b in type(exc).__mro__}
    message = str(exc).lower()

    auth_names = {"authenticationerror", "permissiondeniederror"}
    if names & auth_names or " 401" in f" {message}" or " 403" in f" {message}" \
            or "unauthorized" in message or "invalid api key" in message \
            or "incorrect api key" in message or "forbidden" in message:
        return "auth-failed"

    conn_names = {"apiconnectionerror", "apitimeouterror", "connectionerror", "timeouterror"}
    if names & conn_names or "econnrefused" in message or "connection refused" in message \
            or "connection error" in message or "failed to establish a new connection" in message \
            or "timed out" in message or "name or service not known" in message \
            or "blocked" in message or "network is unreachable" in message:
        return "egress-denied"

    return "unknown"


def _embedding_failure_note(failure_kind: str) -> str:
    """failure_kind 별 운영자용 진단 노트."""
    if failure_kind == "egress-denied":
        return (
            "BM25-only fallback (vector skipped). 임베딩 endpoint 로의 연결이 차단/거부됨 "
            "— host egress allow-list 또는 strict-union(networkAccess)에서 해당 host 가 "
            "hard-deny 되었을 수 있다. 키 문제가 아니라 네트워크 정책 문제다."
        )
    if failure_kind == "auth-failed":
        return (
            "BM25-only fallback (vector skipped). 임베딩 인증 실패 (API 키 부재/무효 또는 권한 거부) "
            "— endpoint 는 도달 가능하나 키/권한이 거부됨. egress 차단이 아니라 키 설정 문제다."
        )
    return (
        "BM25-only fallback (vector skipped). 임베딩 호출 실패 (원인 미상). "
        "임베딩 endpoint 가 다시 도달 가능해지면 재인덱싱 시 vector 활성."
    )


def _info(logger: Any, event: str, **fields: Any) -> None:
    try:
        logger.info(event, **fields)
    except TypeError:
        logger.info("%s %s", event, fields)


def _exception(logger: Any, event: str, **fields: Any) -> None:
    """structlog or stdlib logging compatible exception() call.

    structlog accepts kwargs; stdlib logging does not, so fall back to a
    formatted message while preserving exc_info for the active exception.
    """
    try:
        logger.exception(event, **fields)
    except TypeError:
        logger.exception("%s %s", event, fields)


def _normalize_distance_to_score(distance: float) -> float:
    """Map a LanceDB distance (smaller = closer) to a score (higher = better).

    Vector search returns ``_distance`` where a smaller value means the chunk
    is closer to the query. Downstream RRF and score-based ranking expect the
    opposite polarity (higher = better), so collapse the distance into
    ``1 / (1 + distance)`` which is strictly decreasing on ``[0, ∞)`` and
    bounded to ``(0, 1]``. Negative distances are clamped to 0.
    """
    return 1.0 / (1.0 + max(0.0, float(distance)))


class _LanceVectorStore:
    """Minimal lancedb wrapper used when ``lancedb`` is installed.

    Kept inline so the worker does not need another module file just
    for the adapter. Methods mirror the duck-typed interface expected
    by :class:`LocalIndexer` and :class:`SearchService`.
    """

    _TABLE = "chunks"

    def __init__(self, path: str, dimensions: int = 1536) -> None:
        import lancedb  # type: ignore

        self._path = path
        self._dimensions = dimensions
        os.makedirs(path, exist_ok=True)
        self._db = lancedb.connect(path)
        self._table = None

    def _check_dimension(self, table: Any) -> None:
        """기존 테이블 vector 컬럼 차원과 현재 설정이 다르면 ValueError를 발생시킨다.
        embedding model 변경 후 재인덱싱 없이 전환하면 LanceDB가 insert/search 시점에
        shape 오류를 던지므로 여기서 조기에 감지하여 BM25-only 폴백으로 유도한다."""
        try:
            vec_type = table.schema.field("vector").type
            stored_dim = vec_type.list_size  # pyarrow FixedSizeList
            if stored_dim != self._dimensions:
                raise ValueError(
                    f"LanceDB 차원 불일치: 저장된 {stored_dim}dim ≠ 현재 {self._dimensions}dim. "
                    "embedding model 변경 후 전체 재인덱싱이 필요합니다."
                )
        except ValueError:
            raise
        except Exception:
            pass  # schema 접근 실패 시 무시 (하위 호환)

    def _open_or_create(self, sample: List[Dict[str, Any]]) -> Any:
        if self._table is not None:
            return self._table
        if self._TABLE in self._db.table_names():
            table = self._db.open_table(self._TABLE)
            self._check_dimension(table)  # 차원 불일치 시 ValueError → BM25-only fallback
            self._table = table
        else:
            self._table = self._db.create_table(self._TABLE, data=sample)
        return self._table

    @staticmethod
    def _validate_chunk_id(value: str) -> str:
        """Validate chunk_id is a UUID before embedding in a LanceDB predicate."""
        if not _UUID_RE.match(value):
            raise ValueError(f"Invalid chunk_id format: {value!r}")
        return value

    def upsert(self, rows: List[Dict[str, Any]]) -> None:
        if not rows:
            return
        table = self._open_or_create(rows[:1])
        # Lance doesn't have native upsert for all backends; delete + add.
        # _validate_chunk_id raises ValueError for non-UUID ids — keep it outside
        # the try so an invalid id aborts the entire upsert rather than skipping
        # the delete and producing duplicate rows.
        ids = ",".join(f"'{self._validate_chunk_id(r['chunk_id'])}'" for r in rows)
        try:
            table.delete(f"chunk_id IN ({ids})")
        except Exception:
            pass
        table.add(rows)

    def delete_by_chunk_ids(self, chunk_ids: List[str]) -> None:
        if not chunk_ids:
            return
        if self._table is None:
            if self._TABLE not in self._db.table_names():
                return
            self._table = self._db.open_table(self._TABLE)
        ids = ",".join(f"'{self._validate_chunk_id(cid)}'" for cid in chunk_ids)
        self._table.delete(f"chunk_id IN ({ids})")

    def list_chunk_ids(self) -> "set[str]":
        """Return the set of chunk_ids that actually have a vector in Lance.

        Used by :meth:`LocalIndexer.reconcile` to detect SQLite↔Lance drift.
        Projects ONLY the ``chunk_id`` column (no vector / raw_text
        materialisation) via a column-pruned scan so the enumeration stays
        cheap on large tables. Returns an empty set when the table has not
        been created yet (nothing indexed with vectors).
        """
        if self._table is None:
            if self._TABLE not in self._db.table_names():
                return set()
            self._table = self._db.open_table(self._TABLE)
        # ``search()`` with no query vector is a plain scan; ``select`` prunes
        # to the single id column and ``limit(None)`` defeats any default row
        # cap so every stored chunk_id is enumerated.
        arrow_tbl = self._table.search().select(["chunk_id"]).limit(None).to_arrow()
        return {str(v) for v in arrow_tbl.column("chunk_id").to_pylist() if v is not None}

    def count_rows(self) -> int:
        """Return the number of vectors currently stored in Lance.

        Used by :meth:`LocalIndexer.reconcile` as a cheap O(1) pre-check
        before committing to a full id-set enumeration.  LanceDB reads this
        from the manifest metadata, so it is far cheaper than a scan.
        Returns 0 when the table has not been created yet.
        """
        if self._table is None:
            if self._TABLE not in self._db.table_names():
                return 0
            self._table = self._db.open_table(self._TABLE)
        return int(self._table.count_rows())

    def search(self, vector: List[float], top_k: int = 20) -> List[Dict[str, Any]]:
        if self._table is None:
            if self._TABLE not in self._db.table_names():
                return []
            table = self._db.open_table(self._TABLE)
            try:
                self._check_dimension(table)
            except ValueError:
                log.warning("lance.search.dimension_mismatch", stored_table=self._TABLE)
                return []
            self._table = table
        try:
            # Declare cosine so ``_distance`` is a cosine distance regardless of
            # the table's stored default; query-time only, no reindex needed.
            df = self._table.search(vector).metric("cosine").limit(top_k).to_list()
        except Exception:
            return []
        results: List[Dict[str, Any]] = []
        for item in df:
            distance = item.get("_distance")
            if distance is not None:
                # Convert distance (smaller = closer) → score (higher = better).
                score = _normalize_distance_to_score(distance)
            else:
                # No distance column (duck-typed/pre-scored store): trust the
                # provided score as-is — do not re-normalize.
                score = float(item.get("score", 0.0))
            results.append({"chunk_id": item.get("chunk_id"), "score": float(score)})
        return results


def create_lance_vector_store(path: str, dimensions: int = 1536) -> "_LanceVectorStore":
    """Public factory for _LanceVectorStore — use this for cross-module access."""
    return _LanceVectorStore(path, dimensions=dimensions)


__all__ = ["LocalIndexer", "Chunk", "IndexResult", "create_lance_vector_store"]
