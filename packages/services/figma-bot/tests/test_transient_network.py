"""Regression gates for the transient-network classification + retry.

Live-observed 2026-05-25 06:40 against the cluster pod
figma-designer-bot-676d5ffbcd-fcnf8: a /lease/acquire{force_refresh:
true} call triggered a Camoufox relaunch, and the relaunch's first
page.goto("https://www.figma.com/login") failed with NS_ERROR_
CONNECTION_REFUSED. Root cause: the bot's egress SOCKS5 proxy goes
through a tailscale exit-node (pve-home-t7nqufay, 100.64.0.23) that
had gone offline. Cold-boot 12 minutes earlier worked because the
exit-node was up then.

The auth-backoff schedule (60s → 5m → 30m → 2h → 6h) was designed for
bad-credentials / rate-limit scenarios, NOT infra flaps. Escalating
backoff on an offline exit-node locks the bot out for hours after the
infra recovers in minutes.

Three regression gates here:

1. `_is_transient_network_error` classifier matches the known signatures
   (CONNECTION_REFUSED + family) without false-positive on auth errors.

2. `_goto_with_network_retry` retries on transient errors and raises
   TransientNetworkError after attempts exhausted (so the caller can
   apply a short cooldown instead of escalating backoff).

3. `record_login_failure(transient_infra=True)` applies a short
   cooldown (30s) WITHOUT incrementing consecutive_failures — so a
   genuine bad-credentials failure that follows a network flap still
   escalates correctly from the first-failure rung.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from figma_bot.identity_registry import (
    _BACKOFF_SCHEDULE,
    _TRANSIENT_INFRA_COOLDOWN_S,
    get_identity_state,
    identity_in_backoff,
    record_login_failure,
    record_login_success,
)
from figma_bot.login import (
    TransientNetworkError,
    _goto_with_network_retry,
    _is_transient_network_error,
)

# ─── classifier ────────────────────────────────────────────────────────


@pytest.mark.parametrize("msg", [
    "Page.goto: NS_ERROR_CONNECTION_REFUSED",
    "NS_ERROR_PROXY_CONNECTION_REFUSED at https://www.figma.com/",
    "NS_ERROR_NET_TIMEOUT",
    "Error: NS_ERROR_NET_RESET",
    "Page.goto: NS_ERROR_NET_INTERRUPT",
    "NS_ERROR_UNKNOWN_PROXY_HOST",
    "NS_ERROR_UNKNOWN_HOST: www.figma.com",
    "NS_ERROR_PROXY_BAD_GATEWAY",
    "NS_ERROR_PROXY_GATEWAY_TIMEOUT",
])
def test_classifier_catches_known_transient_signatures(msg: str) -> None:
    assert _is_transient_network_error(Exception(msg)) is True, (
        f"Classifier missed known transient signature: {msg!r}"
    )


@pytest.mark.parametrize("msg", [
    "figma_login_error: Invalid email or password",
    "email input did not appear within 20s",
    "Log in button has no bbox",
    "login timeout after 45s; last_probe=missing_authentication",
    "missing_authentication",
    "http_400",
    "http_429",
    "RFBConnectFailed: Connection refused on 127.0.0.1:5900",  # different layer
    "Unrelated RuntimeError",
])
def test_classifier_doesnt_false_positive_on_auth_errors(msg: str) -> None:
    assert _is_transient_network_error(Exception(msg)) is False, (
        f"Classifier false-positively matched auth-side error: {msg!r}"
    )


# ─── _goto_with_network_retry ──────────────────────────────────────────


def test_goto_retry_succeeds_after_one_transient_failure() -> None:
    """First attempt fails CONNECTION_REFUSED, second succeeds → no raise."""
    page = MagicMock()
    page.goto.side_effect = [
        Exception("Page.goto: NS_ERROR_CONNECTION_REFUSED"),
        None,  # success
    ]
    _goto_with_network_retry(
        page, "https://www.figma.com/login",
        attempts=3, wait_between_s=0.01,
    )
    assert page.goto.call_count == 2


def test_goto_retry_raises_transient_network_error_after_exhaustion() -> None:
    """All attempts fail with transient errors → raises TransientNetworkError
    (NOT the underlying Playwright Error). The caller MUST get the
    classified type so it can apply the short cooldown."""
    page = MagicMock()
    page.goto.side_effect = Exception("NS_ERROR_PROXY_CONNECTION_REFUSED")
    with pytest.raises(TransientNetworkError) as exc_info:
        _goto_with_network_retry(
            page, "https://www.figma.com/login",
            attempts=3, wait_between_s=0.01,
        )
    assert "page.goto" in str(exc_info.value)
    assert page.goto.call_count == 3


def test_goto_retry_doesnt_retry_non_transient_errors() -> None:
    """Auth-style errors must surface immediately (no retry, no
    TransientNetworkError wrapping) so the caller's normal backoff
    schedule applies."""
    page = MagicMock()
    page.goto.side_effect = RuntimeError("figma_login_error: bad creds")
    with pytest.raises(RuntimeError) as exc_info:
        _goto_with_network_retry(
            page, "https://www.figma.com/login",
            attempts=3, wait_between_s=0.01,
        )
    assert "figma_login_error" in str(exc_info.value)
    assert not isinstance(exc_info.value, TransientNetworkError), (
        "Auth-side errors must NOT be wrapped as TransientNetworkError"
    )
    assert page.goto.call_count == 1, (
        "Non-transient errors must surface on the first attempt — retrying "
        "wastes time and could trigger figma's rate limiter."
    )


# ─── record_login_failure(transient_infra=True) ────────────────────────


def test_transient_infra_failure_doesnt_escalate_consecutive_failures() -> None:
    """The whole point of the transient_infra flag: an exit-node flap
    must NOT advance the 60s→6h auth-backoff schedule. If it did, a
    5-minute tailscale hiccup would lock the bot out for 6 hours."""
    ident = "transient-test@example.com"
    s_before = get_identity_state(ident)
    s_before.consecutive_failures = 0
    s_before.backoff_until = None

    # 5 transient flaps in a row.
    for _ in range(5):
        record_login_failure(ident, "transient_network:CONNECTION_REFUSED", transient_infra=True)

    s_after = get_identity_state(ident)
    assert s_after.consecutive_failures == 0, (
        f"transient_infra must not advance consecutive_failures; "
        f"after 5 flaps it became {s_after.consecutive_failures}"
    )
    remaining = identity_in_backoff(ident) or 0.0
    assert 0 < remaining <= _TRANSIENT_INFRA_COOLDOWN_S, (
        f"transient_infra cooldown must be <= {_TRANSIENT_INFRA_COOLDOWN_S}s; "
        f"got {remaining:.1f}s"
    )


def test_transient_infra_failure_after_real_failure_doesnt_shorten_backoff() -> None:
    """If a real bad-credentials failure put us in 1800s backoff and an
    infra flap fires after, the cooldown must NOT shorten the existing
    longer backoff (which would let the bot retry into a bad password
    too soon)."""
    ident = "long-backoff-test@example.com"
    s = get_identity_state(ident)
    s.consecutive_failures = 0
    s.backoff_until = None

    # 3 real auth failures → 1800s backoff (third rung).
    for _ in range(3):
        record_login_failure(ident, "figma_login_error:bad password")
    long_remain = identity_in_backoff(ident) or 0.0
    assert long_remain > _TRANSIENT_INFRA_COOLDOWN_S * 2, (
        f"setup: expected long auth backoff, got {long_remain}s"
    )

    # An infra flap fires.
    record_login_failure(ident, "transient_network:CONNECTION_REFUSED", transient_infra=True)

    # backoff_until must NOT have been shortened.
    new_remain = identity_in_backoff(ident) or 0.0
    assert new_remain >= long_remain - 1, (  # -1s tolerance for clock drift
        f"transient_infra flap shortened existing auth backoff from "
        f"{long_remain:.0f}s to {new_remain:.0f}s — bad credentials window lost"
    )


def test_real_auth_failure_after_transient_infra_starts_at_first_rung() -> None:
    """The mirror case: a transient infra flap followed by a real auth
    failure must escalate from the FIRST rung (60s), not from wherever
    consecutive_failures happens to be. This is what makes the
    classification load-bearing — flaps don't shadow real failures."""
    ident = "first-rung-test@example.com"
    s = get_identity_state(ident)
    s.consecutive_failures = 0
    s.backoff_until = None

    # 3 transient flaps.
    for _ in range(3):
        record_login_failure(ident, "transient_network:flap", transient_infra=True)
    assert get_identity_state(ident).consecutive_failures == 0

    # First real auth failure should be the first rung (60s), not a
    # 4th-rung 7200s as it would if flaps had escalated.
    record_login_failure(ident, "figma_login_error:bad password")
    remain = identity_in_backoff(ident) or 0.0
    assert remain <= _BACKOFF_SCHEDULE[0] + 1, (  # +1s tolerance
        f"After flaps, first real failure should be first-rung ({_BACKOFF_SCHEDULE[0]}s); "
        f"got {remain:.0f}s — flaps incorrectly escalated the schedule"
    )


def test_record_login_success_clears_backoff_after_transient_flap() -> None:
    """Sanity: a successful login must clear the transient cooldown
    just like it clears auth backoff. Otherwise a recovered exit-node
    leaves leftover state."""
    ident = "recovery-test@example.com"
    s = get_identity_state(ident)
    s.consecutive_failures = 0
    s.backoff_until = None

    record_login_failure(ident, "transient_network:flap", transient_infra=True)
    assert identity_in_backoff(ident) is not None

    record_login_success(ident)
    assert identity_in_backoff(ident) is None
    assert get_identity_state(ident).consecutive_failures == 0
    assert get_identity_state(ident).last_failure is None
