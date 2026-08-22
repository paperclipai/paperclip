from datetime import datetime
from unittest.mock import MagicMock

import pytest

import pricing_staleness_alerts
from pricing_staleness_alerts import (
    AlertSinkUnavailableError,
    InMemoryAlertSink,
    NotImplementedAlertSink,
    PostgresAlertSink,
    StalenessAlert,
    alert_to_row,
)

NOW = datetime(2026, 7, 7, 12, 0, 0)

ALL_SIGNAL_TYPES = ["anomaly", "version_hash_drift", "sla_breach", "bulk_escalation"]
ALL_SEVERITIES = ["warn", "critical"]


def _alert(**overrides) -> StalenessAlert:
    defaults = dict(
        signal_type="anomaly",
        severity="warn",
        record_key="FG3|FQ3-A|TX",
        detected_at=NOW,
        warm_up=True,
        details={"pct_delta": 0.06},
    )
    defaults.update(overrides)
    return StalenessAlert(**defaults)


class TestNotImplementedAlertSink:
    def test_write_alert_raises_sink_unavailable(self):
        with pytest.raises(AlertSinkUnavailableError, match="PRICING_STALENESS_DB_DSN"):
            NotImplementedAlertSink().write_alert(_alert())


class TestInMemoryAlertSink:
    def test_write_alert_appends_and_assigns_id(self):
        sink = InMemoryAlertSink()

        sink.write_alert(_alert())
        sink.write_alert(_alert(signal_type="sla_breach"))

        assert len(sink.alerts) == 2
        assert sink.alerts[0].signal_type == "anomaly"
        assert sink.alerts[1].signal_type == "sla_breach"
        assert sink.alerts[0].id is not None
        assert sink.alerts[0].id != sink.alerts[1].id


# ---------------------------------------------------------------------------
# alert_to_row: the table's grain matches the runner's StalenessAlert shape
# 1:1 (SAG-6353), so this is a direct field-for-field mapping onto the
# `pricing_staleness_alerts` columns -- no splitting or enum translation.
# ---------------------------------------------------------------------------


class TestAlertToRow:
    @pytest.mark.parametrize("signal_type", ALL_SIGNAL_TYPES)
    @pytest.mark.parametrize("severity", ALL_SEVERITIES)
    def test_maps_fields_directly_onto_table_columns(self, signal_type, severity):
        alert = _alert(
            signal_type=signal_type,
            severity=severity,
            record_key="FG3|FQ3-A|TX",
            warm_up=False,
            details={"pct_delta": 0.06},
        )

        row = alert_to_row(alert)

        assert row["signal_type"] == signal_type
        assert row["severity"] == severity
        assert row["record_key"] == "FG3|FQ3-A|TX"
        assert row["detected_at"] == NOW
        assert row["warm_up"] is False
        assert row["details_json"].adapted == {"pct_delta": 0.06}

    def test_details_json_wraps_arbitrary_evidence_dict(self):
        alert = _alert(details={"count": 5, "affected_keys": ["MULTIPLE"], "signal_types": ["anomaly"]})

        row = alert_to_row(alert)

        assert row["details_json"].adapted == {
            "count": 5,
            "affected_keys": ["MULTIPLE"],
            "signal_types": ["anomaly"],
        }


# ---------------------------------------------------------------------------
# PostgresAlertSink: verified against a mocked psycopg2 connection (no live
# DB in this environment -- see migrations/README.md "Which Postgres
# instance: TBD").
# ---------------------------------------------------------------------------


class TestPostgresAlertSink:
    @pytest.mark.parametrize("signal_type", ALL_SIGNAL_TYPES)
    @pytest.mark.parametrize("severity", ALL_SEVERITIES)
    def test_write_alert_inserts_new_grain_for_every_signal_type_and_severity(
        self, monkeypatch, signal_type, severity
    ):
        fake_cursor = MagicMock()
        fake_cursor.__enter__.return_value = fake_cursor
        fake_conn = MagicMock()
        fake_conn.cursor.return_value = fake_cursor
        monkeypatch.setattr(pricing_staleness_alerts.psycopg2, "connect", lambda dsn: fake_conn)

        sink = PostgresAlertSink(dsn="postgresql://pricing_staleness_writer@localhost/db")
        sink.write_alert(_alert(signal_type=signal_type, severity=severity))

        assert fake_conn.autocommit is True
        assert fake_cursor.execute.called
        sql, params = fake_cursor.execute.call_args.args
        assert "enrichment_staging.pricing_staleness_alerts" in sql
        assert "record_key" in sql
        assert "warm_up" in sql
        assert "details_json" in sql
        assert params["signal_type"] == signal_type
        assert params["severity"] == severity
        assert params["record_key"] == "FG3|FQ3-A|TX"
        assert params["detected_at"] == NOW
        assert params["warm_up"] is True
        assert params["details_json"].adapted == {"pct_delta": 0.06}

    def test_close_closes_connection(self, monkeypatch):
        fake_conn = MagicMock()
        monkeypatch.setattr(pricing_staleness_alerts.psycopg2, "connect", lambda dsn: fake_conn)

        sink = PostgresAlertSink(dsn="postgresql://pricing_staleness_writer@localhost/db")
        sink.close()

        fake_conn.close.assert_called_once()
