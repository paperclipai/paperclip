"""Shared mutable state for figma-bot.

The bot's design uses module-level mutable state guarded by RLocks. All
shared state lives here so any importer reads the live values. Writers
mutate dicts/lists in place, or — for scalar reassignment that needs to
be visible across modules — use the setter helpers below (Python `global`
only re-binds names within the same module).
"""

from __future__ import annotations

import queue
import threading
import time
from typing import TYPE_CHECKING, Any

from .config import DEFAULT_LEASE_TTL

if TYPE_CHECKING:
    # Type-only imports keep state.py importable without playwright /
    # camoufox installed (unit-test CI gate).
    from .identity_registry import IdentityRegistry


# ─── /health snapshot ──────────────────────────────────────────────────

status_lock: threading.RLock = threading.RLock()
status: dict = {
    "ready": False,
    "phase": "starting",
    "phase_at": time.time(),
    "logged_in": False,
    "url": None,
    "session_restored_at": None,
    "cookie_count": None,
    "last_check_at": None,
}


def set_phase(phase: str) -> None:
    with status_lock:
        status["phase"] = phase
        status["phase_at"] = time.time()


# ─── Single-tenant lease ───────────────────────────────────────────────

lease_lock: threading.RLock = threading.RLock()
lease: dict = {
    "lease_id": None,
    "client_id": None,
    "acquired_at": None,
    "last_heartbeat_at": None,
    "ttl_seconds": DEFAULT_LEASE_TTL,
}


# ─── Main-thread dispatch queue ────────────────────────────────────────

job_queue: queue.Queue = queue.Queue()


# ─── Active-target tracking ────────────────────────────────────────────

_active_target_lock: threading.RLock = threading.RLock()
_active_target: str | None = None
_active_target_force_refresh: bool = False


def set_active_target(identity: str | None, force_refresh: bool = False) -> None:
    """Set the identity the main loop should switch to next.

    `global` doesn't cross module boundaries; this setter is the
    documented seam. Without it, control_plane / job_queue couldn't make
    the main loop observe a new target.
    """
    global _active_target, _active_target_force_refresh
    with _active_target_lock:
        _active_target = identity
        _active_target_force_refresh = force_refresh


def get_active_target() -> tuple[str | None, bool]:
    with _active_target_lock:
        return _active_target, _active_target_force_refresh


def clear_force_refresh() -> None:
    global _active_target_force_refresh
    with _active_target_lock:
        _active_target_force_refresh = False


# ─── Switch-coordinator queue ──────────────────────────────────────────

pending_switch_done: list = []  # entries: (identity, box, done)
pending_switch_done_lock: threading.RLock = threading.RLock()


# ─── IdentityRegistry singleton ────────────────────────────────────────
#
# Initialized in __main__.main() before the control server starts.

identities: IdentityRegistry | None = None


def set_identities(registry: IdentityRegistry | None) -> None:
    global identities
    identities = registry


# ─── Logging ───────────────────────────────────────────────────────────


def log(*m: Any) -> None:
    """Stdout-flushing log line with UTC timestamp.

    Kept here (not in a separate logging module) because every module
    imports state anyway.
    """
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    print("[figma-bot " + ts + "]", *m, flush=True)
