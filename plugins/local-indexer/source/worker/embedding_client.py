"""Embedding client for the RAG indexer (cloud OpenAI / Azure OpenAI).

Provider model
--------------
Embeddings are produced by a hosted OpenAI-compatible API. The supported
providers are ``openai`` (api.openai.com or any OpenAI-compatible base URL)
and ``azure`` (Azure OpenAI Service). There is no in-process local-model
path: the supported set is exactly ``{openai, azure}`` and this is the single
source of truth that the worker argparse choices, the TypeScript
``resolveEmbeddingProvider``, and the manifest ``configSchema.embeddingProvider``
enum all mirror.

This is a cloud-dependent stack — outbound HTTPS to the configured embedding
endpoint is required to produce vectors. When that egress is unavailable (no
API key, blocked endpoint, model-load failure), the indexer degrades to
BM25-only search rather than failing the index run.

Architecture
------------
- ``OpenAIEmbeddingClient``: wraps ``OpenAI``/``AzureOpenAI`` ``embeddings.create``.  # egress-gate: allow Tier A Python-worker embedding egress carve-out: the spawned worker has no JS hostApi.hostFetch handle; this is a doc mention, real egress is grandfathered
- ``create_embedding_client(provider, model, ...)``: factory that selects the
  backend from ``provider``. Call sites use it so provider changes are
  transparent.

Corporate CA trust
------------------
TLS certificate verification is always on. On a network that intercepts TLS
with a corporate CA, trust the corporate root via the standard environment
mechanisms rather than disabling verification:

- ``SSL_CERT_FILE`` / ``REQUESTS_CA_BUNDLE`` — point at the corporate CA bundle
  (PEM). httpx (used by the openai SDK) honors ``SSL_CERT_FILE``.
- ``SSL_CERT_DIR`` — a directory of trusted CA certs.

Disabling certificate verification on a path that carries the embedding API
key in the Authorization header is never supported.
"""

from __future__ import annotations

import logging
import os
import time
from urllib.parse import parse_qs, urlparse
from typing import Any, Callable, List, Optional, Sequence

try:  # pragma: no cover - optional dependency branch
    import structlog  # type: ignore

    log = structlog.get_logger(__name__)
except Exception:  # pragma: no cover - fallback logger
    log = logging.getLogger(__name__)


try:  # pragma: no cover - tenacity is in requirements.lock
    from tenacity import (  # type: ignore
        retry,
        retry_if_exception,
        stop_after_attempt,
    )

    _HAS_TENACITY = True
except Exception:  # pragma: no cover - dev fallback
    _HAS_TENACITY = False


# ─── Defaults ─────────────────────────────────────────────────────────
DEFAULT_PROVIDER = "openai"
DEFAULT_OPENAI_MODEL = "text-embedding-3-small"
DEFAULT_OPENAI_DIMENSIONS = 1536
DEFAULT_BATCH_SIZE = 64
DEFAULT_TARGET_RPM = 400
DEFAULT_AZURE_EMBEDDING_API_VERSION = "2024-02-01"


def _normalize_azure_endpoint_and_version(
    endpoint: str,
    api_version: Optional[str],
) -> tuple[str, str]:
    parsed = urlparse(endpoint)
    if not parsed.scheme or not parsed.netloc:
        raise RuntimeError(
            f"Azure 임베딩 endpoint URL 형식이 잘못됐습니다: {endpoint}"
        )
    normalized_endpoint = f"{parsed.scheme}://{parsed.netloc}/"
    query_version = parse_qs(parsed.query).get("api-version", [""])[0].strip()
    effective_version = (
        (api_version or "").strip()
        or query_version
        or DEFAULT_AZURE_EMBEDDING_API_VERSION
    )
    return normalized_endpoint, effective_version


# ======================================================================
# OpenAI / Azure OpenAI embedding client
# ======================================================================
def broker_http_client(egress_uds: Optional[str]) -> Optional[Any]:
    """Build the HTTP client the provider SDKs must use to reach the broker.

    On macOS and Linux the broker does not listen on loopback TCP. A plugin
    loaded in a confined child cannot bind loopback there — on macOS the bind is
    refused, and on Linux it succeeds into a network namespace this worker is not
    in, which is worse, because the failure would then arrive at the first
    request instead of at the bind. It binds a Unix-domain socket instead, and a
    Unix socket is reached by PATH rather than by port. The SDKs still want a
    URL, so the base URL stays ``http://localhost`` — an authority nothing dials.
    THIS transport is what decides where the bytes go, so a caller that dropped
    the socket path would send real requests to a real localhost port and fail in
    a way that looks like the broker being down.

    Returns ``None`` when no socket path was given: either there is no broker at
    all, or the broker bound loopback TCP (Windows, where ``listen(path)`` makes
    a named pipe rather than a Unix socket, and httpx2 cannot pin a transport to
    a pipe anyway). Both are addressed by the base URL, which is the real bound
    one there, so the SDK's own default client is correct.

    The client is an ``httpx2`` one because that is the HTTP library openai 3
    uses and installs; the older ``httpx`` is no longer in the shipped lock.
    """
    if not egress_uds:
        return None
    try:
        import httpx2  # type: ignore  # egress-gate: allow — pins the SDK to a Unix socket, removing TCP reach rather than adding any
    except Exception as exc:  # pragma: no cover - dep guard
        raise RuntimeError(
            f"httpx2 is required to reach the egress broker over a Unix socket: {exc}"
        ) from exc
    return httpx2.Client(transport=httpx2.HTTPTransport(uds=egress_uds))


class OpenAIEmbeddingClient:
    """Thin wrapper around ``OpenAI``/``AzureOpenAI`` ``embeddings.create``.  # egress-gate: allow Tier A Python-worker embedding egress carve-out: doc mention only, the actual SDK egress below is grandfathered

    Backs both the ``openai`` provider (api.openai.com or an OpenAI-compatible
    base URL) and the ``azure`` provider (Azure OpenAI Service). Outbound HTTPS
    to the configured endpoint is required; on a corporate network this traffic
    may be blocked (generative-AI category) or TLS-intercepted — in the latter
    case trust the corporate CA via ``SSL_CERT_FILE`` / ``REQUESTS_CA_BUNDLE``
    (see module docstring), never by disabling verification.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: str = DEFAULT_OPENAI_MODEL,
        dimensions: int = DEFAULT_OPENAI_DIMENSIONS,
        batch_size: int = 100,
        target_rpm: int = DEFAULT_TARGET_RPM,
        *,
        endpoint: Optional[str] = None,
        api_version: Optional[str] = None,
        use_azure: bool = False,
        client_factory: Optional[Callable[[], Any]] = None,
        egress_broker_url: Optional[str] = None,
        egress_broker_uds: Optional[str] = None,
        egress_token: Optional[str] = None,
    ) -> None:
        # Host-mediated egress broker (P3 ⑬). When ``egress_broker_url`` is set
        # the client never holds the provider key: it points its base_url at the
        # broker, sends only an ``x-ave-egress-token`` header, and a dummy
        # api_key (the broker discards it and injects the real provider auth
        # host-side). The OPENAI_API_KEY env opt-in is GATED OFF in broker mode —
        # falling back to a real env key would bypass the broker entirely.
        self.egress_broker_url = egress_broker_url or None
        self.egress_broker_uds = egress_broker_uds or None
        self.egress_token = egress_token or None
        if self.egress_broker_url:
            self.api_key = "ave-egress-broker"  # dummy; broker injects real auth
        else:
            # Legacy (no-broker) path: the embedding key is pushed into the
            # worker at runtime via the control channel and reaches this client
            # through the explicit ``api_key`` argument, never the process
            # environment. The only env channel kept is the OPENAI_API_KEY dev
            # opt-in (gated host-side by AVE_ALLOW_ENV_API_KEY=1).
            self.api_key = (
                api_key
                or os.environ.get("OPENAI_API_KEY", "")
            )
        self.model = model
        self.dimensions = dimensions
        self.batch_size = max(1, batch_size)
        self.target_rpm = max(1, target_rpm)
        self._min_interval_s = 60.0 / float(self.target_rpm)
        self._last_call_ts: float = 0.0
        # ``endpoint`` is shared across OpenAI-style backends:
        #   * use_azure=False, endpoint=""        → SDK default api.openai.com
        #   * use_azure=False, endpoint=<url>     → OpenAI-compatible base URL
        #     (LM Studio, LiteLLM, an internal proxy, etc.)
        #   * use_azure=True,  endpoint=<resource URL> → Azure OpenAI Service,
        #     `model` becomes the Azure deployment name
        self.endpoint = endpoint or None
        self.api_version = api_version or None
        self.use_azure = bool(use_azure)
        self._client_factory = client_factory
        self._client: Optional[Any] = None

    # ------------------------------------------------------------------
    # Public API (embed_one / embed_batch / embed_corpus)
    # ------------------------------------------------------------------
    def embed_one(self, text: str) -> List[float]:
        vectors = self.embed_batch([text])
        return vectors[0] if vectors else []

    def embed_batch(self, texts: Sequence[str]) -> List[List[float]]:
        if not texts:
            return []
        clean = [t if (isinstance(t, str) and t.strip()) else " " for t in texts]
        out: List[List[float]] = []
        total = len(clean)
        for start in range(0, total, self.batch_size):
            end = min(start + self.batch_size, total)
            batch = clean[start:end]
            self._throttle()
            vectors = self._embed_with_retry(batch)
            if len(vectors) != len(batch):
                raise RuntimeError(
                    f"embedding response mismatch: got {len(vectors)} for {len(batch)}"
                )
            out.extend(vectors)
            _info(
                log,
                "embedding_client.batch.ok",
                provider="openai",
                model=self.model,
                processed=end,
                total=total,
                batch=len(batch),
            )
        return out

    def embed_corpus(self, chunks: Sequence[str]) -> List[List[float]]:
        _info(
            log,
            "embedding_client.corpus.start",
            provider="openai",
            total=len(chunks),
            model=self.model,
        )
        result = self.embed_batch(chunks)
        _info(log, "embedding_client.corpus.done", total=len(result))
        return result

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------
    def _throttle(self) -> None:
        now = time.monotonic()
        wait = self._min_interval_s - (now - self._last_call_ts)
        if wait > 0:
            time.sleep(wait)
        self._last_call_ts = time.monotonic()

    def _ensure_client(self) -> Any:
        if self._client is not None:
            return self._client
        if self._client_factory is not None:
            self._client = self._client_factory()
            return self._client

        # ── Broker mode (P3 ⑬) ────────────────────────────────────────────
        # Point the SDK at the host's egress broker. The broker base URL already
        # carries the channel path (``…/egress/embedding``); it is NOT normalized
        # (the Azure path-construction appends ``/openai/deployments/…`` to it,
        # and the broker forwards the remainder verbatim to the real upstream).
        # The token rides a dedicated header so the SDK auth field stays a dummy.
        if self.egress_broker_url:
            default_headers = (
                {"x-ave-egress-token": self.egress_token} if self.egress_token else {}
            )
            if self.use_azure:
                from openai import AzureOpenAI  # type: ignore  # egress-gate: allow — broker mode: SDK targets the host loopback egress broker (egress_broker_url), not the provider; real egress is host-side via the broker's allow-listed upstream
                # api-version is non-secret config (only the resource host is
                # withheld from the worker — the broker holds it). The broker
                # base has a scheme+netloc so the parser is happy; we keep the
                # un-normalized broker base as azure_endpoint so its channel path
                # survives (the SDK appends /openai/deployments/… to it).
                _, effective_version = _normalize_azure_endpoint_and_version(
                    self.egress_broker_url,
                    self.api_version,
                )
                self._client = AzureOpenAI(  # egress-gate: allow — broker mode: azure_endpoint is the host loopback broker, not the Azure resource
                    azure_endpoint=self.egress_broker_url,
                    api_key=self.api_key,
                    api_version=effective_version,
                    default_headers=default_headers,
                    http_client=broker_http_client(self.egress_broker_uds),
                    max_retries=0,
                )
                return self._client
            from openai import OpenAI  # type: ignore  # egress-gate: allow — broker mode: base_url is the host loopback egress broker, not the provider

            self._client = OpenAI(  # egress-gate: allow — broker mode: base_url is the host loopback egress broker, not the provider
                api_key=self.api_key,
                base_url=self.egress_broker_url,
                default_headers=default_headers,
                http_client=broker_http_client(self.egress_broker_uds),
                max_retries=0,
            )
            return self._client

        # Azure OpenAI Service uses its own client class because the
        # request shape (deployment-as-model, mandatory api-version
        # query param) differs from vanilla OpenAI.
        if self.use_azure:
            if not self.endpoint:
                raise RuntimeError(
                    "Azure 임베딩 사용에는 endpoint 가 필요합니다 "
                    "(예: https://<resource>.openai.azure.com/)."
                )
            try:  # pragma: no cover - exercised in production only
                from openai import AzureOpenAI  # type: ignore
                from urllib.parse import urlparse
            except Exception as exc:  # pragma: no cover
                raise RuntimeError(
                    "openai SDK 의 AzureOpenAI 클래스 import 실패. SDK 버전을 확인하세요."
                ) from exc
            # Normalize: SDK 는 azure_endpoint 가 리소스 root 여야 한다. 사용자가
            # `/openai/deployments/<x>/...?api-version=…` 같은 full URL 을 붙여
            # 넣어도 path/query 를 제거해 root 만 남긴다 — provider 별 URL
            # 패턴을 사용자가 외울 필요가 없게.
            parsed = urlparse(self.endpoint)
            if not parsed.scheme or not parsed.netloc:
                raise RuntimeError(
                    f"Azure 임베딩 endpoint URL 형식이 잘못됐습니다: {self.endpoint}"
                )
            normalized_endpoint = f"{parsed.scheme}://{parsed.netloc}/"
            # ``2024-02-01`` is the stable GA api-version for the
            # embeddings surface; pinned in code rather than user-config
            # because it's an Azure REST detail.
            _, effective_version = _normalize_azure_endpoint_and_version(
                self.endpoint,
                self.api_version,
            )
            self._client = AzureOpenAI(
                azure_endpoint=normalized_endpoint,
                api_key=self.api_key,
                api_version=effective_version,
            )
            return self._client

        try:  # pragma: no cover - exercised in production only
            from openai import OpenAI  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise RuntimeError(
                "openai SDK import 실패. python-requirements.lock에 openai가 포함되었는지 "
                "uv venv가 준비되었는지 확인하세요."
            ) from exc

        # TLS verification stays on for every embedding request — the request
        # carries the API key in the Authorization header. On a TLS-intercepting
        # corporate network, trust the corporate CA via SSL_CERT_FILE /
        # REQUESTS_CA_BUNDLE (honored by the SDK's httpx transport) instead of
        # weakening verification.
        self._client = OpenAI(api_key=self.api_key, base_url=self.endpoint)
        return self._client

    def _embed_with_retry(self, batch: Sequence[str]) -> List[List[float]]:
        if _HAS_TENACITY:
            retryer = retry(
                reraise=True,
                stop=stop_after_attempt(6),
                wait=lambda state: _retry_delay(state.outcome.exception(), state.attempt_number),
                retry=retry_if_exception(_is_retryable),
            )
            wrapped = retryer(self._embed_once)
            return wrapped(batch)
        last_exc: Optional[Exception] = None
        for attempt in range(6):  # pragma: no cover - fallback branch
            try:
                return self._embed_once(batch)
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                if not _is_retryable(exc):
                    raise
                time.sleep(_retry_delay(exc, attempt + 1))
        assert last_exc is not None
        raise last_exc

    def _embed_once(self, batch: Sequence[str]) -> List[List[float]]:
        client = self._ensure_client()
        response = client.embeddings.create(
            model=self.model,
            input=list(batch),
            dimensions=self.dimensions,
        )
        data = getattr(response, "data", None)
        if data is None and isinstance(response, dict):
            data = response.get("data", [])
        if data is None:
            raise RuntimeError("OpenAI embeddings response had no 'data'")
        vectors: List[List[float]] = []
        for item in data:
            emb = getattr(item, "embedding", None)
            if emb is None and isinstance(item, dict):
                emb = item.get("embedding")
            if emb is None:
                raise RuntimeError("embedding entry missing 'embedding' field")
            vectors.append(list(emb))
        return vectors


# ======================================================================
# Factory — single entry point for indexer/worker
# ======================================================================
def create_embedding_client(
    provider: str = DEFAULT_PROVIDER,
    model: Optional[str] = None,
    *,
    api_key: Optional[str] = None,
    endpoint: Optional[str] = None,
    api_version: Optional[str] = None,
    dimensions: Optional[int] = None,
    batch_size: Optional[int] = None,
    target_rpm: int = DEFAULT_TARGET_RPM,
    client_factory: Optional[Callable[[], Any]] = None,
    egress_broker_url: Optional[str] = None,
    egress_broker_uds: Optional[str] = None,
    egress_token: Optional[str] = None,
) -> Any:
    """Factory: return an ``OpenAIEmbeddingClient`` for the chosen provider.

    Supported providers are exactly ``{openai, azure}`` (the same set the
    worker argparse, the TS ``resolveEmbeddingProvider``, and the manifest
    ``configSchema.embeddingProvider`` enum accept). Any other value is a
    config-contract violation and raises ``ValueError``.

    provider ``openai`` → OpenAIEmbeddingClient (api.openai.com or any
                          OpenAI-compatible base URL via ``endpoint``)
    provider ``azure``  → OpenAIEmbeddingClient w/ AzureOpenAI backend.
                          ``endpoint`` is the resource URL and ``model``
                          is the Azure deployment name.
    """
    p = (provider or DEFAULT_PROVIDER).strip().lower()
    if p == "openai":
        return OpenAIEmbeddingClient(
            api_key=api_key,
            model=model or DEFAULT_OPENAI_MODEL,
            dimensions=dimensions or DEFAULT_OPENAI_DIMENSIONS,
            batch_size=batch_size or 100,
            target_rpm=target_rpm,
            endpoint=endpoint,
            api_version=api_version,
            use_azure=False,
            client_factory=client_factory,
            egress_broker_url=egress_broker_url,
            egress_broker_uds=egress_broker_uds,
            egress_token=egress_token,
        )
    if p == "azure":
        return OpenAIEmbeddingClient(
            api_key=api_key,
            model=model or DEFAULT_OPENAI_MODEL,
            dimensions=dimensions or DEFAULT_OPENAI_DIMENSIONS,
            batch_size=batch_size or 100,
            target_rpm=target_rpm,
            endpoint=endpoint,
            api_version=api_version,
            use_azure=True,
            client_factory=client_factory,
            egress_broker_url=egress_broker_url,
            egress_broker_uds=egress_broker_uds,
            egress_token=egress_token,
        )
    raise ValueError(
        f"Unknown embedding provider: {provider!r} (expected 'openai' or 'azure')"
    )


# ----------------------------------------------------------------------
# Retry helpers (OpenAI path only)
# ----------------------------------------------------------------------
def _is_retryable(exc: Exception) -> bool:
    return getattr(exc, "status_code", None) in (429, 502, 503, 504)


def _retry_delay(exc: Exception, attempt: int) -> float:
    if getattr(exc, "status_code", None) == 429:
        response = getattr(exc, "response", None)
        headers = getattr(response, "headers", {})
        try:
            return max(0.0, min(float(headers.get("retry-after", 1)), 5.0))
        except (TypeError, ValueError):
            pass
    return float(min(2 ** max(0, attempt - 1), 60))


def _info(logger: Any, event: str, **fields: Any) -> None:
    """structlog or stdlib logging compatible info call."""
    try:
        logger.info(event, **fields)  # structlog signature
    except TypeError:
        logger.info("%s %s", event, fields)


__all__ = [
    "OpenAIEmbeddingClient",
    "create_embedding_client",
    "DEFAULT_PROVIDER",
    "DEFAULT_OPENAI_MODEL",
    "DEFAULT_OPENAI_DIMENSIONS",
    "DEFAULT_BATCH_SIZE",
    "DEFAULT_TARGET_RPM",
]
