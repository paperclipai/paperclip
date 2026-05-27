#!/bin/bash
set -e

echo "=== Paperclip Cloud Deploy (Railway) ==="
echo ""

# Check for Docker
if ! command -v docker &>/dev/null; then
  echo "Docker not found. Installing via Homebrew..."
  brew install --cask docker
  echo "Please open Docker Desktop and wait for it to finish starting, then re-run this script."
  exit 1
fi

# Check Docker is running
if ! docker info &>/dev/null; then
  echo "Docker is not running. Please start Docker Desktop and try again."
  exit 1
fi

# Install Railway CLI
if ! command -v railway &>/dev/null; then
  echo "Installing Railway CLI..."
  npm install -g @railway/cli
fi

# Generate auth secret
AUTH_SECRET=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")

# Login to Railway
echo "Logging into Railway..."
railway login

# Create project
echo "Creating Railway project..."
railway init --name paperclip

# Link to project
railway link

# Set environment variables
echo "Setting environment variables..."
railway variables set \
  BETTER_AUTH_SECRET="$AUTH_SECRET" \
  SERVE_UI=true \
  PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
  NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=3100

# Add a volume for persistent data
echo "Adding persistent volume..."
railway volume add --mount-path /paperclip --size 1

# Deploy
echo "Deploying..."
railway up --detach

# Get the URL
sleep 10
RAILWAY_URL=$(railway domain 2>/dev/null || echo "")

echo ""
echo "=== Deploy complete! ==="
if [ -n "$RAILWAY_URL" ]; then
  echo "URL: https://$RAILWAY_URL"
else
  echo "Generate a domain with: railway domain add"
fi
echo ""
echo "First launch takes ~3 min (builds UI + runs migrations)."
echo "Check logs: railway logs"
