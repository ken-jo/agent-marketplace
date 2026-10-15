"""Shared HTTP utilities for Naver blog scripts."""

from __future__ import annotations

import re
import ssl
import urllib.error
import urllib.parse
import urllib.request


TAG_RE = re.compile(r"<[^>]+>")

_ssl_ctx: ssl.SSLContext | None = None


def _get_ssl_context() -> ssl.SSLContext:
    global _ssl_ctx
    if _ssl_ctx is None:
        _ssl_ctx = ssl.create_default_context()
    return _ssl_ctx


_NAVER_DOMAINS = (".naver.com", ".naver.net", ".pstatic.net")


def is_naver_url(url: str) -> bool:
    host = urllib.parse.urlparse(url).hostname or ""
    return any(host == d.lstrip(".") or host.endswith(d) for d in _NAVER_DOMAINS)


def urlopen(request: urllib.request.Request, timeout: int, *, insecure: bool = False):
    if insecure:
        raise ValueError("TLS certificate verification cannot be disabled.")
    return urllib.request.urlopen(request, timeout=timeout, context=_get_ssl_context())
