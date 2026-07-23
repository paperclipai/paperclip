"""Replay-test runner for golden fixtures.

A fixture is a directory containing:
  - scenario.md             (English description)
  - exchange_responses.jsonl (one record per line; see format below)
  - expected_events.json    (list of {category, severity} dicts)
  - expected_invariants.json (list of category strings)

Each line of exchange_responses.jsonl is a JSON object describing one
reconciliation tick:
  {
    "exchange": "MEXC",
    "open_positions": [...],
    "recent_fills": [...],
    "balance": {"available_usd": ..., "locked_usd": ...},
    "unreachable": "error message"  # optional; if present, marks unreachable
  }

Pre-state for state_store can be set via an optional `state_seed.json` file
in the fixture directory.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from state_store import (
    open_db, init_schema, insert_position, insert_fill,
    list_unresolved_recon_events,
)
from reconciler import reconcile_exchange, FakeExchange
from invariants import check_all


def discover_fixtures(root: Path) -> list[Path]:
    return sorted(p for p in root.iterdir() if p.is_dir())


def run_fixture(fixture_dir: Path, db_path: Path) -> dict[str, list]:
    """Drive the reconciler + invariants through a fixture.

    Returns a dict with:
      - 'events': list of {category, severity} dicts from reconciliation_events
      - 'invariant_violations': list of category strings from check_all
    """
    init_schema(db_path)
    conn = open_db(db_path)
    try:
        # Optional state seed
        seed_path = fixture_dir / "state_seed.json"
        if seed_path.exists():
            with open(seed_path) as f:
                seed = json.load(f)
            for p in seed.get("positions", []):
                pid = insert_position(
                    conn, symbol=p["symbol"],
                    exchange_a=p["exchange_a"], exchange_b=p["exchange_b"],
                    side_a=p["side_a"], side_b=p["side_b"],
                    size_usd_a=p["size_usd_a"], size_usd_b=p["size_usd_b"],
                    entry_spread_pct=p.get("entry_spread_pct", 0.0),
                    status=p["status"], opened_at_ms=p["opened_at_ms"],
                )
                for f_ in p.get("fills", []):
                    insert_fill(
                        conn, position_id=pid,
                        exchange=f_["exchange"], leg=f_["leg"],
                        intent=f_["intent"], order_id=f_["order_id"],
                        side=f_["side"], size_usd=f_["size_usd"],
                        fill_price=f_["fill_price"], fees_usd=f_["fees_usd"],
                        filled_at_ms=f_["filled_at_ms"],
                        raw_response=f_.get("raw_response", "{}"),
                    )

        # Replay reconciliation ticks
        responses_path = fixture_dir / "exchange_responses.jsonl"
        with open(responses_path) as f:
            for line in f:
                tick = json.loads(line)
                fake = FakeExchange()
                ex = tick["exchange"]
                if "unreachable" in tick:
                    fake.set_unreachable(ex, error=tick["unreachable"])
                else:
                    fake.set_open_positions(ex, tick.get("open_positions", []))
                    fake.set_recent_fills(ex, tick.get("recent_fills", []))
                    bal = tick.get("balance", {"available_usd": 0.0, "locked_usd": 0.0})
                    fake.set_balance(ex, available_usd=bal["available_usd"],
                                     locked_usd=bal.get("locked_usd", 0.0))
                reconcile_exchange(conn, fake, exchange=ex, since_ms=0)

        # Capture results
        events = [
            {"category": e.category, "severity": e.severity}
            for e in list_unresolved_recon_events(conn)
        ]
        violations = [v.category for v in check_all(conn)]
        return {"events": events, "invariant_violations": violations}
    finally:
        conn.close()


def assert_expected(fixture_dir: Path, actual: dict[str, list]) -> None:
    """Compare actual results against the fixture's expected_*.json files."""
    expected_events_path = fixture_dir / "expected_events.json"
    expected_invariants_path = fixture_dir / "expected_invariants.json"

    if expected_events_path.exists():
        with open(expected_events_path) as f:
            expected_events = json.load(f)
        actual_keys = sorted([(e["category"], e["severity"]) for e in actual["events"]])
        expected_keys = sorted([(e["category"], e["severity"]) for e in expected_events])
        assert actual_keys == expected_keys, (
            f"\nExpected events: {expected_keys}\nActual events:   {actual_keys}"
        )

    if expected_invariants_path.exists():
        with open(expected_invariants_path) as f:
            expected_invariants = json.load(f)
        actual_inv = sorted(actual["invariant_violations"])
        expected_inv = sorted(expected_invariants)
        assert actual_inv == expected_inv, (
            f"\nExpected invariants: {expected_inv}\nActual invariants:   {actual_inv}"
        )
