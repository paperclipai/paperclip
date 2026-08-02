#!/usr/bin/env python3
"""
missing_chapter_bench.py — Workstream-C: the "missing chapter" DIFF test.

Distinct from the blind-rubric evals: here we have the AUTHOR'S PUBLISHED chapter as ground
truth (TSB Book-1 Ch2, held in the task's `groundTruth` field — see team/suite.json). A model
drafts the missing middle chapter from the two bookend chapters + context; we score how
faithfully the draft REPRODUCES the published chapter, not how good it is in the abstract.

Two signals:
  1. reference_judge (claude-opus, REFERENCE-AIDED) — sees the DRAFT and the PUBLISHED chapter and
     scores fidelity: event/continuity reproduction + craft parity + would-it-pass-as-the-real-chapter.
     This is the primary signal — creative prose legitimately differs in WORDING, so a judge that
     compares CONTENT is right where lexical overlap is misleading.
  2. lexical (pure python, no API) — ROUGE-L F1 (LCS) + unigram Jaccard. A cheap objective floor;
     reported but weighted low (high lexical overlap on creative prose = copying, not skill).

Scores drafts WITHOUT regenerating: point it at a team_bench run dir (--from-run) whose drafts/
were saved, or a single --draft-file, or --generate a fresh single draft. Recorded to the shared
ledger under namespace 'missing-chapter:<task>:<label>'.

  python3 missing_chapter_bench.py --from-run team-20260622-235005        # score that run's drafts
  python3 missing_chapter_bench.py --draft-file results/.../drafts/x.txt
  python3 missing_chapter_bench.py --generate --single gemini-flash-low    # generate then score
"""

import argparse
import json
import statistics
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

import benchlib
import judge_policy
from adapters import run_model
from scoring import score_run

PRINT_LOCK = threading.Lock()

ROOT = benchlib.ROOT
SUITE = ROOT / "team" / "suite.json"

REF_JUDGE_INSTR = """You are evaluating how faithfully a DRAFT reproduces a PUBLISHED novel chapter. \
A model wrote the DRAFT working only from the surrounding chapters and a context brief; the PUBLISHED \
chapter is the author's ground-truth version of that same chapter. Judge how well the DRAFT recreates \
the published chapter's ESSENTIAL CONTENT — the key events and the order they occur, character actions \
and revelations, the clues/objects/details planted, and the continuity hooks into the neighbouring \
chapters — NOT the exact wording (skilled prose legitimately differs word-for-word).

Score EACH 0.0–1.0, discriminating strictly (do not default high):
- event_fidelity: are the published chapter's key events reproduced, in a compatible order, with no
  invented events that break the plot or the fair-play mystery?
- continuity_fidelity: does the draft honour the same setups/payoffs and threads the published chapter
  carries between its neighbours (so it would slot into the real book)?
- craft_parity: is the prose/voice/POV/tense quality on par with the published chapter?
- holistic_acceptability: would an editor accept this draft AS this chapter of the finished book?

Return ONLY JSON: {"scores": {"event_fidelity": x, "continuity_fidelity": x, "craft_parity": x, "holistic_acceptability": x}, "rationale": "<one specific sentence>"}"""

REF_WEIGHTS = {"event_fidelity": 2.5, "continuity_fidelity": 2.0, "craft_parity": 1.0, "holistic_acceptability": 1.5}


def _tokens(text):
    import re
    return re.findall(r"[a-z0-9']+", (text or "").lower())


def rouge_l_f1(cand, ref):
    """ROUGE-L F1 on whitespace tokens (LCS, space-efficient two-row DP)."""
    a, b = _tokens(cand), _tokens(ref)
    if not a or not b:
        return 0.0
    prev = [0] * (len(b) + 1)
    for i in range(1, len(a) + 1):
        cur = [0] * (len(b) + 1)
        ai = a[i - 1]
        for j in range(1, len(b) + 1):
            cur[j] = prev[j - 1] + 1 if ai == b[j - 1] else (prev[j] if prev[j] >= cur[j - 1] else cur[j - 1])
        prev = cur
    lcs = prev[len(b)]
    prec, rec = lcs / len(a), lcs / len(b)
    return round(2 * prec * rec / (prec + rec), 4) if (prec + rec) else 0.0


def unigram_jaccard(cand, ref):
    a, b = set(_tokens(cand)), set(_tokens(ref))
    if not a or not b:
        return 0.0
    return round(len(a & b) / len(a | b), 4)


def reference_judge(draft, reference, judge_cfg, adapters_cfg, timeout):
    prompt = (REF_JUDGE_INSTR
              + "\n\n=== PUBLISHED CHAPTER (ground truth) ===\n" + reference.strip()
              + "\n\n=== DRAFT TO EVALUATE ===\n" + (draft or "(empty)").strip()
              + "\n\n=== END ===\nReturn the JSON now.")
    judge_row = {"adapter": judge_cfg["adapter"], "model_arg": judge_cfg.get("model_arg")}
    res = run_model(prompt, judge_row, adapters_cfg, timeout)
    parsed = benchlib.extract_json(res.get("output"))
    if not isinstance(parsed, dict) or "scores" not in parsed:
        return None, {"error": "judge unparseable", "raw": (res.get("output") or "")[:300]}
    sc = parsed.get("scores", {})
    tw = ew = 0.0
    per = {}
    for k, w in REF_WEIGHTS.items():
        v = sc.get(k)
        try:
            v = max(0.0, min(1.0, float(v)))
        except (TypeError, ValueError):
            v = None
        per[k] = v
        tw += w
        ew += w * (v if v is not None else 0.0)
    return (ew / tw if tw else None), {"perCriterion": per, "rationale": parsed.get("rationale")}


def score_draft(label, draft, src, task, reference, cfg, adapters_cfg, timeout, with_rubric=False):
    """Score one draft: reference fidelity (claude-opus) + optional BLIND rubric (score_run) + lexical."""
    dw = len(draft.split())
    fid, detail = reference_judge(draft, reference, cfg["judge"], adapters_cfg, timeout)
    rubric_q = None
    if with_rubric:
        raw = {"output": draft, "ok": bool(draft.strip()),
               "outputTokens": benchlib.estimate_tokens(draft), "totalTokens": benchlib.estimate_tokens(draft)}
        rubric_q = score_run(task, raw, cfg, adapters_cfg, timeout).get("quality")  # blind rubric (no reference)
    rec = {"task": task["id"], "label": label, "drafter": label.split("#")[0], "source": src,
           "draftWords": dw, "fidelity": fid, "rubric": rubric_q,
           "rougeL": rouge_l_f1(draft, reference), "unigramJaccard": unigram_jaccard(draft, reference),
           "perCriterion": (detail or {}).get("perCriterion"), "rationale": (detail or {}).get("rationale")}
    with PRINT_LOCK:
        print(f"  {label:<24} fidelity={'  — ' if fid is None else round(fid,3)}  "
              f"rubric={'  — ' if rec['rubric'] is None else round(rec['rubric'],3)}  "
              f"rougeL={rec['rougeL']}  ({dw}w)", flush=True)
    return rec


def main():
    ap = argparse.ArgumentParser(description="workstream-C missing-chapter diff test (reference-aided)")
    ap.add_argument("--config", default=None)
    ap.add_argument("--task", default="team-tsb-book1-middle-chapter")
    ap.add_argument("--from-run", default=None, help="score every drafts/*.txt in this team_bench run dir")
    ap.add_argument("--draft-file", default=None, help="score one draft file")
    ap.add_argument("--drafters", default=None, help="comma list of model ids to GENERATE single drafts + score (fidelity leaderboard)")
    ap.add_argument("--samples", type=int, default=1, help="samples per drafter (non-gemini)")
    ap.add_argument("--gemini-samples", type=int, default=None, help="override samples for gemini/antigravity drafters (conserve quota)")
    ap.add_argument("--with-rubric", action="store_true", help="also compute the blind rubric per draft (slow: re-sends the full task prompt)")
    args = ap.parse_args()

    cfg = benchlib.load_config(args.config)
    cfg["judge"] = judge_policy.opus_reserve_judge()
    adapters_cfg = cfg["adapters"]
    timeout = cfg["run"]["timeout_sec"]
    suite = json.load(open(SUITE))
    task = next((t for t in suite["tasks"] if t["id"] == args.task), None)
    if not task or not task.get("groundTruth"):
        print(f"task {args.task!r} not found or has no groundTruth"); return
    reference = task["groundTruth"]
    ref_words = len(reference.split())

    workers = cfg["run"].get("max_workers", 4)
    try:
        import os as _o
        _pm = json.load(open(_o.path.join(_o.path.dirname(_o.path.abspath(__file__)), ".tsbc-power.json")))
        if _pm.get("paused"):
            print("  TSBC SLEEP (paused) — not running."); return
        if _pm.get("maxWorkers") is not None:
            workers = min(workers, _pm["maxWorkers"])
    except Exception:
        pass
    workers = max(1, min(workers, 4))

    # build jobs: (label, draft_text_or_None_to_generate, drafter_model_row, src)
    import team_bench as tb
    jobs = []  # each: (label, src, draft_text|None, model_row|None)
    if args.from_run:
        ddir = benchlib.RESULTS_DIR / args.from_run / "drafts"
        for p in sorted(ddir.glob(f"{args.task}__*.txt")):
            jobs.append((p.stem.split("__", 1)[-1], str(p), p.read_text(), None))
    if args.draft_file:
        p = Path(args.draft_file)
        jobs.append((p.stem, str(p), p.read_text(), None))
    if args.drafters:
        for mid in [m.strip() for m in args.drafters.split(",") if m.strip()]:
            rows = tb.resolve_models(cfg, [mid])
            if not rows:
                print(f"  [skip unknown drafter {mid!r}]"); continue
            row = rows[0]
            is_gem = row.get("adapter") == "antigravity"
            n = args.gemini_samples if (is_gem and args.gemini_samples is not None) else args.samples
            for i in range(n):
                jobs.append((f"{mid}#{i+1}", "(generated)", None, row))
    if not jobs:
        print("nothing to do — pass --drafters, --from-run, or --draft-file"); return

    run_id = "mch-" + datetime.now().strftime("%Y%m%d-%H%M%S")
    print(f"=== Missing-Chapter Fidelity Leaderboard · {run_id} ===")
    print(f"task   : {args.task}  (reference = published chapter, {ref_words} words)")
    print(f"judge  : {cfg['judge'].get('id')} (reference-aided fidelity + blind rubric) · {len(jobs)} drafts · {workers}w\n")

    def do(job):
        label, src, text, row = job
        if text is None:  # generate
            prod = tb.run_single(task, row, adapters_cfg, timeout)
            text = prod.get("output") or ""
        return score_draft(label, text, src, task, reference, cfg, adapters_cfg, timeout, args.with_rubric)

    with ThreadPoolExecutor(max_workers=workers) as ex:
        records = list(ex.map(do, jobs))

    # aggregate per drafter
    by = {}
    for r in records:
        by.setdefault(r["drafter"], []).append(r)
    def _m(rs, k):
        v = [x[k] for x in rs if x.get(k) is not None]
        return round(statistics.mean(v), 3) if v else None
    agg = {d: {"n": len([r for r in rs if r["fidelity"] is not None]),
               "fidelity": _m(rs, "fidelity"), "rubric": _m(rs, "rubric"),
               "rougeL": _m(rs, "rougeL"), "words": _m(rs, "draftWords")}
           for d, rs in by.items()}

    out_dir = benchlib.RESULTS_DIR / run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    json.dump(records, open(out_dir / "records.json", "w"), indent=2)
    json.dump(agg, open(out_dir / "leaderboard.json", "w"), indent=2)

    L = [f"# Missing-Chapter Fidelity Leaderboard — `{run_id}`\n",
         f"_task {args.task} · reference = published chapter ({ref_words}w) · judge {cfg['judge'].get('id')}._\n",
         "| drafter | n | **fidelity** | blind rubric | gap (rubric−fid) | rougeL | words |",
         "|---|---|---|---|---|---|---|"]
    for d, a in sorted(agg.items(), key=lambda kv: -(kv[1]["fidelity"] or 0)):
        gap = (round(a["rubric"] - a["fidelity"], 3) if (a["rubric"] is not None and a["fidelity"] is not None) else None)
        L.append(f"| {d} | {a['n']} | **{a['fidelity']}** | {a['rubric']} | {gap} | {a['rougeL']} | {a['words']} |")
    md = "\n".join(L) + "\n"
    (out_dir / "report.md").write_text(md)
    print("\n" + "=" * 60 + "\n" + md)

    try:
        import ledger
        ts = ledger._now_iso()
        rows = []
        for d, a in agg.items():
            if a["fidelity"] is None:
                continue
            rows.append({
                "ts": ts, "company": ledger._company(), "kind": "missing_chapter",
                "test_class": f"missing-chapter:{args.task}:{d}", "model": d,
                "model_class": "team" if "team" in d else "single",
                "metrics": {"fidelity": ledger._r(a["fidelity"]), "rubric": ledger._r(a["rubric"]),
                            "rougeL": ledger._r(a["rougeL"]), "draftWords": ledger._r(a["words"], 0)},
                "n_tasks": a["n"], "run_id": run_id, "judge": cfg["judge"].get("id"),
                "frame": "missing-chapter-diff", "skill": None, "source": "missing_chapter_bench.py",
            })
        n = ledger.append_records(rows)
        print(f"wrote {out_dir}/report.md · recorded {n} drafter cell(s) to shared ledger ({ledger._company()})")
    except Exception as e:
        print(f"wrote {out_dir}/report.md · (ledger record skipped: {e})")


if __name__ == "__main__":
    main()
