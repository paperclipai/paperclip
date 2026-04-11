#!/bin/bash
# Block all leader agents from editing COS v2 repo files.
# Only the board user (human operator) may modify this codebase.
# Agents should work in their assigned project repos, not here.

AGENT_ID="${COS_AGENT_ID:-}"

if [ -n "$AGENT_ID" ]; then
  echo "BLOCKED: Agent $AGENT_ID attempted to modify COS v2 repo."
  echo "This repo is managed by the operator only."
  echo "Work in your assigned project repo instead."
  exit 1
fi

exit 0
