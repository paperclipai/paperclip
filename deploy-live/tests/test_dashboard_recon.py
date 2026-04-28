"""Tests for dashboard_recon blueprint (Task 14).

Covers:
  14.1a  /recon/events returns paginated event list with severity filter
  14.1b  /recon/invariants returns 12 invariants with green/red status
  14.1c  Friendly empty state when USE_SQLITE_STATE=false OR state.db missing
"""
from __future__ import annotations

import os
import time
import tempfile

import pytest

import state_store as _ss
from dashboard import app
import dashboard_recon as _dr


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def client():
    """Flask test client with auth bypassed via DASHBOARD_PASSWORD env."""
    app.config["TESTING"] = True
    with app.test_client() as c:
        # Supply basic auth expected by check_auth
        c.environ_base["HTTP_AUTHORIZATION"] = "Basic Y2hhbmdlbWU6Y2hhbmdlbWU="  # changeme:changeme
        yield c


@pytest.fixture()
def sqlite_db(tmp_path):
    """Fresh SQLite DB path with schema initialised."""
    path = str(tmp_path / "state.db")
    _ss.init_schema(path)
    return path


@pytest.fixture(autouse=True)
def _reset_dr_env(monkeypatch, tmp_path):
    """Reset dashboard_recon module-level env state after each test."""
    yield
    # After the test, reset to a safe default so other tests are unaffected.
    monkeypatch.setenv("USE_SQLITE_STATE", "false")


# ---------------------------------------------------------------------------
# Helper: seed a recon event into a DB
# ---------------------------------------------------------------------------

def _seed_event(path: str, **kwargs):
    conn = _ss.open_db(path)
    defaults = dict(
        timestamp_ms=int(time.time() * 1000),
        source="invariants",
        category="fill_quality",
        severity="error",
    )
    defaults.update(kwargs)
    _ss.write_recon_event(conn, **defaults)
    conn.close()


# ---------------------------------------------------------------------------
# 14.1c  Friendly empty state -- USE_SQLITE_STATE=false
# ---------------------------------------------------------------------------

class TestEmptyStateNoSQLite:
    def test_events_no_sqlite_returns_empty(self, client, monkeypatch):
        monkeypatch.setattr(_dr, "_USE_SQLITE", False)
        r = client.get("/recon/events")
        assert r.status_code == 200
        d = r.get_json()
        assert d["events"] == []
        assert d["total"] == 0
        assert "message" in d
        assert "SQLite" in d["message"] or "not configured" in d["message"]

    def test_invariants_no_sqlite_returns_unknown(self, client, monkeypatch):
        monkeypatch.setattr(_dr, "_USE_SQLITE", False)
        r = client.get("/recon/invariants")
        assert r.status_code == 200
        d = r.get_json()
        assert len(d["invariants"]) == 13
        assert all(iv["status"] == "unknown" for iv in d["invariants"])

    def test_events_db_missing_returns_empty(self, client, monkeypatch):
        monkeypatch.setattr(_dr, "_USE_SQLITE", True)
        monkeypatch.setattr(_dr, "_DB_PATH", "/nonexistent/path/state.db")
        r = client.get("/recon/events")
        assert r.status_code == 200
        d = r.get_json()
        assert d["events"] == []
        assert "message" in d

    def test_invariants_db_missing_returns_unknown(self, client, monkeypatch):
        monkeypatch.setattr(_dr, "_USE_SQLITE", True)
        monkeypatch.setattr(_dr, "_DB_PATH", "/nonexistent/path/state.db")
        r = client.get("/recon/invariants")
        assert r.status_code == 200
        d = r.get_json()
        assert len(d["invariants"]) == 13
        assert all(iv["status"] == "unknown" for iv in d["invariants"])


# ---------------------------------------------------------------------------
# 14.1a  /recon/events -- paginated event list with severity filter
# ---------------------------------------------------------------------------

class TestEventsRoute:
    def test_returns_all_events(self, client, monkeypatch, sqlite_db):
        monkeypatch.setattr(_dr, "_USE_SQLITE", True)
        monkeypatch.setattr(_dr, "_DB_PATH", sqlite_db)

        _seed_event(sqlite_db, severity="error")
        _seed_event(sqlite_db, severity="warn", category="aged_open_position")
        _seed_event(sqlite_db, severity="info", category="stale_ok_exchange_health")

        r = client.get("/recon/events")
        assert r.status_code == 200
        d = r.get_json()
        assert d["total"] == 3
        assert len(d["events"]) == 3

    def test_severity_filter_error_excludes_warn_info(self, client, monkeypatch, sqlite_db):
        monkeypatch.setattr(_dr, "_USE_SQLITE", True)
        monkeypatch.setattr(_dr, "_DB_PATH", sqlite_db)

        _seed_event(sqlite_db, severity="error")
        _seed_event(sqlite_db, severity="warn", category="aged_open_position")
        _seed_event(sqlite_db, severity="info", category="stale_ok_exchange_health")

        r = client.get("/recon/events?severity=error")
        assert r.status_code == 200
        d = r.get_json()
        # error and critical only
        assert d["total"] == 1
        assert d["events"][0]["severity"] == "error"

    def test_severity_filter_warn_excludes_info(self, client, monkeypatch, sqlite_db):
        monkeypatch.setattr(_dr, "_USE_SQLITE", True)
        monkeypatch.setattr(_dr, "_DB_PATH", sqlite_db)

        _seed_event(sqlite_db, severity="warn", category="aged_open_position")
        _seed_event(sqlite_db, severity="info", category="stale_ok_exchange_health")

        r = client.get("/recon/events?severity=warn")
        d = r.get_json()
        assert d["total"] == 1
        assert d["events"][0]["severity"] == "warn"

    def test_pagination_page_size(self, client, monkeypatch, sqlite_db):
        monkeypatch.setattr(_dr, "_USE_SQLITE", True)
        monkeypatch.setattr(_dr, "_DB_PATH", sqlite_db)

        # Unique key includes exchange -- vary it to avoid the unresolved constraint
        for i in range(5):
            _seed_event(sqlite_db, severity="info", category="fill_quality",
                        exchange=f"EXCH_{i}", notes=f"event {i}")

        r = client.get("/recon/events?page_size=3&page=1")
        d = r.get_json()
        assert len(d["events"]) == 3
        assert d["total"] == 5
        assert d["page"] == 1
        assert d["page_size"] == 3

    def test_pagination_page_2(self, client, monkeypatch, sqlite_db):
        monkeypatch.setattr(_dr, "_USE_SQLITE", True)
        monkeypatch.setattr(_dr, "_DB_PATH", sqlite_db)

        for i in range(5):
            _seed_event(sqlite_db, severity="info", category="fill_quality",
                        exchange=f"EXCH_{i}", notes=f"event {i}")

        r = client.get("/recon/events?page_size=3&page=2")
        d = r.get_json()
        assert len(d["events"]) == 2  # remaining 2 on page 2

    def test_invalid_severity_falls_back_to_all(self, client, monkeypatch, sqlite_db):
        monkeypatch.setattr(_dr, "_USE_SQLITE", True)
        monkeypatch.setattr(_dr, "_DB_PATH", sqlite_db)

        _seed_event(sqlite_db, severity="error")
        _seed_event(sqlite_db, severity="info", category="aged_open_position")

        # 'DROP TABLE' is invalid; should be treated as no filter (all)
        r = client.get("/recon/events?severity=DROP+TABLE")
        d = r.get_json()
        assert d["total"] == 2  # invalid severity ignored -> returns all

    def test_event_dict_has_required_fields(self, client, monkeypatch, sqlite_db):
        monkeypatch.setattr(_dr, "_USE_SQLITE", True)
        monkeypatch.setattr(_dr, "_DB_PATH", sqlite_db)

        _seed_event(sqlite_db, severity="error", exchange="MEXC", symbol="ORDIUSDT")

        r = client.get("/recon/events")
        d = r.get_json()
        ev = d["events"][0]
        for field in ("id", "timestamp_ms", "source", "category", "severity",
                      "exchange", "symbol", "resolution", "repeat_count"):
            assert field in ev, f"Missing field: {field}"


# ---------------------------------------------------------------------------
# 14.1b  /recon/invariants -- 13 invariants with green/red status
# (Invariant 13 negative_realized_entry_spread added in commit
# following 72ee1bbb's runtime guard.)
# ---------------------------------------------------------------------------

class TestInvariantsRoute:
    def test_returns_exactly_13_invariants(self, client, monkeypatch, sqlite_db):
        monkeypatch.setattr(_dr, "_USE_SQLITE", True)
        monkeypatch.setattr(_dr, "_DB_PATH", sqlite_db)

        r = client.get("/recon/invariants")
        assert r.status_code == 200
        d = r.get_json()
        assert len(d["invariants"]) == 13

    def test_all_green_when_no_unresolved_events(self, client, monkeypatch, sqlite_db):
        monkeypatch.setattr(_dr, "_USE_SQLITE", True)
        monkeypatch.setattr(_dr, "_DB_PATH", sqlite_db)

        r = client.get("/recon/invariants")
        d = r.get_json()
        assert all(iv["status"] == "green" for iv in d["invariants"])

    def test_red_for_category_with_recent_unresolved_event(
        self, client, monkeypatch, sqlite_db
    ):
        monkeypatch.setattr(_dr, "_USE_SQLITE", True)
        monkeypatch.setattr(_dr, "_DB_PATH", sqlite_db)

        now_ms = int(time.time() * 1000)
        _seed_event(sqlite_db, severity="error", category="fill_quality",
                    timestamp_ms=now_ms)

        # Manually set last_seen_ms so it's fresh
        conn = _ss.open_db(sqlite_db)
        conn.execute(
            "UPDATE reconciliation_events SET last_seen_ms=? WHERE category='fill_quality'",
            (now_ms,)
        )
        conn.close()

        r = client.get("/recon/invariants")
        d = r.get_json()

        by_cat = {iv["category"]: iv["status"] for iv in d["invariants"]}
        assert by_cat["fill_quality"] == "red"

    def test_green_for_category_with_only_stale_event(
        self, client, monkeypatch, sqlite_db
    ):
        monkeypatch.setattr(_dr, "_USE_SQLITE", True)
        monkeypatch.setattr(_dr, "_DB_PATH", sqlite_db)

        old_ms = int(time.time() * 1000) - (10 * 60 * 1000)  # 10 min ago
        _seed_event(sqlite_db, severity="error", category="fill_quality",
                    timestamp_ms=old_ms)

        conn = _ss.open_db(sqlite_db)
        conn.execute(
            "UPDATE reconciliation_events SET last_seen_ms=? WHERE category='fill_quality'",
            (old_ms,)
        )
        conn.close()

        r = client.get("/recon/invariants")
        d = r.get_json()
        by_cat = {iv["category"]: iv["status"] for iv in d["invariants"]}
        assert by_cat["fill_quality"] == "green"

    def test_invariant_categories_match_module(self, client, monkeypatch, sqlite_db):
        """All 13 categories in the response must match _INVARIANT_CATEGORIES."""
        monkeypatch.setattr(_dr, "_USE_SQLITE", True)
        monkeypatch.setattr(_dr, "_DB_PATH", sqlite_db)

        r = client.get("/recon/invariants")
        d = r.get_json()
        response_cats = {iv["category"] for iv in d["invariants"]}
        assert response_cats == set(_dr._INVARIANT_CATEGORIES)

    def test_resolved_event_does_not_make_category_red(
        self, client, monkeypatch, sqlite_db
    ):
        monkeypatch.setattr(_dr, "_USE_SQLITE", True)
        monkeypatch.setattr(_dr, "_DB_PATH", sqlite_db)

        now_ms = int(time.time() * 1000)
        _seed_event(sqlite_db, severity="error", category="fill_quality",
                    timestamp_ms=now_ms)

        conn = _ss.open_db(sqlite_db)
        conn.execute(
            "UPDATE reconciliation_events SET last_seen_ms=?, resolution='manual'"
            " WHERE category='fill_quality'",
            (now_ms,)
        )
        conn.close()

        r = client.get("/recon/invariants")
        d = r.get_json()
        by_cat = {iv["category"]: iv["status"] for iv in d["invariants"]}
        assert by_cat["fill_quality"] == "green"


# ---------------------------------------------------------------------------
# Panel HTML route
# ---------------------------------------------------------------------------

class TestPanelRoute:
    def test_panel_returns_html(self, client, monkeypatch):
        monkeypatch.setattr(_dr, "_USE_SQLITE", False)
        r = client.get("/recon/")
        assert r.status_code == 200
        data = r.data.decode()
        assert "Recon Panel" in data
        assert "Main Dashboard" in data


# ---------------------------------------------------------------------------
# Meta-test: _INVARIANT_CATEGORIES stays in sync with invariants.py
# ---------------------------------------------------------------------------

def test_invariant_categories_match_invariants_module_source(monkeypatch):
    """Regression guard: if invariants.py adds/removes a Violation category,
    dashboard_recon._INVARIANT_CATEGORIES must be updated. This test extracts
    category strings from invariants.py source and asserts the set matches."""
    import re, inspect, dashboard_recon as _dr
    import invariants as _inv

    src = inspect.getsource(_inv)
    # Find every category="..." literal in Violation construction.
    matches = set(re.findall(r'category=[\'"]([\w_]+)[\'"]', src))
    # Note: this captures all Violation literals — both check_all and
    # check_inmem_consistency emit categories.

    registry_set = set(_dr._INVARIANT_CATEGORIES)

    # Allow categories in source that aren't yet in the registry to fail loudly.
    missing_in_registry = matches - registry_set
    assert not missing_in_registry, (
        f"Categories in invariants.py not registered in dashboard_recon: "
        f"{missing_in_registry}. Add them to _INVARIANT_CATEGORIES."
    )

    # Also fail if registry has categories no longer in invariants.py.
    extra_in_registry = registry_set - matches
    # Allow this set to be empty for now; if test reports extras, prune them.
    assert not extra_in_registry, (
        f"Categories in dashboard_recon not present in invariants.py: "
        f"{extra_in_registry}. Remove from _INVARIANT_CATEGORIES."
    )


# ---------------------------------------------------------------------------
# _data_source selector (14.4)
# ---------------------------------------------------------------------------

class TestDataSourceSelector:
    def test_returns_file_when_sqlite_disabled(self, monkeypatch):
        import dashboard as _dash
        monkeypatch.setattr(_dash, "USE_SQLITE_STATE", False)
        assert _dash._data_source() == "file"

    def test_returns_file_when_db_missing(self, monkeypatch, tmp_path):
        import dashboard as _dash
        monkeypatch.setattr(_dash, "USE_SQLITE_STATE", True)
        monkeypatch.setattr(_dash, "STATE_DB_PATH", str(tmp_path / "nonexistent.db"))
        assert _dash._data_source() == "file"

    def test_returns_sqlite_when_enabled_and_db_exists(self, monkeypatch, sqlite_db):
        import dashboard as _dash
        monkeypatch.setattr(_dash, "USE_SQLITE_STATE", True)
        monkeypatch.setattr(_dash, "STATE_DB_PATH", sqlite_db)
        assert _dash._data_source() == "sqlite"
