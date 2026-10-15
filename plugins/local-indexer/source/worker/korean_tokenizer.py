"""Korean morpheme tokenizer using kiwipiepy (Pattern B).

Implements pattern B from the Ave Korean tokenizer blueprint: morphemes are
extracted with kiwi, filtered to content-bearing POS tags, and joined
with single spaces so that SQLite FTS5 ``unicode61`` tokenizer can
segment them at whitespace. Verbs/adjectives use their lemma so that
inflected query forms (e.g. ``규정한다``) can match indexed base forms.

Both indexing and query paths must route through the same
``tokenize_for_index`` / ``tokenize_query`` pipeline; otherwise recall
regresses on Korean corpora (see R4 regression queries).

The module imports ``kiwipiepy`` lazily so that environments without
the native wheel can still import other worker modules. Consumers must
call ``KiwiTokenizer()`` to trigger initialisation.
"""

from __future__ import annotations

import logging
import re
from typing import Iterable, List, Optional

log = logging.getLogger(__name__)


# Content POS tags whose morpheme surface or lemma we want to keep.
# Nouns, verbs/adjectives (as lemmas), foreign/hanja/numeric symbols,
# cardinal numbers, pronouns. XR (root) is also retained for coverage.
_CONTENT_POS_PREFIXES = (
    "NN",   # NNG/NNP/NNB common, proper, bound nouns
    "NR",   # cardinal numbers
    "NP",   # pronouns
    "VV",   # verbs (use lemma form)
    "VA",   # adjectives (use lemma form)
    "VX",   # auxiliary verbs (lemma)
    "MM",   # determiners
    "MAG",  # general adverbs
    "MAJ",  # conjunctive adverbs
    "SL",   # foreign (Latin) characters
    "SH",   # hanja
    "SN",   # digits
    "XR",   # root
)

# POS tags that should always be stripped (particles, endings,
# punctuation, symbols). Mirrors the "stopword" policy in the
# blueprint.
_STOPWORD_POS = frozenset(
    {
        "JKS", "JKC", "JKG", "JKO", "JKB", "JKV", "JKQ", "JX", "JC",
        "EP", "EF", "EC", "ETN", "ETM",
        "SF", "SE", "SSO", "SSC", "SC", "SY",
        "XSN", "XSV", "XSA", "XPN",
        "XSM",
    }
)

_LEMMA_POS_PREFIXES = ("VV", "VA", "VX")

_WS_RE = re.compile(r"\s+")

# kiwipiepy 0.22+에서 제거되어 OSError로 네이티브 레이어를 불안정하게 만드는 모델들.
_UNSUPPORTED_KIWI_MODELS = frozenset({"knlm", "sbg"})


class KiwiTokenizer:
    """Thin wrapper around :class:`kiwipiepy.Kiwi` for index + query."""

    def __init__(self, model_type: Optional[str] = "cong") -> None:
        try:
            from kiwipiepy import Kiwi  # type: ignore
        except Exception as exc:  # pragma: no cover - import guard
            raise RuntimeError(
                "kiwipiepy를 import할 수 없습니다. python-requirements.lock에 "
                "kiwipiepy가 포함되었는지, uv venv가 준비되었는지 확인하세요."
            ) from exc
        if isinstance(model_type, str) and model_type.lower() in _UNSUPPORTED_KIWI_MODELS:
            raise RuntimeError(
                f"kiwipiepy 0.22+에서 지원되지 않는 모델 타입입니다: {model_type!r}. "
                "'cong'을 사용하거나 model_type=None으로 호출하세요."
            )
        try:
            if model_type is None:
                self._kiwi = Kiwi()
            else:
                self._kiwi = Kiwi(model_type=model_type)
        except TypeError:
            self._kiwi = Kiwi()
        except OSError as exc:
            raise RuntimeError(
                f"kiwipiepy 모델 로딩 실패 (model_type={model_type!r}): {exc}. "
                "지원 모델: 'cong' (kiwipiepy 0.22+)."
            ) from exc
        # Load user dictionary (~/.ave/kiwi-user-dict.tsv) on worker start.
        # Safe no-op if file missing or kiwi lacks add_user_word.
        try:
            from user_dict_loader import load_entries, apply_to_kiwi  # type: ignore

            entries = load_entries()
            if entries:
                added = apply_to_kiwi(self._kiwi, entries)
                log.info("kiwi_user_dict.loaded count=%d", added)
        except Exception:  # pragma: no cover - never block startup on dict
            log.exception("kiwi_user_dict.load_failed")

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def tokenize_for_index(self, text: str) -> str:
        """Tokenize ``text`` for storage in ``chunks_fts.content_ko``."""
        return " ".join(self._morphemes(text))

    def tokenize_query(self, text: str) -> str:
        """Tokenize a user query for FTS5 MATCH.

        Produces a space-joined morpheme string. Callers typically wrap
        this in an FTS5 OR expression.
        """
        return " ".join(self._morphemes(text))

    def split_sents(self, text: str) -> List[str]:
        """Return sentence boundaries using kiwi's sentence splitter."""
        if not text:
            return []
        try:
            sents = self._kiwi.split_into_sents(text)
        except Exception:  # pragma: no cover - defensive
            log.exception("kiwi split_into_sents failed; falling back to naive split")
            return [segment for segment in re.split(r"(?<=[.!?\n])\s+", text) if segment]
        result: List[str] = []
        for sent in sents:
            value = getattr(sent, "text", None)
            if value is None and isinstance(sent, tuple) and sent:
                value = sent[0]
            if isinstance(value, str):
                clean = value.strip()
                if clean:
                    result.append(clean)
        return result

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _morphemes(self, text: str) -> List[str]:
        if not text:
            return []
        cleaned = _WS_RE.sub(" ", text).strip()
        if not cleaned:
            return []
        tokens = self._kiwi.tokenize(cleaned)
        out: List[str] = []
        for token in tokens:
            form = getattr(token, "form", None)
            lemma = getattr(token, "lemma", None)
            tag = getattr(token, "tag", None)
            if form is None or tag is None:
                # Support tuple-style (form, tag, start, len) if present.
                if isinstance(token, tuple) and len(token) >= 2:
                    form, tag = token[0], token[1]
                    lemma = None
                else:
                    continue
            if not isinstance(form, str) or not isinstance(tag, str):
                continue
            if tag in _STOPWORD_POS:
                continue
            if not _is_content_tag(tag):
                continue
            surface = _select_surface(form, lemma, tag).strip().lower()
            if not surface:
                continue
            out.append(surface)
        return out


# ----------------------------------------------------------------------
# Module-level utilities
# ----------------------------------------------------------------------
def _is_content_tag(tag: str) -> bool:
    return any(tag.startswith(prefix) for prefix in _CONTENT_POS_PREFIXES)


def _select_surface(form: str, lemma: Optional[str], tag: str) -> str:
    if any(tag.startswith(prefix) for prefix in _LEMMA_POS_PREFIXES):
        base = lemma or form
        # Kiwi returns verb lemmas already with '다' suffix; we keep the
        # stem only for more forgiving BM25 match.
        if isinstance(base, str) and base.endswith("다") and len(base) > 1:
            return base[:-1]
        return base or ""
    return form


_SINGLETON: Optional[KiwiTokenizer] = None


def get_tokenizer() -> KiwiTokenizer:
    """Return a process-wide singleton (lazy)."""
    global _SINGLETON
    if _SINGLETON is None:
        _SINGLETON = KiwiTokenizer()
    return _SINGLETON


def tokenize_for_index(text: str) -> str:
    return get_tokenizer().tokenize_for_index(text)


def tokenize_query(text: str) -> str:
    return get_tokenizer().tokenize_query(text)


def split_sents(text: str) -> List[str]:
    return get_tokenizer().split_sents(text)


__all__ = [
    "KiwiTokenizer",
    "get_tokenizer",
    "tokenize_for_index",
    "tokenize_query",
    "split_sents",
]
