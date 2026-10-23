"""Alert-sink contract for the pricing staleness-detection runner (SAG-6344).

The `enrichment_staging.pricing_staleness_alerts` append-only table (SAG-6327
Phase 1) landed in migration `003_pricing_staleness_alerts_up.sql` and was
reconciled in SAG-6353 to the runner's own `StalenessAlert` shape: the table's
`signal_type`/`severity` CHECK constraints use exactly the strings the runner
emits (`anomaly`/`version_hash_drift`/`sla_breach`/`bulk_escalation`,
`warn`/`critical`), and its columns are `record_key`, `detected_at`,
`warm_up`, and a `details_json` JSONB blob for signal-specific evidence. The
table and the runner now share the same grain, so `alert_to_row()` is a
direct field-for-field mapping onto the table's columns -- no splitting or
translation required.

Per the epic's established loud-fail pattern (see pricing_feeds.py Phase 0),
`NotImplementedAlertSink` raises rather than silently dropping alerts on the
floor -- used only if a caller constructs the runner without a DSN and
without opting into the in-memory fakes.
"""

from __future__ import annotations

import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional

import psycopg2
import psycopg2.extras


class AlertSinkUnavailableError(RuntimeError):
    """Raised when the real alert sink is queried before its physical table exists.

    Callers must handle this by escalating, not by treating it as "alert written."
    """


@dataclass(frozen=True)
class StalenessAlert:
    """One detection event, in the detection runner's own working shape.

    `record_key` identifies the affected rate record or negotiated-rate change
    (e.g. "product_estimate_group|bucket_code|territory" for `RateRecord`-derived
    signals, or an opaque feed-supplied key for change-feed-derived signals).
    `details` carries signal-specific evidence (pct_delta, versions, due/committed
    timestamps, etc.) and is persisted verbatim in the `details_json` column.
    """

    signal_type: str
    severity: str
    record_key: str
    detected_at: datetime
    warm_up: bool
    details: dict[str, Any]
    id: Optional[str] = None


def alert_to_row(alert: StalenessAlert) -> dict[str, Any]:
    """Map a `StalenessAlert` onto the exact column set of
    `enrichment_staging.pricing_staleness_alerts` (migration 003, SAG-6353)."""
    return {
        "signal_type": alert.signal_type,
        "severity": alert.severity,
        "record_key": alert.record_key,
        "detected_at": alert.detected_at,
        "warm_up": alert.warm_up,
        "details_json": psycopg2.extras.Json(alert.details),
    }


class AlertSink(ABC):
    @abstractmethod
    def write_alert(self, alert: StalenessAlert) -> None:
        """Persist one alert. Must raise rather than silently drop on failure."""


class NotImplementedAlertSink(AlertSink):
    def write_alert(self, alert: StalenessAlert) -> None:
        raise AlertSinkUnavailableError(
            "No pricing-staleness DB DSN configured (PRICING_STALENESS_DB_DSN unset) "
            "and --use-fakes not passed; refusing to silently drop this alert."
        )


@dataclass
class InMemoryAlertSink(AlertSink):
    """In-memory sink for detection-runner development/tests (SAG-6344)."""

    alerts: list[StalenessAlert] = field(default_factory=list)

    def write_alert(self, alert: StalenessAlert) -> None:
        if alert.id is None:
            alert = StalenessAlert(
                signal_type=alert.signal_type,
                severity=alert.severity,
                record_key=alert.record_key,
                detected_at=alert.detected_at,
                warm_up=alert.warm_up,
                details=alert.details,
                id=str(uuid.uuid4()),
            )
        self.alerts.append(alert)


class PostgresAlertSink(AlertSink):
    """Writes alerts into `enrichment_staging.pricing_staleness_alerts` (migration 003).

    Expects a DSN authenticating as the `pricing_staleness_writer` role
    (SELECT+INSERT only; append-only, no UPDATE/DELETE granted -- see
    migrations/README.md). One connection is opened at construction and
    reused for the life of the sink (one nightly run = one connection).
    """

    def __init__(self, dsn: str):
        self._conn = psycopg2.connect(dsn)
        self._conn.autocommit = True

    def write_alert(self, alert: StalenessAlert) -> None:
        row = alert_to_row(alert)
        with self._conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO enrichment_staging.pricing_staleness_alerts
                    (signal_type, severity, record_key, detected_at, warm_up, details_json)
                VALUES
                    (%(signal_type)s, %(severity)s, %(record_key)s, %(detected_at)s, %(warm_up)s, %(details_json)s)
                """,
                row,
            )

    def close(self) -> None:
        self._conn.close()
