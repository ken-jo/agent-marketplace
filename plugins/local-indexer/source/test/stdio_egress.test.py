"""Provider egress relayed to the plugin (``worker/stdio_egress.py``).

The real openai SDK builds each request; the relay transport hands it to a
fake ``request_blocking`` that plays the plugin. What the plugin receives and
what the SDK makes of the answer are both checked, so a test fails if the
worker sends a key, names an upstream, or misreads a refusal.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

_WORKER_DIR = Path(__file__).resolve().parent.parent / "worker"
sys.path.insert(0, str(_WORKER_DIR))

import openai  # noqa: E402

import image_captioner as ic  # noqa: E402
import stdio_control as sc  # noqa: E402
from embedding_client import OpenAIEmbeddingClient  # noqa: E402
from stdio_egress import CAPTION_IMAGE_BYTES_MAX, EgressRelay  # noqa: E402

REAL_KEY = "sk-REAL-PROVIDER-KEY-must-never-reach-the-relay"


def _json(status: int, body: Any, headers: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    return {
        "status": status,
        "headers": {"content-type": "application/json", **(headers or {})},
        "body": json.dumps(body),
    }


EMBEDDING_OK = _json(
    200,
    {
        "object": "list",
        "data": [{"object": "embedding", "index": 0, "embedding": [0.1, 0.2, 0.3]}],
        "model": "text-embedding-3-small",
        "usage": {"prompt_tokens": 1, "total_tokens": 1},
    },
)

RESPONSES_OK = _json(
    200,
    {
        "id": "resp_1",
        "object": "response",
        "created_at": 0,
        "model": "gpt-4.1-mini",
        "status": "completed",
        "output": [
            {
                "type": "message",
                "id": "msg_1",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": "막대 차트", "annotations": []}],
            }
        ],
        "usage": {"input_tokens": 10, "output_tokens": 3, "total_tokens": 13},
    },
)

CHAT_OK = _json(
    200,
    {
        "id": "chat_1",
        "object": "chat.completion",
        "created": 0,
        "model": "vision",
        "choices": [
            {"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "도면"}}
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12},
    },
)


class FakePlugin:
    def __init__(self, answer: Any) -> None:
        self.answer = answer
        self.calls: List[Dict[str, Any]] = []

    def __call__(self, method: str, params: Any, timeout: Optional[float]) -> Any:
        self.calls.append({"method": method, "params": params, "timeout": timeout})
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


@pytest.fixture(autouse=True)
def _env_key(monkeypatch: pytest.MonkeyPatch) -> None:
    # A real env key is present in every test: relayed paths must ignore it.
    monkeypatch.setenv("OPENAI_API_KEY", REAL_KEY)


def _png(tmp_path: Path, size: int = 40) -> Path:
    p = tmp_path / "img.png"
    header = b"\x89PNG\r\n\x1a\n"
    p.write_bytes(header + b"\x00" * (size - len(header)))
    return p


def _no_secret(params: Dict[str, Any]) -> None:
    flat = json.dumps(params)
    assert REAL_KEY not in flat
    assert "ave-plugin-egress" not in flat  # the dummy SDK key stays in the worker
    assert {k.lower() for k in params["headers"]} <= {"content-type", "accept", "openai-beta"}


# ── embedding ─────────────────────────────────────────────────────────────
def test_openai_embedding_is_one_relayed_request_without_a_key() -> None:
    plugin = FakePlugin(EMBEDDING_OK)
    client = OpenAIEmbeddingClient(api_key=REAL_KEY, dimensions=3, egress_relay=EgressRelay(plugin))
    assert client.api_key == "ave-plugin-egress"
    assert client.embed_one("hello") == [0.1, 0.2, 0.3]

    assert len(plugin.calls) == 1
    call = plugin.calls[0]
    assert call["method"] == "egress_embedding"
    params = call["params"]
    assert params["method"] == "POST"
    assert params["path"] == "/embeddings"
    assert json.loads(params["body"])["input"] == ["hello"]
    assert "bodyEncoding" not in params
    _no_secret(params)


def test_azure_embedding_relays_the_deployment_path_and_api_version() -> None:
    plugin = FakePlugin(EMBEDDING_OK)
    client = OpenAIEmbeddingClient(
        model="embed-deploy",
        dimensions=3,
        use_azure=True,
        api_version="2024-06-01",
        egress_relay=EgressRelay(plugin),
    )
    client.embed_one("hello")
    params = plugin.calls[0]["params"]
    assert params["path"] == "/openai/deployments/embed-deploy/embeddings?api-version=2024-06-01"
    _no_secret(params)


def test_a_plugin_refusal_reaches_the_sdk_as_its_http_status() -> None:
    plugin = FakePlugin(
        _json(403, {"error": "egress-denied", "reason": "lease-unavailable", "terminal": True})
    )
    client = OpenAIEmbeddingClient(dimensions=3, egress_relay=EgressRelay(plugin))
    with pytest.raises(openai.PermissionDeniedError) as excinfo:
        client.embed_one("hello")
    assert excinfo.value.status_code == 403
    assert len(plugin.calls) == 1  # 403 is not retried


def test_a_broken_channel_is_a_connection_error() -> None:
    plugin = FakePlugin(sc.PeerClosed("worker control channel closed (stdin-eof)"))
    client = OpenAIEmbeddingClient(dimensions=3, egress_relay=EgressRelay(plugin))
    with pytest.raises(openai.APIConnectionError):
        client.embed_one("hello")


def test_a_binary_answer_body_is_decoded() -> None:
    import base64

    body = json.dumps(json.loads(EMBEDDING_OK["body"])).encode("utf-8")
    plugin = FakePlugin(
        {"status": 200, "headers": {"content-type": "application/json"},
         "body": base64.b64encode(body).decode("ascii"), "bodyEncoding": "base64"}
    )
    client = OpenAIEmbeddingClient(dimensions=3, egress_relay=EgressRelay(plugin))
    assert client.embed_one("hello") == [0.1, 0.2, 0.3]


# ── captioning ────────────────────────────────────────────────────────────
def test_openai_caption_is_relayed_without_a_key(tmp_path: Path) -> None:
    plugin = FakePlugin(RESPONSES_OK)
    result = ic.caption_image(
        str(_png(tmp_path)), provider="openai", api_key=REAL_KEY, egress_relay=EgressRelay(plugin)
    )
    assert result.caption == "막대 차트"
    call = plugin.calls[0]
    assert call["method"] == "egress_caption"
    assert call["params"]["path"] == "/responses"
    _no_secret(call["params"])


def test_azure_chat_caption_is_relayed_to_the_deployment(tmp_path: Path) -> None:
    plugin = FakePlugin(CHAT_OK)
    result = ic.caption_image(
        str(_png(tmp_path)),
        provider="azure-openai-chat",
        model="vision",
        api_key=REAL_KEY,
        endpoint="https://example.openai.azure.com/",
        egress_relay=EgressRelay(plugin),
    )
    assert result.caption == "도면"
    params = plugin.calls[0]["params"]
    assert params["path"].startswith("/openai/deployments/vision/chat/completions?api-version=")
    # The worker never names the Azure resource; the plugin holds it.
    assert "example.openai.azure.com" not in json.dumps(params)
    _no_secret(params)


def test_azure_responses_caption_is_relayed(tmp_path: Path) -> None:
    plugin = FakePlugin(RESPONSES_OK)
    result = ic.caption_image(
        str(_png(tmp_path)),
        provider="azure-openai-responses",
        model="vision",
        egress_relay=EgressRelay(plugin),
    )
    assert result.caption == "막대 차트"
    assert plugin.calls[0]["params"]["path"].startswith("/openai/responses?api-version=")


def test_an_image_at_the_cap_fits_one_frame(tmp_path: Path) -> None:
    plugin = FakePlugin(RESPONSES_OK)
    image = _png(tmp_path, CAPTION_IMAGE_BYTES_MAX)
    ic.caption_image(str(image), provider="openai", egress_relay=EgressRelay(plugin))
    params = plugin.calls[0]["params"]
    # The body carries the data URL as text, not base64 of base64.
    assert "bodyEncoding" not in params
    frame = sc.encode_frame({"id": "w-1", "method": "egress_caption", "params": params})
    assert len(frame) - 1 <= sc.FRAME_BYTES_MAX


def test_an_image_over_the_cap_is_refused_before_the_relay(tmp_path: Path) -> None:
    plugin = FakePlugin(RESPONSES_OK)
    image = _png(tmp_path, CAPTION_IMAGE_BYTES_MAX + 1)
    with pytest.raises(ic.CaptionError, match="캡션 한도"):
        ic.caption_image(str(image), provider="openai", egress_relay=EgressRelay(plugin))
    assert plugin.calls == []


def test_the_cap_is_11_mib() -> None:
    assert CAPTION_IMAGE_BYTES_MAX == 11 * 1024 * 1024


# ── retryable caption failures (round 3) ──────────────────────────────────
_PROVIDERS = [
    ("openai", {}),
    ("azure-openai-chat", {"model": "vision"}),
    ("azure-openai-responses", {"model": "vision"}),
]

_REFUSALS = {
    429: _json(429, {"error": {"message": "rate limited"}}, {"retry-after": "1"}),
    500: _json(500, {"error": {"message": "boom"}}),
    502: _json(502, {"error": "upstream request failed"}),
    503: _json(503, {"error": {"message": "overloaded"}}),
    499: _json(499, {"error": "egress-denied", "reason": "timeout", "terminal": True}),
    403: _json(403, {"error": "egress-denied", "reason": "lease-unavailable", "terminal": True}),
}


@pytest.mark.parametrize("provider, extra", _PROVIDERS)
@pytest.mark.parametrize("status", sorted(_REFUSALS))
def test_a_caption_that_may_pass_later_is_retryable(tmp_path: Path, provider: str, extra: Dict[str, Any], status: int) -> None:
    plugin = FakePlugin(_REFUSALS[status])
    with pytest.raises(ic.CaptionError) as excinfo:
        ic.caption_image(str(_png(tmp_path)), provider=provider, egress_relay=EgressRelay(plugin), **extra)
    assert excinfo.value.retryable is True, (provider, status, str(excinfo.value))


@pytest.mark.parametrize("provider, extra", _PROVIDERS)
@pytest.mark.parametrize(
    "failure",
    [sc.PeerClosed("worker control channel closed (stdin-eof)"), TimeoutError("egress_caption was not answered")],
)
def test_a_caption_whose_relay_broke_is_retryable(tmp_path: Path, provider: str, extra: Dict[str, Any], failure: Exception) -> None:
    plugin = FakePlugin(failure)
    with pytest.raises(ic.CaptionError) as excinfo:
        ic.caption_image(str(_png(tmp_path)), provider=provider, egress_relay=EgressRelay(plugin), **extra)
    assert excinfo.value.retryable is True


@pytest.mark.parametrize("status", [400, 401, 404, 413])
def test_a_caption_the_provider_rejects_outright_is_not_retryable(tmp_path: Path, status: int) -> None:
    plugin = FakePlugin(_json(status, {"error": {"message": "no"}}))
    with pytest.raises(ic.CaptionError) as excinfo:
        ic.caption_image(str(_png(tmp_path)), provider="openai", egress_relay=EgressRelay(plugin))
    assert excinfo.value.retryable is False


def test_deterministic_caption_errors_are_not_retryable(tmp_path: Path) -> None:
    big = tmp_path / "big.png"
    big.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * (CAPTION_IMAGE_BYTES_MAX + 1))
    with pytest.raises(ic.CaptionError) as oversize:
        ic.caption_image(str(big), provider="openai", egress_relay=EgressRelay(FakePlugin(RESPONSES_OK)))
    assert oversize.value.retryable is False
    with pytest.raises(ic.CaptionError) as no_config:
        ic.caption_image(str(_png(tmp_path)), provider="azure-openai-chat", model="vision", endpoint="", api_key="")
    assert no_config.value.retryable is False


def _relayed_indexer(tmp_path: Path, plugin: FakePlugin) -> Any:
    from local_indexer import LocalIndexer

    class _Embed:
        dimensions = 3

        def embed_corpus(self, texts: Any) -> Any:  # pragma: no cover - never reached
            return [[0.0, 0.0, 0.0] for _ in texts]

    class _Store:
        def delete(self, *_a: Any, **_k: Any) -> None:  # pragma: no cover
            pass

    indexer = LocalIndexer(
        workspace=str(tmp_path / "ws"),
        sqlite_path=str(tmp_path / "fts5.sqlite"),
        lance_path=str(tmp_path / "vectors.lance"),
        openai_api_key=None,
        embedding_client=_Embed(),
        vector_store=_Store(),
        egress_relay=EgressRelay(plugin),
    )
    indexer.set_image_captioning(enabled=True, provider="openai")
    return indexer


def test_a_rate_limited_caption_makes_a_retryable_failed_result(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The repro: a caption 429 during indexing must not read as the worker's verdict on the file."""
    import os

    import local_indexer_worker as lw

    monkeypatch.setattr(lw, "_ALLOWED_ROOTS_RUNTIME", [os.path.realpath(str(tmp_path))])
    plugin = FakePlugin(_REFUSALS[429])
    result = _relayed_indexer(tmp_path, plugin).index_file(str(_png(tmp_path)), mode="image")
    assert result.status == "failed"
    assert result.retryable is True
    assert any("호출 실패" in e for e in result.errors)
    assert plugin.calls and plugin.calls[0]["method"] == "egress_caption"


def test_an_image_outside_the_current_roots_is_a_retryable_failed_result(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import local_indexer_worker as lw

    monkeypatch.setattr(lw, "_ALLOWED_ROOTS_RUNTIME", [str(tmp_path / "elsewhere")])
    plugin = FakePlugin(RESPONSES_OK)
    result = _relayed_indexer(tmp_path, plugin).index_file(str(_png(tmp_path)), mode="image")
    assert result.status == "failed"
    assert result.retryable is True
    assert plugin.calls == []

