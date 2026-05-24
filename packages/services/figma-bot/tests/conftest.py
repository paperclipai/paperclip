"""Shared pytest fixtures for figma-bot.

The bot's design uses module-level mutable globals (status, lease,
active_target, pending_switch_done, identities). Tests that mutate these
MUST not leak into each other — the autouse `_reset_state` fixture
snapshots before each test and restores after.
"""

from __future__ import annotations

import queue

import pytest

from figma_bot import state
from figma_bot.identity_registry import _identity_states, _identity_states_lock


@pytest.fixture(autouse=True)
def _reset_state():
    """Snapshot+restore mutable globals around each test."""
    snap_status = state.status.copy()
    snap_lease = state.lease.copy()
    snap_identities = state.identities
    snap_active_target = state._active_target  # type: ignore[attr-defined]
    snap_force_refresh = state._active_target_force_refresh  # type: ignore[attr-defined]
    # Drain the job_queue + pending_switch_done lists; tests that leak
    # items here would poison the main-loop dispatch in later tests.
    drained: list = []
    while True:
        try:
            drained.append(state.job_queue.get_nowait())
        except queue.Empty:
            break
    snap_pending = list(state.pending_switch_done)
    # IdentityState snapshots — backoff tests mutate these globals.
    with _identity_states_lock:
        snap_identity_states = dict(_identity_states)
    try:
        yield
    finally:
        state.status.clear()
        state.status.update(snap_status)
        state.lease.clear()
        state.lease.update(snap_lease)
        state.set_identities(snap_identities)
        state.set_active_target(snap_active_target, snap_force_refresh)
        # Restore queues
        while True:
            try:
                state.job_queue.get_nowait()
            except queue.Empty:
                break
        for item in drained:
            state.job_queue.put(item)
        state.pending_switch_done[:] = snap_pending
        with _identity_states_lock:
            _identity_states.clear()
            _identity_states.update(snap_identity_states)
