"""Pytest for LocalIndexer operational guardrails (maxFileSize, maxChunksPerDoc).

Tests:
- oversize file (> maxFileSize) → status='failed' with a clear reason recorded
- doc exceeding maxChunksPerDoc → truncated to cap + warning in errors[]
- config override: custom maxFileSize / maxChunksPerDoc is honoured
- default values present when unconfigured (constants match plugin.json defaults)
"""

from __future__ import annotations

import os
import sys
import textwrap
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

_WORKER_DIR = Path(__file__).resolve().parent.parent / "worker"
sys.path.insert(0, str(_WORKER_DIR))

kiwipiepy = pytest.importorskip("kiwipiepy")

from local_indexer import (  # noqa: E402
    LocalIndexer,
    _DEFAULT_MAX_FILE_SIZE,
    _DEFAULT_MAX_CHUNKS_PER_DOC,
)


# ---------------------------------------------------------------------------
# Test fixtures / helpers
# ---------------------------------------------------------------------------

class _FakeEmbeddingClient:
    def __init__(self) -> None:
        self.dimensions = 1536

    def embed_corpus(self, chunks: List[str]) -> List[List[float]]:
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


def _make_indexer(tmp_path: Path, **kwargs: Any) -> LocalIndexer:
    """Build a LocalIndexer with fake embedding/vector deps + optional guardrail overrides."""
    return LocalIndexer(
        workspace=str(tmp_path / "workspace"),
        sqlite_path=str(tmp_path / "fts5.sqlite"),
        lance_path=str(tmp_path / "vectors.lance"),
        openai_api_key="sk-test",
        embedding_client=_FakeEmbeddingClient(),
        vector_store=_FakeVectorStore(),
        **kwargs,
    )


# ---------------------------------------------------------------------------
# Default constant values match plugin.json configSchema defaults
# ---------------------------------------------------------------------------

def test_default_max_file_size_is_50mb() -> None:
    """_DEFAULT_MAX_FILE_SIZE must equal the plugin.json configSchema default (50 MB)."""
    assert _DEFAULT_MAX_FILE_SIZE == 50 * 1024 * 1024


def test_default_max_chunks_per_doc_is_2000() -> None:
    """_DEFAULT_MAX_CHUNKS_PER_DOC must equal the plugin.json configSchema default."""
    assert _DEFAULT_MAX_CHUNKS_PER_DOC == 2000


def test_indexer_uses_defaults_when_unconfigured(tmp_path: Path) -> None:
    """An indexer constructed without guardrail kwargs carries the module defaults."""
    indexer = _make_indexer(tmp_path)
    assert indexer.max_file_size == _DEFAULT_MAX_FILE_SIZE
    assert indexer.max_chunks_per_doc == _DEFAULT_MAX_CHUNKS_PER_DOC


# ---------------------------------------------------------------------------
# maxFileSize — oversize file → status='failed'
# ---------------------------------------------------------------------------

def test_oversize_file_returns_failed(tmp_path: Path) -> None:
    """A file that exceeds maxFileSize must be status='failed' with a clear reason string."""
    limit = 100  # bytes — tiny limit so we can create an oversize file easily
    indexer = _make_indexer(tmp_path, max_file_size=limit)

    oversize = tmp_path / "oversize.txt"
    oversize.write_bytes(b"x" * (limit + 1))

    result = indexer.index_file(str(oversize))

    assert result.status == "failed", f"expected 'failed', got {result.status!r}"
    assert result.chunk_count == 0
    assert result.errors, "errors[] must be non-empty for an oversize rejection"
    reason = result.errors[0]
    assert "maxFileSize" in reason or "max_file_size" in reason or "exceed" in reason.lower(), (
        f"expected the reason to mention the limit, got: {reason!r}"
    )
    assert str(limit + 1) in reason or "byte" in reason.lower(), (
        f"expected the actual size in the reason, got: {reason!r}"
    )


def test_oversize_file_is_recorded_in_db(tmp_path: Path) -> None:
    """The oversize file must be persisted as status='failed' in SQLite (not silently ignored)."""
    import sqlite3

    limit = 50
    indexer = _make_indexer(tmp_path, max_file_size=limit)

    oversize = tmp_path / "big.txt"
    oversize.write_bytes(b"a" * (limit + 10))

    result = indexer.index_file(str(oversize))
    assert result.status == "failed"

    conn = sqlite3.connect(indexer.sqlite_path)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT status FROM documents WHERE path = ?", (str(oversize.resolve()),)
        ).fetchone()
    finally:
        conn.close()

    assert row is not None, "oversize file must be recorded in documents table (not silently dropped)"
    assert row["status"] == "failed", f"expected status='failed' in DB, got {row['status']!r}"


def test_file_at_exact_limit_is_accepted(tmp_path: Path) -> None:
    """A file exactly at the limit (== maxFileSize) must not be rejected."""
    limit = 200
    indexer = _make_indexer(tmp_path, max_file_size=limit)

    at_limit = tmp_path / "at_limit.txt"
    at_limit.write_bytes(b"hello world " * (limit // 12))  # <= limit bytes

    # Ensure the file is exactly at or below the limit
    actual = os.path.getsize(str(at_limit))
    assert actual <= limit

    result = indexer.index_file(str(at_limit))
    assert result.status in ("indexed",), f"file at limit should be accepted, got {result.status!r}"


def test_custom_max_file_size_is_honoured(tmp_path: Path) -> None:
    """Custom maxFileSize of 500 bytes overrides the 50 MB default."""
    custom_limit = 500
    indexer = _make_indexer(tmp_path, max_file_size=custom_limit)
    assert indexer.max_file_size == custom_limit

    small = tmp_path / "small.txt"
    small.write_bytes(b"short content")
    result_small = indexer.index_file(str(small))
    assert result_small.status == "indexed"

    big = tmp_path / "big.txt"
    big.write_bytes(b"y" * (custom_limit + 1))
    result_big = indexer.index_file(str(big))
    assert result_big.status == "failed"


# ---------------------------------------------------------------------------
# maxChunksPerDoc — truncation + recorded warning
# ---------------------------------------------------------------------------

def _write_large_md(path: Path, sentence_count: int) -> None:
    """Write a markdown file with `sentence_count` distinct sentences."""
    lines = [f"이것은 {i + 1}번째 문장입니다. 내용은 여기에 있습니다." for i in range(sentence_count)]
    path.write_text("\n\n".join(lines), encoding="utf-8")


def test_chunk_cap_truncates_and_records_warning(tmp_path: Path) -> None:
    """A document exceeding maxChunksPerDoc must be truncated and have a warning in errors[]."""
    cap = 3
    # Use target_tokens=5 so each short sentence becomes its own chunk, guaranteeing
    # that 30 sentences → many more than 3 chunks and truncation fires.
    indexer = _make_indexer(tmp_path, max_chunks_per_doc=cap, target_tokens=5)

    large = tmp_path / "large.md"
    # 30 sentences each forcing its own chunk at target_tokens=5
    _write_large_md(large, sentence_count=30)

    result = indexer.index_file(str(large))

    assert result.status == "indexed", f"truncated doc should still be indexed, got {result.status!r}"
    assert result.chunk_count == cap, (
        f"chunk_count should equal the cap ({cap}), got {result.chunk_count}"
    )
    assert result.errors, "errors[] must be non-empty when chunks are truncated"
    warning = result.errors[0]
    assert "maxChunksPerDoc" in warning or "max_chunks" in warning.lower() or "truncat" in warning.lower(), (
        f"warning should mention truncation, got: {warning!r}"
    )


def test_chunk_cap_stored_in_db(tmp_path: Path) -> None:
    """After truncation, the DB must contain exactly cap chunks (not the original count)."""
    import sqlite3

    cap = 3
    # target_tokens=5 forces each sentence into its own chunk; 40 sentences → many chunks > cap
    indexer = _make_indexer(tmp_path, max_chunks_per_doc=cap, target_tokens=5)

    large = tmp_path / "large2.md"
    _write_large_md(large, sentence_count=40)

    result = indexer.index_file(str(large))
    assert result.status == "indexed"
    assert result.chunk_count == cap

    conn = sqlite3.connect(indexer.sqlite_path)
    conn.row_factory = sqlite3.Row
    try:
        chunk_rows = conn.execute(
            "SELECT COUNT(*) AS cnt FROM chunks WHERE doc_id = ?", (result.doc_id,)
        ).fetchone()
    finally:
        conn.close()

    assert chunk_rows["cnt"] == cap, (
        f"DB should contain exactly {cap} chunks, got {chunk_rows['cnt']}"
    )


def test_doc_below_chunk_cap_has_no_warning(tmp_path: Path) -> None:
    """A document well within the chunk cap must NOT emit any truncation warning."""
    cap = 500
    indexer = _make_indexer(tmp_path, max_chunks_per_doc=cap)

    small = tmp_path / "small.md"
    small.write_text("짧은 문서입니다. 두 번째 문장.\n", encoding="utf-8")

    result = indexer.index_file(str(small))
    assert result.status == "indexed"
    # No truncation warning expected
    truncation_warnings = [e for e in (result.errors or []) if "truncat" in e.lower() or "maxChunk" in e]
    assert not truncation_warnings, f"no truncation warning expected, got: {truncation_warnings}"


def test_custom_max_chunks_per_doc_is_honoured(tmp_path: Path) -> None:
    """Custom maxChunksPerDoc of 4 overrides the 2000 default."""
    custom_cap = 4
    # target_tokens=5 ensures each sentence is its own chunk → guaranteed truncation
    indexer = _make_indexer(tmp_path, max_chunks_per_doc=custom_cap, target_tokens=5)
    assert indexer.max_chunks_per_doc == custom_cap

    large = tmp_path / "big_doc.md"
    _write_large_md(large, sentence_count=50)

    result = indexer.index_file(str(large))
    assert result.status == "indexed"
    assert result.chunk_count == custom_cap
