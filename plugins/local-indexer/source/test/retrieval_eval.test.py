"""Retrieval LEXICAL-PATH regression guard — the per-PR gate.

⚠️  SCOPE — READ BEFORE CITING ANY NUMBER FROM THIS GATE:
This gate runs the hybrid search path (RRF + FTS5 + Kiwi) with the OFFLINE
``DeterministicEmbedder`` (a fixed char-trigram bag-of-words, NOT a real
embedding model). It therefore measures ONLY the LEXICAL retrieval path and
catches Kiwi-tokenizer / FTS5-index / RRF-fusion regressions. It DOES NOT
measure embedding, reranker, or OCR quality — its Recall@10 / nDCG@10 say
nothing about whether a better embedding model helps. (This exact over-claim —
citing the deterministic-embedder baseline as an embedding-quality number — was
caught in P1 #187; do not repeat it.)

Real embedding/reranker/OCR quality is measured by the SEPARATE nightly job
``.github/workflows/retrieval-eval-real.yml``, which runs ``eval/run_eval.py``
with ``EVAL_EMBEDDING_ENDPOINT`` set to a real cloud endpoint (CI secret). That
job — not this gate — is the data source for model decisions.

This gate injects ``DeterministicEmbedder()`` EXPLICITLY into ``run_eval.run``
so it stays hermetic and reproducible even if a stray ``EVAL_EMBEDDING_*`` env
var is present in the runner. The corpus is intentionally NOT ceiling-saturated
(baseline recall ~0.76 / nDCG ~0.71) so the nightly real-embedding run has
measurable headroom.

WHY ``import kiwipiepy`` DIRECTLY (and not ``pytest.importorskip``):
the corpus is Korean-heavy and the whole point of the gate is to protect the
Korean morpheme path. If Kiwi were missing, ``importorskip`` would SKIP the
test and the gate would report *green while measuring nothing* — a silent,
falsely-passing gate. A missing Kiwi must HARD-FAIL the build instead, so the
import sits unguarded at module top.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import kiwipiepy  # noqa: F401  HARD requirement — do NOT convert to importorskip.

_REPO_ROOT = Path(__file__).resolve().parent.parent
_EVAL_DIR = _REPO_ROOT / "eval"
sys.path.insert(0, str(_EVAL_DIR))

import run_eval  # noqa: E402
from embedder import DeterministicEmbedder  # noqa: E402

# Regression tolerance below the recorded baseline.
REGRESSION_TOLERANCE = 0.02
# Absolute floors — a meaningful retrieval system must clear these regardless
# of the baseline. The current baseline (recall 0.975 / ndcg 0.9584) sits well
# above them; they catch a catastrophic regression that the relative guard
# alone would let a re-baselined PR slip through.
ABS_RECALL_FLOOR = 0.60
ABS_NDCG_FLOOR = 0.55
# Hard latency ceiling per query (p95). Measured p95 is ~1.5ms; 2s leaves
# enormous headroom for a cold CI runner while still catching a pathological
# O(n^2)-style retrieval regression.
HARD_CEILING_S = 2.0
# Absolute slack for the 2x-baseline latency regression bound. A bare 2x of a
# sub-millisecond baseline (e.g. 2 x 1.5ms = 3ms) is far too tight under CI
# scheduling jitter and would flake; the headroom floor keeps the relative
# guard honest without false alarms.
LATENCY_REGRESSION_HEADROOM_S = 0.5


def _load_baseline() -> dict:
    return json.loads((_EVAL_DIR / "baseline.json").read_text(encoding="utf-8"))


def test_retrieval_eval_gate() -> None:
    baseline = _load_baseline()
    # Inject the deterministic embedder EXPLICITLY: this gate is the lexical-path
    # regression guard and must be byte-reproducible regardless of any
    # EVAL_EMBEDDING_* env var present in the runner (those drive the nightly
    # real-embedding job, not this gate).
    result = run_eval.run(embedder=DeterministicEmbedder())
    assert result["embedder"] == "DeterministicEmbedder", (
        "lexical gate must run on the deterministic embedder, got "
        f"{result['embedder']!r}"
    )

    # Persist the run so CI can upload eval/last_run.json as an artifact for
    # post-hoc inspection of per-query results.
    (_EVAL_DIR / "last_run.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    recall = result["recall@10"]
    ndcg = result["ndcg@10"]
    p95 = result["p95_latency_s"]

    base_recall = float(baseline["recall@10"])
    base_ndcg = float(baseline["ndcg@10"])
    base_p95 = float(baseline["p95_latency_s"])

    # 1) Regression guard vs the recorded baseline.
    assert recall >= base_recall - REGRESSION_TOLERANCE, (
        f"Recall@10 regressed: {recall} < {base_recall} - {REGRESSION_TOLERANCE}. "
        f"per_query={result['per_query']}"
    )
    assert ndcg >= base_ndcg - REGRESSION_TOLERANCE, (
        f"nDCG@10 regressed: {ndcg} < {base_ndcg} - {REGRESSION_TOLERANCE}. "
        f"per_query={result['per_query']}"
    )

    # 2) Absolute floor — independent of the baseline.
    assert recall >= ABS_RECALL_FLOOR, f"Recall@10 below floor: {recall} < {ABS_RECALL_FLOOR}"
    assert ndcg >= ABS_NDCG_FLOOR, f"nDCG@10 below floor: {ndcg} < {ABS_NDCG_FLOOR}"

    # 3) Latency — absolute hard ceiling + headroom-padded 2x regression bound.
    assert p95 < HARD_CEILING_S, f"p95 latency over hard ceiling: {p95}s >= {HARD_CEILING_S}s"
    latency_bound = max(2.0 * base_p95, LATENCY_REGRESSION_HEADROOM_S)
    assert p95 < latency_bound, f"p95 latency regressed: {p95}s >= {latency_bound}s"

    # 4) Guard against an accidentally-trivial gate (corpus emptied / queries
    #    dropped) AND against silently shrinking back below the de-ceiling
    #    expansion: the set must stay large enough that all retrievers do not
    #    look equally good.
    assert result["corpus_size"] >= 100, f"corpus shrank: {result['corpus_size']} < 100"
    assert result["query_count"] >= 35, f"query set shrank: {result['query_count']} < 35"
