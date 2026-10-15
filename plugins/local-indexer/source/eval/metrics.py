"""Pure ranking-metric functions for the retrieval eval gate.

Both functions operate on a *ranked list of document ids* (most relevant
first) and the per-query relevance judgments authored in ``queries.json``.
They are intentionally dependency-free and side-effect-free so they can be
unit-tested in isolation and reused by ``run_eval.py``.
"""

from __future__ import annotations

import math
from typing import Iterable, Mapping, Sequence, Set


def recall_at_k(
    retrieved: Sequence[str],
    relevant: Iterable[str],
    k: int,
) -> float:
    """Fraction of relevant docs that appear in the top-``k`` retrieved.

    ``relevant`` is the set of doc ids with grade > 0. Returns 0.0 when there
    are no relevant docs (an undefined recall is reported as 0, never 1).
    """
    relevant_set: Set[str] = set(relevant)
    if not relevant_set:
        return 0.0
    top = retrieved[:k]
    hit = sum(1 for doc in relevant_set if doc in top)
    return hit / len(relevant_set)


def _dcg(gains: Sequence[float]) -> float:
    """Discounted cumulative gain for an ordered list of gains (rank 1..n)."""
    total = 0.0
    for index, gain in enumerate(gains):
        # rank = index + 1; discount = log2(rank + 1) = log2(index + 2)
        total += gain / math.log2(index + 2)
    return total


def ndcg_at_k(
    retrieved: Sequence[str],
    relevant_grades: Mapping[str, int],
    k: int,
) -> float:
    """Normalized DCG@k with exponential gain ``2**grade - 1``.

    ``relevant_grades`` maps doc id -> graded relevance (0-3). Returns 0.0 when
    the ideal DCG is 0 (no graded-relevant docs), matching the recall
    convention for an undefined metric.
    """
    top = retrieved[:k]
    gains = [float(2 ** relevant_grades.get(doc, 0) - 1) for doc in top]
    dcg = _dcg(gains)

    ideal_gains = sorted(
        (float(2 ** grade - 1) for grade in relevant_grades.values()),
        reverse=True,
    )
    idcg = _dcg(ideal_gains[:k])
    if idcg == 0.0:
        return 0.0
    return dcg / idcg


__all__ = ["recall_at_k", "ndcg_at_k"]
