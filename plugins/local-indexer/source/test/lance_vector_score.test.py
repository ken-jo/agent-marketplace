"""Vector score polarity + cosine metric for the LanceDB store.

These tests exercise the pure ``_normalize_distance_to_score`` helper and
the ``_LanceVectorStore.search`` distance→score mapping without requiring
the ``lancedb`` dependency: ``search`` is driven by a fake table whose
query builder records the declared metric and replays canned ``_distance``
rows.
"""

from __future__ import annotations

import sys
from pathlib import Path

_WORKER_DIR = Path(__file__).resolve().parent.parent / "worker"
sys.path.insert(0, str(_WORKER_DIR))

from local_indexer import _LanceVectorStore, _normalize_distance_to_score  # noqa: E402


def test_normalize_distance_to_score_polarity() -> None:
    # Zero distance is a perfect match → top score of 1.0.
    assert _normalize_distance_to_score(0.0) == 1.0
    # Closer (smaller distance) outranks farther.
    assert _normalize_distance_to_score(0.5) > _normalize_distance_to_score(1.5)
    # Strictly decreasing across increasing distance.
    vals = [_normalize_distance_to_score(d) for d in (0.0, 0.5, 1.0, 2.0, 5.0)]
    assert all(vals[i] > vals[i + 1] for i in range(len(vals) - 1))
    # Bounded to (0, 1].
    assert all(0.0 < v <= 1.0 for v in vals)
    # Negative distances clamp to 0 → score 1.0 (no blow-up past 1).
    assert _normalize_distance_to_score(-1.0) == 1.0


class _FakeQuery:
    def __init__(self, rows, recorded) -> None:
        self._rows = rows
        self._recorded = recorded

    def metric(self, m):  # noqa: ANN001
        self._recorded["metric"] = m
        return self

    def limit(self, n):  # noqa: ANN001
        self._recorded["limit"] = n
        return self

    def to_list(self):
        return self._rows


class _FakeTable:
    def __init__(self, rows, recorded) -> None:
        self._rows = rows
        self._recorded = recorded

    def search(self, vector):  # noqa: ANN001
        self._recorded["vector"] = vector
        return _FakeQuery(self._rows, self._recorded)


def _make_store(rows, recorded) -> _LanceVectorStore:
    # Bypass __init__ (which imports lancedb) and inject a fake table.
    store = object.__new__(_LanceVectorStore)
    store._table = _FakeTable(rows, recorded)  # type: ignore[attr-defined]
    return store


def test_search_declares_cosine_metric_and_normalizes_distance() -> None:
    recorded: dict = {}
    rows = [
        {"chunk_id": "near", "_distance": 0.0},
        {"chunk_id": "far", "_distance": 1.0},
    ]
    store = _make_store(rows, recorded)

    results = store.search([0.1, 0.2, 0.3], top_k=5)

    # cosine metric declared at query time.
    assert recorded["metric"] == "cosine"
    assert recorded["limit"] == 5
    # Distance normalised with correct polarity (closer = higher score).
    assert results[0]["chunk_id"] == "near"
    assert results[0]["score"] == _normalize_distance_to_score(0.0)
    assert results[1]["score"] == _normalize_distance_to_score(1.0)
    assert results[0]["score"] > results[1]["score"]


def test_search_without_distance_uses_score_without_double_normalize() -> None:
    recorded: dict = {}
    rows = [{"chunk_id": "pre", "score": 0.42}]
    store = _make_store(rows, recorded)

    results = store.search([0.0], top_k=3)

    # Pre-scored row (no _distance) is trusted as-is, not re-normalized.
    assert results[0]["score"] == 0.42
