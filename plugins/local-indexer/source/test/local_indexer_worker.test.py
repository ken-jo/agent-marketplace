"""The worker's control methods and entrypoint (``worker/local_indexer_worker.py``)."""

from __future__ import annotations

import argparse
import asyncio
import io
import logging
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, List

import pytest

_WORKER_DIR = Path(__file__).resolve().parent.parent / "worker"
sys.path.insert(0, str(_WORKER_DIR))

import local_indexer_worker as w  # noqa: E402
import stdio_control as sc  # noqa: E402
from local_indexer import LocalIndexer  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))


def _call(handlers: Dict[str, Any], method: str, params: Any = None) -> Any:
    return asyncio.run(handlers[method](params))


def _args(*argv: str) -> argparse.Namespace:
    return w.build_arg_parser().parse_args(list(argv))


class FakeIndexer:
    def __init__(self) -> None:
        self.docs: List[Dict[str, Any]] = [{"doc_id": "d1", "path": "/x"}]
        self.egress: List[bool] = []

    def list_documents(self) -> List[Dict[str, Any]]:
        return list(self.docs)

    def list_documents_page(self, after: Any, limit: int) -> List[Dict[str, Any]]:
        rows = sorted(self.docs, key=lambda d: d["doc_id"])
        return [d for d in rows if d["doc_id"] > (after or "")][:limit]

    def count_documents(self) -> int:
        return len(self.docs)

    def get_document(self, doc_id: str) -> Any:
        return next((d for d in self.docs if d["doc_id"] == doc_id), None)

    def set_embedding_egress(self, enabled: bool) -> None:
        self.egress.append(enabled)


class FakeSearch:
    def search_bm25(self, query: str, top_k: int) -> List[Dict[str, Any]]:
        return [{"q": query, "k": top_k}]

    def set_embedding_egress(self, enabled: bool) -> None:
        pass


@pytest.fixture
def handlers() -> Dict[str, Any]:
    state = w.AppState(indexer=FakeIndexer(), search=FakeSearch(), runtime_info={"index_root": "/r"})
    return w.build_handlers(state)


# ── method table ──────────────────────────────────────────────────────────
def test_every_method_is_registered_under_a_contract_name(handlers: Dict[str, Any]) -> None:
    assert tuple(handlers) == w.METHOD_NAMES
    for name in w.METHOD_NAMES:
        assert sc.METHOD_RE.match(name), name


def test_search_validates_its_params(handlers: Dict[str, Any]) -> None:
    assert _call(handlers, "search_bm25", {"query": "budget", "topK": 3}) == [{"q": "budget", "k": 3}]
    with pytest.raises(sc.RequestError) as excinfo:
        _call(handlers, "search_bm25", {"topK": 3})
    assert excinfo.value.code == sc.INVALID_PARAMS
    assert "query" in excinfo.value.message
    with pytest.raises(sc.RequestError):
        _call(handlers, "search_bm25", {"query": "x", "topK": 999})


def test_missing_document_is_not_found(handlers: Dict[str, Any]) -> None:
    assert _call(handlers, "document_get", {"doc_id": "d1"}) == {"doc_id": "d1", "path": "/x"}
    with pytest.raises(sc.RequestError) as excinfo:
        _call(handlers, "document_get", {"doc_id": "nope"})
    assert excinfo.value.code == sc.NOT_FOUND


def test_page_expression_is_checked(handlers: Dict[str, Any]) -> None:
    with pytest.raises(sc.RequestError) as excinfo:
        _call(handlers, "page_content", {"doc_id": "d1", "pages": "1;DROP"})
    assert excinfo.value.code == sc.INVALID_PARAMS


def test_reindex_refuses_a_path_outside_the_allowed_roots(handlers: Dict[str, Any], tmp_path: Path) -> None:
    _call(handlers, "runtime_allowed_roots", {"roots": [str(tmp_path / "inside")]})
    with pytest.raises(sc.RequestError) as excinfo:
        _call(handlers, "indexer_reindex", {"file_path": str(tmp_path / "outside" / "a.md")})
    # Its own code: the roots are runtime state, so the plugin may retry.
    assert excinfo.value.code == w.PATH_NOT_ALLOWED
    assert excinfo.value.code != sc.INVALID_PARAMS
    assert "outside allowed roots" in excinfo.value.message
    # A malformed request is still invalid params.
    with pytest.raises(sc.RequestError) as bad_mode:
        _call(handlers, "indexer_reindex", {"file_path": str(tmp_path / "inside" / "a.md"), "mode": "exe"})
    assert bad_mode.value.code == sc.INVALID_PARAMS


def test_runtime_info_reports_the_document_count(handlers: Dict[str, Any]) -> None:
    info = _call(handlers, "runtime_info")
    assert info["index_root"] == "/r"
    assert info["document_count"] == 1


def test_documents_list_pages_by_cursor_and_validates_its_params(handlers: Dict[str, Any]) -> None:
    assert _call(handlers, "documents_list") == {"documents": [{"doc_id": "d1", "path": "/x"}], "next_after": None}
    with pytest.raises(sc.RequestError) as excinfo:
        _call(handlers, "documents_list", {"limit": w.DOCUMENTS_PAGE_MAX + 1})
    assert excinfo.value.code == sc.INVALID_PARAMS
    with pytest.raises(sc.RequestError):
        _call(handlers, "documents_list", {"limit": 0})


def test_documents_list_pages_a_large_index_in_frames_that_fit(tmp_path: Path) -> None:
    """40k documents with long paths do not fit one frame; every page does."""
    import sqlite3

    from worker.local_indexer import LocalIndexer

    class _Embed:
        def embed_corpus(self, texts: Any) -> Any:  # pragma: no cover - never indexed here
            return []

    class _Store:
        def delete(self, *_a: Any, **_k: Any) -> None:  # pragma: no cover
            pass

    indexer = LocalIndexer(
        workspace=str(tmp_path / "workspace"),
        sqlite_path=str(tmp_path / "fts5.sqlite"),
        lance_path=str(tmp_path / "vectors.lance"),
        openai_api_key=None,
        embedding_client=_Embed(),
        vector_store=_Store(),
    )
    total = 40_000
    long_dir = "/Users/someone/Documents/" + "deeply-nested-folder/" * 18
    with sqlite3.connect(indexer.sqlite_path) as conn:
        conn.executemany(
            "INSERT INTO documents (doc_id, path, doc_name, doc_type, mtime_ms, indexed_at, status) "
            "VALUES (?, ?, ?, 'md', 1, ?, 'indexed')",
            [(f"doc-{i:06d}", f"{long_dir}file-{i:06d}.md", f"file-{i:06d}.md", i) for i in range(total)],
        )
    everything = indexer.list_documents()
    with pytest.raises(sc.FrameTooLarge):
        sc.encode_frame({"id": 1, "result": everything})

    state = w.AppState(indexer=indexer, search=FakeSearch(), runtime_info={})
    paged = w.build_handlers(state)
    assert _call(paged, "runtime_info")["document_count"] == total
    seen: List[str] = []
    after = None
    pages = 0
    while True:
        params = {"limit": w.DOCUMENTS_PAGE_MAX} if after is None else {"after": after, "limit": w.DOCUMENTS_PAGE_MAX}
        page = _call(paged, "documents_list", params)
        sc.encode_frame({"id": 1, "result": page})  # each page fits one frame
        seen.extend(d["doc_id"] for d in page["documents"])
        pages += 1
        if page["next_after"] is None:
            break
        after = page["next_after"]
    assert pages == total // w.DOCUMENTS_PAGE_MAX + 1
    assert len(seen) == total and len(set(seen)) == total


def test_closed_stores_refuse_further_work(handlers: Dict[str, Any]) -> None:
    assert _call(handlers, "worker_shutdown") == {"bye": True}
    with pytest.raises(sc.RequestError, match="closed"):
        _call(handlers, "documents_list")


def test_relayed_caption_sends_no_key_and_no_endpoint(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import worker.image_captioner as ic

    seen: Dict[str, Any] = {}

    def fake_caption(path: str, provider: str, model: Any, api_key: Any, endpoint: Any, api_version: Any, *, egress_relay: Any) -> Any:
        seen.update(api_key=api_key, endpoint=endpoint, relay=egress_relay)
        return ic.CaptionResult(caption="c", provider=provider, model="m", input_tokens=1, output_tokens=1)

    monkeypatch.setattr(ic, "caption_image", fake_caption)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-env")
    relay = object()
    state = w.AppState(indexer=FakeIndexer(), search=FakeSearch(), runtime_info={}, openai_api_key="sk-dev")
    handlers = w.build_handlers(state, egress_relay=relay)
    _call(handlers, "runtime_allowed_roots", {"roots": [str(tmp_path)]})
    image = tmp_path / "a.png"
    image.write_bytes(b"\x89PNG\r\n\x1a\n")
    out = _call(
        handlers,
        "indexer_caption_image",
        {"file_path": str(image), "provider": "openai", "api_key": "sk-req", "endpoint": "https://e.example/"},
    )
    assert out["caption"] == "c"
    assert seen == {"api_key": None, "endpoint": None, "relay": relay}


# ── the write lock ────────────────────────────────────────────────────────
def test_a_cancelled_write_keeps_the_lock_until_its_thread_finishes() -> None:
    state = w.AppState(indexer=FakeIndexer(), search=FakeSearch(), runtime_info={})
    gate = threading.Event()
    order: List[str] = []

    def slow_write() -> str:
        gate.wait(5)
        order.append("first-done")
        return "first"

    def second_write() -> str:
        order.append("second")
        return "second"

    async def main() -> None:
        first = asyncio.ensure_future(w._exclusive(state, slow_write))
        await asyncio.sleep(0.05)
        first.cancel()
        second = asyncio.ensure_future(w._exclusive(state, second_write))
        await asyncio.sleep(0.1)
        assert order == []  # the second write waits for the first thread
        gate.set()
        with pytest.raises(asyncio.CancelledError):
            await first
        assert await second == "second"

    asyncio.run(main())
    assert order == ["first-done", "second"]


# ── storage location ──────────────────────────────────────────────────────
def test_index_defaults_to_the_worker_state_directory(tmp_path: Path) -> None:
    storage = w.resolve_storage(_args(), {"AVE_WORKER_STATE_DIR": str(tmp_path)})
    assert storage["index_root"] == str(tmp_path / "index")
    assert storage["sqlite"] == str(tmp_path / "index" / "fts5.sqlite")
    assert storage["lance"] == str(tmp_path / "index" / "vectors.lance")
    assert storage["state_dir"] == str(tmp_path)


def test_a_user_chosen_index_root_wins_over_the_state_directory(tmp_path: Path) -> None:
    storage = w.resolve_storage(
        _args("--index-root", str(tmp_path / "mine"), "--workspace", str(tmp_path / "ws")),
        {"AVE_WORKER_STATE_DIR": str(tmp_path / "state")},
    )
    assert storage["index_root"] == str(tmp_path / "mine")
    assert storage["sqlite"] == str(tmp_path / "mine" / "fts5.sqlite")
    assert storage["workspace"] == str(tmp_path / "ws")


def test_no_location_at_all_is_a_contract_error() -> None:
    with pytest.raises(SystemExit, match="AVE_WORKER_STATE_DIR"):
        w.resolve_storage(_args(), {})


def test_removed_flags_are_gone() -> None:
    for flag in ("--port", "--host", "--uds", "--egress-broker-url", "--db"):
        with pytest.raises(SystemExit):
            _args(flag, "x")


# ── logs go to stderr ─────────────────────────────────────────────────────
def test_structlog_writes_to_stderr() -> None:
    out, err = io.StringIO(), io.StringIO()
    real_out, real_err = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = out, err
    try:
        logger = w.configure_logging()
        logger.info("indexer.file.empty", path="/doc.md")
    finally:
        sys.stdout, sys.stderr = real_out, real_err
        w.configure_logging()
    assert out.getvalue() == ""
    assert '"event": "indexer.file.empty"' in err.getvalue()


def test_the_stdlib_fallback_writes_to_stderr(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "structlog", None)  # import fails
    root = logging.getLogger()
    saved = list(root.handlers)
    for handler in saved:
        root.removeHandler(handler)
    try:
        w.configure_logging()
        streams = [getattr(h, "stream", None) for h in root.handlers]
        assert sys.stderr in streams
        assert sys.stdout not in streams
    finally:
        for handler in list(root.handlers):
            root.removeHandler(handler)
        for handler in saved:
            root.addHandler(handler)
        w.configure_logging()


# ── serve(): hello first, stores after ────────────────────────────────────
def test_requests_wait_for_the_stores_and_eof_ends_the_incarnation(tmp_path: Path) -> None:
    from stdio_control_test_host import Host, HELLO  # type: ignore

    host = Host()
    peer = sc.StdioPeer(read_fd=host.worker_in_r, write_fd=host.worker_out_w)
    opened = threading.Event()

    def factory(args: argparse.Namespace, storage: Dict[str, str], relay: Any) -> w.AppState:
        opened.wait(5)
        return w.AppState(indexer=FakeIndexer(), search=FakeSearch(), runtime_info={"index_root": storage["index_root"]})

    async def main() -> int:
        task = asyncio.ensure_future(
            w.serve(peer, _args(), env={"AVE_WORKER_STATE_DIR": str(tmp_path)}, state_factory=factory)
        )
        host.send(HELLO)
        assert (await asyncio.to_thread(host.recv))["id"] == 0  # answered before the stores open
        host.send({"jsonrpc": "2.0", "id": 1, "method": "runtime_info"})
        assert await asyncio.to_thread(host.nothing_for, 0.2)
        opened.set()
        answer = await asyncio.to_thread(host.recv)
        assert answer["result"]["index_root"] == str(tmp_path / "index")
        host.close_stdin()
        return await task

    assert asyncio.run(asyncio.wait_for(main(), 15)) == 0


def test_a_failed_start_answers_waiting_requests_and_exits_non_zero(tmp_path: Path) -> None:
    from stdio_control_test_host import Host, HELLO  # type: ignore

    host = Host()
    peer = sc.StdioPeer(read_fd=host.worker_in_r, write_fd=host.worker_out_w)

    def factory(*_a: Any) -> w.AppState:
        time.sleep(0.2)
        raise RuntimeError("lance would not open")

    async def main() -> int:
        task = asyncio.ensure_future(
            w.serve(peer, _args(), env={"AVE_WORKER_STATE_DIR": str(tmp_path)}, state_factory=factory)
        )
        host.send(HELLO)
        await asyncio.to_thread(host.recv)
        host.send({"jsonrpc": "2.0", "id": 1, "method": "worker_health"})
        code = await task
        answer = await asyncio.to_thread(host.recv)
        assert "lance would not open" in answer["error"]["message"]
        return code

    assert asyncio.run(asyncio.wait_for(main(), 15)) == 1


def test_relayed_indexer_stays_bm25_only_until_told_otherwise(tmp_path: Path) -> None:
    indexer = LocalIndexer(
        workspace=str(tmp_path / "ws"),
        sqlite_path=str(tmp_path / "fts5.sqlite"),
        lance_path=str(tmp_path / "vectors.lance"),
        openai_api_key="",
        egress_relay=object(),
    )
    assert indexer.get_embedding_client() is None
    indexer.set_embedding_egress(True)
    client = indexer.get_embedding_client()
    assert client is not None
    assert client.api_key == "ave-plugin-egress"


def _bulk_indexer(tmp_path: Path, rows: List[tuple]) -> Any:
    import sqlite3

    from worker.local_indexer import LocalIndexer

    class _Embed:
        def embed_corpus(self, texts: Any) -> Any:  # pragma: no cover
            return []

    class _Store:
        def delete(self, *_a: Any, **_k: Any) -> None:  # pragma: no cover
            pass

    indexer = LocalIndexer(
        workspace=str(tmp_path / "workspace"),
        sqlite_path=str(tmp_path / "fts5.sqlite"),
        lance_path=str(tmp_path / "vectors.lance"),
        openai_api_key=None,
        embedding_client=_Embed(),
        vector_store=_Store(),
    )
    with sqlite3.connect(indexer.sqlite_path) as conn:
        conn.executemany(
            "INSERT INTO documents (doc_id, path, doc_name, doc_type, mtime_ms, indexed_at, status) "
            "VALUES (?, ?, ?, 'md', 1, 1, 'indexed')",
            rows,
        )
    return indexer


def _walk_pages(handlers: Dict[str, Any], limit: int, frame_limit: int) -> List[List[str]]:
    pages: List[List[str]] = []
    after = None
    while True:
        params = {"limit": limit} if after is None else {"after": after, "limit": limit}
        page = _call(handlers, "documents_list", params)
        sc.encode_frame({"id": 123456789, "result": page}, frame_limit)  # fits the negotiated frame
        pages.append([d["doc_id"] for d in page["documents"]])
        if page["next_after"] is None:
            return pages
        after = page["next_after"]


@pytest.mark.parametrize("frame_limit", [256 * 1024, sc.FRAME_BYTES_MAX])
def test_documents_list_pages_are_cut_by_bytes_for_long_multibyte_paths(tmp_path: Path, frame_limit: int) -> None:
    # ~4000-character paths, mostly 4-byte characters (about 15 KiB each in
    # UTF-8), with Korean file names: 1000 rows (the row cap) would be ~15 MiB,
    # past the 16 MiB frame's page budget and far past a small negotiated frame.
    segment = "𠀀𠀁𠀂𠀃𠀄𠀅𠀆𠀇𠀈𠀉𠀊𠀋𠀌𠀍𠀎/"
    long_dir = "/" + segment * (4000 // len(segment))
    total = 1500
    rows = [(f"doc-{i:05d}", f"{long_dir}{i:05d}.md", f"문서-{i:05d}.md") for i in range(total)]
    indexer = _bulk_indexer(tmp_path, rows)
    state = w.AppState(indexer=indexer, search=FakeSearch(), runtime_info={})
    state.frame_bytes_max = lambda: frame_limit
    pages = _walk_pages(w.build_handlers(state), w.DOCUMENTS_PAGE_MAX, frame_limit)
    flat = [doc_id for page in pages for doc_id in page]
    assert flat == sorted(r[0] for r in rows)  # every row once, in cursor order
    assert all(len(page) < w.DOCUMENTS_PAGE_MAX for page in pages), [len(p) for p in pages]
    assert len(pages) >= 2


def test_documents_page_budget_leaves_headroom() -> None:
    for frame_limit in (64 * 1024 + 1, 256 * 1024, sc.FRAME_BYTES_MAX):
        budget = w.documents_page_budget(frame_limit)
        assert 0 < budget <= frame_limit * 3 // 4


def test_reindex_answers_carry_the_retryable_flag() -> None:
    from worker.local_indexer import IndexResult

    failed = w._result_dict(IndexResult(doc_id="d", doc_name="a.png", doc_type="image", chunk_count=0,
                                        status="failed", errors=["rate limited"], retryable=True))
    assert failed["retryable"] is True
    plain = w._result_dict(IndexResult(doc_id="d", doc_name="a.md", doc_type="md", chunk_count=1, status="indexed"))
    assert plain["retryable"] is False


# ── legacy_index_manifest: what a pre-0.8.0 index held ────────────────────
class _SwitchableEmbedding:
    """Embeds, or fails the way an unreachable provider does."""

    def __init__(self) -> None:
        self.dimensions = 8
        self.down = False

    def embed_corpus(self, chunks: List[str]) -> List[List[float]]:
        if self.down:
            raise RuntimeError("embedding endpoint unreachable")
        return [[0.1] * 8 for _ in chunks]

    def embed_one(self, text: str) -> List[float]:
        return [0.1] * 8


class _Vectors:
    def upsert(self, rows: Any) -> None:
        pass

    def delete(self, *_a: Any, **_k: Any) -> None:
        pass


def _manifest_handlers(workspace: Path) -> Dict[str, Any]:
    state = w.AppState(indexer=FakeIndexer(), search=FakeSearch(), runtime_info={"workspace": str(workspace)})
    return w.build_handlers(state)


def _copy_index(src: Path, workspace: Path) -> Path:
    """What the plugin does: copy fts5.sqlite and its -wal/-shm into the workspace."""
    import shutil

    dest_dir = workspace / ".legacy-index-manifest"
    dest_dir.mkdir(parents=True, exist_ok=True)
    for suffix in ("", "-wal", "-shm"):
        part = Path(f"{src}{suffix}")
        if part.exists():
            shutil.copyfile(part, dest_dir / f"fts5.sqlite{suffix}")
    return dest_dir / "fts5.sqlite"


def test_legacy_manifest_reads_an_index_the_indexer_wrote(tmp_path: Path) -> None:
    fixture = Path(__file__).with_name("indexer.ko.fixture.md")
    docs = tmp_path / "docs"
    docs.mkdir()
    for name in ("with-vectors.md", "without-vectors.md"):
        (docs / name).write_text(fixture.read_text(encoding="utf-8"), encoding="utf-8")
    (docs / "bad.pdf").write_bytes(b"not a pdf")
    embedding = _SwitchableEmbedding()
    old = LocalIndexer(
        workspace=str(tmp_path / "old-ws"),
        sqlite_path=str(tmp_path / "old" / "fts5.sqlite"),
        lance_path=str(tmp_path / "old" / "vectors.lance"),
        openai_api_key="sk-test",
        embedding_client=embedding,
        vector_store=_Vectors(),
    )
    assert old.reindex(str(docs / "with-vectors.md")).status == "indexed"
    embedding.down = True
    assert old.reindex(str(docs / "without-vectors.md")).status == "indexed"
    assert old.reindex(str(docs / "bad.pdf")).status == "failed"
    old.close()

    workspace = tmp_path / "workspace"
    copy = _copy_index(tmp_path / "old" / "fts5.sqlite", workspace)
    page = _call(_manifest_handlers(workspace), "legacy_index_manifest", {"sqlite_path": str(copy)})
    rows = {Path(r["path"]).name: r for r in page["documents"]}
    # Only what the old index held as indexed; a failed file had nothing to lose.
    assert sorted(rows) == ["with-vectors.md", "without-vectors.md"]
    assert rows["with-vectors.md"]["had_vectors"] is True
    assert rows["without-vectors.md"]["had_vectors"] is False
    assert rows["without-vectors.md"]["content_state"] == "embed_failed"
    stat_ms = int((docs / "with-vectors.md").stat().st_mtime * 1000)
    assert rows["with-vectors.md"]["mtime_ms"] == stat_ms
    assert rows["with-vectors.md"]["path"] == str(docs / "with-vectors.md")
    assert page["next_after"] is None


def test_legacy_manifest_reads_an_old_schema_without_the_later_columns(tmp_path: Path) -> None:
    import sqlite3

    src = tmp_path / "old" / "fts5.sqlite"
    src.parent.mkdir()
    conn = sqlite3.connect(src)
    conn.executescript(
        """
        CREATE TABLE documents (
          doc_id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, doc_name TEXT NOT NULL,
          doc_type TEXT NOT NULL, page_count INTEGER, line_count INTEGER,
          mtime_ms INTEGER NOT NULL, indexed_at INTEGER NOT NULL, status TEXT NOT NULL
        );
        INSERT INTO documents VALUES ('d1','/legacy/a.md','a.md','md',1,10,111,222,'indexed');
        INSERT INTO documents VALUES ('d2','/legacy/b.md','b.md','md',1,10,111,222,'pending');
        """
    )
    conn.commit()
    conn.close()
    workspace = tmp_path / "workspace"
    page = _call(_manifest_handlers(workspace), "legacy_index_manifest", {"sqlite_path": str(_copy_index(src, workspace))})
    assert page["documents"] == [
        {"doc_id": "d1", "path": "/legacy/a.md", "mtime_ms": 111, "content_state": None,
         "content_hash": None, "had_vectors": False},
    ]


def test_legacy_manifest_takes_vectors_from_embeddings_meta_without_content_state(tmp_path: Path) -> None:
    import sqlite3

    # Before content_state existed, the only record of vectors is embeddings_meta.
    src = tmp_path / "old" / "fts5.sqlite"
    src.parent.mkdir()
    conn = sqlite3.connect(src)
    conn.executescript(
        """
        CREATE TABLE documents (
          doc_id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, doc_name TEXT NOT NULL,
          doc_type TEXT NOT NULL, mtime_ms INTEGER NOT NULL, indexed_at INTEGER NOT NULL, status TEXT NOT NULL
        );
        CREATE TABLE chunks (chunk_id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, raw_text TEXT NOT NULL);
        CREATE TABLE embeddings_meta (chunk_id TEXT PRIMARY KEY, model TEXT, dimensions INTEGER, embedded_at INTEGER);
        INSERT INTO documents VALUES ('d1','/legacy/a.md','a.md','md',111,222,'indexed');
        INSERT INTO documents VALUES ('d2','/legacy/b.md','b.md','md',111,222,'indexed');
        INSERT INTO chunks VALUES ('c1','d1','x'), ('c2','d2','y');
        INSERT INTO embeddings_meta VALUES ('c1','m',8,1);
        """
    )
    conn.commit()
    conn.close()
    workspace = tmp_path / "workspace"
    page = _call(_manifest_handlers(workspace), "legacy_index_manifest", {"sqlite_path": str(_copy_index(src, workspace))})
    assert {r["doc_id"]: r["had_vectors"] for r in page["documents"]} == {"d1": True, "d2": False}


def test_legacy_manifest_keeps_rows_the_wal_has_not_checkpointed(tmp_path: Path) -> None:
    import sqlite3

    src = tmp_path / "old" / "fts5.sqlite"
    src.parent.mkdir()
    writer = sqlite3.connect(src)
    writer.execute("PRAGMA journal_mode=WAL")
    writer.execute("PRAGMA wal_autocheckpoint=0")
    writer.executescript(
        "CREATE TABLE documents (doc_id TEXT PRIMARY KEY, path TEXT, mtime_ms INTEGER, status TEXT);"
    )
    writer.commit()
    writer.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    writer.executemany(
        "INSERT INTO documents VALUES (?, ?, 1, 'indexed')",
        [(f"d{i}", f"/docs/{i}.md") for i in range(5)],
    )
    writer.commit()
    try:
        workspace = tmp_path / "workspace"
        copy = _copy_index(src, workspace)  # copied while the rows are only in the -wal
        assert Path(f"{copy}-wal").stat().st_size > 0
        # Control: an immutable open of the same copy cannot see them.
        immutable = sqlite3.connect(f"file:{copy}?immutable=1", uri=True)
        try:
            assert immutable.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 0
        finally:
            immutable.close()
        page = _call(_manifest_handlers(workspace), "legacy_index_manifest", {"sqlite_path": str(copy)})
        assert [r["doc_id"] for r in page["documents"]] == [f"d{i}" for i in range(5)]
    finally:
        writer.close()


def test_legacy_manifest_pages_and_refuses_paths_outside_the_workspace(tmp_path: Path) -> None:
    rows = [(f"doc-{i:04d}", f"/docs/{i:04d}.md", f"{i:04d}.md") for i in range(25)]
    indexer = _bulk_indexer(tmp_path / "old", rows)
    indexer.close()
    workspace = tmp_path / "workspace"
    copy = _copy_index(Path(indexer.sqlite_path), workspace)
    handlers = _manifest_handlers(workspace)
    seen: List[str] = []
    after = None
    while True:
        params: Dict[str, Any] = {"sqlite_path": str(copy), "limit": 10}
        if after is not None:
            params["after"] = after
        page = _call(handlers, "legacy_index_manifest", params)
        seen.extend(r["doc_id"] for r in page["documents"])
        if page["next_after"] is None:
            break
        after = page["next_after"]
    assert seen == [r[0] for r in rows]

    with pytest.raises(sc.RequestError) as outside:
        _call(handlers, "legacy_index_manifest", {"sqlite_path": indexer.sqlite_path})
    assert outside.value.code == sc.INVALID_PARAMS
    with pytest.raises(sc.RequestError) as escaped:
        _call(handlers, "legacy_index_manifest", {"sqlite_path": str(workspace / ".." / "old" / "fts5.sqlite")})
    assert escaped.value.code == sc.INVALID_PARAMS
    with pytest.raises(sc.RequestError) as missing:
        _call(handlers, "legacy_index_manifest", {"sqlite_path": str(workspace / "nope.sqlite")})
    assert missing.value.code == sc.NOT_FOUND
    (workspace / "garbage.sqlite").write_bytes(b"\x00" * 4096)
    with pytest.raises(sc.RequestError) as garbage:
        _call(handlers, "legacy_index_manifest", {"sqlite_path": str(workspace / "garbage.sqlite")})
    assert garbage.value.code == sc.SERVER_ERROR
    no_workspace = w.build_handlers(w.AppState(indexer=FakeIndexer(), search=FakeSearch(), runtime_info={}))
    with pytest.raises(sc.RequestError):
        _call(no_workspace, "legacy_index_manifest", {"sqlite_path": str(copy)})


def test_an_unparseable_file_is_a_failed_result_not_a_fault(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(w, "_ALLOWED_ROOTS_RUNTIME", w._ALLOWED_ROOTS_RUNTIME)  # restored after the test
    indexer = LocalIndexer(
        workspace=str(tmp_path / "ws"),
        sqlite_path=str(tmp_path / "fts5.sqlite"),
        lance_path=str(tmp_path / "vectors.lance"),
        openai_api_key="sk-test",
        embedding_client=_SwitchableEmbedding(),
        vector_store=_Vectors(),
    )
    state = w.AppState(indexer=indexer, search=FakeSearch(), runtime_info={})
    handlers = w.build_handlers(state)
    _call(handlers, "runtime_allowed_roots", {"roots": [str(tmp_path)]})
    for name, payload in (("bad.pdf", b"%PDF-1.4 truncated"), ("bad.docx", b"PK\x03\x04 not a zip")):
        path = tmp_path / name
        path.write_bytes(payload)
        result = _call(handlers, "indexer_reindex", {"file_path": str(path)})
        assert result["status"] == "failed", name
        assert result["retryable"] is False, name
        assert result["failure_kind"] == "unparseable", name
        assert "Layer A parse failed" in result["errors"][0], name
        row = indexer.get_document(result["doc_id"])
        assert row is not None and row["status"] == "failed"
    assert state.metrics["failed"] == 2
    assert state.metrics["processed"] == 0
    indexer.close()


def _plain_indexer(tmp_path: Path) -> LocalIndexer:
    return LocalIndexer(
        workspace=str(tmp_path / "ws"),
        sqlite_path=str(tmp_path / "fts5.sqlite"),
        lance_path=str(tmp_path / "vectors.lance"),
        openai_api_key="sk-test",
        embedding_client=_SwitchableEmbedding(),
        vector_store=_Vectors(),
    )


@pytest.mark.skipif(sys.platform == "win32" or getattr(os, "getuid", lambda: 1)() == 0, reason="needs POSIX permissions")
def test_a_file_that_cannot_be_read_now_is_a_read_failure_that_may_pass(tmp_path: Path) -> None:
    indexer = _plain_indexer(tmp_path)
    path = tmp_path / "locked.md"
    path.write_text("# 제목\n본문\n", encoding="utf-8")
    path.chmod(0)
    try:
        result = indexer.reindex(str(path))
    finally:
        path.chmod(0o644)
    assert result.status == "failed"
    assert result.retryable is True
    assert result.failure_kind == "io"
    indexer.close()


def test_a_parser_error_caused_by_a_read_failure_is_not_unparseable(tmp_path: Path) -> None:
    # A Windows sharing violation, EIO on a network volume: parsers raise
    # their own errors with the OSError as the cause, or the OSError itself.
    indexer = _plain_indexer(tmp_path)
    path = tmp_path / "shared.pdf"
    path.write_bytes(b"%PDF-1.4 fine bytes")

    def sharing_violation(_p: str) -> Any:
        raise PermissionError(13, "The process cannot access the file because it is being used by another process")

    def wrapped(_p: str) -> Any:
        try:
            raise OSError(5, "Input/output error")
        except OSError as io:
            raise RuntimeError("pdf parse failed") from io

    for parser in (sharing_violation, wrapped):
        indexer._parser_overrides["pdf"] = parser
        result = indexer.reindex(str(path))
        assert (result.status, result.retryable, result.failure_kind) == ("failed", True, "io"), parser.__name__
    indexer.close()


def test_parse_failure_kind_rereads_the_bytes_before_calling_a_file_unparseable(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import builtins

    import local_indexer as li

    path = tmp_path / "flaky.pdf"
    path.write_bytes(b"%PDF-1.4")
    assert li.parse_failure_kind(str(path), ValueError("bad xref")) == "unparseable"
    real_open = builtins.open

    def failing_open(file: Any, *args: Any, **kwargs: Any) -> Any:
        if str(file) == str(path):
            raise OSError(5, "Input/output error")
        return real_open(file, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", failing_open)
    # A parser error with no OSError attached, on a file that no longer reads.
    assert li.parse_failure_kind(str(path), ValueError("bad xref")) == "io"


def test_a_caption_failure_is_never_unparseable(tmp_path: Path) -> None:
    from worker.image_captioner import CaptionError

    indexer = _plain_indexer(tmp_path)
    path = tmp_path / "photo.pdf"
    path.write_bytes(b"%PDF-1.4")

    def unauthorized(_p: str) -> Any:
        raise CaptionError("OpenAI Vision 호출 실패: Error code: 401", retryable=False)

    indexer._parser_overrides["pdf"] = unauthorized
    result = indexer.reindex(str(path))
    assert (result.status, result.retryable, result.failure_kind) == ("failed", False, "caption")
    assert w._result_dict(result)["failure_kind"] == "caption"
    indexer.close()


def test_legacy_manifest_refuses_a_copy_that_fails_its_integrity_check(tmp_path: Path) -> None:
    import sqlite3

    src = tmp_path / "old" / "fts5.sqlite"
    src.parent.mkdir()
    conn = sqlite3.connect(src)
    conn.execute("PRAGMA page_size=4096")
    conn.execute("CREATE TABLE documents(doc_id TEXT PRIMARY KEY, path TEXT, mtime_ms INT, status TEXT)")
    conn.executemany("INSERT INTO documents VALUES(?, ?, 1, 'indexed')", [(f"d{i:05d}", f"/p/{i}" * 5) for i in range(3000)])
    conn.execute("CREATE INDEX idx_path ON documents(path)")
    conn.commit()
    root = conn.execute("SELECT rootpage FROM sqlite_master WHERE name = 'idx_path'").fetchone()[0]
    conn.close()
    # Damage a page the manifest query never reads: the rows still list, so
    # only the integrity check can tell the copy is not sound.
    with open(src, "r+b") as handle:
        handle.seek((root - 1) * 4096)
        handle.write(b"\x0d" + b"\xff" * 4095)
    reader = sqlite3.connect(src)
    assert len(reader.execute("SELECT doc_id FROM documents WHERE status = 'indexed' ORDER BY doc_id LIMIT 10").fetchall()) == 10
    reader.close()
    workspace = tmp_path / "workspace"
    with pytest.raises(sc.RequestError) as excinfo:
        _call(_manifest_handlers(workspace), "legacy_index_manifest", {"sqlite_path": str(_copy_index(src, workspace))})
    assert excinfo.value.code == sc.SERVER_ERROR
    assert "integrity check" in excinfo.value.message
