from datetime import datetime, timedelta, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest

from pricing_feeds import (
    FakeMarginPolicyChangeFeed,
    FakeNegotiatedRateChangeFeed,
    FakeRateRecordFeed,
    NegotiatedRateChange,
    PolicyChange,
    RateRecord,
)
from pricing_staleness_alerts import InMemoryAlertSink
from pricing_staleness_runner import (
    BULK_ESCALATION_THRESHOLD,
    commit_due_at,
    detect_anomalies,
    detect_bulk_escalation,
    detect_sla_breaches,
    detect_version_hash_drift,
    is_sla_breached,
    run_detection,
)

CHICAGO = ZoneInfo("America/Chicago")
UTC = timezone.utc


def _record(imported_at, value, version="v1", content_hash="h1", **overrides):
    defaults = dict(
        product_estimate_group="FG3",
        bucket_code="FQ3-A",
        territory="TX",
        rate_card_version=version,
        imported_at=imported_at,
        rate_bearing_fields={"fee_per_sqft": Decimal(str(value))},
        content_hash=content_hash,
    )
    defaults.update(overrides)
    return RateRecord(**defaults)


# ---------------------------------------------------------------------------
# Signal 3 helper: business-day + timezone math
# ---------------------------------------------------------------------------


class TestCommitDueAt:
    def test_friday_entry_due_monday_18_00_chicago(self):
        # Friday 2026-07-10 (America/Chicago) -> next business day is Monday 2026-07-13
        entered_at = datetime(2026, 7, 10, 9, 0, tzinfo=CHICAGO)

        due = commit_due_at(entered_at)

        assert due == datetime(2026, 7, 13, 18, 0, tzinfo=CHICAGO)

    def test_monday_entry_due_tuesday_18_00_chicago(self):
        entered_at = datetime(2026, 7, 6, 8, 0, tzinfo=CHICAGO)  # Monday

        due = commit_due_at(entered_at)

        assert due == datetime(2026, 7, 7, 18, 0, tzinfo=CHICAGO)

    def test_saturday_entry_due_monday(self):
        entered_at = datetime(2026, 7, 11, 10, 0, tzinfo=CHICAGO)  # Saturday

        due = commit_due_at(entered_at)

        assert due == datetime(2026, 7, 13, 18, 0, tzinfo=CHICAGO)

    def test_naive_entered_at_is_treated_as_utc_then_converted(self):
        # 2026-07-10 23:30 UTC == 2026-07-10 18:30 America/Chicago (CDT, UTC-5) -> still Friday
        entered_at = datetime(2026, 7, 10, 23, 30)

        due = commit_due_at(entered_at)

        assert due == datetime(2026, 7, 13, 18, 0, tzinfo=CHICAGO)


class TestIsSlaBreached:
    def test_not_breached_when_committed_before_due(self):
        change = NegotiatedRateChange(
            record_key="FG3-FQ3-A-TX",
            old_value=Decimal("12.00"),
            new_value=Decimal("12.50"),
            source="manual",
            reason="cost increase",
            entered_at=datetime(2026, 7, 6, 8, 0, tzinfo=CHICAGO),
            committed_at=datetime(2026, 7, 7, 10, 0, tzinfo=CHICAGO),
        )

        assert is_sla_breached(change, as_of=datetime(2026, 7, 8, tzinfo=CHICAGO)) is False

    def test_breached_when_committed_after_due(self):
        change = NegotiatedRateChange(
            record_key="FG3-FQ3-A-TX",
            old_value=Decimal("12.00"),
            new_value=Decimal("12.50"),
            source="manual",
            reason="cost increase",
            entered_at=datetime(2026, 7, 6, 8, 0, tzinfo=CHICAGO),
            committed_at=datetime(2026, 7, 7, 19, 0, tzinfo=CHICAGO),
        )

        assert is_sla_breached(change, as_of=datetime(2026, 7, 8, tzinfo=CHICAGO)) is True

    def test_breached_when_still_uncommitted_past_due(self):
        change = NegotiatedRateChange(
            record_key="FG3-FQ3-A-TX",
            old_value=Decimal("12.00"),
            new_value=Decimal("12.50"),
            source="manual",
            reason="cost increase",
            entered_at=datetime(2026, 7, 6, 8, 0, tzinfo=CHICAGO),
            committed_at=None,
        )

        assert is_sla_breached(change, as_of=datetime(2026, 7, 8, tzinfo=CHICAGO)) is True

    def test_not_breached_when_uncommitted_before_due(self):
        change = NegotiatedRateChange(
            record_key="FG3-FQ3-A-TX",
            old_value=Decimal("12.00"),
            new_value=Decimal("12.50"),
            source="manual",
            reason="cost increase",
            entered_at=datetime(2026, 7, 6, 8, 0, tzinfo=CHICAGO),
            committed_at=None,
        )

        assert is_sla_breached(change, as_of=datetime(2026, 7, 7, 12, 0, tzinfo=CHICAGO)) is False


# ---------------------------------------------------------------------------
# Signal 1: anomaly vs trailing 3-mo median, with policy-change suppression
# ---------------------------------------------------------------------------


class TestDetectAnomalies:
    def test_flags_warn_at_5pct_and_critical_at_10pct(self):
        as_of = datetime(2026, 7, 7, tzinfo=UTC)
        history = [
            _record(as_of - timedelta(days=80), 10.00),
            _record(as_of - timedelta(days=60), 10.00),
            _record(as_of - timedelta(days=40), 10.00),
        ]
        warn_latest = _record(as_of, 10.51)  # +5.1%
        feed = FakeRateRecordFeed(records=history + [warn_latest])
        policy_feed = FakeMarginPolicyChangeFeed(changes=[])

        alerts = detect_anomalies(feed, policy_feed, as_of=as_of, warm_up=True)

        assert len(alerts) == 1
        assert alerts[0].signal_type == "anomaly"
        assert alerts[0].severity == "warn"

    def test_flags_critical_at_10pct(self):
        as_of = datetime(2026, 7, 7, tzinfo=UTC)
        history = [_record(as_of - timedelta(days=80), 10.00)]
        critical_latest = _record(as_of, 11.20)  # +12%
        feed = FakeRateRecordFeed(records=history + [critical_latest])
        policy_feed = FakeMarginPolicyChangeFeed(changes=[])

        alerts = detect_anomalies(feed, policy_feed, as_of=as_of, warm_up=True)

        assert len(alerts) == 1
        assert alerts[0].severity == "critical"

    def test_no_alert_below_5pct(self):
        as_of = datetime(2026, 7, 7, tzinfo=UTC)
        history = [_record(as_of - timedelta(days=80), 10.00)]
        latest = _record(as_of, 10.20)  # +2%
        feed = FakeRateRecordFeed(records=history + [latest])
        policy_feed = FakeMarginPolicyChangeFeed(changes=[])

        alerts = detect_anomalies(feed, policy_feed, as_of=as_of, warm_up=True)

        assert alerts == []

    def test_suppressed_by_recent_policy_change(self):
        as_of = datetime(2026, 7, 7, tzinfo=UTC)
        history = [_record(as_of - timedelta(days=80), 10.00)]
        latest = _record(as_of, 11.20)  # would be critical
        feed = FakeRateRecordFeed(records=history + [latest])
        policy_feed = FakeMarginPolicyChangeFeed(
            changes=[
                PolicyChange(
                    policy_key="margin_floor",
                    old="0.10",
                    new="0.12",
                    effective_at=as_of - timedelta(days=1),
                    reason="quarterly review",
                )
            ]
        )

        alerts = detect_anomalies(feed, policy_feed, as_of=as_of, warm_up=True)

        assert alerts == []

    def test_no_alert_with_insufficient_history(self):
        as_of = datetime(2026, 7, 7, tzinfo=UTC)
        feed = FakeRateRecordFeed(records=[_record(as_of, 50.00)])
        policy_feed = FakeMarginPolicyChangeFeed(changes=[])

        alerts = detect_anomalies(feed, policy_feed, as_of=as_of, warm_up=True)

        assert alerts == []


# ---------------------------------------------------------------------------
# Signal 2: rate_card_version / content-hash drift
# ---------------------------------------------------------------------------


class TestDetectVersionHashDrift:
    def test_flags_same_version_different_hash(self):
        as_of = datetime(2026, 7, 7, tzinfo=UTC)
        older = _record(as_of - timedelta(days=5), 10.00, version="v3", content_hash="hash-a")
        newer = _record(as_of, 10.00, version="v3", content_hash="hash-b")
        feed = FakeRateRecordFeed(records=[older, newer])

        alerts = detect_version_hash_drift(feed, as_of=as_of, warm_up=True)

        assert len(alerts) == 1
        assert alerts[0].signal_type == "version_hash_drift"
        assert alerts[0].severity == "critical"

    def test_no_alert_when_version_bumped_with_hash(self):
        as_of = datetime(2026, 7, 7, tzinfo=UTC)
        older = _record(as_of - timedelta(days=5), 10.00, version="v3", content_hash="hash-a")
        newer = _record(as_of, 10.50, version="v4", content_hash="hash-b")
        feed = FakeRateRecordFeed(records=[older, newer])

        alerts = detect_version_hash_drift(feed, as_of=as_of, warm_up=True)

        assert alerts == []

    def test_no_alert_when_version_and_hash_both_unchanged(self):
        as_of = datetime(2026, 7, 7, tzinfo=UTC)
        older = _record(as_of - timedelta(days=5), 10.00, version="v3", content_hash="hash-a")
        newer = _record(as_of, 10.00, version="v3", content_hash="hash-a")
        feed = FakeRateRecordFeed(records=[older, newer])

        alerts = detect_version_hash_drift(feed, as_of=as_of, warm_up=True)

        assert alerts == []


# ---------------------------------------------------------------------------
# Signal 3 (feed-level wiring): SLA breach detection over a change feed
# ---------------------------------------------------------------------------


class TestDetectSlaBreaches:
    def test_flags_uncommitted_change_past_due(self):
        as_of = datetime(2026, 7, 8, tzinfo=CHICAGO)
        change = NegotiatedRateChange(
            record_key="FG3-FQ3-A-TX",
            old_value=Decimal("12.00"),
            new_value=Decimal("12.50"),
            source="manual",
            reason="cost increase",
            entered_at=datetime(2026, 7, 6, 8, 0, tzinfo=CHICAGO),
            committed_at=None,
        )
        feed = FakeNegotiatedRateChangeFeed(changes=[change])

        alerts = detect_sla_breaches(feed, as_of=as_of, lookback_days=30, warm_up=True)

        assert len(alerts) == 1
        assert alerts[0].signal_type == "sla_breach"
        assert alerts[0].record_key == "FG3-FQ3-A-TX"

    def test_no_alert_when_committed_on_time(self):
        as_of = datetime(2026, 7, 8, tzinfo=CHICAGO)
        change = NegotiatedRateChange(
            record_key="FG3-FQ3-A-TX",
            old_value=Decimal("12.00"),
            new_value=Decimal("12.50"),
            source="manual",
            reason="cost increase",
            entered_at=datetime(2026, 7, 6, 8, 0, tzinfo=CHICAGO),
            committed_at=datetime(2026, 7, 7, 10, 0, tzinfo=CHICAGO),
        )
        feed = FakeNegotiatedRateChangeFeed(changes=[change])

        alerts = detect_sla_breaches(feed, as_of=as_of, lookback_days=30, warm_up=True)

        assert alerts == []


# ---------------------------------------------------------------------------
# Signal 4: bulk escalator
# ---------------------------------------------------------------------------


class TestDetectBulkEscalation:
    def test_no_escalation_below_threshold(self):
        as_of = datetime(2026, 7, 7, tzinfo=UTC)
        prior_alerts = [
            _anomaly_alert(f"key-{i}", as_of) for i in range(BULK_ESCALATION_THRESHOLD - 1)
        ]

        result = detect_bulk_escalation(prior_alerts, as_of=as_of, warm_up=True)

        assert result == []

    def test_escalates_at_threshold(self):
        as_of = datetime(2026, 7, 7, tzinfo=UTC)
        prior_alerts = [
            _anomaly_alert(f"key-{i}", as_of) for i in range(BULK_ESCALATION_THRESHOLD)
        ]

        result = detect_bulk_escalation(prior_alerts, as_of=as_of, warm_up=True)

        assert len(result) == 1
        assert result[0].signal_type == "bulk_escalation"
        assert result[0].severity == "critical"
        assert result[0].details["count"] == BULK_ESCALATION_THRESHOLD


def _anomaly_alert(key, as_of):
    from pricing_staleness_alerts import StalenessAlert

    return StalenessAlert(
        signal_type="anomaly",
        severity="warn",
        record_key=key,
        detected_at=as_of,
        warm_up=True,
        details={"pct_delta": 0.06},
    )


# ---------------------------------------------------------------------------
# run_detection: end-to-end wiring + warm-up stamping + zero enforcement
# ---------------------------------------------------------------------------


class TestRunDetection:
    def test_writes_one_alert_per_detection_and_stamps_warm_up(self):
        as_of = datetime(2026, 7, 7, tzinfo=UTC)
        history = [_record(as_of - timedelta(days=80), 10.00)]
        latest = _record(as_of, 11.20)  # critical anomaly
        rate_feed = FakeRateRecordFeed(records=history + [latest])
        change_feed = FakeNegotiatedRateChangeFeed(changes=[])
        policy_feed = FakeMarginPolicyChangeFeed(changes=[])
        sink = InMemoryAlertSink()

        run_detection(
            as_of=as_of,
            rate_feed=rate_feed,
            change_feed=change_feed,
            policy_feed=policy_feed,
            alert_sink=sink,
            warm_up=True,
        )

        assert len(sink.alerts) == 1
        assert all(a.warm_up is True for a in sink.alerts)

    def test_warm_up_false_is_stamped_through(self):
        as_of = datetime(2026, 7, 7, tzinfo=UTC)
        history = [_record(as_of - timedelta(days=80), 10.00)]
        latest = _record(as_of, 11.20)
        rate_feed = FakeRateRecordFeed(records=history + [latest])
        change_feed = FakeNegotiatedRateChangeFeed(changes=[])
        policy_feed = FakeMarginPolicyChangeFeed(changes=[])
        sink = InMemoryAlertSink()

        run_detection(
            as_of=as_of,
            rate_feed=rate_feed,
            change_feed=change_feed,
            policy_feed=policy_feed,
            alert_sink=sink,
            warm_up=False,
        )

        assert len(sink.alerts) == 1
        assert sink.alerts[0].warm_up is False

    def test_never_imports_or_calls_freeze_arming(self):
        # Phase 5 (quote-freeze arming) is separately blocked/build-only and out of
        # scope here. Guard against scope creep: this module must not reference it.
        import pricing_staleness_runner as runner_module

        source = open(runner_module.__file__).read()

        assert "arm_freeze" not in source
        assert "freeze_arm" not in source
