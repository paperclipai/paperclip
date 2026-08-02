#!/usr/bin/env python3
"""Monthly Spark-vs-Opus judge drift check for TSBC bench scoring."""

from __future__ import annotations

import argparse
import json
import math
import statistics
import time
from datetime import datetime, timezone
from pathlib import Path

import benchlib
import judge_policy
from adapters import run_model
from scoring import JUDGE_INSTRUCTIONS


SOURCE_RUNS = {
    "content": "probe-20260721-034638",
    "ops": "probe-20260721-094942",
    "auditor": "probe-20260721-101351",
}
TARGET_BY_ROLE = {"content": 4, "ops": 3, "auditor": 3}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def now_run_id() -> str:
    return "judge-drift-" + datetime.now().strftime("%Y%m%d-%H%M%S")


def mean(values):
    xs = [float(value) for value in values if isinstance(value, (int, float))]
    return statistics.mean(xs) if xs else None


def pearson(xs, ys):
    if len(xs) < 2 or len(xs) != len(ys):
        return None
    mx = statistics.mean(xs)
    my = statistics.mean(ys)
    denx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    deny = math.sqrt(sum((y - my) ** 2 for y in ys))
    if not denx or not deny:
        return None
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (denx * deny)


def judge_prompt(task: dict, output: str) -> str:
    criteria = (task.get("rubric", {}).get("judge", {}) or {}).get("criteria") or []
    crit_lines = "\n".join(
        f'- {criterion["name"]} (weight {criterion.get("weight", 1)}): {criterion.get("guidance", "")}'
        for criterion in criteria
    )
    return (
        JUDGE_INSTRUCTIONS
        + "\n\n=== TASK GIVEN TO THE CANDIDATE ===\n"
        + task["prompt"].strip()
        + "\n\n=== CRITERIA TO SCORE ===\n"
        + crit_lines
        + "\n\n=== CANDIDATE ANSWER ===\n"
        + (output or "(empty answer)").strip()
        + "\n\n=== END ===\nReturn the JSON now."
    )


def score_from_judge_json(parsed: dict, task: dict):
    criteria = (task.get("rubric", {}).get("judge", {}) or {}).get("criteria") or []
    scores = parsed.get("scores", {}) if isinstance(parsed, dict) else {}
    total_w = 0.0
    earned = 0.0
    per = {}
    for criterion in criteria:
        name = criterion["name"]
        weight = float(criterion.get("weight", 1))
        total_w += weight
        raw = scores.get(name)
        try:
            value = max(0.0, min(1.0, float(raw)))
        except (TypeError, ValueError):
            value = None
        per[name] = value
        earned += weight * (value if value is not None else 0.0)
    return (earned / total_w if total_w else None), {
        "perCriterion": per,
        "rationale": parsed.get("rationale") if isinstance(parsed, dict) else None,
    }


def run_judge(prompt: str, judge_row: dict, cfg: dict, timeout: int, task: dict):
    raw = run_model(prompt, judge_row, cfg["adapters"], timeout)
    parsed = benchlib.extract_json(raw.get("output"))
    score, detail = score_from_judge_json(parsed if isinstance(parsed, dict) else {}, task)
    ok = bool(raw.get("ok")) and isinstance(score, (int, float))
    return {
        "ok": ok,
        "score": score,
        "detail": detail,
        "servedModel": raw.get("model") or judge_row.get("model_arg"),
        "servedModelVerified": bool(raw.get("servedModelVerified")),
        "error": raw.get("error") if ok else (raw.get("error") or "judge unparseable"),
        "inputTokens": raw.get("inputTokens"),
        "outputTokens": raw.get("outputTokens"),
        "totalTokens": raw.get("totalTokens"),
        "wallMs": raw.get("wallMs"),
        "stderrTail": raw.get("stderrTail"),
    }


def load_samples(limit: int):
    samples = []
    for role, run_id in SOURCE_RUNS.items():
        target = TARGET_BY_ROLE.get(role, 0)
        if target <= 0:
            continue
        run_dir = benchlib.RESULTS_DIR / run_id
        records = json.loads((run_dir / "records.json").read_text())
        tasks = {task["id"]: task for task in benchlib.load_suite(role)["tasks"]}
        candidates = []
        for index, record in enumerate(records):
            task = tasks.get(record.get("task_id"))
            criteria = (task.get("rubric", {}).get("judge", {}) or {}).get("criteria") if task else None
            if (
                not task
                or not criteria
                or record.get("judge") != judge_policy.OPUS_RESERVE_JUDGE_ID
                or not record.get("ok")
                or not record.get("output")
                or not isinstance(record.get("judgeScore"), (int, float))
            ):
                continue
            candidates.append({
                "sampleId": f"{run_id}:{index:03d}",
                "sourceRunId": run_id,
                "sourceRecordIndex": index,
                "role": role,
                "taskId": record["task_id"],
                "taskTitle": record.get("task_title"),
                "candidateModel": record.get("model"),
                "candidateOutput": record.get("output"),
                "preservedOpusScore": record.get("judgeScore"),
                "preservedOpusDetail": record.get("judgeDetail"),
                "task": task,
            })
        by_task = {}
        for sample in candidates:
            by_task.setdefault(sample["taskId"], []).append(sample)
        picked = []
        while len(picked) < target and any(by_task.values()):
            for task_id in sorted(by_task):
                if len(picked) >= target:
                    break
                bucket = by_task[task_id]
                if bucket:
                    picked.append(bucket.pop(0))
        samples.extend(picked)
    if len(samples) < limit:
        raise SystemExit(f"only found {len(samples)} usable judge samples; need {limit}")
    return samples[:limit]


def render_report(summary: dict) -> str:
    metrics = summary["metrics"]
    def fmt(value, digits=3):
        return f"{value:.{digits}f}" if isinstance(value, (int, float)) else "-"

    lines = [
        f"# Judge Drift Check - {summary['meta']['runId']}",
        "",
        f"Generated: `{summary['meta']['finishedAt']}`",
        f"Default judge: `{summary['meta']['defaultJudge']}`",
        f"Reserve judge: `{summary['meta']['reserveJudge']}`",
        f"Opus source: `{summary['meta']['opusSource']}`",
        f"Auto-revert threshold: `{summary['meta']['meanAbsDeltaAutoRevertThreshold']}`",
        "",
        "| Metric | Value |",
        "| --- | ---: |",
        f"| Samples scored | {summary['meta']['samplesScored']} |",
        f"| Mean Opus score | {fmt(metrics['meanOpusScore'])} |",
        f"| Mean Spark score | {fmt(metrics['meanSparkScore'])} |",
        f"| Mean abs delta | {fmt(metrics['meanAbsDelta'])} |",
        f"| Max abs delta | {fmt(metrics['maxAbsDelta'])} |",
        f"| Within 0.10 | {metrics['within0_10']}/{summary['meta']['samplesScored']} |",
        f"| Pearson | {fmt(metrics['pearson'])} |",
        "",
        f"Verdict: `{summary['verdict']}`",
        f"Auto-reverted: `{summary['meta']['autoReverted']}`",
        "",
        "## Samples",
        "",
        "| # | Source | Role/task | Candidate | Opus | Spark | Abs delta |",
        "| ---: | --- | --- | --- | ---: | ---: | ---: |",
    ]
    for index, row in enumerate(summary["samples"], start=1):
        lines.append(
            f"| {index} | `{row['sourceRunId']}` | `{row['role']}/{row['taskId']}` | "
            f"`{row['candidateModel']}` | {fmt(row['opusScore'])} | {fmt(row['sparkScore'])} | "
            f"{fmt(row['absDelta'])} |"
        )
    return "\n".join(lines)


def auto_revert_config(config_path: Path, summary: dict):
    cfg = json.loads(config_path.read_text())
    cfg["judge"] = judge_policy.opus_reserve_judge()
    policy = cfg.setdefault("judge_policy", {})
    policy["defaultJudge"] = judge_policy.OPUS_RESERVE_JUDGE_ID
    policy["lastAutoRevert"] = {
        "runId": summary["meta"]["runId"],
        "at": summary["meta"]["finishedAt"],
        "meanAbsDelta": summary["metrics"]["meanAbsDelta"],
        "threshold": summary["meta"]["meanAbsDeltaAutoRevertThreshold"],
        "from": judge_policy.DEFAULT_JUDGE_ID,
        "to": judge_policy.OPUS_RESERVE_JUDGE_ID,
    }
    config_path.write_text(json.dumps(cfg, indent=2) + "\n")

    flag = benchlib.ROOT / ".judge-drift-revert.json"
    flag.write_text(json.dumps(policy["lastAutoRevert"], indent=2) + "\n")
    state_path = benchlib.ROOT / "model-watch" / "judge-drift-state.json"
    state_path.write_text(json.dumps(summary, indent=2) + "\n")
    return flag, state_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Run monthly Spark-vs-Opus judge drift check.")
    parser.add_argument("--config", default=None)
    parser.add_argument("--n", type=int, default=10)
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--use-preserved-opus", action="store_true",
                        help="compare Spark against preserved Opus scores instead of spending live Opus calls")
    parser.add_argument("--no-revert", action="store_true",
                        help="do not auto-revert config.json even if drift fails")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.n < 10:
        raise SystemExit("--n must be >= 10 for the standing monthly drift check")

    cfg = benchlib.load_config(args.config)
    config_path = Path(args.config) if args.config else benchlib.CONFIG_PATH
    timeout = int(cfg["run"]["timeout_sec"])
    spark_judge = judge_policy.default_judge()
    opus_judge = judge_policy.opus_reserve_judge()
    samples = load_samples(args.n)
    sample_manifest = [
        {key: value for key, value in sample.items() if key not in {"task", "candidateOutput", "preservedOpusDetail"}}
        for sample in samples
    ]
    calibration_set_sha = benchlib.sha256_text(json.dumps(sample_manifest, sort_keys=True))

    run_id = args.run_id or now_run_id()
    out_dir = benchlib.RESULTS_DIR / run_id
    raw_dir = out_dir / "raw"
    out_dir.mkdir(parents=True, exist_ok=True)
    raw_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "samples.json").write_text(json.dumps(sample_manifest, indent=2) + "\n")

    print(f"=== Judge drift check - {run_id} ===", flush=True)
    print(f"samples: {len(samples)}", flush=True)
    print(f"spark  : {spark_judge['id']} ({spark_judge['model_arg']} effort={spark_judge['reasoning_effort']})", flush=True)
    print(f"opus   : {opus_judge['id']} ({'preserved' if args.use_preserved_opus else 'live'})", flush=True)
    if args.dry_run:
        print(json.dumps(sample_manifest, indent=2), flush=True)
        return 0

    started = now_iso()
    t0 = time.time()
    rows = []
    for index, sample in enumerate(samples, start=1):
        prompt = judge_prompt(sample["task"], sample["candidateOutput"])
        if args.use_preserved_opus:
            opus = {
                "ok": True,
                "score": sample["preservedOpusScore"],
                "detail": sample.get("preservedOpusDetail"),
                "servedModel": "preserved:claude-opus",
                "servedModelVerified": True,
                "error": None,
                "inputTokens": None,
                "outputTokens": None,
                "totalTokens": None,
                "wallMs": None,
                "stderrTail": "",
            }
        else:
            opus = run_judge(prompt, opus_judge, cfg, timeout, sample["task"])
        spark = run_judge(prompt, spark_judge, cfg, timeout, sample["task"])
        delta = None
        if isinstance(opus["score"], (int, float)) and isinstance(spark["score"], (int, float)):
            delta = float(spark["score"]) - float(opus["score"])
        row = {
            "sampleId": sample["sampleId"],
            "sourceRunId": sample["sourceRunId"],
            "sourceRecordIndex": sample["sourceRecordIndex"],
            "role": sample["role"],
            "taskId": sample["taskId"],
            "taskTitle": sample["taskTitle"],
            "candidateModel": sample["candidateModel"],
            "runId": run_id,
            "opusScore": opus["score"],
            "opusDetail": opus["detail"],
            "opusServedModel": opus["servedModel"],
            "opusError": opus["error"],
            "sparkScore": spark["score"],
            "sparkDetail": spark["detail"],
            "sparkServedModel": spark["servedModel"],
            "sparkError": spark["error"],
            "scoreDelta": delta,
            "absDelta": abs(delta) if isinstance(delta, (int, float)) else None,
            "sparkInputTokens": spark["inputTokens"],
            "sparkOutputTokens": spark["outputTokens"],
            "sparkTotalTokens": spark["totalTokens"],
            "sparkWallMs": spark["wallMs"],
            "opusInputTokens": opus["inputTokens"],
            "opusOutputTokens": opus["outputTokens"],
            "opusTotalTokens": opus["totalTokens"],
            "opusWallMs": opus["wallMs"],
        }
        rows.append(row)
        (raw_dir / f"{index:02d}-{benchlib.slugify(sample['role'])}-{benchlib.slugify(sample['taskId'])}.json").write_text(
            json.dumps(row, indent=2) + "\n"
        )
        print(
            f"  [{index:02d}/{len(samples)}] {sample['role']}/{sample['taskId']} "
            f"opus={opus['score'] if opus['score'] is not None else '-'} "
            f"spark={spark['score'] if spark['score'] is not None else '-'}",
            flush=True,
        )

    finished = now_iso()
    valid = [
        row for row in rows
        if isinstance(row.get("opusScore"), (int, float)) and isinstance(row.get("sparkScore"), (int, float))
    ]
    opus_scores = [float(row["opusScore"]) for row in valid]
    spark_scores = [float(row["sparkScore"]) for row in valid]
    abs_deltas = [float(row["absDelta"]) for row in valid]
    mean_abs_delta = mean(abs_deltas)
    threshold = judge_policy.DRIFT_MEAN_ABS_DELTA_REVERT_THRESHOLD
    incomplete = len(valid) < args.n
    drift_failed = not incomplete and mean_abs_delta is not None and mean_abs_delta > threshold
    summary = {
        "meta": {
            "runId": run_id,
            "startedAt": started,
            "finishedAt": finished,
            "elapsedSec": round(time.time() - t0, 1),
            "samplesRequested": args.n,
            "samplesScored": len(valid),
            "defaultJudge": spark_judge["id"],
            "reserveJudge": opus_judge["id"],
            "opusSource": "preserved" if args.use_preserved_opus else "live",
            "calibrationSetSha256": calibration_set_sha,
            "meanAbsDeltaAutoRevertThreshold": threshold,
            "spotCheckAbsDeltaOpusThreshold": judge_policy.SPOT_CHECK_ABS_DELTA_OPUS_THRESHOLD,
            "autoReverted": False,
            "sourceRuns": SOURCE_RUNS,
        },
        "metrics": {
            "meanOpusScore": mean(opus_scores),
            "meanSparkScore": mean(spark_scores),
            "meanAbsDelta": mean_abs_delta,
            "maxAbsDelta": max(abs_deltas) if abs_deltas else None,
            "within0_10": sum(1 for value in abs_deltas if value <= judge_policy.SPOT_CHECK_ABS_DELTA_OPUS_THRESHOLD),
            "within0_10Rate": (
                sum(1 for value in abs_deltas if value <= judge_policy.SPOT_CHECK_ABS_DELTA_OPUS_THRESHOLD) / len(abs_deltas)
            ) if abs_deltas else 0.0,
            "pearson": pearson(opus_scores, spark_scores),
        },
        "verdict": "incomplete" if incomplete else ("auto_reverted" if drift_failed else "pass"),
        "samples": rows,
    }
    if drift_failed and not args.no_revert:
        summary["meta"]["autoReverted"] = True
        flag, state_path = auto_revert_config(config_path, summary)
        summary["meta"]["autoRevertFlagPath"] = str(flag)
        summary["meta"]["autoRevertStatePath"] = str(state_path)
        state_path.write_text(json.dumps(summary, indent=2) + "\n")

    (out_dir / "records.json").write_text(json.dumps(rows, indent=2) + "\n")
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    report = render_report(summary)
    (out_dir / "report.md").write_text(report + "\n")
    print("\n" + report, flush=True)
    return 0 if summary["verdict"] == "pass" else 2


if __name__ == "__main__":
    raise SystemExit(main())
