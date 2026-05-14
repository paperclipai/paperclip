#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Paperclip Reliability Rollout ==="
echo ""

# Validate prerequisites
echo "[1/4] Validating prerequisites..."
bash "$SCRIPT_DIR/validate-reliability-prereqs.sh"

# Apply Cloudflare Terraform
echo "[2/4] Applying Cloudflare configuration..."
cd "$REPO_ROOT/ops/terraform/cloudflare"
terraform init -input=false
terraform plan -out=tfplan
terraform apply -auto-approve tfplan

# Rotate tunnel token
echo "[3/4] Rotating cloudflared tunnel token..."
bash "$SCRIPT_DIR/rotate-cloudflared-tunnel-token.sh"

# Install logrotate and watchdog
echo "[4/4] Installing logrotate and watchdog..."
bash "$SCRIPT_DIR/install-paperclip-logrotate.sh"
bash "$SCRIPT_DIR/install-paperclip-watchdog.sh"

echo ""
echo "=== Rollout complete ==="
echo "Verify with: curl http://127.0.0.1:3101/healthz"
echo "Watchdog status: systemctl status paperclip-watchdog.timer"
