"""Load ``~/.ave/kiwi-user-dict.tsv`` into a kiwipiepy analyzer.

File format (tab-separated, one entry per line)::

    term	pos	weight

- ``term``   : surface form to register (non-empty str)
- ``pos``    : kiwi POS tag (e.g. ``NNP``, ``NNG``). Default ``NNP``.
- ``weight`` : float score. Default ``0.0``.

Lines starting with ``#`` and blank lines are ignored. Malformed lines
are skipped with a WARNING so a bad entry cannot block startup.
"""

from __future__ import annotations

import logging
import math
import os
from dataclasses import dataclass
from typing import Any, List, Optional

log = logging.getLogger(__name__)

DEFAULT_DICT_PATH = os.path.expanduser("~/.ave/kiwi-user-dict.tsv")
DEFAULT_POS = "NNP"


@dataclass(frozen=True)
class UserDictEntry:
    term: str
    pos: str
    weight: float


def parse_line(raw: str) -> Optional[UserDictEntry]:
    """Parse one TSV line. Returns ``None`` for malformed/blank lines."""
    if raw is None:
        return None
    line = raw.rstrip("\n").rstrip("\r")
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None
    parts = line.split("\t")
    term = parts[0].strip() if parts else ""
    if not term:
        return None
    pos = (parts[1].strip() if len(parts) > 1 and parts[1].strip() else DEFAULT_POS)
    weight_raw = parts[2].strip() if len(parts) > 2 else "0.0"
    try:
        weight = float(weight_raw) if weight_raw else 0.0
    except ValueError:
        return None
    if not math.isfinite(weight):
        return None
    return UserDictEntry(term=term, pos=pos, weight=weight)


def load_entries(path: Optional[str] = None) -> List[UserDictEntry]:
    """Read + parse the user dict file. Missing file → empty list."""
    target = os.path.expanduser(os.path.expandvars(path or DEFAULT_DICT_PATH))
    if not os.path.isfile(target):
        return []
    entries: List[UserDictEntry] = []
    try:
        with open(target, "r", encoding="utf-8") as fh:
            for lineno, raw in enumerate(fh, start=1):
                entry = parse_line(raw)
                if entry is None:
                    if raw.strip() and not raw.strip().startswith("#"):
                        log.warning(
                            "kiwi_user_dict.skip_malformed",
                            extra={"path": target, "line": lineno},
                        )
                    continue
                entries.append(entry)
    except OSError as exc:
        log.warning("kiwi_user_dict.read_failed", extra={"path": target, "error": str(exc)})
    return entries


def apply_to_kiwi(kiwi: Any, entries: List[UserDictEntry]) -> int:
    """Register ``entries`` into a kiwipiepy ``Kiwi`` analyzer.

    Returns the number of successfully added words.
    """
    if not entries or kiwi is None:
        return 0
    add_user_word = getattr(kiwi, "add_user_word", None)
    if not callable(add_user_word):
        log.warning("kiwi_user_dict.kiwi_missing_add_user_word")
        return 0
    count = 0
    for entry in entries:
        try:
            add_user_word(entry.term, entry.pos, entry.weight)
            count += 1
        except Exception as exc:  # pragma: no cover - kiwi internal errors
            log.warning(
                "kiwi_user_dict.add_failed",
                extra={"term": entry.term, "pos": entry.pos, "error": str(exc)},
            )
    return count


__all__ = [
    "UserDictEntry",
    "DEFAULT_DICT_PATH",
    "DEFAULT_POS",
    "parse_line",
    "load_entries",
    "apply_to_kiwi",
]
