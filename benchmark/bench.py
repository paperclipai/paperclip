#!/usr/bin/env python3
"""
bench.py — Paperclip model benchmark (#15) orchestrator.

  python3 bench.py all                 # run every role/task/model, score, report
  python3 bench.py all --roles intake  # just one role
  python3 bench.py all --models grok-4.3,grok-4.20
  python3 bench.py all --max-tasks-per-role 1   # smoke: 1 task/role
  python3 bench.py all --dry-run       # print the plan + cost estimate, run nothing
  python3 bench.py report <run-id>     # re-render report from a finished run's runs.json
  python3 bench.py list                # list role suites + task counts

Each (role,task,model) cell = one model CLI call; judged tasks add one judge call
per cell. Cells run concurrently (config.run.max_workers). Raw + scored records
land in results/<run-id>/. A clean abort leaves partial results scored.
"""

import argparse
import concurrent.futures as futures
import json
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import benchlib
import report as report_mod
from adapters import run_model
from scoring import score_run

PRINT_LOCK = threading.Lock()
_CLAUDE_LOCK = threading.Lock()
CLAUDE_BENCH_HALT_FLAG = Path(__file__).resolve().parent / ".claude-bench-halt"


def log(msg):
    with PRINT_LOCK:
        print(msg, flush=True)


def _is_claude_model(model_row):
    adapter = str(model_row.get("adapter") or "").lower()
    lane = str(model_row.get("lane") or "").lower()
    model_id = str(model_row.get("id") or "").lower()
    return adapter == "claude" or lane == "claude" or model_id.startswith("claude-")


def _claude_halt_detail():
    if not CLAUDE_BENCH_HALT_FLAG.exists():
        return "claude bench halted by budget guard"
    try:
        tail = CLAUDE_BENCH_HALT_FLAG.read_text().strip().splitlines()[-1]
    except Exception:
        tail = ""
    if tail:
        return f"claude bench halted by budget guard ({tail})"
    return "claude bench halted by budget guard"


def _claude_budget_skip(model_row):
    r = benchlib.empty_result()
    r["model"] = model_row.get("model_arg") or model_row.get("id")
    r["error"] = _claude_halt_detail()
    r["skipped"] = True
    r["skipReason"] = "claude_budget_halt"
    return r


def _adapter_quota_skip(model_row, detail, adapter_key):
    r = benchlib.empty_result()
    r["model"] = model_row.get("model_arg") or model_row.get("id")
    r["error"] = detail or f"{adapter_key} bench halted by quota guard"
    r["skipped"] = True
    r["skipReason"] = f"{adapter_key}_quota_halt"
    return r


def run_id_now():
    return "run-" + datetime.now().strftime("%Y%m%d-%H%M%S")


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _suite_meta(role):
    suite_path = benchlib.ROOT / role / "suite.json"
    return {
        "suiteSourcePath": str(suite_path),
        "suiteSha256": benchlib.file_sha256(suite_path),
    }


def select_models(cfg, only):
    if not only:
        return cfg["models"]
    # resolve --models against the active lineup AND the staged variant catalog
    roster = {m["id"]: m for m in (cfg.get("models", []) + cfg.get("models_catalog", []))}
    want = [x.strip() for x in only.split(",") if x.strip()]
    sel = [roster[w] for w in want if w in roster]
    missing = [w for w in want if w not in roster]
    if missing:
        sys.exit(f"unknown model id(s): {', '.join(missing)}  "
                 f"(known: {', '.join(sorted(roster))})")
    return sel


def select_roles(cfg, only):
    # Agentic roles (e.g. "paperclip") run real agents against live fixture issues,
    # so they are OPT-IN: never part of a default `all` sweep, only when requested
    # explicitly via --roles.
    valid = list(cfg["roles"]) + list(cfg.get("agentic_roles", []))
    if not only:
        return cfg["roles"]
    want = [x.strip() for x in only.split(",") if x.strip()]
    for r in want:
        if r not in valid:
            sys.exit(f"unknown role: {r}")
    return want


def build_cells(suites, roles, models, max_tasks, reps):
    cells = []
    for role in roles:
        tasks = suites[role].get("tasks", [])
        if max_tasks:
            tasks = tasks[:max_tasks]
        for task in tasks:
            judged = bool((task.get("rubric", {}).get("judge", {}) or {}).get("criteria"))
            for m in models:
                for rep in range(1, reps + 1):
                    cells.append({
                        "role": role,
                        "task": task,
                        "model": m,
                        "judged": judged,
                        "rep": rep,
                        "reps": reps,
                    })
    return cells


def plan_summary(cells, models, judge_id):
    gen_calls = len(cells)
    judge_calls = sum(1 for c in cells if c["judged"])
    by_lane = {}
    for c in cells:
        by_lane[c["model"]["id"]] = by_lane.get(c["model"]["id"], 0) + 1
    lines = [
        f"  generations : {gen_calls} model calls",
        f"  judge calls : {judge_calls} (all via judge={judge_id})",
        f"  total CLI    : {gen_calls + judge_calls} invocations",
        "  per-model generations: " + ", ".join(f"{k}={v}" for k, v in sorted(by_lane.items())),
    ]
    return "\n".join(lines)


def _power_limits():
    """Read TSBC power mode (.tsbc-power.json) -> (maxWorkersCap|None, heavyTasksAllowed, paused).
    Absent/unreadable = unconstrained, so non-TSBC use of bench.py is unaffected."""
    try:
        import json as _j, os as _o
        p = _j.load(open(_o.path.join(_o.path.dirname(_o.path.abspath(__file__)), ".tsbc-power.json")))
        return p.get("maxWorkers"), p.get("heavyTasksAllowed", True), p.get("paused", False)
    except Exception:
        return None, True, False


def execute(cells, cfg, run_dir):
    raw_dir = run_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    adapters_cfg = cfg["adapters"]
    suite_meta_by_role = {
        role: _suite_meta(role)
        for role in {c["role"] for c in cells}
    }
    # Agentic cells are heavy LIVE runs against the shared server; use the lower
    # paperclip-lane concurrency + higher per-cell timeout when any are present.
    pc = cfg.get("paperclip", {}) or {}
    has_agentic = any(c["role"] in set(cfg.get("agentic_roles", [])) for c in cells)
    if has_agentic:
        timeout = pc.get("cellTimeoutSec", cfg["run"]["timeout_sec"])
        workers = pc.get("maxWorkers", cfg["run"].get("max_workers", 4))
        # self-heal: clear any orphan fixtures a prior killed run left behind so
        # they never accumulate / strand board-action cards in the live company.
        try:
            import paperclip_lane
            swept = paperclip_lane.sweep_bench_fixtures(cfg)
            if swept:
                print(f"  pre-run sweep: cancelled {swept} orphan bench fixture(s)", flush=True)
        except Exception as e:
            print(f"  pre-run sweep skipped: {e}", flush=True)
    else:
        timeout = cfg["run"]["timeout_sec"]
        workers = cfg["run"].get("max_workers", 4)

    # --- TSBC power mode: shared-Mac safety (cap concurrency, gate heavy tasks, sleep) ---
    cap, heavy_ok, paused = _power_limits()
    if paused:
        print("  TSBC SLEEP (paused) — not running this sweep.", flush=True)
        return []
    if cap is not None:
        workers = min(workers, cap)
    if has_agentic and not heavy_ok:
        ag = set(cfg.get("agentic_roles", []))
        dropped = [c for c in cells if c["role"] in ag]
        cells = [c for c in cells if c["role"] not in ag]
        print(f"  TSBC low-power: heavy agentic disabled — skipped {len(dropped)} agentic cell(s), "
              f"running {len(cells)} single-pass cell(s) at {workers} worker(s).", flush=True)
        if not cells:
            return []
    # interleave cells across adapters so concurrent workers rarely double-hit one
    # adapter/sub (the 'one model per adapter at a time' intent)
    from collections import defaultdict, deque
    _by_lane = defaultdict(deque)
    for c in cells:
        _by_lane[c["model"]["lane"]].append(c)
    _interleaved = []
    while any(_by_lane.values()):
        for lane in list(_by_lane):
            if _by_lane[lane]:
                _interleaved.append(_by_lane[lane].popleft())
    cells = _interleaved

    total = len(cells)
    done = [0]
    runs = []
    runs_lock = threading.Lock()
    adapter_quota_halts = {}
    adapter_quota_halts_lock = threading.Lock()

    def work(cell):
        role, task, m = cell["role"], cell["task"], cell["model"]
        tag = f"{role}/{task['id']} @ {m['id']}"
        adapter_key = str(m.get("adapter") or "").strip() or None
        pass_started_at = now_iso()
        try:
            with adapter_quota_halts_lock:
                adapter_halt = adapter_quota_halts.get(adapter_key) if adapter_key else None
            if adapter_halt:
                raw = _adapter_quota_skip(m, adapter_halt, adapter_key)
            elif _is_claude_model(m):
                with _CLAUDE_LOCK:
                    if CLAUDE_BENCH_HALT_FLAG.exists():
                        raw = _claude_budget_skip(m)
                    elif role in cfg.get("agentic_roles", []):
                        import paperclip_lane
                        raw = paperclip_lane.run_case(task, m, cfg, timeout)
                    else:
                        raw = run_model(task["prompt"], m, adapters_cfg, timeout)
            elif role in cfg.get("agentic_roles", []):
                import paperclip_lane
                raw = paperclip_lane.run_case(task, m, cfg, timeout)
            else:
                raw = run_model(task["prompt"], m, adapters_cfg, timeout)
            if adapter_key and raw.get("quotaError"):
                raw["skipped"] = True
                raw["skipReason"] = f"{adapter_key}_quota_halt"
                with adapter_quota_halts_lock:
                    adapter_quota_halts.setdefault(
                        adapter_key,
                        raw.get("error") or f"{adapter_key} bench halted by quota guard",
                    )
            scored = score_run(task, raw, cfg, adapters_cfg, timeout)
        except Exception as e:  # never let one cell kill the sweep
            raw = benchlib.empty_result()
            raw["error"] = f"harness exception: {e}"
            raw["failureReason"] = "tool-error"
            scored = {"quality": None, "qualityPer1kTokens": None,
                      "deterministicScore": None, "judgeScore": None}
        pass_finished_at = now_iso()
        rec = {
            "role": role, "task_id": task["id"], "task_title": task.get("title"),
            "model_id": m["id"], "model_label": m["label"], "lane": m["lane"],
            "rep": int(cell.get("rep") or 1),
            "reps": int(cell.get("reps") or 1),
            "passStartedAt": pass_started_at,
            "passFinishedAt": pass_finished_at,
            "adapterType": raw.get("benchAdapterType") or m.get("adapter"),
            "effort": benchlib.model_effort_label(m),
            "ok": raw.get("ok"), "error": raw.get("error"),
            "failureReason": raw.get("failureReason"),
            "output": raw.get("output"),
            "model_reported": raw.get("model"),
            "servedModel": raw.get("model") or "unknown",
            "servedModelSelfReport": raw.get("servedModelSelfReport"),
            "servedModelVerified": bool(raw.get("servedModelVerified")),
            "servedModelMismatch": bool(raw.get("servedModelMismatch")),
            "requestedModelId": raw.get("requestedModelId") or m["id"],
            "requestedModelArg": raw.get("requestedModelArg") or m.get("model_arg"),
            "trueModelId": raw.get("model") or m.get("model_arg") or m["id"],
            "benchAgentId": raw.get("benchAgentId"),
            "benchAgentName": raw.get("benchAgentName"),
            "benchAgentSource": raw.get("benchAgentSource"),
            "benchAdapterType": raw.get("benchAdapterType") or m.get("adapter"),
            "inputTokens": raw.get("inputTokens"), "outputTokens": raw.get("outputTokens"),
            "totalTokens": raw.get("totalTokens"), "tokensEstimated": raw.get("tokensEstimated"),
            "costUsd": raw.get("costUsd"), "wallMs": raw.get("wallMs"),
            "taskWallMs": raw.get("taskWallMs"),
            "selfReportWallMs": raw.get("selfReportWallMs"),
            "selfReportInputTokens": raw.get("selfReportInputTokens"),
            "selfReportOutputTokens": raw.get("selfReportOutputTokens"),
            "stderrTail": raw.get("stderrTail"),
            "agentFileSha256": "none",
            "skillsBundleSha256": "none",
            "suiteSha256": suite_meta_by_role[role]["suiteSha256"],
            "suiteSourcePath": suite_meta_by_role[role]["suiteSourcePath"],
            "skipped": bool(raw.get("skipped")),
            "skipReason": raw.get("skipReason"),
        }
        rec.update(scored)
        # persist per-cell raw
        fname = (
            f"{benchlib.slugify(role)}__{benchlib.slugify(task['id'])}"
            f"__rep-{int(cell.get('rep') or 1):02d}__{benchlib.slugify(m['id'])}.json"
        )
        with open(raw_dir / fname, "w") as f:
            json.dump(rec, f, indent=2)
        with runs_lock:
            runs.append(rec)
        with PRINT_LOCK:
            done[0] += 1
            q = rec.get("quality")
            qs = f"q={q:.2f}" if isinstance(q, (int, float)) else "q=  — "
            status = "SKIP" if rec.get("skipped") else ("ok " if rec["ok"] else "FAIL")
            tok = rec.get("totalTokens")
            toks = f"{tok}t" if tok else "?t"
            print(f"  [{done[0]:>3}/{total}] {status} {qs} {toks:>8} {rec.get('wallMs') or '?'}ms  {tag}"
                  + (f"  !! {rec['error']}" if rec.get("error") else ""), flush=True)
        return rec

    with futures.ThreadPoolExecutor(max_workers=workers) as ex:
        list(ex.map(work, cells))
    return runs


def finalize(runs, cfg, run_dir, run_id, started):
    finished = now_iso()
    for run in runs:
        run.setdefault("runStartedAt", started)
        run.setdefault("runFinishedAt", finished)
    runs.sort(key=lambda r: (r["role"], r["task_id"], r["model_id"], int(r.get("rep") or 1)))
    with open(run_dir / "runs.json", "w") as f:
        json.dump(runs, f, indent=2)

    rep = report_mod.aggregate(runs, cfg)
    non_skipped = [r for r in runs if not r.get("skipped")]
    present_roles = sorted({r["role"] for r in runs})
    present_models = sorted({r["model_id"] for r in runs})
    roster = {m["id"]: m for m in (cfg.get("models", []) + cfg.get("models_catalog", []))}
    meta = {"finished_at": finished, "started_at": started,
            "n_runs": len(runs),
            "n_fail": sum(1 for r in non_skipped if not r["ok"]),
            "n_skipped": sum(1 for r in runs if r.get("skipped")),
            "run_id": run_id,
            "suiteShaByRole": {role: _suite_meta(role)["suiteSha256"] for role in present_roles},
            "suiteSourcePathByRole": {role: _suite_meta(role)["suiteSourcePath"] for role in present_roles},
            "modelEffortById": {
                model_id: benchlib.model_effort_label(roster[model_id])
                for model_id in present_models
                if model_id in roster
            },
            "reps": min((int(r.get("reps") or 1) for r in runs), default=1),
            "minRepsForDecision": benchlib.min_reps_for_decision(cfg),
            "adapterTypeById": {
                model_id: roster[model_id].get("adapter")
                for model_id in present_models
                if model_id in roster
            }}
    rep["meta"] = meta
    with open(run_dir / "recommendations.json", "w") as f:
        json.dump(rep, f, indent=2)
    md = report_mod.to_markdown(rep, run_id, meta)
    with open(run_dir / "report.md", "w") as f:
        f.write(md)
    return rep, md, meta


def cmd_all(args, cfg):
    roles = select_roles(cfg, args.roles)
    models = select_models(cfg, args.models)
    models, held_models = benchlib.filter_models_for_active_holds(models, cfg)
    if held_models:
        log(benchlib.format_model_hold_skip(held_models))
    if not models:
        log("No benchmark models remain after active TSBC model holds; nothing to run.")
        return
    reps = args.reps if args.reps is not None else benchlib.configured_reps(cfg)
    if reps < 1:
        sys.exit("--reps must be >= 1")
    suites = benchlib.load_all_suites(roles)
    cells = build_cells(suites, roles, models, args.max_tasks_per_role, reps)

    run_id = run_id_now()
    log(f"=== Paperclip Model Benchmark · {run_id} ===")
    log(f"roles  : {', '.join(roles)}")
    log(f"models : {', '.join(m['id'] for m in models)}")
    log(f"reps   : {reps} (decision floor {benchlib.min_reps_for_decision(cfg)})")
    log(f"judge  : {cfg['judge'].get('id')}")
    log("plan:\n" + plan_summary(cells, models, cfg["judge"].get("id")))
    if args.dry_run:
        log("\n(dry run — nothing executed)")
        return
    _cap, _heavy_ok, _paused = _power_limits()
    _base = cfg['run'].get('max_workers', 4)
    _eff = min(_base, _cap) if _cap is not None else _base
    _pm = f" [TSBC power: {_cap} cap]" if _cap is not None and _cap < _base else ""
    log(f"\nrunning {len(cells)} cells with {_eff} worker(s){_pm} "
        f"(timeout {cfg['run']['timeout_sec']}s each)…\n")

    started = now_iso()
    run_dir = benchlib.RESULTS_DIR / run_id
    t0 = time.time()
    try:
        runs = execute(cells, cfg, run_dir)
    except KeyboardInterrupt:
        log("\n!! interrupted — finalizing partial results")
        runs = _load_partial(run_dir)
    rep, md, meta = finalize(runs, cfg, run_dir, run_id, started)

    log("\n" + "=" * 60)
    log(md)
    log(f"wrote: {run_dir}/report.md")
    log(f"       {run_dir}/recommendations.json   (machine-readable, for tiering #9)")
    _record_to_ledger(run_id, "bench")
    log(f"elapsed {time.time()-t0:.0f}s, {meta['n_fail']}/{meta['n_runs']} failed"
        + (f", {meta['n_skipped']} skipped" if meta.get("n_skipped") else ""))


def _record_to_ledger(run_id, kind):
    """Auto-append this run's findings to the shared cross-company ledger."""
    try:
        import ledger
        n, total = (ledger.record_skill_run(run_id) if kind == "skill"
                    else ledger.record_bench_run(run_id))
        log(f"       recorded {total} result(s) to shared ledger ({ledger._company()})")
    except Exception as e:
        log(f"       (ledger record skipped: {e})")


def _load_partial(run_dir):
    raw_dir = run_dir / "raw"
    runs = []
    if raw_dir.exists():
        for p in raw_dir.glob("*.json"):
            try:
                runs.append(json.load(open(p)))
            except Exception:
                pass
    return runs


def cmd_report(args, cfg):
    run_dir = benchlib.RESULTS_DIR / args.run_id
    runs_path = run_dir / "runs.json"
    if not runs_path.exists():
        sys.exit(f"no runs.json at {runs_path}")
    runs = json.load(open(runs_path))
    rep, md, meta = finalize(runs, cfg, run_dir, args.run_id, now_iso())
    log(md)
    log(f"re-wrote {run_dir}/report.md")


def cmd_list(args, cfg):
    for role in cfg["roles"]:
        try:
            suite = benchlib.load_suite(role)
        except FileNotFoundError:
            log(f"{role:<10} (no suite.json)")
            continue
        tasks = suite.get("tasks", [])
        judged = sum(1 for t in tasks if (t.get("rubric", {}).get("judge", {}) or {}).get("criteria"))
        log(f"{role:<10} {len(tasks)} tasks ({judged} judged, {len(tasks)-judged} deterministic-only)")
        for t in tasks:
            log(f"   - {t['id']:<26} {t.get('title','')}")


def main():
    ap = argparse.ArgumentParser(description="Paperclip model benchmark (#15)")
    ap.add_argument("--config", default=None)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_all = sub.add_parser("all", help="run + score + report")
    p_all.add_argument("--roles", default=None, help="comma list (default: all)")
    p_all.add_argument("--models", default=None, help="comma list of model ids (default: all)")
    p_all.add_argument("--max-tasks-per-role", type=int, default=None, dest="max_tasks_per_role")
    p_all.add_argument("--reps", type=int, default=None,
                       help="repetitions per role/task/model cell (default: config run.reps)")
    p_all.add_argument("--dry-run", action="store_true")

    p_rep = sub.add_parser("report", help="re-render report from a finished run")
    p_rep.add_argument("run_id")

    sub.add_parser("list", help="list role suites")

    args = ap.parse_args()
    cfg = benchlib.load_config(args.config)

    if args.cmd == "all":
        cmd_all(args, cfg)
    elif args.cmd == "report":
        cmd_report(args, cfg)
    elif args.cmd == "list":
        cmd_list(args, cfg)


if __name__ == "__main__":
    main()
