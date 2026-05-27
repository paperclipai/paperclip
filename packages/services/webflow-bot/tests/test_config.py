"""Unit tests for config.py.

config.py exposes env-derived constants. The constants themselves are
captured at module-import time so they're hard to vary across tests —
test what we can: the `assert_credentials_present` failure path.
"""

from __future__ import annotations

from unittest import mock

import pytest

from webflow_bot import config


def test_assert_credentials_present_passes_when_both_set():
    """assert_credentials_present must not sys.exit when both creds are
    present. This is the happy path that runs on every cluster pod boot."""
    with mock.patch.object(config, "EMAIL", "alice@example.com"), \
         mock.patch.object(config, "PASSWORD", "hunter2"):
        # No assertion — just that it doesn't raise/exit.
        config.assert_credentials_present()


@pytest.mark.parametrize(
    "email,password",
    [
        ("", "hunter2"),
        ("alice@example.com", ""),
        ("", ""),
    ],
)
def test_assert_credentials_present_exits_on_missing(email: str, password: str):
    """Cluster yaml mounts WEBFLOW_EMAIL + WEBFLOW_PASSWORD from the
    paperclip-figma-bot-creds secret. If either is missing the bot MUST
    fail fast — silent unauthenticated launches would lead to ten-minute
    login-form-timeout cycles instead of an immediate operator-visible
    pod CrashLoopBackOff."""
    with mock.patch.object(config, "EMAIL", email), \
         mock.patch.object(config, "PASSWORD", password):
        with pytest.raises(SystemExit) as exc_info:
            config.assert_credentials_present()
        assert exc_info.value.code == 2


def test_state_file_lives_under_profile_dir():
    """STATE_FILE must always be inside PROFILE_DIR — otherwise Camoufox's
    profile-restore looks in the wrong place after a pod restart."""
    assert config.STATE_FILE.startswith(config.PROFILE_DIR)
    assert config.STATE_FILE.endswith(".json")


def test_dashboard_url_is_canonical():
    """DASHBOARD_URL is hard-coded (not env-derived) — `is_logged_in` uses
    it to detect a valid session. Pin the value so future env-i-fication
    has to update this test deliberately."""
    assert config.DASHBOARD_URL == "https://webflow.com/dashboard"


def test_refresh_seconds_is_positive_int():
    """The health-probe cadence must be a positive int — service_actions
    uses `now - last_health_at >= REFRESH_SECONDS` and a zero value would
    drive a runaway probe loop."""
    assert isinstance(config.REFRESH_SECONDS, int)
    assert config.REFRESH_SECONDS > 0


def test_control_port_in_valid_range():
    assert 1 <= config.CONTROL_PORT <= 65535
