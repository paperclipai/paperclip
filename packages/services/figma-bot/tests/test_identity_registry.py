"""Unit tests for the backoff state machine.

`identity_in_backoff` returning an exponentially-escalating
retry_after_seconds is what the cluster operator runbook actually
relies on — `_BACKOFF_SCHEDULE` is therefore part of the public
contract. Pin its shape + behavior.
"""

from __future__ import annotations

import time

from figma_bot.identity_registry import (
    _BACKOFF_SCHEDULE,
    get_identity_state,
    identity_in_backoff,
    record_login_failure,
    record_login_success,
    slug_for,
)

# ─── slug_for ──────────────────────────────────────────────────────────


def test_slug_for_is_deterministic():
    assert slug_for("alice@example.com") == slug_for("alice@example.com")


def test_slug_for_distinguishes_identities():
    assert slug_for("alice@example.com") != slug_for("bob@example.com")


def test_slug_for_is_16_hex_chars():
    """Path-safe + collision-resistant — matches ccrotate-auth-bot convention."""
    s = slug_for("ally@blockcast.net")
    assert len(s) == 16
    assert all(c in "0123456789abcdef" for c in s)


# ─── Backoff schedule ──────────────────────────────────────────────────


def test_backoff_schedule_is_monotonic():
    """Each escalation must be ≥ the previous; otherwise the operator
    sees retry_after_seconds bouncing around instead of escalating."""
    for prev, nxt in zip(_BACKOFF_SCHEDULE, _BACKOFF_SCHEDULE[1:], strict=False):
        assert nxt >= prev


def test_backoff_schedule_matches_runbook():
    """60s, 5m, 30m, 2h, 6h cap — pinned because the cluster operator
    runbook explicitly documents this curve. Changing it requires a
    runbook update."""
    assert _BACKOFF_SCHEDULE == [60, 300, 1800, 7200, 21600]


# ─── Per-identity state machine ────────────────────────────────────────


def test_fresh_identity_not_in_backoff():
    assert identity_in_backoff("never-failed@example.com") is None


def test_first_failure_sets_60s_backoff():
    """First failure → 60s. Operator sees retry_after_seconds≈60."""
    record_login_failure("alice@example.com", "rfb_unreachable")
    remain = identity_in_backoff("alice@example.com")
    assert remain is not None
    # Should be close to 60 (allow a few hundred ms for test wall time)
    assert 58 < remain <= 60


def test_second_failure_escalates_to_5m():
    record_login_failure("bob@example.com", "rfb_unreachable")
    record_login_failure("bob@example.com", "switch_timeout")
    remain = identity_in_backoff("bob@example.com")
    assert remain is not None
    assert 298 < remain <= 300


def test_third_failure_escalates_to_30m():
    """The cluster's deployed bot hit this case repeatedly during
    ccrotate-induced SSO churn — pin the 30-minute backoff."""
    record_login_failure("carol@example.com", "x")
    record_login_failure("carol@example.com", "x")
    record_login_failure("carol@example.com", "x")
    remain = identity_in_backoff("carol@example.com")
    assert remain is not None
    assert 1798 < remain <= 1800


def test_backoff_caps_at_6_hours():
    """After the schedule is exhausted, further failures cap at 6h (the
    last entry). Without this cap, an exponential past 6h would lock the
    identity out for days."""
    for _ in range(20):
        record_login_failure("dave@example.com", "x")
    remain = identity_in_backoff("dave@example.com")
    assert remain is not None
    assert 21598 < remain <= 21600


def test_success_clears_backoff():
    """A successful login wipes the backoff state — next failure starts
    again from 60s."""
    record_login_failure("eve@example.com", "x")
    assert identity_in_backoff("eve@example.com") is not None
    record_login_success("eve@example.com")
    assert identity_in_backoff("eve@example.com") is None
    # Next failure starts fresh at 60s, NOT escalated
    record_login_failure("eve@example.com", "x")
    remain = identity_in_backoff("eve@example.com")
    assert remain is not None
    assert 58 < remain <= 60


def test_success_records_last_login_at():
    """Operator's /health.identities map surfaces last_login_at."""
    before = time.time()
    record_login_success("frank@example.com")
    after = time.time()
    s = get_identity_state("frank@example.com")
    assert s.last_login_at is not None
    assert before <= s.last_login_at <= after
    assert s.consecutive_failures == 0


def test_failure_records_reason_for_health_surface():
    """/health.identities[].last_failure surfaces the reason. Test pins
    the dict shape since dashboards parse it."""
    record_login_failure("grace@example.com", "switch_timeout")
    s = get_identity_state("grace@example.com")
    assert s.last_failure is not None
    assert s.last_failure["reason"] == "switch_timeout"
    assert "at" in s.last_failure


def test_get_identity_state_is_idempotent():
    """Multiple gets return the SAME instance (so successive
    record_login_* calls mutate one state object, not a clone each call)."""
    s1 = get_identity_state("henry@example.com")
    s2 = get_identity_state("henry@example.com")
    assert s1 is s2
