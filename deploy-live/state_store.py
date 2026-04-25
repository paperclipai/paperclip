"""Canonical state store for the live trader.

SQLite-backed. Single source of truth for positions, fills, audit log,
balances, exchange health, and reconciliation events.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Optional

from schemas import PositionRecord, FillRecord, AuditEntry

SCHEMA_DDL = """
CREATE TABLE IF NOT EXISTS positions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol          TEXT    NOT NULL,
    exchange_a      TEXT    NOT NULL,
    exchange_b      TEXT    NOT NULL,
    side_a          TEXT    NOT NULL CHECK (side_a IN ('buy','sell')),
    side_b          TEXT    NOT NULL CHECK (side_b IN ('buy','sell')),
    size_usd_a      REAL    NOT NULL,
    size_usd_b      REAL    NOT NULL,
    entry_spread_pct REAL   NOT NULL,
    exit_spread_pct REAL,
    status          TEXT    NOT NULL CHECK (status IN
                       ('opening','open','closing','closed','degraded','failed')),
    opened_at       INTEGER NOT NULL,
    closed_at       INTEGER,
    realized_pnl_usd REAL,
    UNIQUE (symbol, exchange_a, exchange_b, opened_at)
);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_symbol ON positions(symbol);

CREATE TABLE IF NOT EXISTS fills (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id     INTEGER NOT NULL REFERENCES positions(id),
    exchange        TEXT    NOT NULL,
    leg             TEXT    NOT NULL CHECK (leg IN ('a','b')),
    intent          TEXT    NOT NULL CHECK (intent IN ('entry','exit')),
    order_id        TEXT    NOT NULL,
    side            TEXT    NOT NULL CHECK (side IN ('buy','sell')),
    size_usd        REAL    NOT NULL CHECK (size_usd > 0),
    fill_price      REAL    NOT NULL CHECK (fill_price > 0),
    fees_usd        REAL    NOT NULL,
    filled_at       INTEGER NOT NULL,
    raw_response    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fills_position ON fills(position_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fills_exchange_order ON fills(exchange, order_id);

CREATE TABLE IF NOT EXISTS audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       INTEGER NOT NULL,
    event_type      TEXT    NOT NULL,
    severity        TEXT    NOT NULL CHECK (severity IN ('info','warn','error','critical')),
    position_id     INTEGER REFERENCES positions(id),
    exchange        TEXT,
    symbol          TEXT,
    message         TEXT    NOT NULL,
    details         TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_position ON audit_log(position_id);

CREATE TABLE IF NOT EXISTS balances (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    exchange        TEXT    NOT NULL,
    asset           TEXT    NOT NULL,
    available_usd   REAL    NOT NULL,
    locked_usd      REAL    NOT NULL,
    snapshot_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_balances_exchange_ts ON balances(exchange, snapshot_at);

CREATE TABLE IF NOT EXISTS exchange_health (
    exchange        TEXT    PRIMARY KEY,
    status          TEXT    NOT NULL CHECK (status IN ('ok','degraded','down')),
    last_ok_at      INTEGER,
    last_error_at   INTEGER,
    last_error_msg  TEXT,
    consecutive_errors INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reconciliation_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       INTEGER NOT NULL,
    source          TEXT    NOT NULL CHECK (source IN ('reconciler','invariants')),
    category        TEXT    NOT NULL,
    severity        TEXT    NOT NULL CHECK (severity IN ('info','warn','error','critical')),
    exchange        TEXT,
    symbol          TEXT,
    position_id     INTEGER REFERENCES positions(id),
    expected        TEXT,
    actual          TEXT,
    resolution      TEXT NOT NULL DEFAULT 'unresolved'
                       CHECK (resolution IN ('unresolved','manual','auto','stale')),
    notes           TEXT
);
CREATE INDEX IF NOT EXISTS idx_recon_ts ON reconciliation_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_recon_unresolved
    ON reconciliation_events(resolution) WHERE resolution='unresolved';
"""


def open_db(path: str | Path) -> sqlite3.Connection:
    """Open a SQLite connection with WAL + foreign keys enabled."""
    conn = sqlite3.connect(str(path), isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.row_factory = sqlite3.Row
    return conn


def init_schema(path: str | Path) -> None:
    """Create the database file (if missing) and apply the schema."""
    conn = open_db(path)
    try:
        conn.executescript(SCHEMA_DDL)
    finally:
        conn.close()


_OPEN_STATUSES = ("opening", "open", "closing", "degraded")


def insert_position(
    conn: sqlite3.Connection, *,
    symbol: str, exchange_a: str, exchange_b: str,
    side_a: str, side_b: str,
    size_usd_a: float, size_usd_b: float,
    entry_spread_pct: float,
    status: str, opened_at_ms: int,
) -> int:
    cur = conn.execute(
        """INSERT INTO positions
           (symbol, exchange_a, exchange_b, side_a, side_b,
            size_usd_a, size_usd_b, entry_spread_pct, status, opened_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (symbol, exchange_a, exchange_b, side_a, side_b,
         size_usd_a, size_usd_b, entry_spread_pct, status, opened_at_ms),
    )
    return cur.lastrowid


def get_position(conn: sqlite3.Connection, position_id: int) -> Optional[PositionRecord]:
    row = conn.execute(
        "SELECT * FROM positions WHERE id=?", (position_id,)
    ).fetchone()
    if row is None:
        return None
    return _row_to_position(row)


def update_position_status(
    conn: sqlite3.Connection, position_id: int, status: str
) -> None:
    conn.execute(
        "UPDATE positions SET status=? WHERE id=?", (status, position_id)
    )


def close_position(
    conn: sqlite3.Connection, position_id: int, *,
    closed_at_ms: int, exit_spread_pct: float, realized_pnl_usd: float,
) -> None:
    conn.execute(
        """UPDATE positions
           SET status='closed', closed_at=?, exit_spread_pct=?, realized_pnl_usd=?
           WHERE id=?""",
        (closed_at_ms, exit_spread_pct, realized_pnl_usd, position_id),
    )


def list_open_positions(conn: sqlite3.Connection) -> list[PositionRecord]:
    placeholders = ",".join("?" * len(_OPEN_STATUSES))
    rows = conn.execute(
        f"SELECT * FROM positions WHERE status IN ({placeholders}) ORDER BY id",
        _OPEN_STATUSES,
    ).fetchall()
    return [_row_to_position(r) for r in rows]


def _row_to_position(row: sqlite3.Row) -> PositionRecord:
    return PositionRecord(
        id=row["id"], symbol=row["symbol"],
        exchange_a=row["exchange_a"], exchange_b=row["exchange_b"],
        side_a=row["side_a"], side_b=row["side_b"],
        size_usd_a=row["size_usd_a"], size_usd_b=row["size_usd_b"],
        entry_spread_pct=row["entry_spread_pct"],
        exit_spread_pct=row["exit_spread_pct"],
        status=row["status"], opened_at_ms=row["opened_at"],
        closed_at_ms=row["closed_at"],
        realized_pnl_usd=row["realized_pnl_usd"],
    )


def insert_fill(
    conn: sqlite3.Connection, *,
    position_id: int, exchange: str, leg: str, intent: str,
    order_id: str, side: str,
    size_usd: float, fill_price: float, fees_usd: float,
    filled_at_ms: int, raw_response: str,
) -> int:
    cur = conn.execute(
        """INSERT INTO fills
           (position_id, exchange, leg, intent, order_id, side,
            size_usd, fill_price, fees_usd, filled_at, raw_response)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (position_id, exchange, leg, intent, order_id, side,
         size_usd, fill_price, fees_usd, filled_at_ms, raw_response),
    )
    return cur.lastrowid


def list_fills_for_position(
    conn: sqlite3.Connection, position_id: int
) -> list[FillRecord]:
    rows = conn.execute(
        "SELECT * FROM fills WHERE position_id=? ORDER BY filled_at",
        (position_id,),
    ).fetchall()
    return [_row_to_fill(r) for r in rows]


def list_recent_fills(
    conn: sqlite3.Connection, *, exchange: str, since_ms: int
) -> list[FillRecord]:
    rows = conn.execute(
        "SELECT * FROM fills WHERE exchange=? AND filled_at>=? ORDER BY filled_at",
        (exchange, since_ms),
    ).fetchall()
    return [_row_to_fill(r) for r in rows]


def _row_to_fill(row: sqlite3.Row) -> FillRecord:
    return FillRecord(
        id=row["id"], position_id=row["position_id"],
        exchange=row["exchange"], leg=row["leg"], intent=row["intent"],
        order_id=row["order_id"], side=row["side"],
        size_usd=row["size_usd"], fill_price=row["fill_price"],
        fees_usd=row["fees_usd"], filled_at_ms=row["filled_at"],
    )


def write_audit(
    conn: sqlite3.Connection, *,
    timestamp_ms: int, event_type: str, severity: str, message: str,
    position_id: Optional[int] = None,
    exchange: Optional[str] = None,
    symbol: Optional[str] = None,
    details: Optional[dict] = None,
) -> int:
    cur = conn.execute(
        """INSERT INTO audit_log
           (timestamp, event_type, severity, position_id, exchange, symbol, message, details)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (timestamp_ms, event_type, severity, position_id, exchange, symbol,
         message, json.dumps(details) if details is not None else None),
    )
    return cur.lastrowid


def list_audit_for_position(
    conn: sqlite3.Connection, position_id: int
) -> list[AuditEntry]:
    rows = conn.execute(
        "SELECT * FROM audit_log WHERE position_id=? ORDER BY timestamp",
        (position_id,),
    ).fetchall()
    return [_row_to_audit(r) for r in rows]


def list_audit_recent(
    conn: sqlite3.Connection, *, since_ms: int, limit: int = 100
) -> list[AuditEntry]:
    rows = conn.execute(
        "SELECT * FROM audit_log WHERE timestamp>=? ORDER BY timestamp DESC LIMIT ?",
        (since_ms, limit),
    ).fetchall()
    return [_row_to_audit(r) for r in rows]


def _row_to_audit(row: sqlite3.Row) -> AuditEntry:
    details = json.loads(row["details"]) if row["details"] else None
    return AuditEntry(
        timestamp_ms=row["timestamp"], event_type=row["event_type"],
        severity=row["severity"], position_id=row["position_id"],
        exchange=row["exchange"], symbol=row["symbol"],
        message=row["message"], details=details,
    )
