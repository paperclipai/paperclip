#!/usr/bin/env python3
"""Stamp lane-coverage provenance onto the bare always-on flags of live sisters.

WHY. `reconcileLanePromotionActivityWindowPolicy` (server/src/routes/agents.ts)
gives a newly registered fallback SISTER `ignoreActivityWindow: true` so it can
cover its primary's lane outside the company activity window, and clears that
flag from the promoted PRIMARY. Since b4e5953a5 the sister-side write also
records WHY, as an `ignoreActivityWindowException` with
class=`fallback_sister_lane_coverage`, source=`agent-fallback-sisters`.

Sisters registered BEFORE that commit carry a BARE flag — no record — which is
byte-identical to an operator's manual 24/7 grant. This backfill closes that
gap: once it has run, "bare flag with no record" reliably means "a human set
this", which is what lets the primary-side cleanup preserve operator grants
while still clearing lane residue.

WHY A SCRIPT, NOT A MIGRATION. The flag lives in `agents.runtime_config` and
means something only against fork-local operational state — the fallback
registry and the company activity window — neither of which a schema migration
should be reading. It is also a judgement call that may need re-running (new
lanes, restored agents) and re-reading in dry-run before it writes; a migration
runs once, unattended, on every install of a fork none of this applies to.

SAFE TO RUN REPEATEDLY. A candidate must satisfy ALL of:
  - live agent (not terminated/archived),
  - active `agent_fallback_sisters` row as the SISTER (revoked_at is null),
  - `runtime_config->>'ignoreActivityWindow'` is exactly true,
  - NO `ignoreActivityWindowException` key of any kind,
  - its company HAS an activity window,
  - it is not ALSO an active primary of some other lane.
The "no record of any kind" rule makes the second run a no-op, and means an
operator record is never overwritten.

The last two conditions are deliberately conservative. The route only writes the
flag when the company has an activity window, so a bare flag in a window-less
company was not written by it. And an agent that is a sister in one lane and a
primary in another would have this stamp read as clearable residue the next time
its own lane is registered, dropping coverage it still needs. In both cases the
error directions are asymmetric: skipping leaves an ambiguous bare flag that the
cleanup PRESERVES, while stamping wrongly destroys an operator's grant. Skip.

Usage:
  backfill_sister_lane_coverage_provenance.py             # dry-run (default)
  backfill_sister_lane_coverage_provenance.py --json      # machine-readable plan
  backfill_sister_lane_coverage_provenance.py --apply     # write

Revert (undoes only this script's stamps, by recordedBy):
  UPDATE agents SET runtime_config = runtime_config - 'ignoreActivityWindowException'
   WHERE runtime_config #>> '{ignoreActivityWindowException,recordedBy}' = '<RECORDED_BY>';
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib  # noqa: E402


IGNORE_KEY = "ignoreActivityWindow"
EXCEPTION_KEY = "ignoreActivityWindowException"

# Must match SISTER_LANE_COVERAGE_EXCEPTION_CLASS / IGNORE_ACTIVITY_WINDOW_EXCEPTION_SOURCE
# and the sister-side reason string in server/src/routes/agents.ts.
LANE_COVERAGE_CLASS = "fallback_sister_lane_coverage"
LANE_COVERAGE_SOURCE = "agent-fallback-sisters"
LANE_COVERAGE_REASON = (
    "Fallback sister covers its primary's lane outside the company activity window."
)
RECORDED_BY = "scripts/lane_registry/backfill_sister_lane_coverage_provenance.py"

UUID_RE = re.compile(r"\A[0-9a-fA-F-]{36}\Z")


def _psql_json(db_url: str, sql: str) -> list[dict[str, Any]]:
    return [json.loads(row[0]) for row in lib._psql(db_url, sql) if row and row[0]]


def load_agents_with_runtime(db_url: str) -> dict[str, dict[str, Any]]:
    rows = _psql_json(
        db_url,
        """
        select json_build_object(
          'id', id,
          'companyId', company_id,
          'name', name,
          'runtimeConfig', runtime_config
        )::text
        from agents
        where status not in ('terminated', 'archived');
        """,
    )
    return {row["id"]: row for row in rows}


def load_company_windows(db_url: str) -> dict[str, dict[str, Any]]:
    rows = _psql_json(
        db_url,
        """
        select json_build_object(
          'id', id,
          'name', name,
          'activityWindow', activity_window
        )::text
        from companies
        where status <> 'archived';
        """,
    )
    return {row["id"]: row for row in rows}


def plan(
    agents: dict[str, dict[str, Any]],
    rows: list[dict],
    companies: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    """Live sisters whose bare always-on flag should be stamped as lane coverage."""
    sister_ids = {row["sister"] for row in rows}
    primary_ids = {row["primary"] for row in rows}
    out: list[dict[str, Any]] = []
    for agent_id in sorted(sister_ids):
        agent = agents.get(agent_id)
        if not agent:
            continue  # terminated/archived: not a live sister
        if agent_id in primary_ids:
            continue  # also a primary elsewhere; stamp would read as clearable residue
        runtime = agent.get("runtimeConfig") or {}
        if runtime.get(IGNORE_KEY) is not True:
            continue  # nothing to explain
        if EXCEPTION_KEY in runtime:
            continue  # already has provenance (lane-coverage OR operator) — never overwrite
        company = companies.get(agent.get("companyId", ""))
        if not company or company.get("activityWindow") is None:
            continue  # route never writes the flag without a window; not lane residue
        out.append({
            "agentId": agent_id,
            "agentName": agent.get("name"),
            "companyId": agent.get("companyId"),
            "company": company.get("name"),
        })
    return out


def apply_plan(db_url: str, candidates: list[dict[str, Any]], recorded_at: str) -> int:
    if not candidates:
        return 0
    ids = [c["agentId"] for c in candidates]
    bad = [i for i in ids if not UUID_RE.match(i)]
    if bad:
        raise ValueError(f"refusing to build SQL for non-uuid agent ids: {bad}")
    record = json.dumps({
        "class": LANE_COVERAGE_CLASS,
        "reason": LANE_COVERAGE_REASON,
        "source": LANE_COVERAGE_SOURCE,
        "recordedAt": recorded_at,
        "recordedBy": RECORDED_BY,
    }).replace("'", "''")
    id_list = ",".join(f"'{i}'" for i in ids)
    # The NOT ? guard re-checks the "no record" precondition inside the write, so a
    # concurrent stamp between plan and apply is left alone rather than clobbered.
    sql = (
        "UPDATE agents SET runtime_config = "
        f"coalesce(runtime_config, '{{}}'::jsonb) || jsonb_build_object('{EXCEPTION_KEY}', '{record}'::jsonb), "
        "updated_at = now() "
        f"WHERE id IN ({id_list}) "
        f"AND runtime_config->'{IGNORE_KEY}' = 'true'::jsonb "
        f"AND NOT (coalesce(runtime_config, '{{}}'::jsonb) ? '{EXCEPTION_KEY}');"
    )
    out = subprocess.run(
        ["psql", db_url, "-c", sql], check=True, capture_output=True, text=True
    ).stdout
    updated = 0
    for tok in out.split():  # psql prints "UPDATE N"
        if tok.isdigit():
            updated = int(tok)
    return updated


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db-url", default=lib.DEFAULT_DB_URL)
    ap.add_argument("--json", action="store_true", help="print the plan as JSON")
    ap.add_argument("--apply", action="store_true", help="write the records (default: dry-run)")
    args = ap.parse_args(argv)

    candidates = plan(
        load_agents_with_runtime(args.db_url),
        lib.load_active_fallback_rows(args.db_url),
        load_company_windows(args.db_url),
    )

    if args.json:
        print(json.dumps(candidates, indent=2, sort_keys=True))
    else:
        print(f"Lane-coverage provenance backfill — {len(candidates)} bare sister flag(s):")
        for c in candidates:
            print(f"  {c['company']}: {c['agentName']} ({c['agentId']})")
        if not candidates:
            print("  (nothing to stamp — every live sister's always-on flag has a record)")

    if args.apply:
        recorded_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        updated = apply_plan(args.db_url, candidates, recorded_at)
        print(f"\nAPPLIED: stamped {updated} agent(s).")
        print(f"Revert:  recordedBy = '{RECORDED_BY}' (see module docstring).")
    elif not args.json:
        print("\nDRY-RUN: no DB changes. Re-run with --apply to stamp.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
