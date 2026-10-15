# Why deterministic: offline CI eval embedder, not a production fallback.
#
# This module lives ONLY under eval/ and is never imported by the worker or
# the host. It exists so the retrieval eval gate can exercise the *real*
# hybrid search path (Kiwi + FTS5 + RRF + a vector channel) hermetically —
# no embedding API key, no network, byte-identical vectors across runs.
# Production embeddings are produced by OpenAIEmbeddingClient against a real
# provider; nothing here is a runtime substitute for that.
"""Deterministic, offline embedding client for the retrieval eval gate.

``DeterministicEmbedder`` maps text to a fixed 256-dimensional, L2-normalized
vector built from a hashed character-trigram bag-of-words. Because the hash is
a stable digest (blake2b, not Python's salted ``hash()``), the same input
yields a byte-identical vector on every process and machine — a hard
requirement for a regression gate whose baseline must be reproducible.

Interface mirrors the production embedding client the worker injects:
``embed_corpus(list[str]) -> list[list[float]]``,
``embed_one(str) -> list[float]``, and a ``dimensions`` attribute.
"""

from __future__ import annotations

import hashlib
import math
from typing import List

_DIMENSIONS = 256


def _normalize_text(text: str) -> str:
    """Lower-case and collapse runs of whitespace to single spaces."""
    return " ".join(text.lower().split())


def _char_trigrams(text: str) -> List[str]:
    """Sliding window of 3 characters over the normalized text.

    Texts shorter than 3 characters fall back to the whole token so that
    very short queries still produce a non-empty bag.
    """
    s = _normalize_text(text)
    if not s:
        return []
    if len(s) < 3:
        return [s]
    return [s[i : i + 3] for i in range(len(s) - 2)]


def _bucket(trigram: str) -> int:
    """Stable hash of a trigram into ``[0, _DIMENSIONS)``.

    Uses blake2b (a fixed digest) rather than ``hash()``, which is salted per
    process via PYTHONHASHSEED and would break byte-identical reproducibility.
    """
    digest = hashlib.blake2b(trigram.encode("utf-8"), digest_size=8).digest()
    return int.from_bytes(digest, "big") % _DIMENSIONS


class DeterministicEmbedder:
    """Hashed char-trigram bag-of-words embedder (256-dim, L2-normalized)."""

    dimensions = _DIMENSIONS

    def embed_one(self, text: str) -> List[float]:
        vector = [0.0] * _DIMENSIONS
        for trigram in _char_trigrams(text):
            vector[_bucket(trigram)] += 1.0
        norm = math.sqrt(sum(value * value for value in vector))
        if norm == 0.0:
            return vector
        return [value / norm for value in vector]

    def embed_corpus(self, chunks: List[str]) -> List[List[float]]:
        return [self.embed_one(chunk) for chunk in chunks]


__all__ = ["DeterministicEmbedder"]
