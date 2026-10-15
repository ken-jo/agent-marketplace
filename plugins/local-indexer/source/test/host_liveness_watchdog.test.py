"""Host liveness watchdog: the worker exits when the host's stdin pipe closes.

The host spawns the worker with stdin as a pipe that carries no bytes and is
closed by the OS only when the host process is gone: Node/libuv hands the
child a ``socketpair`` end on macOS and Linux and a named pipe (``S_IFIFO``)
on Windows. The watchdog must arm on either shape, ignore stray data, and
act only on EOF; on a character device (``/dev/null``) it must stay unarmed,
because such a handle reaches EOF at once and would kill the worker at
startup.
"""

from __future__ import annotations

import os
import socket
import sys
import time
from pathlib import Path
from typing import List

import pytest

_WORKER_DIR = Path(__file__).resolve().parent.parent / "worker"
sys.path.insert(0, str(_WORKER_DIR))

import local_indexer_worker  # noqa: E402
from local_indexer_worker import arm_host_liveness_watchdog  # noqa: E402


class FakeServer:
    def __init__(self) -> None:
        self.should_exit = False


def _wait_until(predicate, timeout: float = 2.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


def test_pipe_eof_stops_server_then_exits() -> None:
    r, w = os.pipe()
    server = FakeServer()
    exits: List[int] = []
    try:
        assert arm_host_liveness_watchdog(server, stdin_fd=r, exit_fn=exits.append, grace_seconds=0.2) is True
        assert server.should_exit is False

        os.close(w)

        assert _wait_until(lambda: server.should_exit), "EOF on the liveness pipe must stop the server"
        assert _wait_until(lambda: exits == [0]), "the grace timer must fire exit_fn(0) after the server is asked to stop"
    finally:
        os.close(r)


def test_socketpair_peer_close_stops_server_then_exits() -> None:
    a, b = socket.socketpair()
    server = FakeServer()
    exits: List[int] = []
    try:
        assert arm_host_liveness_watchdog(server, stdin_fd=a.fileno(), exit_fn=exits.append, grace_seconds=0.2) is True
        assert server.should_exit is False

        b.close()

        assert _wait_until(lambda: server.should_exit), "peer close on the socket end must stop the server"
        assert _wait_until(lambda: exits == [0])
    finally:
        a.close()


def test_char_device_does_not_arm() -> None:
    fd = os.open(os.devnull, os.O_RDONLY)
    server = FakeServer()
    exits: List[int] = []
    try:
        assert arm_host_liveness_watchdog(server, stdin_fd=fd, exit_fn=exits.append, grace_seconds=0.2) is False
        time.sleep(0.3)
        assert server.should_exit is False
        assert exits == []
    finally:
        os.close(fd)


def test_stray_bytes_are_ignored_only_eof_counts() -> None:
    r, w = os.pipe()
    server = FakeServer()
    exits: List[int] = []
    try:
        assert arm_host_liveness_watchdog(server, stdin_fd=r, exit_fn=exits.append, grace_seconds=0.2) is True

        os.write(w, b"x")
        time.sleep(0.3)
        assert server.should_exit is False
        assert exits == []

        os.close(w)
        assert _wait_until(lambda: server.should_exit)
        assert _wait_until(lambda: exits == [0])
    finally:
        os.close(r)


def test_read_error_counts_as_host_gone() -> None:
    # A read that fails instead of returning EOF must still stop the server:
    # a watchdog thread that died on the error would recreate the orphan.
    # The pipe is made non-blocking so the read raises (BlockingIOError, an
    # OSError) deterministically on every platform; closing the read end from
    # another thread is not portable — Linux leaves a blocked read() pending
    # after close(), so it would never see EBADF and the test would only pass
    # where the kernel wakes the reader.
    r, w = os.pipe()
    os.set_blocking(r, False)
    server = FakeServer()
    exits: List[int] = []
    try:
        assert arm_host_liveness_watchdog(server, stdin_fd=r, exit_fn=exits.append, grace_seconds=0.2) is True
        assert _wait_until(lambda: server.should_exit), "a read error must stop the server like EOF does"
        assert _wait_until(lambda: exits == [0])
    finally:
        os.close(w)
        os.close(r)


def test_exit_still_happens_when_logging_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    # The worker's stdout is the host's pipe too, so once the host is gone
    # the log write itself raises. The exit must not depend on it.
    class DeadStdoutLogger:
        def info(self, *args: object, **kwargs: object) -> None:
            raise BrokenPipeError(32, "Broken pipe")

        def warning(self, *args: object, **kwargs: object) -> None:
            raise BrokenPipeError(32, "Broken pipe")

    def dead_warning(event: str, **fields: object) -> None:
        raise BrokenPipeError(32, "Broken pipe")

    monkeypatch.setattr(local_indexer_worker, "log", DeadStdoutLogger())
    monkeypatch.setattr(local_indexer_worker, "_warning", dead_warning)

    r, w = os.pipe()
    server = FakeServer()
    exits: List[int] = []
    try:
        assert arm_host_liveness_watchdog(server, stdin_fd=r, exit_fn=exits.append, grace_seconds=0.2) is True
        os.close(w)
        assert _wait_until(lambda: server.should_exit), "a failing log write must not prevent the server stop"
        assert _wait_until(lambda: exits == [0])
    finally:
        os.close(r)
