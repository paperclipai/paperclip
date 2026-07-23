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
_UNRESOLVED_AGE_LIMIT_MIN = 30
_OK_HEALTH_FRESHNESS_LIMIT_MIN = 5


def check_all(conn: sqlite3.Connection) -> list[Violation]:
    """Run every invariant. Returns the union of all Violations found."""
    out: list[Violation] = []
    out += _check_open_position_legs(conn)
    out += _check_closed_position_legs(conn)
    out += _check_fill_quality(conn)
    out += _check_overlapping_open_positions(conn)
    out += _check_aged_open_positions(conn)
    out += _check_stuck_transitions(conn)
    out += _check_audit_orphans(conn)
    out += _check_fill_orphans(conn)
    out += _check_exposure_vs_balance(conn)
    out += _check_stale_unresolved_recon_events(conn)
    out += _check_stale_ok_exchange_health(conn)
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


def _check_audit_orphans(conn: sqlite3.Connection) -> list[Violation]:
    """Invariant 7: audit_log entries with position_id pointing nowhere."""
    rows = conn.execute(
        "SELECT a.id, a.position_id FROM audit_log a "
        "LEFT JOIN positions p ON p.id = a.position_id "
        "WHERE a.position_id IS NOT NULL AND p.id IS NULL"
    ).fetchall()
    return [
        Violation(
            category="audit_orphan_position_id",
            severity="warn",
            notes=f"audit_log #{r['id']} references missing position_id={r['position_id']}",
        )
        for r in rows
    ]


def _check_fill_orphans(conn: sqlite3.Connection) -> list[Violation]:
    """Invariant 8: fill rows with position_id pointing nowhere."""
    rows = conn.execute(
        "SELECT f.id, f.position_id FROM fills f "
        "LEFT JOIN positions p ON p.id = f.position_id "
        "WHERE p.id IS NULL"
    ).fetchall()
    return [
        Violation(
            category="fill_orphan_position_id",
            severity="error",
            notes=f"fill #{r['id']} references missing position_id={r['position_id']}",
        )
        for r in rows
    ]


def _check_exposure_vs_balance(conn: sqlite3.Connection) -> list[Violation]:
    """Invariant 10: sum(open size_usd) per exchange <= latest balance."""
    rows = conn.execute(
        f"""WITH legs AS (
            SELECT exchange_a AS exchange, size_usd_a AS sz
            FROM positions WHERE status IN ({",".join("?" * len(_OPEN_LIKE_STATUSES))})
            UNION ALL
            SELECT exchange_b AS exchange, size_usd_b AS sz
            FROM positions WHERE status IN ({",".join("?" * len(_OPEN_LIKE_STATUSES))})
        )
        SELECT exchange, SUM(sz) AS open_total FROM legs GROUP BY exchange""",
        _OPEN_LIKE_STATUSES + _OPEN_LIKE_STATUSES,
    ).fetchall()
    out = []
    for r in rows:
        bal_row = conn.execute(
            "SELECT available_usd, locked_usd FROM balances "
            "WHERE exchange=? AND asset='USDT' "
            "ORDER BY snapshot_at DESC LIMIT 1",
            (r["exchange"],),
        ).fetchone()
        if bal_row is None:
            continue  # no balance snapshot yet; can't compare
        bal_total = bal_row["available_usd"] + bal_row["locked_usd"]
        if r["open_total"] > bal_total:
            out.append(Violation(
                category="exposure_exceeds_balance",
                severity="warn",
                exchange=r["exchange"],
                expected={"max_exposure_usd": bal_total},
                actual={"open_exposure_usd": r["open_total"]},
            ))
    return out


def _check_stale_unresolved_recon_events(conn: sqlite3.Connection) -> list[Violation]:
    """Invariant 11: unresolved recon_event older than 30 min."""
    cutoff_ms = int(time.time() * 1000) - _UNRESOLVED_AGE_LIMIT_MIN * 60_000
    rows = conn.execute(
        "SELECT id, category, exchange, symbol, timestamp FROM reconciliation_events "
        "WHERE resolution='unresolved' AND timestamp < ?",
        (cutoff_ms,),
    ).fetchall()
    out = []
    for r in rows:
        age_min = (int(time.time() * 1000) - r["timestamp"]) / 60_000
        out.append(Violation(
            category="stale_unresolved_recon_event",
            severity="warn",
            exchange=r["exchange"],
            symbol=r["symbol"],
            notes=f"recon_event #{r['id']} ({r['category']}) unresolved for {age_min:.0f} min",
        ))
    return out


def _check_stale_ok_exchange_health(conn: sqlite3.Connection) -> list[Violation]:
    """Invariant 12: exchange marked 'ok' but last_ok_at is too old."""
    cutoff_ms = int(time.time() * 1000) - _OK_HEALTH_FRESHNESS_LIMIT_MIN * 60_000
    rows = conn.execute(
        "SELECT exchange, last_ok_at FROM exchange_health "
        "WHERE status='ok' AND (last_ok_at IS NULL OR last_ok_at < ?)",
        (cutoff_ms,),
    ).fetchall()
    out = []
    for r in rows:
        age_min = (
            (int(time.time() * 1000) - r["last_ok_at"]) / 60_000
            if r["last_ok_at"] else None
        )
        out.append(Violation(
            category="stale_ok_exchange_health",
            severity="error",
            exchange=r["exchange"],
            actual={"last_ok_age_minutes": age_min,
                    "limit_minutes": _OK_HEALTH_FRESHNESS_LIMIT_MIN},
        ))
    return out


class RateLimiter:
    """Coalesces repeated violations within a fixed window.

    Key is (category, position_id, exchange, symbol). Same key within
    `window_s` seconds is suppressed.
    """

    def __init__(self, *, window_s: float = 60.0) -> None:
        self._window_s = window_s
        self._last_seen: dict[tuple, float] = {}

    def allow(self, violation: Violation, *, now_s: Optional[float] = None) -> bool:
        if now_s is None:
            now_s = time.time()
        key = (violation.category, violation.position_id,
               violation.exchange, violation.symbol)
        prev = self._last_seen.get(key)
        if prev is not None and (now_s - prev) < self._window_s:
            return False
        self._last_seen[key] = now_s
        return True


def check_inmem_consistency(
    conn: sqlite3.Connection, *, in_memory_open_count: int
) -> list[Violation]:
    """Invariant 9: caller-provided in-memory count vs DB count.

    Separate from check_all() because it requires data only the trader
    process has (its in-memory tracker).
    """
    placeholders = ",".join("?" * len(_OPEN_LIKE_STATUSES))
    n = conn.execute(
        f"SELECT COUNT(*) FROM positions WHERE status IN ({placeholders})",
        _OPEN_LIKE_STATUSES,
    ).fetchone()[0]
    if n != in_memory_open_count:
        return [Violation(
            category="inmem_db_count_mismatch",
            severity="error",
            expected={"in_memory_count": in_memory_open_count},
            actual={"db_count": n},
        )]
    return []
