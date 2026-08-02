#!/usr/bin/env python3
"""
smoke_cheap.py — tiny health check of the cheap-model lanes before a big sweep.
One trivial generation per model (serial, to be gentle on the shared Mac), reporting
ok / model-seen / in+out tokens / error. Identifies broken lanes (e.g. the claude-haiku
failures seen earlier) so we don't waste a full sweep on a dead adapter.
"""
import sys
import benchlib
from adapters import run_model

PROMPT = "Write a single one-sentence tagline for a free weekly budget planner. Return ONLY the tagline."

# the cheap roster (+ a couple mid-tier for reference); skip rate-limited spark
WANT = ["claude-haiku", "claude-sonnet-5", "gpt-5.4-mini", "gemini-flash",
        "gemini-flash-lite", "grok-4.3", "grok-4.5", "grok-3-mini"]

cfg = benchlib.load_config()
roster = {m["id"]: m for m in (cfg.get("models", []) + cfg.get("models_catalog", []))}
adapters_cfg = cfg["adapters"]
timeout = cfg["run"]["timeout_sec"]

want = sys.argv[1].split(",") if len(sys.argv) > 1 else WANT
print(f"=== cheap-lane smoke test ({len(want)} models, serial) ===")
print(f"{'model':<18}{'ok':>4}{'in':>8}{'out':>7}{'wall_s':>8}  model-seen / error")
print("-" * 78)
for mid in want:
    row = roster.get(mid)
    if not row:
        print(f"{mid:<18}  -- not in roster"); continue
    r = run_model(PROMPT, row, adapters_cfg, timeout)
    ok = "yes" if r.get("ok") else "NO"
    inp = r.get("inputTokens"); out = r.get("outputTokens")
    wall = (r.get("wallMs") or 0) / 1000
    detail = r.get("model") or ""
    if not r.get("ok"):
        detail = (r.get("error") or "") + " | " + (r.get("stderrTail") or "")[:120]
    elif r.get("tokensEstimated"):
        detail += " (tokens estimated)"
    print(f"{mid:<18}{ok:>4}{str(inp):>8}{str(out):>7}{wall:>8.0f}  {detail[:80]}")
print("-" * 78)
print("done")
