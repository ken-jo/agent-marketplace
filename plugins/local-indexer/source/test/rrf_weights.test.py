"""Sprint 3-C: RRF weight tuning — different weights rerank results."""

from __future__ import annotations

import sys
from pathlib import Path

_WORKER = Path(__file__).resolve().parent.parent / "worker"
sys.path.insert(0, str(_WORKER))

from local_indexer_search import _reciprocal_rank_fusion  # noqa: E402


def _bm25(chunks: list[str]) -> list[dict]:
    return [
        {"chunk_id": c, "doc_id": "d", "doc_name": "d", "raw_text": "", "source": "bm25"}
        for c in chunks
    ]


def _vec(chunks: list[str]) -> list[dict]:
    return [
        {"chunk_id": c, "doc_id": "d", "doc_name": "d", "raw_text": "", "source": "vector"}
        for c in chunks
    ]


def test_equal_weights_baseline() -> None:
    bm = _bm25(["A", "B", "C"])
    vec = _vec(["C", "B", "A"])
    fused = _reciprocal_rank_fusion([bm, vec], k=60)
    # With symmetric inputs and equal weights, A and C score identically
    # (1/61 + 1/63) and B trails (2/62). Verify all three chunks returned.
    ids = {f["chunk_id"] for f in fused}
    assert ids == {"A", "B", "C"}
    # B's RRF score should be strictly less than A's under equal weights.
    scores = {f["chunk_id"]: f["score"] for f in fused}
    assert scores["A"] > scores["B"]


def test_bm25_heavy_prefers_bm25_top() -> None:
    bm = _bm25(["A", "B", "C"])
    vec = _vec(["C", "B", "A"])
    fused = _reciprocal_rank_fusion(
        [bm, vec], k=60, rrf_weights={"bm25": 10.0, "vector": 1.0}
    )
    assert [f["chunk_id"] for f in fused][0] == "A"


def test_vector_heavy_prefers_vector_top() -> None:
    bm = _bm25(["A", "B", "C"])
    vec = _vec(["C", "B", "A"])
    fused = _reciprocal_rank_fusion(
        [bm, vec], k=60, rrf_weights={"bm25": 1.0, "vector": 10.0}
    )
    assert [f["chunk_id"] for f in fused][0] == "C"


def test_unknown_source_defaults_to_one() -> None:
    bm = _bm25(["A"])
    vec = _vec(["A"])
    # No weights provided — both contribute with weight 1.0
    fused = _reciprocal_rank_fusion([bm, vec], k=60)
    assert len(fused) == 1
    assert fused[0]["source"] == "hybrid"
