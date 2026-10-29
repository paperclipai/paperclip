#!/bin/bash
set -euo pipefail
source "$(dirname "$(readlink -f "$0")")/lib.sh"
NONCE="$1"; PLACEHOLDER="$2"; RUNROOT="${3:-/opt/pkst}"
METHOD="${4:-POST}"; URL="${5:-https://vault-echo.test:8443/echo}"; LABEL="${6:-bound}"
AG_DIR="$RUNROOT/agent"; PUB="$RUNROOT/pub"; ASSET_DIR="/home/tester/pkst-assets"
RESULT="$AG_DIR/result-$LABEL.json"; BARRIER="$AG_DIR/barrier-$LABEL"

sudo -u agent touch "$BARRIER"
sudo chown agent:agent "$BARRIER"

sudo -u agent bash -c "
  cd '$AG_DIR'
  AG_URL='$URL' AG_METHOD='$METHOD' AG_PLACEHOLDER='$PLACEHOLDER' AG_NONCE='$NONCE' \
  AG_RESULT='$RESULT' AG_AGENTPID='$AG_DIR/agent-$LABEL.agentpid' AG_BARRIER='$BARRIER' AG_BARRIER_TIMEOUT_MS=120000 \
  setsid /opt/kow-venv/bin/kow run --ca-cert '$PUB/kow-ca.pem' --proxy http://127.0.0.1:14322 \
    -- node '$RUNROOT/assets/agent.mjs' </dev/null >'$AG_DIR/agent-$LABEL.log' 2>&1 &
  echo \$! > '$AG_DIR/agent-$LABEL.pid'
"
wait_for 60 file_exists_sudo "$RESULT" || true
echo "[run-agent] result ready for label=$LABEL nonce=$NONCE"
sudo cat "$RESULT" 2>/dev/null | head -40 || echo "NO RESULT (see $AG_DIR/agent-$LABEL.log)"
