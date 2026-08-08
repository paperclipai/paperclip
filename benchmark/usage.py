#!/usr/bin/env python3
"""
usage.py — consolidated token-usage accounting across every model lane, in one place.

Pulls accurate token usage from four sources and presents them in a single view:

  1. bench       per-model usage from a benchmark run (results/<run>/runs.json) —
                 input/output/total, mean per call, # runs. Authoritative for the
                 benchmark; the same usage_json dialect Paperclip uses.
  2. gemini      local CONSUMED usage from gemini session history (gemini_usage.py) —
                 solves the "blind lane" (Paperclip's quota board can't see gemini).
  3. hermes      local CONSUMED usage from `hermes insights` (grok via xAI OAuth).
  4. paperclip   live per-model usage rolled up from the heartbeat_runs DB
                 (usage_json->>'model' / inputTokens / outputTokens).

  python3 usage.py all                 # everything
  python3 usage.py bench [run-id]      # default: latest run
  python3 usage.py gemini --days 7
  python3 usage.py hermes --days 7
  python3 usage.py paperclip --days 7

Note on metrics: under subscription billing costUsd is ~0, so TOKENS are the cost
signal. As of TSMC-20229 the portfolio daily view also reports **weighted**
Terra-equivalent units (tokens × ledger input_weight) so a Fable/Opus token is
never counted equal to a Luna/Haiku token. For harness *efficiency* comparisons
use OUTPUT tokens — input is mostly fixed per-CLI system-prompt overhead.
"""

import argparse
import glob
import json
import os
import re
import subprocess

import benchlib
import gemini_usage
import price_ledger

PG = ["env", "PGPASSWORD=paperclip", "psql", "-h127.0.0.1", "-p54329",
      "-U", "paperclip", "-d", "paperclip", "-tAF\t"]


def _fmt(n):
    try:
        return f"{int(round(n)):,}"
    except (TypeError, ValueError):
        return "—"


def _row(label, calls, inp, out, total, extra=""):
    return (f"{label:<28} {str(calls):>7} {_fmt(inp):>14} {_fmt(out):>12} "
            f"{_fmt(total):>14}  {extra}")


def _header():
    return (f"{'Lane / model':<28} {'calls':>7} {'input':>14} {'output':>12} "
            f"{'total':>14}")


def _weighted_header():
    return (f"{'Lane / model':<28} {'w':>6} {'raw in':>14} {'w·in':>14} "
            f"{'raw out':>12} {'w·out':>12}")


def _weighted_row(label, weight, inp, w_in, out, w_out, extra=""):
    w_s = f"{weight:.2f}" if isinstance(weight, (int, float)) else "—"
    return (f"{label:<28} {w_s:>6} {_fmt(inp):>14} {_fmt(w_in):>14} "
            f"{_fmt(out):>12} {_fmt(w_out):>12}  {extra}")


# --------------------------------------------------------------------------
# 1. benchmark run usage
# --------------------------------------------------------------------------

def latest_run():
    runs = sorted(glob.glob(str(benchlib.RESULTS_DIR / "run-*")))
    return os.path.basename(runs[-1]) if runs else None


def bench_usage(run_id=None):
    run_id = run_id or latest_run()
    if not run_id:
        return None, []
    path = benchlib.RESULTS_DIR / run_id / "runs.json"
    if not path.exists():
        return run_id, []
    runs = json.load(open(path))
    by = {}
    for r in runs:
        m = r["model_id"]
        agg = by.setdefault(m, {"calls": 0, "input": 0, "output": 0, "total": 0, "est": False})
        agg["calls"] += 1
        agg["input"] += r.get("inputTokens") or 0
        agg["output"] += r.get("outputTokens") or 0
        agg["total"] += r.get("totalTokens") or 0
        agg["est"] = agg["est"] or bool(r.get("tokensEstimated"))
    return run_id, by


def print_bench(run_id=None):
    run_id, by = bench_usage(run_id)
    print(f"## 1. Benchmark run usage  [{run_id or 'none found'}]\n")
    if not by:
        print("   (no runs.json)\n")
        return
    print("   " + _header())
    print("   " + "-" * 78)
    tot = {"calls": 0, "input": 0, "output": 0, "total": 0}
    for m in sorted(by, key=lambda k: -by[k]["output"]):
        a = by[m]
        mean_out = a["output"] / a["calls"] if a["calls"] else 0
        extra = f"~{_fmt(mean_out)} out/call" + ("  (est)" if a["est"] else "")
        print("   " + _row(m, a["calls"], a["input"], a["output"], a["total"], extra))
        for k in tot:
            tot[k] += a[k]
    print("   " + "-" * 78)
    print("   " + _row("TOTAL", tot["calls"], tot["input"], tot["output"], tot["total"]))
    print()


# --------------------------------------------------------------------------
# 2. gemini local usage
# --------------------------------------------------------------------------

def print_gemini(days=7):
    print(f"## 2. Gemini local consumed usage  [last {days}d, from ~/.gemini history]\n")
    per_model = gemini_usage.summarize(days=days)
    if not per_model:
        print("   (no gemini history found)\n")
        return
    print("   " + _header())
    print("   " + "-" * 78)
    tot = {"calls": 0, "input": 0, "output": 0, "total": 0}
    for m in sorted(per_model, key=lambda k: -per_model[k]["total"]):
        c = per_model[m]
        print("   " + _row(m, c.get("calls", 0), c.get("input", 0), c.get("output", 0), c.get("total", 0)))
        tot["calls"] += c.get("calls", 0); tot["input"] += c.get("input", 0)
        tot["output"] += c.get("output", 0); tot["total"] += c.get("total", 0)
    print("   " + "-" * 78)
    print("   " + _row("TOTAL", tot["calls"], tot["input"], tot["output"], tot["total"]))
    print("   (consumed only — no local remaining-quota record for gemini)\n")


# --------------------------------------------------------------------------
# 3. hermes / grok local usage  (parse `hermes insights`)
# --------------------------------------------------------------------------

def hermes_usage(days=7):
    try:
        out = subprocess.run(["hermes", "insights", "--days", str(days)],
                             capture_output=True, text=True, timeout=60).stdout
    except Exception as e:
        return None, f"hermes insights failed: {e}"
    def grab(label):
        m = re.search(label + r":\s*([\d,]+)", out)
        return int(m.group(1).replace(",", "")) if m else None
    totals = {"input": grab("Input tokens"), "output": grab("Output tokens"),
              "total": grab("Total tokens"), "sessions": grab("Sessions")}
    # per-model lines: "grok-4.3   5   522,120"
    models = {}
    for m in re.finditer(r"^\s*(grok\S+|gpt\S+|claude\S+)\s+(\d+)\s+([\d,]+)\s*$", out, re.MULTILINE):
        models[m.group(1)] = {"sessions": int(m.group(2)), "total": int(m.group(3).replace(",", ""))}
    return {"totals": totals, "models": models}, None


def print_hermes(days=7):
    print(f"## 3. Hermes/Grok local consumed usage  [last {days}d, from `hermes insights`]\n")
    data, err = hermes_usage(days)
    if err:
        print(f"   {err}\n")
        return
    t = data["totals"]
    print("   " + _header())
    print("   " + "-" * 78)
    for m, c in sorted(data["models"].items(), key=lambda kv: -kv[1]["total"]):
        print("   " + _row(m, c["sessions"], None, None, c["total"], "(per-model: sessions/total only)"))
    print("   " + "-" * 78)
    print("   " + _row("TOTAL (all msgs)", t.get("sessions"), t.get("input"), t.get("output"), t.get("total")))
    print()


# --------------------------------------------------------------------------
# 4. paperclip live DB usage  (heartbeat_runs.usage_json per model)
# --------------------------------------------------------------------------

PAPERCLIP_SQL = """
SELECT coalesce(usage_json->>'model','(none)') AS model,
       count(*) AS calls,
       coalesce(sum((usage_json->>'inputTokens')::numeric),0)::bigint  AS input,
       coalesce(sum((usage_json->>'outputTokens')::numeric),0)::bigint AS output
FROM heartbeat_runs
WHERE usage_json IS NOT NULL
  AND created_at > now() - interval '{days} days'
GROUP BY 1 ORDER BY output DESC;
"""


def paperclip_usage(days=7):
    sql = PAPERCLIP_SQL.format(days=int(days))
    try:
        proc = subprocess.run(PG + ["-c", sql], capture_output=True, text=True, timeout=30)
    except Exception as e:
        return None, f"psql failed: {e}"
    if proc.returncode != 0:
        return None, f"psql rc={proc.returncode}: {proc.stderr.strip()[:200]}"
    rows = []
    for line in proc.stdout.strip().splitlines():
        parts = line.split("\t")
        if len(parts) != 4:
            continue
        model, calls, inp, out = parts
        rows.append({"model": model, "calls": int(calls),
                     "input": int(inp), "output": int(out),
                     "total": int(inp) + int(out)})
    return rows, None


def print_paperclip(days=7):
    print(f"## 4. Paperclip live fleet usage  [last {days}d, heartbeat_runs DB, per model]\n")
    rows, err = paperclip_usage(days)
    if err:
        print(f"   {err}\n")
        return
    if not rows:
        print("   (no rows)\n")
        return
    print("   " + _header())
    print("   " + "-" * 78)
    tot = {"calls": 0, "input": 0, "output": 0, "total": 0}
    for r in rows:
        print("   " + _row(r["model"], r["calls"], r["input"], r["output"], r["total"]))
        for k in tot:
            tot[k] += r[k]
    print("   " + "-" * 78)
    print("   " + _row("TOTAL", tot["calls"], tot["input"], tot["output"], tot["total"]))
    print()

    # Weighted Terra-equivalent burn (TSMC-20229)
    print(f"## 4b. Weighted pool draw (Terra-eq units = tokens × input_weight)\n")
    print(f"   ledger as_of={price_ledger.load_ledger().get('as_of')} · "
          f"anchor ${price_ledger.load_ledger().get('anchor', {}).get('usd_per_1m_input', 2.5)}/1M\n")
    print("   " + _weighted_header())
    print("   " + "-" * 90)
    w_tot_in = w_tot_out = 0.0
    raw_priced_in = raw_priced_out = 0
    unpriced = []
    ranked = []
    for r in rows:
        w = price_ledger.input_weight(r["model"], input_tokens=r["input"])
        if w is None:
            unpriced.append(r["model"])
            continue
        wi = price_ledger.weighted_tokens(r["input"], r["model"], input_tokens_for_context=r["input"])
        wo = price_ledger.weighted_tokens(r["output"], r["model"], input_tokens_for_context=r["input"])
        ranked.append((wi or 0, r, w, wi, wo))
        w_tot_in += wi or 0
        w_tot_out += wo or 0
        raw_priced_in += r["input"]
        raw_priced_out += r["output"]
    ranked.sort(key=lambda t: -t[0])
    for _wi_sort, r, w, wi, wo in ranked:
        print("   " + _weighted_row(r["model"], w, r["input"], wi, r["output"], wo))
    print("   " + "-" * 90)
    print("   " + _weighted_row("PRICED TOTAL", None, raw_priced_in, w_tot_in, raw_priced_out, w_tot_out))
    if unpriced:
        sample = ", ".join(unpriced[:8])
        more = f" (+{len(unpriced)-8} more)" if len(unpriced) > 8 else ""
        print(f"   unpriced/unknown models excluded from weighted total: {sample}{more}")
    print("   note: weighted units are relative pool-draw proxies, not cash USD.\n")


# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="consolidated token usage across all model lanes")
    ap.add_argument("source", nargs="?", default="all",
                    choices=["all", "bench", "gemini", "hermes", "paperclip"])
    ap.add_argument("run_id", nargs="?", default=None, help="for 'bench' (default: latest)")
    ap.add_argument("--days", type=int, default=7)
    args = ap.parse_args()

    if args.source in ("all",):
        print("=" * 80)
        print("CONSOLIDATED MODEL TOKEN USAGE")
        print("=" * 80 + "\n")
    if args.source in ("all", "bench"):
        print_bench(args.run_id)
    if args.source in ("all", "gemini"):
        print_gemini(args.days)
    if args.source in ("all", "hermes"):
        print_hermes(args.days)
    if args.source in ("all", "paperclip"):
        print_paperclip(args.days)


if __name__ == "__main__":
    main()
