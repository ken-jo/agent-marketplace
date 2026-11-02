"""End to end: the real worker process, spoken to over its stdin and stdout.

The test plays the host and the plugin at once. It sends the hello, indexes a
document while answering the worker's own ``egress_embedding`` requests,
searches, cancels a write mid-egress, and closes stdin. Every line the worker
writes to stdout must be a JSON-RPC frame; its logs must be on stderr.
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

_SOURCE = Path(__file__).resolve().parent.parent
_WORKER = _SOURCE / "worker" / "local_indexer_worker.py"

import kiwipiepy  # noqa: E402,F401  -- in the shipped lock; the worker tokenizes with it


class WorkerProcess:
    def __init__(self, tmp_path: Path) -> None:
        self.state_dir = tmp_path / "state"
        self.state_dir.mkdir()
        env = {
            key: value
            for key, value in os.environ.items()
            if key in ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT")
        }
        env.update(AVE_WORKER_STATE_DIR=str(self.state_dir), PYTHONDONTWRITEBYTECODE="1")
        self.proc = subprocess.Popen(
            [sys.executable, str(_WORKER), "--workspace", str(tmp_path / "ws"), "--embedding-dimensions", "8"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        self.frames: "queue.Queue[Optional[Dict[str, Any]]]" = queue.Queue()
        self.non_frames: List[bytes] = []
        self.stderr = bytearray()
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()
        self._next = 1

    def _read_stdout(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            try:
                frame = json.loads(line)
                assert isinstance(frame, dict) and frame.get("jsonrpc") == "2.0"
            except Exception:
                self.non_frames.append(line)
                continue
            self.frames.put(frame)
        self.frames.put(None)

    def _read_stderr(self) -> None:
        assert self.proc.stderr is not None
        for line in self.proc.stderr:
            self.stderr.extend(line)

    def send(self, frame: Dict[str, Any]) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write((json.dumps({"jsonrpc": "2.0", **frame}) + "\n").encode("utf-8"))
        self.proc.stdin.flush()

    def recv(self, timeout: float = 60.0) -> Dict[str, Any]:
        frame = self.frames.get(timeout=timeout)
        assert frame is not None, f"worker stdout closed; stderr:\n{self.stderr.decode(errors='replace')[-2000:]}"
        return frame

    def request(self, method: str, params: Any = None) -> int:
        request_id = self._next
        self._next += 1
        frame: Dict[str, Any] = {"id": request_id, "method": method}
        if params is not None:
            frame["params"] = params
        self.send(frame)
        return request_id

    def answer_until(self, request_id: int, egress: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Play the plugin: answer worker egress requests until ``request_id`` is answered."""
        while True:
            frame = self.recv()
            if frame.get("method") == "egress_embedding":
                egress.append(frame)
                self.send({"id": frame["id"], "result": embedding_answer(frame["params"])})
                continue
            assert frame.get("id") == request_id, frame
            return frame

    def call(self, method: str, params: Any = None) -> Any:
        frame = self.answer_until(self.request(method, params), [])
        assert "result" in frame, frame
        return frame["result"]


def embedding_answer(params: Dict[str, Any]) -> Dict[str, Any]:
    body = json.loads(params["body"])
    inputs = body["input"] if isinstance(body["input"], list) else [body["input"]]
    dims = int(body.get("dimensions") or 8)
    data = [
        {"object": "embedding", "index": i, "embedding": [((i + j) % 7) / 7.0 + 0.01 for j in range(dims)]}
        for i in range(len(inputs))
    ]
    return {
        "status": 200,
        "headers": {"content-type": "application/json"},
        "body": json.dumps({"object": "list", "data": data, "model": body["model"],
                            "usage": {"prompt_tokens": 1, "total_tokens": 1}}),
    }


@pytest.fixture
def worker(tmp_path: Path) -> Any:
    process = WorkerProcess(tmp_path)
    yield process
    if process.proc.poll() is None:
        process.proc.kill()
        process.proc.wait(10)


def test_the_real_worker_speaks_stdio_control_v1(worker: WorkerProcess, tmp_path: Path) -> None:
    docs = tmp_path / "docs"
    docs.mkdir()
    first = docs / "budget.md"
    first.write_text("# 분기 예산\n\n분기 예산 보고서는 매출과 비용을 다룬다.\n", encoding="utf-8")
    second = docs / "travel.md"
    second.write_text("# 출장 규정\n\n출장비는 영수증으로 정산한다.\n", encoding="utf-8")

    # The hello is answered first, before anything else is written.
    worker.send({"id": 0, "method": "$/ave/hello",
                 "params": {"protocol": "ave-worker-stdio-control", "versions": ["1"], "frameBytesMax": 16777216}})
    assert worker.recv() == {"jsonrpc": "2.0", "id": 0,
                             "result": {"protocol": "ave-worker-stdio-control", "version": "1"}}

    assert worker.call("worker_health")["status"] == "ok"
    info = worker.call("runtime_info")
    assert info["index_root"] == str(worker.state_dir / "index")
    assert info["document_count"] == 0

    worker.call("runtime_allowed_roots", {"roots": [str(docs)]})
    assert worker.call("indexer_set_embedding_egress", {"enabled": True}) == {"embeddingEgress": True}

    # Indexing embeds through the plugin: the worker asks, the test answers.
    egress: List[Dict[str, Any]] = []
    answer = worker.answer_until(worker.request("indexer_reindex", {"file_path": str(first)}), egress)
    result = answer["result"]
    assert result["status"] == "indexed", result
    assert result["embedded"] is True
    assert egress, "the worker embedded without asking the plugin"
    for frame in egress:
        assert frame["id"].startswith("w-")
        assert frame["params"]["path"] == "/embeddings"
        assert "authorization" not in {k.lower() for k in frame["params"]["headers"]}

    docs_listed = worker.call("documents_list")
    assert [Path(d["path"]).name for d in docs_listed] == ["budget.md"]
    hits = worker.call("search_bm25", {"query": "예산", "topK": 5})
    assert hits and hits[0]["doc_name"] == "budget.md"

    # Cancel a write while its embedding request is outstanding: the worker
    # still answers the cancelled request, after its thread has finished.
    reindex_id = worker.request("indexer_reindex", {"file_path": str(second)})
    egress_request = worker.recv()
    assert egress_request["method"] == "egress_embedding"
    worker.send({"method": "$/ave/cancel", "params": {"id": reindex_id}})
    worker.send({"id": egress_request["id"], "result": embedding_answer(egress_request["params"])})
    cancelled = worker.answer_until(reindex_id, [])
    assert cancelled["error"]["code"] == -32800

    # Requests that fail are JSON-RPC errors, not crashes.
    bad = worker.answer_until(worker.request("search_hybrid", {"topK": 3}), [])
    assert bad["error"]["code"] == -32602

    # stdin EOF ends the worker.
    assert worker.proc.stdin is not None
    worker.proc.stdin.close()
    assert worker.proc.wait(30) == 0
    assert worker.frames.get(timeout=5) is None  # nothing after the last answer

    assert worker.non_frames == [], worker.non_frames
    log = worker.stderr.decode("utf-8", errors="replace")
    assert '"event": "worker.ready"' in log
    assert '"reason": "stdin-eof"' in log


def test_shutdown_notification_ends_the_worker(worker: WorkerProcess) -> None:
    worker.send({"id": 0, "method": "$/ave/hello",
                 "params": {"protocol": "ave-worker-stdio-control", "versions": ["1"], "frameBytesMax": 16777216}})
    worker.recv()
    assert worker.call("worker_shutdown") == {"bye": True}
    worker.send({"method": "$/ave/shutdown"})
    assert worker.proc.wait(30) == 0
    assert worker.non_frames == []
