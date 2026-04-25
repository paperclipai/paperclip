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

_MAX_HOLD_MINUTES = 30  # from live trader EU config
_MAX_HOLD_GRACE_MINUTES = 5  # invariant fires at max_hold + grace
_TRANSITION_TIMEOUT_S = 60  # opening/closing should not exceed this


def check_all(conn: sqlite3.Connection) -> list[Violation]:
    """Run every invariant. Returns the union of all Violations found."""
    out: list[Violation] = []
    out += _check_open_position_legs(conn)
    out += _check_closed_position_legs(conn)
    out += _check_fill_quality(conn)
    out += _check_overlapping_open_positions(conn)
    out += _check_aged_open_positions(conn)
    out += _check_stuck_transitions(conn)
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


def _check_overlapping_open_positions(conn: sqlite3.Connection) -> list[Violation]:
    """Invariant 4: no two open positions share (symbol, exchange, side)."""
    placeholders = ",".join("?" * len(_OPEN_LIKE_STATUSES))
    rows = conn.execute(
        f"""WITH legs AS (
            SELECT id AS pid, symbol, exchange_a AS exchange, side_a AS side
            FROM positions WHERE status IN ({placeholders})
            UNION ALL
            SELECT id AS pid, symbol, exchange_b AS exchange, side_b AS side
            FROM positions WHERE status IN ({placeholders})
        )
        SELECT symbol, exchange, side, COUNT(*) AS n, GROUP_CONCAT(pid) AS pids
        FROM legs GROUP BY symbol, exchange, side HAVING n > 1""",
        _OPEN_LIKE_STATUSES + _OPEN_LIKE_STATUSES,
    ).fetchall()
    out = []
    for r in rows:
        out.append(Violation(
            category="overlapping_open_positions",
            severity="error",
            symbol=r["symbol"],
            exchange=r["exchange"],
            actual={"side": r["side"], "position_ids": r["pids"], "count": r["n"]},
        ))
    return out


def _check_aged_open_positions(conn: sqlite3.Connection) -> list[Violation]:
    """Invariant 5: position older than max_hold_minutes + grace."""
    cutoff_ms = int(time.time() * 1000) - (_MAX_HOLD_MINUTES + _MAX_HOLD_GRACE_MINUTES) * 60_000
    rows = conn.execute(
        "SELECT id, symbol, opened_at FROM positions "
        "WHERE status='open' AND opened_at < ?",
        (cutoff_ms,),
    ).fetchall()
    out = []
    for r in rows:
        age_min = (int(time.time() * 1000) - r["opened_at"]) / 60_000
        out.append(Violation(
            category="aged_open_position",
            severity="warn",
            position_id=r["id"],
            symbol=r["symbol"],
            actual={"age_minutes": age_min,
                    "limit_minutes": _MAX_HOLD_MINUTES + _MAX_HOLD_GRACE_MINUTES},
        ))
    return out


def _check_stuck_transitions(conn: sqlite3.Connection) -> list[Violation]:
    """Invariant 6: opening/closing position older than 60s."""
    cutoff_ms = int(time.time() * 1000) - _TRANSITION_TIMEOUT_S * 1000
    rows = conn.execute(
        "SELECT id, symbol, status, opened_at FROM positions "
        "WHERE status IN ('opening','closing') AND opened_at < ?",
        (cutoff_ms,),
    ).fetchall()
    out = []
    for r in rows:
        age_s = (int(time.time() * 1000) - r["opened_at"]) / 1000
        out.append(Violation(
            category="stuck_transition",
            severity="error",
            position_id=r["id"],
            symbol=r["symbol"],
            actual={"status": r["status"], "age_seconds": age_s,
                    "timeout_seconds": _TRANSITION_TIMEOUT_S},
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
