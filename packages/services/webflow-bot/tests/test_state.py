"""Unit tests for state.py.

state.py owns the bot's shared mutable globals. These tests exercise the
public mutators without spinning up Camoufox or Playwright — verifying that
each setter actually re-binds the module attribute it claims to manage and
that `set_phase` produces the dict shape that GET /health returns.

state.py's playwright imports are TYPE_CHECKING-only, so this test file can
import the module in a Python env that has only stdlib + pytest installed.
"""

from __future__ import annotations

import time

from webflow_bot import state

# state reset is handled by conftest.py's autouse fixture.


def test_status_has_required_keys():
    """The /health endpoint relies on `phase` always being present.
    Verify the contract — values may shift across tests (the autouse
    fixture restores them) but the keys must always be there."""
    assert "phase" in state.status
    assert "ready" in state.status


def test_set_phase_updates_status_and_stamps_time():
    """set_phase MUST write both `phase` and `phase_at` so the runbook's
    'how long has the bot been stuck' check has a timestamp."""
    before = time.time()
    state.set_phase("opening-designer")
    after = time.time()
    assert state.status["phase"] == "opening-designer"
    assert before <= state.status["phase_at"] <= after


def test_set_phase_preserves_other_status_keys():
    """status is shared with /health; setting phase must not nuke `ready`,
    `manual_login_required`, etc."""
    state.status["ready"] = True
    state.status["manual_login_required"] = True
    state.set_phase("health-probe")
    assert state.status["ready"] is True
    assert state.status["manual_login_required"] is True


def test_set_page_re_binds_module_attribute():
    """`global page` in state.py is the documented seam — verify the setter
    actually rebinds it. (`global` doesn't cross module boundaries; without
    this helper, other modules would read a stale None forever.)"""
    sentinel = object()
    state.set_page(sentinel)  # type: ignore[arg-type]
    assert state.page is sentinel
    state.set_page(None)
    assert state.page is None


def test_set_context_re_binds_module_attribute():
    """Companion to set_page — same contract."""
    sentinel = object()
    state.set_context(sentinel)  # type: ignore[arg-type]
    assert state.context is sentinel
    state.set_context(None)
    assert state.context is None


def test_set_last_health_at_re_binds_scalar():
    """control_plane.ControlServer.service_actions reassigns this on every
    tick. If the setter doesn't rebind, the health probe loops on the
    initial 0.0 forever."""
    state.set_last_health_at(123456.0)
    assert state.last_health_at == 123456.0


def test_log_writes_line_with_timestamp(capsys):
    """log() is the bot's only stdout discipline — verify the format so the
    kubectl logs scraper continues to parse it."""
    state.log("hello", "world")
    captured = capsys.readouterr()
    line = captured.out.strip()
    # Shape: "[bot YYYY-MM-DDTHH:MM:SSZ] hello world"
    assert line.startswith("[bot ")
    assert line.endswith("] hello world")
    assert "Z]" in line


def test_log_handles_non_string_args(capsys):
    """state.log is called with exceptions and dicts in the original source.
    Verify it doesn't crash on those."""
    state.log("err:", ValueError("boom"), {"key": "value"})
    captured = capsys.readouterr()
    # Exception → str(e), dict → str(d)
    assert "err:" in captured.out
    assert "boom" in captured.out
    assert "key" in captured.out
