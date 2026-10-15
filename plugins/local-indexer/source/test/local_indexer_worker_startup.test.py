"""Worker startup regression tests."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

_WORKER_DIR = Path(__file__).resolve().parent.parent / "worker"
sys.path.insert(0, str(_WORKER_DIR))

from local_indexer_worker import AppState, create_app, main  # noqa: E402


def test_main_defers_tokenizer_initialization(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: dict[str, object] = {}

    class FakeIndexer:
        def __init__(self, **kwargs: object) -> None:
            calls["indexer_kwargs"] = kwargs
            self.sqlite_path = kwargs["sqlite_path"]

        def _get_tokenizer(self) -> object:
            raise AssertionError("startup should not eagerly create the tokenizer")

    class FakeSearchService:
        def __init__(self, **kwargs: object) -> None:
            calls["search_kwargs"] = kwargs

    class FakeServer:
        def __init__(self, config: object) -> None:
            self.config = config
            self.should_exit = False

        def run(self) -> None:
            calls["server_run"] = True

    def fake_arm_watchdog(server: object) -> bool:
        # main() must hand the server it built to the watchdog; the test
        # process's own stdin is not the host's liveness pipe, so do not arm.
        calls["watchdog_server"] = server
        return False

    monkeypatch.setattr("local_indexer_worker.LocalIndexer", FakeIndexer)
    monkeypatch.setattr("local_indexer_worker.SearchService", FakeSearchService)
    monkeypatch.setattr("local_indexer_worker.uvicorn.Server", FakeServer)
    monkeypatch.setattr("local_indexer_worker.arm_host_liveness_watchdog", fake_arm_watchdog)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "local_indexer_worker.py",
            "--workspace",
            str(tmp_path / "workspace"),
            "--sqlite",
            str(tmp_path / "fts5.sqlite"),
            "--lance",
            str(tmp_path / "vectors.lance"),
            "--embedding-provider",
            "openai",
            "--embedding-model",
            "text-embedding-3-small",
        ],
    )

    main()

    assert calls["search_kwargs"]["tokenizer"] is None
    assert isinstance(calls["watchdog_server"], FakeServer)
    assert calls["server_run"] is True


def test_read_and_search_routes_require_worker_token(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeIndexer:
        def list_documents(self) -> list[dict[str, object]]:
            return []

    class FakeSearch:
        def search_hybrid_internal(self, query: str, top_k: int) -> list[dict[str, object]]:
            return []

    monkeypatch.setattr("local_indexer_worker.SHUTDOWN_TOKEN", "secret-token")
    app = create_app(
        AppState(
            indexer=FakeIndexer(),  # type: ignore[arg-type]
            search=FakeSearch(),  # type: ignore[arg-type]
            runtime_info={"pid": 123},
        )
    )
    client = TestClient(app)

    assert client.get("/health").status_code == 200
    assert client.get("/documents").status_code == 403
    assert client.post("/search/hybrid", json={"query": "private", "topK": 5}).status_code == 403

    headers = {"x-ave-shutdown-token": "secret-token"}
    assert client.get("/documents", headers=headers).status_code == 200
    assert client.post("/search/hybrid", headers=headers, json={"query": "private", "topK": 5}).status_code == 200
