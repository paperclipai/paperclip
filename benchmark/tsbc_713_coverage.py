#!/usr/bin/env python3
"""Summarize TSBC-713 exact-pair coverage from the shared skillbench ledger."""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parent
LEDGER_PATH = ROOT / "ledger" / "results.jsonl"

PAIRS = [
    "youtube-script-content-ops",
    "etsy-listing-seo",
    "cv-polish-recruitment",
    "content-book-craft",
]

MODELS = [
    "gemini-flash",
    "grok-4.3",
    "codex-gpt-5.4",
    "claude-opus",
]

MIN_REPS = 3


def weighted_mean(rows: list[tuple[float | None, int]]) -> float | None:
    usable = [(value, weight) for value, weight in rows if value is not None and weight > 0]
    if not usable:
        return None
    total_weight = sum(weight for _, weight in usable)
    if total_weight <= 0:
        return None
    return sum(value * weight for value, weight in usable) / total_weight


def load_rows() -> dict[tuple[str, str], dict[str, object]]:
    cells: dict[tuple[str, str], dict[str, object]] = {}
    for pair in PAIRS:
        for model in MODELS:
            cells[(pair, model)] = {
                "n": 0,
                "run_ids": [],
                "baseline": [],
                "treatment": [],
                "lift": [],
                "extra_tokens": [],
            }

    with LEDGER_PATH.open() as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if record.get("source") != "skillbench.py" or record.get("kind") != "skill_eval":
                continue
            pair = (record.get("skill") or {}).get("id")
            model = record.get("model")
            key = (pair, model)
            if key not in cells:
                continue
            n = int(record.get("n_tasks") or 0)
            metrics = record.get("metrics") or {}
            cell = cells[key]
            cell["n"] = int(cell["n"]) + n
            cell["run_ids"].append(record.get("run_id"))
            cell["baseline"].append((metrics.get("baselineQuality"), n))
            cell["treatment"].append((metrics.get("treatmentQuality"), n))
            cell["lift"].append((metrics.get("lift"), n))
            cell["extra_tokens"].append((metrics.get("skillExtraInputTokens"), n))
    return cells


def fmt(value: float | None, digits: int = 3, signed: bool = False) -> str:
    if value is None:
        return "—"
    if signed:
        return f"{value:+.{digits}f}"
    return f"{value:.{digits}f}"


def summarize(cells: dict[tuple[str, str], dict[str, object]]) -> tuple[list[dict[str, object]], dict[tuple[str, ...], list[str]]]:
    rows: list[dict[str, object]] = []
    missing_groups: dict[tuple[str, ...], list[str]] = defaultdict(list)

    for pair in PAIRS:
        missing_models: list[str] = []
        for model in MODELS:
            cell = cells[(pair, model)]
            n = int(cell["n"])
            baseline = weighted_mean(cell["baseline"])
            treatment = weighted_mean(cell["treatment"])
            lift = weighted_mean(cell["lift"])
            extra_tokens = weighted_mean(cell["extra_tokens"])
            complete = n >= MIN_REPS
            if not complete:
                missing_models.append(model)
            rows.append(
                {
                    "pair": pair,
                    "model": model,
                    "baseline": baseline,
                    "treatment": treatment,
                    "lift": lift,
                    "extra_tokens": extra_tokens,
                    "n": n,
                    "status": "ready" if complete else f"needs {MIN_REPS - n} more rep(s)",
                    "run_ids": sorted(set(run_id for run_id in cell["run_ids"] if run_id)),
                }
            )
        if missing_models:
            missing_groups[tuple(missing_models)].append(pair)

    return rows, missing_groups


def render_markdown(rows: list[dict[str, object]], missing_groups: dict[tuple[str, ...], list[str]]) -> str:
    out = [
        "# TSBC-713 Exact-Pair Coverage",
        "",
        f"Coverage source: `{LEDGER_PATH}`",
        "",
        f"`MIN_REPS = {MIN_REPS}` per pair x model cell.",
        "",
        "| Pair | Model | Baseline | Treatment | Delta | +tok | n | Coverage |",
        "|---|---|---:|---:|---:|---:|---:|---|",
    ]
    for row in rows:
        out.append(
            f"| `{row['pair']}` | `{row['model']}` | {fmt(row['baseline'])} | "
            f"{fmt(row['treatment'])} | {fmt(row['lift'], signed=True)} | "
            f"{fmt(row['extra_tokens'], digits=0)} | {row['n']} | {row['status']} |"
        )

    out.extend(["", "## Top-up Commands", ""])
    if not missing_groups:
        out.append("All TSBC-713 cells already meet the 3-rep minimum.")
        return "\n".join(out) + "\n"

    out.append("Run these after the Books `00:00-04:00` low-power window clears:")
    out.append("")
    out.append("```bash")
    for models, pairs in sorted(missing_groups.items(), key=lambda item: (len(item[1]), item[1])):
        out.append(
            "python3 skillbench.py "
            f"--pairs {','.join(pairs)} "
            f"--models {','.join(models)} "
            f"--reps {MIN_REPS}"
        )
    out.append("```")
    out.append("")
    out.append("## Notes")
    out.append("")
    out.append("- Weighted means use each ledger row's `n_tasks` so older 2-rep runs aggregate correctly.")
    out.append("- `content-book-craft` can reuse archived Gemini Flash and Claude Opus evidence; the other three pairs are still blank in the shared ledger.")
    return "\n".join(out) + "\n"


def main() -> None:
    rows, missing_groups = summarize(load_rows())
    print(render_markdown(rows, missing_groups), end="")


if __name__ == "__main__":
    main()
