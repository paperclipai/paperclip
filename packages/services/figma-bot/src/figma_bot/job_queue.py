"""Main-thread dispatch queue + switch-coordinator.

Playwright sync_api binds its internal greenlet to the thread that
created the Page (main thread). HTTP handlers run on worker threads, so
every Page operation routes through this queue and gets dispatched on
the main loop's iteration.
"""

from __future__ import annotations

import queue
import threading
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from . import state
from .config import JOB_TIMEOUT

if TYPE_CHECKING:
    from playwright.sync_api import Page


# ─── Generic page-job dispatch ─────────────────────────────────────────


def submit_job(fn: Callable[[Page], Any], timeout: float = JOB_TIMEOUT) -> Any:
    done = threading.Event()
    box: dict = {"result": None, "error": None}
    state.job_queue.put((fn, box, done))
    if not done.wait(timeout):
        raise TimeoutError(f"Playwright job timed out after {timeout}s")
    if box["error"] is not None:
        raise box["error"]
    return box["result"]


# ─── Switch coordinator ────────────────────────────────────────────────


class SwitchJobError(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class _SwitchSentinel:
    """Marker pushed onto job_queue to tell the main loop to swap identity."""
    __slots__ = ("identity", "force_refresh")

    def __init__(self, identity: str, force_refresh: bool):
        self.identity = identity
        self.force_refresh = force_refresh


def submit_switch_job(
    identity: str,
    force_refresh: bool,
    timeout: float = 60.0,
) -> tuple[bool, bool]:
    """Blocking primitive. Returns (switched, login_performed).
    Raises SwitchJobError(reason) on failure."""
    box: dict = {}
    done = threading.Event()
    entry = (identity, box, done)
    with state.pending_switch_done_lock:
        state.pending_switch_done.append(entry)
    state.job_queue.put((_SwitchSentinel(identity, force_refresh), box, done))
    if not done.wait(timeout=timeout):
        with state.pending_switch_done_lock:
            try:
                state.pending_switch_done.remove(entry)
            except ValueError:
                pass  # signal raced with timeout; entry already removed
        raise SwitchJobError("switch_timeout")
    if "error" in box:
        raise SwitchJobError(box["error"])
    return box.get("switched", False), box.get("login_performed", False)


def signal_switch_done(
    identity: str,
    *,
    switched: bool,
    login_performed: bool,
    error: str | None,
) -> None:
    """Called by the main loop after a switch attempt resolves."""
    with state.pending_switch_done_lock:
        still = []
        for ident, box, done in state.pending_switch_done:
            if ident == identity:
                if error is None:
                    box["switched"] = switched
                    box["login_performed"] = login_performed
                else:
                    box["error"] = error
                done.set()
            else:
                still.append((ident, box, done))
        state.pending_switch_done[:] = still


def drain_jobs_for(page: Page, max_seconds: float) -> None:
    """Pull jobs off job_queue and execute them on the main thread, up to
    max_seconds. Returns early on a _SwitchSentinel (so the main loop can
    pick up the new target)."""
    import time as _time  # noqa: PLC0415

    from .config import JOB_POLL_INTERVAL  # noqa: PLC0415

    deadline = _time.time() + max_seconds
    while True:
        remaining = deadline - _time.time()
        if remaining <= 0:
            return
        try:
            entry = state.job_queue.get(timeout=min(remaining, JOB_POLL_INTERVAL))
        except queue.Empty:
            return
        fn, box, done = entry
        if isinstance(fn, _SwitchSentinel):
            # Record the target; main loop body picks it up next iteration.
            # Do NOT signal done here — signal_switch_done does that.
            state.set_active_target(fn.identity, fn.force_refresh)
            return  # yield to the main loop so the switch runs
        try:
            box["result"] = fn(page)
        except Exception as e:
            box["error"] = e
        finally:
            done.set()


def drain_pending_switch_sentinels() -> bool:
    """Non-blocking scan of job_queue for any pending _SwitchSentinel.

    Without this, after an auto_login failure tore pm down, the main
    loop could no longer call drain_jobs_for (which requires pm.page).
    Sentinels from /lease/acquire would sit on the queue indefinitely,
    submit_switch_job would time out at 60s, and the bot would ratchet
    backoff on a healthy queue — the same chicken-and-egg as BLO-6870
    but post-failure rather than cold-boot.

    Page jobs (non-sentinel queue entries) that get pulled during the
    scan are deferred back to the queue so drain_jobs_for can run them
    once pm.page exists.

    Returns True if at least one sentinel was processed (i.e. the
    caller should re-read state.get_active_target()).
    """
    deferred: list = []
    processed_any = False
    while True:
        try:
            entry = state.job_queue.get(block=False)
        except queue.Empty:
            break
        fn, box, done = entry
        if isinstance(fn, _SwitchSentinel):
            state.set_active_target(fn.identity, fn.force_refresh)
            # Do NOT signal done — signal_switch_done does that after
            # the main loop processes the switch.
            processed_any = True
        else:
            deferred.append(entry)
    for entry in deferred:
        state.job_queue.put(entry)
    return processed_any
