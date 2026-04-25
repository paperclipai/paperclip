"""One-time migration from file-based state to the SQLite state_store.

Reads `state.json` (open positions + their fills) and `trade_history.csv`
(closed positions). Validates each row through pydantic schemas. Inserts
passing rows; writes failures to a quarantine JSONL file with reason.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from schemas import PositionRecord, FillRecord
from state_store import (
    open_db, insert_position, insert_fill,
)


def migrate(
    *,
    state_json_path: Path,
    trade_history_csv_path: Path,
    db_path: Path,
    quarantine_path: Path,
    quarantine_threshold_pct: float | None = None,
) -> dict[str, int]:
    summary = {"positions_migrated": 0, "fills_migrated": 0, "quarantined": 0}
    quarantine_lines: list[str] = []

    conn = open_db(db_path)
    try:
        # Open positions from state.json
        if state_json_path.exists():
            with open(state_json_path) as f:
                state = json.load(f)
            for raw in state.get("open_positions", []):
                pid_or_skip = _migrate_open_position(conn, raw, quarantine_lines)
                if pid_or_skip is not None:
                    summary["positions_migrated"] += 1
                    summary["fills_migrated"] += _migrate_fills(
                        conn, pid_or_skip, raw.get("fills", []), quarantine_lines
                    )

        # Closed positions from trade_history.csv
        if trade_history_csv_path.exists():
            with open(trade_history_csv_path, newline="") as f:
                for row in csv.DictReader(f):
                    if _migrate_closed_position(conn, row, quarantine_lines):
                        summary["positions_migrated"] += 1
    finally:
        conn.close()

    if quarantine_lines:
        with open(quarantine_path, "w") as f:
            f.write("\n".join(quarantine_lines))
    summary["quarantined"] = len(quarantine_lines)

    if quarantine_threshold_pct is not None:
        total = (
            summary["positions_migrated"]
            + summary["fills_migrated"]
            + summary["quarantined"]
        )
        if total > 0:
            pct = 100.0 * summary["quarantined"] / total
            if pct > quarantine_threshold_pct:
                sys.stderr.write(
                    f"Migration aborted: {summary['quarantined']} of {total} rows "
                    f"({pct:.1f}%) quarantined, exceeding threshold "
                    f"{quarantine_threshold_pct:.1f}%\n"
                )
                raise SystemExit(2)

    return summary


def _migrate_open_position(conn, raw: dict, quarantine: list[str]) -> int | None:
    try:
        # Validate the shape we expect — id is auto-assigned, so omit
        PositionRecord(
            id=0, symbol=raw["symbol"],
            exchange_a=raw["exchange_a"], exchange_b=raw["exchange_b"],
            side_a=raw["side_a"], side_b=raw["side_b"],
            size_usd_a=raw["size_usd_a"], size_usd_b=raw["size_usd_b"],
            entry_spread_pct=raw.get("entry_spread_pct", 0.0),
            status="open", opened_at_ms=raw["opened_at_ms"],
        )
    except (ValidationError, KeyError) as e:
        quarantine.append(json.dumps({
            "kind": "open_position", "row": raw, "reason": str(e),
        }))
        return None
    pid = insert_position(
        conn, symbol=raw["symbol"],
        exchange_a=raw["exchange_a"], exchange_b=raw["exchange_b"],
        side_a=raw["side_a"], side_b=raw["side_b"],
        size_usd_a=raw["size_usd_a"], size_usd_b=raw["size_usd_b"],
        entry_spread_pct=raw.get("entry_spread_pct", 0.0),
        status="open", opened_at_ms=raw["opened_at_ms"],
    )
    return pid


def _migrate_fills(conn, position_id: int, raws: list[dict], quarantine: list[str]) -> int:
    n = 0
    for raw in raws:
        try:
            FillRecord(
                id=0, position_id=position_id,
                exchange=raw["exchange"], leg=raw["leg"], intent=raw["intent"],
                order_id=raw["order_id"], side=raw["side"],
                size_usd=raw["size_usd"], fill_price=raw["fill_price"],
                fees_usd=raw["fees_usd"], filled_at_ms=raw["filled_at_ms"],
            )
        except (ValidationError, KeyError) as e:
            quarantine.append(json.dumps({
                "kind": "fill", "position_id": position_id, "row": raw, "reason": str(e),
            }))
            continue
        insert_fill(
            conn, position_id=position_id,
            exchange=raw["exchange"], leg=raw["leg"], intent=raw["intent"],
            order_id=raw["order_id"], side=raw["side"],
            size_usd=raw["size_usd"], fill_price=raw["fill_price"],
            fees_usd=raw["fees_usd"], filled_at_ms=raw["filled_at_ms"],
            raw_response=raw.get("raw", "{}"),
        )
        n += 1
    return n


def _migrate_closed_position(conn, row: dict[str, Any], quarantine: list[str]) -> bool:
    """Migrate one closed position from CSV.

    NOTE: This bypasses `state_store.close_position()` and writes the close
    fields via raw SQL UPDATE because the position is being inserted directly
    into a `closed` state, not transitioning from `open`. If `close_position()`
    ever grows behavior beyond the SQL update (e.g. requiring a prior `open`
    state, emitting an audit log entry), this migration path will not see it.
    """
    try:
        # CSV gives strings; coerce numerics.
        coerced = {
            "symbol": row["symbol"],
            "exchange_a": row["exchange_a"], "exchange_b": row["exchange_b"],
            "side_a": row["side_a"], "side_b": row["side_b"],
            "size_usd_a": float(row["size_usd_a"]),
            "size_usd_b": float(row["size_usd_b"]),
            "entry_spread_pct": float(row["entry_spread_pct"]),
            "exit_spread_pct": float(row["exit_spread_pct"]) if row.get("exit_spread_pct") else None,
            "opened_at_ms": int(row["opened_at_ms"]),
            "closed_at_ms": int(row["closed_at_ms"]) if row.get("closed_at_ms") else None,
            "realized_pnl_usd": float(row["realized_pnl_usd"]) if row.get("realized_pnl_usd") else None,
        }
        PositionRecord(id=0, status="closed", **coerced)
    except (ValidationError, ValueError, KeyError) as e:
        quarantine.append(json.dumps({
            "kind": "closed_position", "row": row, "reason": str(e),
        }))
        return False
    pid = insert_position(
        conn, symbol=coerced["symbol"],
        exchange_a=coerced["exchange_a"], exchange_b=coerced["exchange_b"],
        side_a=coerced["side_a"], side_b=coerced["side_b"],
        size_usd_a=coerced["size_usd_a"], size_usd_b=coerced["size_usd_b"],
        entry_spread_pct=coerced["entry_spread_pct"],
        status="closed", opened_at_ms=coerced["opened_at_ms"],
    )
    conn.execute(
        """UPDATE positions SET closed_at=?, exit_spread_pct=?, realized_pnl_usd=?
           WHERE id=?""",
        (coerced["closed_at_ms"], coerced["exit_spread_pct"],
         coerced["realized_pnl_usd"], pid),
    )
    return True


def _main():
    p = argparse.ArgumentParser(description="Migrate file-based state to SQLite.")
    p.add_argument("--state", required=True, type=Path)
    p.add_argument("--csv", required=True, type=Path)
    p.add_argument("--db", required=True, type=Path)
    p.add_argument("--quarantine", required=True, type=Path)
    p.add_argument("--threshold", type=float, default=5.0,
                   help="Abort if quarantined rows exceed this %% (default 5.0)")
    p.add_argument("--dry-run", action="store_true",
                   help="Run validation pass only; do not insert into the DB")
    args = p.parse_args()

    if args.dry_run:
        # Use an in-memory DB so all inserts are discarded
        import tempfile, os
        fd, tmp = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        try:
            init_schema_path = Path(tmp)
            from state_store import init_schema as _init
            _init(init_schema_path)
            summary = migrate(
                state_json_path=args.state,
                trade_history_csv_path=args.csv,
                db_path=init_schema_path,
                quarantine_path=args.quarantine,
                quarantine_threshold_pct=args.threshold,
            )
        finally:
            os.remove(tmp)
        print(f"DRY RUN summary: {summary}")
        return

    summary = migrate(
        state_json_path=args.state,
        trade_history_csv_path=args.csv,
        db_path=args.db,
        quarantine_path=args.quarantine,
        quarantine_threshold_pct=args.threshold,
    )
    print(f"Migration summary: {summary}")


if __name__ == "__main__":
    _main()
