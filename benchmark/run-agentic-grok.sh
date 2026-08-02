#!/usr/bin/env bash
# Quiet-TSMC agentic grok sweep.
#
# Runs the 12-stage agentic "Paperclip-function" suite against the 4 dedicated
# grok bench agents, with the live TSMC fleet quieted so it doesn't act on the
# bench's board-action fixtures mid-run:
#   - temporarily bootout the board-ask-janitor + stale-error-sweep launchd jobs
#     (AUTO-RESTORED on exit via an EXIT/INT/TERM trap — they can't be left off),
#   - the bench agents already reportTo a PAUSED Bench-Manager, so stage-9
#     routing never wakes the real CEO.
#
# Run this in YOUR terminal (it needs launchctl authority + the board token env).
# ~20-30 min. Writes results to benchmark/results/run-<ts>/.
set -uo pipefail

U="$(id -u)"
LA="$HOME/Library/LaunchAgents"
JOBS=(com.thinkstack.board-ask-janitor com.thinkstack.stale-error-sweep)

restore() {
  for J in "${JOBS[@]}"; do
    launchctl bootstrap "gui/$U" "$LA/$J.plist" 2>/dev/null || true
  done
  echo "[bench] janitors restored"
}
trap restore EXIT INT TERM

for J in "${JOBS[@]}"; do
  launchctl bootout "gui/$U/$J" 2>/dev/null || true
done
echo "[bench] janitors quieted for the run window"

ENV_FILE="$HOME/.paperclip/instances/default/companies/e6361895-a6a4-438d-bb76-b17a0ad026cb/agents/3733fb01-0791-442c-83d0-eb69a5c6602b/instructions/.secrets/session-limit-watch.env"
set -a; source "$ENV_FILE"; set +a

cd "$HOME/paperclip/benchmark"
python3 bench.py all --roles paperclip --models grok-4.3,grok-4.20,grok-4.5
# EXIT trap restores the janitors here, even on Ctrl-C / error.
