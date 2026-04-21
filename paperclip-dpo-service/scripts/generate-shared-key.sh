#!/usr/bin/env bash
set -euo pipefail
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
