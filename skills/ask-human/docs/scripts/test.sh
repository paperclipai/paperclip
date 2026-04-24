#!/usr/bin/env bash
# Offline validation for the `ask-human` skill.
# Runs ask.sh --dry-run across representative cases (no network, no Discord post).
# Exits non-zero if any expected-success case fails, or any expected-fail case passes.

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PASS=0
FAIL=0

# Require the routing file so dry-runs resolve channels.
if [ ! -f "${OPENCLAW_ROUTING_JSON:-/Users/vasanth/.gsai/openclaw-routing.json}" ]; then
  echo "SKIP: routing.json not present; cannot validate." >&2
  exit 0
fi

# Helper: run a case, check expected exit status.
run_case() {
  local expect="$1"; shift
  local desc="$1"; shift
  local out
  out="$("$DIR/ask.sh" --dry-run "$@" 2>&1)"; rc=$?

  if [ "$expect" = "ok" ] && [ "$rc" -eq 0 ]; then
    echo "  ✓ $desc"; PASS=$((PASS+1))
  elif [ "$expect" = "fail" ] && [ "$rc" -ne 0 ]; then
    echo "  ✓ $desc (expected failure, rc=$rc)"; PASS=$((PASS+1))
  else
    echo "  ✗ $desc — expected $expect, got rc=$rc" >&2
    echo "    output: $out" >&2
    FAIL=$((FAIL+1))
  fi
}

echo "[1] Valid dry-run for every kind…"
VSR_BODY='[Scene 1 — Hook] [visual: close-up]
"Line one."

=== TTS-READY SCRIPT ===

Line one.'
run_case ok "#cfw CFW-1 video_script_request (with delimiter)" "#cfw" "CFW-1" "video_script_request" "$VSR_BODY"
for kind in review_request approval_request question handoff; do
  run_case ok "#cfw CFW-1 $kind" "#cfw" "CFW-1" "$kind" "test body"
done

echo "[1b] video_script_request WITHOUT delimiter must fail…"
run_case fail "video_script_request missing TTS delimiter" "#cfw" "CFW-1" "video_script_request" "just a plain script, no delimiter"

echo "[2] Channel name variants (with/without '#', case)…"
run_case ok "cfw (no hash)" "cfw" "CFW-1" "review_request" "body"
run_case ok "#CFW (upper)"  "#CFW" "CFW-1" "review_request" "body"

echo "[3] Unknown channel…"
run_case fail "unknown channel" "#nonexistent" "CFW-1" "review_request" "body"

echo "[4] Channel with no Paperclip binding (#briefings)…"
run_case fail "#briefings (paperclip=null)" "#briefings" "CFW-1" "review_request" "body"

echo "[5] Prefix mismatch…"
run_case fail "CFW issue → #gsai" "#gsai" "CFW-1" "review_request" "body"
run_case fail "GRO issue → #cfw" "#cfw" "GRO-1" "review_request" "body"

echo "[6] Unknown kind…"
run_case fail "bogus kind" "#cfw" "CFW-1" "not_a_kind" "body"

echo "[7] Missing args…"
run_case fail "no args" ""
run_case fail "missing body" "#cfw" "CFW-1" "review_request"

echo
echo "Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
