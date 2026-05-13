#!/bin/sh
# Test-only fake "agent" used by M2 Task 26's end-to-end test.
#
# Simulates the agent-shim contract just enough to prove the FULL
# orchestrator + Job lifecycle + log streaming path against a real kind
# cluster, without depending on the real claude-code CLI.
#
# Real claude-code integration is covered by Task 26.5 / M3 follow-up; the
# scope reduction is documented in claude-end-to-end.test.ts.
#
# Behavior:
#   1. Sleep briefly so kind's pod networking + DNS settle (host.docker.internal
#      resolution can be slow on first start).
#   2. POST a minimal "messages" payload to ANTHROPIC_BASE_URL/v1/messages.
#   3. Echo the response so the test can assert on it via pod logs.
#   4. Exit 0 if the assistant text we expect appears, otherwise exit 1.
set -eu

URL="${ANTHROPIC_BASE_URL:-http://host.docker.internal:8080}/v1/messages"

echo "[fake-agent] starting"
echo "[fake-agent] ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL:-<unset>}"

# Give kind's networking a beat to settle (DNS rewriting for host.docker.internal
# happens inside the kindnetd CNI; first resolution can take a couple of seconds).
sleep 2

echo "[fake-agent] POST $URL"
RESP=$(wget -O- -q \
  --header='content-type: application/json' \
  --post-data='{"model":"claude-opus-4-7","messages":[{"role":"user","content":"hi"}]}' \
  "$URL" 2>&1) || {
  echo "[fake-agent] wget failed:"
  echo "$RESP"
  exit 1
}

echo "[fake-agent] response: $RESP"

# Look for the deterministic marker the fake server returns.
if echo "$RESP" | grep -q 'I read your prompt and I am alive'; then
  echo "[fake-agent] success: assistant marker found"
  exit 0
fi

echo "[fake-agent] failure: assistant marker not found"
exit 1
