#!/usr/bin/env python3
"""Nightly-eval regression detector: digest and alert.

Reads per-task NDJSON eval rows, computes per-class quality metrics excluding
infra-error rows, and classifies each class as REGRESSION, INCONCLUSIVE, or OK.

Key invariant: rows with a non-null `error` field are infra-errors (timeouts,
OOM, etc.) and must NOT count against quality. They are only counted against the
`error_rate` gauge. A class with error_rate >= ERROR_RATE_INCONCLUSIVE_THRESHOLD
is flagged INCONCLUSIVE — not a quality regression — because we lack a meaningful
quality sample.

Row schema (NDJSON):
  {"gold_class": str, "task_id": str, "task_correct": 0|1,
   "error": null | "timed out" | ..., "wall_s": float}
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ERROR_RATE_INCONCLUSIVE_THRESHOLD = 0.25  # error_rate >= this → INCONCLUSIVE
REGRESSION_DELTA_THRESHOLD = 0.10         # task_correct_rate drop >= 10 pp → alert
MIN_CLEAN_ROWS_FOR_REGRESSION = 3         # need at least this many clean rows to call a regression


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class ClassMetrics:
    gold_class: str
    total: int
    errors: int
    error_rate: float
    clean: int
    clean_rate: float          # fraction of non-errored rows (1 - error_rate)
    task_correct_rate: float   # correct / clean (quality over non-errored rows only)
    inconclusive: bool         # True when error_rate >= ERROR_RATE_INCONCLUSIVE_THRESHOLD


@dataclass
class Alert:
    gold_class: str
    kind: str        # "REGRESSION" | "INCONCLUSIVE"
    delta: float     # task_correct_rate - baseline (negative for drops; 0.0 for INCONCLUSIVE)
    error_rate: float


# ---------------------------------------------------------------------------
# Core functions
# ---------------------------------------------------------------------------

def compute_class_metrics(gold_class: str, rows: list[dict]) -> ClassMetrics:
    """Aggregate per-task rows into per-class quality metrics.

    Rows with a non-null `error` field are counted as infra-errors and excluded
    from the quality denominator (task_correct_rate).
    """
    total = len(rows)
    if total == 0:
        return ClassMetrics(
            gold_class=gold_class,
            total=0,
            errors=0,
            error_rate=0.0,
            clean=0,
            clean_rate=0.0,
            task_correct_rate=0.0,
            inconclusive=False,
        )

    error_rows = [r for r in rows if r.get("error") is not None]
    clean_rows = [r for r in rows if r.get("error") is None]

    errors = len(error_rows)
    clean = len(clean_rows)
    error_rate = errors / total
    clean_rate = clean / total

    task_correct_rate = (
        sum(int(r.get("task_correct", 0)) for r in clean_rows) / clean
        if clean > 0
        else 0.0
    )

    inconclusive = error_rate >= ERROR_RATE_INCONCLUSIVE_THRESHOLD

    return ClassMetrics(
        gold_class=gold_class,
        total=total,
        errors=errors,
        error_rate=error_rate,
        clean=clean,
        clean_rate=clean_rate,
        task_correct_rate=task_correct_rate,
        inconclusive=inconclusive,
    )


def detect_regressions(
    metrics: list[ClassMetrics],
    baseline: dict[str, float],
    regression_threshold: float = REGRESSION_DELTA_THRESHOLD,
    min_clean_rows: int = MIN_CLEAN_ROWS_FOR_REGRESSION,
) -> list[Alert]:
    """Classify each class as REGRESSION, INCONCLUSIVE, or OK.

    Rules applied in order:
      1. INCONCLUSIVE: error_rate >= threshold → emit INCONCLUSIVE alert, skip regression check.
      2. No baseline for class → skip (insufficient reference data).
      3. Too few clean rows → skip (insufficient quality sample).
      4. REGRESSION: task_correct_rate dropped >= regression_threshold vs baseline.
      5. OK: no alert emitted.
    """
    alerts: list[Alert] = []

    for m in metrics:
        if m.inconclusive:
            alerts.append(Alert(
                gold_class=m.gold_class,
                kind="INCONCLUSIVE",
                delta=0.0,
                error_rate=m.error_rate,
            ))
            continue

        if m.gold_class not in baseline:
            continue

        if m.clean < min_clean_rows:
            continue

        delta = m.task_correct_rate - baseline[m.gold_class]
        if delta < -regression_threshold:
            alerts.append(Alert(
                gold_class=m.gold_class,
                kind="REGRESSION",
                delta=delta,
                error_rate=m.error_rate,
            ))

    return alerts


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------

def format_digest_table(metrics: list[ClassMetrics]) -> str:
    """Render a fixed-width digest table with an errors column and INCONCLUSIVE markers."""
    col_w = {
        "gold_class": max(12, max((len(m.gold_class) for m in metrics), default=12)),
        "total": 7,
        "errors": 7,
        "clean": 7,
        "error_rate": 11,
        "correct_rate": 13,
        "status": 14,
    }

    def row_fmt(gc, total, errors, clean, err_rate, corr_rate, status):
        return (
            f"{gc:<{col_w['gold_class']}}  "
            f"{total:>{col_w['total']}}  "
            f"{errors:>{col_w['errors']}}  "
            f"{clean:>{col_w['clean']}}  "
            f"{err_rate:>{col_w['error_rate']}}  "
            f"{corr_rate:>{col_w['correct_rate']}}  "
            f"{status:<{col_w['status']}}"
        )

    header = row_fmt(
        "gold_class", "total", "errors", "clean",
        "error_rate", "correct_rate", "status"
    )
    sep = "-" * len(header)

    lines = [header, sep]
    for m in metrics:
        status = "INCONCLUSIVE" if m.inconclusive else "ok"
        lines.append(row_fmt(
            m.gold_class,
            m.total,
            m.errors,
            m.clean,
            f"{m.error_rate:.1%}",
            f"{m.task_correct_rate:.1%}" if m.clean > 0 else "n/a",
            status,
        ))

    return "\n".join(lines)


def format_alert_message(alerts: list[Alert]) -> str:
    """Produce a human-readable alert body distinguishing infra-flake from quality drops."""
    if not alerts:
        return "No regressions or infra issues detected."

    regressions = [a for a in alerts if a.kind == "REGRESSION"]
    inconclusive = [a for a in alerts if a.kind == "INCONCLUSIVE"]

    parts: list[str] = []
    if regressions:
        parts.append(
            f"QUALITY REGRESSION ({len(regressions)} class(es)):\n"
            + "\n".join(
                f"  {a.gold_class}: delta={a.delta:+.1%} vs baseline"
                for a in regressions
            )
        )
    if inconclusive:
        parts.append(
            f"INCONCLUSIVE — re-run needed ({len(inconclusive)} class(es)):\n"
            + "\n".join(
                f"  {a.gold_class}: error_rate={a.error_rate:.1%} (infra flake, not a quality signal)"
                for a in inconclusive
            )
        )

    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# NDJSON loader
# ---------------------------------------------------------------------------

def load_rows(path: Path) -> list[dict]:
    """Load all NDJSON rows from a file."""
    rows: list[dict] = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def group_by_class(rows: list[dict]) -> dict[str, list[dict]]:
    """Partition rows into {gold_class: [row, ...]}."""
    groups: dict[str, list[dict]] = {}
    for row in rows:
        gc = str(row.get("gold_class", "unknown"))
        groups.setdefault(gc, []).append(row)
    return groups


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Nightly-eval digest and alert")
    parser.add_argument("ndjson", type=Path, help="NDJSON eval results file")
    parser.add_argument(
        "--baseline",
        type=Path,
        default=None,
        help="JSON file mapping gold_class → baseline task_correct_rate",
    )
    args = parser.parse_args()

    rows = load_rows(args.ndjson)
    groups = group_by_class(rows)

    metrics_list = [
        compute_class_metrics(gc, grp) for gc, grp in sorted(groups.items())
    ]

    print(format_digest_table(metrics_list))
    print()

    baseline: dict[str, float] = {}
    if args.baseline:
        baseline = json.loads(args.baseline.read_text(encoding="utf-8"))

    alerts = detect_regressions(metrics_list, baseline)
    print(format_alert_message(alerts))

    regressions = [a for a in alerts if a.kind == "REGRESSION"]
    sys.exit(1 if regressions else 0)


if __name__ == "__main__":
    main()
