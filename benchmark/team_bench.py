#!/usr/bin/env python3
"""
team_bench.py — Workstream-D: does a TEAM of fast agents splitting a long-form draft
beat ONE drafter? (TSBC vision doc, depends on the long-form team/suite.json.)

Two modes per (task):
  SINGLE : one drafter model writes the whole deliverable in a single pass (the baseline).
  TEAM   : planner decomposes the task into N section briefs -> N worker agents draft their
           section concurrently (round-robin across --workers for cross-model load-share) ->
           an assembler stitches the sections into one seamless deliverable.

Both outputs are scored by the SAME blind judge on the bare task rubric (scoring.score_run);
the judge never sees that one was team-assembled — we measure whether the final ANSWER is
better, not the process. The team's internal planner/worker/assembler prompts are process
(analogous to skills/agent-file living in the generation env only).

We compare quality, q/1k-OUTPUT (team output = planner+workers+assembler, so the team pays
for its coordination), and wall-time (team workers run in parallel, so team can WIN wall-time
even when it loses tokens). Recorded to the shared ledger under namespace
  team:<domain>:single-<model>   and   team:<domain>:team<N>-<worker-stems>
so it never mixes with the model/skill/variant evals.

  python3 team_bench.py --single claude-haiku --workers claude-haiku --dry-run
  python3 team_bench.py --single gemini-flash-low --workers grok-4.3,gemini-flash-low --team-size 3
  python3 team_bench.py --roles book-chapter --single claude-haiku --max-tasks 1   # smoke
"""

import argparse
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

import benchlib
from adapters import run_model
from scoring import score_run

ROOT = benchlib.ROOT
SUITE = ROOT / "team" / "suite.json"
PRINT_LOCK = threading.Lock()

PLANNER_INSTR = (
    "You are the planning lead for a writing team. Decompose the task below into {n} SELF-CONTAINED, "
    "NON-OVERLAPPING sections that together fully satisfy it, in order. For each section give a short "
    "heading and a one-to-two sentence brief (what it must cover, and roughly how many words). The "
    "sections must tile the whole deliverable with no gaps and no duplication.\n"
    "Return ONLY a JSON array, no prose: [{{\"heading\": \"...\", \"brief\": \"...\", \"words\": <int>}}, ...]"
)
WORKER_INSTR = (
    "You are a section writer on a team drafting one deliverable. Write ONLY your assigned section — "
    "do NOT write an intro to the whole piece, do NOT repeat other sections, do NOT add notes. Match the "
    "voice/POV/tense the task implies and write so your section will sit seamlessly between its neighbours. "
    "Return ONLY your section's text (no heading label, no commentary)."
)
ASSEMBLER_INSTR = (
    "You are the editor assembling a team's sections into ONE finished, seamless deliverable that fully "
    "satisfies the original task. Smooth the transitions, remove any redundancy or contradictory setups "
    "between sections, ensure consistent voice/POV/tense throughout, and cut section-label artifacts. Do "
    "NOT summarise or shorten the substance. Return ONLY the final deliverable text."
)


def _stem(model_id):
    return model_id.replace("gemini-", "g").replace("claude-", "c").replace("grok-", "k").replace("gpt-", "x")


def _q(x):
    return f"{x:.3f}" if isinstance(x, (int, float)) else "  —  "


def resolve_models(cfg, ids):
    roster = {m["id"]: m for m in (cfg.get("models", []) + cfg.get("models_catalog", []))}
    out = []
    for i in ids:
        i = i.strip()
        if i in roster:
            out.append(roster[i])
    return out


def _planner_decompose(task, planner_row, n, adapters_cfg, timeout):
    prompt = (PLANNER_INSTR.format(n=n) + "\n\n=== TASK ===\n" + task["prompt"].strip()
              + "\n\n=== END TASK ===\nReturn the JSON array now.")
    raw = run_model(prompt, planner_row, adapters_cfg, timeout)
    parsed = benchlib.extract_json(raw.get("output"))
    sections = []
    if isinstance(parsed, list):
        for s in parsed:
            if isinstance(s, dict) and (s.get("heading") or s.get("brief")):
                sections.append({"heading": str(s.get("heading") or "").strip(),
                                 "brief": str(s.get("brief") or "").strip(),
                                 "words": s.get("words")})
    return sections, raw


def _draft_section(task, section, idx, total, all_headings, worker_row, adapters_cfg, timeout):
    tgt = f" (~{section['words']} words)" if section.get("words") else ""
    prompt = (WORKER_INSTR
              + f"\n\n=== ORIGINAL TASK (for context) ===\n{task['prompt'].strip()}"
              + f"\n\n=== THE FULL PIECE'S SECTIONS (in order) ===\n"
              + "\n".join(f"{j+1}. {h}" for j, h in enumerate(all_headings))
              + f"\n\n=== YOUR SECTION: #{idx+1}/{total} — {section['heading']} ===\n"
              + f"Brief: {section['brief']}{tgt}\n\nWrite your section now.")
    return run_model(prompt, worker_row, adapters_cfg, timeout)


def _assemble(task, sections, drafts, assembler_row, adapters_cfg, timeout):
    body = "\n\n".join(f"--- SECTION {i+1}: {sections[i]['heading']} ---\n{d}"
                       for i, d in enumerate(drafts))
    prompt = (ASSEMBLER_INSTR
              + f"\n\n=== ORIGINAL TASK ===\n{task['prompt'].strip()}"
              + f"\n\n=== THE TEAM'S SECTIONS ===\n{body}"
              + "\n\n=== END ===\nReturn the finished deliverable now.")
    return run_model(prompt, assembler_row, adapters_cfg, timeout)


def run_single(task, model_row, adapters_cfg, timeout):
    t0 = time.time()
    raw = run_model(task["prompt"], model_row, adapters_cfg, timeout)
    return {"output": raw.get("output") or "", "ok": bool(raw.get("ok")),
            "inputTokens": raw.get("inputTokens"), "outputTokens": raw.get("outputTokens"),
            "totalTokens": raw.get("totalTokens"),
            "wallMs": int((time.time() - t0) * 1000), "calls": 1}


def run_team(task, planner_row, worker_rows, assembler_row, n, adapters_cfg, timeout, workers):
    t0 = time.time()
    sections, prun = _planner_decompose(task, planner_row, n, adapters_cfg, timeout)
    if len(sections) < 2:
        return {"output": "", "ok": False, "error": f"planner produced {len(sections)} section(s)",
                "outputTokens": prun.get("outputTokens"), "inputTokens": prun.get("inputTokens"),
                "totalTokens": prun.get("totalTokens"), "wallMs": int((time.time() - t0) * 1000),
                "calls": 1, "sections": len(sections)}
    headings = [s["heading"] or f"Section {i+1}" for i, s in enumerate(sections)]
    drafts_runs = [None] * len(sections)

    def _w(i):
        wr = worker_rows[i % len(worker_rows)]  # round-robin for cross-model load-share
        drafts_runs[i] = _draft_section(task, sections[i], i, len(sections), headings, wr, adapters_cfg, timeout)

    wpar = max(1, min(workers, len(sections)))
    section_t0 = time.time()
    with ThreadPoolExecutor(max_workers=wpar) as ex:
        list(ex.map(_w, range(len(sections))))
    section_wall = int((time.time() - section_t0) * 1000)
    drafts = [(r.get("output") or "") for r in drafts_runs]
    arun = _assemble(task, sections, drafts, assembler_row, adapters_cfg, timeout)

    def _sum(key):
        vals = [prun.get(key)] + [r.get(key) for r in drafts_runs] + [arun.get(key)]
        vals = [v for v in vals if isinstance(v, (int, float))]
        return sum(vals) if vals else None

    ok = bool(arun.get("ok")) and bool(arun.get("output")) and all(r.get("ok") for r in drafts_runs)
    # team WALL = planner (serial) + slowest worker (parallel) + assembler (serial)
    team_wall = (prun.get("wallMs") or 0) + section_wall + (arun.get("wallMs") or 0)
    breakdown = {
        "planner": prun.get("outputTokens"),
        "workers": [{"model": worker_rows[i % len(worker_rows)]["id"], "out": drafts_runs[i].get("outputTokens")}
                    for i in range(len(sections))],
        "assembler": arun.get("outputTokens"),
    }
    return {"output": arun.get("output") or "", "ok": ok,
            "inputTokens": _sum("inputTokens"), "outputTokens": _sum("outputTokens"),
            "totalTokens": _sum("totalTokens"), "wallMs": team_wall,
            "calls": 2 + len(sections), "sections": len(sections), "breakdown": breakdown}


def score_and_pack(task, prod, cfg, adapters_cfg, timeout):
    scored = score_run(task, prod, cfg, adapters_cfg, timeout)
    out_tok = prod.get("outputTokens")
    q = scored.get("quality")
    qpk = (q / (out_tok / 1000.0)) if (q is not None and out_tok) else None
    return q, qpk


def main():
    ap = argparse.ArgumentParser(description="Workstream-D team-vs-single decomposition bench")
    ap.add_argument("--config", default=None)
    ap.add_argument("--roles", default=None, help="filter team/suite.json by domain (book-chapter,content)")
    ap.add_argument("--tasks", default=None, help="filter to specific task id(s), comma list")
    ap.add_argument("--single", default="claude-haiku", help="single-drafter baseline model id")
    ap.add_argument("--workers", default=None, help="team worker model ids (comma, round-robin); default=--single")
    ap.add_argument("--planner", default=None, help="planner model id; default=--single")
    ap.add_argument("--assembler", default=None, help="assembler model id; default=--single")
    ap.add_argument("--team-size", type=int, default=3, dest="team_size")
    ap.add_argument("--modes", default="single,team", help="which modes to run")
    ap.add_argument("--max-tasks", type=int, default=None, dest="max_tasks")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    cfg = benchlib.load_config(args.config)
    adapters_cfg = cfg["adapters"]
    suite = json.load(open(SUITE))
    tasks = suite["tasks"]
    if args.roles:
        want = {r.strip() for r in args.roles.split(",")}
        tasks = [t for t in tasks if t.get("domain") in want]
    if args.tasks:
        want_ids = {t.strip() for t in args.tasks.split(",")}
        tasks = [t for t in tasks if t["id"] in want_ids]
    if args.max_tasks:
        tasks = tasks[: args.max_tasks]

    single_row = resolve_models(cfg, [args.single])
    if not single_row:
        print(f"unknown --single model {args.single!r}"); return
    single_row = single_row[0]
    worker_rows = resolve_models(cfg, (args.workers or args.single).split(","))
    planner_row = resolve_models(cfg, [args.planner or args.single])[0]
    assembler_row = resolve_models(cfg, [args.assembler or args.single])[0]
    modes = [m.strip() for m in args.modes.split(",") if m.strip() in ("single", "team")]
    n = args.team_size

    run_id = "team-" + datetime.now().strftime("%Y%m%d-%H%M%S")
    print(f"=== Team-vs-Single Decomposition Bench · {run_id} ===")
    print(f"tasks    : {', '.join(t['id'] for t in tasks)} ({len(tasks)})")
    print(f"single   : {single_row['id']}")
    print(f"team     : planner={planner_row['id']} workers={[w['id'] for w in worker_rows]} "
          f"assembler={assembler_row['id']} N={n}")
    print(f"modes    : {modes}")
    plan_calls = len(tasks) * (("single" in modes) + ("team" in modes) * (2 + n))
    print(f"plan     : ~{plan_calls} generation calls + {len(tasks)*len(modes)} judge calls")
    if args.dry_run:
        print("(dry run — nothing executed)"); return
    print()

    timeout = cfg["run"]["timeout_sec"]
    workers = cfg["run"].get("max_workers", 4)
    try:
        import os as _o
        _pm = json.load(open(_o.path.join(_o.path.dirname(_o.path.abspath(__file__)), ".tsbc-power.json")))
        if _pm.get("paused"):
            print("  TSBC SLEEP (paused) — not running."); return
        if _pm.get("maxWorkers") is not None:
            workers = min(workers, _pm["maxWorkers"])
        print(f"  [TSBC power cap: {workers} worker(s)]")
    except Exception:
        pass
    workers = max(1, min(workers, 4))

    records = []
    out_dir = benchlib.RESULTS_DIR / run_id
    (out_dir / "drafts").mkdir(parents=True, exist_ok=True)
    for t in tasks:
        domain = t.get("domain", "general")
        for mode in modes:
            try:
                if mode == "single":
                    prod = run_single(t, single_row, adapters_cfg, timeout)
                    tc = f"team:{domain}:single-{single_row['id']}"
                else:
                    prod = run_team(t, planner_row, worker_rows, assembler_row, n,
                                    adapters_cfg, timeout, workers)
                    tc = f"team:{domain}:team{n}-{'+'.join(_stem(w['id']) for w in worker_rows)}"
                q, qpk = score_and_pack(t, prod, cfg, adapters_cfg, timeout)
            except Exception as e:
                q, qpk, prod, tc = None, None, {"ok": False, "error": str(e)}, f"team:{domain}:{mode}"
            draft_path = out_dir / "drafts" / f"{t['id']}__{mode}.txt"
            if prod.get("output"):
                draft_path.write_text(prod["output"])
            rec = {"task": t["id"], "domain": domain, "mode": mode, "test_class": tc,
                   "quality": q, "qPer1kOut": qpk, "outputTokens": prod.get("outputTokens"),
                   "wallMs": prod.get("wallMs"), "calls": prod.get("calls"),
                   "sections": prod.get("sections"), "ok": bool(prod.get("ok")),
                   "error": prod.get("error"), "breakdown": prod.get("breakdown"),
                   "draftFile": str(draft_path) if prod.get("output") else None,
                   "outputSample": (prod.get("output") or "")[:600]}
            records.append(rec)
            with PRINT_LOCK:
                wsec = (prod.get("wallMs") or 0) // 1000
                print(f"  {t['id']:<22} {mode:<6} q={_q(q)} q/1k={_q(qpk)} "
                      f"out={prod.get('outputTokens')} {wsec}s calls={prod.get('calls')}"
                      f"{' SECT='+str(prod.get('sections')) if mode=='team' else ''}"
                      f"{' FAIL '+str(prod.get('error') or '') if not prod.get('ok') else ''}", flush=True)
                if mode == "team" and prod.get("breakdown"):
                    bd = prod["breakdown"]
                    wk = " ".join(f"{w['model']}={w['out']}" for w in bd["workers"])
                    print(f"        tok breakdown: planner={bd['planner']} | workers[{wk}] | assembler={bd['assembler']}", flush=True)

    # aggregate per (domain, mode) and per task delta
    out_dir = benchlib.RESULTS_DIR / run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    json.dump(records, open(out_dir / "records.json", "w"), indent=2)
    cells = {}
    for r in records:
        cells.setdefault(r["test_class"], []).append(r)
    cells_agg = {}
    for tc, rs in cells.items():
        ok = [r for r in rs if r.get("ok") and r.get("quality") is not None]
        cells_agg[tc] = {
            "n": len(ok),
            "quality": (sum(r["quality"] for r in ok) / len(ok)) if ok else None,
            "qPer1kOut": (sum(r["qPer1kOut"] for r in ok if r["qPer1kOut"]) / len(ok)) if ok else None,
            "meanOutputTokens": (sum(r["outputTokens"] for r in ok if r["outputTokens"]) / len(ok)) if ok else None,
            "meanWallMs": (sum(r["wallMs"] for r in ok if r["wallMs"]) / len(ok)) if ok else None,
        }
    json.dump(cells_agg, open(out_dir / "cells.json", "w"), indent=2)

    # report: per-task single-vs-team + verdict
    L = [f"# Team-vs-Single Decomposition Bench — `{run_id}`\n",
         f"_single={single_row['id']} · team: planner={planner_row['id']} workers="
         f"{','.join(w['id'] for w in worker_rows)} assembler={assembler_row['id']} N={n} · "
         f"judge={cfg['judge'].get('id')} (blind, bare rubric)._\n",
         "| task | mode | q | q/1k-out | out-tok | wall | calls |",
         "|---|---|---|---|---|---|---|"]
    by_task = {}
    for r in records:
        by_task.setdefault(r["task"], {})[r["mode"]] = r
    for r in records:
        L.append(f"| {r['task']} | {r['mode']} | {_q(r['quality'])} | {_q(r['qPer1kOut'])} | "
                 f"{r['outputTokens']} | {(r['wallMs'] or 0)//1000}s | {r['calls']} |")
    L.append("\n**Verdict (team − single):**")
    for task_id, mm in by_task.items():
        s, te = mm.get("single"), mm.get("team")
        if s and te and s.get("quality") is not None and te.get("quality") is not None:
            dq = te["quality"] - s["quality"]
            dw = (te.get("wallMs") or 0) - (s.get("wallMs") or 0)
            dt = (te.get("outputTokens") or 0) - (s.get("outputTokens") or 0)
            L.append(f"- `{task_id}`: Δquality **{dq:+.3f}** · Δwall {dw//1000:+d}s · Δout-tok {dt:+d} "
                     f"→ {'TEAM wins quality' if dq>0.01 else 'SINGLE wins/ties quality'}")
    md = "\n".join(L) + "\n"
    (out_dir / "report.md").write_text(md)
    print("\n" + "=" * 60 + "\n" + md)
    print(f"wrote {out_dir}/report.md")

    try:
        import ledger
        _a, _t = ledger.record_team_run(run_id)
        print(f"       recorded {_t} team cell(s) to shared ledger ({ledger._company()})")
    except Exception as e:
        print(f"       (ledger record skipped: {e})")


if __name__ == "__main__":
    main()
