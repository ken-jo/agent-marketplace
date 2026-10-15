"""Input hardening for the worker's image captioner.

The captioner forwards a file's bytes to a cloud vision provider. Every
provider path goes through ``_image_to_data_url``, so that one function is
where the file is validated: the extension must be one the providers accept,
the size must fit under ``MAX_IMAGE_BYTES`` (checked on ``st_size`` before
the file is read), and the leading bytes must carry the signature the
extension claims. A model identifier is checked against the naming rule of
the provider that will receive it, before any SDK client is constructed.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_WORKER_DIR = Path(__file__).resolve().parent.parent / "worker"
sys.path.insert(0, str(_WORKER_DIR))

import image_captioner as ic  # noqa: E402

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 32
WEBP = b"RIFF\x00\x00\x00\x00WEBP" + b"\x00" * 32


def _write(tmp_path: Path, name: str, data: bytes) -> Path:
    p = tmp_path / name
    p.write_bytes(data)
    return p


class _NeverConstructed:
    """Stands in for the SDK client classes; constructing one is the failure."""

    def __init__(self, *args: object, **kwargs: object) -> None:
        raise AssertionError("provider client constructed before input validation")


@pytest.fixture
def no_sdk_clients(monkeypatch: pytest.MonkeyPatch) -> None:
    import openai

    monkeypatch.setattr(openai, "OpenAI", _NeverConstructed)
    monkeypatch.setattr(openai, "AzureOpenAI", _NeverConstructed)


# ── extension ──────────────────────────────────────────────────────────────
def test_unknown_extension_is_rejected_not_relabelled(tmp_path: Path) -> None:
    bmp = _write(tmp_path, "img.bmp", PNG)
    with pytest.raises(ic.CaptionError, match="확장자"):
        ic._image_to_data_url(bmp)


def test_missing_extension_is_rejected(tmp_path: Path) -> None:
    bare = _write(tmp_path, "img", PNG)
    with pytest.raises(ic.CaptionError, match="확장자"):
        ic._image_to_data_url(bare)


def test_gif_is_rejected_up_front(tmp_path: Path) -> None:
    # Only non-animated GIF would be accepted upstream and the signature
    # cannot tell the two apart, so the extension is not in the allowlist.
    gif = _write(tmp_path, "img.gif", b"GIF89a" + b"\x00" * 32)
    with pytest.raises(ic.CaptionError, match="확장자"):
        ic._image_to_data_url(gif)


# ── magic bytes ────────────────────────────────────────────────────────────
def test_signature_must_match_extension(tmp_path: Path) -> None:
    mislabelled = _write(tmp_path, "img.png", JPEG)
    with pytest.raises(ic.CaptionError, match="시그니처 image/jpeg"):
        ic._image_to_data_url(mislabelled)


def test_unknown_signature_is_rejected(tmp_path: Path) -> None:
    text = _write(tmp_path, "img.png", b"<html>not an image</html>")
    with pytest.raises(ic.CaptionError, match="알 수 없음"):
        ic._image_to_data_url(text)


@pytest.mark.parametrize(
    ("name", "data", "mime"),
    [
        ("a.png", PNG, "image/png"),
        ("a.jpg", JPEG, "image/jpeg"),
        ("a.JPEG", JPEG, "image/jpeg"),
        ("a.webp", WEBP, "image/webp"),
    ],
)
def test_accepted_formats_encode_with_their_mime(
    tmp_path: Path, name: str, data: bytes, mime: str
) -> None:
    url = ic._image_to_data_url(_write(tmp_path, name, data))
    assert url.startswith(f"data:{mime};base64,")


# ── size ───────────────────────────────────────────────────────────────────
def test_empty_file_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ic.CaptionError, match="비어"):
        ic._image_to_data_url(_write(tmp_path, "img.png", b""))


def test_oversized_file_is_rejected_before_it_is_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    big = _write(tmp_path, "img.png", PNG)
    monkeypatch.setattr(ic, "MAX_IMAGE_BYTES", len(PNG) - 1)

    def _no_read(*args: object, **kwargs: object) -> None:
        raise AssertionError("file opened despite exceeding MAX_IMAGE_BYTES")

    monkeypatch.setattr(Path, "open", _no_read)
    with pytest.raises(ic.CaptionError, match="너무 큽니다"):
        ic._image_to_data_url(big)


def test_size_cap_is_azure_openai_per_image_limit() -> None:
    # 20 MB decimal — Azure OpenAI's documented per-image vision limit; a
    # 20 MiB cap (20,971,520) would admit files Azure refuses.
    assert ic.MAX_IMAGE_BYTES == 20_000_000


def test_file_that_grows_after_the_stat_is_still_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    growing = _write(tmp_path, "img.png", PNG)
    monkeypatch.setattr(ic, "MAX_IMAGE_BYTES", len(PNG) + 8)
    real_open = Path.open

    def grow_then_open(self: Path, *args: object, **kwargs: object) -> object:
        # The watched folder's writer appends between our stat and our read.
        with real_open(self, "ab") as fh:
            fh.write(b"\x00" * 64)
        return real_open(self, *args, **kwargs)

    monkeypatch.setattr(Path, "open", grow_then_open)
    with pytest.raises(ic.CaptionError, match="읽는 중"):
        ic._image_to_data_url(growing)


def test_read_is_bounded_to_one_byte_over_the_cap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    png = _write(tmp_path, "img.png", PNG)
    monkeypatch.setattr(ic, "MAX_IMAGE_BYTES", len(PNG))
    real_open = Path.open
    requested: list[object] = []

    class _Handle:
        def __init__(self, fh: object) -> None:
            self._fh = fh

        def read(self, n: int = -1) -> bytes:
            requested.append(n)
            return self._fh.read(n)  # type: ignore[attr-defined]

        def __enter__(self) -> "_Handle":
            return self

        def __exit__(self, *exc: object) -> None:
            self._fh.__exit__(*exc)  # type: ignore[attr-defined]

    monkeypatch.setattr(Path, "open", lambda self, *a, **k: _Handle(real_open(self, *a, **k)))
    ic._image_to_data_url(png)
    assert requested == [len(PNG) + 1]


def test_file_at_the_cap_is_accepted(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    exact = _write(tmp_path, "img.png", PNG)
    monkeypatch.setattr(ic, "MAX_IMAGE_BYTES", len(PNG))
    assert ic._image_to_data_url(exact).startswith("data:image/png;base64,")


# ── validation precedes the provider client ────────────────────────────────
def test_caption_image_rejects_bad_file_before_building_a_client(
    tmp_path: Path, no_sdk_clients: None
) -> None:
    bmp = _write(tmp_path, "img.bmp", PNG)
    with pytest.raises(ic.CaptionError) as info:
        ic.caption_image(str(bmp), provider="openai", api_key="k")
    assert "확장자" in str(info.value)
    assert "호출 실패" not in str(info.value)


def test_caption_image_rejects_bad_model_before_building_a_client(
    tmp_path: Path, no_sdk_clients: None
) -> None:
    png = _write(tmp_path, "img.png", PNG)
    with pytest.raises(ic.CaptionError, match="모델명"):
        ic.caption_image(str(png), provider="openai", model="gpt 4", api_key="k")


def test_azure_paths_validate_input_before_building_a_client(
    tmp_path: Path, no_sdk_clients: None
) -> None:
    mislabelled = _write(tmp_path, "img.png", JPEG)
    for provider in ("azure-openai-chat", "azure-openai-responses"):
        with pytest.raises(ic.CaptionError, match="시그니처"):
            ic.caption_image(
                str(mislabelled),
                provider=provider,
                model="vision-deploy",
                endpoint="https://r.openai.azure.com/",
                api_key="k",
            )


# ── model naming rule per provider ─────────────────────────────────────────
@pytest.mark.parametrize(
    "model",
    ["gpt-4.1-mini", "o4-mini", "chatgpt-4o-latest", "vendor/qwen2.5-vl-7b", "ns:model-1"],
)
def test_openai_model_shapes_accepted(model: str) -> None:
    assert ic.validate_caption_model("openai", model) == model


@pytest.mark.parametrize(
    "model",
    ["gpt 4", "../gpt-4o", "vendor//model", "/gpt-4o", "gpt-4o/", "-gpt", "a" * 129, "모델"],
)
def test_openai_model_shapes_rejected(model: str) -> None:
    with pytest.raises(ic.CaptionError, match="OpenAI 모델명"):
        ic.validate_caption_model("openai", model)


@pytest.mark.parametrize("model", ["gpt-4o-mini", "my_deploy.v2", "A1", "a" * 64])
@pytest.mark.parametrize("provider", ["azure-openai-chat", "azure-openai-responses"])
def test_azure_deployment_shapes_accepted(provider: str, model: str) -> None:
    assert ic.validate_caption_model(provider, model) == model


@pytest.mark.parametrize("model", ["vendor/model", "a b", "-lead", ".lead", "a" * 65, "배포"])
@pytest.mark.parametrize("provider", ["azure-openai-chat", "azure-openai-responses"])
def test_azure_deployment_shapes_rejected(provider: str, model: str) -> None:
    with pytest.raises(ic.CaptionError, match="deployment"):
        ic.validate_caption_model(provider, model)


@pytest.mark.parametrize("model", [None, "", "   "])
def test_blank_model_means_provider_default(model: str | None) -> None:
    assert ic.validate_caption_model("openai", model) is None
    assert ic.validate_caption_model("azure-openai-chat", model) is None


def test_model_is_stripped_before_the_rule_applies() -> None:
    assert ic.validate_caption_model("openai", "  gpt-4o  ") == "gpt-4o"


def test_unknown_provider_is_rejected_by_the_model_rule() -> None:
    with pytest.raises(ic.CaptionError, match="provider"):
        ic.validate_caption_model("local", "anything")


# ── the local BLIP path is gone ────────────────────────────────────────────
def test_local_provider_no_longer_exists(tmp_path: Path) -> None:
    for name in ("_caption_local", "_load_blip", "DEFAULT_LOCAL_MODEL", "_local_blip_cache"):
        assert not hasattr(ic, name), name
    png = _write(tmp_path, "img.png", PNG)
    with pytest.raises(ic.CaptionError, match="provider"):
        ic.caption_image(str(png), provider="local")  # type: ignore[arg-type]
