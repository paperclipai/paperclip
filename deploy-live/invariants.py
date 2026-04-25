"""Self-consistency invariants over state_store.

Each invariant is a pure function: takes a sqlite3.Connection, returns a
list[Violation]. Callers run check_all() periodically and turn each
Violation into a reconciliation_event row.

The 12 invariants are derived from real production bugs in the live trader.
See docs/superpowers/specs/2026-04-25-live-trader-data-reliability-design.md
for the rationale of each.
"""
from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Violation:
    category: str
    severity: str  # "info" | "warn" | "error" | "critical"
    position_id: Optional[int] = None
    exchange: Optional[str] = None
    symbol: Optional[str] = None
    notes: str = ""
    expected: dict = field(default_factory=dict)
    actual: dict = field(default_factory=dict)


_OPEN_LIKE_STATUSES = ("opening", "open", "closing", "degraded")


def check_all(conn: sqlite3.Connection) -> list[Violation]:
    """Run every invariant. Returns the union of all Violations found."""
    out: list[Violation] = []
    out += _check_open_position_legs(conn)
    out += _check_closed_position_legs(conn)
    out += _check_fill_quality(conn)
    return out


def _check_open_position_legs(conn: sqlite3.Connection) -> list[Violation]:
    """Invariant 1 + 2 (open part): every open-status position has exactly 2 entry fills."""
    placeholders = ",".join("?" * len(_OPEN_LIKE_STATUSES))
    rows = conn.execute(
        f"""SELECT p.id, p.symbol,
                   COALESCE(SUM(CASE WHEN f.intent='entry' THEN 1 ELSE 0 END), 0) AS n_entry
            FROM positions p
            LEFT JOIN fills f ON f.position_id = p.id
            WHERE p.status IN ({placeholders})
            GROUP BY p.id""",
        _OPEN_LIKE_STATUSES,
    ).fetchall()
    out = []
    for r in rows:
        if r["n_entry"] != 2:
            out.append(Violation(
                category="open_position_missing_legs",
                severity="error",
                position_id=r["id"],
                symbol=r["symbol"],
                expected={"entry_fills": 2},
                actual={"entry_fills": r["n_entry"]},
            ))
    return out


def _check_closed_position_legs(conn: sqlite3.Connection) -> list[Violation]:
    """Invariant 2 (closed part): every closed position has 2 entry + 2 exit fills."""
    rows = conn.execute(
        """SELECT p.id, p.symbol,
                  COALESCE(SUM(CASE WHEN f.intent='entry' THEN 1 ELSE 0 END), 0) AS n_entry,
                  COALESCE(SUM(CASE WHEN f.intent='exit' THEN 1 ELSE 0 END), 0) AS n_exit
           FROM positions p
           LEFT JOIN fills f ON f.position_id = p.id
           WHERE p.status = 'closed'
           GROUP BY p.id"""
    ).fetchall()
    out = []
    for r in rows:
        if r["n_entry"] != 2 or r["n_exit"] != 2:
            out.append(Violation(
                category="closed_position_missing_exit_fills",
                severity="error",
                position_id=r["id"],
                symbol=r["symbol"],
                expected={"entry_fills": 2, "exit_fills": 2},
                actual={"entry_fills": r["n_entry"], "exit_fills": r["n_exit"]},
            ))
    return out


def _check_fill_quality(conn: sqlite3.Connection) -> list[Violation]:
    """Invariant 3: defensive scan against CHECK-bypass scenarios."""
    rows = conn.execute(
        "SELECT id, position_id, fill_price, size_usd FROM fills "
        "WHERE fill_price <= 0 OR size_usd <= 0"
    ).fetchall()
    out = []
    for r in rows:
        out.append(Violation(
            category="fill_quality",
            severity="critical",
            position_id=r["position_id"],
            notes=f"fill #{r['id']} has fill_price={r['fill_price']} size_usd={r['size_usd']}",
        ))
    return out
