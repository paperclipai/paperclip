"""Shared pytest fixtures for webflow-bot.

The bot's design intentionally uses module-level mutable globals (status,
page, context, last_health_at). Tests that mutate these MUST not leak into
each other — the autouse `_reset_state` fixture snapshots before each test
and restores after, so test order doesn't matter.
"""

from __future__ import annotations

import pytest

from webflow_bot import state


@pytest.fixture(autouse=True)
def _reset_state():
    """Snapshot+restore mutable globals around each test."""
    snap_status = state.status.copy()
    snap_page = state.page
    snap_context = state.context
    snap_last_health = state.last_health_at
    try:
        yield
    finally:
        state.status.clear()
        state.status.update(snap_status)
        state.set_page(snap_page)
        state.set_context(snap_context)
        state.set_last_health_at(snap_last_health)
