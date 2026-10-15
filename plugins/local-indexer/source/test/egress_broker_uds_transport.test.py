"""The real OpenAI SDK reaches the egress broker over its Unix socket.

``egress_broker_worker.test.py`` swaps the SDK for capturing fakes, so it
proves which arguments the worker passes but never that the pinned transport
actually carries a request. This file uses the installed ``openai`` package and
``broker_http_client`` against a broker stand-in that listens ONLY on a
Unix-domain socket. The base URL is the dummy ``http://localhost`` authority, so
a request can arrive here only through the socket transport.

Written to fail when the transport stops working: openai 3 dropped ``httpx``
for ``httpx2``, and a client built from the wrong library either raises at
construction or is rejected by the SDK.
"""

from __future__ import annotations

import json
import os
import socketserver
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any, Dict, Iterator, List

import pytest

if not hasattr(socketserver, "UnixStreamServer"):  # Windows: the broker binds loopback TCP there
    pytest.skip("Unix-domain sockets are not available on this platform", allow_module_level=True)

_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT / "worker"))

import embedding_client as ec  # noqa: E402
from embedding_client import OpenAIEmbeddingClient  # noqa: E402

TOKEN = "session-egress-token-uds"


class _BrokerHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    seen: List[Dict[str, Any]] = []

    def do_POST(self) -> None:  # noqa: N802 - http.server naming
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        _BrokerHandler.seen.append(
            {"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body}
        )
        dims = body.get("dimensions") or 3
        inputs = body["input"] if isinstance(body["input"], list) else [body["input"]]
        payload = json.dumps(
            {
                "object": "list",
                "data": [
                    {"object": "embedding", "index": i, "embedding": [0.25] * dims}
                    for i in range(len(inputs))
                ],
                "model": body.get("model", "m"),
                "usage": {"prompt_tokens": 1, "total_tokens": 1},
            }
        ).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args: Any) -> None:
        # The default formats client_address[0], which is empty for a Unix socket.
        return


class _UnixBroker(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


@pytest.fixture
def broker_socket() -> Iterator[str]:
    # AF_UNIX paths are capped near 104 bytes on macOS; pytest's tmp_path there
    # is longer than that, so the socket lives in a short directory of its own.
    sock_dir = tempfile.mkdtemp(prefix="ave-uds-", dir="/tmp")
    sock = os.path.join(sock_dir, "egress.sock")
    _BrokerHandler.seen = []
    server = _UnixBroker(sock, _BrokerHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield sock
    finally:
        server.shutdown()
        server.server_close()
        os.unlink(sock)
        os.rmdir(sock_dir)


def test_sdk_embedding_request_arrives_over_the_unix_socket(broker_socket: str) -> None:
    client = OpenAIEmbeddingClient(
        api_key=None,
        egress_broker_url="http://localhost/egress/embedding",
        egress_broker_uds=broker_socket,
        egress_token=TOKEN,
    )

    vector = client.embed_one("hello")

    assert vector and all(v == 0.25 for v in vector)
    assert len(_BrokerHandler.seen) == 1
    request = _BrokerHandler.seen[0]
    # The channel path survives and the SDK appended its own route to it.
    assert request["path"] == "/egress/embedding/embeddings"
    # Brokered: the session token on its own header, a dummy SDK auth field.
    assert request["headers"]["x-ave-egress-token"] == TOKEN
    assert request["headers"]["authorization"] == "Bearer ave-egress-broker"


def test_broker_http_client_is_one_the_installed_sdk_accepts(broker_socket: str) -> None:
    from openai import OpenAI  # egress-gate: allow — test drives the SDK at a Unix-socket broker stand-in

    http_client = ec.broker_http_client(broker_socket)
    assert http_client is not None
    # The test environment installs legacy httpx for FastAPI's TestClient, but
    # the shipped python-requirements.lock does not. A client built from httpx
    # would pass here and fail at the first brokered request in production.
    assert type(http_client).__module__.split(".")[0] == "httpx2"
    try:
        sdk = OpenAI(  # egress-gate: allow — test: base_url is a dummy authority, the socket decides
            api_key="ave-egress-broker",
            base_url="http://localhost/egress/embedding",
            http_client=http_client,
            max_retries=0,
        )
        result = sdk.embeddings.create(model="m", input=["a", "b"], dimensions=2)
        assert [d.embedding for d in result.data] == [[0.25, 0.25], [0.25, 0.25]]
    finally:
        http_client.close()
