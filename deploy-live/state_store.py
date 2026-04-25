"""Canonical state store for the live trader.

SQLite-backed. Single source of truth for positions, fills, audit log,
balances, exchange health, and reconciliation events.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

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
