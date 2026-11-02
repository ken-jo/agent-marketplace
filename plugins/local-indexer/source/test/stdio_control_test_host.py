"""The host's side of worker stdio control v1, for the worker's tests.

Two real OS pipes: the test writes frames to the worker's stdin and reads
what the worker writes to its stdout.
"""

from __future__ import annotations

import io
import json
import os
import queue
import threading
from typing import Any, Dict, Optional

HELLO = {
    "jsonrpc": "2.0",
    "id": 0,
    "method": "$/ave/hello",
    "params": {"protocol": "ave-worker-stdio-control", "versions": ["1"], "frameBytesMax": 16777216},
}


class Host:
    """The host's ends of the two pipes."""

    def __init__(self) -> None:
        self.worker_in_r, self._in_w = os.pipe()
        self._out_r, self.worker_out_w = os.pipe()
        self._lines: "queue.Queue[Optional[bytes]]" = queue.Queue()
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self) -> None:
        reader = io.open(self._out_r, "rb", closefd=False)
        while True:
            line = reader.readline()
            if not line:
                self._lines.put(None)
                return
            self._lines.put(line)

    def send(self, frame: Dict[str, Any]) -> None:
        os.write(self._in_w, (json.dumps(frame) + "\n").encode("utf-8"))

    def recv_raw(self, timeout: float = 5.0) -> bytes:
        line = self._lines.get(timeout=timeout)
        assert line is not None, "worker stdout closed"
        return line

    def recv(self, timeout: float = 5.0) -> Dict[str, Any]:
        frame = json.loads(self.recv_raw(timeout))
        assert frame["jsonrpc"] == "2.0"
        return frame

    def nothing_for(self, seconds: float) -> bool:
        try:
            self._lines.get(timeout=seconds)
        except queue.Empty:
            return True
        return False

    def close_stdin(self) -> None:
        os.close(self._in_w)
