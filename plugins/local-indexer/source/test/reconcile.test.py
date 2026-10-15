"""Pytest for LocalIndexer.reconcile — boot SQLite↔LanceDB drift heal.

Covers the crash signature P1 item 7a narrows but cannot fully close: a
SIGKILL/OOM/power-loss between index_file's sqlite commit (Step 5, which writes
content_state='ok' + embeddings_meta) and the Lance upsert (Step 6) leaves
embeddings_meta rows whose chunk_id has NO Lance vector. reconcile detects and
heals this bidirectionally.
"""

from __future__ import annotations

import sqlite3
import sys
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

_WORKER_DIR = Path(__file__).resolve().parent.parent / "worker"
sys.path.insert(0, str(_WORKER_DIR))

kiwipiepy = pytest.importorskip("kiwipiepy")

from local_indexer import LocalIndexer  # noqa: E402


class _FakeEmbeddingClient:
    def __init__(self) -> None:
        self.dimensions = 1536

    def embed_corpus(self, chunks: List[str]) -> List[List[float]]:
        return [[0.01] * 1536 for _ in chunks]

    def embed_one(self, text: str) -> List[float]:
        return [0.01] * 1536


class _EmptyEmbeddingClient:
    """Embeds nothing — drives the honest embed_failed path (no embeddings_meta)."""

    def __init__(self) -> None:
        self.dimensions = 1536

    def embed_corpus(self, chunks: List[str]) -> List[List[float]]:
        return []

    def embed_one(self, text: str) -> List[float]:
        return [0.01] * 1536


class _FakeVectorStore:
    """In-memory stand-in mirroring the _LanceVectorStore duck-type that
    reconcile depends on: upsert / delete_by_chunk_ids / count_rows /
    list_chunk_ids."""

    def __init__(self) -> None:
        self.rows: List[Dict[str, Any]] = []
        # Set to True by the test when you want to assert the fast-path fired
        # (i.e. list_chunk_ids was never called because counts matched).
        self._list_chunk_ids_call_count: int = 0

    def upsert(self, rows: List[Dict[str, Any]]) -> None:
        incoming = {r["chunk_id"] for r in rows}
        # mirror real upsert delete+add semantics so repeats don't duplicate
        self.rows = [r for r in self.rows if r["chunk_id"] not in incoming]
        self.rows.extend(rows)

    def delete_by_chunk_ids(self, chunk_ids: List[str]) -> None:
        drop = set(chunk_ids)
        self.rows = [r for r in self.rows if r["chunk_id"] not in drop]

    def count_rows(self) -> int:
        return len(self.rows)

    def list_chunk_ids(self) -> "set[str]":
        self._list_chunk_ids_call_count += 1
        return {r["chunk_id"] for r in self.rows}

    def search(self, vector: List[float], top_k: int = 20) -> List[Dict[str, Any]]:
        return []


@pytest.fixture
def fixture_md() -> Path:
    return Path(__file__).with_name("indexer.ko.fixture.md")


def _make_indexer(
    tmp_path: Path,
    *,
    embedding_client: Optional[Any],
    vector_store: _FakeVectorStore,
    api_key: str = "sk-test",
) -> LocalIndexer:
    return LocalIndexer(
        workspace=str(tmp_path / "workspace"),
        sqlite_path=str(tmp_path / "fts5.sqlite"),
        lance_path=str(tmp_path / "vectors.lance"),
        openai_api_key=api_key,
        embedding_client=embedding_client,
        vector_store=vector_store,
    )


def _read_doc(indexer: LocalIndexer, doc_id: str) -> sqlite3.Row:
    conn = sqlite3.connect(indexer.sqlite_path)
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute(
            "SELECT content_hash, content_state, status FROM documents WHERE doc_id = ?",
            (doc_id,),
        ).fetchone()
    finally:
        conn.close()


def _meta_chunk_ids(indexer: LocalIndexer) -> "set[str]":
    conn = sqlite3.connect(indexer.sqlite_path)
    try:
        rows = conn.execute("SELECT chunk_id FROM embeddings_meta").fetchall()
    finally:
        conn.close()
    return {r[0] for r in rows}


# ----------------------------------------------------------------------
# Crash recovery — the load-bearing test.
# ----------------------------------------------------------------------
def test_reconcile_heals_meta_without_vector(tmp_path: Path, fixture_md: Path) -> None:
    store = _FakeVectorStore()
    indexer = _make_indexer(tmp_path, embedding_client=_FakeEmbeddingClient(), vector_store=store)

    result = indexer.index_file(str(fixture_md), mode="md")
    assert result.status == "indexed"
    assert result.chunk_count > 0
    # Healthy baseline: every embeddings_meta chunk_id has a Lance vector.
    assert _meta_chunk_ids(indexer) == store.list_chunk_ids()
    assert store.list_chunk_ids(), "baseline must have vectors"
    # After a clean index content_hash is set + content_state='ok'.
    pre = _read_doc(indexer, result.doc_id)
    assert pre["content_hash"] is not None
    assert pre["content_state"] == "ok"

    # Simulate the crash: the Lance upsert was lost but the sqlite commit
    # (embeddings_meta + content_state='ok' + content_hash) survived. This is a
    # SUPERSET of the real signature (a crash leaves content_hash NULL; here it
    # is set, proving reconcile FORCES it NULL).
    store.rows.clear()
    assert store.list_chunk_ids() == set()
    assert _meta_chunk_ids(indexer), "embeddings_meta must survive the crash"

    # Detect — reconcile flags the owning doc and normalises it for re-embed.
    report = indexer.reconcile()
    assert report["checked"] is True
    assert report["drifted_doc_count"] == 1
    assert report["drifted_docs"][0]["doc_id"] == result.doc_id
    assert report["drifted_docs"][0]["path"].endswith("indexer.ko.fixture.md")
    assert report["orphan_vectors_deleted"] == 0

    marked = _read_doc(indexer, result.doc_id)
    assert marked["content_hash"] is None, "reconcile must force content_hash NULL"
    assert marked["content_state"] == "embed_failed"

    # Heal — a reindex with a key re-embeds (no short-circuit, hash is NULL).
    heal = indexer.reindex(str(fixture_md), mode="md")
    assert heal.status == "indexed"
    assert heal.unchanged is not True
    # Lance vectors restored, fully consistent with embeddings_meta again.
    assert store.list_chunk_ids() == _meta_chunk_ids(indexer)
    assert store.list_chunk_ids(), "vectors must be restored after heal"
    healed_doc = _read_doc(indexer, result.doc_id)
    assert healed_doc["content_hash"] is not None
    assert healed_doc["content_state"] == "ok"


# ----------------------------------------------------------------------
# Mutation / non-vacuous: WITHOUT reconcile the drift persists.
# ----------------------------------------------------------------------
def test_without_reconcile_drift_persists(tmp_path: Path, fixture_md: Path) -> None:
    store = _FakeVectorStore()
    indexer = _make_indexer(tmp_path, embedding_client=_FakeEmbeddingClient(), vector_store=store)

    result = indexer.index_file(str(fixture_md), mode="md")
    assert store.list_chunk_ids()

    # Crash: vectors lost, but content_hash stays set + content_state='ok'.
    store.rows.clear()
    assert store.list_chunk_ids() == set()

    # No reconcile. A normal mtime-triggered reindex of unchanged content hits
    # the Step 3.5 short-circuit (hash matches, state 'ok') → embedding skipped →
    # the vector STAYS missing. This is exactly the residual bug reconcile fixes;
    # asserting it proves reconcile's content_hash NULL'ing is load-bearing.
    again = indexer.reindex(str(fixture_md), mode="md")
    assert again.unchanged is True, "short-circuit must fire without reconcile"
    assert store.list_chunk_ids() == set(), "drift persists without reconcile"
    still = _read_doc(indexer, result.doc_id)
    assert still["content_hash"] is not None
    assert still["content_state"] == "ok"


# ----------------------------------------------------------------------
# Orphan vector (Lance chunk_id with no embeddings_meta) → deleted.
# ----------------------------------------------------------------------
def test_reconcile_deletes_orphan_vectors(tmp_path: Path, fixture_md: Path) -> None:
    store = _FakeVectorStore()
    indexer = _make_indexer(tmp_path, embedding_client=_FakeEmbeddingClient(), vector_store=store)

    indexer.index_file(str(fixture_md), mode="md")
    legit_ids = store.list_chunk_ids()
    assert legit_ids

    # Inject an orphan vector — a valid-UUID chunk_id with NO embeddings_meta row.
    orphan_id = str(uuid.uuid4())
    store.upsert([{"chunk_id": orphan_id, "doc_id": "ghost", "vector": [0.0] * 1536, "raw_text": "x"}])
    assert orphan_id in store.list_chunk_ids()

    report = indexer.reconcile()
    assert report["orphan_vectors_deleted"] == 1
    assert report["drifted_doc_count"] == 0, "legit vectors must not be flagged"
    assert orphan_id not in store.list_chunk_ids()
    # The legit vectors are untouched.
    assert legit_ids == store.list_chunk_ids()


# ----------------------------------------------------------------------
# embed_failed (honest, no embeddings_meta) → NOT a false positive.
# ----------------------------------------------------------------------
def test_reconcile_ignores_honest_embed_failed(tmp_path: Path, fixture_md: Path) -> None:
    store = _FakeVectorStore()
    indexer = _make_indexer(
        tmp_path, embedding_client=_EmptyEmbeddingClient(), vector_store=store
    )

    result = indexer.index_file(str(fixture_md), mode="md")
    assert result.status == "indexed"
    # Honest embed_failed: text indexed (BM25), zero embeddings, zero vectors.
    assert result.content_state == "embed_failed"
    assert _meta_chunk_ids(indexer) == set()
    assert store.list_chunk_ids() == set()

    report = indexer.reconcile()
    assert report["drifted_doc_count"] == 0, "embed_failed has no meta → no drift"
    assert report["orphan_vectors_deleted"] == 0
    # The doc state is untouched — still the honest embed_failed.
    row = _read_doc(indexer, result.doc_id)
    assert row["content_state"] == "embed_failed"


# ----------------------------------------------------------------------
# Key-free detect: reconcile detects + marks drift with NO embedding key,
# and never re-embeds itself (heal is the host's job, which needs the key).
# ----------------------------------------------------------------------
def test_reconcile_detect_is_key_free_and_never_embeds(tmp_path: Path, fixture_md: Path) -> None:
    store = _FakeVectorStore()
    # Keyed indexer establishes real meta + vectors.
    keyed = _make_indexer(tmp_path, embedding_client=_FakeEmbeddingClient(), vector_store=store)
    result = keyed.index_file(str(fixture_md), mode="md")
    assert store.list_chunk_ids()

    # Crash: vectors lost.
    store.rows.clear()

    # A keyless indexer over the SAME sqlite + SAME store — truly no embedding
    # client (openai provider, empty key → get_embedding_client() is None).
    keyless = _make_indexer(
        tmp_path, embedding_client=None, vector_store=store, api_key=""
    )
    assert keyless.get_embedding_client() is None

    report = keyless.reconcile()
    # Detect works WITHOUT a key.
    assert report["checked"] is True
    assert report["drifted_doc_count"] == 1
    assert report["drifted_docs"][0]["doc_id"] == result.doc_id
    # reconcile itself NEVER embeds — no vectors get restored by detect.
    assert store.list_chunk_ids() == set()
    # The doc is marked so the host can heal it once a key is pushed.
    marked = _read_doc(keyless, result.doc_id)
    assert marked["content_hash"] is None
    assert marked["content_state"] == "embed_failed"


# ----------------------------------------------------------------------
# Vector store unavailable → skip (never flag everything as drift).
# ----------------------------------------------------------------------
def test_reconcile_skips_when_vector_store_unavailable(tmp_path: Path, fixture_md: Path) -> None:
    store = _FakeVectorStore()
    indexer = _make_indexer(tmp_path, embedding_client=_FakeEmbeddingClient(), vector_store=store)
    indexer.index_file(str(fixture_md), mode="md")

    # Swap in a store with no list_chunk_ids capability → reconcile must skip.
    class _CapabilityLessStore:
        def upsert(self, rows: List[Dict[str, Any]]) -> None: ...
        def search(self, vector: List[float], top_k: int = 20) -> List[Dict[str, Any]]:
            return []

    indexer._vector_store = _CapabilityLessStore()  # type: ignore[assignment]
    report = indexer.reconcile()
    assert report["checked"] is False
    assert report["drifted_doc_count"] == 0
    assert report["orphan_vectors_deleted"] == 0


# ----------------------------------------------------------------------
# O(1) fast-path: equal meta vs lance counts → skip full id-set enumeration.
# ----------------------------------------------------------------------
def test_reconcile_fast_path_skips_enumeration_on_clean_counts(
    tmp_path: Path, fixture_md: Path
) -> None:
    """When meta count == lance count, reconcile returns clean WITHOUT calling
    list_chunk_ids() — proving the O(1) fast-path fires on a healthy index."""
    store = _FakeVectorStore()
    indexer = _make_indexer(tmp_path, embedding_client=_FakeEmbeddingClient(), vector_store=store)

    result = indexer.index_file(str(fixture_md), mode="md")
    assert result.status == "indexed"
    # After a successful index, meta and lance are consistent — counts match.
    assert len(_meta_chunk_ids(indexer)) == store.count_rows()

    # Reset the call counter so we can detect whether list_chunk_ids fires.
    store._list_chunk_ids_call_count = 0

    report = indexer.reconcile()

    assert report["checked"] is True
    assert report["drifted_doc_count"] == 0
    assert report["orphan_vectors_deleted"] == 0
    # The fast-path should have skipped the full enumeration entirely.
    assert store._list_chunk_ids_call_count == 0, (
        "list_chunk_ids was called despite equal counts — fast-path did not fire"
    )


# ----------------------------------------------------------------------
# Real _LanceVectorStore.list_chunk_ids enumerates what was upserted.
# ----------------------------------------------------------------------
def test_real_lance_store_list_chunk_ids(tmp_path: Path) -> None:
    pytest.importorskip("lancedb")
    from local_indexer import _LanceVectorStore  # noqa: E402

    store = _LanceVectorStore(str(tmp_path / "vectors.lance"), dimensions=4)
    # Empty table not yet created → empty set.
    assert store.list_chunk_ids() == set()

    # Insert 150 rows — well above any plausible default query-cap that a
    # future lancedb version might silently re-introduce.  If .limit(None) ever
    # stops working, list_chunk_ids() will return a truncated set and this
    # assertion will fail loudly, preventing silent false-positive drift reports.
    ids = [str(uuid.uuid4()) for _ in range(150)]
    store.upsert(
        [
            {"chunk_id": cid, "doc_id": "d1", "vector": [0.1, 0.2, 0.3, 0.4], "raw_text": "x"}
            for cid in ids
        ]
    )
    result = store.list_chunk_ids()
    assert result == set(ids), (
        f"list_chunk_ids returned {len(result)} ids — expected 150; "
        "a default row-cap may have been re-introduced in lancedb"
    )

    # Deleting one is reflected in the enumeration.
    store.delete_by_chunk_ids([ids[0]])
    assert store.list_chunk_ids() == set(ids[1:])
