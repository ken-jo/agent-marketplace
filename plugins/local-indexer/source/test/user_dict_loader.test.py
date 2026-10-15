"""Sprint 3-C: kiwi user-dict TSV loader."""

from __future__ import annotations

import sys
from pathlib import Path

_WORKER = Path(__file__).resolve().parent.parent / "worker"
sys.path.insert(0, str(_WORKER))

from user_dict_loader import (  # noqa: E402
    UserDictEntry,
    apply_to_kiwi,
    load_entries,
    parse_line,
)


def test_parse_valid_full_line() -> None:
    entry = parse_line("엘비스\tNNP\t3.5")
    assert entry == UserDictEntry(term="엘비스", pos="NNP", weight=3.5)


def test_parse_defaults_pos_and_weight() -> None:
    entry = parse_line("엘비스")
    assert entry is not None
    assert entry.term == "엘비스"
    assert entry.pos == "NNP"
    assert entry.weight == 0.0


def test_parse_skips_blank_and_comment() -> None:
    assert parse_line("") is None
    assert parse_line("   \n") is None
    assert parse_line("# this is a comment") is None


def test_parse_malformed_weight_returns_none() -> None:
    assert parse_line("term\tNNP\tnot_a_float") is None


def test_load_entries_skips_malformed(tmp_path: Path) -> None:
    file = tmp_path / "dict.tsv"
    file.write_text(
        "\n".join(
            [
                "# header comment",
                "엘비스\tNNP\t2.0",
                "",
                "bad\tNNP\tNaN_weight_xx",  # malformed weight
                "good\tNNG\t0.0",
            ]
        ),
        encoding="utf-8",
    )
    entries = load_entries(str(file))
    terms = [e.term for e in entries]
    assert terms == ["엘비스", "good"]


def test_load_entries_missing_file(tmp_path: Path) -> None:
    assert load_entries(str(tmp_path / "nope.tsv")) == []


class _StubKiwi:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, float]] = []

    def add_user_word(self, term: str, pos: str, weight: float) -> None:
        self.calls.append((term, pos, weight))


def test_apply_to_kiwi_registers_each_entry() -> None:
    kiwi = _StubKiwi()
    entries = [UserDictEntry("a", "NNP", 1.0), UserDictEntry("b", "NNG", 0.0)]
    assert apply_to_kiwi(kiwi, entries) == 2
    assert kiwi.calls == [("a", "NNP", 1.0), ("b", "NNG", 0.0)]


def test_apply_to_kiwi_no_method() -> None:
    class _Empty:
        pass

    assert apply_to_kiwi(_Empty(), [UserDictEntry("a", "NNP", 0.0)]) == 0
