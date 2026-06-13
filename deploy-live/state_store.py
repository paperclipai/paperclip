"""Canonical state store for the live trader.

SQLite-backed. Single source of truth for positions, fills, audit log,
balances, exchange health, and reconciliation events.
"""
from __future__ import annotations

import asyncio
import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Optional

from schemas import PositionRecord, FillRecord, AuditEntry, BalanceSnapshot, ExchangeHealthRecord, ReconciliationEvent

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


@contextmanager
def transaction(conn: sqlite3.Connection):
    """Atomic transaction context.

    Wraps statements in BEGIN / COMMIT, rolling back on exception. Use this
    when multiple writes must succeed or fail together. Single-statement
    writes do not need this — the connection is in autocommit mode by default.

    Example:
        with transaction(conn):
            insert_position(conn, ...)
            insert_fill(conn, ...)
    """
    conn.execute("BEGIN")
    try:
        yield
    except Exception:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")


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
        id=row["id"],
        timestamp_ms=row["timestamp"], event_type=row["event_type"],
        severity=row["severity"], position_id=row["position_id"],
        exchange=row["exchange"], symbol=row["symbol"],
        message=row["message"], details=details,
    )


def snapshot_balance(
    conn: sqlite3.Connection, *,
    exchange: str, asset: str,
    available_usd: float, locked_usd: float, snapshot_at_ms: int,
) -> int:
    cur = conn.execute(
        """INSERT INTO balances
           (exchange, asset, available_usd, locked_usd, snapshot_at)
           VALUES (?, ?, ?, ?, ?)""",
        (exchange, asset, available_usd, locked_usd, snapshot_at_ms),
    )
    return cur.lastrowid


def latest_balance(
    conn: sqlite3.Connection, *, exchange: str, asset: str = "USDT"
) -> Optional[BalanceSnapshot]:
    row = conn.execute(
        """SELECT * FROM balances WHERE exchange=? AND asset=?
           ORDER BY snapshot_at DESC LIMIT 1""",
        (exchange, asset),
    ).fetchone()
    if row is None:
        return None
    return BalanceSnapshot(
        exchange=row["exchange"], asset=row["asset"],
        available_usd=row["available_usd"], locked_usd=row["locked_usd"],
        snapshot_at_ms=row["snapshot_at"],
    )


def upsert_exchange_health(
    conn: sqlite3.Connection, *,
    exchange: str, status: str,
    last_ok_at_ms: Optional[int] = None,
    last_error_at_ms: Optional[int] = None,
    last_error_msg: Optional[str] = None,
    consecutive_errors: int = 0,
) -> None:
    conn.execute(
        """INSERT INTO exchange_health
           (exchange, status, last_ok_at, last_error_at, last_error_msg, consecutive_errors)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(exchange) DO UPDATE SET
             status=excluded.status,
             last_ok_at=COALESCE(excluded.last_ok_at, exchange_health.last_ok_at),
             last_error_at=COALESCE(excluded.last_error_at, exchange_health.last_error_at),
             last_error_msg=COALESCE(excluded.last_error_msg, exchange_health.last_error_msg),
             consecutive_errors=excluded.consecutive_errors""",
        (exchange, status, last_ok_at_ms, last_error_at_ms,
         last_error_msg, consecutive_errors),
    )


def get_exchange_health(
    conn: sqlite3.Connection, exchange: str
) -> Optional[ExchangeHealthRecord]:
    row = conn.execute(
        "SELECT * FROM exchange_health WHERE exchange=?", (exchange,)
    ).fetchone()
    if row is None:
        return None
    return ExchangeHealthRecord(
        exchange=row["exchange"], status=row["status"],
        last_ok_at_ms=row["last_ok_at"], last_error_at_ms=row["last_error_at"],
        last_error_msg=row["last_error_msg"],
        consecutive_errors=row["consecutive_errors"],
    )


_SEVERITY_ORDER = {"info": 0, "warn": 1, "error": 2, "critical": 3}


def write_recon_event(
    conn: sqlite3.Connection, *,
    timestamp_ms: int, source: str, category: str, severity: str,
    exchange: Optional[str] = None,
    symbol: Optional[str] = None,
    position_id: Optional[int] = None,
    expected: Optional[dict] = None,
    actual: Optional[dict] = None,
    notes: Optional[str] = None,
) -> int:
    cur = conn.execute(
        """INSERT INTO reconciliation_events
           (timestamp, source, category, severity, exchange, symbol, position_id,
            expected, actual, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (timestamp_ms, source, category, severity, exchange, symbol, position_id,
         json.dumps(expected) if expected is not None else None,
         json.dumps(actual) if actual is not None else None,
         notes),
    )
    return cur.lastrowid


def list_unresolved_recon_events(
    conn: sqlite3.Connection, *, min_severity: str = "info"
) -> list[ReconciliationEvent]:
    # Build the IN clause from severities at or above the threshold
    threshold = _SEVERITY_ORDER[min_severity]
    accepted = [s for s, lvl in _SEVERITY_ORDER.items() if lvl >= threshold]
    placeholders = ",".join("?" * len(accepted))
    rows = conn.execute(
        f"SELECT * FROM reconciliation_events "
        f"WHERE resolution='unresolved' AND severity IN ({placeholders}) "
        f"ORDER BY timestamp",
        accepted,
    ).fetchall()
    return [_row_to_recon_event(r) for r in rows]


def resolve_recon_event(
    conn: sqlite3.Connection, event_id: int, *,
    resolution: str, notes: Optional[str] = None,
) -> None:
    conn.execute(
        "UPDATE reconciliation_events SET resolution=?, notes=COALESCE(?, notes) WHERE id=?",
        (resolution, notes, event_id),
    )


def _row_to_recon_event(row: sqlite3.Row) -> ReconciliationEvent:
    return ReconciliationEvent(
        id=row["id"],
        timestamp_ms=row["timestamp"], source=row["source"],
        category=row["category"], severity=row["severity"],
        exchange=row["exchange"], symbol=row["symbol"],
        position_id=row["position_id"],
        expected=json.loads(row["expected"]) if row["expected"] else None,
        actual=json.loads(row["actual"]) if row["actual"] else None,
        notes=row["notes"], resolution=row["resolution"],
    )


class AsyncStateStore:
    """Serializes all writes through a single asyncio lock; reads are direct.

    Holds one connection. Callers should `await start()` before use and
    `await stop()` at shutdown.
    """

    def __init__(self, path: str | Path):
        self._path = path
        self._conn: Optional[sqlite3.Connection] = None
        self._write_lock = asyncio.Lock()

    async def start(self) -> None:
        self._conn = open_db(self._path)

    async def stop(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    @property
    def conn(self) -> sqlite3.Connection:
        if self._conn is None:
            raise RuntimeError("AsyncStateStore not started")
        return self._conn

    # Writes (serialized)
    async def insert_position(self, **kwargs) -> int:
        async with self._write_lock:
            return insert_position(self.conn, **kwargs)

    async def update_position_status(self, position_id: int, status: str) -> None:
        async with self._write_lock:
            update_position_status(self.conn, position_id, status)

    async def close_position(self, position_id: int, **kwargs) -> None:
        async with self._write_lock:
            close_position(self.conn, position_id, **kwargs)

    async def insert_fill(self, **kwargs) -> int:
        async with self._write_lock:
            return insert_fill(self.conn, **kwargs)

    async def write_audit(self, **kwargs) -> int:
        async with self._write_lock:
            return write_audit(self.conn, **kwargs)

    async def snapshot_balance(self, **kwargs) -> int:
        async with self._write_lock:
            return snapshot_balance(self.conn, **kwargs)

    async def upsert_exchange_health(self, **kwargs) -> None:
        async with self._write_lock:
            upsert_exchange_health(self.conn, **kwargs)

    async def write_recon_event(self, **kwargs) -> int:
        async with self._write_lock:
            return write_recon_event(self.conn, **kwargs)

    async def resolve_recon_event(self, event_id: int, **kwargs) -> None:
        async with self._write_lock:
            resolve_recon_event(self.conn, event_id, **kwargs)

    # Reads (direct, no lock — SQLite supports concurrent reads in WAL mode)
    async def get_position(self, position_id: int):
        return get_position(self.conn, position_id)

    async def list_open_positions(self):
        return list_open_positions(self.conn)

    async def list_fills_for_position(self, position_id: int):
        return list_fills_for_position(self.conn, position_id)

    async def list_recent_fills(self, *, exchange: str, since_ms: int):
        return list_recent_fills(self.conn, exchange=exchange, since_ms=since_ms)

    async def latest_balance(self, *, exchange: str, asset: str = "USDT"):
        return latest_balance(self.conn, exchange=exchange, asset=asset)

    async def get_exchange_health(self, exchange: str):
        return get_exchange_health(self.conn, exchange)

    async def list_unresolved_recon_events(self, *, min_severity: str = "info"):
        return list_unresolved_recon_events(self.conn, min_severity=min_severity)
