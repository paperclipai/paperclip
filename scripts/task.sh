#!/usr/bin/env bash
# Push an ad-hoc task into the CEO agent's inbox from the terminal.
# Usage: ./scripts/task.sh "Launch a course on Blender + Claude"
#
# Wires into the Paperclip task API once the company is booted.

set -euo pipefail

BRIEF="${*:?Usage: task.sh \"<your brief>\"}"

# Placeholder — replace with `paperclip task create` invocation once
# the company + adapter wiring is live (Phase 2).
echo "TODO(Phase 2): post brief to Paperclip company learnova-academy CEO inbox"
echo "Brief: $BRIEF"
