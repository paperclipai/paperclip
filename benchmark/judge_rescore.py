#!/usr/bin/env python3
"""Re-score saved benchmark outputs with the current default judge."""

from __future__ import annotations

import argparse
import json
import statistics
import time
from datetime import datetime, timezone
from pathlib import Path

import benchlib
import judge_policy
from scoring import score_run


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def now_run_id() -> str:
    return "judge-rescore-" + datetime.now().strftime("%Y%m%d-%H%M%S")


def mean(values):
    xs = [float(value) for value in values if isinstance(value, (int, float))]
    return statistics.mean(xs) if xs else None


def load_source_run(run_id: str):
    run_dir = benchlib.RESULTS_DIR / run_id
    runs_path = run_dir / "runs.json"
    if not runs_path.exists():
        raise SystemExit(f"no runs.json at {runs_path}")
    return run_dir, json.loads(runs_path.read_text())


def raw_from_record(record: dict) -> dict:
    return {
        "ok": bool(record.get("ok")),
        "output": record.get("output") or "",
        "model": record.get("servedModel") or record.get("model_reported") or record.get("trueModelId"),
        "inputTokens": record.get("inputTokens"),
        "outputTokens": record.get("outputTokens"),
        "totalTokens": record.get("totalTokens"),
        "costUsd": record.get("costUsd"),
        "tokensEstimated": bool(record.get("tokensEstimated")),
        "wallMs": record.get("wallMs"),
        "error": record.get("error"),
        "stderrTail": record.get("stderrTail"),
        "servedModelVerified": bool(record.get("servedModelVerified")),
        "servedModelMismatch": bool(record.get("servedModelMismatch")),
    }


def task_has_judge_criteria(task: dict) -> bool:
    return bool((task.get("rubric", {}).get("judge", {}) or {}).get("criteria"))


def has_unparseable_judge(scored: dict) -> bool:
    detail = scored.get("judgeDetail")
    return isinstance(detail, dict) and detail.get("error") == "judge: unparseable"


def rescore_with_retries(task: dict, raw_record: dict, cfg: dict, timeout: int, retries: int) -> dict:
    attempts = 0
    while True:
        scored = score_run(task, raw_record, cfg, cfg["adapters"], timeout)
        if not has_unparseable_judge(scored) or attempts >= retries:
            scored["judgeAttempts"] = attempts + 1
            return scored
        attempts += 1
        print(f"      judge parse retry {attempts}/{retries}", flush=True)


def render_report(summary: dict) -> str:
    metrics = summary["metrics"]
    lines = [
        f"# Judge Re-score - {summary['meta']['runId']}",
        "",
        f"Source run: `{summary['meta']['sourceRunId']}`",
        f"Role: `{summary['meta']['role']}`",
        f"Original judge: `{summary['meta']['originalJudge']}`",
        f"Rescore judge: `{summary['meta']['rescoreJudge']}`",
        f"Quality tolerance: `{summary['meta']['meanAbsQualityDeltaTolerance']}` mean abs delta, "
        f"`{summary['meta']['maxAbsQualityDeltaTolerance']}` max abs delta",
        "",
        "| Metric | Value |",
        "| --- | ---: |",
        f"| Records | {summary['meta']['records']} |",
        f"| Judge calls | {summary['meta']['judgeCalls']} |",
        f"| Judge parse errors | {summary['meta']['judgeErrors']} |",
        f"| Original mean quality | {metrics['originalMeanQuality']:.4f} |",
        f"| Rescored mean quality | {metrics['rescoredMeanQuality']:.4f} |",
        f"| Mean abs quality delta | {metrics['meanAbsQualityDelta']:.4f} |",
        f"| Max abs quality delta | {metrics['maxAbsQualityDelta']:.4f} |",
        "",
        f"Verdict: `{summary['verdict']}`",
        "",
        "## Per Task",
        "",
        "| task | model | rep | oldQ | newQ | abs delta | old judge | new judge |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for row in summary["records"]:
        old_judge = row["originalJudgeScore"]
        new_judge = row["rescoredJudgeScore"]
        old_judge_text = f"{old_judge:.4f}" if isinstance(old_judge, (int, float)) else "-"
        new_judge_text = f"{new_judge:.4f}" if isinstance(new_judge, (int, float)) else "-"
        lines.append(
            f"| `{row['taskId']}` | `{row['modelId']}` | {row['rep']} | "
            f"{row['originalQuality']:.4f} | {row['rescoredQuality']:.4f} | "
            f"{row['absQualityDelta']:.4f} | {old_judge_text} | {new_judge_text} |"
        )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Re-score one complete role from an existing run.")
    parser.add_argument("--config", default=None)
    parser.add_argument("--source-run", required=True)
    parser.add_argument("--role", required=True)
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--mean-tolerance", type=float,
                        default=judge_policy.DRIFT_MEAN_ABS_DELTA_REVERT_THRESHOLD)
    parser.add_argument("--max-tolerance", type=float,
                        default=judge_policy.SPOT_CHECK_ABS_DELTA_OPUS_THRESHOLD)
    parser.add_argument("--judge-retries", type=int, default=2,
                        help="Retry unparseable judge responses before failing the re-score.")
    args = parser.parse_args()

    cfg = benchlib.load_config(args.config)
    timeout = int(cfg["run"]["timeout_sec"])
    run_id = args.run_id or now_run_id()
    source_dir, source_records = load_source_run(args.source_run)
    records = [record for record in source_records if record.get("role") == args.role]
    if not records:
        raise SystemExit(f"source run {args.source_run} has no records for role {args.role!r}")
    tasks = {task["id"]: task for task in benchlib.load_suite(args.role)["tasks"]}
    missing_tasks = sorted({record.get("task_id") for record in records if record.get("task_id") not in tasks})
    if missing_tasks:
        raise SystemExit(f"source run contains unknown task ids for {args.role}: {', '.join(missing_tasks)}")

    out_dir = benchlib.RESULTS_DIR / run_id
    raw_dir = out_dir / "raw"
    out_dir.mkdir(parents=True, exist_ok=True)
    raw_dir.mkdir(parents=True, exist_ok=True)

    started = now_iso()
    t0 = time.time()
    rows = []
    print(f"=== Judge re-score - {run_id} ===", flush=True)
    print(f"source: {source_dir}", flush=True)
    print(f"role  : {args.role}", flush=True)
    print(f"judge : {cfg['judge'].get('id')}", flush=True)
    print(f"rows  : {len(records)}", flush=True)

    for index, record in enumerate(records, start=1):
        task = tasks[record["task_id"]]
        scored = rescore_with_retries(task, raw_from_record(record), cfg, timeout, args.judge_retries)
        original_quality = record.get("quality")
        rescored_quality = scored.get("quality")
        if not isinstance(original_quality, (int, float)) or not isinstance(rescored_quality, (int, float)):
            raise SystemExit(
                f"record {index} could not be compared: old={original_quality!r} new={rescored_quality!r}"
            )
        delta = float(rescored_quality) - float(original_quality)
        row = {
            "sourceRunId": args.source_run,
            "role": args.role,
            "taskId": record["task_id"],
            "modelId": record.get("model_id"),
            "rep": record.get("rep"),
            "originalQuality": original_quality,
            "rescoredQuality": rescored_quality,
            "qualityDelta": delta,
            "absQualityDelta": abs(delta),
            "originalJudgeScore": record.get("judgeScore"),
            "rescoredJudgeScore": scored.get("judgeScore"),
            "rescoredJudgeDetail": scored.get("judgeDetail"),
            "judgeAttempts": scored.get("judgeAttempts"),
            "judgeParseError": has_unparseable_judge(scored),
            "judgeExpected": task_has_judge_criteria(task),
            "deterministicScore": scored.get("deterministicScore"),
        }
        rows.append(row)
        (raw_dir / f"{index:03d}-{benchlib.slugify(record['task_id'])}-{benchlib.slugify(record.get('model_id'))}.json").write_text(
            json.dumps(row, indent=2) + "\n"
        )
        print(
            f"  [{index:02d}/{len(records)}] {record['task_id']} {record.get('model_id')} "
            f"old={original_quality:.3f} new={rescored_quality:.3f} delta={delta:+.3f}",
            flush=True,
        )

    abs_deltas = [row["absQualityDelta"] for row in rows]
    original = [row["originalQuality"] for row in rows]
    rescored = [row["rescoredQuality"] for row in rows]
    mean_delta = mean(abs_deltas)
    max_delta = max(abs_deltas) if abs_deltas else None
    judge_errors = sum(1 for row in rows if row["judgeParseError"])
    verdict = (
        "pass"
        if mean_delta is not None
        and mean_delta <= args.mean_tolerance
        and max_delta is not None
        and max_delta <= args.max_tolerance
        and judge_errors == 0
        else "fail"
    )
    meta = {
        "runId": run_id,
        "sourceRunId": args.source_run,
        "sourceRunDir": str(source_dir),
        "role": args.role,
        "startedAt": started,
        "finishedAt": now_iso(),
        "elapsedSec": round(time.time() - t0, 1),
        "records": len(rows),
        "judgeCalls": sum(1 for row in rows if isinstance(row.get("rescoredJudgeScore"), (int, float))),
        "judgeErrors": judge_errors,
        "originalJudge": "claude-opus",
        "rescoreJudge": cfg["judge"].get("id"),
        "meanAbsQualityDeltaTolerance": args.mean_tolerance,
        "maxAbsQualityDeltaTolerance": args.max_tolerance,
    }
    summary = {
        "meta": meta,
        "metrics": {
            "originalMeanQuality": mean(original),
            "rescoredMeanQuality": mean(rescored),
            "meanAbsQualityDelta": mean_delta,
            "maxAbsQualityDelta": max_delta,
        },
        "verdict": verdict,
        "records": rows,
    }
    (out_dir / "records.json").write_text(json.dumps(rows, indent=2) + "\n")
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    report = render_report(summary)
    (out_dir / "report.md").write_text(report + "\n")
    print("\n" + report, flush=True)
    return 0 if verdict == "pass" else 2


if __name__ == "__main__":
    raise SystemExit(main())
