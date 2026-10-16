#!/usr/bin/env python3
"""Ave Local Indexer worker - FastAPI + uvicorn.

Routes (14)
-----------
    GET  /health
    GET  /runtime/info
    POST /runtime/allowed_roots
    POST /indexer/reindex
    POST /indexer/reconcile
    GET  /documents
    GET  /document
    GET  /structure
    GET  /page-content
    POST /search/bm25
    POST /search/vector
    POST /search/hybrid
    GET  /metrics
    POST /shutdown

``/indexer/reindex`` is the sole ingestion route: each call indexes one
file synchronously and returns its result. ``asyncio.Lock`` serialises
the actual ``index_file`` call because sqlite + lance are not re-entrant,
so concurrent reindex calls from the Electron host cannot race each other.

Production behaviour lives in :mod:`worker.local_indexer` and
:mod:`worker.local_indexer_search`. If an optional dependency is missing
the worker fails fast on startup with a descriptive error rather than
silently downgrading to a mock.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import os
import re
import secrets
import signal
import stat
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

# Validate page expressions with a ReDoS-safe character class.
# Allowed examples: "5", "5-7", "5,7,9", "5-7,10,12-14". Max length 200.
_PAGES_RE = re.compile(r"^[\d,\-\s]{1,200}$")

# Security A1 fix: inject the /shutdown token via env to avoid stdout leakage.
# If the host (localIndexerPlugin.ts) supplies `AVE_SHUTDOWN_TOKEN`, use it.
# Otherwise generate a random dev token without emitting it to stdout.
# Pop the env var immediately so it is not propagated to child processes.
_PROVIDED_SHUTDOWN_TOKEN = os.environ.pop("AVE_SHUTDOWN_TOKEN", "")
SHUTDOWN_TOKEN = _PROVIDED_SHUTDOWN_TOKEN or secrets.token_urlsafe(32)
_TOKEN_FROM_ENV = bool(_PROVIDED_SHUTDOWN_TOKEN)

# Ensure the worker directory is importable whether launched from the
# repository root or from inside the extraResources bundle.
_WORKER_DIR = Path(__file__).resolve().parent
if str(_WORKER_DIR.parent) not in sys.path:
    sys.path.insert(0, str(_WORKER_DIR.parent))
if str(_WORKER_DIR) not in sys.path:
    sys.path.insert(0, str(_WORKER_DIR))

try:  # pragma: no cover - optional dependency branch
    import structlog  # type: ignore

    # IMPORTANT: route worker logs to STDOUT, not stderr.
    # The host's `onWorkerStdout` parser
    # (`src/hostPlugin.ts:handleWorkerStdoutLine`) reads JSON event lines —
    # `indexer.caption.failed`, `indexer.file.empty`, etc. — and pumps them
    # into `index.warning` events that the UI subscribes to. structlog's
    # default `PrintLoggerFactory()` writes to stderr, so the host parser
    # never sees those events and the UI warning banner stays empty even
    # while the worker logs steady failures. `WriteLoggerFactory(sys.stdout)`
    # is the canonical way to flip the stream.
    structlog.configure(
        processors=[
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ],
        logger_factory=structlog.WriteLoggerFactory(file=sys.stdout),
    )
    log = structlog.get_logger("local-indexer.worker")
except Exception:  # pragma: no cover
    # Same reason as above for the fallback path: `logging.basicConfig`
    # defaults to `sys.stderr`. Force the worker's stdlib logger onto stdout.
    logging.basicConfig(level=logging.INFO, stream=sys.stdout)
    log = logging.getLogger("local-indexer.worker")


try:
    from fastapi import Depends, FastAPI, Header, HTTPException
    from pydantic import BaseModel, Field, field_validator, model_validator
    import uvicorn
except Exception as exc:  # pragma: no cover - startup guard
    sys.stderr.write(
        "fastapi/uvicorn/pydantic import failed. python-requirements.lock via "
        "uv venv must be ready before the worker spawns.\n"
        f"details: {exc}\n"
    )
    raise

# Relative imports from the worker package.
from local_indexer import IndexResult, LocalIndexer  # type: ignore  # noqa: E402
from local_indexer_search import SearchService  # type: ignore  # noqa: E402


def _warning(event: str, **fields: Any) -> None:
    try:
        log.warning(event, **fields)
    except TypeError:
        log.warning("%s %s", event, fields)


# ----------------------------------------------------------------------
# Pydantic models
# ----------------------------------------------------------------------

# Security A3 fix: constrain file_path to allowed roots to block traversal.
# Roots come from AVE_INDEX_ALLOWED_ROOTS or the default three locations.
_ALLOWED_ROOTS_ENV = "AVE_INDEX_ALLOWED_ROOTS"


# Runtime override for allowed roots. When the host adds/removes scan folders
# at runtime via `POST /runtime/allowed_roots`, this variable is replaced so
# `_validate_file_path_within_roots` accepts the newly-added paths without a
# worker restart. `None` means "fall back to env / defaults".
_ALLOWED_ROOTS_RUNTIME: Optional[List[str]] = None


def _normalise_roots(paths: List[str]) -> List[str]:
    roots: List[str] = []
    for p in paths:
        if not isinstance(p, str):
            continue
        p = p.strip()
        if not p:
            continue
        try:
            roots.append(os.path.realpath(os.path.expanduser(p)))
        except Exception:
            continue
    # Deduplicate while preserving order.
    seen: set[str] = set()
    unique: List[str] = []
    for r in roots:
        if r not in seen:
            seen.add(r)
            unique.append(r)
    return unique


def _get_allowed_roots() -> List[str]:
    # Runtime override takes priority so the host can update roots without
    # restarting the Python subprocess.
    if _ALLOWED_ROOTS_RUNTIME is not None:
        return list(_ALLOWED_ROOTS_RUNTIME)
    raw = os.environ.get(_ALLOWED_ROOTS_ENV, "")
    if raw:
        roots = _normalise_roots(raw.split(os.pathsep))
        if roots:
            return roots
    home = os.path.expanduser("~")
    return [
        os.path.realpath(os.path.join(home, "Documents")),
        os.path.realpath(os.path.join(home, "Desktop")),
        os.path.realpath(os.path.join(home, ".ave")),
    ]


def _validate_file_path_within_roots(v: str) -> str:
    if not v or not isinstance(v, str):
        raise ValueError("file_path must be a non-empty string")
    if len(v) > 4096:
        raise ValueError("file_path too long (max 4096 chars)")
    real = os.path.realpath(os.path.expanduser(v))
    allowed = _get_allowed_roots()
    for root in allowed:
        try:
            if os.path.commonpath([real, root]) == root:
                return real
        except ValueError:
            continue
    raise ValueError(f"file_path outside allowed roots: {real}")


class ReindexRequest(BaseModel):
    file_path: str = Field(..., min_length=1, max_length=4096)
    mode: str = Field(
        "auto",
        pattern=r"^(auto|pdf|md|markdown|txt|html|docx|pptx|xlsx|image)$",
    )

    @field_validator("file_path")
    @classmethod
    def _validate_path(cls, v: str) -> str:
        return _validate_file_path_within_roots(v)


class SearchRequest(BaseModel):
    query: str = Field(..., min_length=1)
    topK: int = Field(20, ge=1, le=200)


class AllowedRootsRequest(BaseModel):
    # Absolute paths the host wants to whitelist for indexing.
    # Non-string / empty entries are dropped in `_normalise_roots`.
    roots: List[str] = Field(..., max_length=256)


class DeleteDocumentRequest(BaseModel):
    doc_id: str = Field(..., min_length=1, max_length=512)


class SetEgressTokenRequest(BaseModel):
    """Request body for the /indexer/set_egress_token endpoint.

    The host calls this once at index_scan entry to push the worker's outbound
    credential captured at scan start. With a host-mediated egress broker
    (P3 ⑬) the value is the per-session BROKER TOKEN (presented as
    ``x-ave-egress-token``; the broker injects the real provider auth). On the
    legacy no-broker path it is the embedding API key itself. Either way it is
    locked in for the lifetime of the scan so a mid-scan toggle change cannot
    reload the embedding client with a different credential.

    (Renamed from SetEmbeddingApiKeyRequest / ``api_key`` for honesty — the
    worker↔host contract moves together in the same single-repo change.)
    """

    token: str = Field(..., min_length=1, max_length=1024)


class SetImageCaptioningRequest(BaseModel):
    """Toggle for the indexer's image-captioning pass.

    Worker boots with image captioning OFF. The host flips this through
    the UI; subsequent reindex calls observe the new state. The
    settings are *not* persisted on the worker side — the host's
    configSchema is the source of truth and the host pushes the value
    again on every worker restart via this endpoint.

    ``model`` / ``endpoint`` / ``api_version`` are tri-state:

    * omitted / ``null`` — keep the worker's current value;
    * ``""`` — reset to the provider default;
    * non-empty — set.

    The host reads all three from its config on every push, so it sends
    ``""`` for an unset field rather than omitting it — that is what lets a
    provider switch drop the previous provider's model and endpoint.
    """

    enabled: bool
    provider: str = Field(
        "openai",
        pattern=r"^(openai|azure-openai-chat|azure-openai-responses)$",
    )
    model: Optional[str] = Field(None, max_length=128)
    # Captioning endpoint URL — shared across cloud providers. For the
    # Azure providers it is the resource root
    # (``https://<resource>.openai.azure.com/``); for ``provider="openai"``
    # it is an optional OpenAI-compatible base URL (``""`` -> SDK default).
    endpoint: Optional[str] = Field(None, max_length=2048)
    # ``""`` keeps the current key: the host omits the credential on pushes
    # that only change the toggle, and a secret has no "provider default"
    # to reset to.
    api_key: str = Field("", max_length=1024)
    # Azure OpenAI-only api-version 쿼리 값. endpoint 가 root URL 일 때만 사용 —
    # full URL 이면 endpoint 의 쿼리가 우선이므로 본 필드는 무시된다.
    # ``""`` 는 image_captioner 의 provider 별 모듈 디폴트 적용.
    api_version: Optional[str] = Field(None, max_length=64)

    @model_validator(mode="after")
    def _validate_model_for_provider(self) -> "SetImageCaptioningRequest":
        _validate_caption_model_or_raise(self.provider, self.model)
        return self


class CaptionImageRequest(BaseModel):
    """Request body for the /indexer/caption_image endpoint.

    Host calls this for files routed through the image-embedding toggle.
    The endpoint returns only the caption text (a string) — feeding that
    caption into the embedding pipeline is the host's job because the
    embedding client already lives in the existing index path.
    """

    file_path: str = Field(..., min_length=1, max_length=4096)
    provider: str = Field(
        "openai",
        pattern=r"^(openai|azure-openai-chat|azure-openai-responses)$",
    )
    # Empty string -> provider default (gpt-4.1-mini for openai; Azure has
    # no default — the deployment name is required).
    model: str = Field("", max_length=128)
    # Captioning endpoint URL (Azure required, OpenAI optional override)
    # and the API key for the chosen provider. The worker prefers these
    # when present, else falls back to its persisted state (OpenAI key
    # from boot, etc.). Azure endpoint accepts either a root URL or a
    # full URL with path/query — worker uses the latter verbatim.
    endpoint: str = Field("", max_length=2048)
    api_key: str = Field("", max_length=1024)
    # Azure-only api-version 쿼리. Root endpoint 일 때만 사용 — full URL
    # 이면 endpoint 의 쿼리가 우선.
    api_version: str = Field("", max_length=64)

    @field_validator("file_path")
    @classmethod
    def _validate_path(cls, v: str) -> str:
        return _validate_file_path_within_roots(v)

    @model_validator(mode="after")
    def _validate_model_for_provider(self) -> "CaptionImageRequest":
        _validate_caption_model_or_raise(self.provider, self.model)
        return self


def _validate_caption_model_or_raise(provider: str, model: Optional[str]) -> None:
    """Apply ``image_captioner.validate_caption_model`` at the HTTP boundary.

    One rule for both boundaries: the request models reject with 422 what
    the in-process index path would reject with ``CaptionError``. Empty /
    ``None`` is not validated here because its meaning (keep vs. reset)
    belongs to the request model, not to the naming rule.
    """
    if not model:
        return
    from worker.image_captioner import (  # local import keeps cold-start light
        CaptionError,
        validate_caption_model,
    )

    try:
        validate_caption_model(provider, model)
    except CaptionError as exc:
        raise ValueError(str(exc)) from exc


# ----------------------------------------------------------------------
# App state container
# ----------------------------------------------------------------------
class AppState:
    def __init__(
        self,
        *,
        indexer: LocalIndexer,
        search: SearchService,
        runtime_info: Dict[str, Any],
        openai_api_key: str = "",
    ) -> None:
        self.indexer = indexer
        self.search = search
        self.runtime_info = runtime_info
        # Stored separately from runtime_info because /runtime/info echoes
        # the whole dict to the host — keeping the key out of that surface
        # avoids leaking it through a normally-read-only endpoint.
        self.openai_api_key = openai_api_key
        # Serialises index_file calls — sqlite + lance are not re-entrant, so
        # concurrent /indexer/reindex requests must not run their writes in
        # parallel.
        self.lock = asyncio.Lock()
        self.started_at = time.time()
        # uvicorn Server instance - populated in main() so that _request_shutdown
        # can flip should_exit for a graceful shutdown (atexit + WAL checkpoint).
        self.server: Optional[Any] = None
        self.metrics: Dict[str, Any] = {
            "processed": 0,
            "failed": 0,
            "search_bm25": 0,
            "search_vector": 0,
            "search_hybrid": 0,
        }

    def close_storage(self) -> None:
        for name, owner in (("indexer", self.indexer), ("search", self.search)):
            close = getattr(owner, "close", None)
            if not callable(close):
                continue
            try:
                close()
            except Exception as exc:  # pragma: no cover - defensive cleanup log
                _warning("shutdown.storage_close_failed", component=name, error=str(exc))


def create_app(state: AppState) -> FastAPI:
    app = FastAPI(title="ave-local-indexer-worker", version="1.0.0")

    def _require_write_token(x_ave_shutdown_token: str = Header(default="")) -> None:
        if not secrets.compare_digest(x_ave_shutdown_token, SHUTDOWN_TOKEN):
            raise HTTPException(status_code=403, detail="invalid write token")

    # ----- POST /runtime/auth_check -----------------------------------
    # Plugin-side worker-reuse path probes /health (unauthenticated) to
    # detect a live listener on the port, then needs to confirm that the
    # listener really is OUR worker (not an unrelated process that
    # happens to answer /health 200) before binding the saved shutdown
    # token to the worker client. /health alone is not sufficient — any
    # local process could spoof it. /runtime/auth_check requires the
    # write token; a 200 response proves the responder shares the token,
    # which is only true for the worker we spawned. The endpoint is
    # idempotent and has no side effects.
    @app.post(
        "/runtime/auth_check",
        dependencies=[Depends(_require_write_token)],
    )
    async def runtime_auth_check() -> Dict[str, Any]:
        return {"ok": True, "data": {"pid": os.getpid()}}

    # ----- GET /health -------------------------------------------------
    @app.get("/health")
    async def health() -> Dict[str, Any]:
        return {"ok": True, "data": {"status": "ok", "uptime_s": time.time() - state.started_at}}

    # ----- GET /runtime/info ------------------------------------------
    @app.get("/runtime/info", dependencies=[Depends(_require_write_token)])
    async def runtime_info() -> Dict[str, Any]:
        return {"ok": True, "data": state.runtime_info}

    # ----- POST /runtime/allowed_roots --------------------------------
    # Updates the in-process allowed-roots override so the host can widen
    # the indexing whitelist at runtime (e.g. after `index_add_folder`)
    # without restarting the worker. Authenticated with the same shared
    # shutdown token so only the owning host can mutate it.
    @app.post("/runtime/allowed_roots")
    async def runtime_set_allowed_roots(
        req: AllowedRootsRequest,
        x_ave_shutdown_token: str = Header(default=""),
    ) -> Dict[str, Any]:
        if not secrets.compare_digest(x_ave_shutdown_token, SHUTDOWN_TOKEN):
            raise HTTPException(status_code=403, detail="invalid shutdown token")
        global _ALLOWED_ROOTS_RUNTIME
        normalised = _normalise_roots(req.roots)
        if not normalised:
            raise HTTPException(status_code=422, detail="roots must contain at least one valid path")
        _ALLOWED_ROOTS_RUNTIME = normalised
        try:
            log.info("runtime.allowed_roots.updated", count=len(normalised))
        except TypeError:
            log.info("runtime.allowed_roots.updated count=%s", len(normalised))
        return {"ok": True, "data": {"roots": normalised, "count": len(normalised)}}

    # ----- POST /indexer/reindex --------------------------------------
    @app.post("/indexer/reindex", dependencies=[Depends(_require_write_token)])
    async def indexer_reindex(req: ReindexRequest) -> Dict[str, Any]:
        async with state.lock:
            try:
                result = await asyncio.to_thread(
                    state.indexer.reindex, req.file_path, req.mode
                )
                state.metrics["processed"] += 1
                return {"ok": True, "data": _result_dict(result)}
            except FileNotFoundError as exc:
                state.metrics["failed"] += 1
                raise HTTPException(status_code=404, detail=str(exc))
            except Exception as exc:
                state.metrics["failed"] += 1
                log.exception("indexer.reindex.error")
                raise HTTPException(status_code=500, detail=str(exc))

    # ----- POST /indexer/reconcile ------------------------------------
    # Boot reconcile pass: detect + normalise SQLite↔LanceDB vector drift left
    # by a crash between index_file's sqlite commit and the Lance upsert. This
    # is DETECT + normalise only (no embedding), so it is key-free — the shared
    # write token still gates it like every other route, but no embedding API
    # key is needed to run it. Returns the drifted doc list so the host can heal
    # them with a bounded reindex AFTER the warmup key push. Held under the same
    # lock as reindex because it deletes orphan Lance rows + rewrites sqlite
    # state, which must not interleave with a concurrent index_file.
    @app.post("/indexer/reconcile", dependencies=[Depends(_require_write_token)])
    async def indexer_reconcile() -> Dict[str, Any]:
        async with state.lock:
            try:
                report = await asyncio.to_thread(state.indexer.reconcile)
                return {"ok": True, "data": report}
            except Exception as exc:
                log.exception("indexer.reconcile.error")
                raise HTTPException(status_code=500, detail=str(exc))

    # ----- GET /documents ---------------------------------------------
    @app.get("/documents", dependencies=[Depends(_require_write_token)])
    async def documents() -> Dict[str, Any]:
        docs = await asyncio.to_thread(state.indexer.list_documents)
        return {"ok": True, "data": docs}

    # ----- GET /document ----------------------------------------------
    @app.get("/document", dependencies=[Depends(_require_write_token)])
    async def document(doc_id: str) -> Dict[str, Any]:
        doc = await asyncio.to_thread(state.indexer.get_document, doc_id)
        if not doc:
            raise HTTPException(status_code=404, detail=f"Document {doc_id} not found")
        return {"ok": True, "data": doc}

    # ----- POST /documents/delete -------------------------------------
    @app.post("/documents/delete", dependencies=[Depends(_require_write_token)])
    async def documents_delete(req: DeleteDocumentRequest) -> Dict[str, Any]:
        removed = await asyncio.to_thread(state.indexer.remove_document, req.doc_id)
        return {"ok": True, "data": {"removed": removed, "doc_id": req.doc_id}}

    # ----- GET /structure ---------------------------------------------
    @app.get("/structure", dependencies=[Depends(_require_write_token)])
    async def structure(doc_id: str) -> Dict[str, Any]:
        data = await asyncio.to_thread(state.search.get_document_structure, doc_id)
        return {"ok": True, "data": data}

    # ----- GET /page-content ------------------------------------------
    @app.get("/page-content", dependencies=[Depends(_require_write_token)])
    async def page_content(doc_id: str, pages: str) -> Dict[str, Any]:
        # Validate the page expression with a 200-char whitelist.
        if not _PAGES_RE.match(pages):
            raise HTTPException(
                status_code=400,
                detail="invalid pages expression (expected digits, comma, dash, space; <=200 chars)",
            )
        data = await asyncio.to_thread(state.search.get_page_content, doc_id, pages)
        return {"ok": True, "data": data}

    # ----- POST /search/bm25 ------------------------------------------
    @app.post("/search/bm25", dependencies=[Depends(_require_write_token)])
    async def search_bm25(req: SearchRequest) -> Dict[str, Any]:
        state.metrics["search_bm25"] += 1
        hits = await asyncio.to_thread(state.search.search_bm25, req.query, req.topK)
        return {"ok": True, "data": hits}

    # ----- POST /search/vector ----------------------------------------
    @app.post("/search/vector", dependencies=[Depends(_require_write_token)])
    async def search_vector(req: SearchRequest) -> Dict[str, Any]:
        state.metrics["search_vector"] += 1
        hits = await asyncio.to_thread(state.search.search_vector, req.query, req.topK)
        return {"ok": True, "data": hits}

    # ----- POST /search/hybrid ----------------------------------------
    @app.post("/search/hybrid", dependencies=[Depends(_require_write_token)])
    async def search_hybrid(req: SearchRequest) -> Dict[str, Any]:
        state.metrics["search_hybrid"] += 1
        hits = await asyncio.to_thread(
            state.search.search_hybrid_internal, req.query, req.topK
        )
        return {"ok": True, "data": hits}

    # ----- POST /indexer/set_image_captioning -------------------------
    @app.post(
        "/indexer/set_image_captioning",
        dependencies=[Depends(_require_write_token)],
    )
    async def indexer_set_image_captioning(
        req: SetImageCaptioningRequest,
    ) -> Dict[str, Any]:
        state.indexer.set_image_captioning(
            enabled=req.enabled,
            provider=req.provider,
            model=req.model,
            endpoint=req.endpoint,
            api_key=req.api_key,
            api_version=req.api_version,
        )
        return {
            "ok": True,
            "data": state.indexer.get_image_captioning(),
        }

    # ----- POST /indexer/set_egress_token ----------------------------
    @app.post(
        "/indexer/set_egress_token",
        dependencies=[Depends(_require_write_token)],
    )
    async def indexer_set_egress_token(
        req: SetEgressTokenRequest,
    ) -> Dict[str, Any]:
        # Feed ALL THREE credential consumers, not just the indexer. The env key
        # channel was removed, so this push is the only path the credential
        # reaches the worker. In broker mode the value is the per-session token;
        # in legacy mode it is the embedding key. The indexer needs it for
        # embedding-at-index; the SearchService needs it for query-time vector
        # search (which runs outside any index_scan window); AppState.openai_api_key
        # backs the caption fallback. Updating only the indexer (the old
        # behaviour) would leave query-time vector search silently degraded.
        state.indexer.set_embedding_api_key(req.token)
        state.search.set_embedding_api_key(req.token)
        state.openai_api_key = req.token
        return {"ok": True, "data": {"hasEmbeddingKey": True}}

    # ----- POST /indexer/caption_image --------------------------------
    @app.post(
        "/indexer/caption_image",
        dependencies=[Depends(_require_write_token)],
    )
    async def indexer_caption_image(req: CaptionImageRequest) -> Dict[str, Any]:
        """Caption a single image file via the requested provider.

        Provider routing lives in ``worker.image_captioner``. The endpoint
        runs the captioning call on a thread to keep the event loop free
        while the provider round-trip is in flight.
        Auth: requires the shared write token (same as reindex).
        """
        from worker.image_captioner import (  # local import keeps cold-start light
            CaptionError,
            caption_image,
        )

        # Broker mode (P3 ⑬): the stored credential is the per-session token, the
        # endpoint is the broker caption channel, and the OPENAI_API_KEY dev
        # opt-in is GATED OFF (an env key would bypass the broker). Legacy mode:
        # prefer the request-supplied credential, then the worker's stored key
        # (``state.openai_api_key`` — set by the runtime token push, not env),
        # then the OPENAI_API_KEY dev opt-in.
        if state.indexer.egress_brokered:
            egress_token = req.api_key or state.openai_api_key or None
            caption_api_key: Optional[str] = None
            caption_endpoint: Optional[str] = state.indexer.egress_caption_url
        else:
            egress_token = None
            caption_api_key = (
                req.api_key
                or state.openai_api_key
                or os.environ.get("OPENAI_API_KEY")
                or ""
            ) or None
            caption_endpoint = req.endpoint or None
        try:
            result = await asyncio.to_thread(
                caption_image,
                req.file_path,
                req.provider,  # type: ignore[arg-type]
                req.model or None,
                caption_api_key,
                caption_endpoint,
                req.api_version or None,
                egress_token,
            )
        except CaptionError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except Exception as exc:  # pragma: no cover - defensive
            raise HTTPException(status_code=500, detail=f"caption_image failed: {exc}")

        return {
            "ok": True,
            "data": {
                "file_path": req.file_path,
                "caption": result.caption,
                "provider": result.provider,
                "model": result.model,
                "input_tokens": result.input_tokens,
                "output_tokens": result.output_tokens,
            },
        }

    # ----- GET /metrics -----------------------------------------------
    @app.get("/metrics", dependencies=[Depends(_require_write_token)])
    async def metrics() -> Dict[str, Any]:
        return {
            "ok": True,
            "data": {
                **state.metrics,
                "uptime_s": time.time() - state.started_at,
            },
        }

    # ----- POST /shutdown ---------------------------------------------
    @app.post("/shutdown")
    async def shutdown(
        x_ave_shutdown_token: str = Header(default=""),
    ) -> Dict[str, Any]:
        # Verify the per-process token to block external shutdowns.
        if not secrets.compare_digest(x_ave_shutdown_token, SHUTDOWN_TOKEN):
            raise HTTPException(status_code=403, detail="invalid shutdown token")
        log.info("shutdown.requested")
        # Scrub the embedding key from worker memory on shutdown (timing =
        # shutdown/rotation, NOT scan end — the key must stay resident while
        # search can run). Clears the indexer + search caches and the AppState
        # copy that backs the caption fallback.
        state.indexer.clear_embedding_key()
        state.search.clear_embedding_key()
        state.openai_api_key = ""
        state.close_storage()
        loop = asyncio.get_running_loop()
        loop.call_later(0.1, lambda: _request_shutdown(state))
        return {"ok": True, "data": {"bye": True}}

    return app


def _result_dict(result: IndexResult) -> Dict[str, Any]:
    return {
        "doc_id": result.doc_id,
        "doc_name": result.doc_name,
        "doc_type": result.doc_type,
        "chunk_count": result.chunk_count,
        "status": result.status,
        "page_count": result.page_count,
        "line_count": result.line_count,
        "errors": result.errors,
        # 임베딩 성공 여부 — 플러그인은 embedded=false 면 (status="indexed"
        # 이더라도) 사용자 입장에선 실패로 본다. None 은 옛 워커 호환용
        # (필드 미존재) 으로만 발생.
        "embedded": result.embedded,
        # True 면 content-hash 가 일치해 임베딩/persist 를 건너뛰고 mtime 만
        # 갱신한 short-circuit (기존 청크/벡터 재사용). 관측/디버깅용.
        "unchanged": result.unchanged,
    }


def _request_shutdown(state: Optional[AppState] = None) -> None:
    """Graceful shutdown - uvicorn Server.should_exit triggers proper cleanup.

    Avoids ``os._exit(0)`` because it skips atexit hooks, SQLite WAL
    checkpoint, and lance flush. Falling back to SIGTERM only if the
    server instance is not attached yet (very early shutdown request).
    """
    srv = state.server if state is not None else None
    if srv is not None:
        try:
            srv.should_exit = True
            return
        except Exception:  # pragma: no cover - defensive
            pass
    try:
        os.kill(os.getpid(), signal.SIGTERM)
    except Exception:  # pragma: no cover - last resort
        os._exit(0)


def arm_host_liveness_watchdog(
    server: Any,
    *,
    stdin_fd: int = 0,
    exit_fn: Any = os._exit,
    grace_seconds: float = 5.0,
) -> bool:
    """Exit with the host instead of outliving it.

    The host hands the worker its stdin as a liveness pipe: it never carries
    bytes and the OS closes it only when the host process is gone, in every
    death mode (SIGTERM, crash, ``kill``). Without this the worker is
    reparented to the init process and serves forever after the host dies.

    Whether the pipe exists is read from the handle itself, not from a
    flag. The host (Node/libuv, ``stdio: "pipe"``) hands the child one end of
    a ``socketpair(AF_UNIX)`` on macOS and Linux and a named pipe on Windows,
    which CPython's ``os.fstat`` reports as ``S_IFIFO`` (``GetFileType`` ==
    ``FILE_TYPE_PIPE``); a FIFO from any other spawner is the same contract.
    All of these reach EOF only when their peer (the host) is gone. A
    character device (``/dev/null``, ``NUL``) is the one shape that means
    "no liveness contract": it reaches EOF immediately, so a watchdog on it
    would kill the worker at startup.

    Returns True when armed. On EOF the server is asked to stop the way
    ``/shutdown`` does (WAL checkpoint, storage close); ``exit_fn`` runs
    after ``grace_seconds`` so a wedged server still exits.
    """
    mode = os.fstat(stdin_fd).st_mode
    if not (stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode)):
        return False

    def _watch() -> None:
        # Data never arrives on this pipe; only EOF (b"") means the host is
        # gone. os.read returns b"" on peer close for a socket end as well.
        # A read error (EBADF when the fd is closed underneath, a broken-pipe
        # variant on some runtimes) means the handle is no longer a liveness
        # signal at all. The only safe reading of a signal that has gone silent
        # is "host gone": letting the thread die on the error would recreate
        # the orphan this watchdog exists to prevent.
        read_error: Optional[OSError] = None
        try:
            while os.read(stdin_fd, 1):
                pass
        except OSError as exc:
            read_error = exc
        # Effects first, log last. The worker's stdout is the host's pipe as
        # well, so once the host is gone a log write has no reader and can
        # raise (BrokenPipeError); a thread that died there would never have
        # asked the server to stop. Nothing after the host's death is worth a
        # failed exit, so the log is best-effort. uvicorn's own shutdown
        # logging can fail the same way, which is what the exit_fn backstop
        # is for.
        server.should_exit = True
        timer = threading.Timer(grace_seconds, lambda: exit_fn(0))
        timer.daemon = True
        timer.start()
        try:
            if read_error is None:
                log.info("worker.host_gone")
            else:
                _warning("worker.host_gone", error=str(read_error))
        except Exception:
            pass

    threading.Thread(target=_watch, name="host-liveness-watchdog", daemon=True).start()
    return True


# ----------------------------------------------------------------------
# Entrypoint
# ----------------------------------------------------------------------
def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Ave Local Indexer local worker")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=43129)
    # 호스트-중재 confinement 채널. 호스트가 ASRT-confined spawn 시 bind-mount된
    # Unix-domain socket 경로를 주입한다. 설정되면 TCP 대신 UDS로만 HTTP를 서빙해
    # loopback 포트를 열지 않는다 (gate-OFF / win32 legacy 시 None → host/port 경로).
    parser.add_argument(
        "--uds",
        default=None,
        help="Unix-domain socket path to bind the control server (host-mediated confinement). "
        "When set, --host/--port are ignored.",
    )
    parser.add_argument("--workspace", default=os.path.expanduser("~/.ave/local-indexer/workspace"))
    # --db is a legacy alias for --sqlite (kept for e2e + older callers).
    parser.add_argument(
        "--sqlite",
        "--db",
        dest="sqlite",
        default=os.path.expanduser("~/.ave/local-indexer/fts5.sqlite"),
        help="SQLite path (alias: --db)",
    )
    parser.add_argument("--lance", default=os.path.expanduser("~/.ave/local-indexer/vectors.lance"))
    parser.add_argument("--model", default="gpt-4o-mini")
    # Cloud embeddings. Supported set is exactly {openai, azure} — kept in sync
    # with create_embedding_client and the manifest configSchema enum.
    parser.add_argument(
        "--embedding-provider",
        choices=["openai", "azure"],
        default="openai",
        help="embedding provider - openai or azure (Azure OpenAI Service)",
    )
    parser.add_argument(
        "--embedding-model",
        default="text-embedding-3-small",
        help="model name (OpenAI model name for openai, deployment name for azure)",
    )
    parser.add_argument(
        "--embedding-endpoint",
        default="",
        help="OpenAI-compatible base URL (for provider=openai, optional) or Azure OpenAI resource URL (for provider=azure, required)",
    )
    parser.add_argument(
        "--embedding-api-version",
        default="",
        help="Azure embeddings api-version override; empty -> worker default or endpoint query param",
    )
    parser.add_argument(
        "--egress-broker-url",
        default="",
        help="Host-mediated egress broker base URL (P3 ⑬). When set, ALL provider "
        "egress (embeddings + captioning) is routed through the broker "
        "(<base>/egress/embedding, <base>/egress/caption) and the worker holds "
        "only the per-session token (pushed via /indexer/set_egress_token), never "
        "the provider key. --embedding-endpoint is ignored in this mode (the broker "
        "holds the real endpoint host-side).",
    )
    parser.add_argument(
        "--egress-broker-uds",
        default="",
        help="Filesystem path of the broker's Unix-domain socket, on the platforms "
        "that bind one. There the broker does not listen on loopback TCP — a plugin "
        "loaded in a confined child cannot bind loopback (refused on macOS; on "
        "Linux it binds into a network namespace this worker is not in) — so "
        "--egress-broker-url is only the authority the provider SDKs insist on "
        "parsing and THIS is what decides where the bytes go. Absent on Windows, "
        "where listen(path) makes a named pipe rather than a Unix socket: the "
        "broker binds loopback TCP there and --egress-broker-url carries the real "
        "bound address.",
    )
    parser.add_argument(
        "--embedding-dimensions",
        type=int,
        default=None,
        help="explicit dim override (default: auto-detect from model)",
    )
    parser.add_argument("--batch-rpm", type=int, default=400)
    parser.add_argument("--disable-vector", action="store_true")
    parser.add_argument(
        "--max-file-size",
        type=int,
        default=50 * 1024 * 1024,  # 50 MB
        help="maximum file size in bytes; files larger than this are recorded as status='failed' "
        "(default: 52428800 = 50 MB, 0 = no limit)",
    )
    parser.add_argument(
        "--max-chunks-per-doc",
        type=int,
        default=2000,
        help="maximum chunks per document; documents producing more chunks are truncated to "
        "this cap and indexed with a recorded warning (default: 2000)",
    )
    return parser


def _build_runtime_info(args: argparse.Namespace) -> Dict[str, Any]:
    lock_path = _WORKER_DIR.parent / "python-requirements.lock"
    lock_hash = ""
    try:
        if lock_path.exists():
            lock_hash = hashlib.sha256(lock_path.read_bytes()).hexdigest()[:16]
    except Exception:
        lock_hash = ""
    return {
        "python": sys.version,
        "executable": sys.executable,
        "workspace": args.workspace,
        "sqlite_path": args.sqlite,
        "lance_path": args.lance,
        "model": args.model,
        "embedding_provider": args.embedding_provider,
        "embedding_model": args.embedding_model,
        "embedding_dimensions": args.embedding_dimensions,  # None = auto
        "batch_rpm": args.batch_rpm,
        "max_file_size": args.max_file_size,
        "max_chunks_per_doc": args.max_chunks_per_doc,
        "lock_hash": lock_hash,
    }


def main() -> None:
    args = build_arg_parser().parse_args()

    # The embedding key is NOT read from the environment. The host-injected
    # INDEXER_API_KEY channel was removed (it exposed the key via
    # /proc/<pid>/environ, child-process inheritance, and crash dumps). The
    # worker boots with an empty key; the host pushes the credential at
    # runtime via /indexer/set_embedding_api_key (on worker warmup, per scan,
    # and on rotation), which feeds the indexer, the SearchService, and the
    # caption fallback alike.
    api_key = ""

    os.makedirs(args.workspace, exist_ok=True)
    os.makedirs(os.path.dirname(args.sqlite), exist_ok=True)
    os.makedirs(os.path.dirname(args.lance), exist_ok=True)

    indexer = LocalIndexer(
        workspace=args.workspace,
        sqlite_path=args.sqlite,
        lance_path=args.lance,
        openai_api_key=api_key,
        embedding_provider=args.embedding_provider,
        embedding_model=args.embedding_model,
        embedding_dimensions=args.embedding_dimensions,  # None = auto from client
        embedding_endpoint=args.embedding_endpoint,
        embedding_api_version=args.embedding_api_version,
        egress_broker_url=args.egress_broker_url,
        egress_broker_uds=args.egress_broker_uds,
        target_rpm=args.batch_rpm,
        max_file_size=args.max_file_size,
        max_chunks_per_doc=args.max_chunks_per_doc,
    )
    # Pass embedding_client/vector_store to SearchService lazily.
    # Keep SentenceTransformer off the startup critical path so health checks
    # are not delayed. The indexer creates the client on demand, and BM25-only
    # fallback remains available. search/vector must return empty results when
    # embedding_client is None; vector_store is also created lazily on indexing.
    # Keep startup light: SearchService already lazily creates the Kiwi tokenizer
    # on the first search request, so there is no need to pay the cold-start cost
    # before the health endpoint can respond.
    search = SearchService(
        sqlite_path=args.sqlite,
        tokenizer=None,
        embedding_client=None,
        vector_store=None,
        lance_path=args.lance,
        embedding_provider=args.embedding_provider,
        embedding_model=args.embedding_model,
        openai_api_key=api_key,
        embedding_dimensions=args.embedding_dimensions,
        embedding_endpoint=args.embedding_endpoint,
        embedding_api_version=args.embedding_api_version,
        egress_broker_url=args.egress_broker_url,
        egress_broker_uds=args.egress_broker_uds,
    )
    state = AppState(
        indexer=indexer,
        search=search,
        runtime_info=_build_runtime_info(args),
        openai_api_key=api_key,
    )
    app = create_app(state)

    try:
        log.info(
            "worker.starting",
            host=args.host,
            port=args.port,
            sqlite=args.sqlite,
            workspace=args.workspace,
        )
    except TypeError:
        log.info("worker.starting host=%s port=%s", args.host, args.port)

    # The shutdown token is never emitted to stdout.
    # The host learns the token only through env injection. A dev fallback
    # token stays in process memory unless AVE_SHUTDOWN_TOKEN is set explicitly.

    # Instantiate the Server explicitly so _request_shutdown can flip
    # should_exit and let uvicorn run its shutdown lifecycle (atexit hooks,
    # SQLite WAL checkpoint, lance flush) instead of os._exit.
    #
    # --uds가 주입되면 uvicorn은 해당 Unix 소켓 위에서 HTTP를 서빙한다 (loopback
    # TCP 포트를 열지 않음). 호스트가 ASRT-confined로 spawn하며 bind-mount한
    # 소켓 경로를 그대로 사용한다. 미주입(gate-OFF / win32 legacy)이면 기존
    # host/port TCP 경로를 유지한다.
    if args.uds:
        config = uvicorn.Config(app, uds=args.uds, log_level="warning")
    else:
        config = uvicorn.Config(app, host=args.host, port=args.port, log_level="warning")
    server = uvicorn.Server(config)
    state.server = server
    arm_host_liveness_watchdog(server)
    server.run()


if __name__ == "__main__":
    main()

