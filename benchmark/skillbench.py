#!/usr/bin/env python3
"""
skillbench.py — #16 skill-refinement benchmark: does a candidate skill actually help?

Runs a task WITH vs WITHOUT a candidate skill injected, scores both outputs against
the SAME rubric (reusing the #15 scoring engine), and reports the LIFT. This is the
keep/kill gate for the skill-creator eval loop: a skill earns its place only if it
beats baseline on the rubric — and the lift has to justify the extra tokens it costs.

Key design choices that keep it honest:
  - The skill is injected into the GENERATION prompt only. SCORING uses the original
    bare task (prompt + rubric), and the blind judge sees the candidate's OUTPUT and
    the ORIGINAL objective — never the skill text. So we measure whether the skill made
    the ANSWER better, not whether the model can parrot the skill.
  - Pairs live in skillbench/pairs.json: each pairs a candidate skill file with a
    deliberately UNDER-SPECIFIED task (the methodology the skill teaches is NOT already
    in the bare prompt) so there is room for the skill to help.
  - Reps (default 2) per (pair,model) to dampen single-run noise.

  python3 skillbench.py                          # all pairs, configured models, 2 reps
  python3 skillbench.py --pairs ops-forensics
  python3 skillbench.py --models claude-opus,gemini-pro --reps 3
  python3 skillbench.py --keep-threshold 0.03    # min mean lift to recommend KEEP
"""

import argparse
import json
import statistics
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

import benchlib
from adapters import run_model
from scoring import score_run

ROOT = benchlib.ROOT
SKILLBENCH_DIR = ROOT / "skillbench"
PAIRS_PATH = SKILLBENCH_DIR / "pairs.json"
PRINT_LOCK = threading.Lock()


SKILL_PREAMBLE = """You have access to the following operating skill — a vetted playbook for \
this class of task. Read it and apply its guidance where relevant.

--- BEGIN SKILL: {name} ---
{body}
--- END SKILL ---

Now complete the task below. Apply the skill's method; do not mention the skill in your answer.

=== TASK ===
{task}
"""


def load_pairs():
    with open(PAIRS_PATH) as f:
        cfg = json.load(f)
    for p in cfg["pairs"]:
        skill_path = SKILLBENCH_DIR / p["skill"]
        p["_skill_name"] = Path(p["skill"]).stem
        p["_skill_body"] = skill_path.read_text()
    return cfg["pairs"]


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return statistics.mean(xs) if xs else None


def run_cell(pair, model_row, adapters_cfg, timeout, rep):
    """One (pair, model, rep): baseline + treatment, scored against the bare task."""
    bare_task = pair["task"]                       # {id, prompt, rubric}
    injected_prompt = SKILL_PREAMBLE.format(
        name=pair["_skill_name"], body=pair["_skill_body"], task=bare_task["prompt"])
    treat_gen_task = {"id": bare_task["id"], "prompt": injected_prompt, "rubric": bare_task["rubric"]}

    # baseline: generate from bare prompt, score against bare task
    base_raw = run_model(bare_task["prompt"], model_row, adapters_cfg, timeout)
    base_scored = score_run(bare_task, base_raw, _cfg, adapters_cfg, timeout)
    # treatment: generate WITH skill, but SCORE against the bare task (judge sees bare objective)
    treat_raw = run_model(injected_prompt, model_row, adapters_cfg, timeout)
    treat_scored = score_run(bare_task, treat_raw, _cfg, adapters_cfg, timeout)

    bq, tq = base_scored.get("quality"), treat_scored.get("quality")
    both_ok = bool(base_raw.get("ok")) and bool(treat_raw.get("ok"))
    # a lift is only valid if BOTH calls succeeded — a transient infra error (socket
    # closed, timeout) is not a quality signal and must not count as a -1.0 lift.
    lift = (tq - bq) if (both_ok and bq is not None and tq is not None) else None
    # skill cost = INPUT-token delta (the skill body adds to the prompt deterministically).
    # NOT total — total is swamped by output/thoughts variance (esp. reasoning models).
    extra_tokens = None
    if base_raw.get("inputTokens") is not None and treat_raw.get("inputTokens") is not None:
        extra_tokens = treat_raw["inputTokens"] - base_raw["inputTokens"]
    rec = {
        "pair": pair["id"], "task": bare_task["id"], "model": model_row["id"], "rep": rep,
        "baselineQuality": bq, "treatmentQuality": tq, "lift": lift, "bothOk": both_ok,
        "baselineInputTokens": base_raw.get("inputTokens"), "treatmentInputTokens": treat_raw.get("inputTokens"),
        "baselineTokens": base_raw.get("totalTokens"), "treatmentTokens": treat_raw.get("totalTokens"),
        "skillExtraTokens": extra_tokens,
        "baselineOutput": (base_raw.get("output") or "")[:1500],
        "treatmentOutput": (treat_raw.get("output") or "")[:1500],
        "baselineOk": base_raw.get("ok"), "treatmentOk": treat_raw.get("ok"),
    }
    with PRINT_LOCK:
        ls = f"{lift:+.3f}" if isinstance(lift, float) else "  —  "
        print(f"  {pair['id']:<16} {model_row['id']:<14} rep{rep}  "
              f"base={_q(bq)} treat={_q(tq)} lift={ls} "
              f"(+{extra_tokens if extra_tokens is not None else '?'} tok)", flush=True)
    return rec


def _q(x):
    return f"{x:.3f}" if isinstance(x, (int, float)) else "  —  "


def aggregate(records, keep_threshold):
    by = {}
    for r in records:
        by.setdefault((r["pair"], r["model"]), []).append(r)
    summary = {}
    pair_rollup = {}
    dropped = 0
    for (pair, model), rs in sorted(by.items()):
        valid = [r for r in rs if r.get("lift") is not None]   # skip infra-failed cells
        dropped += len(rs) - len(valid)
        lifts = [r["lift"] for r in valid]
        summary[f"{pair}::{model}"] = {
            "pair": pair, "model": model, "n": len(valid), "skipped": len(rs) - len(valid),
            "meanBaseline": _mean([r["baselineQuality"] for r in valid]),
            "meanTreatment": _mean([r["treatmentQuality"] for r in valid]),
            "meanLift": _mean(lifts),
            "meanExtraTokens": _mean([r.get("skillExtraTokens") for r in valid]),
        }
        pair_rollup.setdefault(pair, []).extend(lifts)
    verdicts = {}
    for pair, lifts in pair_rollup.items():
        ml = _mean(lifts)
        verdicts[pair] = {
            "meanLiftAcrossModels": ml, "nValid": len(lifts),
            "verdict": "KEEP" if (ml is not None and ml >= keep_threshold)
                       else ("NEUTRAL" if (ml is not None and ml > -keep_threshold) else "DROP"),
            "keepThreshold": keep_threshold,
        }
    return {"perPairModel": summary, "verdicts": verdicts, "droppedCells": dropped}


def to_markdown(agg, meta):
    L = [f"# Skill-Refinement Benchmark (#16) — `{meta['run_id']}`\n",
         f"_Judge: **{meta['judge']}** · {meta['n']} cells · keep-threshold {meta['keep']:+.3f}_\n",
         "> Lift = treatment quality − baseline quality on the SAME rubric. The skill is in "
         "the generation prompt only; scoring uses the bare task (judge never sees the skill). "
         "`+tok` = extra tokens the skill costs per call — a skill must lift quality enough to "
         "justify that cost.\n",
         "## Verdicts (mean lift across models)\n",
         "| Skill pair | Mean lift | Verdict |", "|---|---|---|"]
    for pair, v in agg["verdicts"].items():
        ml = v["meanLiftAcrossModels"]
        L.append(f"| `{pair}` | {ml:+.3f} | **{v['verdict']}** |" if ml is not None
                 else f"| `{pair}` | — | {v['verdict']} |")
    L.append("\n## Per pair × model\n")
    L.append("| Pair | Model | n | Baseline | Treatment | Lift | +tok |")
    L.append("|---|---|---|---|---|---|---|")
    for key, s in agg["perPairModel"].items():
        ml = s["meanLift"]
        L.append(f"| `{s['pair']}` | {s['model']} | {s['n']} | {_q(s['meanBaseline'])} | "
                 f"{_q(s['meanTreatment'])} | {ml:+.3f} | {_fmt(s['meanExtraTokens'])} |"
                 if ml is not None else
                 f"| `{s['pair']}` | {s['model']} | {s['n']} | {_q(s['meanBaseline'])} | "
                 f"{_q(s['meanTreatment'])} | — | {_fmt(s['meanExtraTokens'])} |")
    return "\n".join(L) + "\n"


def _fmt(x):
    return "—" if x is None else f"{int(round(x)):,}"


def _power_limits():
    """Honor TSBC shared-Mac caps like bench.py/variants.py."""
    try:
        import json as _j
        import os as _o
        p = _j.load(open(_o.path.join(_o.path.dirname(_o.path.abspath(__file__)), ".tsbc-power.json")))
        return p.get("maxWorkers"), p.get("paused", False)
    except Exception:
        return None, False


def main():
    global _cfg
    ap = argparse.ArgumentParser(description="#16 skill-refinement benchmark")
    ap.add_argument("--config", default=None)
    ap.add_argument("--pairs", default=None, help="comma list of pair ids (default: all)")
    ap.add_argument("--models", default=None, help="comma list of model ids (default: config models)")
    ap.add_argument("--reps", type=int, default=2)
    ap.add_argument("--keep-threshold", type=float, default=0.03, dest="keep_threshold")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    _cfg = benchlib.load_config(args.config)
    adapters_cfg = _cfg["adapters"]
    pairs = load_pairs()
    if args.pairs:
        want = {x.strip() for x in args.pairs.split(",")}
        pairs = [p for p in pairs if p["id"] in want]
    models = _cfg["models"]
    if args.models:
        # resolve against the active lineup AND the staged variant catalog
        roster = {m["id"]: m for m in (_cfg.get("models", []) + _cfg.get("models_catalog", []))}
        want = [x.strip() for x in args.models.split(",") if x.strip()]
        missing = [w for w in want if w not in roster]
        if missing:
            import sys
            sys.exit(f"unknown model id(s): {', '.join(missing)}  (known: {', '.join(sorted(roster))})")
        models = [roster[w] for w in want]
    models, held_models = benchlib.filter_models_for_active_holds(models, _cfg)
    if held_models:
        print(benchlib.format_model_hold_skip(held_models))
    if not models:
        print("No skillbench models remain after active TSBC model holds; nothing to run.")
        return

    cells = [(p, m, rep) for p in pairs for m in models for rep in range(1, args.reps + 1)]
    n_cells = len(cells)
    run_id = "skill-" + datetime.now().strftime("%Y%m%d-%H%M%S")
    print(f"=== Skill-Refinement Benchmark · {run_id} ===")
    print(f"pairs: {', '.join(p['id'] for p in pairs)}")
    print(f"models: {', '.join(m['id'] for m in models)} · reps: {args.reps}")
    print(f"cells: {n_cells}  (each = baseline gen + treatment gen + 2 judge calls = {n_cells*4} CLI calls)")
    if args.dry_run:
        print("(dry run)")
        return
    print()

    timeout = _cfg["run"]["timeout_sec"]
    workers = _cfg["run"].get("max_workers", 4)
    max_workers_cap, paused = _power_limits()
    if paused:
        print("TSBC SLEEP (paused) — not running.")
        return
    if max_workers_cap is not None:
        workers = min(workers, max_workers_cap)
    print(f"  [TSBC power cap: {workers} worker(s)]")
    t0 = time.time()
    records = []
    rec_lock = threading.Lock()

    def work(cell):
        p, m, rep = cell
        try:
            r = run_cell(p, m, adapters_cfg, timeout, rep)
        except Exception as e:
            r = {"pair": p["id"], "model": m["id"], "rep": rep, "lift": None, "error": str(e)}
            with PRINT_LOCK:
                print(f"  {p['id']} {m['id']} rep{rep} EXC {e}", flush=True)
        with rec_lock:
            records.append(r)
        return r

    with ThreadPoolExecutor(max_workers=workers) as ex:
        list(ex.map(work, cells))

    agg = aggregate([r for r in records if "error" not in r], args.keep_threshold)
    out_dir = benchlib.RESULTS_DIR / run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    json.dump(records, open(out_dir / "records.json", "w"), indent=2)
    json.dump(agg, open(out_dir / "summary.json", "w"), indent=2)
    meta = {"run_id": run_id, "judge": _cfg["judge"].get("id"), "n": n_cells,
            "keep": args.keep_threshold}
    md = to_markdown(agg, meta)
    (out_dir / "report.md").write_text(md)
    try:
        import ledger
        _, total = ledger.record_skill_run(run_id)
        print(f"recorded {total} skill result(s) to shared ledger ({ledger._company()})")
    except Exception as e:
        print(f"(ledger record skipped: {e})")
    print("\n" + "=" * 60)
    print(md)
    print(f"wrote {out_dir}/report.md  ({time.time()-t0:.0f}s)")


if __name__ == "__main__":
    main()
