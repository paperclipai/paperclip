#!/usr/bin/env python3
"""
per_task_compare.py — head-to-head per-task quality across models, aggregated over ALL
recent run-* sweeps (so the 3-run confirm + the original sweeps combine into a stable mean).

Answers "is one model better at some tasks than others?" — per task and per suite, with the
winner flagged, not just an overall average.

  python3 per_task_compare.py --models gemini-flash-low,grok-4.3,grok-4.20
"""
import argparse
import glob
import json
import os
import statistics


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default="gemini-flash-low,grok-4.3,grok-4.20")
    ap.add_argument("--runs", type=int, default=12, help="scan this many most-recent run-* dirs")
    a = ap.parse_args()
    models = [m.strip() for m in a.models.split(",")]

    run_dirs = sorted(glob.glob("results/run-2026*"), key=os.path.getmtime)[-a.runs:]
    # (role, task) -> model -> [quality...]
    agg, nseen = {}, {}
    for rd in run_dirs:
        p = os.path.join(rd, "runs.json")
        if not os.path.exists(p):
            continue
        for r in json.load(open(p)):
            m = r["model_id"]
            if m not in models or r.get("quality") is None:
                continue
            key = (r["role"], r["task_id"])
            agg.setdefault(key, {}).setdefault(m, []).append(r["quality"])
            nseen[m] = nseen.get(m, 0) + 1

    print(f"models: {', '.join(models)}   (runs scanned: {len(run_dirs)})")
    print("samples/model:", {m: nseen.get(m, 0) for m in models})

    roles = sorted({k[0] for k in agg})
    wins = {m: 0 for m in models}
    for role in roles:
        print(f"\n### {role}")
        print(f"  {'task':<30}" + "".join(f"{m[:14]:>15}" for m in models) + "   winner")
        tasks = sorted({k[1] for k in agg if k[0] == role})
        suite_means = {m: [] for m in models}
        for t in tasks:
            cell = agg[(role, t)]
            means = {m: (statistics.mean(cell[m]) if cell.get(m) else None) for m in models}
            valid = {m: v for m, v in means.items() if v is not None}
            win = max(valid, key=valid.get) if valid else None
            if win:
                wins[win] += 1
            row = f"  {t:<30}"
            for m in models:
                v = means[m]
                star = "*" if m == win else " "
                row += f"{(('%.3f'%v) if v is not None else '-')+star:>15}"
                if v is not None:
                    suite_means[m].append(v)
            row += f"   {win or '-'}"
            print(row)
        sm = "  " + f"{'SUITE MEAN':<30}" + "".join(
            f"{(('%.3f'%statistics.mean(suite_means[m])) if suite_means[m] else '-'):>15}" for m in models)
        best_suite = max((m for m in models if suite_means[m]),
                         key=lambda m: statistics.mean(suite_means[m]), default="-")
        print(sm + f"   <= {best_suite}")

    print(f"\n=== task wins per model (out of {sum(wins.values())} tasks) ===")
    for m in sorted(models, key=lambda m: -wins[m]):
        print(f"  {m:<18} {wins[m]}")


if __name__ == "__main__":
    main()
