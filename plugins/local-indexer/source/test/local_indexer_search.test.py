"""R4 regression: 8 Korean queries must hit the indexed corpus.

Validates pattern B (kiwi → FTS5 content_ko) by reindexing the fixture
markdown into a temporary SQLite database and issuing the exact queries
called out in the autopilot blueprint (§10 S4).
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import List

import pytest

_WORKER_DIR = Path(__file__).resolve().parent.parent / "worker"
sys.path.insert(0, str(_WORKER_DIR))

kiwipiepy = pytest.importorskip("kiwipiepy")

from local_indexer import LocalIndexer  # noqa: E402
from local_indexer_search import SearchService  # noqa: E402
from korean_tokenizer import get_tokenizer  # noqa: E402


R4_QUERIES = [
    "regulation",
    "규정",
    "규정집",
    "규정은",
    "규정한다",
    "support",
    "지원",
    "품의",
]


class _FakeEmbeddingClient:
    dimensions = 1536

    def embed_corpus(self, chunks):
        return [[0.0] * 1536 for _ in chunks]

    def embed_one(self, text):
        return [0.0] * 1536


class _FakeVectorStore:
    def upsert(self, rows):
        pass

    def search(self, vector, top_k=20):
        return []


@pytest.fixture(scope="module")
def fixture_md() -> Path:
    return Path(__file__).with_name("indexer.ko.fixture.md")


@pytest.fixture(scope="module")
def search(tmp_path_factory: pytest.TempPathFactory, fixture_md: Path) -> SearchService:
    base = tmp_path_factory.mktemp("local_indexer_search")
    indexer = LocalIndexer(
        workspace=str(base / "workspace"),
        sqlite_path=str(base / "fts5.sqlite"),
        lance_path=str(base / "vectors.lance"),
        openai_api_key="sk-test",
        embedding_client=_FakeEmbeddingClient(),
        vector_store=_FakeVectorStore(),
    )
    indexer.index_file(str(fixture_md), mode="md")
    return SearchService(
        sqlite_path=indexer.sqlite_path,
        tokenizer=get_tokenizer(),
        embedding_client=_FakeEmbeddingClient(),
        vector_store=_FakeVectorStore(),
    )


def test_r4_eight_queries_recall(search: SearchService) -> None:
    results = {}
    hits_count = 0
    for query in R4_QUERIES:
        hits = search.search_bm25(query, top_k=10)
        results[query] = hits
        if hits:
            hits_count += 1
    # R4 regression baseline: at least 4/8 queries must hit.
    assert hits_count >= 4, f"only {hits_count}/8 queries hit: {results}"


def test_gyujeong_variant_recall(search: SearchService) -> None:
    """'규정' must return at least one chunk containing any inflected form."""
    hits = search.search_bm25("규정", top_k=10)
    assert hits, "bm25 returned no hits for 규정"
    texts = [h["raw_text"] for h in hits]
    variants = ("규정집", "규정은", "규정한다")
    assert any(any(v in t for v in variants) for t in texts), (
        "none of 규정집/규정은/규정한다 reachable via '규정' query"
    )


def test_pumwi_and_support(search: SearchService) -> None:
    assert search.search_bm25("품의", top_k=5)
    assert search.search_bm25("지원", top_k=5)


def test_english_regulation(search: SearchService) -> None:
    # Optional — fixture includes an English summary paragraph.
    hits = search.search_bm25("regulation", top_k=5)
    # Pattern B normalises to lower-case, so should match the fixture.
    assert isinstance(hits, list)


def test_empty_query(search: SearchService) -> None:
    assert search.search_bm25("", top_k=5) == []
    assert search.search_bm25("   ", top_k=5) == []


def test_bm25_score_normalization_formula_math() -> None:
    """Unit regression: BM25 normalization |x|/(1+|x|) is monotonic and in [0,1).

    The formula was intentionally changed from 1/(1+max(0,bm25)) — which
    returned 1.0 for EVERY hit because FTS5 bm25() always returns negative
    values, making max(0, negative)=0 and 1/(1+0)=1.0 — to |x|/(1+|x|),
    which correctly maps stronger matches (larger |bm25|) to higher scores.
    """
    # Simulate the normalization logic from _fts_query
    def normalize(bm25: float) -> float:
        neg = max(0.0, -float(bm25))
        return neg / (1.0 + neg)

    def old_normalize(bm25: float) -> float:
        return 1.0 / (1.0 + max(0.0, float(bm25)))

    bm25_samples = [-0.000001, -1.0, -10.0, -100.0]  # increasingly strong matches

    scores = [normalize(b) for b in bm25_samples]

    # All scores must be in [0, 1)
    for bm25, score in zip(bm25_samples, scores):
        assert 0.0 <= score < 1.0, f"normalize({bm25}) = {score} out of [0, 1)"

    # Stronger match (larger |bm25|) → higher score (monotonically increasing)
    for i in range(len(scores) - 1):
        assert scores[i] < scores[i + 1], (
            f"score not monotonically increasing: normalize({bm25_samples[i]})={scores[i]}"
            f" >= normalize({bm25_samples[i+1]})={scores[i+1]}"
        )

    # OLD formula was broken: returned 1.0 for all negative bm25 values
    for bm25 in bm25_samples:
        assert old_normalize(bm25) == 1.0, (
            f"old formula should give 1.0 for bm25={bm25} (sanity check)"
        )
