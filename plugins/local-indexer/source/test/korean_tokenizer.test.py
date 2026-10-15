"""Pytest for KiwiTokenizer (Pattern B morpheme pipeline)."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

_WORKER_DIR = Path(__file__).resolve().parent.parent / "worker"
sys.path.insert(0, str(_WORKER_DIR))

kiwipiepy = pytest.importorskip("kiwipiepy")

from korean_tokenizer import KiwiTokenizer, tokenize_for_index, tokenize_query  # noqa: E402


@pytest.fixture(scope="module")
def tk() -> KiwiTokenizer:
    return KiwiTokenizer()


def test_strips_josa_and_emi(tk: KiwiTokenizer) -> None:
    out = tk.tokenize_for_index("출장 규정은 매년 갱신됩니다.")
    tokens = out.split()
    assert "규정" in tokens
    assert "출장" in tokens
    # Josa/EF must not survive
    for bad in ("은", "됩니다", "."):
        assert bad not in tokens


def test_verb_lemma(tk: KiwiTokenizer) -> None:
    # 규정한다 → 규정하다 (stem 규정하) or morpheme 규정 + 하
    out = tk.tokenize_for_index("연차는 규정한다.")
    assert "규정" in out.split() or "규정하" in out.split()


def test_empty_string(tk: KiwiTokenizer) -> None:
    assert tk.tokenize_for_index("") == ""
    assert tk.tokenize_query("") == ""


def test_english_and_digits(tk: KiwiTokenizer) -> None:
    out = tk.tokenize_for_index("Regulation 2024 version")
    tokens = out.split()
    assert any("regulation" in t.lower() or "regulation" == t for t in tokens)
    assert "2024" in tokens


def test_split_sents(tk: KiwiTokenizer) -> None:
    text = "출장 규정은 매년 갱신됩니다. 품의서를 제출해야 합니다."
    sents = tk.split_sents(text)
    assert len(sents) >= 2
    assert any("규정" in s for s in sents)


def test_module_level_helpers() -> None:
    out = tokenize_for_index("지원 품의서")
    assert "지원" in out.split()
    assert "품" in out.split() or "품의" in out.split() or "품의서" in out.split()

    q = tokenize_query("지원")
    assert "지원" in q.split()
