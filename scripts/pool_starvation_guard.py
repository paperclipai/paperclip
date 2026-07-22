#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any


DEFAULT_STATE_PATH = Path("scratch/pool-starvation-guard-state.json")
DEFAULT_REPORT_PATH = Path("docs/pool-starvation-guard-report.json")
DEFAULT_POOL_SIZE = 10
DEFAULT_THRESHOLD_PERCENT = 80
DEFAULT_IDLE_TRANSACTION_SECONDS = 60
DEFAULT_COOLDOWN_SECONDS = 900
DEFAULT_LAUNCHD_LABEL = "ie.thinkstack.paperclip-source"


class GuardError(RuntimeError):
    pass


@dataclass(frozen=True)
class Detection:
    observed_at: datetime
    total_connections: int
    stuck_connections: int
    threshold_connections: int
    max_stuck_age_seconds: int
    sample_pids: list[int]
    sample_issue_queries: list[str]

    @property
    def triggered(self) -> bool:
        return self.stuck_connections >= self.threshold_connections


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Detect and self-heal Paperclip DB pool starvation.")
    parser.add_argument("--state-path", type=Path, default=DEFAULT_STATE_PATH)
    parser.add_argument("--report-path", type=Path, default=DEFAULT_REPORT_PATH)
    parser.add_argument("--pool-size", type=int, default=DEFAULT_POOL_SIZE)
    parser.add_argument("--threshold-percent", type=int, default=DEFAULT_THRESHOLD_PERCENT)
    parser.add_argument("--idle-transaction-seconds", type=int, default=DEFAULT_IDLE_TRANSACTION_SECONDS)
    parser.add_argument("--cooldown-seconds", type=int, default=DEFAULT_COOLDOWN_SECONDS)
    parser.add_argument("--launchd-label", default=DEFAULT_LAUNCHD_LABEL)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def run_psql_json(database_url: str, query: str) -> list[dict[str, Any]]:
    wrapped = f"SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM ({query}) t;"
    completed = subprocess.run(
        [
            "psql",
            database_url,
            "-X",
            "-A",
            "-t",
            "-q",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            wrapped,
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise GuardError(completed.stderr.strip() or completed.stdout.strip() or "psql query failed")
    payload = json.loads(completed.stdout.strip() or "[]")
    if not isinstance(payload, list):
        raise GuardError("psql did not return a JSON array")
    return payload


def detect_starvation(database_url: str, idle_transaction_seconds: int, pool_size: int, threshold_percent: int) -> Detection:
    threshold_connections = max(1, math.ceil(pool_size * (threshold_percent / 100.0)))
    query = f"""
        WITH client_backends AS (
          SELECT
            pid,
            state,
            wait_event_type,
            wait_event,
            EXTRACT(EPOCH FROM now() - xact_start)::int AS xact_age_seconds,
            regexp_replace(query, '\\s+', ' ', 'g') AS compact_query
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND backend_type = 'client backend'
            AND pid <> pg_backend_pid()
        ),
        stuck AS (
          SELECT *
          FROM client_backends
          WHERE state = 'idle in transaction'
            AND wait_event_type = 'Client'
            AND wait_event = 'ClientRead'
            AND xact_age_seconds >= {idle_transaction_seconds}
        )
        SELECT
          now() AT TIME ZONE 'UTC' AS observed_at,
          (SELECT count(*) FROM client_backends)::int AS total_connections,
          (SELECT count(*) FROM stuck)::int AS stuck_connections,
          {threshold_connections}::int AS threshold_connections,
          COALESCE((SELECT max(xact_age_seconds) FROM stuck), 0)::int AS max_stuck_age_seconds,
          COALESCE(
            (
              SELECT json_agg(pid ORDER BY xact_age_seconds DESC)
              FROM (SELECT pid, xact_age_seconds FROM stuck ORDER BY xact_age_seconds DESC LIMIT 10) s
            ),
            '[]'::json
          ) AS sample_pids,
          COALESCE(
            (
              SELECT json_agg(compact_query ORDER BY xact_age_seconds DESC)
              FROM (
                SELECT compact_query, xact_age_seconds
                FROM stuck
                ORDER BY xact_age_seconds DESC
                LIMIT 3
              ) s
            ),
            '[]'::json
          ) AS sample_issue_queries
    """
    row = run_psql_json(database_url, query)[0]
    observed_at = datetime.fromisoformat(str(row["observed_at"]).replace(" ", "T") + "+00:00")
    return Detection(
        observed_at=observed_at,
        total_connections=int(row["total_connections"]),
        stuck_connections=int(row["stuck_connections"]),
        threshold_connections=int(row["threshold_connections"]),
        max_stuck_age_seconds=int(row["max_stuck_age_seconds"]),
        sample_pids=[int(value) for value in (row.get("sample_pids") or [])],
        sample_issue_queries=[str(value) for value in (row.get("sample_issue_queries") or [])],
    )


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text())
    except json.JSONDecodeError as error:
        raise GuardError(f"invalid state file {path}: {error}") from error
    if not isinstance(payload, dict):
        raise GuardError(f"state file {path} must contain a JSON object")
    return payload


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")


def kickstart_launchd(label: str) -> None:
    target = f"gui/{os.getuid()}/{label}"
    completed = subprocess.run(
        ["launchctl", "kickstart", "-k", target],
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise GuardError(completed.stderr.strip() or completed.stdout.strip() or f"launchctl kickstart failed for {target}")


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    database_url = os.environ.get("DATABASE_URL", "").strip()
    if not database_url:
        raise GuardError("DATABASE_URL is required")
    if args.pool_size <= 0:
        raise GuardError("--pool-size must be positive")
    if args.threshold_percent <= 0 or args.threshold_percent > 100:
        raise GuardError("--threshold-percent must be between 1 and 100")

    detection = detect_starvation(
        database_url=database_url,
        idle_transaction_seconds=args.idle_transaction_seconds,
        pool_size=args.pool_size,
        threshold_percent=args.threshold_percent,
    )
    state = load_state(args.state_path)
    last_restart_at_raw = state.get("lastRestartAt")
    last_restart_at = (
        datetime.fromisoformat(str(last_restart_at_raw)) if isinstance(last_restart_at_raw, str) else None
    )

    cooldown_until = (
        last_restart_at + timedelta(seconds=args.cooldown_seconds)
        if last_restart_at is not None
        else None
    )
    within_cooldown = cooldown_until is not None and detection.observed_at < cooldown_until

    action = "none"
    if detection.triggered and not within_cooldown:
        action = "dry_run_restart" if args.dry_run else "kickstart_restart"
        if not args.dry_run:
            kickstart_launchd(args.launchd_label)
            state["lastRestartAt"] = detection.observed_at.isoformat()
            state["lastLaunchdLabel"] = args.launchd_label
    elif detection.triggered and within_cooldown:
        action = "cooldown_skip"

    state["lastObservedAt"] = detection.observed_at.isoformat()
    state["lastDetection"] = {
        "triggered": detection.triggered,
        "stuckConnections": detection.stuck_connections,
        "totalConnections": detection.total_connections,
        "thresholdConnections": detection.threshold_connections,
        "maxStuckAgeSeconds": detection.max_stuck_age_seconds,
        "samplePids": detection.sample_pids,
    }
    write_json(args.state_path, state)

    report = {
        "observedAt": detection.observed_at.isoformat(),
        "triggered": detection.triggered,
        "action": action,
        "poolSize": args.pool_size,
        "thresholdPercent": args.threshold_percent,
        "thresholdConnections": detection.threshold_connections,
        "idleTransactionSeconds": args.idle_transaction_seconds,
        "totalConnections": detection.total_connections,
        "stuckConnections": detection.stuck_connections,
        "maxStuckAgeSeconds": detection.max_stuck_age_seconds,
        "samplePids": detection.sample_pids,
        "sampleIssueQueries": detection.sample_issue_queries,
        "launchdLabel": args.launchd_label,
        "cooldownSeconds": args.cooldown_seconds,
        "cooldownUntil": iso(cooldown_until),
        "withinCooldown": within_cooldown,
        "dryRun": args.dry_run,
    }
    write_json(args.report_path, report)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except GuardError as error:
        print(f"pool-starvation-guard: {error}", file=sys.stderr)
        raise SystemExit(1)
