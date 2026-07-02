#!/usr/bin/env python3
"""Backfill cps.paper_progress.v1 PROGRESS.json sidecars from existing judgments.

Local/offline only: reads JUDGMENT.json sidecars under self_practice and writes
a PROGRESS.json next to each one that lacks it. Never calls networks, brokers,
or paid APIs. Stage derivation is conservative and verdict-driven; curated
simple-language human blockers exist for the three seed papers.

Canonical stages: intake -> decomposed -> inventory -> data_check ->
replication -> oos_validation -> shadow -> dossier.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_SELF_PRACTICE_DIR = Path("/root/cps/var/self_practice")
SCHEMA = "cps.paper_progress.v1"
STAGES = ["intake", "decomposed", "inventory", "data_check", "replication", "oos_validation", "shadow", "dossier"]

# Curated human-required blockers for the seed papers (real, not artificial).
SEED_BLOCKERS: dict[str, dict[str, Any]] = {
    "iv-mean-reversion-20260630": {
        "stage": "data_check",
        "blocker": {
            "kind": "data_subscription",
            "human_required": True,
            "simple_ask": (
                "Full intraday out-of-sample replay is blocked: the IBKR paper session is "
                "already used by the market-data recorder and our intraday options data is "
                "incomplete. Decide one: allow a second IBKR session, pause the recorder for "
                "a day, or approve buying the missing intraday data."
            ),
            "link": "https://www.interactivebrokers.com/en/pricing/research-news-marketdata.php",
        },
    },
    "crackingmarkets-volatility-breakout-20260630": {
        "stage": "decomposed",
        "blocker": {
            "kind": "rules_gated",
            "human_required": True,
            "simple_ask": (
                "The article's exact entry/exit rules are members-only on crackingmarkets.com. "
                "If you want this tested faithfully, subscribe and paste the full rules; "
                "otherwise we archive it as rules-blocked. We never invent missing rules."
            ),
            "link": None,  # filled from judgment source url when present
        },
    },
    "crackingmarkets-buy-the-dip-20260630": {
        "stage": "oos_validation",
        "blocker": {
            "kind": "data_subscription",
            "human_required": True,
            "simple_ask": (
                "Promotion needs survivorship-bias-free historical index membership data "
                "(including delisted stocks). Norgate Data covers this for US equities — "
                "approve a subscription, or tell us to keep this proxy-only."
            ),
            "link": "https://norgatedata.com/",
        },
    },
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def scalar(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def stage_row(stage: str, status: str, **extra: Any) -> dict[str, Any]:
    row: dict[str, Any] = {"stage": stage, "status": status}
    row.update({k: v for k, v in extra.items() if v is not None})
    return row


def derive_stages(experiment_id: str, judgment: dict[str, Any]) -> list[dict[str, Any]]:
    verdict = scalar(judgment.get("result_verdict")) or scalar(judgment.get("resultVerdict")) or "INCONCLUSIVE"
    source = judgment.get("source") if isinstance(judgment.get("source"), dict) else {}
    now = utc_now()

    # A judgment existing implies the claim was taken in and decomposed.
    status: dict[str, Any] = {stage: stage_row(stage, "pending") for stage in STAGES}
    status["intake"] = stage_row("intake", "done", at=now)
    status["decomposed"] = stage_row("decomposed", "done", at=now)
    status["inventory"] = stage_row("inventory", "done", at=now)

    seed = SEED_BLOCKERS.get(experiment_id)
    if seed:
        blocker = dict(seed["blocker"])
        if not blocker.get("link"):
            blocker["link"] = scalar(source.get("url"))
        stuck_stage = seed["stage"]
        # Stages before the stuck one stay done, the stuck one carries the blocker,
        # everything after stays pending.
        reached = True
        for stage in STAGES:
            if stage == stuck_stage:
                status[stage] = stage_row(stage, "stuck", blocker=blocker)
                reached = False
            elif not reached:
                status[stage] = stage_row(stage, "pending")
        # buy-the-dip did complete a proxy replication before its OOS blocker.
        if experiment_id == "crackingmarkets-buy-the-dip-20260630":
            status["data_check"] = stage_row("data_check", "done", note="proxy dataset accepted")
            status["replication"] = stage_row("replication", "done", note="local proxy reproduced core stats")
        return [status[stage] for stage in STAGES]

    if verdict == "LOCAL_VALIDATION_KILL":
        status["data_check"] = stage_row("data_check", "done")
        status["replication"] = stage_row("replication", "done")
        status["oos_validation"] = stage_row("oos_validation", "done", note="negative result")
        status["shadow"] = stage_row("shadow", "skipped", note="killed before shadow")
        status["dossier"] = stage_row("dossier", "done", note="failure dossier / learning archive")
    elif verdict in {"DATA_BLOCKED", "RULES_BLOCKED"}:
        stuck = "data_check" if verdict == "DATA_BLOCKED" else "decomposed"
        status[stuck] = stage_row(stuck, "stuck", blocker={
            "kind": "data" if verdict == "DATA_BLOCKED" else "rules_gated",
            "human_required": False,
            "simple_ask": None,
        })
    elif verdict == "INCONCLUSIVE":
        if scalar(judgment.get("archived_utc")):
            # Archived draft: routed out of autonomous work, learning captured,
            # verdict still awaits an operator label.
            status["data_check"] = stage_row("data_check", "in_progress", note="archived; draft judgment awaiting operator label")
            status["dossier"] = stage_row("dossier", "done", note="failure learning archived (LEARNING.md)")
        else:
            status["data_check"] = stage_row("data_check", "in_progress", note="auto-draft judgment awaiting operator correction")
    else:
        # Supportive verdicts (proxy support, shadow-only, promote-review).
        status["data_check"] = stage_row("data_check", "done")
        status["replication"] = stage_row("replication", "done")
        status["oos_validation"] = stage_row("oos_validation", "in_progress")
    return [status[stage] for stage in STAGES]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-practice-dir", type=Path, default=DEFAULT_SELF_PRACTICE_DIR)
    parser.add_argument("--force", action="store_true", help="overwrite existing PROGRESS.json")
    parser.add_argument("--only", action="append", default=None, metavar="EXPERIMENT_ID",
                        help="refresh only these experiment ids (implies overwrite for them); "
                             "used by consumer handlers to advance stages after a mutation")
    args = parser.parse_args()

    only = set(args.only) if args.only else None
    written: list[str] = []
    skipped: list[str] = []
    for judgment_path in sorted(args.self_practice_dir.glob("*/JUDGMENT.json")):
        experiment_dir = judgment_path.parent
        experiment_id = experiment_dir.name
        if only is not None and experiment_id not in only:
            continue
        progress_path = experiment_dir / "PROGRESS.json"
        if progress_path.exists() and not args.force and only is None:
            skipped.append(experiment_id)
            continue
        try:
            judgment = json.loads(judgment_path.read_text())
        except (OSError, json.JSONDecodeError):
            skipped.append(experiment_id)
            continue
        if not isinstance(judgment, dict):
            skipped.append(experiment_id)
            continue
        progress = {
            "schema": SCHEMA,
            "paper_id": experiment_id,
            "updated_utc": utc_now(),
            "generated_by": "backfill-paper-progress.v2",
            "stages": derive_stages(experiment_id, judgment),
        }
        progress_path.write_text(json.dumps(progress, indent=2, sort_keys=False) + "\n")
        written.append(experiment_id)

    print(json.dumps({
        "status": "ok",
        "self_practice_dir": str(args.self_practice_dir),
        "written": written,
        "written_count": len(written),
        "skipped_count": len(skipped),
        "network": False,
        "paid_actions": False,
    }, indent=2))


if __name__ == "__main__":
    main()
