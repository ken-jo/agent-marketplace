"""Worker-side egress-broker (P3 ⑬) routing tests.

The security invariant under test: with a broker configured the worker holds
NO provider key — only the per-session token — and EVERY egress path (embedding
+ all caption providers) addresses the broker, presenting the token via
``x-ave-egress-token`` and a dummy SDK auth field. Each test is written to FAIL
if the worker leaked a real key or bypassed the broker.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List

import pytest
from fastapi.testclient import TestClient

_REPO_ROOT = Path(__file__).resolve().parent.parent
_WORKER_DIR = _REPO_ROOT / "worker"
sys.path.insert(0, str(_WORKER_DIR))

import embedding_client as ec  # noqa: E402
import image_captioner as ic  # noqa: E402
from embedding_client import OpenAIEmbeddingClient  # noqa: E402
from local_indexer import LocalIndexer  # noqa: E402
from local_indexer_search import SearchService  # noqa: E402
from local_indexer_worker import AppState, create_app  # noqa: E402

REAL_KEY = "sk-REAL-PROVIDER-KEY-must-never-reach-worker"
BROKER_BASE = "http://127.0.0.1:54999"
TOKEN = "session-egress-token-xyz"


# ── SDK capture fakes ─────────────────────────────────────────────────────
class _FakeEmbeddings:
    def create(self, **kwargs: Any) -> Any:
        dims = kwargs.get("dimensions", 3)
        return SimpleNamespace(data=[SimpleNamespace(embedding=[0.1] * dims) for _ in kwargs["input"]])


class _CapturingOpenAI:
    instances: List[Dict[str, Any]] = []

    def __init__(self, **kwargs: Any) -> None:
        _CapturingOpenAI.instances.append(kwargs)
        self.embeddings = _FakeEmbeddings()
        # Responses API for caption-openai.
        self.responses = SimpleNamespace(
            create=lambda **_k: SimpleNamespace(output_text="caption", usage=None)
        )


class _CapturingAzureOpenAI:
    instances: List[Dict[str, Any]] = []

    def __init__(self, **kwargs: Any) -> None:
        _CapturingAzureOpenAI.instances.append(kwargs)
        self.embeddings = _FakeEmbeddings()
        self.chat = SimpleNamespace(
            completions=SimpleNamespace(
                create=lambda **_k: SimpleNamespace(
                    choices=[SimpleNamespace(message=SimpleNamespace(content="caption"))],
                    usage=None,
                )
            )
        )
        self.responses = SimpleNamespace(
            create=lambda **_k: SimpleNamespace(output_text="caption", usage=None)
        )


@pytest.fixture(autouse=True)
def _reset(monkeypatch: pytest.MonkeyPatch) -> None:
    _CapturingOpenAI.instances.clear()
    _CapturingAzureOpenAI.instances.clear()
    fake_openai = SimpleNamespace(OpenAI=_CapturingOpenAI, AzureOpenAI=_CapturingAzureOpenAI)
    monkeypatch.setitem(sys.modules, "openai", fake_openai)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)


def _png(tmp_path: Path) -> str:
    p = tmp_path / "img.png"
    p.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 32)
    return str(p)


# ── Embedding egress ──────────────────────────────────────────────────────
def test_embedding_client_broker_mode_uses_token_header_and_dummy_key() -> None:
    client = OpenAIEmbeddingClient(
        api_key=None,
        egress_broker_url=f"{BROKER_BASE}/egress/embedding",
        egress_token=TOKEN,
    )
    client.embed_one("hello")
    assert len(_CapturingOpenAI.instances) == 1
    kw = _CapturingOpenAI.instances[0]
    assert kw["base_url"] == f"{BROKER_BASE}/egress/embedding"
    assert kw["default_headers"] == {"x-ave-egress-token": TOKEN}
    # The SDK auth field is a dummy, NEVER a real key.
    assert kw["api_key"] != REAL_KEY
    assert kw["api_key"] == "ave-egress-broker"


def test_embedding_broker_gates_off_env_openai_key(monkeypatch: pytest.MonkeyPatch) -> None:
    # Mutation guard: in broker mode the OPENAI_API_KEY dev opt-in must NOT be
    # consulted (an env key would bypass the broker).
    monkeypatch.setenv("OPENAI_API_KEY", REAL_KEY)
    client = OpenAIEmbeddingClient(
        api_key=None,
        egress_broker_url=f"{BROKER_BASE}/egress/embedding",
        egress_token=TOKEN,
    )
    assert client.api_key == "ave-egress-broker"
    assert REAL_KEY not in client.api_key


def test_embedding_broker_over_loopback_tcp_dials_the_base_url_directly() -> None:
    # Where the broker binds loopback TCP (Windows: listen(path) there makes a
    # named pipe, not a Unix socket, and httpx2 cannot pin a transport to a pipe)
    # there is no socket path, the base URL is the real bound address, and the
    # SDK's own client is what reaches it.
    client = OpenAIEmbeddingClient(
        api_key=None,
        egress_broker_url="http://127.0.0.1:1234/egress/embedding",
        egress_broker_uds=None,
        egress_token=TOKEN,
    )
    client.embed_one("hello")
    kw = _CapturingOpenAI.instances[0]
    assert kw["base_url"] == "http://127.0.0.1:1234/egress/embedding"
    assert kw["http_client"] is None
    # Still brokered: dummy SDK auth, token on its own header.
    assert kw["api_key"] == "ave-egress-broker"
    assert kw["default_headers"] == {"x-ave-egress-token": TOKEN}


def test_embedding_broker_over_unix_socket_pins_the_transport_to_it(tmp_path: Path) -> None:
    # Mutation guard for the case above: a socket path must still produce a
    # pinned client, or the URL (a dummy authority there) would be dialled.
    sock = str(tmp_path / "egress.sock")
    client = OpenAIEmbeddingClient(
        api_key=None,
        egress_broker_url="http://localhost/egress/embedding",
        egress_broker_uds=sock,
        egress_token=TOKEN,
    )
    client.embed_one("hello")
    http_client = _CapturingOpenAI.instances[0]["http_client"]
    assert http_client is not None
    http_client.close()


def test_broker_http_client_is_built_only_for_a_socket_path() -> None:
    assert ec.broker_http_client(None) is None
    assert ec.broker_http_client("") is None


def test_azure_embedding_broker_keeps_channel_path_unnormalized() -> None:
    client = OpenAIEmbeddingClient(
        api_key=None,
        use_azure=True,
        api_version="2024-02-01",
        egress_broker_url=f"{BROKER_BASE}/egress/embedding",
        egress_token=TOKEN,
    )
    client.embed_one("hello")
    kw = _CapturingAzureOpenAI.instances[0]
    # The broker channel path must survive (the SDK appends /openai/... to it).
    assert kw["azure_endpoint"] == f"{BROKER_BASE}/egress/embedding"
    assert kw["api_key"] == "ave-egress-broker"
    assert kw["default_headers"] == {"x-ave-egress-token": TOKEN}


def test_indexer_broker_mode_holds_token_not_key() -> None:
    indexer = LocalIndexer(
        workspace="/tmp/ave-broker-test-ws",
        sqlite_path="/tmp/ave-broker-test.sqlite",
        lance_path="/tmp/ave-broker-test.lance",
        openai_api_key="",
        egress_broker_url=BROKER_BASE,
    )
    assert indexer.egress_brokered is True
    assert indexer.egress_embedding_url == f"{BROKER_BASE}/egress/embedding"
    # No token yet → no client (BM25-only until the host pushes it).
    assert indexer.get_embedding_client() is None
    # Push the token (the renamed /indexer/set_egress_token path stores it here).
    indexer.set_embedding_api_key(TOKEN)
    # The holder carries the TOKEN, never a provider key.
    assert indexer._openai_api_key == TOKEN
    assert indexer._openai_api_key != REAL_KEY
    client = indexer.get_embedding_client()
    assert client is not None
    client.embed_one("hi")
    kw = _CapturingOpenAI.instances[-1]
    assert kw["base_url"] == f"{BROKER_BASE}/egress/embedding"
    assert kw["default_headers"] == {"x-ave-egress-token": TOKEN}
    assert kw["api_key"] != REAL_KEY


def test_search_broker_mode_routes_through_broker() -> None:
    search = SearchService(
        sqlite_path="/tmp/ave-broker-search.sqlite",
        embedding_provider="openai",
        egress_broker_url=BROKER_BASE,
    )
    assert search.egress_brokered is True
    assert search._get_embedding_client() is None  # no token yet
    search.set_embedding_api_key(TOKEN)
    assert search._openai_api_key == TOKEN
    client = search._get_embedding_client()
    assert client is not None
    client.embed_one("hi")
    kw = _CapturingOpenAI.instances[-1]
    assert kw["base_url"] == f"{BROKER_BASE}/egress/embedding"
    assert kw["default_headers"] == {"x-ave-egress-token": TOKEN}


# ── Caption egress (all four providers) ───────────────────────────────────
def test_caption_openai_broker_mode(tmp_path: Path) -> None:
    ic.caption_image(
        _png(tmp_path),
        provider="openai",
        endpoint=f"{BROKER_BASE}/egress/caption",
        api_key=None,
        egress_token=TOKEN,
    )
    kw = _CapturingOpenAI.instances[-1]
    assert kw["base_url"] == f"{BROKER_BASE}/egress/caption"
    assert kw["default_headers"] == {"x-ave-egress-token": TOKEN}
    assert kw["api_key"] != REAL_KEY


def test_caption_azure_chat_broker_mode(tmp_path: Path) -> None:
    ic.caption_image(
        _png(tmp_path),
        provider="azure-openai-chat",
        model="gpt-4o-mini",
        endpoint=f"{BROKER_BASE}/egress/caption",
        api_key=None,
        egress_token=TOKEN,
    )
    kw = _CapturingAzureOpenAI.instances[-1]
    assert kw["azure_endpoint"] == f"{BROKER_BASE}/egress/caption"
    assert kw["default_headers"] == {"x-ave-egress-token": TOKEN}
    assert kw["api_key"] != REAL_KEY


def test_caption_azure_responses_broker_mode(tmp_path: Path) -> None:
    ic.caption_image(
        _png(tmp_path),
        provider="azure-openai-responses",
        model="gpt-4o-mini",
        endpoint=f"{BROKER_BASE}/egress/caption",
        api_key=None,
        egress_token=TOKEN,
    )
    kw = _CapturingAzureOpenAI.instances[-1]
    assert kw["azure_endpoint"] == f"{BROKER_BASE}/egress/caption"
    assert kw["default_headers"] == {"x-ave-egress-token": TOKEN}


# ── Route rename ─────────────────────────────────────────────────────────
def test_set_egress_token_route_feeds_all_three_holders(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("local_indexer_worker.SHUTDOWN_TOKEN", "wt")

    class _Idx:
        def __init__(self) -> None:
            self.key = ""

        def set_embedding_api_key(self, v: str) -> None:
            self.key = v

    idx = _Idx()
    search = _Idx()
    state = AppState(indexer=idx, search=search, runtime_info={}, openai_api_key="")
    client = TestClient(create_app(state))
    resp = client.post(
        "/indexer/set_egress_token",
        headers={"x-ave-shutdown-token": "wt"},
        json={"token": TOKEN},
    )
    assert resp.status_code == 200
    assert idx.key == TOKEN
    assert search.key == TOKEN
    assert state.openai_api_key == TOKEN
    # The legacy route name is gone.
    gone = client.post(
        "/indexer/set_embedding_api_key",
        headers={"x-ave-shutdown-token": "wt"},
        json={"api_key": TOKEN},
    )
    assert gone.status_code == 404
