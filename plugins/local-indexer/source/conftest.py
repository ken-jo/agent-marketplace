"""Put the repository root on ``sys.path`` for the Python worker suite.

``worker/`` is a namespace package (no ``__init__.py``) and the worker
imports its own modules as ``worker.<module>``. ``python -m pytest`` adds the
current directory to ``sys.path`` and so hides the need; a bare ``pytest`` /
``uv run pytest`` does not. This makes both spellings run the same suite.
"""

import sys
from pathlib import Path

_REPO_ROOT = str(Path(__file__).resolve().parent)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)
