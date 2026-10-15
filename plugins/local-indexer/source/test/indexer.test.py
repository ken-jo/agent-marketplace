"""Pytest for LocalIndexer (sqlite + FTS5, mocked embedding + vector)."""

from __future__ import annotations

import os
import shutil
import sqlite3
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

_WORKER_DIR = Path(__file__).resolve().parent.parent / "worker"
sys.path.insert(0, str(_WORKER_DIR))

kiwipiepy = pytest.importorskip("kiwipiepy")

from local_indexer import LocalIndexer  # noqa: E402
from local_indexer_search import SearchService  # noqa: E402
from korean_tokenizer import get_tokenizer  # noqa: E402


class _FakeEmbeddingClient:
    def __init__(self) -> None:
        self.calls: List[int] = []
        self.dimensions = 1536

    def embed_corpus(self, chunks: List[str]) -> List[List[float]]:
        self.calls.append(len(chunks))
        return [[0.01] * 1536 for _ in chunks]

    def embed_one(self, text: str) -> List[float]:
        return [0.01] * 1536


class _FakeVectorStore:
    def __init__(self) -> None:
        self.rows: List[Dict[str, Any]] = []

    def upsert(self, rows: List[Dict[str, Any]]) -> None:
        self.rows.extend(rows)

    def search(self, vector: List[float], top_k: int = 20) -> List[Dict[str, Any]]:
        return []


@pytest.fixture
def fixture_md() -> Path:
    return Path(__file__).with_name("indexer.ko.fixture.md")


@pytest.fixture
def indexer(tmp_path: Path) -> LocalIndexer:
    sqlite_path = tmp_path / "fts5.sqlite"
    lance_path = tmp_path / "vectors.lance"
    workspace = tmp_path / "workspace"

    embed = _FakeEmbeddingClient()
    store = _FakeVectorStore()

    return LocalIndexer(
        workspace=str(workspace),
        sqlite_path=str(sqlite_path),
        lance_path=str(lance_path),
        openai_api_key="sk-test",
        embedding_client=embed,
        vector_store=store,
    )


def test_index_markdown_populates_tables(indexer: LocalIndexer, fixture_md: Path) -> None:
    result = indexer.index_file(str(fixture_md), mode="md")
    assert result.status == "indexed"
    assert result.chunk_count > 0

    conn = sqlite3.connect(indexer.sqlite_path)
    conn.row_factory = sqlite3.Row
    try:
        docs = conn.execute("SELECT * FROM documents").fetchall()
        assert len(docs) == 1
        chunk_rows = conn.execute("SELECT * FROM chunks").fetchall()
        assert len(chunk_rows) == result.chunk_count
        fts_rows = conn.execute("SELECT content_ko FROM chunks_fts").fetchall()
        assert len(fts_rows) == result.chunk_count
        non_empty = [row["content_ko"] for row in fts_rows if row["content_ko"].strip()]
        assert non_empty, "content_ko must contain kiwi morphemes"
        # Korean morphemes joined by spaces — sanity check that kiwi ran
        assert any("규정" in content for content in non_empty)

        emb_rows = conn.execute("SELECT * FROM embeddings_meta").fetchall()
        assert len(emb_rows) == result.chunk_count
    finally:
        conn.close()

    # Injected vector store should have received the rows.
    assert len(indexer._vector_store.rows) == result.chunk_count  # type: ignore[attr-defined]


def test_reindex_replaces_document(indexer: LocalIndexer, fixture_md: Path) -> None:
    indexer.index_file(str(fixture_md), mode="md")
    result = indexer.reindex(str(fixture_md), mode="md")
    assert result.status == "indexed"
    conn = sqlite3.connect(indexer.sqlite_path)
    try:
        (count,) = conn.execute("SELECT COUNT(*) FROM documents").fetchone()
        assert count == 1
    finally:
        conn.close()


def test_remove_document_purges_searchable_rows(indexer: LocalIndexer, fixture_md: Path) -> None:
    result = indexer.index_file(str(fixture_md), mode="md")

    assert indexer.remove_document(result.doc_id) is True
    assert indexer.remove_document(result.doc_id) is False

    conn = sqlite3.connect(indexer.sqlite_path)
    try:
        (doc_count,) = conn.execute("SELECT COUNT(*) FROM documents").fetchone()
        (chunk_count,) = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()
        (fts_count,) = conn.execute(
            "SELECT COUNT(*) FROM chunks_fts WHERE doc_id = ?",
            (result.doc_id,),
        ).fetchone()
        assert doc_count == 0
        assert chunk_count == 0
        assert fts_count == 0, "FTS5 rows must be purged on delete — stale rows cause search contamination"
    finally:
        conn.close()


def test_delete_then_search_returns_no_results(indexer: LocalIndexer, fixture_md: Path) -> None:
    """Regression: deleted document must not appear in BM25 search results (FTS5 stale row check)."""
    result = indexer.index_file(str(fixture_md), mode="md")
    assert result.status == "indexed"

    svc = SearchService(
        sqlite_path=indexer.sqlite_path,
        tokenizer=get_tokenizer(),
        embedding_client=_FakeEmbeddingClient(),
        vector_store=indexer._vector_store,  # type: ignore[arg-type]
    )

    # Verify the document is searchable before deletion
    hits_before = svc.search_bm25("규정", top_k=10)
    assert len(hits_before) > 0, "Document must be searchable before deletion"

    indexer.remove_document(result.doc_id)

    # After deletion, BM25 search must return no results for the deleted doc
    hits_after = svc.search_bm25("규정", top_k=10)
    deleted_ids = {h["doc_id"] for h in hits_after}
    assert result.doc_id not in deleted_ids, "Deleted document must not appear in search results (FTS5 stale row)"


def test_list_documents_recovers_when_sqlite_parent_dir_was_removed(tmp_path: Path) -> None:
    base = tmp_path / "data"
    indexer = LocalIndexer(
        workspace=str(tmp_path / "workspace"),
        sqlite_path=str(base / "fts5.sqlite"),
        lance_path=str(base / "vectors.lance"),
        openai_api_key="sk-test",
        embedding_client=_FakeEmbeddingClient(),
        vector_store=_FakeVectorStore(),
    )

    assert indexer.list_documents() == []
    # The directory holds the WAL/SHM sidecars of the open connection as well
    # as the database file; the scenario is "the parent directory is gone",
    # so remove the tree rather than assuming the database file was alone.
    shutil.rmtree(base)

    assert indexer.list_documents() == []
    assert Path(indexer.sqlite_path).exists()


class _RaisingEmbeddingClient:
    """Embedding client whose embed_corpus always fails — simulates an
    unreachable/denied embedding endpoint so the indexer falls back to
    BM25-only (vectors=[]) while still registering the document."""

    def __init__(self) -> None:
        self.dimensions = 1536

    def embed_corpus(self, chunks: List[str]) -> List[List[float]]:
        raise RuntimeError("embedding endpoint unreachable")

    def embed_one(self, text: str) -> List[float]:
        raise RuntimeError("embedding endpoint unreachable")


def test_empty_doc_content_state(indexer: LocalIndexer, tmp_path: Path) -> None:
    """Whitespace-only file: parsed but no extractable text. The doc must still
    register as status='indexed' (listable) but content_state='empty' with no
    chunks — distinct from a hard parse failure."""
    empty_file = tmp_path / "blank.md"
    empty_file.write_text("   \n\n  \t\n", encoding="utf-8")

    result = indexer.index_file(str(empty_file), mode="md")
    assert result.status == "indexed"
    assert result.content_state == "empty"
    assert result.chunk_count == 0

    conn = sqlite3.connect(indexer.sqlite_path)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT status, content_state FROM documents WHERE doc_id = ?",
            (result.doc_id,),
        ).fetchone()
        assert row["status"] == "indexed"
        assert row["content_state"] == "empty"
    finally:
        conn.close()


def test_embed_failed_content_state(tmp_path: Path, fixture_md: Path) -> None:
    """Text extracts and chunks fine, but embedding fails (vectors=[]). The doc
    stays status='indexed' (BM25/FTS5 still searchable) with
    content_state='embed_failed', chunk_count>0, and zero embeddings_meta rows —
    so the host can flag that semantic search is unavailable for this doc."""
    indexer = LocalIndexer(
        workspace=str(tmp_path / "workspace"),
        sqlite_path=str(tmp_path / "fts5.sqlite"),
        lance_path=str(tmp_path / "vectors.lance"),
        openai_api_key="sk-test",
        embedding_client=_RaisingEmbeddingClient(),
        vector_store=_FakeVectorStore(),
    )

    result = indexer.index_file(str(fixture_md), mode="md")
    assert result.status == "indexed"
    assert result.content_state == "embed_failed"
    assert result.chunk_count > 0

    conn = sqlite3.connect(indexer.sqlite_path)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT status, content_state FROM documents WHERE doc_id = ?",
            (result.doc_id,),
        ).fetchone()
        assert row["status"] == "indexed"
        assert row["content_state"] == "embed_failed"
        (chunk_count,) = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()
        assert chunk_count == result.chunk_count
        (emb_count,) = conn.execute("SELECT COUNT(*) FROM embeddings_meta").fetchone()
        assert emb_count == 0, "embeddings_meta must be empty when embedding failed"
    finally:
        conn.close()


def test_legacy_db_migrates_content_state(tmp_path: Path) -> None:
    """An existing index DB created before content_state shipped must gain the
    column via an idempotent ALTER ... ADD COLUMN without dropping rows; legacy
    rows backfill to the 'ok' default."""
    base = tmp_path / "data"
    base.mkdir(parents=True)
    sqlite_path = base / "fts5.sqlite"

    # Build an OLD-schema documents table (no content_state) + seed legacy rows.
    legacy = sqlite3.connect(sqlite_path)
    legacy.executescript(
        """
        CREATE TABLE documents (
          doc_id     TEXT PRIMARY KEY,
          path       TEXT NOT NULL UNIQUE,
          doc_name   TEXT NOT NULL,
          doc_type   TEXT NOT NULL,
          page_count INTEGER,
          line_count INTEGER,
          mtime_ms   INTEGER NOT NULL,
          indexed_at INTEGER NOT NULL,
          status     TEXT NOT NULL
        );
        """
    )
    legacy.execute(
        "INSERT INTO documents VALUES ('d1','/legacy/a.md','a.md','md',1,10,111,222,'indexed')"
    )
    legacy.execute(
        "INSERT INTO documents VALUES ('d2','/legacy/b.md','b.md','md',1,10,111,222,'failed')"
    )
    legacy.commit()
    cols_before = {r[1] for r in legacy.execute("PRAGMA table_info(documents)")}
    (rows_before,) = legacy.execute("SELECT COUNT(*) FROM documents").fetchone()
    legacy.close()
    assert "content_state" not in cols_before

    # Constructing the indexer runs _init_schema → idempotent migration.
    indexer = LocalIndexer(
        workspace=str(tmp_path / "workspace"),
        sqlite_path=str(sqlite_path),
        lance_path=str(base / "vectors.lance"),
        openai_api_key="sk-test",
        embedding_client=_FakeEmbeddingClient(),
        vector_store=_FakeVectorStore(),
    )

    conn = sqlite3.connect(sqlite_path)
    conn.row_factory = sqlite3.Row
    try:
        cols_after = {r["name"] for r in conn.execute("PRAGMA table_info(documents)")}
        assert "content_state" in cols_after
        (rows_after,) = conn.execute("SELECT COUNT(*) FROM documents").fetchone()
        assert rows_after == rows_before, "migration must not drop rows"
        legacy_state = conn.execute(
            "SELECT content_state FROM documents WHERE doc_id = 'd1'"
        ).fetchone()["content_state"]
        assert legacy_state == "ok", "legacy rows backfill to the 'ok' default"
    finally:
        conn.close()

    # Re-running the migration is a no-op (idempotent) — column count stays 1.
    indexer._init_schema()
    conn = sqlite3.connect(sqlite_path)
    try:
        cs_cols = [
            r for r in conn.execute("PRAGMA table_info(documents)") if r[1] == "content_state"
        ]
        assert len(cs_cols) == 1
        (rows_final,) = conn.execute("SELECT COUNT(*) FROM documents").fetchone()
        assert rows_final == rows_before
    finally:
        conn.close()


# ----------------------------------------------------------------------
# P1 item 7a — doc-level content-hash short-circuit
# ----------------------------------------------------------------------
class _CountingEmbeddingClient:
    """Embedding client that counts embed_corpus invocations.

    The whole point of the content-hash short-circuit is to spend ZERO embedding
    calls on a no-op re-index, so the cost-saving claim is proven by asserting
    corpus_calls does not advance across an unchanged-content reindex."""

    def __init__(self) -> None:
        self.dimensions = 1536
        self.corpus_calls = 0
        self.embedded_chunk_total = 0

    def embed_corpus(self, chunks: List[str]) -> List[List[float]]:
        self.corpus_calls += 1
        self.embedded_chunk_total += len(chunks)
        return [[0.01] * 1536 for _ in chunks]

    def embed_one(self, text: str) -> List[float]:
        return [0.01] * 1536


class _ToggleEmbeddingClient:
    """Embedding client whose embed_corpus fails while ``fail`` is True, then
    succeeds once flipped. Used to land a doc in content_state='embed_failed'
    and then prove an unchanged-content reindex retries embedding instead of
    short-circuiting."""

    def __init__(self) -> None:
        self.dimensions = 1536
        self.fail = True
        self.corpus_calls = 0

    def embed_corpus(self, chunks: List[str]) -> List[List[float]]:
        self.corpus_calls += 1
        if self.fail:
            raise RuntimeError("embedding endpoint unreachable")
        return [[0.01] * 1536 for _ in chunks]

    def embed_one(self, text: str) -> List[float]:
        if self.fail:
            raise RuntimeError("embedding endpoint unreachable")
        return [0.01] * 1536


def _touch(path: Path, *, delta_s: float = 5.0) -> int:
    """Bump a file's mtime by delta_s WITHOUT changing its bytes. Returns the
    new mtime in ms (matching the indexer's int(getmtime*1000))."""
    new_mtime = os.path.getmtime(path) + delta_s
    os.utime(path, (new_mtime, new_mtime))
    return int(os.path.getmtime(path) * 1000)


def _doc_row(sqlite_path: str, doc_id: str) -> Dict[str, Any]:
    conn = sqlite3.connect(sqlite_path)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT mtime_ms, content_hash, content_state FROM documents WHERE doc_id = ?",
            (doc_id,),
        ).fetchone()
        return dict(row) if row else {}
    finally:
        conn.close()


def _count(sqlite_path: str, table: str) -> int:
    conn = sqlite3.connect(sqlite_path)
    try:
        (n,) = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()
        return n
    finally:
        conn.close()


def test_touch_unchanged_content_short_circuits(tmp_path: Path, fixture_md: Path) -> None:
    """Touch (mtime++ only, bytes identical) → reindex must short-circuit:
    unchanged==True, ZERO new embed calls, embeddings_meta stable, mtime advanced."""
    embed = _CountingEmbeddingClient()
    indexer = LocalIndexer(
        workspace=str(tmp_path / "workspace"),
        sqlite_path=str(tmp_path / "fts5.sqlite"),
        lance_path=str(tmp_path / "vectors.lance"),
        openai_api_key="sk-test",
        embedding_client=embed,
        vector_store=_FakeVectorStore(),
    )

    first = indexer.index_file(str(fixture_md), mode="md")
    assert first.status == "indexed"
    assert first.content_state == "ok"
    assert first.unchanged is False
    assert embed.corpus_calls == 1, "first index must embed exactly once"

    emb_before = _count(indexer.sqlite_path, "embeddings_meta")
    mtime_before = _doc_row(indexer.sqlite_path, first.doc_id)["mtime_ms"]
    assert emb_before == first.chunk_count

    new_mtime_ms = _touch(fixture_md)

    second = indexer.reindex(str(fixture_md), mode="md")
    assert second.unchanged is True, "byte-identical content must short-circuit"
    assert second.embedded is True
    assert second.content_state == "ok"
    assert second.doc_id == first.doc_id, "doc_id must stay stable across reindex"
    assert embed.corpus_calls == 1, "no-op reindex must make ZERO new embed calls"

    row_after = _doc_row(indexer.sqlite_path, first.doc_id)
    assert _count(indexer.sqlite_path, "embeddings_meta") == emb_before, (
        "embeddings_meta must be untouched by the short-circuit"
    )
    assert row_after["mtime_ms"] == new_mtime_ms, "mtime must advance to the touched value"
    assert row_after["mtime_ms"] > mtime_before
    assert row_after["content_state"] == "ok"


def test_embed_failed_does_not_short_circuit(tmp_path: Path, fixture_md: Path) -> None:
    """A doc whose embedding failed (content_state='embed_failed') must RE-ATTEMPT
    embedding on an unchanged-content reindex — the short-circuit only fires for
    content_state=='ok'."""
    client = _ToggleEmbeddingClient()
    indexer = LocalIndexer(
        workspace=str(tmp_path / "workspace"),
        sqlite_path=str(tmp_path / "fts5.sqlite"),
        lance_path=str(tmp_path / "vectors.lance"),
        openai_api_key="sk-test",
        embedding_client=client,
        vector_store=_FakeVectorStore(),
    )

    first = indexer.index_file(str(fixture_md), mode="md")
    assert first.content_state == "embed_failed"
    assert first.chunk_count > 0
    assert client.corpus_calls == 1
    assert _count(indexer.sqlite_path, "embeddings_meta") == 0

    # Endpoint recovers; re-index the SAME bytes.
    _touch(fixture_md)
    client.fail = False

    second = indexer.reindex(str(fixture_md), mode="md")
    assert second.unchanged is False, "embed_failed must retry, not short-circuit"
    assert second.content_state == "ok"
    assert second.embedded is True
    assert client.corpus_calls == 2, "embedding must be re-attempted"
    assert _count(indexer.sqlite_path, "embeddings_meta") == second.chunk_count


def test_legacy_null_hash_reindexes_then_short_circuits(tmp_path: Path, fixture_md: Path) -> None:
    """A row with content_hash NULL (legacy, predates the column) is treated as
    changed: it reindexes once and backfills the hash. A subsequent touch then
    short-circuits, proving the backfill took."""
    embed = _CountingEmbeddingClient()
    indexer = LocalIndexer(
        workspace=str(tmp_path / "workspace"),
        sqlite_path=str(tmp_path / "fts5.sqlite"),
        lance_path=str(tmp_path / "vectors.lance"),
        openai_api_key="sk-test",
        embedding_client=embed,
        vector_store=_FakeVectorStore(),
    )

    first = indexer.index_file(str(fixture_md), mode="md")
    doc_id = first.doc_id
    assert embed.corpus_calls == 1

    # Simulate a legacy row: blank the hash the migration backfilled to NULL.
    conn = sqlite3.connect(indexer.sqlite_path)
    conn.execute("UPDATE documents SET content_hash = NULL WHERE doc_id = ?", (doc_id,))
    conn.commit()
    conn.close()

    _touch(fixture_md)
    second = indexer.reindex(str(fixture_md), mode="md")
    assert second.unchanged is False, "legacy NULL hash forces one reindex"
    assert second.doc_id == doc_id
    assert embed.corpus_calls == 2, "NULL hash must re-embed"
    backfilled = _doc_row(indexer.sqlite_path, doc_id)["content_hash"]
    assert backfilled is not None, "the reindex must backfill content_hash"

    # Now that the hash is present + content_state=='ok', a touch short-circuits.
    _touch(fixture_md)
    third = indexer.reindex(str(fixture_md), mode="md")
    assert third.unchanged is True
    assert embed.corpus_calls == 2, "no further embed once the hash is backfilled"


def test_legacy_db_migrates_content_hash(tmp_path: Path) -> None:
    """An index DB created after content_state but before content_hash shipped
    must gain the content_hash column via an idempotent ALTER ... ADD COLUMN
    without dropping rows; legacy rows get a NULL hash (treated as changed)."""
    base = tmp_path / "data"
    base.mkdir(parents=True)
    sqlite_path = base / "fts5.sqlite"

    legacy = sqlite3.connect(sqlite_path)
    legacy.executescript(
        """
        CREATE TABLE documents (
          doc_id        TEXT PRIMARY KEY,
          path          TEXT NOT NULL UNIQUE,
          doc_name      TEXT NOT NULL,
          doc_type      TEXT NOT NULL,
          page_count    INTEGER,
          line_count    INTEGER,
          mtime_ms      INTEGER NOT NULL,
          indexed_at    INTEGER NOT NULL,
          status        TEXT NOT NULL,
          content_state TEXT NOT NULL DEFAULT 'ok'
        );
        """
    )
    legacy.execute(
        "INSERT INTO documents "
        "(doc_id,path,doc_name,doc_type,page_count,line_count,mtime_ms,indexed_at,status,content_state) "
        "VALUES ('d1','/legacy/a.md','a.md','md',1,10,111,222,'indexed','ok')"
    )
    legacy.commit()
    cols_before = {r[1] for r in legacy.execute("PRAGMA table_info(documents)")}
    (rows_before,) = legacy.execute("SELECT COUNT(*) FROM documents").fetchone()
    legacy.close()
    assert "content_hash" not in cols_before

    # Constructing the indexer runs _init_schema → idempotent migration.
    indexer = LocalIndexer(
        workspace=str(tmp_path / "workspace"),
        sqlite_path=str(sqlite_path),
        lance_path=str(base / "vectors.lance"),
        openai_api_key="sk-test",
        embedding_client=_CountingEmbeddingClient(),
        vector_store=_FakeVectorStore(),
    )

    conn = sqlite3.connect(sqlite_path)
    conn.row_factory = sqlite3.Row
    try:
        cols_after = {r["name"] for r in conn.execute("PRAGMA table_info(documents)")}
        assert "content_hash" in cols_after
        (rows_after,) = conn.execute("SELECT COUNT(*) FROM documents").fetchone()
        assert rows_after == rows_before, "migration must not drop rows"
        legacy_hash = conn.execute(
            "SELECT content_hash FROM documents WHERE doc_id = 'd1'"
        ).fetchone()["content_hash"]
        assert legacy_hash is None, "legacy rows get a NULL hash (treated as changed)"
    finally:
        conn.close()

    # Re-running the migration is a no-op (idempotent) — column count stays 1.
    indexer._init_schema()
    conn = sqlite3.connect(sqlite_path)
    try:
        ch_cols = [
            r for r in conn.execute("PRAGMA table_info(documents)") if r[1] == "content_hash"
        ]
        assert len(ch_cols) == 1
        (rows_final,) = conn.execute("SELECT COUNT(*) FROM documents").fetchone()
        assert rows_final == rows_before
    finally:
        conn.close()


# ----------------------------------------------------------------------
# P1 item 7a — crash-window ordering invariant
# ----------------------------------------------------------------------
class _OrderingProbeVectorStore:
    """Vector store that snapshots content_hash from the DB during its upsert call.

    Used to prove the ordering invariant: _persist_sqlite commits with
    content_hash=NULL (Step 5), and _set_doc_content_hash runs only AFTER the
    lance upsert succeeds (Step 6). A crash between the two steps therefore
    leaves content_hash=NULL, which the short-circuit treats as 'changed' and
    forces a full reindex — self-healing any missing vectors.

    This test FAILS without the fix (content_hash is written eagerly in
    _persist_sqlite and will be non-NULL during the upsert).
    """

    def __init__(self, sqlite_path: str) -> None:
        self.sqlite_path = sqlite_path
        self.rows: List[Dict[str, Any]] = []
        # content_hash value captured from the DB at the moment upsert is called.
        # Initialized to a sentinel so we can distinguish "upsert never called"
        # from "upsert called and saw NULL".
        self.content_hash_at_upsert: Optional[str] = "SENTINEL_NOT_CALLED"
        self._upsert_called = False

    def upsert(self, rows: List[Dict[str, Any]]) -> None:
        self._upsert_called = True
        # Snapshot content_hash INSIDE the upsert call — this is the crash window.
        # If a SIGKILL fires here, whatever content_hash is in the DB is what
        # persists; the subsequent _set_doc_content_hash call never runs.
        conn = sqlite3.connect(self.sqlite_path)
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute("SELECT content_hash FROM documents LIMIT 1").fetchone()
            # Stays None if no row exists yet (first-time index, brand-new doc).
            self.content_hash_at_upsert = row["content_hash"] if row else None
        finally:
            conn.close()
        self.rows.extend(rows)

    def search(self, vector: List[float], top_k: int = 20) -> List[Dict[str, Any]]:
        return []

    def delete_by_chunk_ids(self, chunk_ids: List[str]) -> None:
        self.rows = [r for r in self.rows if r["chunk_id"] not in chunk_ids]


def test_crash_window_content_hash_set_only_after_lance_success(
    tmp_path: Path, fixture_md: Path
) -> None:
    """Ordering invariant: content_hash must be NULL in the DB during the lance
    upsert, and non-NULL only after the upsert returns successfully.

    This proves the crash-window fix: a SIGKILL between Step 5 (sqlite commit)
    and the completion of Step 6 (lance + _set_doc_content_hash UPDATE) leaves
    content_hash=NULL. The short-circuit treats NULL as 'changed' and forces a
    full re-embed on the next reindex, self-healing the missing vectors.

    WITHOUT the fix (_persist_sqlite writes content_hash eagerly in Step 5),
    this test fails because content_hash_at_upsert is non-NULL.
    """
    probe = _OrderingProbeVectorStore(str(tmp_path / "fts5.sqlite"))
    embed = _CountingEmbeddingClient()
    indexer = LocalIndexer(
        workspace=str(tmp_path / "workspace"),
        sqlite_path=str(tmp_path / "fts5.sqlite"),
        lance_path=str(tmp_path / "vectors.lance"),
        openai_api_key="sk-test",
        embedding_client=embed,
        vector_store=probe,
    )

    result = indexer.index_file(str(fixture_md), mode="md")
    assert result.status == "indexed"
    assert result.content_state == "ok"
    assert embed.corpus_calls == 1
    assert probe._upsert_called, "probe upsert must have been invoked"

    # THE KEY ASSERTION: content_hash must be NULL inside the crash window
    # (during the lance upsert call). Without the fix it would be non-NULL here.
    assert probe.content_hash_at_upsert is None, (
        "content_hash must be NULL during lance upsert (Step 5 must not write it). "
        "A SIGKILL here would leave content_hash=NULL, forcing a reindex on next run."
    )

    # After full success both sqlite and lance are committed and content_hash is set.
    row = _doc_row(indexer.sqlite_path, result.doc_id)
    assert row["content_hash"] is not None, (
        "content_hash must be set after the full index (lance success + UPDATE)"
    )

    # Sanity: a touch still short-circuits now that content_hash is in place.
    _touch(fixture_md)
    second = indexer.reindex(str(fixture_md), mode="md")
    assert second.unchanged is True
    assert embed.corpus_calls == 1, "no new embed after successful short-circuit"
