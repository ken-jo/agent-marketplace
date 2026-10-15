"""Determinism + shape tests for the offline eval embedder (eval/embedder.py)."""

from __future__ import annotations

import math
import sys
from pathlib import Path

_EVAL_DIR = Path(__file__).resolve().parent.parent / "eval"
sys.path.insert(0, str(_EVAL_DIR))

from embedder import DeterministicEmbedder  # noqa: E402


def test_dimensions_attribute() -> None:
    assert DeterministicEmbedder.dimensions == 256
    assert DeterministicEmbedder().dimensions == 256


def test_same_input_identical_vector() -> None:
    embedder = DeterministicEmbedder()
    a = embedder.embed_one("정보 보안 등급 분류")
    b = embedder.embed_one("정보 보안 등급 분류")
    assert a == b  # byte-identical (exact float equality)
    assert len(a) == 256


def test_determinism_across_instances() -> None:
    # A fresh instance (and thus no shared mutable state) must reproduce the
    # exact same vector — the gate baseline depends on this.
    text = "password policy requirements"
    assert DeterministicEmbedder().embed_one(text) == DeterministicEmbedder().embed_one(text)


def test_different_input_different_vector() -> None:
    embedder = DeterministicEmbedder()
    a = embedder.embed_one("연차 휴가 규정")
    b = embedder.embed_one("보안 사고 대응")
    assert a != b


def test_l2_norm_is_unit() -> None:
    embedder = DeterministicEmbedder()
    for text in ("비밀번호 정책", "backup and disaster recovery", "출장비 정산"):
        vector = embedder.embed_one(text)
        norm = math.sqrt(sum(v * v for v in vector))
        assert abs(norm - 1.0) < 1e-9


def test_empty_text_is_zero_vector() -> None:
    embedder = DeterministicEmbedder()
    vector = embedder.embed_one("   ")
    assert vector == [0.0] * 256


def test_embed_corpus_matches_embed_one() -> None:
    embedder = DeterministicEmbedder()
    texts = ["연차 휴가", "VPN 원격 접속", "expense report"]
    corpus = embedder.embed_corpus(texts)
    assert corpus == [embedder.embed_one(t) for t in texts]
