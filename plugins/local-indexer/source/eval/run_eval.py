"""Drive the real hybrid retrieval path over the golden eval set.

This is the source-of-truth harness for every later retrieval change. It:

1. Instantiates the *real* ``LocalIndexer`` with an embedder + in-memory cosine
   store injected, plus the real Kiwi tokenizer. The embedder is selected by
   :func:`build_embedder`:
   * **offline default** — the deterministic char-trigram ``DeterministicEmbedder``
     (no API key, no network). This is what the per-PR lexical-path regression
     gate uses, so the build is hermetic and reproducible.
   * **real embeddings** — when ``EVAL_EMBEDDING_ENDPOINT`` (+
     ``EVAL_EMBEDDING_API_KEY``) is set, the *production*
     ``OpenAIEmbeddingClient`` (the worker's real ``embedding_client.py``)
     pointed at that endpoint. This is what the nightly real-embedding job uses
     to MEASURE genuine embedding/reranker quality on the corpus.
2. Indexes every corpus document under ``eval/corpus/``.
3. Builds a ``SearchService`` over the same SQLite store / embedder / vector
   store and runs each query in ``eval/queries.json`` through
   ``search_hybrid_internal`` — the genuine RRF + FTS5 + Kiwi hybrid path.
4. Maps each chunk hit back to its corpus document, then computes Recall@10
   and nDCG@10 against the authored relevance judgments, plus per-query
   latency.
5. Aggregates (macro means + p95 latency) and writes ``eval/last_run.json``.

Run directly (``python eval/run_eval.py``) to print a summary; the gate test
imports :func:`run`, injects the deterministic embedder explicitly, and asserts
against ``eval/baseline.json`` (a *lexical-path* baseline — see the gate test).
"""

from __future__ import annotations

import json
import math
import os
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

_EVAL_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _EVAL_DIR.parent
_WORKER_DIR = _REPO_ROOT / "worker"
sys.path.insert(0, str(_WORKER_DIR))
sys.path.insert(0, str(_EVAL_DIR))

from embedder import DeterministicEmbedder  # noqa: E402
from vector_store import InMemoryCosineStore  # noqa: E402
from metrics import recall_at_k, ndcg_at_k  # noqa: E402

from local_indexer import LocalIndexer  # noqa: E402
from local_indexer_search import SearchService  # noqa: E402
from korean_tokenizer import get_tokenizer  # noqa: E402

TOP_K = 10
CORPUS_DIR = _EVAL_DIR / "corpus"
QUERIES_PATH = _EVAL_DIR / "queries.json"
LAST_RUN_PATH = _EVAL_DIR / "last_run.json"

# Defaults for the REAL-embedding path (only used when EVAL_EMBEDDING_ENDPOINT
# is set). text-embedding-3-small is the plugin's current production default;
# the nightly job overrides EVAL_EMBEDDING_MODEL to benchmark alternatives.
DEFAULT_REAL_MODEL = "text-embedding-3-small"
DEFAULT_REAL_DIMENSIONS = 1536


def build_embedder() -> Tuple[Any, str]:
    """Select the embedder for an eval run from the environment.

    Returns ``(client, label)``.

    * ``EVAL_EMBEDDING_ENDPOINT`` set → the REAL ``OpenAIEmbeddingClient`` (the
      worker's production ``embedding_client.py``) is pointed at that endpoint
      so the eval measures GENUINE embedding quality. ``EVAL_EMBEDDING_API_KEY``
      supplies the key (never hard-coded), ``EVAL_EMBEDDING_MODEL`` /
      ``EVAL_EMBEDDING_PROVIDER`` / ``EVAL_EMBEDDING_DIMENSIONS`` are optional
      overrides. This path makes a real network call and costs money — it runs
      only in the nightly job (or a deliberate local measurement run).
    * unset → the offline ``DeterministicEmbedder`` (no key, no network). This
      keeps the default/offline PR gate hermetic, but it only exercises the
      LEXICAL path (Kiwi + FTS5 + RRF) — it does NOT measure embedding quality.
    """
    endpoint = os.getenv("EVAL_EMBEDDING_ENDPOINT", "").strip()
    if not endpoint:
        return DeterministicEmbedder(), "deterministic"

    # Lazy import: the real client is only needed on the measurement path, and
    # keeping it out of the deterministic path makes the hermetic gate's import
    # surface obvious.
    from embedding_client import create_embedding_client  # noqa: E402

    provider = (os.getenv("EVAL_EMBEDDING_PROVIDER", "openai").strip() or "openai")
    model = (os.getenv("EVAL_EMBEDDING_MODEL", "").strip() or DEFAULT_REAL_MODEL)
    api_key = os.getenv("EVAL_EMBEDDING_API_KEY") or None
    try:
        dimensions = int(os.getenv("EVAL_EMBEDDING_DIMENSIONS", "").strip() or DEFAULT_REAL_DIMENSIONS)
    except ValueError:
        dimensions = DEFAULT_REAL_DIMENSIONS

    client = create_embedding_client(
        provider=provider,
        model=model,
        api_key=api_key,
        endpoint=endpoint,
        dimensions=dimensions,
    )
    return client, f"real:{provider}:{model}"


def _corpus_key(filename: str) -> str:
    """``ko-001-document-management-rule.md`` -> ``ko-001`` (stable doc id)."""
    stem = Path(filename).stem
    parts = stem.split("-")
    if len(parts) >= 2:
        return f"{parts[0]}-{parts[1]}"
    return stem


def _percentile(values: List[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = math.ceil(pct / 100.0 * len(ordered)) - 1
    rank = max(0, min(rank, len(ordered) - 1))
    return ordered[rank]


def _dedupe_docs(hits: List[Dict[str, Any]], doc_id_to_key: Dict[str, str]) -> List[str]:
    """Map chunk hits -> ordered, de-duplicated corpus doc keys."""
    seen: set[str] = set()
    ordered: List[str] = []
    for hit in hits:
        key = doc_id_to_key.get(hit.get("doc_id", ""))
        if not key or key in seen:
            continue
        seen.add(key)
        ordered.append(key)
    return ordered


def run(
    embedder: Optional[Any] = None,
    store: Optional[Any] = None,
) -> Dict[str, Any]:
    """Index the corpus, run every query, return the aggregate result dict.

    ``embedder`` / ``store`` are dependency-injection seams. When ``embedder``
    is ``None`` the embedder is chosen from the environment via
    :func:`build_embedder` (deterministic offline by default; the real cloud
    client when ``EVAL_EMBEDDING_ENDPOINT`` is set). The PR lexical-path gate
    passes ``DeterministicEmbedder()`` explicitly so it is never perturbed by a
    stray ``EVAL_EMBEDDING_*`` env var.
    """
    tokenizer = get_tokenizer()
    if embedder is None:
        embedder, embedder_label = build_embedder()
    else:
        embedder_label = type(embedder).__name__
    if store is None:
        store = InMemoryCosineStore()

    with tempfile.TemporaryDirectory(prefix="retrieval-eval-") as tmp:
        base = Path(tmp)
        indexer = LocalIndexer(
            workspace=str(base / "workspace"),
            sqlite_path=str(base / "fts5.sqlite"),
            lance_path=str(base / "vectors.lance"),
            openai_api_key="",
            tokenizer=tokenizer,
            embedding_client=embedder,
            vector_store=store,
        )

        doc_id_to_key: Dict[str, str] = {}
        corpus_files = sorted(CORPUS_DIR.glob("*.md")) + sorted(CORPUS_DIR.glob("*.txt"))
        for path in corpus_files:
            result = indexer.index_file(str(path), mode="md")
            doc_id_to_key[result.doc_id] = _corpus_key(path.name)

        search = SearchService(
            sqlite_path=indexer.sqlite_path,
            tokenizer=tokenizer,
            embedding_client=embedder,
            vector_store=store,
        )

        queries = json.loads(QUERIES_PATH.read_text(encoding="utf-8"))
        per_query: List[Dict[str, Any]] = []
        recalls: List[float] = []
        ndcgs: List[float] = []
        latencies: List[float] = []

        for q in queries:
            grades = {r["doc"]: int(r["grade"]) for r in q["relevant"]}
            relevant = {doc for doc, grade in grades.items() if grade > 0}

            start = time.perf_counter()
            hits = search.search_hybrid_internal(q["query"], top_k=TOP_K)
            latency = time.perf_counter() - start

            ranked_docs = _dedupe_docs(hits, doc_id_to_key)
            recall = recall_at_k(ranked_docs, relevant, TOP_K)
            ndcg = ndcg_at_k(ranked_docs, grades, TOP_K)

            recalls.append(recall)
            ndcgs.append(ndcg)
            latencies.append(latency)
            per_query.append(
                {
                    "id": q["id"],
                    "lang": q["lang"],
                    "recall@10": round(recall, 4),
                    "ndcg@10": round(ndcg, 4),
                    "latency_s": round(latency, 6),
                    "retrieved": ranked_docs,
                    "relevant": sorted(relevant),
                }
            )

    n = len(queries)
    result = {
        "corpus_size": len(corpus_files),
        "query_count": n,
        "top_k": TOP_K,
        "embedder": embedder_label,
        "recall@10": round(sum(recalls) / n, 4) if n else 0.0,
        "ndcg@10": round(sum(ndcgs) / n, 4) if n else 0.0,
        "p95_latency_s": round(_percentile(latencies, 95.0), 6),
        "mean_latency_s": round(sum(latencies) / n, 6) if n else 0.0,
        "per_query": per_query,
    }
    return result


def main() -> None:
    result = run()
    LAST_RUN_PATH.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(
        "embedder={embedder} corpus={corpus_size} queries={query_count} "
        "recall@10={recall} ndcg@10={ndcg} p95={p95:.4f}s".format(
            embedder=result["embedder"],
            corpus_size=result["corpus_size"],
            query_count=result["query_count"],
            recall=result["recall@10"],
            ndcg=result["ndcg@10"],
            p95=result["p95_latency_s"],
        )
    )
    print(f"wrote {LAST_RUN_PATH.relative_to(_REPO_ROOT)}")


if __name__ == "__main__":
    main()
