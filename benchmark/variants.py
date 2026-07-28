#!/usr/bin/env python3
"""
variants.py — #17 config-variant matrix: establish a role's CURRENT STANDING.

#15 (bench.py) measures the BARE base model per role (no agent-file, no skills).
#16 (skillbench.py) measures ONE candidate skill/agent-file on vs off.
#17 (this) measures the full config grid the agents actually run under, so we can
separate the marginal contribution of the AGENT-FILE from the SKILLS before doing
any role-specific tweaks:

    agent_file ∈ {bare, minimal, current}  ×  skills ∈ {none, all}   = 6 cells / model / role

  - bare    = no agent-file (the #15 base-model floor)
  - minimal = a stub agent-file (role identity + core directive only)
  - current = the role's PRODUCTION AGENTS.md (what the live agents run today)
  - none    = no skills injected
  - all     = the role's currently-materialized skill set, concatenated

Like skillbench, the config docs go in the GENERATION prompt only; SCORING uses the
bare task + rubric and the blind judge never sees the agent-file/skills — we measure
whether the config made the ANSWER better, not whether it parrots the config.

  python3 variants.py --roles cto --models grok-4.3            # one role, one model
  python3 variants.py --roles cto,ceo --max-tasks-per-role 3
  python3 variants.py --dry-run                                 # plan + CLI-call estimate
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
VARIANTS_CFG = ROOT / "variants.json"
PRINT_LOCK = threading.Lock()

# the 6-cell grid (agent_file, skills)
GRID = [("bare", "none"), ("bare", "all"),
        ("minimal", "none"), ("minimal", "all"),
        ("current", "none"), ("current", "all")]

PREFIX_INSTR = ("Apply your operating file and available skills where relevant; "
                "do not mention them in your answer.")


def _read(path):
    p = Path(path)
    return p.read_text() if p.exists() else ""


def load_skill_bundle(skills_dir):
    """Concatenate every <skill>/SKILL.md under a runtime skills dir = the 'all' variant."""
    d = Path(skills_dir)
    if not d.exists():
        return ""
    parts = []
    for sk in sorted(d.iterdir()):
        md = sk / "SKILL.md"
        if md.exists():
            parts.append(f"## SKILL: {sk.name}\n{md.read_text().strip()}")
    return "\n\n".join(parts)


def resolve_role(role, rc):
    """Resolve a role's variant bodies from variants.json config."""
    af = {
        "bare": "",
        "minimal": _read(ROOT / rc["minimalAgentFile"]) if rc.get("minimalAgentFile") else "",
        "current": _read(rc["currentAgentFile"]) if rc.get("currentAgentFile") else "",
    }
    skills = {"none": "", "all": load_skill_bundle(rc["skillsDir"]) if rc.get("skillsDir") else ""}
    return af, skills


def build_prompt(af_body, skills_body, task_prompt):
    blocks = []
    if af_body.strip():
        blocks.append(f"--- BEGIN AGENT OPERATING FILE ---\n{af_body.strip()}\n--- END AGENT OPERATING FILE ---")
    if skills_body.strip():
        blocks.append(f"--- BEGIN AVAILABLE SKILLS ---\n{skills_body.strip()}\n--- END AVAILABLE SKILLS ---")
    if not blocks:
        return task_prompt  # bare+none == the pure base-model baseline (matches bench.py)
    return "\n\n".join(blocks) + f"\n\n{PREFIX_INSTR}\n\n=== TASK ===\n{task_prompt}"


def _q(x):
    return f"{x:.3f}" if isinstance(x, (int, float)) else "  —  "


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return statistics.mean(xs) if xs else None


def run_cell(role, task, model_row, af_key, sk_key, af_bodies, sk_bodies, adapters_cfg, timeout):
    prompt = build_prompt(af_bodies[af_key], sk_bodies[sk_key], task["prompt"])
    raw = run_model(prompt, model_row, adapters_cfg, timeout)
    scored = score_run(task, raw, _cfg, adapters_cfg, timeout)
    out_tok = raw.get("outputTokens")
    quality = scored.get("quality")
    qpk = (quality / (out_tok / 1000.0)) if (quality is not None and out_tok) else None
    suite_path = ROOT / role / "suite.json"
    agent_file_sha = benchlib.sha256_text(af_bodies[af_key]) if af_bodies[af_key] else "none"
    skills_bundle_sha = benchlib.sha256_text(sk_bodies[sk_key]) if sk_bodies[sk_key] else "none"
    rec = {"role": role, "task": task["id"], "model": model_row["id"],
           "agentFile": af_key, "skills": sk_key, "quality": quality,
           "inputTokens": raw.get("inputTokens"), "outputTokens": out_tok,
           "qPer1kOut": qpk, "ok": bool(raw.get("ok")),
           "adapterType": model_row.get("adapter"),
           "effort": benchlib.model_effort_label(model_row),
           "model_reported": raw.get("model"),
           "agentFileSha256": agent_file_sha,
           "skillsBundleSha256": skills_bundle_sha,
           "suiteSha256": benchlib.file_sha256(suite_path),
           "suiteSourcePath": str(suite_path)}
    with PRINT_LOCK:
        print(f"  {role:<10} {model_row['id']:<12} af={af_key:<7} skills={sk_key:<4} "
              f"q={_q(quality)} q/1k={_q(qpk)} {task['id']}", flush=True)
    return rec


def aggregate(records):
    """Mean per (role, model, af, skills) cell."""
    by = {}
    for r in records:
        by.setdefault((r["role"], r["model"], r["agentFile"], r["skills"]), []).append(r)
    cells = {}
    for k, rs in by.items():
        valid = [r for r in rs if r.get("ok") and r.get("quality") is not None]
        cells[k] = {"n": len(valid),
                    "quality": _mean([r["quality"] for r in valid]),
                    "qPer1kOut": _mean([r["qPer1kOut"] for r in valid]),
                    "outputTokens": _mean([r["outputTokens"] for r in valid])}
    return cells


def to_markdown(cells, roles, models, meta):
    L = [f"# Config-Variant Matrix (#17) — `{meta['run_id']}`\n",
         f"_Judge: **{meta['judge']}** · current standing per role: agent-file × skills × model_\n",
         "> Each cell = mean quality (and q/1k-out) with that agent-file + skills config, scored on the "
         "bare task rubric (judge never sees the config). **floor** = bare+none (base model); "
         "**current** = current+all (what the live agents run). ΔAF = current−bare at all-skills; "
         "ΔSkills = all−none at current-AF.\n"]
    for role in roles:
        L.append(f"\n## `{role}`\n")
        for m in models:
            mid = m["id"]
            L.append(f"### {mid}\n")
            L.append("| agent-file ↓ / skills → | none | all |")
            L.append("|---|---|---|")
            for af in ("bare", "minimal", "current"):
                row = [f"| **{af}** "]
                for sk in ("none", "all"):
                    c = cells.get((role, mid, af, sk))
                    row.append(f"| {_q(c['quality'])} ({_q(c['qPer1kOut'])} q/1k) " if c else "| — ")
                L.append("".join(row) + "|")
            floor = cells.get((role, mid, "bare", "none"))
            cur = cells.get((role, mid, "current", "all"))
            bare_all = cells.get((role, mid, "bare", "all"))
            cur_none = cells.get((role, mid, "current", "none"))
            def d(a, b, key="quality"):
                if a and b and a.get(key) is not None and b.get(key) is not None:
                    return f"{a[key]-b[key]:+.3f}"
                return "—"
            L.append(f"\n_floor (bare+none) q={_q(floor['quality']) if floor else '—'} · "
                     f"current (current+all) q={_q(cur['quality']) if cur else '—'} · "
                     f"current-standing uplift {d(cur, floor)} · "
                     f"ΔAF (current−bare @all) {d(cur, bare_all)} · "
                     f"ΔSkills (all−none @current) {d(cur, cur_none)}_\n")
    return "\n".join(L) + "\n"


def main():
    global _cfg
    ap = argparse.ArgumentParser(description="#17 config-variant matrix")
    ap.add_argument("--config", default=None)
    ap.add_argument("--roles", default=None, help="comma list (default: all in variants.json)")
    ap.add_argument("--models", default=None, help="comma list of model ids (default: config models)")
    ap.add_argument("--max-tasks-per-role", type=int, default=None, dest="max_tasks")
    ap.add_argument("--cells", default=None,
                    help="comma list of af:skills cells to run, e.g. 'current:none,current:all' "
                         "(default: full 6-cell grid)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    grid = GRID
    if args.cells:
        want = set()
        for c in args.cells.split(","):
            c = c.strip()
            if ":" in c:
                af, sk = c.split(":", 1)
                want.add((af.strip(), sk.strip()))
        grid = [g for g in GRID if g in want]
        if not grid:
            print(f"--cells '{args.cells}' matched no grid cells; valid: {GRID}")
            return

    _cfg = benchlib.load_config(args.config)
    adapters_cfg = _cfg["adapters"]
    vcfg = json.load(open(VARIANTS_CFG))["roles"]

    want_roles = [r.strip() for r in args.roles.split(",")] if args.roles else list(vcfg)
    want_roles = [r for r in want_roles if r in vcfg]

    models = _cfg["models"]
    if args.models:
        roster = {m["id"]: m for m in (_cfg.get("models", []) + _cfg.get("models_catalog", []))}
        models = [roster[w.strip()] for w in args.models.split(",") if w.strip() in roster]
    models, held_models = benchlib.filter_models_for_active_holds(models, _cfg)
    if held_models:
        print(benchlib.format_model_hold_skip(held_models))
    if not models:
        print("No variant-matrix models remain after active TSBC model holds; nothing to run.")
        return

    # build the task list per role + resolve variant bodies
    plan = []
    bodies = {}
    for role in want_roles:
        suite = json.load(open(ROOT / role / "suite.json"))
        tasks = suite["tasks"]
        if args.max_tasks:
            tasks = tasks[: args.max_tasks]
        af, sk = resolve_role(role, vcfg[role])
        bodies[role] = (af, sk)
        for t in tasks:
            for m in models:
                for af_key, sk_key in grid:
                    plan.append((role, t, m, af_key, sk_key))

    run_id = "variants-" + datetime.now().strftime("%Y%m%d-%H%M%S")
    print(f"=== Config-Variant Matrix (#17) · {run_id} ===")
    print(f"roles  : {', '.join(want_roles)}")
    print(f"models : {', '.join(m['id'] for m in models)}")
    print(f"grid   : {len(grid)} cells/model (agent-file × skills){' [subset via --cells]' if args.cells else ''}")
    print(f"plan   : {len(plan)} generations + {len(plan)} judge calls = {len(plan)*2} CLI invocations")
    if args.dry_run:
        for role in want_roles:
            af, sk = bodies[role]
            print(f"  {role}: minimal-AF {len(af['minimal'])}b, current-AF {len(af['current'])}b, "
                  f"all-skills {len(sk['all'])}b")
        print("(dry run — nothing executed)")
        return
    print()

    timeout = _cfg["run"]["timeout_sec"]
    workers = _cfg["run"].get("max_workers", 4)
    # TSBC power cap (shared-Mac safety): honor .tsbc-power.json like bench.py
    try:
        import json as _j, os as _o
        _pm = _j.load(open(_o.path.join(_o.path.dirname(_o.path.abspath(__file__)), ".tsbc-power.json")))
        if _pm.get("paused"):
            print("  TSBC SLEEP (paused) — not running."); return
        if _pm.get("maxWorkers") is not None:
            workers = min(workers, _pm["maxWorkers"])
        print(f"  [TSBC power cap: {workers} worker(s)]")
    except Exception:
        pass
    records, rec_lock = [], threading.Lock()

    def work(cell):
        role, t, m, af_key, sk_key = cell
        af, sk = bodies[role]
        try:
            r = run_cell(role, t, m, af_key, sk_key, af, sk, adapters_cfg, timeout)
        except Exception as e:
            r = {"role": role, "task": t["id"], "model": m["id"], "agentFile": af_key,
                 "skills": sk_key, "quality": None, "ok": False, "error": str(e)}
            with PRINT_LOCK:
                print(f"  {role} {m['id']} af={af_key} skills={sk_key} EXC {e}", flush=True)
        with rec_lock:
            records.append(r)
        return r

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=workers) as ex:
        list(ex.map(work, plan))

    cells = aggregate(records)
    out_dir = benchlib.RESULTS_DIR / run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    json.dump(records, open(out_dir / "records.json", "w"), indent=2)
    json.dump({f"{k[0]}|{k[1]}|{k[2]}|{k[3]}": v for k, v in cells.items()},
              open(out_dir / "cells.json", "w"), indent=2)
    meta = {"run_id": run_id, "judge": _cfg["judge"].get("id")}
    md = to_markdown(cells, want_roles, models, meta)
    (out_dir / "report.md").write_text(md)
    print("\n" + "=" * 60)
    print(md)
    fails = sum(1 for r in records if not r.get("ok"))
    print(f"wrote {out_dir}/report.md  (elapsed {time.time()-t0:.0f}s, {fails}/{len(records)} failed)")

    # auto-append the with-skills cells to the shared ledger (namespaced test_class), so the
    # Drillmaster can count them + the decision matrix is queryable alongside the base model evals.
    try:
        import ledger
        _appended, _total = ledger.record_variants_run(run_id)
        print(f"       recorded {_total} variant cell(s) to shared ledger ({ledger._company()})")
    except Exception as e:
        print(f"       (ledger record skipped: {e})")


if __name__ == "__main__":
    main()
