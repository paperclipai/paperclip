"""Pricing staleness detection runner — SAG-6327 Phase 3+4 (SAG-6344).

Four signals, each producing zero or more `StalenessAlert` rows:
  1. anomaly       — latest rate-bearing field value vs trailing 3-mo median,
                      +-5% (warn) / +-10% (critical), suppressed by a recent
                      margin/SUT policy change.
  2. version/hash  — same `rate_card_version` but a different `content_hash`
                      between consecutive imports of the same record (silent
                      drift without a version bump).
  3. sla_breach    — a negotiated-rate change not committed by 18:00
                      America/Chicago on the next business day after it was
                      entered.
  4. bulk_escalation — a meta-signal: when signals 1-3 fire >= threshold times
                      in a single run, one additional escalation row is
                      written summarizing the batch.

Phase 4 (30-day warm-up): every alert is stamped `warm_up=True` while inside
the warm-up window. This module takes **zero enforcement action** in either
mode — it only detects and records. Quote-freeze arming is Phase 5 (SAG-6345,
separately blocked, build-only, never auto-armed) and is intentionally not
referenced here.

SAG-6327 Phase 1 (the `pricing_staleness_alerts` table, migration 003,
commit b35be578) has landed. Real writes go through the `AlertSink` contract
in pricing_staleness_alerts.py: `PostgresAlertSink` writes to the real table
when `PRICING_STALENESS_DB_DSN` is set; otherwise `NotImplementedAlertSink`
raises loudly instead of pretending to persist alerts.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import statistics
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

from pricing_feeds import (
    FeedUnavailableError,
    MarginPolicyChangeFeed,
    NegotiatedRateChange,
    NegotiatedRateChangeFeed,
    NotImplementedMarginPolicyChangeFeed,
    NotImplementedNegotiatedRateChangeFeed,
    NotImplementedRateRecordFeed,
    RateRecordFeed,
)
from pricing_staleness_alerts import (
    AlertSink,
    AlertSinkUnavailableError,
    NotImplementedAlertSink,
    StalenessAlert,
)

log = logging.getLogger(__name__)

CHICAGO = ZoneInfo("America/Chicago")

TRAILING_WINDOW = timedelta(days=90)
WARN_THRESHOLD = Decimal("0.05")
CRITICAL_THRESHOLD = Decimal("0.10")
ANOMALY_SUPPRESSION_WINDOW = timedelta(days=3)
SLA_LOOKBACK_DAYS = 30
BULK_ESCALATION_THRESHOLD = 5

WARM_UP_START_DATE = date(2026, 7, 7)  # runner go-live; SAG-6327 Phase 4
WARM_UP_DURATION_DAYS = 30

PRICING_LANE_ISSUE_ID = "61fe7650-d932-47cf-ac3c-8989e3b72f57"  # SAG-6327


def _ensure_aware(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def commit_due_at(entered_at: datetime) -> datetime:
    """Next business day, 18:00 America/Chicago, after `entered_at`.

    Naive input is treated as UTC before converting to Chicago local time.
    Weekends are skipped; US holidays are not modeled (known simplification).
    """
    local = _ensure_aware(entered_at).astimezone(CHICAGO)
    next_day = local.date() + timedelta(days=1)
    while next_day.weekday() >= 5:  # Saturday=5, Sunday=6
        next_day += timedelta(days=1)
    return datetime(next_day.year, next_day.month, next_day.day, 18, 0, tzinfo=CHICAGO)


def is_sla_breached(change: NegotiatedRateChange, as_of: datetime) -> bool:
    due = commit_due_at(change.entered_at)
    if change.committed_at is not None:
        return _ensure_aware(change.committed_at) > due
    return _ensure_aware(as_of) > due


def _record_key(record) -> str:
    return f"{record.product_estimate_group}|{record.bucket_code}|{record.territory}"


def _is_anomaly_suppressed(policy_feed: MarginPolicyChangeFeed, latest_imported_at: datetime) -> bool:
    since = latest_imported_at - ANOMALY_SUPPRESSION_WINDOW
    changes = policy_feed.get_changes_since(since)
    return any(c.effective_at <= latest_imported_at for c in changes)


def detect_anomalies(
    rate_feed: RateRecordFeed,
    policy_feed: MarginPolicyChangeFeed,
    as_of: datetime,
    warm_up: bool,
) -> list[StalenessAlert]:
    records = rate_feed.get_active_rate_records(as_of=as_of)
    by_key: dict[tuple, list] = defaultdict(list)
    for record in records:
        by_key[(record.product_estimate_group, record.bucket_code, record.territory)].append(record)

    alerts: list[StalenessAlert] = []
    window_start = as_of - TRAILING_WINDOW
    for key, recs in by_key.items():
        recs_sorted = sorted(recs, key=lambda r: r.imported_at)
        latest = recs_sorted[-1]
        history = [r for r in recs_sorted[:-1] if r.imported_at >= window_start]
        if not history:
            continue
        if _is_anomaly_suppressed(policy_feed, latest.imported_at):
            continue

        for field_name, latest_val in latest.rate_bearing_fields.items():
            hist_vals = [
                r.rate_bearing_fields[field_name]
                for r in history
                if field_name in r.rate_bearing_fields
            ]
            if not hist_vals:
                continue
            median_val = statistics.median(hist_vals)
            if median_val == 0:
                continue
            pct_delta = abs(latest_val - median_val) / median_val
            if pct_delta >= CRITICAL_THRESHOLD:
                severity = "critical"
            elif pct_delta >= WARN_THRESHOLD:
                severity = "warn"
            else:
                continue

            alerts.append(
                StalenessAlert(
                    signal_type="anomaly",
                    severity=severity,
                    record_key=_record_key(latest),
                    detected_at=as_of,
                    warm_up=warm_up,
                    details={
                        "field": field_name,
                        "pct_delta": float(pct_delta),
                        "latest_value": str(latest_val),
                        "median_value": str(median_val),
                        "rate_card_version": latest.rate_card_version,
                    },
                )
            )
    return alerts


def detect_version_hash_drift(
    rate_feed: RateRecordFeed, as_of: datetime, warm_up: bool
) -> list[StalenessAlert]:
    records = rate_feed.get_active_rate_records(as_of=as_of)
    by_key: dict[tuple, list] = defaultdict(list)
    for record in records:
        by_key[(record.product_estimate_group, record.bucket_code, record.territory)].append(record)

    alerts: list[StalenessAlert] = []
    for key, recs in by_key.items():
        recs_sorted = sorted(recs, key=lambda r: r.imported_at)
        for prev, curr in zip(recs_sorted, recs_sorted[1:]):
            if prev.rate_card_version == curr.rate_card_version and prev.content_hash != curr.content_hash:
                alerts.append(
                    StalenessAlert(
                        signal_type="version_hash_drift",
                        severity="critical",
                        record_key=_record_key(curr),
                        detected_at=as_of,
                        warm_up=warm_up,
                        details={
                            "rate_card_version": curr.rate_card_version,
                            "prev_content_hash": prev.content_hash,
                            "curr_content_hash": curr.content_hash,
                            "prev_imported_at": prev.imported_at.isoformat(),
                            "curr_imported_at": curr.imported_at.isoformat(),
                        },
                    )
                )
    return alerts


def detect_sla_breaches(
    change_feed: NegotiatedRateChangeFeed,
    as_of: datetime,
    lookback_days: int,
    warm_up: bool,
) -> list[StalenessAlert]:
    since = as_of - timedelta(days=lookback_days)
    alerts: list[StalenessAlert] = []
    for change in change_feed.get_changes_since(since):
        if not is_sla_breached(change, as_of):
            continue
        alerts.append(
            StalenessAlert(
                signal_type="sla_breach",
                severity="warn",
                record_key=change.record_key,
                detected_at=as_of,
                warm_up=warm_up,
                details={
                    "entered_at": change.entered_at.isoformat(),
                    "committed_at": change.committed_at.isoformat() if change.committed_at else None,
                    "due_at": commit_due_at(change.entered_at).isoformat(),
                    "source": change.source,
                    "reason": change.reason,
                },
            )
        )
    return alerts


def detect_bulk_escalation(
    prior_alerts: list[StalenessAlert], as_of: datetime, warm_up: bool
) -> list[StalenessAlert]:
    if len(prior_alerts) < BULK_ESCALATION_THRESHOLD:
        return []
    return [
        StalenessAlert(
            signal_type="bulk_escalation",
            severity="critical",
            record_key="MULTIPLE",
            detected_at=as_of,
            warm_up=warm_up,
            details={
                "count": len(prior_alerts),
                "affected_keys": sorted({a.record_key for a in prior_alerts}),
                "signal_types": sorted({a.signal_type for a in prior_alerts}),
            },
        )
    ]


def is_warm_up(as_of: datetime, warm_up_start: date = WARM_UP_START_DATE) -> bool:
    return (as_of.date() - warm_up_start).days < WARM_UP_DURATION_DAYS


def run_detection(
    *,
    as_of: datetime,
    rate_feed: RateRecordFeed,
    change_feed: NegotiatedRateChangeFeed,
    policy_feed: MarginPolicyChangeFeed,
    alert_sink: AlertSink,
    warm_up: bool,
) -> list[StalenessAlert]:
    """Run all four signals and write one alert row per detection. Detect-only:
    no enforcement action of any kind is taken here, warm-up or not."""
    alerts: list[StalenessAlert] = []
    alerts += detect_anomalies(rate_feed, policy_feed, as_of, warm_up)
    alerts += detect_version_hash_drift(rate_feed, as_of, warm_up)
    alerts += detect_sla_breaches(change_feed, as_of, SLA_LOOKBACK_DAYS, warm_up)
    alerts += detect_bulk_escalation(alerts, as_of, warm_up)

    for alert in alerts:
        alert_sink.write_alert(alert)

    return alerts


# ---------------------------------------------------------------------------
# Digest posting (nightly digest comment to the pricing lane)
# ---------------------------------------------------------------------------


def format_digest(alerts: list[StalenessAlert], as_of: datetime, warm_up: bool) -> str:
    if not alerts:
        mode = "warm-up (observe-only)" if warm_up else "enforced"
        return f"## Pricing Staleness Detection — {as_of.date().isoformat()} ({mode})\n\nNo alerts."

    by_signal: dict[str, int] = defaultdict(int)
    for a in alerts:
        by_signal[a.signal_type] += 1
    mode = "warm-up (observe-only, zero enforcement)" if warm_up else "enforced"
    lines = [
        f"## Pricing Staleness Detection — {as_of.date().isoformat()} ({mode})",
        "",
        f"**{len(alerts)}** alert(s) this run:",
    ]
    for signal_type, count in sorted(by_signal.items()):
        lines.append(f"- `{signal_type}`: {count}")
    return "\n".join(lines)


def post_digest_comment(body: str, issue_id: str = PRICING_LANE_ISSUE_ID) -> None:
    api_url = os.environ.get("PAPERCLIP_API_URL", "http://127.0.0.1:3100")
    api_key = os.environ.get("PAPERCLIP_API_KEY", "")
    if not api_key:
        log.warning("PAPERCLIP_API_KEY not set; skipping digest post.")
        return
    run_id = os.environ.get("PAPERCLIP_RUN_ID", "")
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    if run_id:
        headers["X-Paperclip-Run-Id"] = run_id
    req = urllib.request.Request(
        f"{api_url}/api/issues/{issue_id}/comments",
        data=json.dumps({"body": body}).encode(),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp.read()
    except urllib.error.URLError as e:
        log.warning("Failed to post digest comment: %s", e)


# ---------------------------------------------------------------------------
# CLI entrypoint
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [pricing-staleness] %(message)s")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--use-fakes",
        action="store_true",
        help="Run against empty in-memory fakes (local dev/demo only).",
    )
    parser.add_argument("--no-post", action="store_true", help="Do not post the digest comment.")
    args = parser.parse_args(argv)

    as_of = datetime.now(timezone.utc)
    warm_up = is_warm_up(as_of)
    dsn = os.environ.get("PRICING_STALENESS_DB_DSN", "")

    if args.use_fakes:
        from pricing_feeds import FakeMarginPolicyChangeFeed, FakeNegotiatedRateChangeFeed, FakeRateRecordFeed
        from pricing_staleness_alerts import InMemoryAlertSink

        rate_feed = FakeRateRecordFeed()
        change_feed = FakeNegotiatedRateChangeFeed()
        policy_feed = FakeMarginPolicyChangeFeed()
        alert_sink = InMemoryAlertSink()
    else:
        # Rate-record/change/policy feeds still have no physical store (SAG-6341
        # pending, blocks SAG-6343's Phase 2 real adapters) -- always
        # NotImplemented outside --use-fakes. The alert sink, however, is real
        # once a DSN is configured, since Phase 1 (the table) has landed.
        rate_feed = NotImplementedRateRecordFeed()
        change_feed = NotImplementedNegotiatedRateChangeFeed()
        policy_feed = NotImplementedMarginPolicyChangeFeed()
        if dsn:
            from pricing_staleness_alerts import PostgresAlertSink

            alert_sink = PostgresAlertSink(dsn=dsn)
        else:
            alert_sink = NotImplementedAlertSink()

    try:
        alerts = run_detection(
            as_of=as_of,
            rate_feed=rate_feed,
            change_feed=change_feed,
            policy_feed=policy_feed,
            alert_sink=alert_sink,
            warm_up=warm_up,
        )
    except (FeedUnavailableError, AlertSinkUnavailableError) as e:
        log.info(
            "Pricing staleness runner not yet wired to production (%s). "
            "This is an expected pending-dependency state (SAG-6341/SAG-6343 rate "
            "feeds still pending) -- skipping this run without failing nightly_eval.",
            e,
        )
        return 0
    finally:
        if hasattr(alert_sink, "close"):
            alert_sink.close()

    log.info("Detection complete: %d alert(s), warm_up=%s", len(alerts), warm_up)

    if not args.no_post:
        post_digest_comment(format_digest(alerts, as_of, warm_up))

    return 0


if __name__ == "__main__":
    sys.exit(main())
