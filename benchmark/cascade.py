#!/usr/bin/env python3
"""
cascade.py — #18 cascade economics: does cheap-worker + strong-escalation actually SAVE,
or do we burn the same as the strong model doing everything?

For each role it runs the FULL failable suite on a CHEAP and a STRONG model, then models a
"cheap does all, strong handles the failures" cascade and reports save-or-burn per role:

  - cheap vs strong mean quality              (the raw quality gap)
  - escalation rate f = fraction of cases the cheap model fails a quality bar
  - deterministic-detectable fraction         = of those failures, how many a FREE objective
                                                gate catches (deterministic score < 1.0).
                                                The rest are SUBJECTIVE failures that need a
                                                paid model-review to even detect.
  - ideal-cascade savings vs all-strong       (output-token proxy): 1 - (C + f*S)/S

Reading it:
  - HIGH det-detectable + LOW f  -> cheap+free-gate ≈ strong quality at a fraction of cost. TIER DOWN.
  - LOW det-detectable           -> failures are subjective; you'd pay a strong review on the
                                    rest to catch them -> savings erode toward "burn the same". KEEP PREMIUM.

  python3 cascade.py --roles intake,ledger,cto,quant --cheap gpt-5.4-mini --strong grok-4.3
  python3 cascade.py --bar 0.85 --dry-run
"""
import argparse
import json
import statistics
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

import benchlib
from adapters import run_model
from scoring import score_run

ROOT = benchlib.ROOT
LOCK = threading.Lock()


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return statistics.mean(xs) if xs else None


def _f(x, p=3):
    return f"{x:.{p}f}" if isinstance(x, (int, float)) else " — "


def run_task(role, task, model_row, adapters_cfg, timeout):
    raw = run_model(task["prompt"], model_row, adapters_cfg, timeout)
    s = score_run(task, raw, _cfg, adapters_cfg, timeout)
    rec = {"role": role, "task": task["id"], "model": model_row["id"],
           "quality": s.get("quality"), "det": s.get("deterministicScore"),
           "outTok": raw.get("outputTokens"), "ok": bool(raw.get("ok"))}
    with LOCK:
        print(f"  {role:<10} {model_row['id']:<13} q={_f(rec['quality'])} det={_f(rec['det'])} {task['id']}", flush=True)
    return rec


def main():
    global _cfg
    ap = argparse.ArgumentParser(description="#18 cascade economics")
    ap.add_argument("--roles", default="intake,ledger,cto,quant")
    ap.add_argument("--cheap", default="gpt-5.4-mini")
    ap.add_argument("--strong", default="grok-4.3")
    ap.add_argument("--bar", type=float, default=0.85, help="quality bar for 'handled correctly'")
    ap.add_argument("--max-tasks-per-role", type=int, default=None, dest="maxt")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    _cfg = benchlib.load_config()
    adapters_cfg = _cfg["adapters"]
    timeout = _cfg["run"]["timeout_sec"]
    workers = _cfg["run"].get("max_workers", 4)
    roster = {m["id"]: m for m in (_cfg.get("models", []) + _cfg.get("models_catalog", []))}
    cheap, strong = roster[a.cheap], roster[a.strong]
    roles = [r.strip() for r in a.roles.split(",")]

    plan = []
    for role in roles:
        suite = json.load(open(ROOT / role / "suite.json"))
        tasks = suite["tasks"][: a.maxt] if a.maxt else suite["tasks"]
        for t in tasks:
            plan.append((role, t, cheap))
            plan.append((role, t, strong))

    run_id = "cascade-" + datetime.now().strftime("%Y%m%d-%H%M%S")
    print(f"=== Cascade Economics (#18) · {run_id} ===")
    print(f"roles: {', '.join(roles)} | cheap={a.cheap} strong={a.strong} | quality bar={a.bar}")
    print(f"plan: {len(plan)} generations + {len(plan)} judge calls = {len(plan)*2} CLI invocations")
    if a.dry_run:
        print("(dry run — nothing executed)")
        return
    print()

    recs, rl = [], threading.Lock()

    def work(c):
        role, t, m = c
        try:
            r = run_task(role, t, m, adapters_cfg, timeout)
        except Exception as e:
            r = {"role": role, "task": t["id"], "model": m["id"], "quality": None, "ok": False, "error": str(e)}
            with LOCK:
                print(f"  {role} {m['id']} EXC {e}", flush=True)
        with rl:
            recs.append(r)

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=workers) as ex:
        list(ex.map(work, plan))

    rows = []
    for role in roles:
        ch = [r for r in recs if r["role"] == role and r["model"] == a.cheap and r.get("ok") and r["quality"] is not None]
        st = [r for r in recs if r["role"] == role and r["model"] == a.strong and r.get("ok") and r["quality"] is not None]
        if not ch or not st:
            continue
        chq, stq = _mean([r["quality"] for r in ch]), _mean([r["quality"] for r in st])
        cout, sout = _mean([r["outTok"] for r in ch]), _mean([r["outTok"] for r in st])
        fails = [r for r in ch if r["quality"] < a.bar]
        f = len(fails) / len(ch)
        detcatch = [r for r in fails if r.get("det") is not None and r["det"] < 1.0]
        det_frac = (len(detcatch) / len(fails)) if fails else 1.0
        casc = (cout + f * sout) if (cout is not None and sout) else None
        sav = (1 - casc / sout) if (casc is not None and sout) else None
        rows.append({"role": role, "n": len(ch), "cheapQ": chq, "strongQ": stq, "escalation": f,
                     "detDetectable": det_frac, "cheapOut": cout, "strongOut": sout, "idealSavings": sav})

    # report
    L = [f"# Cascade Economics (#18) — `{run_id}`\n",
         f"_cheap=**{a.cheap}** · strong=**{a.strong}** · judge={_cfg['judge'].get('id')} · quality bar={a.bar} · cost=output-token proxy_\n",
         "> escalation f = share of cases cheap fails the bar (→ strong handles). det-detectable = share of those "
         "failures a FREE objective gate catches; the rest are subjective failures needing a paid review. "
         "ideal savings = 1−(C+f·S)/S assuming a free, perfect gate.\n",
         "| role | n | cheap q | strong q | escalation f | det-detectable | ideal savings | verdict |",
         "|---|---|---|---|---|---|---|---|"]
    for r in rows:
        # verdict heuristic
        if r["escalation"] <= 0.15 and r["detDetectable"] >= 0.7:
            v = "TIER DOWN (cheap+free-gate)"
        elif r["escalation"] >= 0.5 or (r["idealSavings"] is not None and r["idealSavings"] < 0.2):
            v = "KEEP PREMIUM"
        elif r["detDetectable"] < 0.5:
            v = "cheap+PAID review (savings erode)"
        else:
            v = "cheap+gate (verify on harder tasks)"
        L.append(f"| {r['role']} | {r['n']} | {_f(r['cheapQ'])} | {_f(r['strongQ'])} | "
                 f"{r['escalation']*100:.0f}% | {r['detDetectable']*100:.0f}% | "
                 f"{(r['idealSavings']*100):.0f}% | {v} |" if r["idealSavings"] is not None else
                 f"| {r['role']} | {r['n']} | {_f(r['cheapQ'])} | {_f(r['strongQ'])} | "
                 f"{r['escalation']*100:.0f}% | {r['detDetectable']*100:.0f}% | — | {v} |")
    md = "\n".join(L) + "\n"

    out_dir = benchlib.RESULTS_DIR / run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    json.dump(recs, open(out_dir / "records.json", "w"), indent=2)
    json.dump(rows, open(out_dir / "cascade.json", "w"), indent=2)
    (out_dir / "report.md").write_text(md)
    print("\n" + "=" * 60)
    print(md)
    fails = sum(1 for r in recs if not r.get("ok"))
    print(f"wrote {out_dir}/report.md  (elapsed {time.time()-t0:.0f}s, {fails}/{len(recs)} failed)")


if __name__ == "__main__":
    main()
