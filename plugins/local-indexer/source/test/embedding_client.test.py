"""Pytest for OpenAIEmbeddingClient (mocked)."""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any, List

import pytest

_WORKER_DIR = Path(__file__).resolve().parent.parent / "worker"
sys.path.insert(0, str(_WORKER_DIR))

from embedding_client import (  # noqa: E402
    DEFAULT_PROVIDER,
    OpenAIEmbeddingClient,
    _is_retryable,
    create_embedding_client,
)


class _BrokerResponseError(Exception):
    def __init__(self, status_code: int) -> None:
        super().__init__(f"broker returned {status_code}")
        self.status_code = status_code


class _FakeEmbeddings:
    def __init__(self) -> None:
        self.calls: List[List[str]] = []
        self.fail_429_times = 0

    def create(self, *, model: str, input: List[str], dimensions: int) -> Any:
        self.calls.append(list(input))
        if self.fail_429_times > 0:
            self.fail_429_times -= 1
            raise _BrokerResponseError(429)
        data = [SimpleNamespace(embedding=[0.1] * dimensions) for _ in input]
        return SimpleNamespace(data=data)


class _FakeClient:
    def __init__(self) -> None:
        self.embeddings = _FakeEmbeddings()


@pytest.fixture
def fake_client() -> _FakeClient:
    return _FakeClient()


def _make_client(fake: _FakeClient, **kwargs: Any) -> OpenAIEmbeddingClient:
    return OpenAIEmbeddingClient(
        api_key="sk-test",
        target_rpm=60_000,  # effectively disable throttling for tests
        client_factory=lambda: fake,
        **kwargs,
    )


def test_batch_split_respects_100(fake_client: _FakeClient) -> None:
    client = _make_client(fake_client, batch_size=100)
    assert client.batch_size == 100
    texts = [f"chunk-{i}" for i in range(250)]
    vectors = client.embed_batch(texts)
    assert len(vectors) == 250
    # 250 / 100 → 3 batches (100, 100, 50)
    sizes = [len(c) for c in fake_client.embeddings.calls]
    assert sizes == [100, 100, 50]


def test_embed_one(fake_client: _FakeClient) -> None:
    client = _make_client(fake_client)
    vec = client.embed_one("hello")
    assert isinstance(vec, list)
    assert len(vec) == 1536


def test_retry_on_transient(fake_client: _FakeClient) -> None:
    fake_client.embeddings.fail_429_times = 2
    client = _make_client(fake_client)
    vectors = client.embed_batch(["one", "two"])
    assert len(vectors) == 2
    # Should have retried at least twice before success
    assert len(fake_client.embeddings.calls) >= 3


@pytest.mark.parametrize("status", [403, 499, 500, 501])
def test_broker_denial_is_terminal(status: int) -> None:
    assert not _is_retryable(_BrokerResponseError(status))


@pytest.mark.parametrize("status", [429, 502, 503, 504])
def test_broker_transient_is_retryable(status: int) -> None:
    assert _is_retryable(_BrokerResponseError(status))


def test_empty_input(fake_client: _FakeClient) -> None:
    client = _make_client(fake_client)
    assert client.embed_batch([]) == []


def test_whitespace_only_preserved_position(fake_client: _FakeClient) -> None:
    client = _make_client(fake_client)
    texts = ["foo", "", "bar"]
    vectors = client.embed_batch(texts)
    assert len(vectors) == 3
    # Second input was substituted with " " — one API call passes 3 inputs
    assert fake_client.embeddings.calls[0][1] == " "


def test_azure_full_endpoint_is_normalized_and_preserves_api_version(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: dict[str, str] = {}

    class _FakeAzureClient:
        def __init__(self, *, azure_endpoint: str, api_key: str, api_version: str) -> None:
            seen["azure_endpoint"] = azure_endpoint
            seen["api_key"] = api_key
            seen["api_version"] = api_version
            self.embeddings = _FakeEmbeddings()

    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(AzureOpenAI=_FakeAzureClient))

    client = OpenAIEmbeddingClient(
        api_key="az-test",
        model="text-embedding-3-small",
        endpoint=(
            "https://tenant.cognitiveservices.azure.com/openai/deployments/"
            "text-embedding-3-small/embeddings?api-version=2023-05-15"
        ),
        use_azure=True,
        target_rpm=60_000,
    )

    vectors = client.embed_batch(["hello"])
    assert len(vectors) == 1
    assert seen["azure_endpoint"] == "https://tenant.cognitiveservices.azure.com/"
    assert seen["api_key"] == "az-test"
    assert seen["api_version"] == "2023-05-15"


# ----------------------------------------------------------------------
# Provider-set contract (factory agrees with worker/TS/manifest on {openai, azure})
# ----------------------------------------------------------------------
def test_default_provider_is_supported_and_builds_a_client() -> None:
    # The documented default provider must build a client, not raise. Client
    # construction is lazy (no network until embed_batch), so this is safe.
    client = create_embedding_client(provider=DEFAULT_PROVIDER, api_key="sk-test")
    assert isinstance(client, OpenAIEmbeddingClient)
    assert client.use_azure is False


def test_azure_provider_builds_a_client() -> None:
    client = create_embedding_client(
        provider="azure",
        api_key="az-test",
        endpoint="https://tenant.openai.azure.com/",
    )
    assert isinstance(client, OpenAIEmbeddingClient)
    assert client.use_azure is True


@pytest.mark.parametrize("provider", ["local", "cohere", "sentence-transformers"])
def test_unsupported_provider_raises_value_error(provider: str) -> None:
    # Any non-empty provider outside {openai, azure} (e.g. the removed 'local')
    # is a config-contract violation and must raise loudly, not silently degrade.
    with pytest.raises(ValueError):
        create_embedding_client(provider=provider, api_key="sk-test")


def test_empty_provider_coerces_to_default() -> None:
    # An empty/None provider intentionally means "use the default" (openai),
    # not an error.
    client = create_embedding_client(provider="", api_key="sk-test")
    assert isinstance(client, OpenAIEmbeddingClient)
    assert client.use_azure is False


def test_no_insecure_tls_path_exists() -> None:
    # The verify=False TLS bypass (and its AVE_DEV_INSECURE_TLS gate) is gone:
    # certificate verification can never be disabled via a runtime env var.
    import embedding_client as ec  # noqa: PLC0415

    source = Path(ec.__file__).read_text(encoding="utf-8")
    assert "verify=False" not in source
    assert "AVE_DEV_INSECURE_TLS" not in source


# ----------------------------------------------------------------------
# get_embedding_client distinguishes config-contract from runtime degrade
# ----------------------------------------------------------------------
def _make_indexer(tmp_path: Path, *, provider: str, api_key: str = "sk-test") -> Any:
    from local_indexer import LocalIndexer  # noqa: PLC0415

    return LocalIndexer(
        workspace=str(tmp_path / "workspace"),
        sqlite_path=str(tmp_path / "fts5.sqlite"),
        lance_path=str(tmp_path / "vectors.lance"),
        openai_api_key=api_key,
        embedding_provider=provider,
        embedding_endpoint="https://tenant.openai.azure.com/" if provider == "azure" else "",
    )


def test_get_embedding_client_default_config_does_not_silently_return_none(
    tmp_path: Path,
) -> None:
    # With the documented default provider and a key present, the indexer must
    # produce a usable client — not silently fall through to None / BM25-only.
    indexer = _make_indexer(tmp_path, provider=DEFAULT_PROVIDER)
    client = indexer.get_embedding_client()
    assert client is not None
    assert isinstance(client, OpenAIEmbeddingClient)


def test_get_embedding_client_unsupported_provider_reraises_value_error(
    tmp_path: Path,
) -> None:
    # An unsupported provider is a config bug: get_embedding_client must
    # re-raise the ValueError instead of masking it as a benign BM25-only
    # degrade with a misleading HuggingFace-cold-boot note.
    indexer = _make_indexer(tmp_path, provider="local")
    with pytest.raises(ValueError):
        indexer.get_embedding_client()
