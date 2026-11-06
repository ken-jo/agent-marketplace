"""Worker stdio control v1, the worker's side of the channel.

The host spawns this worker with ``control: "stdio-control-v1"``. From then
on stdin and stdout carry nothing but newline-delimited JSON-RPC 2.0 frames,
one object per line and at most ``FRAME_BYTES_MAX`` bytes before the newline
(Ave ``docs/design/plugin-hostapi-protocol.md`` section 3.3.2, frames in
``schemas/worker-stdio-control/1/worker-control.schema.json``). Logs go to
stderr; a stray line on stdout ends the worker as a ``control-violation``.

* The host's first frame is the request ``$/ai.agent-connector.ave/hello`` (id 0). The worker
  answers it before it writes anything else.
* Either side may then send requests and notifications. Method names match
  ``METHOD_RE``; the ``$/`` names belong to the host.
* ``$/ai.agent-connector.ave/cancel {id}`` withdraws a request in either direction. The
  receiver still answers it, and it keeps its slot until then.
* ``$/ai.agent-connector.ave/shutdown`` and stdin EOF both mean "exit now". EOF is the one
  signal that outlives a host crash, so it is always honoured.
* At most ``REQUESTS_IN_FLIGHT_MAX`` requests may be outstanding in each
  direction. The host stops a worker that sends a 65th, so the worker waits
  for a free slot instead.

``StdioPeer`` owns the two descriptors. A reader thread turns stdin lines
into calls on the event loop; a single writer thread writes whole frames in
order, so a frame is never interleaved with another one, whichever thread
produced it. Request handlers run on the event loop. A blocking caller (an
SDK call running under ``asyncio.to_thread``) asks the plugin something with
``request_blocking``, which parks only that thread.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import io
import itertools
import json
import os
import queue
import re
import sys
import threading
import time
from typing import Any, Awaitable, Callable, Dict, Mapping, Optional

PROTOCOL = "ave-worker-stdio-control"
VERSION = "1"
# Largest frame, in bytes, excluding its newline (WORKER_CONTROL_FRAME_BYTES_MAX).
FRAME_BYTES_MAX = 16 * 1024 * 1024
# Outstanding requests allowed in each direction.
REQUESTS_IN_FLIGHT_MAX = 64
METHOD_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]{0,127}$")

HELLO_METHOD = "$/ai.agent-connector.ave/hello"
CANCEL_METHOD = "$/ai.agent-connector.ave/cancel"
SHUTDOWN_METHOD = "$/ai.agent-connector.ave/shutdown"

# JSON-RPC 2.0 error codes, plus -32800 for a cancelled request (the code the
# frame schema names for it).
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
SERVER_ERROR = -32000
NOT_FOUND = -32004
REQUEST_CANCELLED = -32800

Handler = Callable[[Any], Awaitable[Any]]


class RequestError(Exception):
    """A handler's refusal, sent back as a JSON-RPC error."""

    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


class FrameTooLarge(Exception):
    """A frame would exceed ``FRAME_BYTES_MAX``; nothing was written."""


class PeerClosed(Exception):
    """The channel ended (stdin EOF or shutdown) before an answer arrived."""


class PluginRequestFailed(Exception):
    """The plugin answered a worker request with a JSON-RPC error."""

    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


def _log(event: str, **fields: Any) -> None:
    # stderr only: stdout belongs to the frames.
    try:
        sys.stderr.write(json.dumps({"event": event, **fields}, ensure_ascii=False) + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def encode_frame(frame: Mapping[str, Any], limit: int = FRAME_BYTES_MAX) -> bytes:
    """Serialize one frame, newline included, or raise ``FrameTooLarge``."""
    data = json.dumps(
        {"jsonrpc": "2.0", **frame},
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    if len(data) > limit:
        raise FrameTooLarge(
            f"frame of {len(data)} bytes exceeds the {limit}-byte worker control limit"
        )
    return data + b"\n"


def read_frame_line(reader: Any, limit: int) -> bytes:
    """Read one frame line of at most ``limit`` bytes before its newline.

    Asks for ``limit + 1`` bytes, the largest frame plus its newline, so a
    longer line is never buffered whole. Returns b"" at EOF, and raises
    ``FrameTooLarge`` for a line longer than ``limit``.
    """
    line = reader.readline(limit + 1)
    if len(line.rstrip(b"\n")) > limit:
        raise FrameTooLarge(f"frame line of more than {limit} bytes")
    return line


class StdioPeer:
    """Both directions of worker stdio control v1 over two file descriptors."""

    def __init__(
        self,
        *,
        read_fd: int,
        write_fd: int,
        handlers: Optional[Mapping[str, Handler]] = None,
    ) -> None:
        self._read_fd = read_fd
        self._write_fd = write_fd
        self._handlers: Dict[str, Handler] = dict(handlers or {})
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._loop_thread: Optional[int] = None
        self._closed: Optional[asyncio.Event] = None
        self._close_reason = ""
        self._hello_answered = threading.Event()
        self._send_queue: "queue.Queue[Optional[tuple[bytes, concurrent.futures.Future]]]" = queue.Queue()
        self._writer_broken = False
        # Requests the host sent us that are still running, by id.
        self._inflight: Dict[Any, asyncio.Task] = {}
        # Requests we sent the plugin, by id. Kept until the answer arrives,
        # because a cancelled request holds its slot until then.
        self._pending: Dict[str, concurrent.futures.Future] = {}
        self._pending_lock = threading.Lock()
        self._slots = threading.BoundedSemaphore(REQUESTS_IN_FLIGHT_MAX)
        self._ids = itertools.count(1)
        self._stopping = threading.Event()
        # The frame limit the host announced in its hello (never above
        # FRAME_BYTES_MAX); until then, the protocol's upper bound.
        self._frame_bytes_max = FRAME_BYTES_MAX

    # ── lifecycle ─────────────────────────────────────────────────────
    def register(self, method: str, handler: Handler) -> None:
        if not METHOD_RE.match(method):
            raise ValueError(f"invalid worker control method name: {method!r}")
        self._handlers[method] = handler

    async def start(self) -> None:
        """Bind to the running loop and start the reader and writer threads."""
        self._loop = asyncio.get_running_loop()
        self._loop_thread = threading.get_ident()
        self._closed = asyncio.Event()
        threading.Thread(target=self._write_loop, name="stdio-control-writer", daemon=True).start()
        threading.Thread(target=self._read_loop, name="stdio-control-reader", daemon=True).start()

    @property
    def close_reason(self) -> str:
        return self._close_reason

    @property
    def hello_answered(self) -> bool:
        return self._hello_answered.is_set()

    async def wait_closed(self) -> str:
        assert self._closed is not None, "start() first"
        await self._closed.wait()
        return self._close_reason

    def close(self, reason: str) -> None:
        """End the channel: no new work, every waiting caller fails."""
        if self._stopping.is_set():
            return
        self._stopping.set()
        self._close_reason = reason
        for task in list(self._inflight.values()):
            task.cancel()
        with self._pending_lock:
            pending = list(self._pending.items())
            self._pending.clear()
        for _, future in pending:
            if not future.done():
                future.set_exception(PeerClosed(f"worker control channel closed ({reason})"))
            self._slots.release()
        if self._closed is not None:
            self._closed.set()

    def flush(self, timeout: float = 2.0) -> None:
        """Wait until every queued frame has been written (best effort)."""
        done: concurrent.futures.Future = concurrent.futures.Future()
        self._send_queue.put((b"", done))
        try:
            done.result(timeout)
        except Exception:
            pass

    # ── writing ───────────────────────────────────────────────────────
    def _write_loop(self) -> None:
        while True:
            item = self._send_queue.get()
            if item is None:
                return
            data, done = item
            if self._writer_broken:
                done.set_exception(PeerClosed("worker stdout is closed"))
                continue
            try:
                view = memoryview(data)
                while view:
                    written = os.write(self._write_fd, view)
                    view = view[written:]
                done.set_result(None)
            except OSError as exc:
                # The host is gone. Nothing can be said any more; the reader
                # sees EOF next and ends the worker.
                self._writer_broken = True
                done.set_exception(PeerClosed(f"worker stdout write failed: {exc}"))

    @property
    def frame_bytes_max(self) -> int:
        return self._frame_bytes_max

    def send(self, frame: Mapping[str, Any]) -> concurrent.futures.Future:
        """Queue one frame. Raises ``FrameTooLarge`` before anything is queued."""
        data = encode_frame(frame, self._frame_bytes_max)
        if not self._hello_answered.is_set():
            # The hello answer must be the first frame the worker writes.
            raise RuntimeError("worker control: no frame may precede the hello answer")
        done: concurrent.futures.Future = concurrent.futures.Future()
        self._send_queue.put((data, done))
        return done

    def notify(self, method: str, params: Any = None) -> None:
        if not METHOD_RE.match(method):
            raise ValueError(f"invalid worker control method name: {method!r}")
        frame: Dict[str, Any] = {"method": method}
        if params is not None:
            frame["params"] = params
        self.send(frame)

    def _answer(self, request_id: Any, *, result: Any = None, error: Optional[RequestError] = None) -> None:
        if error is not None:
            body: Dict[str, Any] = {"code": error.code, "message": error.message}
            if error.data is not None:
                body["data"] = error.data
            frame: Dict[str, Any] = {"id": request_id, "error": body}
        else:
            frame = {"id": request_id, "result": result}
        try:
            self.send(frame)
        except FrameTooLarge as exc:
            self.send({"id": request_id, "error": {"code": INTERNAL_ERROR, "message": str(exc)}})

    # ── worker → plugin requests ──────────────────────────────────────
    def request_blocking(self, method: str, params: Any = None, timeout: Optional[float] = None) -> Any:
        """Ask the plugin and wait for its answer, from a thread other than the loop's.

        Raises ``PluginRequestFailed`` for an error answer, ``PeerClosed``
        when the channel ends first, ``FrameTooLarge`` when the request cannot
        be sent, and ``TimeoutError`` when ``timeout`` passes. ``timeout`` is
        one deadline for the whole call: waiting for a free request slot and
        waiting for the answer both spend it. ``None`` waits as long as the
        channel lives. A request already sent when the deadline passes is
        withdrawn with ``$/ai.agent-connector.ave/cancel``.
        """
        if threading.get_ident() == self._loop_thread:
            raise RuntimeError("request_blocking would block the event loop; call it from a worker thread")
        if not METHOD_RE.match(method):
            raise ValueError(f"invalid worker control method name: {method!r}")
        if self._stopping.is_set():
            raise PeerClosed(f"worker control channel closed ({self._close_reason})")
        frame: Dict[str, Any] = {"method": method}
        if params is not None:
            frame["params"] = params
        request_id = f"w-{next(self._ids)}"
        frame["id"] = request_id
        # Encode before taking a slot, so an oversized request costs nothing.
        encode_frame(frame, self._frame_bytes_max)
        deadline = None if timeout is None else time.monotonic() + max(0.0, timeout)

        def remaining() -> Optional[float]:
            return None if deadline is None else max(0.0, deadline - time.monotonic())

        # ``acquire(timeout=None)`` blocks until a slot frees; a finite value
        # waits at most that long. (``timeout=-1`` would also block, but only
        # as a sentinel; say what is meant.)
        wait = remaining()
        got_slot = self._slots.acquire() if wait is None else self._slots.acquire(timeout=wait)
        if not got_slot:
            raise TimeoutError(f"no free worker request slot for {method} within {timeout} s")
        future: concurrent.futures.Future = concurrent.futures.Future()
        with self._pending_lock:
            if self._stopping.is_set():
                self._slots.release()
                raise PeerClosed(f"worker control channel closed ({self._close_reason})")
            self._pending[request_id] = future
        try:
            self.send(frame)
        except Exception:
            with self._pending_lock:
                if self._pending.pop(request_id, None) is not None:
                    self._slots.release()
            raise
        try:
            return future.result(remaining())
        except concurrent.futures.TimeoutError:
            try:
                self.send({"method": CANCEL_METHOD, "params": {"id": request_id}})
            except Exception:
                pass
            raise TimeoutError(f"{method} was not answered within {timeout} s") from None

    def _settle(self, frame: Mapping[str, Any]) -> None:
        request_id = frame.get("id")
        with self._pending_lock:
            future = self._pending.pop(request_id, None) if isinstance(request_id, str) else None
        if future is None:
            _log("worker.control.unknown_response", id=request_id)
            return
        self._slots.release()
        if future.done():
            return
        if "error" in frame:
            error = frame.get("error") or {}
            future.set_exception(
                PluginRequestFailed(
                    int(error.get("code", SERVER_ERROR)),
                    str(error.get("message", "plugin request failed")),
                    error.get("data"),
                )
            )
        else:
            future.set_result(frame.get("result"))

    # ── reading ───────────────────────────────────────────────────────
    def _read_loop(self) -> None:
        reader = io.open(self._read_fd, "rb", buffering=1 << 16, closefd=False)
        reason = "stdin-eof"
        try:
            while True:
                try:
                    line = read_frame_line(reader, FRAME_BYTES_MAX)
                except FrameTooLarge as exc:
                    _log("worker.control.oversized_frame", error=str(exc))
                    reason = "oversized-frame"
                    break
                if not line:
                    break
                self._post(self._on_line, line)
        except Exception as exc:  # pragma: no cover - a vanished descriptor
            _log("worker.control.read_failed", error=str(exc))
        self._post(self.close, reason)

    def _post(self, fn: Callable[..., Any], *args: Any) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(fn, *args)
        except RuntimeError:  # pragma: no cover - loop closed in between
            pass

    def _on_line(self, line: bytes) -> None:
        if len(line.rstrip(b"\n")) > self._frame_bytes_max:
            # Over the limit the host announced, though under the protocol's.
            _log("worker.control.oversized_frame", bytes=len(line), limit=self._frame_bytes_max)
            self.close("oversized-frame")
            return
        text = line.strip()
        if not text:
            return
        try:
            frame = json.loads(text)
        except ValueError:
            _log("worker.control.unparseable_frame", bytes=len(line))
            return
        if not isinstance(frame, dict) or frame.get("jsonrpc") != "2.0":
            _log("worker.control.invalid_frame")
            return
        method = frame.get("method")
        if not self._hello_answered.is_set():
            self._on_hello(frame)
            return
        if method is None:
            self._settle(frame)
            return
        if method == CANCEL_METHOD:
            params = frame.get("params") or {}
            task = self._inflight.get(params.get("id")) if isinstance(params, dict) else None
            if task is not None:
                task.cancel()
            return
        if method == SHUTDOWN_METHOD:
            self.close("shutdown")
            return
        if "id" not in frame:
            # No notifications from the host are defined beyond the two above.
            return
        if self._stopping.is_set():
            self._answer(frame["id"], error=RequestError(SERVER_ERROR, "worker is shutting down"))
            return
        request_id = frame["id"]
        task = asyncio.ensure_future(self._dispatch(request_id, str(method), frame.get("params")))
        self._inflight[request_id] = task

    def _on_hello(self, frame: Mapping[str, Any]) -> None:
        params = frame.get("params") if isinstance(frame.get("params"), dict) else {}
        if frame.get("method") != HELLO_METHOD or frame.get("id") != 0:
            _log("worker.control.frame_before_hello", method=frame.get("method"))
            return
        versions = params.get("versions") if isinstance(params, dict) else None
        if params.get("protocol") != PROTOCOL or not isinstance(versions, list) or VERSION not in versions:
            _log("worker.control.hello_unsupported", protocol=params.get("protocol"), versions=versions)
            self.close("hello-unsupported")
            return
        # The host names its frame limit; both sides keep to it. It must be a
        # positive integer no larger than the protocol's 16 MiB bound.
        announced = params.get("frameBytesMax")
        if (
            not isinstance(announced, int)
            or isinstance(announced, bool)
            or announced < 1
            or announced > FRAME_BYTES_MAX
        ):
            _log("worker.control.hello_unsupported", frameBytesMax=announced)
            self.close("hello-unsupported")
            return
        self._frame_bytes_max = announced
        data = encode_frame({"id": 0, "result": {"protocol": PROTOCOL, "version": VERSION}}, announced)
        self._send_queue.put((data, concurrent.futures.Future()))
        self._hello_answered.set()

    async def _dispatch(self, request_id: Any, method: str, params: Any) -> None:
        try:
            handler = self._handlers.get(method)
            if handler is None:
                raise RequestError(METHOD_NOT_FOUND, f"no method {method}")
            result = await handler(params)
            self._answer(request_id, result=result)
        except asyncio.CancelledError:
            self._answer(request_id, error=RequestError(REQUEST_CANCELLED, "request cancelled"))
        except RequestError as exc:
            self._answer(request_id, error=exc)
        except Exception as exc:  # noqa: BLE001 - every failure becomes an answer
            _log("worker.control.handler_failed", method=method, error=str(exc))
            self._answer(request_id, error=RequestError(SERVER_ERROR, str(exc) or exc.__class__.__name__))
        finally:
            self._inflight.pop(request_id, None)


def claim_stdout_for_frames() -> int:
    """Keep the real stdout for frames only and send everything else to stderr.

    Returns a private duplicate of descriptor 1 for the frame writer. Then
    descriptor 1 itself is pointed at stderr, so a ``print`` in this process
    or a write from a native library ends up in the log instead of breaking
    the frame stream, and ``sys.stdout`` follows it.
    """
    frames_fd = os.dup(1)
    # Point descriptor 1 at stderr first, then flush: anything an import
    # printed into the stdout buffer lands in the log, not in front of the
    # hello answer.
    os.dup2(2, 1)
    try:
        sys.stdout.flush()
    except Exception:
        pass
    sys.stdout = sys.stderr
    if os.name == "nt":  # pragma: no cover - Windows only
        import msvcrt

        # Frames are binary: no CRLF translation on either stream.
        msvcrt.setmode(frames_fd, os.O_BINARY)
        msvcrt.setmode(0, os.O_BINARY)
    return frames_fd


__all__ = [
    "read_frame_line",
    "CANCEL_METHOD",
    "FRAME_BYTES_MAX",
    "FrameTooLarge",
    "HELLO_METHOD",
    "INVALID_PARAMS",
    "METHOD_NOT_FOUND",
    "METHOD_RE",
    "NOT_FOUND",
    "PROTOCOL",
    "PeerClosed",
    "PluginRequestFailed",
    "REQUESTS_IN_FLIGHT_MAX",
    "REQUEST_CANCELLED",
    "RequestError",
    "SERVER_ERROR",
    "SHUTDOWN_METHOD",
    "StdioPeer",
    "VERSION",
    "claim_stdout_for_frames",
    "encode_frame",
]
