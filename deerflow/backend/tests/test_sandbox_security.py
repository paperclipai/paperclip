"""Tests for sandbox security capability gating."""

from types import SimpleNamespace

from src.sandbox.security import uses_local_sandbox_provider, is_host_bash_allowed


def _make_config(use="", allow_host_bash=None):
    """Build a minimal config namespace mimicking the app config structure."""
    sandbox_attrs = {"use": use}
    if allow_host_bash is not None:
        sandbox_attrs["allow_host_bash"] = allow_host_bash
    return SimpleNamespace(sandbox=SimpleNamespace(**sandbox_attrs))


# -- uses_local_sandbox_provider ------------------------------------------------


def test_uses_local_sandbox_provider_true_for_marker():
    """Returns True when sandbox.use matches a known marker string."""
    config = _make_config(use="src.sandbox.local:LocalSandboxProvider")
    assert uses_local_sandbox_provider(config) is True

    config2 = _make_config(use="src.sandbox.local.local_sandbox_provider:LocalSandboxProvider")
    assert uses_local_sandbox_provider(config2) is True


def test_uses_local_sandbox_provider_false_for_aio():
    """Returns False for the AioSandboxProvider class path."""
    config = _make_config(use="src.community.aio_sandbox:AioSandboxProvider")
    assert uses_local_sandbox_provider(config) is False


def test_uses_local_sandbox_provider_true_for_suffix_match():
    """Returns True for any path ending in :LocalSandboxProvider with src.sandbox.local in it."""
    config = _make_config(use="src.sandbox.local.custom_module:LocalSandboxProvider")
    assert uses_local_sandbox_provider(config) is True


# -- is_host_bash_allowed -------------------------------------------------------


def test_is_host_bash_allowed_false_by_default():
    """Local sandbox without allow_host_bash defaults to False."""
    config = _make_config(use="src.sandbox.local:LocalSandboxProvider")
    assert is_host_bash_allowed(config) is False


def test_is_host_bash_allowed_true_when_set():
    """Local sandbox with allow_host_bash=True returns True."""
    config = _make_config(use="src.sandbox.local:LocalSandboxProvider", allow_host_bash=True)
    assert is_host_bash_allowed(config) is True


def test_is_host_bash_allowed_true_for_non_local():
    """Non-local sandbox always returns True regardless of allow_host_bash."""
    config = _make_config(use="src.community.aio_sandbox:AioSandboxProvider")
    assert is_host_bash_allowed(config) is True
