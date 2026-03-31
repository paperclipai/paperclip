#!/usr/bin/env bash
set -euo pipefail

export PAPERCLIP_DEPLOYMENT_MODE="${PAPERCLIP_DEPLOYMENT_MODE:-authenticated}"
export PAPERCLIP_DEPLOYMENT_EXPOSURE="${PAPERCLIP_DEPLOYMENT_EXPOSURE:-public}"
export PAPERCLIP_AUTH_BASE_URL_MODE="${PAPERCLIP_AUTH_BASE_URL_MODE:-explicit}"
export PAPERCLIP_AUTH_PUBLIC_BASE_URL="${PAPERCLIP_AUTH_PUBLIC_BASE_URL:-https://app.tye.ai}"
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-deploy-gate-secret-change-me}"
export PAPERCLIP_SECRETS_STRICT_MODE="${PAPERCLIP_SECRETS_STRICT_MODE:-true}"

pnpm paperclipai onboard --yes
pnpm paperclipai doctor

