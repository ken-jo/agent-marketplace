"""Constructor regression tests for KiwiTokenizer."""

from __future__ import annotations

import importlib
import sys
from pathlib import Path
from types import ModuleType
from typing import Callable, TypeVar

_WORKER_DIR = Path(__file__).resolve().parent.parent / "worker"
sys.path.insert(0, str(_WORKER_DIR))

T = TypeVar("T")

def _with_fake_kiwi(fake_kiwi_cls: type, callback: Callable[[object], T]) -> T:
    prev_kiwi = sys.modules.get("kiwipiepy")
    prev_tokenizer = sys.modules.get("korean_tokenizer")
    sys.modules.pop("korean_tokenizer", None)
    fake_mod = ModuleType("kiwipiepy")
    fake_mod.Kiwi = fake_kiwi_cls
    sys.modules["kiwipiepy"] = fake_mod
    try:
        module = importlib.import_module("korean_tokenizer")
        return callback(module)
    finally:
        sys.modules.pop("korean_tokenizer", None)
        if prev_tokenizer is not None:
            sys.modules["korean_tokenizer"] = prev_tokenizer
        if prev_kiwi is not None:
            sys.modules["kiwipiepy"] = prev_kiwi
        else:
            sys.modules.pop("kiwipiepy", None)


def test_defaults_to_supported_cong_model() -> None:
    calls: list[dict[str, object]] = []

    class FakeKiwi:
        def __init__(self, *args: object, **kwargs: object) -> None:
            calls.append(dict(kwargs))

        def tokenize(self, text: str) -> list[object]:
            return []

        def split_into_sents(self, text: str) -> list[object]:
            return []

    _with_fake_kiwi(FakeKiwi, lambda module: module.KiwiTokenizer())

    assert calls == [{"model_type": "cong"}]


def test_falls_back_to_plain_constructor_when_model_type_kw_unsupported() -> None:
    calls: list[dict[str, object]] = []

    class FakeKiwi:
        def __init__(self, *args: object, **kwargs: object) -> None:
            calls.append(dict(kwargs))
            if kwargs:
                raise TypeError("unexpected keyword")

        def tokenize(self, text: str) -> list[object]:
            return []

        def split_into_sents(self, text: str) -> list[object]:
            return []

    _with_fake_kiwi(FakeKiwi, lambda module: module.KiwiTokenizer())

    assert calls == [{"model_type": "cong"}, {}]
