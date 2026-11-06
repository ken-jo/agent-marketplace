"""Provider egress over the worker control channel.

The worker holds no provider key and opens no socket of its own for the
embedding and captioning calls. It asks its plugin instead: each HTTP request
the openai SDK would have sent becomes one worker-to-plugin request,
``egress_embedding`` or ``egress_caption``, carrying only the method, the
path below the channel, an allow-listed set of headers and the body. The
plugin resolves the real upstream and its credential itself, sends the
request with ``hostFetch`` and answers with the upstream status, headers and
body, which this transport turns back into the response the SDK expects.

A refusal by the plugin (an unknown upstream, no credential lease, a rate
limit) arrives as an ordinary HTTP status (403, 429, 413), so the SDK's error
mapping, the 429 retry and the indexer's failure classification all see the
same thing they saw when this was an HTTP broker. Only a broken channel turns
into a transport error.

Bodies travel as UTF-8 text. They are JSON here, and the caption body already
holds the image as base64: encoding it a second time would cost another third
and push an image near the cap over the frame limit.
"""

from __future__ import annotations

import base64
from typing import Any, Callable, Dict, Literal, Mapping, Optional

import httpx2  # type: ignore  # the openai SDK's HTTP library; only its transport interface is used here

# Largest image, in raw bytes, the worker forwards for captioning. The data
# URL carries it as base64 (4/3 of the raw size, 14.67 MiB at the cap) inside
# a JSON request body, which travels as one string inside one frame of at most
# 16 MiB; the remaining 1.3 MiB covers the prompt, the JSON envelope and the
# frame's own fields. The plugin applies the same cap to what it receives.
CAPTION_IMAGE_BYTES_MAX = 11 * 1024 * 1024

# The URL the SDKs are pointed at. Nothing dials it: the transport below
# takes only the path and query from it, and the plugin decides the upstream.
EGRESS_BASE_URL = "http://localhost"

EgressChannelName = Literal["embedding", "caption"]

CHANNEL_METHODS: Dict[str, str] = {
    "embedding": "egress_embedding",
    "caption": "egress_caption",
}

# Headers worth carrying. The plugin filters again with the same list; the
# SDK's own auth header holds a dummy value and is never sent.
FORWARDED_REQUEST_HEADERS = frozenset({"content-type", "accept", "openai-beta"})

# How long one relayed provider call may take end to end. Vision calls are
# the slow ones; the plugin's own upstream timeout is shorter.
DEFAULT_EGRESS_TIMEOUT_S = 120.0

RequestBlocking = Callable[[str, Any, Optional[float]], Any]


class EgressRelay:
    """Turns provider SDK traffic into worker-to-plugin requests."""

    def __init__(self, request_blocking: RequestBlocking, *, timeout_s: float = DEFAULT_EGRESS_TIMEOUT_S) -> None:
        self._request = request_blocking
        self.timeout_s = timeout_s

    def call(self, channel: EgressChannelName, params: Mapping[str, Any]) -> Mapping[str, Any]:
        method = CHANNEL_METHODS[channel]
        result = self._request(method, dict(params), self.timeout_s)
        if not isinstance(result, dict) or not isinstance(result.get("status"), int):
            raise ValueError(f"{method}: the plugin's answer has no HTTP status")
        return result

    def http_client(self, channel: EgressChannelName) -> Any:
        """An ``httpx2.Client`` whose every request goes through the plugin."""
        return httpx2.Client(transport=StdioEgressTransport(self, channel))


class StdioEgressTransport(httpx2.BaseTransport):
    """``httpx2`` transport that relays each request to the plugin."""

    def __init__(self, relay: EgressRelay, channel: EgressChannelName) -> None:
        if channel not in CHANNEL_METHODS:
            raise ValueError(f"unknown egress channel: {channel!r}")
        self._relay = relay
        self._channel = channel

    def handle_request(self, request: Any) -> Any:
        body = request.read()
        params: Dict[str, Any] = {
            "method": request.method,
            "path": request.url.raw_path.decode("ascii"),
            "headers": {
                key: value
                for key, value in request.headers.items()
                if key.lower() in FORWARDED_REQUEST_HEADERS
            },
        }
        if body:
            try:
                params["body"] = body.decode("utf-8")
            except UnicodeDecodeError:
                params["body"] = base64.b64encode(body).decode("ascii")
                params["bodyEncoding"] = "base64"
        try:
            answer = self._relay.call(self._channel, params)
        except Exception as exc:
            # The channel itself failed (closed, too large, timed out, refused
            # as a frame). To the SDK that is a connection that did not work.
            raise httpx2.ConnectError(f"egress via the plugin failed: {exc}", request=request) from exc
        raw = answer.get("body") or ""
        if answer.get("bodyEncoding") == "base64":
            content = base64.b64decode(raw)
        else:
            content = str(raw).encode("utf-8")
        headers = answer.get("headers") if isinstance(answer.get("headers"), dict) else {}
        return httpx2.Response(
            status_code=answer["status"],
            headers={str(k): str(v) for k, v in headers.items()},
            content=content,
            request=request,
        )


__all__ = [
    "CAPTION_IMAGE_BYTES_MAX",
    "CHANNEL_METHODS",
    "DEFAULT_EGRESS_TIMEOUT_S",
    "EGRESS_BASE_URL",
    "EgressRelay",
    "FORWARDED_REQUEST_HEADERS",
    "StdioEgressTransport",
]
