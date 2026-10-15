"""In-memory cosine vector store for the retrieval eval gate.

``InMemoryCosineStore`` is a duck-typed stand-in for the worker's LanceDB
store (``_LanceVectorStore``). It implements the same three methods the
indexer/search layers call — ``upsert``, ``search``, ``delete_by_chunk_ids`` —
and crucially mirrors the production *score polarity*: every hit's score is
``1 / (1 + cosine_distance)`` so that higher = better, exactly as
``_normalize_distance_to_score`` does on the real LanceDB path. Keeping the
polarity identical means the eval exercises RRF fusion with the same score
ordering the production worker would see.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Sequence


def _cosine_distance(a: Sequence[float], b: Sequence[float]) -> float:
    """Cosine distance ``1 - cos_sim`` in ``[0, 2]`` (0 = identical direction)."""
    dot = 0.0
    norm_a = 0.0
    norm_b = 0.0
    for x, y in zip(a, b):
        dot += x * y
        norm_a += x * x
        norm_b += y * y
    if norm_a == 0.0 or norm_b == 0.0:
        # Undefined similarity for a zero vector — treat as maximally distant.
        return 1.0
    cos_sim = dot / (math.sqrt(norm_a) * math.sqrt(norm_b))
    # Guard against floating point drift just outside [-1, 1].
    cos_sim = max(-1.0, min(1.0, cos_sim))
    return 1.0 - cos_sim


class InMemoryCosineStore:
    """Exact-cosine nearest-neighbour store keyed by ``chunk_id``."""

    def __init__(self) -> None:
        # chunk_id -> vector
        self._vectors: Dict[str, List[float]] = {}

    def upsert(self, rows: List[Dict[str, Any]]) -> None:
        for row in rows:
            chunk_id = row.get("chunk_id")
            vector = row.get("vector")
            if not chunk_id or vector is None:
                continue
            self._vectors[chunk_id] = list(vector)

    def delete_by_chunk_ids(self, chunk_ids: Sequence[str]) -> None:
        for chunk_id in chunk_ids:
            self._vectors.pop(chunk_id, None)

    def search(self, vector: Sequence[float], top_k: int = 20) -> List[Dict[str, Any]]:
        scored: List[Dict[str, Any]] = []
        for chunk_id, stored in self._vectors.items():
            distance = _cosine_distance(vector, stored)
            # Mirror production polarity: higher score = closer.
            score = 1.0 / (1.0 + distance)
            scored.append({"chunk_id": chunk_id, "score": score})
        scored.sort(key=lambda item: item["score"], reverse=True)
        return scored[:top_k]


__all__ = ["InMemoryCosineStore"]
