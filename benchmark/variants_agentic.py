#!/usr/bin/env python3
"""
variants_agentic.py — AGENTIC config-variant eval for the antigravity (Gemini) lane.

WHY THIS EXISTS
  The single-shot #17 matrix (variants.py) concatenates a role's ~10 skill bodies into one
  ~65k-char prompt. claude/grok/codex answer that fine, but `agy` (Antigravity / Gemini) in
  print mode CANNOT — it derails into tool-use (false low scores) or hangs to timeout, even
  with --dangerously-skip-permissions --sandbox. The 65k concatenated prompt itself is the
  problem, and agy has no --allowedTools "" equivalent to force a direct answer. So gemini is
  excluded from the single-shot drill.

  But that is not how the live fleet uses Gemini. The production antigravity_local adapter
  (packages/adapters/antigravity-local/src/server/execute.ts) mounts the desired skills as
  FILES under <cwd>/.paperclip/skills/<name>/, sends a SMALL prompt that points the agent at
  them, and runs `agy --print --dangerously-skip-permissions` so the agent reads the skill
  files on demand. This script measures the SAME current:none vs current:all grid that way —
  the production-faithful AGENTIC frame. Validated: clean on-spec answers, no hang.

METHOD (kept identical to variants.py where it matters)
  - The agent-file + skills go into the GENERATION environment only; SCORING uses the bare
    task + rubric and the blind judge never sees the config — we measure whether the config
    made the ANSWER better, not whether it parrots the config.
  - Results land in their OWN ledger namespace 'agentic-variant:<role>:<af>-<skills>', never
    mixed with the single-shot 'variant:' cells (different methodology — compare separately).

Antigravity-only by design (the lane that needs it). Non-antigravity models are skipped.

  python3 variants_agentic.py --roles content --models gemini-flash-low --max-tasks-per-role 1
  python3 variants_agentic.py --roles content,cv-review --models gemini-flash,gemini-flash-low
  python3 variants_agentic.py --dry-run
"""

import argparse
import json
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
import tempfile

import benchlib
import variants  # reuse resolve_role / aggregate / _q / PREFIX_INSTR / GRID
from adapters import run_antigravity_agentic
from scoring import score_run

ROOT = benchlib.ROOT
VARIANTS_CFG = ROOT / "variants.json"
PRINT_LOCK = threading.Lock()

# the antigravity print-mode wait; the subprocess timeout (config.run.timeout_sec) is the backstop.
AGY_PRINT_TIMEOUT = "4m0s"

# default to the production cell + its no-skills control (the meaningful ΔSkills pair)
DEFAULT_CELLS = [("current", "none"), ("current", "all")]


def stage_skills(cwd, skills_dir):
    """Copy each <skill>/ (dir containing SKILL.md) into <cwd>/.paperclip/skills/<name>/, mirroring
    the production antigravity_local adapter. Returns the staged skill names (for the prompt note)."""
    d = Path(skills_dir)
    if not d.exists():
        return [], None
    root = Path(cwd) / ".paperclip" / "skills"
    root.mkdir(parents=True, exist_ok=True)
    staged = []
    for sk in sorted(d.iterdir()):
        if (sk / "SKILL.md").exists():
            shutil.copytree(sk, root / sk.name, dirs_exist_ok=True)
            staged.append(sk.name)
    return staged, root


def build_agentic_prompt(af_body, staged_names, task_prompt):
    """SMALL prompt: agent-file + a one-line 'skills are mounted as files' note + the task.
    NOT the concatenated skill bodies — the agent reads .paperclip/skills/<name>/SKILL.md on demand."""
    blocks = []
    if af_body.strip():
        blocks.append(f"--- BEGIN AGENT OPERATING FILE ---\n{af_body.strip()}\n--- END AGENT OPERATING FILE ---")
    if staged_names:
        blocks.append(
            f"Paperclip runtime skills are available as files in ./.paperclip/skills/ "
            f"({len(staged_names)} skills: {', '.join(staged_names)}). "
            f"Read and apply the skill instructions that match the task.")
    if not blocks:
        return task_prompt  # bare+none == pure base-model baseline
    return "\n\n".join(blocks) + f"\n\n{variants.PREFIX_INSTR}\n\n=== TASK ===\n{task_prompt}"


def run_cell_agentic(role, task, model_row, af_key, sk_key, af_bodies, skills_dir,
                     skills_bundle_body,
                     adapters_cfg, timeout, halt):
    """One agentic cell. Stages skills (if sk=all) into a temp cwd, runs agy agentically there,
    scores on the bare rubric. Sets the halt Event on a quota/auth failure so the run stops."""
    if halt.is_set():
        return {"role": role, "task": task["id"], "model": model_row["id"], "agentFile": af_key,
                "skills": sk_key, "quality": None, "ok": False, "error": "halted (quota)"}
    with tempfile.TemporaryDirectory(prefix=f"agv-{role}-") as cwd:
        staged = []
        if sk_key == "all":
            staged, _ = stage_skills(cwd, skills_dir)
        prompt = build_agentic_prompt(af_bodies[af_key], staged, task["prompt"])
        extra = ["--print-timeout", AGY_PRINT_TIMEOUT]
        raw = run_antigravity_agentic(prompt, model_row.get("model_arg"), extra, timeout, cwd)
        if raw.get("quotaError"):
            halt.set()
        scored = score_run(task, raw, _cfg, adapters_cfg, timeout)
    out_tok = raw.get("outputTokens")
    quality = scored.get("quality")
    qpk = (quality / (out_tok / 1000.0)) if (quality is not None and out_tok) else None
    suite_path = ROOT / role / "suite.json"
    agent_file_sha = benchlib.sha256_text(af_bodies[af_key]) if af_bodies[af_key] else "none"
    skills_bundle_sha = benchlib.sha256_text(skills_bundle_body) if sk_key == "all" and skills_bundle_body else "none"
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
           "suiteSourcePath": str(suite_path),
           "stagedSkills": len(staged), "promptChars": len(prompt),
           "wallMs": raw.get("wallMs"), "error": raw.get("error"),
           # keep a truncated output sample so derails/flakes (occasional agy 0.0s) are debuggable
           "outputSample": (raw.get("output") or "")[:800]}
    with PRINT_LOCK:
        flag = " [QUOTA]" if raw.get("quotaError") else (" [FAIL]" if not raw.get("ok") else "")
        print(f"  {role:<10} {model_row['id']:<16} af={af_key:<7} skills={sk_key:<4} "
              f"q={variants._q(quality)} q/1k={variants._q(qpk)} "
              f"{(raw.get('wallMs') or 0)//1000}s {task['id']}{flag}", flush=True)
    return rec


def to_markdown(cells, roles, models, meta):
    L = [f"# Agentic Config-Variant Matrix — `{meta['run_id']}`\n",
         f"_Judge: **{meta['judge']}** · AGENTIC frame (skills mounted as files, agy --print "
         f"--dangerously-skip-permissions) · scored on the bare task rubric (judge blind to config)._\n",
         "> current:all = production config (agent-file + skills-as-files). "
         "ΔSkills = all−none at current-AF. Separate namespace from the single-shot `variant:` cells.\n"]
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
                    row.append(f"| {variants._q(c['quality'])} ({variants._q(c['qPer1kOut'])} q/1k) " if c else "| — ")
                L.append("".join(row) + "|")
            cur = cells.get((role, mid, "current", "all"))
            cur_none = cells.get((role, mid, "current", "none"))
            def d(a, b, key="quality"):
                if a and b and a.get(key) is not None and b.get(key) is not None:
                    return f"{a[key]-b[key]:+.3f}"
                return "—"
            L.append(f"\n_current (current+all) q={variants._q(cur['quality']) if cur else '—'} · "
                     f"ΔSkills (all−none @current) {d(cur, cur_none)}_\n")
    return "\n".join(L) + "\n"


def main():
    global _cfg
    ap = argparse.ArgumentParser(description="agentic config-variant matrix (antigravity lane)")
    ap.add_argument("--config", default=None)
    ap.add_argument("--roles", default=None, help="comma list (default: all in variants.json)")
    ap.add_argument("--models", default=None, help="comma list of model ids (default: all antigravity models in config)")
    ap.add_argument("--max-tasks-per-role", type=int, default=None, dest="max_tasks")
    ap.add_argument("--cells", default=None,
                    help="comma list of af:skills cells (default: current:none,current:all)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    grid = DEFAULT_CELLS
    if args.cells:
        want = set()
        for c in args.cells.split(","):
            c = c.strip()
            if ":" in c:
                af, sk = c.split(":", 1)
                want.add((af.strip(), sk.strip()))
        grid = [g for g in variants.GRID if g in want]
        if not grid:
            print(f"--cells '{args.cells}' matched no grid cells; valid: {variants.GRID}")
            return

    _cfg = benchlib.load_config(args.config)
    adapters_cfg = _cfg["adapters"]
    vcfg = json.load(open(VARIANTS_CFG))["roles"]

    want_roles = [r.strip() for r in args.roles.split(",")] if args.roles else list(vcfg)
    want_roles = [r for r in want_roles if r in vcfg]

    roster = {m["id"]: m for m in (_cfg.get("models", []) + _cfg.get("models_catalog", []))}
    if args.models:
        models = [roster[w.strip()] for w in args.models.split(",") if w.strip() in roster]
    else:
        models = [m for m in _cfg.get("models", []) if m.get("adapter") == "antigravity"]
    # antigravity-only by design
    skipped = [m["id"] for m in models if m.get("adapter") != "antigravity"]
    models = [m for m in models if m.get("adapter") == "antigravity"]
    if skipped:
        print(f"  [skipping non-antigravity models (this eval is antigravity-only): {', '.join(skipped)}]")
    models, held_models = benchlib.filter_models_for_active_holds(models, _cfg)
    if held_models:
        print(benchlib.format_model_hold_skip(held_models))
    if not models:
        print("  no antigravity models remain after TSBC model guards — nothing to do.")
        return

    plan = []
    bodies = {}
    skills_dirs = {}
    skills_bundles = {}
    for role in want_roles:
        suite = json.load(open(ROOT / role / "suite.json"))
        tasks = suite["tasks"]
        if args.max_tasks:
            tasks = tasks[: args.max_tasks]
        af, _sk = variants.resolve_role(role, vcfg[role])
        bodies[role] = af
        skills_dirs[role] = vcfg[role].get("skillsDir", "")
        skills_bundles[role] = variants.load_skill_bundle(skills_dirs[role]) if skills_dirs[role] else ""
        for t in tasks:
            for m in models:
                for af_key, sk_key in grid:
                    plan.append((role, t, m, af_key, sk_key))

    run_id = "agentic-variants-" + datetime.now().strftime("%Y%m%d-%H%M%S")
    print(f"=== Agentic Config-Variant Matrix · {run_id} ===")
    print(f"roles  : {', '.join(want_roles)}")
    print(f"models : {', '.join(m['id'] for m in models)} (antigravity)")
    print(f"grid   : {len(grid)} cells/model: {['%s:%s' % g for g in grid]}")
    print(f"plan   : {len(plan)} agentic generations + {len(plan)} judge calls")
    if args.dry_run:
        for role in want_roles:
            af = bodies[role]
            d = Path(skills_dirs[role])
            nsk = len([s for s in d.iterdir() if (s / 'SKILL.md').exists()]) if d.exists() else 0
            print(f"  {role}: current-AF {len(af['current'])}b, skills-dir {nsk} skills ({skills_dirs[role]})")
        print("(dry run — nothing executed)")
        return
    print()

    timeout = _cfg["run"]["timeout_sec"]
    workers = _cfg["run"].get("max_workers", 4)
    # TSBC power cap (shared-Mac safety) — honor .tsbc-power.json like variants.py/bench.py
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
    # agy is also globally capped at _AGY_SEM(2); keep workers modest regardless.
    workers = max(1, min(workers, 2))

    records, rec_lock = [], threading.Lock()
    halt = threading.Event()  # set on a quota/auth failure -> stop submitting real agy work

    def work(cell):
        role, t, m, af_key, sk_key = cell
        try:
            r = run_cell_agentic(role, t, m, af_key, sk_key, bodies[role], skills_dirs[role],
                                 skills_bundles[role],
                                 adapters_cfg, timeout, halt)
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

    if halt.is_set():
        print("\n  ⚠ HALTED: agy reported a quota/rate-limit/auth failure — stopped early to avoid "
              "burning the weekly Gemini quota. Re-run later; completed cells are recorded.")

    cells = variants.aggregate(records)
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

    # record the agentic cells to the shared ledger under the dedicated 'agentic-variant:' namespace
    try:
        import ledger
        _appended, _total = ledger.record_agentic_variants_run(run_id)
        print(f"       recorded {_total} agentic-variant cell(s) to shared ledger ({ledger._company()})")
    except Exception as e:
        print(f"       (ledger record skipped: {e})")


if __name__ == "__main__":
    main()
