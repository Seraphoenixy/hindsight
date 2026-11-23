"""Liveness/health probes over aiohttp, async only.

hindsight-embed makes no outbound HTTP calls other than these loopback probes
(is the daemon / UI / control center answering?). They run on aiohttp; the sync
CLI and the control center's threaded HTTP handlers drive them through
:func:`probe_get`, which owns the ``asyncio.run`` at the sync boundary.

Each probe opens and closes its own ``ClientSession``: probes are one-shots
spread across short-lived loops, so there is no session worth keeping.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import functools
import json
from dataclasses import dataclass
from typing import Any

import aiohttp


@dataclass(frozen=True)
class ProbeResponse:
    """Status and body of a probe that got an HTTP answer."""

    status_code: int
    text: str

    def json(self) -> Any:
        """Parse the body as JSON (raises ``ValueError`` when it is not)."""
        return json.loads(self.text)


def _timeout(read: float, connect: float | None) -> aiohttp.ClientTimeout:
    # Per phase, like httpx.Timeout(read, connect=...): ``connect`` bounds pool
    # wait + connect, ``sock_read`` each socket read. No ``total``.
    return aiohttp.ClientTimeout(total=None, connect=read if connect is None else connect, sock_read=read)


async def aprobe_get(url: str, *, read_timeout: float, connect_timeout: float | None = None) -> ProbeResponse | None:
    """GET ``url``; the response, or ``None`` when no HTTP answer came back.

    Connection refused/reset, timeouts, an unreadable body and malformed URLs
    all read as ``None`` — the probe's only question is whether something
    answered.
    """
    try:
        async with aiohttp.ClientSession(timeout=_timeout(read_timeout, connect_timeout)) as session:
            async with session.get(url) as response:
                text = await response.text(errors="replace")
                return ProbeResponse(status_code=response.status, text=text)
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError, ValueError):
        return None


async def aprobe_first(
    urls: list[str], *, read_timeout: float, connect_timeout: float | None = None
) -> tuple[int, ProbeResponse | None]:
    """Probe ``urls`` concurrently and return the first HTTP answer as ``(index, response)``.

    Pending probes are cancelled as soon as one answers, so an address family
    that is not listening cannot delay one that is. When nothing answers, this
    returns after the slowest probe finishes; ``(0, None)``. The caller decides
    which statuses mean what — an old server may answer a route added later
    with 404 and should not be mistaken for a dead one.
    """
    tasks = {
        asyncio.create_task(aprobe_get(url, read_timeout=read_timeout, connect_timeout=connect_timeout)): index
        for index, url in enumerate(urls)
    }
    try:
        pending = set(tasks)
        while pending:
            done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            answered = []
            for task in done:
                response = task.result()
                if response is not None:
                    answered.append((tasks[task], response))
            if answered:
                return min(answered, key=lambda item: item[0])
        return (0, None)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


def probe_get(url: str, *, read_timeout: float, connect_timeout: float | None = None) -> ProbeResponse | None:
    """Sync entry point for :func:`aprobe_get`, for the CLI and threaded server.

    The probe ALWAYS runs on its own loop in a helper thread, never on the
    caller's. Two reasons, and the second is the load-bearing one:

    1. From a thread whose event loop is already running (hindsight-all's sync
       ``_ensure_started`` is reached from its async methods too), ``asyncio.run``
       cannot nest.
    2. ``asyncio.run`` does not just close the loop it created — it leaves the
       calling thread with NO current event loop (``set_event_loop(None)``).
       Event-loop state is per-thread, so doing that on the caller's thread
       quietly sabotages any sync caller that reaches us between its own calls:
       hindsight-client's ``_run_async`` then sees no current loop, builds a
       fresh one, and runs against an ``aiohttp`` session still bound to the old
       one — which fails with "Timeout context manager should be used inside a
       task". That is exactly the shape of the Hermes memory plugin in
       local_embedded mode, where a daemon health probe sits between two client
       calls. A library helper must not mutate its caller's loop state.

    This blocks the caller for the probe's bounded timeout, exactly as the sync
    client it replaced did; async callers should await :func:`aprobe_get`.
    """
    probe = functools.partial(aprobe_get, url, read_timeout=read_timeout, connect_timeout=connect_timeout)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, probe()).result()


def probe_first(
    urls: list[str], *, read_timeout: float, connect_timeout: float | None = None
) -> tuple[int, ProbeResponse | None]:
    """Sync entry point for :func:`aprobe_first`; same loop-isolation rules as :func:`probe_get`."""
    probe = functools.partial(aprobe_first, urls, read_timeout=read_timeout, connect_timeout=connect_timeout)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, probe()).result()
