"""Image-caption settings push: the worker keeps no source of truth.

The host owns provider / model / endpoint / api-version (its config) and
pushes all of them on every ``set_image_captioning`` call. On the wire each
of ``model`` / ``endpoint`` / ``api_version`` is tri-state: omitted or
``null`` keeps the worker's current value, ``""`` resets it to the provider
default, a non-empty string sets it. The case that matters is a provider
switch: the host sends ``model=""`` for the new provider and the previous
provider's model must not survive it.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Dict

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

_REPO_ROOT = Path(__file__).resolve().parent.parent
_WORKER_DIR = _REPO_ROOT / "worker"
sys.path.insert(0, str(_WORKER_DIR))

from local_indexer import LocalIndexer  # noqa: E402
from local_indexer_worker import (  # noqa: E402
    AppState,
    SetImageCaptioningRequest,
    create_app,
)

WRITE_TOKEN = "wt"


def _indexer(tmp_path: Path) -> LocalIndexer:
    return LocalIndexer(
        workspace=str(tmp_path / "workspace"),
        sqlite_path=str(tmp_path / "fts5.sqlite"),
        lance_path=str(tmp_path / "vectors.lance"),
        openai_api_key="",
    )


# ── LocalIndexer.set_image_captioning ─────────────────────────────────────
def test_worker_boots_with_captioning_off_and_openai_defaults(tmp_path: Path) -> None:
    state = _indexer(tmp_path).get_image_captioning()
    assert state == {
        "enabled": False,
        "provider": "openai",
        "model": "",
        "endpoint": "",
        "apiVersion": "",
        "hasApiKey": False,
    }


def test_none_keeps_the_current_value(tmp_path: Path) -> None:
    idx = _indexer(tmp_path)
    idx.set_image_captioning(
        enabled=True,
        provider="azure-openai-chat",
        model="vision-deploy",
        endpoint="https://r.openai.azure.com/",
        api_version="2024-08-01-preview",
    )
    idx.set_image_captioning(enabled=False, provider="azure-openai-chat")
    state = idx.get_image_captioning()
    assert state["enabled"] is False
    assert state["model"] == "vision-deploy"
    assert state["endpoint"] == "https://r.openai.azure.com/"
    assert state["apiVersion"] == "2024-08-01-preview"


def test_empty_string_resets_to_the_provider_default(tmp_path: Path) -> None:
    idx = _indexer(tmp_path)
    idx.set_image_captioning(enabled=True, provider="openai", model="gpt-4o")
    idx.set_image_captioning(enabled=True, provider="openai", model="")
    assert idx.get_image_captioning()["model"] == ""


def test_provider_switch_with_empty_fields_drops_the_previous_provider_values(
    tmp_path: Path,
) -> None:
    idx = _indexer(tmp_path)
    idx.set_image_captioning(
        enabled=True,
        provider="azure-openai-responses",
        model="vision-deploy",
        endpoint="https://r.openai.azure.com/",
        api_version="2025-04-01-preview",
    )
    # What the host sends when the user switches to OpenAI without naming a
    # model: every config-derived field, each of them empty.
    idx.set_image_captioning(
        enabled=True, provider="openai", model="", endpoint="", api_version=""
    )
    state = idx.get_image_captioning()
    assert state["provider"] == "openai"
    assert state["model"] == ""
    assert state["endpoint"] == ""
    assert state["apiVersion"] == ""


def test_empty_api_key_keeps_the_current_secret(tmp_path: Path) -> None:
    idx = _indexer(tmp_path)
    idx.set_image_captioning(enabled=True, provider="openai", api_key="sk-1")
    idx.set_image_captioning(enabled=True, provider="openai", api_key="")
    assert idx.get_image_captioning()["hasApiKey"] is True


def test_unknown_provider_is_rejected(tmp_path: Path) -> None:
    idx = _indexer(tmp_path)
    with pytest.raises(ValueError, match="provider"):
        idx.set_image_captioning(enabled=True, provider="local")
    assert idx.get_image_captioning()["provider"] == "openai"


# ── request model ─────────────────────────────────────────────────────────
def test_request_model_distinguishes_omitted_from_empty() -> None:
    omitted = SetImageCaptioningRequest(enabled=True, provider="openai")
    assert omitted.model is None
    assert omitted.endpoint is None
    assert omitted.api_version is None
    reset = SetImageCaptioningRequest(
        enabled=True, provider="openai", model="", endpoint="", api_version=""
    )
    assert reset.model == ""
    assert reset.endpoint == ""
    assert reset.api_version == ""


def test_request_model_applies_the_provider_naming_rule() -> None:
    SetImageCaptioningRequest(enabled=True, provider="openai", model="vendor/qwen2.5-vl")
    with pytest.raises(ValidationError, match="deployment"):
        SetImageCaptioningRequest(
            enabled=True, provider="azure-openai-chat", model="vendor/qwen2.5-vl"
        )
    with pytest.raises(ValidationError):
        SetImageCaptioningRequest(enabled=True, provider="local")


# ── HTTP route ────────────────────────────────────────────────────────────
@pytest.fixture
def worker(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[TestClient, LocalIndexer]:
    monkeypatch.setattr("local_indexer_worker.SHUTDOWN_TOKEN", WRITE_TOKEN)
    idx = _indexer(tmp_path)
    state = AppState(indexer=idx, search=object(), runtime_info={}, openai_api_key="")  # type: ignore[arg-type]
    return TestClient(create_app(state)), idx


def _push(client: TestClient, body: Dict[str, Any]) -> Any:
    return client.post(
        "/indexer/set_image_captioning",
        headers={"x-ave-shutdown-token": WRITE_TOKEN},
        json=body,
    )


def test_route_null_keeps_and_empty_resets(worker: tuple[TestClient, LocalIndexer]) -> None:
    client, idx = worker
    resp = _push(
        client,
        {
            "enabled": True,
            "provider": "azure-openai-chat",
            "model": "vision-deploy",
            "endpoint": "https://r.openai.azure.com/",
            "api_version": "2024-08-01-preview",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["model"] == "vision-deploy"

    # Explicit null and an omitted field both keep the value.
    resp = _push(client, {"enabled": True, "provider": "azure-openai-chat", "model": None})
    assert resp.status_code == 200
    assert resp.json()["data"]["model"] == "vision-deploy"
    assert idx.get_image_captioning()["endpoint"] == "https://r.openai.azure.com/"

    # The provider switch: empty strings clear what the previous provider set.
    resp = _push(
        client,
        {"enabled": True, "provider": "openai", "model": "", "endpoint": "", "api_version": ""},
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["provider"] == "openai"
    assert data["model"] == ""
    assert data["endpoint"] == ""
    assert data["apiVersion"] == ""


def test_route_rejects_a_model_the_provider_cannot_name(
    worker: tuple[TestClient, LocalIndexer],
) -> None:
    client, idx = worker
    resp = _push(
        client,
        {"enabled": True, "provider": "azure-openai-responses", "model": "vendor/model"},
    )
    assert resp.status_code == 422
    assert idx.get_image_captioning()["enabled"] is False


def test_route_rejects_the_removed_local_provider(
    worker: tuple[TestClient, LocalIndexer],
) -> None:
    client, _ = worker
    assert _push(client, {"enabled": True, "provider": "local"}).status_code == 422
