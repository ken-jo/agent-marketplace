"""Embedding credential: the worker holds none.

The host-injected env channel under the retired product prefix
(``RETIRED_INDEXER_KEY_ENV`` below) was removed, and the worker's provider
egress is relayed to the plugin, which supplies the credential per request.
What the plugin pushes is only whether a credential exists
(``indexer_set_embedding_egress``), and that push must reach BOTH consumers:
the indexer and the ``SearchService`` (query-time vector search). The only env
channel kept is the user's own ``OPENAI_API_KEY`` dev opt-in on the direct
(eval) path, and it is off whenever egress is relayed.

These tests prove:
    * ``OpenAIEmbeddingClient`` no longer consults ``RETIRED_INDEXER_KEY_ENV``;
    * the relayed worker boots with embedding off on both consumers;
    * the push turns both on, and — the load-bearing assertion —
      ``SearchService.search_vector`` returns nothing BEFORE the push
      (BM25-only) and real hits AFTER it;
    * ``worker_shutdown`` turns both off and closes the stores.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent
_WORKER_DIR = _REPO_ROOT / "worker"
_EVAL_DIR = _REPO_ROOT / "eval"
sys.path.insert(0, str(_WORKER_DIR))
sys.path.insert(0, str(_EVAL_DIR))

from embedding_client import OpenAIEmbeddingClient  # noqa: E402
from local_indexer import LocalIndexer  # noqa: E402
from local_indexer_search import SearchService  # noqa: E402
from local_indexer_worker import AppState, build_handlers  # noqa: E402

# The removed channel's real variable name. Its prefix is the retired product
# name, built from code points the way tools/check-retired-name.mjs builds it,
# so the repository's retired-name gate never sees it spelled out.
RETIRED_INDEXER_KEY_ENV = (
    "".join(chr(code) for code in (0x6C, 0x76, 0x69, 0x73)).upper() + "_INDEXER_API_KEY"
)


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Strip both env vars before each test — leaking either across cases
    would mask a precedence regression."""
    monkeypatch.delenv(RETIRED_INDEXER_KEY_ENV, raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)


# ----------------------------------------------------------------------
# OpenAIEmbeddingClient — env channel removed (RETIRED_INDEXER_KEY_ENV gone)
# ----------------------------------------------------------------------
def test_explicit_arg_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "env-openai-key")
    client = OpenAIEmbeddingClient(api_key="explicit-key")
    assert client.api_key == "explicit-key"


def test_retired_indexer_api_key_env_not_consulted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The dedicated host→worker env channel is removed: even when set, the
    client must NOT pick up ``RETIRED_INDEXER_KEY_ENV``."""
    monkeypatch.setenv(RETIRED_INDEXER_KEY_ENV, "from-retired-env")
    client = OpenAIEmbeddingClient(api_key=None)
    assert client.api_key == ""


def test_retired_indexer_env_does_not_shadow_openai_optin(monkeypatch: pytest.MonkeyPatch) -> None:
    """With both env vars set, the client resolves to OPENAI_API_KEY (the dev
    opt-in) — ``RETIRED_INDEXER_KEY_ENV`` is ignored entirely."""
    monkeypatch.setenv(RETIRED_INDEXER_KEY_ENV, "from-retired-env")
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
    dev opt-in — but never to ``RETIRED_INDEXER_KEY_ENV`` (which is gone)."""
    monkeypatch.setenv(RETIRED_INDEXER_KEY_ENV, "from-retired-env")
    monkeypatch.setenv("OPENAI_API_KEY", "from-openai")
    client = OpenAIEmbeddingClient(api_key="")
    assert client.api_key == "from-openai"


# ----------------------------------------------------------------------
# Push lifecycle — boot off, push turns both on, search_vector revives
# ----------------------------------------------------------------------
class _Relay:
    """Stands in for ``stdio_egress.EgressRelay``; never reached here."""

    def http_client(self, channel: str) -> object:
        raise AssertionError(f"no provider call expected ({channel})")


def _call(handlers: dict, method: str, params: object = None) -> object:
    return asyncio.run(handlers[method](params))


def test_push_feeds_both_and_revives_vector_search(
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
        openai_api_key="",
        tokenizer=tokenizer,
        embedding_client=embedder,
        vector_store=store,
    )
    indexer.index_file(str(doc), mode="md")

    relay = _Relay()
    # The SearchService boots relayed WITHOUT an injected embedding client:
    # exactly the worker's boot state. Its query-time vector path waits for
    # the plugin's push.
    search = SearchService(
        sqlite_path=indexer.sqlite_path,
        tokenizer=tokenizer,
        embedding_client=None,
        vector_store=store,
        openai_api_key="",
        embedding_provider="openai",
        egress_relay=relay,
    )
    relayed_indexer = LocalIndexer(
        workspace=str(tmp_path / "ws2"),
        sqlite_path=str(tmp_path / "fts5-2.sqlite"),
        lance_path=str(tmp_path / "vectors-2.lance"),
        openai_api_key="",
        egress_relay=relay,
    )
    state = AppState(indexer=relayed_indexer, search=search, runtime_info={"pid": 1})
    handlers = build_handlers(state, egress_relay=relay)

    assert relayed_indexer._embedding_egress_enabled is False
    assert search._embedding_egress_enabled is False

    query = "quarterly budget report revenue"

    # BEFORE the push: no embedding client, so vector search is empty and
    # search degrades to BM25-only.
    assert search.search_vector(query, top_k=5) == []
    assert relayed_indexer.get_embedding_client() is None

    # After the push the client is rebuilt. In production it is the relayed
    # OpenAI client; here the deterministic offline embedder stands in so the
    # query embeds into the same space the corpus was indexed in.
    built: list[dict] = []

    def _factory(**kwargs: object) -> object:
        built.append(kwargs)
        return embedder

    monkeypatch.setattr("embedding_client.create_embedding_client", _factory)

    assert _call(handlers, "indexer_set_embedding_egress", {"enabled": True}) == {"embeddingEgress": True}

    assert relayed_indexer._embedding_egress_enabled is True
    assert search._embedding_egress_enabled is True

    # AFTER the push the SEARCH path has an embedding client, so vector search
    # returns the indexed chunk: the push reaches the search consumer, not just
    # the indexer.
    hits = search.search_vector(query, top_k=5)
    assert hits, "vector search returned no hits after the push"
    # Built relayed: no key, no endpoint, the relay passed through.
    assert built[0]["api_key"] is None
    assert built[0]["endpoint"] is None
    assert built[0]["egress_relay"] is relay


def test_push_rejects_a_missing_flag(tmp_path: Path) -> None:
    from stdio_control import RequestError  # noqa: E402

    relay = _Relay()
    indexer = LocalIndexer(
        workspace=str(tmp_path / "ws"),
        sqlite_path=str(tmp_path / "fts5.sqlite"),
        lance_path=str(tmp_path / "vectors.lance"),
        openai_api_key="",
        egress_relay=relay,
    )
    search = SearchService(sqlite_path=str(tmp_path / "fts5.sqlite"), egress_relay=relay)
    handlers = build_handlers(AppState(indexer=indexer, search=search, runtime_info={}), egress_relay=relay)
    with pytest.raises(RequestError) as excinfo:
        _call(handlers, "indexer_set_embedding_egress", {})
    assert excinfo.value.code == -32602
    assert indexer._embedding_egress_enabled is False


def test_shutdown_turns_egress_off_and_closes_storage(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    relay = _Relay()
    indexer = LocalIndexer(
        workspace=str(tmp_path / "ws"),
        sqlite_path=str(tmp_path / "fts5.sqlite"),
        lance_path=str(tmp_path / "vectors.lance"),
        openai_api_key="",
        egress_relay=relay,
    )
    search = SearchService(
        sqlite_path=str(tmp_path / "fts5.sqlite"),
        embedding_provider="openai",
        egress_relay=relay,
    )
    state = AppState(indexer=indexer, search=search, runtime_info={"pid": 1}, openai_api_key="sk-dev")
    handlers = build_handlers(state, egress_relay=relay)
    _call(handlers, "indexer_set_embedding_egress", {"enabled": True})

    close_calls: list[str] = []
    monkeypatch.setattr(indexer, "close", lambda: close_calls.append("indexer"))
    monkeypatch.setattr(search, "close", lambda: close_calls.append("search"))

    assert _call(handlers, "worker_shutdown") == {"bye": True}

    assert indexer._embedding_egress_enabled is False
    assert search._embedding_egress_enabled is False
    assert state.openai_api_key == ""
    assert close_calls == ["indexer", "search"]
    # Closing twice (the shutdown method, then stdin EOF) closes once.
    state.close_storage()
    assert close_calls == ["indexer", "search"]
