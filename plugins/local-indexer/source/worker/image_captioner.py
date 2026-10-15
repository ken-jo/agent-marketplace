"""Image captioning service for the local-indexer worker.

Provides a uniform ``caption_image`` entry point over the cloud vision
providers:

* **OpenAI** (provider=``openai``) — sends the image to the configured
  vision model (default ``gpt-4.1-mini``) via the Responses API and asks
  for an *image-only* caption suitable for retrieval indexing. This is
  the same shape as test.ipynb's ``openai_describe_image_only``
  pipeline — the slide / page text is intentionally NOT included so
  the resulting caption depends solely on the visual content.

* **Azure OpenAI** (provider=``azure-openai-chat`` /
  ``azure-openai-responses``) — the same prompt against a vision-capable
  Azure deployment, over chat-completions or the Responses API.

Every provider receives the image as a base64 data URL, so the file is
validated once, in ``_image_to_data_url`` — extension, size, and magic
bytes — before any provider client is built.

The module deliberately exposes a small surface (``caption_image``,
``CaptionResult``, ``validate_caption_model``) so the worker FastAPI
endpoint can wrap it without re-implementing provider routing or model
validation.

This is the search_1-style flow from test.ipynb: image -> visual
caption -> downstream text embedding handled by the existing
embedding client. We never embed pixels directly.
"""

from __future__ import annotations

import base64
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Optional

# Deferred at call time elsewhere in this package, but this one is a pure
# function with no heavy import behind it — and it must be the SAME function the
# embedding client uses, because a second copy of "how to reach the broker"
# would be free to disagree with the first about what the transport is.
from worker.embedding_client import broker_http_client  # type: ignore

ProviderLiteral = Literal[
    "openai",
    "azure-openai-chat",
    "azure-openai-responses",
]

DEFAULT_OPENAI_MODEL = "gpt-4.1-mini"

AZURE_OPENAI_RESPONSES_API_VERSION = "2025-04-01-preview"

# Model identifiers are validated per provider, because the two provider
# families name models differently and a single loose pattern would let a
# value through that one of them cannot mean.
#
# * OpenAI / OpenAI-compatible: published model ids (``gpt-4.1-mini``,
#   ``o4-mini``) plus the ``vendor/model`` form OpenAI-compatible gateways
#   (LiteLLM, LM Studio) use. A single path separator is the only extra
#   character that form needs, and it must be followed by an alphanumeric,
#   so ``vendor//model`` and a trailing ``/`` are out. The first character
#   must be alphanumeric, which is what rejects a leading ``..``; dots
#   inside the id are ordinary characters (``gpt-4.1-mini``).
# * Azure OpenAI: ``model`` is a *deployment name*, which the subscription
#   owner chooses when creating the deployment. There is no model-family
#   prefix to check against, so only Azure's own naming rule is enforced —
#   alphanumerics, ``-``, ``_``, ``.``, 64 characters at most.
_OPENAI_MODEL_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._:-]|/(?=[A-Za-z0-9])){0,127}$")
_AZURE_DEPLOYMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

# Upper bound on the image file size the worker will read and forward.
# Azure OpenAI documents 20 MB (decimal) per image for vision input; OpenAI
# documents a per-request total instead of a per-image cap, so the Azure
# figure is applied to both providers as a conservative shared ceiling.
# Anything larger is a guaranteed Azure rejection that we would have paid
# for up front by reading the whole file into memory and base64-encoding it
# (x4/3). ``st_size`` is the cheap fast path (one stat, no bytes); the read
# itself is bounded too, because a file under a chokidar-watched folder can
# still be growing between the stat and the read.
MAX_IMAGE_BYTES = 20_000_000

# Korean image-only prompt mirrors test.ipynb's search_1 pipeline so
# downstream retrieval has the same keyword shape.
_OPENAI_PROMPT = (
    "이미지만 보고 검색용 시각 설명을 한국어로 작성해줘.\n"
    "주변 텍스트는 고려하지 말고 이미지에 보이는 객체, 구조, 차트/도면 유형,\n"
    "키워드를 중심으로 작성해줘."
)

# GIF is deliberately absent: the providers accept only non-animated GIF,
# the magic bytes cannot tell the two apart, and GIF is marginal inside
# indexed documents. A ``.gif`` is rejected up front rather than uploaded
# and refused.
_MIME_BY_EXT = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}

# Longest signature we need to read: RIFF????WEBP (12 bytes).
_MAGIC_HEADER_LEN = 12


def _sniff_mime(head: bytes) -> Optional[str]:
    """Return the MIME type the file's leading bytes declare, or ``None``.

    Only the container signatures of the accepted formats are known here;
    anything else is *unknown*, not "probably PNG".
    """
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    return None


def validate_caption_model(provider: str, model: Optional[str]) -> Optional[str]:
    """Check ``model`` against the naming rule of ``provider``.

    Returns the stripped model, or ``None`` when the caller passed nothing
    (the provider default applies). Raises ``CaptionError`` for a value
    that the provider cannot name. Shared by the HTTP request models and
    the in-process index path so both boundaries apply the same rule.
    """
    if model is None:
        return None
    value = model.strip()
    if not value:
        return None
    if provider == "openai":
        if not _OPENAI_MODEL_RE.fullmatch(value):
            raise CaptionError(f"OpenAI 모델명 형식이 잘못됐습니다: {model!r}")
        return value
    if provider in ("azure-openai-chat", "azure-openai-responses"):
        if not _AZURE_DEPLOYMENT_RE.fullmatch(value):
            raise CaptionError(
                f"Azure OpenAI deployment 이름 형식이 잘못됐습니다: {model!r}"
            )
        return value
    raise CaptionError(f"알 수 없는 caption provider: {provider}")


@dataclass
class CaptionResult:
    caption: str
    provider: ProviderLiteral
    model: str
    input_tokens: int = 0
    output_tokens: int = 0


class CaptionError(RuntimeError):
    """Raised when captioning fails for a recoverable reason (bad input,
    missing API key, model load failure). The worker endpoint should
    convert this to a 4xx/5xx HTTP response without crashing the
    process."""


def _image_to_data_url(path: Path) -> str:
    """Validate the image file and encode it as a ``data:`` URL.

    The extension, the size, and the magic bytes must all agree before the
    bytes are forwarded: an unknown extension is rejected rather than
    labelled ``image/png`` (the provider would reject the mislabelled body
    anyway, after we had uploaded it), a file over ``MAX_IMAGE_BYTES`` is
    rejected on ``st_size`` before it is read, and a body whose signature
    does not match its extension is rejected because the extension came
    from a document parser and the bytes came from the document.
    """
    ext = path.suffix.lower()
    mime = _MIME_BY_EXT.get(ext)
    if mime is None:
        raise CaptionError(
            f"지원하지 않는 이미지 확장자입니다 ({ext or '없음'}): {path.name}. "
            f"허용: {', '.join(sorted(_MIME_BY_EXT))}"
        )
    size = path.stat().st_size
    if size == 0:
        raise CaptionError(f"이미지 파일이 비어 있습니다: {path.name}")
    if size > MAX_IMAGE_BYTES:
        raise CaptionError(
            f"이미지 파일이 너무 큽니다 ({size} bytes > {MAX_IMAGE_BYTES} bytes): {path.name}"
        )
    # Bounded read: ``st_size`` was the fast path, not the guarantee. Ask for
    # one byte more than the cap — if it arrives, the file outgrew the stat.
    with path.open("rb") as f:
        data = f.read(MAX_IMAGE_BYTES + 1)
    if len(data) > MAX_IMAGE_BYTES:
        raise CaptionError(
            f"이미지 파일이 너무 큽니다 (읽는 중 {MAX_IMAGE_BYTES} bytes 초과): {path.name}"
        )
    sniffed = _sniff_mime(data[:_MAGIC_HEADER_LEN])
    if sniffed != mime:
        raise CaptionError(
            f"이미지 내용이 확장자와 다릅니다 ({ext} 확장자, 시그니처 "
            f"{sniffed or '알 수 없음'}): {path.name}"
        )
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:{mime};base64,{b64}"


def _caption_openai(
    image_data_url: str,
    model: str,
    api_key: Optional[str],
    base_url: Optional[str] = None,
    egress_token: Optional[str] = None,
    egress_uds: Optional[str] = None,
) -> CaptionResult:
    if not egress_token and not api_key:
        raise CaptionError(
            "OpenAI 이미지 캡션을 사용하려면 apiKey 또는 OPENAI_API_KEY 환경변수가 필요합니다."
        )
    try:
        from openai import OpenAI  # type: ignore
    except Exception as exc:  # pragma: no cover - dep guard
        raise CaptionError(f"openai SDK 로드 실패: {exc}") from exc

    if egress_token:
        # Broker mode: dummy SDK key, token via header, broker base URL.
        client = OpenAI(  # egress-gate: allow — broker mode: base_url is the host-owned egress broker, not the provider
            api_key="ave-egress-broker",
            base_url=base_url or None,
            default_headers={"x-ave-egress-token": egress_token},
            http_client=broker_http_client(egress_uds),
            max_retries=0,
        )
    else:
        # ``base_url`` lets the user point at any OpenAI-compatible endpoint
        # (LM Studio, LiteLLM, an internal proxy, etc.). Empty string is
        # treated as "use the SDK default" — passing "" through to the SDK
        # would route to ``https:///...`` and fail.
        client = OpenAI(api_key=api_key, base_url=base_url or None)  # egress-gate: allow — legacy direct caption egress (grandfathered; reindented under the broker-mode branch, behaviour unchanged)
    try:
        res = client.responses.create(
            model=model or DEFAULT_OPENAI_MODEL,
            input=[
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": _OPENAI_PROMPT},
                        {
                            "type": "input_image",
                            "image_url": image_data_url,
                            "detail": "low",
                        },
                    ],
                }
            ],
        )
    except Exception as exc:
        raise CaptionError(f"OpenAI Vision 호출 실패: {exc}") from exc

    caption = getattr(res, "output_text", "") or ""
    usage = getattr(res, "usage", None)
    return CaptionResult(
        caption=caption.strip(),
        provider="openai",
        model=model or DEFAULT_OPENAI_MODEL,
        input_tokens=getattr(usage, "input_tokens", 0) or 0,
        output_tokens=getattr(usage, "output_tokens", 0) or 0,
    )


def _caption_azure_openai_chat(
    image_data_url: str,
    endpoint: Optional[str],
    api_key: Optional[str],
    model: Optional[str],
    api_version: Optional[str] = None,
    egress_token: Optional[str] = None,
    egress_uds: Optional[str] = None,
) -> CaptionResult:
    """Caption an image via Azure OpenAI chat-completions (vision-capable deployment).

    Use this when your Azure subscription only provisions ``/openai/deployments/
    <name>/`` endpoints (no Computer Vision multi-service API). The deployment
    referenced by ``model`` MUST be vision-capable (gpt-4o, gpt-4o-mini,
    gpt-5-mini, gpt-5.4-mini, etc.); a text-only deployment will reject the
    ``image_url`` message part with 400.

    This path goes through the Azure OpenAI Python SDK so the URL construction
    (``/openai/deployments/<deploy>/chat/completions?api-version=...``) is
    delegated to the SDK — the caller only supplies the resource root and the
    api-version.
    """
    if not endpoint:
        raise CaptionError(
            "Azure OpenAI 캡션을 사용하려면 endpoint (리소스 root URL) 가 필요합니다 "
            "(예: https://<resource>.openai.azure.com/ 또는 .cognitiveservices.azure.com/)."
        )
    if not egress_token and not api_key:
        raise CaptionError("Azure OpenAI 캡션을 사용하려면 apiKey 가 필요합니다.")
    if not model:
        raise CaptionError(
            "Azure OpenAI 캡션을 사용하려면 model (vision-capable deployment 이름) 이 필요합니다."
        )

    try:
        from openai import AzureOpenAI  # type: ignore
        from urllib.parse import urlparse
    except Exception as exc:  # pragma: no cover - dep guard
        raise CaptionError(
            f"openai SDK 의 AzureOpenAI 클래스 로드 실패: {exc}"
        ) from exc

    parsed = urlparse(endpoint)
    if not parsed.scheme or not parsed.netloc:
        raise CaptionError(
            f"Azure OpenAI endpoint URL 형식이 잘못됐습니다: {endpoint}"
        )
    # Broker mode (P3 ⑬): keep the broker caption channel path intact (the SDK
    # appends /openai/deployments/… to it and the broker forwards the remainder).
    # Legacy mode: normalize to the resource root (the Azure SDK requires it).
    normalized_endpoint = endpoint if egress_token else f"{parsed.scheme}://{parsed.netloc}/"

    # Default api-version for vision-capable chat-completions. The
    # ``image_url`` content part stabilized around ``2024-08-01-preview``;
    # earlier versions reject the multimodal message shape with 400.
    effective_version = (api_version or "").strip() or "2024-08-01-preview"

    client = AzureOpenAI(
        api_key="ave-egress-broker" if egress_token else api_key,
        azure_endpoint=normalized_endpoint,
        api_version=effective_version,
        default_headers={"x-ave-egress-token": egress_token} if egress_token else None,
        http_client=broker_http_client(egress_uds),
        max_retries=0 if egress_token else 2,
    )
    # gpt-5 계열 / o1 / o3 reasoning 모델은 `max_tokens` 를 거부하고
    # `max_completion_tokens` 만 받는다 (Azure OpenAI 400 "Unsupported
    # parameter" 에러). gpt-4o 계열도 `max_completion_tokens` 받으므로 한
    # 파라미터로 통일.
    try:
        res = client.chat.completions.create(
            model=model,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": _OPENAI_PROMPT},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": image_data_url,
                                "detail": "low",
                            },
                        },
                    ],
                }
            ],
            max_completion_tokens=128,
        )
    except Exception as exc:
        raise CaptionError(f"Azure OpenAI Vision 호출 실패: {exc}") from exc

    caption = ""
    try:
        caption = (res.choices[0].message.content or "").strip()
    except Exception:  # pragma: no cover - defensive parse
        caption = ""

    usage = getattr(res, "usage", None)
    return CaptionResult(
        caption=caption,
        provider="azure-openai-chat",
        model=model,
        input_tokens=getattr(usage, "prompt_tokens", 0) or 0,
        output_tokens=getattr(usage, "completion_tokens", 0) or 0,
    )


def _caption_azure_openai_responses(
    image_data_url: str,
    endpoint: Optional[str],
    api_key: Optional[str],
    model: Optional[str],
    api_version: Optional[str] = None,
    egress_token: Optional[str] = None,
    egress_uds: Optional[str] = None,
) -> CaptionResult:
    """Caption an image via Azure OpenAI Responses API.

    This mirrors the OpenAI ``responses.create`` path but uses the AzureOpenAI
    SDK client so the caller only supplies the resource root and deployment
    name. It is the right fit when the Azure environment exposes model-specific
    surfaces through ``/openai/responses`` rather than chat completions.
    """
    if not endpoint:
        raise CaptionError(
            "Azure OpenAI Responses 罹≪뀡???ъ슜?섎젮硫?endpoint (由ъ냼??root URL) 媛 ?꾩슂?⑸땲??"
            "(?? https://<resource>.openai.azure.com/ ?먮뒗 .cognitiveservices.azure.com/)."
        )
    if not egress_token and not api_key:
        raise CaptionError("Azure OpenAI Responses 罹≪뀡???ъ슜?섎젮硫?apiKey 媛 ?꾩슂?⑸땲??")
    if not model:
        raise CaptionError(
            "Azure OpenAI Responses 罹≪뀡???ъ슜?섎젮硫?model (vision-capable deployment ?대쫫) ???꾩슂?⑸땲??"
        )

    try:
        from openai import AzureOpenAI  # type: ignore
        from urllib.parse import urlparse
    except Exception as exc:  # pragma: no cover - dep guard
        raise CaptionError(
            f"openai SDK ??AzureOpenAI ?대옒??濡쒕뱶 ?ㅽ뙣: {exc}"
        ) from exc

    parsed = urlparse(endpoint)
    if not parsed.scheme or not parsed.netloc:
        raise CaptionError(
            f"Azure OpenAI endpoint URL ?뺤떇???섎せ?먯뒿?덈떎: {endpoint}"
        )
    # Broker mode (P3 ⑬): keep the broker caption channel path; legacy mode
    # normalizes to the resource root.
    normalized_endpoint = endpoint if egress_token else f"{parsed.scheme}://{parsed.netloc}/"
    effective_version = (api_version or "").strip() or AZURE_OPENAI_RESPONSES_API_VERSION

    client = AzureOpenAI(
        api_key="ave-egress-broker" if egress_token else api_key,
        azure_endpoint=normalized_endpoint,
        api_version=effective_version,
        default_headers={"x-ave-egress-token": egress_token} if egress_token else None,
        http_client=broker_http_client(egress_uds),
        max_retries=0 if egress_token else 2,
    )
    try:
        res = client.responses.create(
            model=model,
            input=[
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": _OPENAI_PROMPT},
                        {
                            "type": "input_image",
                            "image_url": image_data_url,
                            "detail": "low",
                        },
                    ],
                }
            ],
        )
    except Exception as exc:
        raise CaptionError(f"Azure OpenAI Responses ?몄텧 ?ㅽ뙣: {exc}") from exc

    caption = getattr(res, "output_text", "") or ""
    usage = getattr(res, "usage", None)
    return CaptionResult(
        caption=caption.strip(),
        provider="azure-openai-responses",
        model=model,
        input_tokens=getattr(usage, "input_tokens", 0) or 0,
        output_tokens=getattr(usage, "output_tokens", 0) or 0,
    )


def caption_image(
    path: str,
    provider: ProviderLiteral = "openai",
    model: Optional[str] = None,
    api_key: Optional[str] = None,
    endpoint: Optional[str] = None,
    api_version: Optional[str] = None,
    egress_token: Optional[str] = None,
    egress_uds: Optional[str] = None,
) -> CaptionResult:
    """Caption a single image file and return the raw caption string.

    The caller is responsible for routing the caption text to the embedding
    pipeline — this function intentionally does not call the embedding
    client because that path is already encapsulated in
    ``local_indexer`` / the worker's embedding service.

    ``endpoint`` is shared across providers:
      * ``provider="openai"`` — optional OpenAI-compatible base URL. Empty
        means the SDK default (``api.openai.com``).
      * ``provider="azure-openai-*"`` — Azure OpenAI resource root
        (``https://<resource>.openai.azure.com/``); required.

    ``model`` is validated against the provider's naming rule before any
    client is built (see ``validate_caption_model``); ``None`` / empty
    selects the provider default. ``api_version`` (Azure-only) is the
    ``api-version`` query value; empty selects the module default.
    """
    image_path = Path(path)
    if not image_path.is_file():
        raise CaptionError(f"이미지 파일을 찾을 수 없습니다: {path}")
    model = validate_caption_model(provider, model)
    # Validate + encode before any provider client exists, so a rejected
    # file never reaches an SDK and its error is not reported as a call
    # failure.
    image_data_url = _image_to_data_url(image_path)
    # Host-mediated egress broker (P3 ⑬): when an egress token is present the
    # call routes through the broker (``endpoint`` is the broker caption
    # channel, the token rides ``x-ave-egress-token``, and the broker injects
    # the real provider auth). The OPENAI_API_KEY dev opt-in is GATED OFF in
    # broker mode — falling back to a real env key would bypass the broker.
    if provider == "openai":
        # In broker mode (egress_token present) the OPENAI_API_KEY dev opt-in is
        # gated off: using an env key would bypass the broker and send the real
        # key to the worker.
        resolved_key = None if egress_token else (api_key or os.environ.get("OPENAI_API_KEY"))
        return _caption_openai(
            image_data_url,
            model or DEFAULT_OPENAI_MODEL,
            resolved_key,
            endpoint,
            egress_token=egress_token,
            egress_uds=egress_uds,
        )
    if provider == "azure-openai-chat":
        return _caption_azure_openai_chat(
            image_data_url, endpoint, api_key, model, api_version,
            egress_token=egress_token, egress_uds=egress_uds
        )
    if provider == "azure-openai-responses":
        return _caption_azure_openai_responses(
            image_data_url, endpoint, api_key, model, api_version,
            egress_token=egress_token, egress_uds=egress_uds
        )
    raise CaptionError(f"알 수 없는 caption provider: {provider}")
