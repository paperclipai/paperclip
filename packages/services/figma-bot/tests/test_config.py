"""Unit tests for figma_bot.config."""

from __future__ import annotations

from figma_bot import config


def test_state_file_unused_in_figma_bot():
    """Unlike webflow-bot, figma-bot uses per-identity profile dirs at
    PROFILES_ROOT, not a single storage_state.json. Verify PROFILES_ROOT
    is set and falls under /config by default."""
    assert config.PROFILES_ROOT.startswith("/config")


def test_refresh_seconds_is_positive_int():
    assert isinstance(config.REFRESH_SECONDS, int)
    assert config.REFRESH_SECONDS > 0


def test_control_port_in_valid_range():
    assert 1 <= config.CONTROL_PORT <= 65535


def test_job_timeout_is_positive_float():
    assert config.JOB_TIMEOUT > 0


def test_default_lease_ttl_positive():
    assert config.DEFAULT_LEASE_TTL > 0


def test_identities_path_is_absolute():
    """The cluster Secret mount path needs to be absolute."""
    assert config.IDENTITIES_PATH.startswith("/")


def test_legacy_paths_match_pre_t6():
    """Migration shim depends on these exact paths. If the legacy layout
    ever moves, migration.py needs an updated source path."""
    assert config.LEGACY_PROFILE_DIR == "/config/playwright-profile"
    assert config.LEGACY_BACKUP_DIR == "/config/playwright-profile-backup"


def test_rfb_button_hold_is_human_natural():
    """50ms matches a natural human click duration. Longer triggers
    Figma's long-press handlers; shorter gets debounced. The constant is
    load-bearing for the Continue-with-Google bypass."""
    assert 0.03 <= config._RFB_BUTTON_HOLD_S <= 0.2


def test_job_poll_interval_module_constant():
    assert config.JOB_POLL_INTERVAL > 0
