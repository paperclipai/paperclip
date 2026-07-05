#!/usr/bin/env bash
# ==============================================================================
# deploy-vps.sh
# Deployment helper to transfer and run update on VPS.
# Usage: bash deploy-vps.sh
#
# This script should be run from the repo root on the VPS.
# It copies the updated files and executes run.sh up.
# ==============================================================================
set -Eeuo pipefail

VPS_HOST="43.156.53.45"
VPS_USER="ubuntu"
REPO_PATH="/opt/paperclip"
LOCAL_REPO="/mnt/c/Users/admin/Downloads/paperclipandro/paperclip"  # WSL path

log() { printf "[INFO] %s\n" "$*"; }
error() { printf "[ERROR] %s\n" "$*" >&2; }
die() { error "$*"; exit 1; }

# Step 1: Copy updated files to VPS
log "Copying files to VPS..."
scp "$LOCAL_REPO/run.sh" "$VPS_USER@$VPS_HOST:$REPO_PATH/run.sh"
scp "$LOCAL_REPO/.env" "$VPS_USER@$VPS_HOST:$REPO_PATH/.env"
scp "$LOCAL_REPO/.env.example" "$VPS_USER@$VPS_HOST:$REPO_PATH/.env.example"

# Step 2: SSH and run deployment
log "Running deployment on VPS..."
ssh "$VPS_USER@$VPS_HOST" bash <<SSHEOF
  set -Eeuo pipefail
  cd "$REPO_PATH"

  # Backup existing run.sh
  if [[ -f "run.sh.bak" ]]; then
    rm -f run.sh.bak
  fi

  chmod +x run.sh

  # Ensure .env is secure
  chmod 600 .env

  # Run the deployment
  echo "[VPS] Starting deployment..."
  ./run.sh up
SSHEOF

log "Deployment complete. Run verification on VPS:"
echo "  ssh $VPS_USER@$VPS_HOST"
echo "  curl -sSI https://paperclip.carisinternational.com"
echo "  claude --version"
echo "  codex -V"
