#!/usr/bin/env python3
"""Ave Local Indexer worker: a worker stdio control v1 server.

The plugin spawns this process with ``spawnWorker({ control:
"stdio-control-v1", stateDirectory: true })``. It opens no socket and no
port. stdin and stdout carry JSON-RPC frames only (``worker/stdio_control.py``)
and every log line goes to stderr.

Methods the plugin calls
------------------------
    worker_health                  readiness and uptime
    runtime_info                   paths, runtime versions, document count
    runtime_allowed_roots          replace the path-confinement roots
    indexer_reindex                index one file synchronously
    indexer_reconcile              detect and normalise SQLite/LanceDB drift
    indexer_set_image_captioning   image-captioning settings
    indexer_set_embedding_egress   whether relayed embedding may be attempted
    indexer_caption_image          caption one image
    documents_list / document_get / documents_delete
    document_structure / page_content
    legacy_index_manifest          read a copy of a pre-0.8.0 index: which
                                   documents it held, and which had vectors
    search_bm25 / search_vector / search_hybrid
    metrics
    worker_shutdown                drop the egress flag and close the stores

Methods the worker calls on the plugin
--------------------------------------
    egress_embedding / egress_caption   one provider HTTP request each
                                        (``worker/stdio_egress.py``)

``indexer_reindex`` is the sole ingestion method: each call indexes one file
and returns its result. An ``asyncio.Lock`` serialises the writes because
sqlite and lance are not re-entrant, and a cancelled write still holds the
lock until its thread has finished.

The worker exits on stdin EOF and on ``$/ave/shutdown``, after closing its
stores. It answers the host's hello before loading the indexing stack, so the
hello never waits on a cold import.
"""

from __future__ import annotations

import argparse
import asyncio
import functools
import hashlib
import json
import logging
import os
import re
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional

# Validate page expressions with a ReDoS-safe character class.
# Allowed examples: "5", "5-7", "5,7,9", "5-7,10,12-14". Max length 200.
_PAGES_RE = re.compile(r"^[\d,\-\s]{1,200}$")

# The host names the worker's private state directory here
# (PluginWorkerSpec.stateDirectory).
WORKER_STATE_DIR_ENV = "AVE_WORKER_STATE_DIR"

# Ensure the worker directory is importable whether launched from the
# repository root or from inside the extraResources bundle.
_WORKER_DIR = Path(__file__).resolve().parent
if str(_WORKER_DIR.parent) not in sys.path:
    sys.path.insert(0, str(_WORKER_DIR.parent))
if str(_WORKER_DIR) not in sys.path:
    sys.path.insert(0, str(_WORKER_DIR))


def configure_logging() -> Any:
    """Send every log line to stderr: stdout carries control frames only.

    The plugin reads stderr line by line and turns the JSON events it knows
    (``indexer.caption.failed``, ``indexer.file.empty``, ...) into
    ``index.warning`` events for the UI, so the JSON renderer stays.
    """
    try:  # pragma: no cover - optional dependency branch
        import structlog  # type: ignore

        structlog.configure(
            processors=[
                structlog.processors.add_log_level,
                structlog.processors.TimeStamper(fmt="iso"),
                structlog.processors.JSONRenderer(),
            ],
            logger_factory=structlog.WriteLoggerFactory(file=sys.stderr),
        )
        return structlog.get_logger("local-indexer.worker")
    except Exception:  # pragma: no cover
        logging.basicConfig(level=logging.INFO, stream=sys.stderr)
        return logging.getLogger("local-indexer.worker")


log = configure_logging()

try:
    from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator
except Exception as exc:  # pragma: no cover - startup guard
    sys.stderr.write(
        "pydantic import failed. python-requirements.lock via uv venv must be "
        f"ready before the worker spawns.\ndetails: {exc}\n"
    )
    raise

from stdio_control import (  # type: ignore  # noqa: E402
    FRAME_BYTES_MAX,
    INVALID_PARAMS,
    NOT_FOUND,
    SERVER_ERROR,
    RequestError,
    StdioPeer,
    claim_stdout_for_frames,
)


def _warning(event: str, **fields: Any) -> None:
    try:
        log.warning(event, **fields)
    except TypeError:
        log.warning("%s %s", event, fields)


def _info(event: str, **fields: Any) -> None:
    try:
        log.info(event, **fields)
    except TypeError:
        log.info("%s %s", event, fields)


# ----------------------------------------------------------------------
# Request models
# ----------------------------------------------------------------------

# Security A3 fix: constrain file_path to allowed roots to block traversal.
# Roots come from AVE_INDEX_ALLOWED_ROOTS or the default three locations.
_ALLOWED_ROOTS_ENV = "AVE_INDEX_ALLOWED_ROOTS"


# Runtime override for allowed roots. When the host adds/removes scan folders
# at runtime via `runtime_allowed_roots`, this variable is replaced so
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


class PathNotAllowed(ValueError):
    """A path outside the allowed roots. The roots are runtime state the host
    pushes (runtime_allowed_roots), so this refusal may pass after a sync."""


# JSON-RPC code for a PathNotAllowed refusal, distinct from invalid params so
# the plugin can tell "outside the roots right now" from a malformed request.
PATH_NOT_ALLOWED = -32011


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
    raise PathNotAllowed(f"file_path outside allowed roots: {real}")


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


class SetEmbeddingEgressRequest(BaseModel):
    """Body of ``indexer_set_embedding_egress``.

    The plugin sends ``enabled: true`` once it knows a provider credential is
    available (at worker warmup and at each scan start). The worker holds no
    key either way; without the flag it stays BM25-only instead of asking the
    plugin for an embedding that would be refused.
    """

    enabled: bool


class SetImageCaptioningRequest(BaseModel):
    """Toggle for the indexer's image-captioning pass.

    Worker boots with image captioning OFF. The host flips this through
    the UI; subsequent reindex calls observe the new state. The
    settings are *not* persisted on the worker side — the host's
    configSchema is the source of truth and the host pushes the value
    again on every worker restart via this method.

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
    """Body of ``indexer_caption_image``.

    Host calls this for files routed through the image-embedding toggle.
    The method returns only the caption text (a string) — feeding that
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
    """Apply ``image_captioner.validate_caption_model`` at the method boundary.

    One rule for both boundaries: the request models reject as invalid params what
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


class SearchRequest(BaseModel):
    query: str = Field(..., min_length=1)
    topK: int = Field(20, ge=1, le=200)


# A page of documents_list holds at most this many rows, and is also cut by
# bytes (see documents_page_budget) so long multi-byte paths cannot push it
# past the negotiated frame limit.
DOCUMENTS_PAGE_MAX = 1000
# Room left in a frame for the JSON-RPC envelope and the page wrapper.
DOCUMENTS_FRAME_HEADROOM = 64 * 1024


def documents_page_budget(frame_bytes_max: int) -> int:
    """Bytes of serialized rows one documents_list page may carry: three
    quarters of the frame, less the envelope headroom."""
    return max(1, frame_bytes_max * 3 // 4 - DOCUMENTS_FRAME_HEADROOM)


def _row_bytes(row: Dict[str, Any]) -> int:
    # Serialized the way the frame encoder writes it, plus the separating comma.
    return len(json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) + 1


class DocumentsListRequest(BaseModel):
    after: Optional[str] = Field(None, max_length=512)
    limit: int = Field(DOCUMENTS_PAGE_MAX, ge=1, le=DOCUMENTS_PAGE_MAX)


class LegacyManifestRequest(BaseModel):
    sqlite_path: str = Field(..., min_length=1, max_length=4096)
    after: Optional[str] = Field(None, max_length=512)
    limit: int = Field(DOCUMENTS_PAGE_MAX, ge=1, le=DOCUMENTS_PAGE_MAX)


def _budgeted_page(rows: List[Dict[str, Any]], limit: int, frame_bytes_max: int, key: str) -> Dict[str, Any]:
    """Cut ``rows`` (one keyset page of at most ``limit``) to the frame budget.

    Returns the rows that fit and the cursor for the next page, or null on
    the last one.
    """
    budget = documents_page_budget(frame_bytes_max)
    page: List[Dict[str, Any]] = []
    used = 0
    for row in rows:
        size = _row_bytes(row)
        if page and used + size > budget:
            break
        page.append(row)
        used += size
    more = len(page) < len(rows) or len(rows) == limit
    return {"rows": page, "next_after": page[-1][key] if more and page else None}


def _is_within(child: str, parent: str) -> bool:
    child_real = os.path.realpath(child)
    parent_real = os.path.realpath(parent)
    try:
        return os.path.commonpath([child_real, parent_real]) == parent_real
    except ValueError:
        return False


def read_legacy_manifest_page(sqlite_path: str, after: Optional[str], limit: int) -> List[Dict[str, Any]]:
    """One page of the documents a pre-0.8.0 index held as indexed.

    ``sqlite_path`` is a copy the plugin made of the old ``fts5.sqlite`` (with
    its ``-wal``). It is opened read-write so SQLite can replay that WAL: a
    read-only or immutable open drops rows the WAL has not checkpointed, and
    a missing row here would let the plugin delete the old index without
    rebuilding that document. ``query_only`` keeps this reader from writing.

    The first page (no ``after``) runs ``PRAGMA quick_check`` and refuses a
    copy that fails it.

    Columns added by later ALTERs (``content_state``, ``content_hash``) may be
    absent in an old index. ``had_vectors`` is whether any of the document's
    chunks has an ``embeddings_meta`` row; an index without that table falls
    back to ``content_state = 'ok'``.
    """
    conn = sqlite3.connect(sqlite_path)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA query_only = ON")
        if not after:
            # Once per read: a copy torn or damaged on the way here must not
            # pass for a smaller index.
            verdict = conn.execute("PRAGMA quick_check").fetchone()
            if verdict is None or verdict[0] != "ok":
                detail = str(verdict[0]).splitlines()[:2] if verdict else ["no answer"]
                raise ValueError(f"the index copy failed its integrity check: {' '.join(detail)}")
        tables = {row["name"] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        if "documents" not in tables:
            raise ValueError("not an index: the documents table is missing")
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(documents)")}
        content_state = "d.content_state" if "content_state" in columns else "NULL"
        content_hash = "d.content_hash" if "content_hash" in columns else "NULL"
        if "embeddings_meta" in tables and "chunks" in tables:
            had_vectors = (
                "EXISTS (SELECT 1 FROM chunks c JOIN embeddings_meta e ON e.chunk_id = c.chunk_id "
                "WHERE c.doc_id = d.doc_id)"
            )
        elif "content_state" in columns:
            had_vectors = "(d.content_state = 'ok')"
        else:
            had_vectors = "0"
        rows = conn.execute(
            f"SELECT d.doc_id AS doc_id, d.path AS path, d.mtime_ms AS mtime_ms, "
            f"       {content_state} AS content_state, {content_hash} AS content_hash, "
            f"       {had_vectors} AS had_vectors "
            f"FROM documents d WHERE d.status = 'indexed' AND d.doc_id > ? "
            f"ORDER BY d.doc_id LIMIT ?",
            (after or "", int(limit)),
        ).fetchall()
    finally:
        conn.close()
    return [
        {
            "doc_id": row["doc_id"],
            "path": row["path"],
            "mtime_ms": row["mtime_ms"],
            "content_state": row["content_state"],
            "content_hash": row["content_hash"],
            "had_vectors": bool(row["had_vectors"]),
        }
        for row in rows
    ]


class DocIdRequest(BaseModel):
    doc_id: str = Field(..., min_length=1, max_length=512)


class PageContentRequest(BaseModel):
    doc_id: str = Field(..., min_length=1, max_length=512)
    pages: str = Field(..., min_length=1, max_length=200)


# ----------------------------------------------------------------------
# App state container
# ----------------------------------------------------------------------
class AppState:
    def __init__(
        self,
        *,
        indexer: Any,
        search: Any,
        runtime_info: Dict[str, Any],
        openai_api_key: str = "",
    ) -> None:
        self.indexer = indexer
        self.search = search
        self.runtime_info = runtime_info
        # Used only by the direct (non-relayed) caption fallback; kept out of
        # runtime_info, which the plugin reads.
        self.openai_api_key = openai_api_key
        # Serialises index writes: sqlite + lance are not re-entrant.
        self.lock = asyncio.Lock()
        self.started_at = time.time()
        self.storage_closed = False
        # The frame limit the host announced (serve() points this at the
        # peer once the hello is answered); answers that grow with the index
        # are paged to stay inside it.
        self.frame_bytes_max: Callable[[], int] = lambda: FRAME_BYTES_MAX
        self.metrics: Dict[str, Any] = {
            "processed": 0,
            "failed": 0,
            "search_bm25": 0,
            "search_vector": 0,
            "search_hybrid": 0,
        }

    def close_storage(self) -> None:
        if self.storage_closed:
            return
        self.storage_closed = True
        for name, owner in (("indexer", self.indexer), ("search", self.search)):
            close = getattr(owner, "close", None)
            if not callable(close):
                continue
            try:
                close()
            except Exception as exc:  # pragma: no cover - defensive cleanup log
                _warning("shutdown.storage_close_failed", component=name, error=str(exc))


def _validated(model: Any, params: Any) -> Any:
    """Validate ``params`` against ``model`` or refuse with invalid params."""
    try:
        return model.model_validate(params if params is not None else {})
    except ValidationError as exc:
        errors = exc.errors()
        first = errors[0] if errors else {}
        where = ".".join(str(part) for part in first.get("loc", ()))
        message = str(first.get("msg", "invalid params"))
        cause = (first.get("ctx") or {}).get("error")
        code = PATH_NOT_ALLOWED if isinstance(cause, PathNotAllowed) else INVALID_PARAMS
        raise RequestError(code, f"{where}: {message}" if where else message) from None


async def _blocking(fn: Callable[..., Any], *args: Any) -> Any:
    """Run a blocking read off the event loop. Cancellation answers at once."""
    return await asyncio.to_thread(fn, *args)


async def _exclusive(state: AppState, fn: Callable[..., Any], *args: Any) -> Any:
    """Run a blocking write under the state lock, to completion.

    A thread cannot be interrupted, so a cancelled write keeps the lock until
    its thread returns: the next write must not overlap it. The cancellation
    is reported once the thread is done.
    """
    loop = asyncio.get_running_loop()
    async with state.lock:
        future = loop.run_in_executor(None, functools.partial(fn, *args))
        cancelled = False
        while True:
            try:
                result = await asyncio.shield(future)
                break
            except asyncio.CancelledError:
                cancelled = True
                if future.done():
                    break
        if cancelled:
            raise asyncio.CancelledError()
        return result


Handler = Callable[[Any], Awaitable[Any]]

# Every method the plugin may call; ``build_handlers`` returns exactly these.
METHOD_NAMES = (
    "worker_health",
    "runtime_info",
    "runtime_allowed_roots",
    "indexer_reindex",
    "indexer_reconcile",
    "documents_list",
    "document_get",
    "documents_delete",
    "document_structure",
    "page_content",
    "legacy_index_manifest",
    "search_bm25",
    "search_vector",
    "search_hybrid",
    "indexer_set_image_captioning",
    "indexer_set_embedding_egress",
    "indexer_caption_image",
    "metrics",
    "worker_shutdown",
)


def build_handlers(state: AppState, *, egress_relay: Optional[Any] = None) -> Dict[str, Handler]:
    """The worker's control methods, bound to ``state``."""

    def _open() -> None:
        if state.storage_closed:
            raise RequestError(SERVER_ERROR, "worker stores are closed")

    async def worker_health(_params: Any) -> Dict[str, Any]:
        return {"status": "ok", "uptime_s": time.time() - state.started_at}

    async def runtime_info(_params: Any) -> Dict[str, Any]:
        _open()
        count = await _blocking(state.indexer.count_documents)
        return {**state.runtime_info, "document_count": count}

    async def runtime_allowed_roots(params: Any) -> Dict[str, Any]:
        req = _validated(AllowedRootsRequest, params)
        global _ALLOWED_ROOTS_RUNTIME
        normalised = _normalise_roots(req.roots)
        if not normalised:
            raise RequestError(INVALID_PARAMS, "roots must contain at least one valid path")
        _ALLOWED_ROOTS_RUNTIME = normalised
        _info("runtime.allowed_roots.updated", count=len(normalised))
        return {"roots": normalised, "count": len(normalised)}

    async def indexer_reindex(params: Any) -> Dict[str, Any]:
        req = _validated(ReindexRequest, params)
        _open()
        try:
            result = await _exclusive(state, state.indexer.reindex, req.file_path, req.mode)
        except FileNotFoundError as exc:
            state.metrics["failed"] += 1
            raise RequestError(NOT_FOUND, str(exc)) from None
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            state.metrics["failed"] += 1
            try:
                log.exception("indexer.reindex.error")
            except Exception:
                pass
            raise RequestError(SERVER_ERROR, str(exc)) from None
        state.metrics["failed" if result.status == "failed" else "processed"] += 1
        return _result_dict(result)

    async def indexer_reconcile(_params: Any) -> Dict[str, Any]:
        # Detect + normalise only (no embedding), so it needs no credential.
        # Held under the write lock because it deletes orphan Lance rows and
        # rewrites sqlite state.
        _open()
        return await _exclusive(state, state.indexer.reconcile)

    async def documents_list(params: Any) -> Dict[str, Any]:
        # Paged: an index of tens of thousands of documents does not fit one
        # control frame. ``next_after`` is the cursor for the next page, or
        # null on the last one.
        req = _validated(DocumentsListRequest, params if params is not None else {})
        _open()
        rows = await _blocking(state.indexer.list_documents_page, req.after, req.limit)
        cut = _budgeted_page(rows, req.limit, state.frame_bytes_max(), "doc_id")
        return {"documents": cut["rows"], "next_after": cut["next_after"]}

    async def legacy_index_manifest(params: Any) -> Dict[str, Any]:
        # Read-only over a copy the plugin placed in the workspace; the worker
        # never reads the old index directory itself. Paged like documents_list.
        req = _validated(LegacyManifestRequest, params)
        workspace = str(state.runtime_info.get("workspace") or "")
        if not workspace or not _is_within(req.sqlite_path, workspace):
            raise RequestError(INVALID_PARAMS, "sqlite_path must be inside the worker workspace")
        if not os.path.isfile(req.sqlite_path):
            raise RequestError(NOT_FOUND, f"no index copy at {req.sqlite_path}")
        try:
            rows = await _blocking(read_legacy_manifest_page, req.sqlite_path, req.after, req.limit)
        except (sqlite3.DatabaseError, ValueError) as exc:
            raise RequestError(SERVER_ERROR, f"the old index could not be read: {exc}") from None
        cut = _budgeted_page(rows, req.limit, state.frame_bytes_max(), "doc_id")
        return {"documents": cut["rows"], "next_after": cut["next_after"]}

    async def document_get(params: Any) -> Dict[str, Any]:
        req = _validated(DocIdRequest, params)
        _open()
        doc = await _blocking(state.indexer.get_document, req.doc_id)
        if not doc:
            raise RequestError(NOT_FOUND, f"Document {req.doc_id} not found")
        return doc

    async def documents_delete(params: Any) -> Dict[str, Any]:
        req = _validated(DeleteDocumentRequest, params)
        _open()
        removed = await _exclusive(state, state.indexer.remove_document, req.doc_id)
        return {"removed": removed, "doc_id": req.doc_id}

    async def document_structure(params: Any) -> Any:
        req = _validated(DocIdRequest, params)
        _open()
        return await _blocking(state.search.get_document_structure, req.doc_id)

    async def page_content(params: Any) -> Any:
        req = _validated(PageContentRequest, params)
        if not _PAGES_RE.match(req.pages):
            raise RequestError(
                INVALID_PARAMS,
                "invalid pages expression (expected digits, comma, dash, space; <=200 chars)",
            )
        _open()
        return await _blocking(state.search.get_page_content, req.doc_id, req.pages)

    def _search(kind: str, fn_name: str) -> Handler:
        async def handler(params: Any) -> Any:
            req = _validated(SearchRequest, params)
            _open()
            state.metrics[f"search_{kind}"] += 1
            return await _blocking(getattr(state.search, fn_name), req.query, req.topK)

        return handler

    async def indexer_set_image_captioning(params: Any) -> Dict[str, Any]:
        req = _validated(SetImageCaptioningRequest, params)
        state.indexer.set_image_captioning(
            enabled=req.enabled,
            provider=req.provider,
            model=req.model,
            endpoint=req.endpoint,
            api_key=req.api_key,
            api_version=req.api_version,
        )
        return state.indexer.get_image_captioning()

    async def indexer_set_embedding_egress(params: Any) -> Dict[str, Any]:
        # Feed both consumers: the indexer embeds at index time, the
        # SearchService embeds queries outside any scan.
        req = _validated(SetEmbeddingEgressRequest, params)
        state.indexer.set_embedding_egress(req.enabled)
        state.search.set_embedding_egress(req.enabled)
        return {"embeddingEgress": req.enabled}

    async def indexer_caption_image(params: Any) -> Dict[str, Any]:
        from worker.image_captioner import (  # local import keeps cold-start light
            CaptionError,
            caption_image,
        )

        req = _validated(CaptionImageRequest, params)
        if egress_relay is not None:
            # Relayed: the plugin picks the upstream and the credential; an
            # env key would go around it, so none is read.
            caption_api_key: Optional[str] = None
            caption_endpoint: Optional[str] = None
        else:
            caption_api_key = (
                req.api_key or state.openai_api_key or os.environ.get("OPENAI_API_KEY") or ""
            ) or None
            caption_endpoint = req.endpoint or None
        try:
            result = await _blocking(
                functools.partial(
                    caption_image,
                    req.file_path,
                    req.provider,  # type: ignore[arg-type]
                    req.model or None,
                    caption_api_key,
                    caption_endpoint,
                    req.api_version or None,
                    egress_relay=egress_relay,
                )
            )
        except CaptionError as exc:
            raise RequestError(INVALID_PARAMS, str(exc)) from None
        return {
            "file_path": req.file_path,
            "caption": result.caption,
            "provider": result.provider,
            "model": result.model,
            "input_tokens": result.input_tokens,
            "output_tokens": result.output_tokens,
        }

    async def metrics(_params: Any) -> Dict[str, Any]:
        return {**state.metrics, "uptime_s": time.time() - state.started_at}

    async def worker_shutdown(_params: Any) -> Dict[str, Any]:
        # The plugin's orderly stop: forget the egress flag and close the
        # stores (WAL checkpoint, lance flush) while it waits, then it stops
        # the worker. Waits for an in-flight write first.
        _info("shutdown.requested")
        state.indexer.set_embedding_egress(False)
        state.search.set_embedding_egress(False)
        state.openai_api_key = ""
        async with state.lock:
            await asyncio.to_thread(state.close_storage)
        return {"bye": True}

    return {
        "worker_health": worker_health,
        "runtime_info": runtime_info,
        "runtime_allowed_roots": runtime_allowed_roots,
        "indexer_reindex": indexer_reindex,
        "indexer_reconcile": indexer_reconcile,
        "documents_list": documents_list,
        "document_get": document_get,
        "documents_delete": documents_delete,
        "document_structure": document_structure,
        "page_content": page_content,
        "legacy_index_manifest": legacy_index_manifest,
        "search_bm25": _search("bm25", "search_bm25"),
        "search_vector": _search("vector", "search_vector"),
        "search_hybrid": _search("hybrid", "search_hybrid_internal"),
        "indexer_set_image_captioning": indexer_set_image_captioning,
        "indexer_set_embedding_egress": indexer_set_embedding_egress,
        "indexer_caption_image": indexer_caption_image,
        "metrics": metrics,
        "worker_shutdown": worker_shutdown,
    }




def _result_dict(result: Any) -> Dict[str, Any]:
    return {
        "doc_id": result.doc_id,
        "doc_name": result.doc_name,
        "doc_type": result.doc_type,
        "chunk_count": result.chunk_count,
        "status": result.status,
        "page_count": result.page_count,
        "line_count": result.line_count,
        "errors": result.errors,
        # For a failed result: whether the same file may index on a later try.
        "retryable": bool(getattr(result, "retryable", False)),
        # For a failed result: what failed ("unparseable", "io", "caption", "too_large").
        "failure_kind": getattr(result, "failure_kind", None),
        # 임베딩 성공 여부 — 플러그인은 embedded=false 면 (status="indexed"
        # 이더라도) 사용자 입장에선 실패로 본다. None 은 옛 워커 호환용
        # (필드 미존재) 으로만 발생.
        "embedded": result.embedded,
        # True 면 content-hash 가 일치해 임베딩/persist 를 건너뛰고 mtime 만
        # 갱신한 short-circuit (기존 청크/벡터 재사용). 관측/디버깅용.
        "unchanged": result.unchanged,
    }



# ----------------------------------------------------------------------
# Entrypoint
# ----------------------------------------------------------------------
def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Ave Local Indexer local worker")
    # Where the index lives. The default is the worker's private state
    # directory, which the host creates and names in AVE_WORKER_STATE_DIR
    # (spawnWorker ``stateDirectory: true``). ``--index-root`` is a
    # user-chosen storage root instead; ``--sqlite`` / ``--lance`` name the
    # two stores directly (tests and manual runs).
    parser.add_argument("--index-root", default="")
    parser.add_argument("--workspace", default="")
    parser.add_argument("--sqlite", default="")
    parser.add_argument("--lance", default="")
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


def _build_runtime_info(args: argparse.Namespace, storage: Dict[str, str]) -> Dict[str, Any]:
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
        "index_root": storage["index_root"],
        "state_dir": storage["state_dir"],
        "workspace": storage["workspace"],
        "sqlite_path": storage["sqlite"],
        "lance_path": storage["lance"],
        "model": args.model,
        "embedding_provider": args.embedding_provider,
        "embedding_model": args.embedding_model,
        "embedding_dimensions": args.embedding_dimensions,  # None = auto
        "batch_rpm": args.batch_rpm,
        "max_file_size": args.max_file_size,
        "max_chunks_per_doc": args.max_chunks_per_doc,
        "lock_hash": lock_hash,
    }




def resolve_storage(args: argparse.Namespace, env: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """Decide where the index and the scratch workspace live.

    Explicit ``--sqlite`` / ``--lance`` win, then ``--index-root`` (a
    user-chosen storage root), then the host-made state directory named in
    ``AVE_WORKER_STATE_DIR``. There is no home-directory fallback: a worker
    with none of the three was spawned against the contract, and says so.
    """
    environ = os.environ if env is None else env
    state_dir = environ.get(WORKER_STATE_DIR_ENV, "")
    if args.index_root:
        root = os.path.abspath(os.path.expanduser(args.index_root))
    elif state_dir:
        root = os.path.join(os.path.abspath(state_dir), "index")
    elif args.sqlite and args.lance:
        root = os.path.dirname(os.path.abspath(args.sqlite))
    else:
        raise SystemExit(
            f"local-indexer worker: no index location. Spawn it with stateDirectory "
            f"(sets {WORKER_STATE_DIR_ENV}) or pass --index-root."
        )
    return {
        "index_root": root,
        "state_dir": state_dir,
        "sqlite": os.path.abspath(args.sqlite) if args.sqlite else os.path.join(root, "fts5.sqlite"),
        "lance": os.path.abspath(args.lance) if args.lance else os.path.join(root, "vectors.lance"),
        "workspace": os.path.abspath(args.workspace) if args.workspace else os.path.join(root, "workspace"),
    }


def build_state(args: argparse.Namespace, storage: Dict[str, str], egress_relay: Optional[Any]) -> AppState:
    """Open the stores. Slow (lance, pyarrow), so it runs after the hello."""
    from local_indexer import LocalIndexer  # type: ignore
    from local_indexer_search import SearchService  # type: ignore

    os.makedirs(storage["workspace"], exist_ok=True)
    os.makedirs(os.path.dirname(storage["sqlite"]), exist_ok=True)
    os.makedirs(os.path.dirname(storage["lance"]), exist_ok=True)

    # The worker holds no embedding key: relayed egress gets its credential
    # from the plugin per request.
    indexer = LocalIndexer(
        workspace=storage["workspace"],
        sqlite_path=storage["sqlite"],
        lance_path=storage["lance"],
        openai_api_key="",
        embedding_provider=args.embedding_provider,
        embedding_model=args.embedding_model,
        embedding_dimensions=args.embedding_dimensions,  # None = auto from client
        embedding_endpoint=args.embedding_endpoint,
        embedding_api_version=args.embedding_api_version,
        egress_relay=egress_relay,
        target_rpm=args.batch_rpm,
        max_file_size=args.max_file_size,
        max_chunks_per_doc=args.max_chunks_per_doc,
    )
    # SearchService creates the Kiwi tokenizer and the embedding client on
    # first use, so opening it is cheap.
    search = SearchService(
        sqlite_path=storage["sqlite"],
        tokenizer=None,
        embedding_client=None,
        vector_store=None,
        lance_path=storage["lance"],
        embedding_provider=args.embedding_provider,
        embedding_model=args.embedding_model,
        openai_api_key="",
        embedding_dimensions=args.embedding_dimensions,
        embedding_endpoint=args.embedding_endpoint,
        embedding_api_version=args.embedding_api_version,
        egress_relay=egress_relay,
    )
    return AppState(indexer=indexer, search=search, runtime_info=_build_runtime_info(args, storage))


async def serve(
    peer: StdioPeer,
    args: argparse.Namespace,
    *,
    env: Optional[Dict[str, str]] = None,
    state_factory: Callable[[argparse.Namespace, Dict[str, str], Optional[Any]], AppState] = build_state,
    close_timeout_s: float = 10.0,
) -> int:
    """Run one worker incarnation until stdin EOF or ``$/ave/shutdown``.

    Returns the process exit code. Requests that arrive while the stores are
    still opening wait for them; if opening fails the worker exits non-zero
    and the plugin sees the exit.
    """
    from stdio_egress import EgressRelay  # type: ignore

    ready = asyncio.Event()
    holder: Dict[str, Any] = {}

    def gated(method: str) -> Handler:
        async def handler(params: Any) -> Any:
            await ready.wait()
            if "error" in holder:
                raise RequestError(SERVER_ERROR, f"worker failed to start: {holder['error']}")
            return await holder["handlers"][method](params)

        return handler

    relay = EgressRelay(peer.request_blocking)
    # Registered before the reader starts, so no request finds a gap.
    for method in METHOD_NAMES:
        peer.register(method, gated(method))
    await peer.start()

    storage = resolve_storage(args, env)
    try:
        state = await asyncio.to_thread(state_factory, args, storage, relay)
    except Exception as exc:
        holder["error"] = str(exc)
        ready.set()
        _warning("worker.start_failed", error=str(exc))
        return 1
    state.frame_bytes_max = lambda: peer.frame_bytes_max
    holder["handlers"] = build_handlers(state, egress_relay=relay)
    ready.set()
    _info("worker.ready", index_root=storage["index_root"], workspace=storage["workspace"])

    reason = await peer.wait_closed()
    _info("worker.stopping", reason=reason)
    async def close_stores() -> None:
        # Behind the write lock: a write still running in its thread finishes
        # before the stores close under it.
        async with state.lock:
            await asyncio.to_thread(state.close_storage)

    try:
        await asyncio.wait_for(close_stores(), close_timeout_s)
    except Exception as exc:  # pragma: no cover - a wedged store
        _warning("shutdown.storage_close_timeout", error=str(exc))
    peer.flush()
    return 0


def main(argv: Optional[List[str]] = None) -> None:
    # First: take stdout away from everything but the frame writer.
    frames_fd = claim_stdout_for_frames()
    args = build_arg_parser().parse_args(argv)
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    peer = StdioPeer(read_fd=0, write_fd=frames_fd)
    try:
        code = loop.run_until_complete(serve(peer, args))
    except SystemExit as exc:
        sys.stderr.write(f"{exc}\n")
        code = 2
    except BaseException as exc:  # pragma: no cover - last resort
        sys.stderr.write(f"local-indexer worker crashed: {exc!r}\n")
        code = 1
    try:
        sys.stderr.flush()
    finally:
        # Do not wait for executor threads: a provider call stuck in one must
        # not keep the process alive after stdin EOF. The stores are closed.
        os._exit(code)


if __name__ == "__main__":
    main()
