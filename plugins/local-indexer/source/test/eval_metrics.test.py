"""Unit tests for the pure ranking-metric functions (eval/metrics.py)."""

from __future__ import annotations

import math
import sys
from pathlib import Path

_EVAL_DIR = Path(__file__).resolve().parent.parent / "eval"
sys.path.insert(0, str(_EVAL_DIR))

from metrics import recall_at_k, ndcg_at_k  # noqa: E402


# ----------------------------------------------------------------------
# recall_at_k
# ----------------------------------------------------------------------
def test_recall_perfect() -> None:
    assert recall_at_k(["a", "b", "c"], {"a", "b"}, 10) == 1.0


def test_recall_partial() -> None:
    # 1 of 2 relevant docs retrieved.
    assert recall_at_k(["a", "x", "y"], {"a", "b"}, 10) == 0.5


def test_recall_k_truncates() -> None:
    # Relevant doc sits at rank 3 but k=2, so it is not counted.
    assert recall_at_k(["x", "y", "a"], {"a"}, 2) == 0.0


def test_recall_empty_relevant_is_zero() -> None:
    assert recall_at_k(["a", "b"], set(), 10) == 0.0


def test_recall_empty_retrieved() -> None:
    assert recall_at_k([], {"a"}, 10) == 0.0


# ----------------------------------------------------------------------
# ndcg_at_k
# ----------------------------------------------------------------------
def test_ndcg_perfect_ranking_is_one() -> None:
    grades = {"a": 3, "b": 2, "c": 1}
    assert ndcg_at_k(["a", "b", "c"], grades, 10) == 1.0


def test_ndcg_empty_relevant_is_zero() -> None:
    assert ndcg_at_k(["a", "b"], {}, 10) == 0.0


def test_ndcg_no_relevant_retrieved_is_zero() -> None:
    assert ndcg_at_k(["x", "y"], {"a": 3}, 10) == 0.0


def test_ndcg_reversed_known_value() -> None:
    """Reversed ranking of three graded docs yields a known nDCG.

    Grades a=3,b=2,c=1 → gains 2**g-1 = {a:7, b:3, c:1}.
    Reversed retrieval [c, b, a] →
        DCG  = 1/log2(2) + 3/log2(3) + 7/log2(4)
             = 1 + 1.8927892607 + 3.5 = 6.3927892607
    Ideal [a, b, c] →
        IDCG = 7/log2(2) + 3/log2(3) + 1/log2(4)
             = 7 + 1.8927892607 + 0.5 = 9.3927892607
    nDCG = 6.3927892607 / 9.3927892607 ≈ 0.680603.
    """
    grades = {"a": 3, "b": 2, "c": 1}
    dcg = 1.0 / math.log2(2) + 3.0 / math.log2(3) + 7.0 / math.log2(4)
    idcg = 7.0 / math.log2(2) + 3.0 / math.log2(3) + 1.0 / math.log2(4)
    expected = dcg / idcg
    assert ndcg_at_k(["c", "b", "a"], grades, 10) == expected
    assert abs(expected - 0.680603) < 1e-5


def test_ndcg_in_unit_interval() -> None:
    grades = {"a": 3, "b": 1}
    value = ndcg_at_k(["b", "x", "a"], grades, 10)
    assert 0.0 <= value <= 1.0
