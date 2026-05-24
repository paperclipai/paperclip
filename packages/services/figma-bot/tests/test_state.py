"""Unit tests for figma_bot.state.

state.py owns the bot's shared mutable globals. Tests exercise public
setters without spinning up Camoufox or Playwright. The conftest fixture
restores all globals around each test.
"""

from __future__ import annotations

import time

from figma_bot import state


def test_status_has_required_keys():
    """The /health endpoint relies on these keys always being present."""
    for key in ("ready", "phase"):
        assert key in state.status


def test_set_phase_updates_status_and_stamps_time():
    before = time.time()
    state.set_phase("opening-designer")
    after = time.time()
    assert state.status["phase"] == "opening-designer"
    assert before <= state.status["phase_at"] <= after


def test_set_phase_preserves_other_status_keys():
    """status is shared with /health; set_phase must not clobber other keys."""
    state.status["ready"] = True
    state.status["logged_in"] = True
    state.set_phase("health-probe")
    assert state.status["ready"] is True
    assert state.status["logged_in"] is True


def test_set_active_target_re_binds_module_attributes():
    """`global` doesn't cross module boundaries — the setter is the seam."""
    state.set_active_target("ally@blockcast.net", force_refresh=True)
    target, force_refresh = state.get_active_target()
    assert target == "ally@blockcast.net"
    assert force_refresh is True
    state.set_active_target(None, force_refresh=False)
    assert state.get_active_target() == (None, False)


def test_clear_force_refresh_keeps_target():
    state.set_active_target("alice@example.com", force_refresh=True)
    state.clear_force_refresh()
    target, force_refresh = state.get_active_target()
    assert target == "alice@example.com"
    assert force_refresh is False


def test_set_identities_re_binds():
    sentinel = object()
    state.set_identities(sentinel)  # type: ignore[arg-type]
    assert state.identities is sentinel
    state.set_identities(None)
    assert state.identities is None


def test_log_writes_timestamped_line(capsys):
    state.log("hello", "world")
    captured = capsys.readouterr()
    line = captured.out.strip()
    # Shape: "[figma-bot YYYY-MM-DDTHH:MM:SSZ] hello world"
    assert line.startswith("[figma-bot ")
    assert "hello world" in line
    assert "Z]" in line


def test_log_handles_non_string_args(capsys):
    state.log("err:", ValueError("boom"), {"key": "value"})
    out = capsys.readouterr().out
    assert "err:" in out
    assert "boom" in out
    assert "key" in out
