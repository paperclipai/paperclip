#!/usr/bin/env python3
"""Shadow-measure the disposition EXECUTION GAP for the grok bench agents.

For each (stage, model): the agent is asked to STATE its chosen disposition as a
structured token (PAPERCLIP_DISPOSITION: {...}) in addition to its normal status
update. We then compare:
  - tokenStatus      : what the agent SAID it decided
  - actualFinal      : what the agent actually SET on the issue
  - expected         : the stage's correct disposition (from rubric.deterministic)
The win a system-side enforcement hook would capture = the agent stated a CORRECT
valid disposition but failed to execute it (issue left without a valid disposition).

Checkpoints every cell to results/_disposition_shadow.jsonl and RESUMES (skips
cells already recorded) — so a kill never loses data; just re-launch.

Usage: python3 run_disposition_shadow.py [smoke|hard|all]
  smoke = 1 stage x 1 model            (validate token capture)
  hard  = the harder dispositions      (in_review / delegate / plan / restraint / blocked)
  all   = every board-card-free stage  (default; full non-board picture)
Env: PAPERCLIP_API_URL + PAPERCLIP_API_KEY (board token).
Board-action stages (05 request-confirmation, 09 route, 11 board-approval) are
excluded — they need the launchd janitors quieted (your terminal).
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import paperclip_lane
paperclip_lane.SHADOW_DISPOSITION = True  # force on regardless of import-time env

cfg = json.load(open(os.path.join(HERE, "config.json")))
suite = json.load(open(os.path.join(HERE, "paperclip", "suite.json")))
tasks_by_id = {t["id"]: t for t in suite["tasks"]}
timeout = cfg["paperclip"].get("cellTimeoutSec", 900)
models_by_id = {m["id"]: m for m in (cfg["models"] + cfg.get("models_catalog", []))}
GROK_IDS = ["grok-4.3", "grok-4.20", "grok-4.5"]

RESULTS = os.path.join(HERE, "results", "_disposition_shadow.jsonl")
os.makedirs(os.path.dirname(RESULTS), exist_ok=True)

# board-card-free stages only (no janitor dependency)
ALL_STAGES = ["01-read-comment-done", "02-compute-comment-done", "03-read-extract-token",
              "04-in-review-handoff", "06-blocked-with-blocker", "07-delegate-subtasks",
              "08-plan-document", "10-compound-gauntlet", "12-idempotent-restraint"]
HARD_STAGES = ["04-in-review-handoff", "06-blocked-with-blocker", "07-delegate-subtasks",
               "08-plan-document", "10-compound-gauntlet", "12-idempotent-restraint"]

mode = sys.argv[1] if len(sys.argv) > 1 else "all"
if mode == "smoke":
    STAGES, MODELS = ["01-read-comment-done"], ["grok-4.3"]
elif mode == "hard":
    STAGES, MODELS = HARD_STAGES, GROK_IDS
else:
    STAGES, MODELS = ALL_STAGES, GROK_IDS


def expected_status(task):
    for c in ((task.get("rubric") or {}).get("deterministic") or []):
        spec = c.get("spec") or {}
        if spec.get("path") == "finalStatus":
            return spec.get("value")
    return None  # only validDisposition required -> any valid status is correct


def load_records():
    out = []
    if os.path.exists(RESULTS):
        for line in open(RESULTS):
            line = line.strip()
            if line:
                try: out.append(json.loads(line))
                except Exception: pass
    return out


VALID = {"done", "cancelled", "in_review", "blocked"}
existing = load_records()
done_keys = {(r["stage"], r["model"]) for r in existing}
print(f"resume: {len(done_keys)} cells already recorded in {RESULTS}", flush=True)

for sid in STAGES:
    task = tasks_by_id[sid]
    exp = expected_status(task)
    for mid in MODELS:
        if (sid, mid) in done_keys:
            print(f"[skip] {sid} @ {mid} (already recorded)", flush=True)
            continue
        m = models_by_id[mid]
        print(f"[run] {sid} @ {mid} ...", flush=True)
        try:
            res = paperclip_lane.run_case(task, m, cfg, timeout)
        except Exception as e:
            print(f"   ERROR: {e}", flush=True); continue
        out = json.loads(res.get("output") or "{}") if res.get("ok") else {}
        tok = out.get("dispositionToken") or {}
        ts = tok.get("status")
        present = bool(out.get("dispositionTokenPresent"))
        actual_valid = bool(out.get("validDisposition"))
        actual_final = out.get("finalStatus")
        token_correct = (ts == exp) if exp else (ts in VALID)
        actual_correct = (actual_final == exp and actual_valid) if exp else actual_valid
        rec = {"stage": sid, "model": mid, "ok": res.get("ok"), "expected": exp or "(any-valid)",
               "tokenPresent": present, "tokenStatus": ts, "tokenCorrect": token_correct,
               "actualFinal": actual_final, "actualCorrect": actual_correct,
               "executionGap": present and token_correct and not actual_correct}
        with open(RESULTS, "a") as f:
            f.write(json.dumps(rec) + "\n")
        print(f"   token={ts}(present={present},correct={token_correct}) "
              f"actual={actual_final}(correct={actual_correct}) execGap={rec['executionGap']}", flush=True)

# ---- analysis over ALL recorded cells ----
records = load_records()
print(f"\n================ SHADOW DISPOSITION REPORT ({len(records)} cells) ================")
def pct(n, d): return f"{(100.0*n/d):.0f}%" if d else "-"
for mid in GROK_IDS:
    rs = [r for r in records if r["model"] == mid]
    if not rs: continue
    n = len(rs); tp = sum(r["tokenPresent"] for r in rs)
    tcorr = sum(r["tokenPresent"] and r["tokenCorrect"] for r in rs)
    acorr = sum(r["actualCorrect"] for r in rs)
    fails = [r for r in rs if not r["actualCorrect"]]
    gap = sum(r["executionGap"] for r in rs)
    print(f"\n{mid}: n={n}")
    print(f"  token present:      {tp}/{n} ({pct(tp,n)})")
    print(f"  token DECISION ok:  {tcorr}/{tp} of present ({pct(tcorr,tp)})")
    print(f"  actual correct:     {acorr}/{n} ({pct(acorr,n)})")
    print(f"  EXECUTION GAP:      {gap}/{n}  = {gap}/{len(fails)} of failures ({pct(gap,len(fails))})")
# decision-accuracy by disposition type (the auto-apply-safety question)
print("\nDecision accuracy by token status (is the agent's stated disposition correct?):")
for st in sorted(VALID):
    rs = [r for r in records if r["tokenStatus"] == st]
    if rs:
        ok = sum(r["tokenCorrect"] for r in rs)
        print(f"  token={st:10} {ok}/{len(rs)} correct ({pct(ok,len(rs))})")
print("\nper-cell:")
for r in records:
    tag = "EXEC-GAP" if r["executionGap"] else ("ok" if r["actualCorrect"] else "fail")
    print(f"  {r['stage']:26} {r['model']:14} exp={r['expected']:11} "
          f"tok={str(r['tokenStatus']):9} act={str(r['actualFinal']):12} {tag}")
