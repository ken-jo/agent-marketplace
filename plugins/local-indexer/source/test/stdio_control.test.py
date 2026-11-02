"""Worker stdio control v1, the worker's side (``worker/stdio_control.py``).

Each test runs a ``StdioPeer`` on two real OS pipes and plays the host on the
other ends: it writes frames to the worker's stdin and reads what the worker
writes to its stdout. Nothing is mocked between the two.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import io
import json
import os
import queue
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, Optional

import pytest

_WORKER_DIR = Path(__file__).resolve().parent.parent / "worker"
sys.path.insert(0, str(_WORKER_DIR))

import stdio_control as sc  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))

from stdio_control_test_host import HELLO, Host  # noqa: E402


def run(scenario: Callable[[sc.StdioPeer, Host], Awaitable[None]], handlers: Optional[Dict[str, Any]] = None) -> None:
    host = Host()
    peer = sc.StdioPeer(read_fd=host.worker_in_r, write_fd=host.worker_out_w, handlers=handlers)

    async def main() -> None:
        await peer.start()
        await scenario(peer, host)

    asyncio.run(asyncio.wait_for(main(), 15))


async def hello(host: Host) -> Dict[str, Any]:
    host.send(HELLO)
    return await asyncio.to_thread(host.recv)


# ── hello ─────────────────────────────────────────────────────────────────
def test_the_hello_answer_is_the_first_frame() -> None:
    async def scenario(peer: sc.StdioPeer, host: Host) -> None:
        answer = await hello(host)
        assert answer == {
            "jsonrpc": "2.0",
            "id": 0,
            "result": {"protocol": "ave-worker-stdio-control", "version": "1"},
        }
        assert peer.hello_answered

    run(scenario)


def test_nothing_may_be_written_before_the_hello_answer() -> None:
    async def scenario(peer: sc.StdioPeer, host: Host) -> None:
        with pytest.raises(RuntimeError, match="hello"):
            peer.notify("progress", {"n": 1})
        assert await asyncio.to_thread(host.nothing_for, 0.2)

    run(scenario)


def test_a_hello_without_version_1_closes_the_channel_unanswered() -> None:
    async def scenario(peer: sc.StdioPeer, host: Host) -> None:
        host.send({**HELLO, "params": {**HELLO["params"], "versions": ["2"]}})
        assert await peer.wait_closed() == "hello-unsupported"
        assert await asyncio.to_thread(host.nothing_for, 0.2)

    run(scenario)


# ── requests from the host ────────────────────────────────────────────────
def test_answers_are_correlated_by_id_not_by_order() -> None:
    release_slow = asyncio.Event()

    async def slow(params: Any) -> Any:
        await release_slow.wait()
        return {"slow": params}

    async def fast(params: Any) -> Any:
        return {"fast": params}

    async def scenario(peer: sc.StdioPeer, host: Host) -> None:
        await hello(host)
        host.send({"jsonrpc": "2.0", "id": 7, "method": "slow", "params": "a"})
        host.send({"jsonrpc": "2.0", "id": "s-8", "method": "fast", "params": "b"})
        first = await asyncio.to_thread(host.recv)
        assert first == {"jsonrpc": "2.0", "id": "s-8", "result": {"fast": "b"}}
        release_slow.set()
        second = await asyncio.to_thread(host.recv)
        assert second == {"jsonrpc": "2.0", "id": 7, "result": {"slow": "a"}}

    run(scenario, {"slow": slow, "fast": fast})


def test_unknown_methods_and_refusals_are_json_rpc_errors() -> None:
    async def refuse(_params: Any) -> Any:
        raise sc.RequestError(sc.INVALID_PARAMS, "query: field required")

    async def crash(_params: Any) -> Any:
        raise ValueError("boom")

    async def scenario(peer: sc.StdioPeer, host: Host) -> None:
        await hello(host)
        host.send({"jsonrpc": "2.0", "id": 1, "method": "missing"})
        assert (await asyncio.to_thread(host.recv))["error"]["code"] == sc.METHOD_NOT_FOUND
        host.send({"jsonrpc": "2.0", "id": 2, "method": "refuse"})
        assert (await asyncio.to_thread(host.recv))["error"] == {
            "code": -32602,
            "message": "query: field required",
        }
        host.send({"jsonrpc": "2.0", "id": 3, "method": "crash"})
        assert (await asyncio.to_thread(host.recv))["error"] == {"code": -32000, "message": "boom"}

    run(scenario, {"refuse": refuse, "crash": crash})


def test_cancel_withdraws_a_running_request_which_is_still_answered() -> None:
    started = asyncio.Event()
    finished = asyncio.Event()

    async def hang(_params: Any) -> Any:
        started.set()
        try:
            await asyncio.sleep(30)
        finally:
            finished.set()

    async def scenario(peer: sc.StdioPeer, host: Host) -> None:
        await hello(host)
        host.send({"jsonrpc": "2.0", "id": 5, "method": "hang"})
        await started.wait()
        host.send({"jsonrpc": "2.0", "method": "$/ave/cancel", "params": {"id": 5}})
        answer = await asyncio.to_thread(host.recv)
        assert answer == {"jsonrpc": "2.0", "id": 5, "error": {"code": -32800, "message": "request cancelled"}}
        assert finished.is_set()

    run(scenario, {"hang": hang})


def test_an_oversized_result_becomes_an_error_answer() -> None:
    async def huge(_params: Any) -> Any:
        return "x" * (sc.FRAME_BYTES_MAX + 1)

    async def scenario(peer: sc.StdioPeer, host: Host) -> None:
        await hello(host)
        host.send({"jsonrpc": "2.0", "id": 9, "method": "huge"})
        answer = await asyncio.to_thread(host.recv, 10.0)
        assert answer["id"] == 9
        assert answer["error"]["code"] == -32603
        assert "exceeds" in answer["error"]["message"]

    run(scenario, {"huge": huge})


# ── requests from the worker ──────────────────────────────────────────────
def test_a_worker_request_round_trips_through_the_plugin() -> None:
    async def scenario(peer: sc.StdioPeer, host: Host) -> None:
        await hello(host)
        call = asyncio.ensure_future(
            asyncio.to_thread(peer.request_blocking, "egress_embedding", {"path": "/embeddings"}, 5.0)
        )
        request = await asyncio.to_thread(host.recv)
        assert request["method"] == "egress_embedding"
        assert request["params"] == {"path": "/embeddings"}
        assert isinstance(request["id"], str) and request["id"].startswith("w-")
        host.send({"jsonrpc": "2.0", "id": request["id"], "result": {"status": 200}})
        assert await call == {"status": 200}

    run(scenario)


def test_a_plugin_error_answer_raises_in_the_worker() -> None:
    async def scenario(peer: sc.StdioPeer, host: Host) -> None:
        await hello(host)
        call = asyncio.ensure_future(asyncio.to_thread(peer.request_blocking, "egress_caption", {}, 5.0))
        request = await asyncio.to_thread(host.recv)
        host.send({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32602, "message": "bad path"}})
        with pytest.raises(sc.PluginRequestFailed, match="bad path"):
            await call

    run(scenario)


def test_request_blocking_refuses_the_event_loop_thread() -> None:
    async def scenario(peer: sc.StdioPeer, host: Host) -> None:
        await hello(host)
        with pytest.raises(RuntimeError, match="event loop"):
            peer.request_blocking("egress_embedding", {})

    run(scenario)


def test_an_oversized_worker_request_is_refused_before_anything_is_written() -> None:
    async def scenario(peer: sc.StdioPeer, host: Host) -> None:
        await hello(host)
        with pytest.raises(sc.FrameTooLarge):
            await asyncio.to_thread(
                peer.request_blocking, "egress_caption", {"body": "x" * sc.FRAME_BYTES_MAX}, 5.0
            )
        assert await asyncio.to_thread(host.nothing_for, 0.3)

    run(scenario)


def test_a_timed_out_worker_request_is_cancelled_and_keeps_its_slot_until_answered() -> None:
    async def scenario(peer: sc.StdioPeer, host: Host) -> None:
        await hello(host)
        with pytest.raises(TimeoutError):
            await asyncio.to_thread(peer.request_blocking, "egress_embedding", {}, 0.2)
        request = await asyncio.to_thread(host.recv)
        cancel = await asyncio.to_thread(host.recv)
        assert cancel == {"jsonrpc": "2.0", "method": "$/ave/cancel", "params": {"id": request["id"]}}
        assert len(peer._pending) == 1  # still counted until the plugin answers
        host.send({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32800, "message": "cancelled"}})
        for _ in range(50):
            if not peer._pending:
                break
            await asyncio.sleep(0.02)
        assert peer._pending == {}

    run(scenario)


def test_at_most_64_worker_requests_are_outstanding() -> None:
    async def scenario(peer: sc.StdioPeer, host: Host) -> None:
        await hello(host)
        # One thread per caller: the default executor has fewer threads than this.
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=sc.REQUESTS_IN_FLIGHT_MAX + 1)
        loop = asyncio.get_running_loop()
        calls = [
            loop.run_in_executor(pool, peer.request_blocking, "egress_embedding", {"n": i}, 10.0)
            for i in range(sc.REQUESTS_IN_FLIGHT_MAX + 1)
        ]
        seen = [await asyncio.to_thread(host.recv) for _ in range(sc.REQUESTS_IN_FLIGHT_MAX)]
        # The 65th waits for a slot rather than being sent.
        assert await asyncio.to_thread(host.nothing_for, 0.3)
        host.send({"jsonrpc": "2.0", "id": seen[0]["id"], "result": {"status": 200}})
        last = await asyncio.to_thread(host.recv)
        assert last["method"] == "egress_embedding"
        for frame in seen[1:] + [last]:
            host.send({"jsonrpc": "2.0", "id": frame["id"], "result": {"status": 200}})
        results = await asyncio.gather(*calls)
        assert all(r == {"status": 200} for r in results)
        pool.shutdown()

    run(scenario)


# ── ending ────────────────────────────────────────────────────────────────
def test_shutdown_closes_the_channel() -> None:
    async def scenario(peer: sc.StdioPeer, host: Host) -> None:
        await hello(host)
        host.send({"jsonrpc": "2.0", "method": "$/ave/shutdown"})
        assert await peer.wait_closed() == "shutdown"

    run(scenario)


def test_stdin_eof_closes_the_channel_and_fails_waiting_worker_requests() -> None:
    async def scenario(peer: sc.StdioPeer, host: Host) -> None:
        await hello(host)
        call = asyncio.ensure_future(asyncio.to_thread(peer.request_blocking, "egress_embedding", {}, 10.0))
        await asyncio.to_thread(host.recv)
        host.close_stdin()
        assert await peer.wait_closed() == "stdin-eof"
        with pytest.raises(sc.PeerClosed):
            await call
        with pytest.raises(sc.PeerClosed):
            await asyncio.to_thread(peer.request_blocking, "egress_embedding", {}, 1.0)

    run(scenario)


def test_eof_before_hello_closes_the_channel() -> None:
    async def scenario(peer: sc.StdioPeer, host: Host) -> None:
        host.close_stdin()
        assert await peer.wait_closed() == "stdin-eof"

    run(scenario)


# ── stdout belongs to the frames ──────────────────────────────────────────
def test_claim_stdout_sends_prints_and_native_writes_to_stderr() -> None:
    script = (
        "import os, sys\n"
        f"sys.path.insert(0, {str(_WORKER_DIR)!r})\n"
        "import stdio_control as sc\n"
        "fd = sc.claim_stdout_for_frames()\n"
        "print('stray print')\n"
        "os.write(1, b'native write\\n')\n"
        "sys.stdout.flush()\n"
        "os.write(fd, b'{\"frame\":1}\\n')\n"
    )
    proc = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, timeout=30, check=True
    )
    assert proc.stdout == b'{"frame":1}\n'
    assert b"stray print" in proc.stderr
    assert b"native write" in proc.stderr


def test_frames_are_whole_lines_even_from_many_threads() -> None:
    async def scenario(peer: sc.StdioPeer, host: Host) -> None:
        await hello(host)

        def burst(tag: int) -> None:
            for i in range(50):
                peer.notify("tick", {"tag": tag, "i": i, "pad": "y" * 4096})

        await asyncio.gather(*(asyncio.to_thread(burst, t) for t in range(4)))
        for _ in range(200):
            frame = await asyncio.to_thread(host.recv)
            assert frame["method"] == "tick"

    run(scenario)


def test_encode_frame_counts_utf8_bytes() -> None:
    limit_text = "가" * ((sc.FRAME_BYTES_MAX // 3) - 20)
    assert len(sc.encode_frame({"method": "m", "params": limit_text})) <= sc.FRAME_BYTES_MAX + 1
    with pytest.raises(sc.FrameTooLarge):
        sc.encode_frame({"method": "m", "params": "가" * (sc.FRAME_BYTES_MAX // 3 + 1)})


def test_method_names_follow_the_contract() -> None:
    peer = sc.StdioPeer(read_fd=0, write_fd=1)
    for bad in ("search.bm25", "search/bm25", "$/ave/x", "1abc", "a" * 129):
        with pytest.raises(ValueError):
            peer.register(bad, lambda _p: None)  # type: ignore[arg-type,return-value]
    peer.register("search_bm25", lambda _p: None)  # type: ignore[arg-type,return-value]
