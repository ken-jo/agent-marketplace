"""Embedding-key channel: the host-injected ``INDEXER_API_KEY`` env
channel was removed. The worker now boots with an empty key and receives the
credential exclusively through the runtime ``/indexer/set_egress_token``
push, which must reach ALL THREE key consumers — the indexer, the
``SearchService`` (query-time vector search), and the ``AppState`` copy that
backs the caption fallback. The only env channel kept is the user's own
``OPENAI_API_KEY`` dev opt-in (gated host-side by ``AVE_ALLOW_ENV_API_KEY=1``).

These tests prove:
    * ``OpenAIEmbeddingClient`` no longer consults ``INDEXER_API_KEY``;
    * the worker boots with an empty key on all three consumers;
    * the push feeds all three, and — the load-bearing assertion —
      ``SearchService.search_vector`` returns nothing BEFORE the push (no key
      ⇒ no embedding client ⇒ BM25-only) and real hits AFTER it;
    * ``/shutdown`` scrubs the key from all three consumers.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

_REPO_ROOT = Path(__file__).resolve().parent.parent
_WORKER_DIR = _REPO_ROOT / "worker"
_EVAL_DIR = _REPO_ROOT / "eval"
sys.path.insert(0, str(_WORKER_DIR))
sys.path.insert(0, str(_EVAL_DIR))

from embedding_client import OpenAIEmbeddingClient  # noqa: E402
from local_indexer import LocalIndexer  # noqa: E402
from local_indexer_search import SearchService  # noqa: E402
from local_indexer_worker import AppState, create_app  # noqa: E402


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Strip both env vars before each test — leaking either across cases
    would mask a precedence regression."""
    monkeypatch.delenv("INDEXER_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)


# ----------------------------------------------------------------------
# OpenAIEmbeddingClient — env channel removed (INDEXER_API_KEY gone)
# ----------------------------------------------------------------------
def test_explicit_arg_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "env-openai-key")
    client = OpenAIEmbeddingClient(api_key="explicit-key")
    assert client.api_key == "explicit-key"


def test_indexer_api_key_env_not_consulted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The dedicated host→worker env channel is removed: even when set, the
    client must NOT pick up ``INDEXER_API_KEY``."""
    monkeypatch.setenv("INDEXER_API_KEY", "from-indexer-env")
    client = OpenAIEmbeddingClient(api_key=None)
    assert client.api_key == ""


def test_indexer_env_does_not_shadow_openai_optin(monkeypatch: pytest.MonkeyPatch) -> None:
    """With both env vars set, the client resolves to OPENAI_API_KEY (the dev
    opt-in) — INDEXER_API_KEY is ignored entirely."""
    monkeypatch.setenv("INDEXER_API_KEY", "from-indexer-env")
    monkeypatch.setenv("OPENAI_API_KEY", "from-openai")
    client = OpenAIEmbeddingClient(api_key=None)
    assert client.api_key == "from-openai"


def test_openai_api_key_dev_optin_still_works(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "user-exported")
    client = OpenAIEmbeddingClient(api_key=None)
    assert client.api_key == "user-exported"


def test_empty_when_neither_set() -> None:
    client = OpenAIEmbeddingClient(api_key=None)
    assert client.api_key == ""


def test_empty_string_arg_falls_through_to_openai_optin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An empty string ``api_key`` arg falls through to the OPENAI_API_KEY
    dev opt-in — but never to INDEXER_API_KEY (which is gone)."""
    monkeypatch.setenv("INDEXER_API_KEY", "from-indexer-env")
    monkeypatch.setenv("OPENAI_API_KEY", "from-openai")
    client = OpenAIEmbeddingClient(api_key="")
    assert client.api_key == "from-openai"


# ----------------------------------------------------------------------
# Push lifecycle — boot empty, push feeds all three, search_vector revives
# ----------------------------------------------------------------------
def test_push_feeds_all_three_and_revives_vector_search(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    kiwipiepy = pytest.importorskip("kiwipiepy")  # noqa: F841
    from korean_tokenizer import get_tokenizer  # noqa: E402
    from embedder import DeterministicEmbedder  # noqa: E402
    from vector_store import InMemoryCosineStore  # noqa: E402

    doc = tmp_path / "doc.md"
    doc.write_text(
        "# Quarterly Budget\n\n"
        "The quarterly budget report covers revenue and expenses for fiscal year 2026.\n",
        encoding="utf-8",
    )

    tokenizer = get_tokenizer()
    embedder = DeterministicEmbedder()
    store = InMemoryCosineStore()

    # Index the corpus with the deterministic offline embedder injected so the
    # vector store is populated without any network or API key.
    indexer = LocalIndexer(
        workspace=str(tmp_path / "ws"),
        sqlite_path=str(tmp_path / "fts5.sqlite"),
        lance_path=str(tmp_path / "vectors.lance"),
        openai_api_key="",  # worker boots with NO resident key
        tokenizer=tokenizer,
        embedding_client=embedder,
        vector_store=store,
    )
    indexer.index_file(str(doc), mode="md")

    # The SearchService boots WITHOUT an injected embedding client and WITHOUT a
    # key — exactly the post-env-removal boot state. Its query-time vector path
    # is gated on the pushed key.
    search = SearchService(
        sqlite_path=indexer.sqlite_path,
        tokenizer=tokenizer,
        embedding_client=None,
        vector_store=store,
        openai_api_key="",
        embedding_provider="openai",
    )
    state = AppState(
        indexer=indexer, search=search, runtime_info={"pid": 1}, openai_api_key=""
    )

    # All three boot empty.
    assert indexer._openai_api_key == ""
    assert search._openai_api_key == ""
    assert state.openai_api_key == ""

    query = "quarterly budget report revenue"

    # BEFORE the push: no key ⇒ no embedding client ⇒ vector search empty
    # (search silently degrades to BM25-only). This is the exact failure the
    # search-key-feed fix prevents.
    assert search.search_vector(query, top_k=5) == []

    # The pushed key rebuilds the embedding client. In production that is the
    # real OpenAI client; here we substitute the deterministic offline embedder
    # so the query embeds into the same space the corpus was indexed in.
    monkeypatch.setattr(
        "embedding_client.create_embedding_client",
        lambda **kwargs: embedder,
    )
    monkeypatch.setattr("local_indexer_worker.SHUTDOWN_TOKEN", "secret-token")

    client = TestClient(create_app(state))
    resp = client.post(
        "/indexer/set_egress_token",
        headers={"x-ave-shutdown-token": "secret-token"},
        json={"token": "sk-pushed"},
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["hasEmbeddingKey"] is True

    # ALL THREE consumers now hold the pushed key (indexer + search + the
    # AppState copy that backs the caption fallback).
    assert indexer._openai_api_key == "sk-pushed"
    assert search._openai_api_key == "sk-pushed"
    assert state.openai_api_key == "sk-pushed"

    # AFTER the push: the SEARCH path has a key ⇒ vector search returns the
    # indexed chunk. This is the load-bearing proof that the push reaches the
    # search consumer, not just the indexer.
    hits = search.search_vector(query, top_k=5)
    assert hits, "vector search returned no hits after the key push"


def test_shutdown_scrubs_embedding_key_from_all_consumers(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    indexer = LocalIndexer(
        workspace=str(tmp_path / "ws"),
        sqlite_path=str(tmp_path / "fts5.sqlite"),
        lance_path=str(tmp_path / "vectors.lance"),
        openai_api_key="sk-live",
    )
    search = SearchService(
        sqlite_path=str(tmp_path / "fts5.sqlite"),
        openai_api_key="sk-live",
        embedding_provider="openai",
    )
    state = AppState(
        indexer=indexer, search=search, runtime_info={"pid": 1}, openai_api_key="sk-live"
    )

    # Neutralise the post-response shutdown timer: with a fake server attached,
    # _request_shutdown flips ``should_exit`` instead of os.kill-ing pytest.
    class _FakeServer:
        should_exit = False

    state.server = _FakeServer()

    monkeypatch.setattr("local_indexer_worker.SHUTDOWN_TOKEN", "secret-token")
    client = TestClient(create_app(state))
    resp = client.post(
        "/shutdown", headers={"x-ave-shutdown-token": "secret-token"}
    )
    assert resp.status_code == 200

    # Memory scrub: the key is gone from all three consumers.
    assert indexer._openai_api_key is None
    assert search._openai_api_key is None
    assert state.openai_api_key == ""


def test_shutdown_closes_storage_handles(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    indexer = LocalIndexer(
        workspace=str(tmp_path / "ws"),
        sqlite_path=str(tmp_path / "fts5.sqlite"),
        lance_path=str(tmp_path / "vectors.lance"),
        openai_api_key="sk-live",
    )
    search = SearchService(
        sqlite_path=str(tmp_path / "fts5.sqlite"),
        openai_api_key="sk-live",
        embedding_provider="openai",
    )
    state = AppState(
        indexer=indexer, search=search, runtime_info={"pid": 1}, openai_api_key="sk-live"
    )

    class _FakeServer:
        should_exit = False

    state.server = _FakeServer()
    close_calls: list[str] = []

    monkeypatch.setattr(indexer, "close", lambda: close_calls.append("indexer"))
    monkeypatch.setattr(search, "close", lambda: close_calls.append("search"))
    monkeypatch.setattr("local_indexer_worker.SHUTDOWN_TOKEN", "secret-token")

    client = TestClient(create_app(state))
    resp = client.post(
        "/shutdown", headers={"x-ave-shutdown-token": "secret-token"}
    )

    assert resp.status_code == 200
    assert close_calls == ["indexer", "search"]
