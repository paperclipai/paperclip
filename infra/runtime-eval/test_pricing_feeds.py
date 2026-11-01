from datetime import datetime, timedelta
from decimal import Decimal

import pytest

from pricing_feeds import (
    FakeMarginPolicyChangeFeed,
    FakeNegotiatedRateChangeFeed,
    FakeRateRecordFeed,
    FeedUnavailableError,
    NegotiatedRateChange,
    NotImplementedMarginPolicyChangeFeed,
    NotImplementedNegotiatedRateChangeFeed,
    NotImplementedRateRecordFeed,
    PolicyChange,
    RateRecord,
)

NOW = datetime(2026, 7, 7, 12, 0, 0)


class TestNotImplementedAdapters:
    def test_rate_record_feed_raises_feed_unavailable(self):
        with pytest.raises(FeedUnavailableError, match="SAG-6341"):
            NotImplementedRateRecordFeed().get_active_rate_records(as_of=NOW)

    def test_negotiated_rate_change_feed_raises_feed_unavailable(self):
        with pytest.raises(FeedUnavailableError, match="SAG-6341"):
            NotImplementedNegotiatedRateChangeFeed().get_changes_since(since=NOW)

    def test_margin_policy_change_feed_raises_feed_unavailable(self):
        with pytest.raises(FeedUnavailableError, match="SAG-6341"):
            NotImplementedMarginPolicyChangeFeed().get_changes_since(since=NOW)


class TestFakeRateRecordFeed:
    def test_returns_only_records_imported_at_or_before_as_of(self):
        older = RateRecord(
            product_estimate_group="FG3",
            bucket_code="FQ3-A",
            territory="TX",
            rate_card_version="v1",
            imported_at=NOW - timedelta(days=1),
            rate_bearing_fields={"fee_per_sqft": Decimal("12.50")},
        )
        newer = RateRecord(
            product_estimate_group="FG3",
            bucket_code="FQ3-A",
            territory="TX",
            rate_card_version="v2",
            imported_at=NOW + timedelta(days=1),
            rate_bearing_fields={"fee_per_sqft": Decimal("13.00")},
        )
        feed = FakeRateRecordFeed(records=[older, newer])

        result = feed.get_active_rate_records(as_of=NOW)

        assert result == [older]

    def test_empty_feed_returns_empty_list(self):
        assert FakeRateRecordFeed().get_active_rate_records(as_of=NOW) == []


class TestFakeNegotiatedRateChangeFeed:
    def test_returns_only_changes_entered_since_cutoff(self):
        before = NegotiatedRateChange(
            record_key="FG3-FQ3-A-TX",
            old_value=Decimal("12.00"),
            new_value=Decimal("12.50"),
            source="manual",
            reason="cost increase",
            entered_at=NOW - timedelta(days=2),
        )
        after = NegotiatedRateChange(
            record_key="FG3-FQ3-A-TX",
            old_value=Decimal("12.50"),
            new_value=Decimal("13.00"),
            source="manual",
            reason="renegotiation",
            entered_at=NOW + timedelta(hours=1),
        )
        feed = FakeNegotiatedRateChangeFeed(changes=[before, after])

        result = feed.get_changes_since(since=NOW)

        assert result == [after]


class TestFakeMarginPolicyChangeFeed:
    def test_returns_only_changes_effective_since_cutoff(self):
        before = PolicyChange(
            policy_key="margin_floor",
            old="0.10",
            new="0.12",
            effective_at=NOW - timedelta(days=5),
            reason="quarterly review",
        )
        after = PolicyChange(
            policy_key="sut_dimension",
            old="width",
            new="width+depth",
            effective_at=NOW + timedelta(days=1),
            reason="new SKU class",
        )
        feed = FakeMarginPolicyChangeFeed(changes=[before, after])

        result = feed.get_changes_since(since=NOW)

        assert result == [after]
