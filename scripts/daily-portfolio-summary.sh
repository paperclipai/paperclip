#!/usr/bin/env bash
# TSMC-21193 runbook wrapper — digest-sourced daily portfolio summary (0 LLM).
# Canonical implementation lives in the TSMC CTO scripts tree (shared by OpCo
# Fallback-Compiler shell handlers via opco-fallback-dispatch.py).
set -euo pipefail
CANON="${DETERMINISTIC_REPORTS_PY:-/Users/glad0s/.paperclip/instances/default/companies/e6361895-a6a4-438d-bb76-b17a0ad026cb/agents/3733fb01-0791-442c-83d0-eb69a5c6602b/instructions/scripts/deterministic-reports.py}"
exec python3 "$CANON" --mode portfolio "$@"
