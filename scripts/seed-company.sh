#!/usr/bin/env bash
# Spin up a new product company by cloning the _template.
# Usage: ./scripts/seed-company.sh marketing
#        ./scripts/seed-company.sh sales

set -euo pipefail

NEW="${1:?Usage: seed-company.sh <new-company-name>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/companies/_template"
DST="$ROOT/companies/$NEW"

if [[ -d "$DST" ]]; then
  echo "Company '$NEW' already exists at $DST"
  exit 1
fi

if [[ ! -d "$SRC" ]]; then
  echo "Template missing at $SRC — populate it first by adapting companies/learnova-academy"
  exit 1
fi

cp -R "$SRC" "$DST"
echo "Created $DST"
echo "Next: edit $DST/COMPANY.md, agents/*/SOUL.md, schedules/, and prompts/."
