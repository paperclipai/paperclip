#!/usr/bin/env bash
# TSMC-21193 runbook wrapper — MC multi-company digest rollup (0 LLM).
set -euo pipefail
CANON="${DETERMINISTIC_REPORTS_PY:-/Users/glad0s/.paperclip/instances/default/companies/e6361895-a6a4-438d-bb76-b17a0ad026cb/agents/3733fb01-0791-442c-83d0-eb69a5c6602b/instructions/scripts/deterministic-reports.py}"
exec python3 "$CANON" --mode rollup "$@"
