#!/usr/bin/env python3
"""
costreport.py — #19 cost comparison across models for any results dir.

Reads a run's records.json and reports, per model, the cost signals that matter for
tiering. Works on variants-*, cascade-*, and run-* result dirs.

Three cost bases (all shown when data exists):
  1. SCORE-PER-WEIGHT (TSMC-20229) — quality ÷ ledger input_weight. A 0.95 model at
     weight 0.4 beats a 0.98 model at weight 2.0 for pool draw. Primary subscription
     selection signal once a quality floor is cleared.
  2. OUTPUT-TOKEN EFFICIENCY — quality per 1k OUTPUT tokens (harness-fair marginal
     signal; input is ~95% fixed CLI overhead).
  3. NOTIONAL API $ (only if config.pricing / price_ledger has rates) — quality per $.
     Prices come from benchmark/price_ledger.json; never fabricated.

  python3 costreport.py                         # latest results dir
  python3 costreport.py results/cascade-...      # a specific dir
  python3 costreport.py --baseline grok-4.3      # cheapness ratios vs this model
"""
import argparse
import glob
import json
import os
import statistics

import benchlib
import model_provenance
import price_ledger


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return statistics.mean(xs) if xs else None


def _norm(rec):
    """Normalize the three record dialects (variants: model/outputTokens; cascade: model/outTok;
    bench runs.json: model_id/outputTokens, no explicit ok)."""
    model = rec.get("model") or rec.get("model_id")
    effective = model_provenance.effective_model_id_for_record(rec, key="model_id")
    if effective:
        model = effective
    out = rec.get("outputTokens")
    if out is None:
        out = rec.get("outTok")
    inp = rec.get("inputTokens")
    if inp is None:
        inp = rec.get("inTok")
    q = rec.get("quality")
    ok = rec.get("ok") if "ok" in rec else (q is not None)
    return model, q, inp, out, bool(ok)


def _records_file(d):
    for name in ("records.json", "runs.json"):
        p = os.path.join(d, name)
        if os.path.exists(p):
            return p
    return None


def latest_dir():
    cands = sorted(glob.glob(str(benchlib.RESULTS_DIR / "*")), key=os.path.getmtime)
    for d in reversed(cands):
        if _records_file(d):
            return d
    return None


def main():
    ap = argparse.ArgumentParser(description="#19 cost comparison across models")
    ap.add_argument("results_dir", nargs="?", default=None, help="default: latest with records.json")
    ap.add_argument("--baseline", default=None, help="model id to compute cheapness ratios against")
    a = ap.parse_args()

    rdir = a.results_dir or latest_dir()
    rf = _records_file(rdir) if rdir else None
    if not rf:
        print("no records.json / runs.json found"); return
    recs = json.load(open(rf))
    cfg = benchlib.load_config()
    pricing = cfg.get("pricing") or {}
    # Prefer live price_ledger.json; fall back to config.pricing rates.
    ledger = price_ledger.load_ledger()
    have_prices = any(
        (price_ledger.lookup_row(m) or {}).get("usd_per_1m_output") is not None
        for m in {(_norm(r)[0]) for r in recs if _norm(r)[0]}
    ) or any(isinstance(v, dict) and v.get("out") for v in pricing.values())

    by = {}
    for r in recs:
        m, q, inp, out, ok = _norm(r)
        if not ok or m is None:
            continue
        agg = by.setdefault(m, {"q": [], "in": [], "out": []})
        agg["q"].append(q); agg["in"].append(inp); agg["out"].append(out)

    rows = []
    for m, agg in by.items():
        mq = _mean(agg["q"]); mo = _mean(agg["out"]); mi = _mean(agg["in"])
        qp1k = (mq / (mo / 1000)) if (mq is not None and mo) else None
        w = price_ledger.input_weight(m, input_tokens=mi)
        qpw = price_ledger.score_per_weight(mq, m, input_tokens=mi)
        usd = qpd = None
        row = price_ledger.lookup_row(m)
        pr_in = (row or {}).get("usd_per_1m_input")
        pr_out = (row or {}).get("usd_per_1m_output")
        if pr_out is None:
            pr = pricing.get(m) or pricing.get(str(m).lower())
            if isinstance(pr, dict):
                pr_in = pr.get("in") if pr_in is None else pr_in
                pr_out = pr.get("out")
        if have_prices and pr_out:
            out_usd = (mo or 0) / 1e6 * pr_out
            in_usd = (mi or 0) / 1e6 * (pr_in or 0)
            usd = out_usd + in_usd
            # output-only notional $ is the fair model-to-model marginal cost (input=overhead)
            out_only = out_usd or None
            qpd = (mq / out_only) if (mq is not None and out_only) else None
        rows.append({"model": m, "n": len(agg["q"]), "q": mq, "out": mo, "in": mi,
                     "w": w, "qpw": qpw, "qp1k": qp1k, "usd": usd, "qpd": qpd})

    # Primary sort: score-per-weight when present, else raw quality.
    rows.sort(key=lambda r: (
        r["qpw"] is not None,
        r["qpw"] if r["qpw"] is not None else -1,
        r["q"] is not None,
        r["q"] if r["q"] is not None else -1,
    ), reverse=True)

    print(f"\n=== Cost comparison · {os.path.basename(rdir)} ===")
    print(f"score-per-weight = quality ÷ input_weight (ledger as_of={ledger.get('as_of')}; "
          f"anchor ${ledger.get('anchor', {}).get('usd_per_1m_input', 2.5)}/1M).")
    print("subscription-billed: costUsd~=0; weighted pool draw is the live selection signal once quality clears the floor.")
    print("q/1k-out remains the harness-fair output-efficiency view (input ≈ fixed CLI overhead).")
    if have_prices:
        print("$ columns = NOTIONAL API list price (price_ledger.json / config.pricing).")
    else:
        print("$ columns hidden: no rates in price_ledger/config.pricing (not fabricated).")
    hdr = f"\n  {'model':<20}{'n':>4}{'quality':>9}{'w':>6}{'q/w':>8}{'out tok':>9}{'q/1k-out':>10}"
    if have_prices:
        hdr += f"{'$/task(out)':>12}{'q/$':>10}"
    print(hdr); print("  " + "-" * (len(hdr) - 2))
    for r in rows:
        line = (f"  {r['model']:<20}{r['n']:>4}{(('%.3f'%r['q']) if r['q'] is not None else '-'):>9}"
                f"{(('%.2f'%r['w']) if r['w'] is not None else '-'):>6}"
                f"{(('%.3f'%r['qpw']) if r['qpw'] is not None else '-'):>8}"
                f"{(('%.0f'%r['out']) if r['out'] is not None else '-'):>9}"
                f"{(('%.1f'%r['qp1k']) if r['qp1k'] is not None else '-'):>10}")
        if have_prices:
            line += f"{('$%.5f'%r['usd']) if r['usd'] is not None else '-':>12}{(('%.0f'%r['qpd']) if r['qpd'] is not None else '-'):>10}"
        print(line)

    # cheapness ratios vs a baseline (by mean output tokens — secondary signal)
    base = a.baseline
    if base and base in by:
        bo = _mean(by[base]["out"])
        print(f"\n  output-token cost vs {base} (×cheaper = fewer output tokens for the task):")
        for r in sorted(rows, key=lambda r: (r["out"] or 1e9)):
            if r["out"] and bo:
                ratio = bo / r["out"]
                print(f"    {r['model']:<20} {ratio:>5.2f}× {'cheaper' if ratio>=1 else 'pricier':<8} "
                      f"(q={_f(r['q'])} q/w={_f(r['qpw'])})")
    print()


def _f(x):
    return f"{x:.3f}" if isinstance(x, (int, float)) else "-"


if __name__ == "__main__":
    main()
