"""Tests for the real-embedding env hook in eval/run_eval.py (build_embedder).

These guard the Stage-0 rebuild: the eval harness must use the REAL
``OpenAIEmbeddingClient`` when ``EVAL_EMBEDDING_ENDPOINT`` is set (so the
nightly job measures genuine embedding quality), and fall back to the offline
``DeterministicEmbedder`` when it is not (so the per-PR gate runs with no key
and no network).

CRITICAL: every test here passes WITHOUT any API key. The real-client path is
verified by INSPECTING the constructed client's configuration — no ``embed_*``
call is made, so no network request and no key validation happens. A key is
never hard-coded.
"""

from __future__ import annotations

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_EVAL_DIR = _REPO_ROOT / "eval"
_WORKER_DIR = _REPO_ROOT / "worker"
sys.path.insert(0, str(_WORKER_DIR))
sys.path.insert(0, str(_EVAL_DIR))

import run_eval  # noqa: E402
from embedder import DeterministicEmbedder  # noqa: E402

_ENV_KEYS = (
    "EVAL_EMBEDDING_ENDPOINT",
    "EVAL_EMBEDDING_API_KEY",
    "EVAL_EMBEDDING_MODEL",
    "EVAL_EMBEDDING_PROVIDER",
    "EVAL_EMBEDDING_DIMENSIONS",
)


def _clear_eval_env(monkeypatch) -> None:
    for key in _ENV_KEYS:
        monkeypatch.delenv(key, raising=False)


# ----------------------------------------------------------------------
# Fallback path (no endpoint → deterministic, no key, no network)
# ----------------------------------------------------------------------
def test_build_embedder_falls_back_to_deterministic(monkeypatch) -> None:
    _clear_eval_env(monkeypatch)
    client, label = run_eval.build_embedder()
    assert isinstance(client, DeterministicEmbedder)
    assert label == "deterministic"


def test_blank_endpoint_falls_back_to_deterministic(monkeypatch) -> None:
    # A present-but-empty endpoint must NOT trip the real path.
    _clear_eval_env(monkeypatch)
    monkeypatch.setenv("EVAL_EMBEDDING_ENDPOINT", "   ")
    client, label = run_eval.build_embedder()
    assert isinstance(client, DeterministicEmbedder)
    assert label == "deterministic"


def test_run_env_hook_smoke_without_key(monkeypatch) -> None:
    # End-to-end smoke: with no EVAL_EMBEDDING_* env, run() (no embedder arg)
    # selects the deterministic embedder and produces a valid result with NO
    # key and NO network. This is the "passes without a key" guarantee.
    _clear_eval_env(monkeypatch)
    result = run_eval.run()
    assert result["embedder"] == "deterministic"
    assert 0.0 <= result["recall@10"] <= 1.0
    assert 0.0 <= result["ndcg@10"] <= 1.0
    assert result["corpus_size"] >= 100
    assert result["query_count"] >= 35


# ----------------------------------------------------------------------
# Real path (endpoint set → real OpenAIEmbeddingClient, config-only checks)
# ----------------------------------------------------------------------
def test_build_embedder_uses_real_client_when_endpoint_set(monkeypatch) -> None:
    _clear_eval_env(monkeypatch)
    monkeypatch.setenv("EVAL_EMBEDDING_ENDPOINT", "https://api.openai.test/v1")
    monkeypatch.setenv("EVAL_EMBEDDING_API_KEY", "test-not-a-real-key")

    client, label = run_eval.build_embedder()

    from embedding_client import OpenAIEmbeddingClient

    assert isinstance(client, OpenAIEmbeddingClient)
    # Pointed at the endpoint, carrying the provided key, default model — all
    # without making a request (the SDK client is constructed lazily).
    assert client.endpoint == "https://api.openai.test/v1"
    assert client.api_key == "test-not-a-real-key"
    assert client.model == run_eval.DEFAULT_REAL_MODEL
    assert label == f"real:openai:{run_eval.DEFAULT_REAL_MODEL}"
    # Interface compatibility with the indexer/search DI seam.
    assert hasattr(client, "embed_one") and hasattr(client, "embed_corpus")


def test_real_client_honors_model_and_dimensions(monkeypatch) -> None:
    _clear_eval_env(monkeypatch)
    monkeypatch.setenv("EVAL_EMBEDDING_ENDPOINT", "https://api.openai.test/v1")
    monkeypatch.setenv("EVAL_EMBEDDING_API_KEY", "test-not-a-real-key")
    monkeypatch.setenv("EVAL_EMBEDDING_MODEL", "text-embedding-3-large")
    monkeypatch.setenv("EVAL_EMBEDDING_DIMENSIONS", "3072")

    client, label = run_eval.build_embedder()

    assert client.model == "text-embedding-3-large"
    assert client.dimensions == 3072
    assert label == "real:openai:text-embedding-3-large"


def test_invalid_dimensions_falls_back_to_default(monkeypatch) -> None:
    # A non-integer EVAL_EMBEDDING_DIMENSIONS must not crash the harness.
    _clear_eval_env(monkeypatch)
    monkeypatch.setenv("EVAL_EMBEDDING_ENDPOINT", "https://api.openai.test/v1")
    monkeypatch.setenv("EVAL_EMBEDDING_API_KEY", "test-not-a-real-key")
    monkeypatch.setenv("EVAL_EMBEDDING_DIMENSIONS", "not-a-number")

    client, _ = run_eval.build_embedder()
    assert client.dimensions == run_eval.DEFAULT_REAL_DIMENSIONS
