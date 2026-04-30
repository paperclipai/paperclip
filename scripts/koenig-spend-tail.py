#!/usr/bin/env python3
"""Phase J — spend log workaround.

Paperclip's `cost_events` table is populating, but the
`/api/companies/{id}/cost-events` endpoint is missing in this build, so the
watchdog's cap enforcement is inert. This script tails the postgres table
to JSONL so spend is durable, greppable, and inspectable without
docker-exec'ing into the DB every time.

Run as a sidecar from docker-compose.koenig.yml (or standalone for ad-hoc
dumps with `--once`).

Output: /paperclip/spend.jsonl (one JSON object per cost event, append-only).
On host this maps to the named volume `paperclip-data:/paperclip` — visible
inside the paperclip container and via `docker volume inspect`.

CLI:
  python3 koenig-spend-tail.py            # daemon, polls every 60s
  python3 koenig-spend-tail.py --once     # one-shot dump and exit
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

PG_URL = os.environ.get("DATABASE_URL", "postgres://paperclip:paperclip@db:5432/paperclip")
COMPANY_ID = "2a77f89b-33f0-4133-a20c-77ddaac5e744"
JSONL_PATH = Path(os.environ.get("KOENIG_SPEND_JSONL", "/paperclip/spend.jsonl"))
POLL_INTERVAL_S = int(os.environ.get("KOENIG_SPEND_POLL_S", "60"))
STATE_FILE = JSONL_PATH.with_suffix(".state")


def log(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    line = f"{ts} {msg}\n"
    sys.stdout.write(line)
    sys.stdout.flush()


def query_pg(since_iso: str | None) -> list[dict]:
    import psycopg2
    import psycopg2.extras
    conn = psycopg2.connect(PG_URL)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            sql = """
                SELECT ce.id::text, ce.agent_id::text, a.name AS agent_name,
                       ce.provider, ce.model, ce.input_tokens, ce.output_tokens,
                       ce.cached_input_tokens, ce.cost_cents, ce.occurred_at,
                       ce.issue_id::text AS issue_id, ce.heartbeat_run_id::text AS run_id
                FROM cost_events ce
                JOIN agents a ON ce.agent_id = a.id
                WHERE ce.company_id = %s
            """
            params = [COMPANY_ID]
            if since_iso:
                sql += " AND ce.occurred_at > %s"
                params.append(since_iso)
            sql += " ORDER BY ce.occurred_at ASC"
            cur.execute(sql, params)
            rows = cur.fetchall()
            for r in rows:
                if isinstance(r.get("occurred_at"), datetime):
                    r["occurred_at"] = r["occurred_at"].isoformat()
            return rows
    finally:
        conn.close()


def load_state() -> str | None:
    if STATE_FILE.exists():
        return STATE_FILE.read_text(encoding="utf-8").strip() or None
    return None


def save_state(occurred_at: str) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(occurred_at, encoding="utf-8")


def append_jsonl(rows: list[dict]) -> None:
    if not rows:
        return
    JSONL_PATH.parent.mkdir(parents=True, exist_ok=True)
    with JSONL_PATH.open("a", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, default=str) + "\n")


def cycle() -> int:
    since = load_state()
    rows = query_pg(since)
    append_jsonl(rows)
    if rows:
        save_state(rows[-1]["occurred_at"])
        total_usd = sum(r["cost_cents"] for r in rows) / 100.0
        log(f"appended {len(rows)} events (${total_usd:.2f}) since={since}")
    else:
        log(f"no new events since={since}")
    return len(rows)


def main() -> int:
    once = "--once" in sys.argv
    log(f"spend-tail up — pg={PG_URL.split('@')[-1]} jsonl={JSONL_PATH} once={once}")
    if once:
        cycle()
        return 0
    while True:
        try:
            cycle()
        except Exception as e:  # noqa: BLE001
            log(f"cycle error: {e}")
        try:
            time.sleep(POLL_INTERVAL_S)
        except KeyboardInterrupt:
            log("shutdown via SIGINT")
            return 0


if __name__ == "__main__":
    sys.exit(main())
