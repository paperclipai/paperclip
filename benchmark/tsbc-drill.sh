#!/usr/bin/env bash
# =============================================================================
# tsbc-drill — TSBC's continuous test driver ("Drillmaster"). Keeps the bootcamp
# TESTING within the power budget instead of sitting idle between one-shot batches.
#
# Concurrency is governed by bench.py's _power_limits() (.tsbc-power.json): 1 worker
# in LOW, 2 in NORMAL, heavy/agentic gated in LOW, fully paused during weekly SLEEP.
# This loop just keeps feeding bench.py cheap-model single-pass suites, accumulating
# toward the 5-sample target per (model,task), then IDLES (long sleep) until there's
# new work (with-skills layer, new models, refresh cadence). Survives via launchd.
# =============================================================================
set -uo pipefail
# model CLIs live in ~/.local/bin (claude/agy/hermes) + /opt/homebrew/bin (codex); node for the node-based ones.
# launchd gives a minimal PATH, so set the full one explicitly or every adapter call fails "No such file".
export PATH="/Users/glad0s/.local/bin:/opt/homebrew/bin:/usr/local/bin:/Users/glad0s/.nvm/versions/node/v20.20.2/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd /Users/glad0s/paperclip/benchmark || exit 1
PY=/Library/Frameworks/Python.framework/Versions/3.14/bin/python3
LOG=/Users/glad0s/paperclip/.devlogs/tsbc-drill.log
AGY_LAST_RUN=/Users/glad0s/paperclip/.devlogs/tsbc-drill-agy-last-run.log
CHEAP="grok-4.1-fast,grok-4-fast,gpt-5.4-mini,gpt-5.6-luna"
TASKS=(content book-chapter video-hook social-post designer summarize-extract cv-review intake ops)
AGY="agy-claude-opus-4.6,agy-claude-sonnet-4.6,agy-gpt-oss-120b"
AGY_TASKS=(engineer ceo cto ledger auditor quant)
AGY_TARGET=1
# with-skills (#17) layer: roles that are BOTH a drill task AND a configured variants.json role
# (have minimal+current agent-files + skillsDir). Once the bare base matrix is full, the drill
# fills the production-config grid (current:none vs current:all) so we can see the skill's marginal lift.
VTASKS=(content book-chapter designer cv-review intake ops)
# with-skills uses LARGE prompts (agent-file + ~10 concatenated skills, ~65k chars). These must be
# answered SINGLE-SHOT (direct text), consistent with the base matrix. Lane status (verified 2026-06-22):
#   • claude (stdin), grok (hermes), codex (gpt-5.4-mini) — answer cleanly single-shot -> ENABLED.
#     codex's earlier "rc=2/empty" was NOT an agentic failure: the prompt's "--- BEGIN ..." markers were
#     read by clap as CLI flags (fails in 1s, before the model runs). Fixed in adapters._run_codex by
#     feeding the prompt via stdin (`codex exec -`), same fix as claude. Validated: content gpt-5.4-mini
#     current:none 0.908 / current:all 0.938 (ΔSkills +0.030); 0 tool/exec events.
#   • gemini/antigravity (agy) — EXCLUDED. agy is agentic with no --allowedTools "" equivalent: it either
#     DERAILS into tool-use (false low score, e.g. content 0.214) or, with a no-tools directive, HANGS on
#     the headless permission gate (killed at the adapter's timeout). No CLI single-shot/no-tools mode
#     exists. For gemini skill-lift, eval AGENTICALLY in a separate quota-bounded path — not in this 24/7
#     single-shot drill. The base matrix above is restricted to the approved Grok/ChatGPT lanes.
VCHEAP="grok-4.1-fast,grok-4-fast,gpt-5.4-mini,gpt-5.6-luna"
TARGET=10
ts(){ date '+%F %T'; }
quota_sleep_seconds(){
  "$PY" - "$1" <<'PYEOF'
import re, sys
try:
    text = open(sys.argv[1], errors="ignore").read()
except FileNotFoundError:
    print(0)
    raise SystemExit
if "Individual quota reached" not in text and "RESOURCE_EXHAUSTED" not in text:
    print(0)
    raise SystemExit
matches = re.findall(r"Resets in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?", text)
if not matches:
    print(1800)
    raise SystemExit
h, m, s = matches[-1]
seconds = int(h or 0) * 3600 + int(m or 0) * 60 + int(s or 0)
# AGY quota resets can now be multi-day. Sleep through the provider's stated
# reset window instead of hammering every few hours while the lane is exhausted.
print(max(300, min(seconds + 300, 604800)))
PYEOF
}

echo "$(ts) tsbc-drill START (target=$TARGET samples/cell, models=$CHEAP)" >>"$LOG"
while true; do
  # weekly SLEEP / paused -> idle
  paused=$("$PY" -c "import json;print(json.load(open('.tsbc-power.json')).get('paused',False))" 2>/dev/null || echo False)
  if [ "$paused" = "True" ]; then echo "$(ts) paused (weekly sleep) — idle 1800s" >>"$LOG"; sleep 1800; continue; fi

  # pick the task whose WEAKEST cheap-model sample count is lowest and still < target
  NEXT="$("$PY" - "$CHEAP" "$TARGET" "${TASKS[@]}" <<'PYEOF'
import json,sys,collections
cheap=set(sys.argv[1].split(",")); target=int(sys.argv[2]); tasks=sys.argv[3:]
cnt=collections.defaultdict(lambda: collections.defaultdict(int))
try:
    for l in open("ledger/results.jsonl"):
        l=l.strip()
        if not l: continue
        r=json.loads(l); m=r.get("model"); tc=r.get("test_class")
        if m in cheap and tc in tasks and r.get("metrics",{}).get("quality") is not None:
            cnt[tc][m]+=1
except FileNotFoundError:
    pass
best=None; bestmin=10**9
for tc in tasks:
    mn=min(cnt[tc].get(m,0) for m in cheap.__iter__())
    if mn<target and mn<bestmin: bestmin=mn; best=tc
print(best or "")
PYEOF
)"
  if [ -n "$NEXT" ]; then
    pm="$("$PY" -c "import json;p=json.load(open('.tsbc-power.json'));print(p['mode'],p['maxWorkers'])" 2>/dev/null || echo "?")"
    echo "$(ts) drilling base: $NEXT  (power=$pm; bench self-caps)" >>"$LOG"
    "$PY" bench.py all --roles "$NEXT" --models "$CHEAP" --max-tasks-per-role 1 >>"$LOG" 2>&1 || echo "$(ts) bench pass error (continuing)" >>"$LOG"
    sleep 30; continue
  fi

  # AGY pack: the Saturday, July 25, 2026 AGY sweep proved the model pins work, but
  # quota exhaustion left the matrix partial and the cheap drill would otherwise sleep
  # forever because it only tracks the old cheap pack. Refill the missing AGY role pack
  # whenever a role lacks one publishable (success-floor-clearing) sample per AGY model.
  NEXT_AGY="$("$PY" - "$AGY" "$AGY_TARGET" "${AGY_TASKS[@]}" <<'PYEOF'
import collections, json, sys

models = [m for m in sys.argv[1].split(",") if m]
target = int(sys.argv[2])
roles = sys.argv[3:]
cfg = json.load(open("config.json"))
threshold = float((cfg.get("recommendation", {}) or {}).get("min_success_rate_for_quality", 0.8))
cnt = collections.defaultdict(lambda: collections.defaultdict(int))
try:
    for line in open("ledger/results.jsonl"):
        line = line.strip()
        if not line:
            continue
        row = json.loads(line)
        metrics = row.get("metrics", {}) or {}
        model = row.get("model")
        role = row.get("test_class")
        quality = metrics.get("quality")
        success = float(metrics.get("successRate") or 0.0)
        if model in models and role in roles and quality is not None and success >= threshold:
            cnt[role][model] += 1
except FileNotFoundError:
    pass

best = None
best_min = 10 ** 9
for role in roles:
    role_min = min(cnt[role].get(model, 0) for model in models)
    if role_min < target and role_min < best_min:
        best_min = role_min
        best = role
print(best or "")
PYEOF
)"
  if [ -n "$NEXT_AGY" ]; then
    pm="$("$PY" -c "import json;p=json.load(open('.tsbc-power.json'));print(p['mode'],p['maxWorkers'])" 2>/dev/null || echo "?")"
    echo "$(ts) drilling AGY: $NEXT_AGY  (target=$AGY_TARGET role-pass/model; power=$pm)" >>"$LOG"
    "$PY" bench.py all --roles "$NEXT_AGY" --models "$AGY" >"$AGY_LAST_RUN" 2>&1 || echo "$(ts) agy pass error (continuing)" >>"$LOG"
    cat "$AGY_LAST_RUN" >>"$LOG"
    quota_sleep="$(quota_sleep_seconds "$AGY_LAST_RUN" 2>/dev/null || echo 0)"
    if [ "${quota_sleep:-0}" -gt 0 ]; then
      echo "$(ts) AGY quota halt detected — sleeping ${quota_sleep}s before retry" >>"$LOG"
      sleep "$quota_sleep"
      continue
    fi
    sleep 30; continue
  fi

  # base matrix full -> drill the WITH-SKILLS (#17) layer: pick the overlap role whose weakest
  # cheap-model sample count for the production cell (variant:<role>:current-all) is lowest and < target.
  NEXTV="$("$PY" - "$VCHEAP" "$TARGET" "${VTASKS[@]}" <<'PYEOF'
import json,sys,collections
cheap=set(sys.argv[1].split(",")); target=int(sys.argv[2]); roles=sys.argv[3:]
SUF=":current-all"; PRE="variant:"
cnt=collections.defaultdict(lambda: collections.defaultdict(int))
try:
    for l in open("ledger/results.jsonl"):
        l=l.strip()
        if not l: continue
        r=json.loads(l); m=r.get("model"); tc=r.get("test_class") or ""
        if not (tc.startswith(PRE) and tc.endswith(SUF)): continue
        role=tc[len(PRE):-len(SUF)]
        if m in cheap and role in roles and r.get("metrics",{}).get("quality") is not None:
            cnt[role][m]+=1
except FileNotFoundError:
    pass
best=None; bestmin=10**9
for role in roles:
    mn=min(cnt[role].get(m,0) for m in cheap)
    if mn<target and mn<bestmin: bestmin=mn; best=role
print(best or "")
PYEOF
)"
  if [ -z "$NEXTV" ]; then
    echo "$(ts) base + with-skills matrices at >=$TARGET samples — idle 1800s (waiting on new work)" >>"$LOG"
    sleep 1800; continue
  fi

  pm="$("$PY" -c "import json;p=json.load(open('.tsbc-power.json'));print(p['mode'],p['maxWorkers'])" 2>/dev/null || echo "?")"
  echo "$(ts) drilling with-skills: $NEXTV  (current:none vs current:all; clean lanes; power=$pm)" >>"$LOG"
  "$PY" variants.py --roles "$NEXTV" --models "$VCHEAP" --cells "current:none,current:all" --max-tasks-per-role 1 >>"$LOG" 2>&1 || echo "$(ts) variants pass error (continuing)" >>"$LOG"
  sleep 30
done
