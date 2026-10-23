#!/bin/bash
set -euo pipefail
source "$(dirname "$(readlink -f "$0")")/lib.sh"
PLACEHOLDER="$1"; RUNROOT="${2:-/opt/pkst}"
KOWD_DIR="$RUNROOT/kowd"; UP_DIR="$RUNROOT/upstream"; PUB="$RUNROOT/pub"
ASSET_DIR="/home/tester/pkst-assets"
log(){ echo "[start] $*"; }

if ! sudo ss -tnlp 2>/dev/null | grep -q 127.0.0.1:14322; then
  log "starting kow proxy on 127.0.0.1:14322"
  sudo -u kowd bash -c "
    umask 077
    cd '$KOWD_DIR'
    setsid /opt/kow-venv/bin/python -m kow \
      --set kow_config='$KOWD_DIR/bindings.yaml' \
      --set confdir='$KOWD_DIR/confdir' \
      --set ssl_verify_upstream_trusted_ca='$PUB/upstream-ca.pem' \
      </dev/null >'$KOWD_DIR/kowd.log' 2>&1 &
    echo \$! > '$KOWD_DIR/kowd.pid'
  "
  wait_for 30 port_listening 14322 || true
fi
wait_for 20 sudo test -f "$KOWD_DIR/confdir/mitmproxy-ca-cert.pem" || true
sudo cp "$KOWD_DIR/confdir/mitmproxy-ca-cert.pem" "$PUB/kow-ca.pem"
sudo chmod 0644 "$PUB/kow-ca.pem"

PLACEHOLDER_FP=$(printf '%s' "$PLACEHOLDER" | sha256sum | cut -c1-12)
EXPECT_FP=$(cat "$PUB/fixture.fp")
if ! sudo ss -tnlp 2>/dev/null | grep -q 127.0.0.1:8443; then
  log "starting mock upstream on 127.0.0.1:8443"
  sudo -u upstream bash -c "
    cd '$UP_DIR'
    UP_PORT=8443 UP_CERT='$UP_DIR/leaf.pem' UP_KEY='$UP_DIR/leaf.key' \
    UP_EXPECT_FP='$EXPECT_FP' UP_PLACEHOLDER_FP='$PLACEHOLDER_FP' \
    UP_LOG='$UP_DIR/received.log' UP_LABEL='bound' \
    setsid node '$RUNROOT/assets/mock-upstream.mjs' </dev/null >'$UP_DIR/mock.log' 2>&1 &
    echo \$! > '$UP_DIR/mock.pid'
  "
  wait_for 20 port_listening 8443 || true
fi

log "services up: kow 14322, mock 8443"
sudo ss -tnlp 2>/dev/null | grep -E '127.0.0.1:(14322|8443)' || true
