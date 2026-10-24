#!/usr/bin/env bash
# audit-runners.sh — list self-hosted runners and detect orphans.
#
# A runner is "orphan" if its registered repo no longer exists on GitHub or has
# been archived. Useful for catching dangling runners after company sunset.
#
# Usage:
#   bash scripts/audit-runners.sh

set -euo pipefail

RUNNERS_DIR="${HOME}/actions-runners"

if [ ! -d "$RUNNERS_DIR" ]; then
  echo "No runners directory at $RUNNERS_DIR" >&2
  exit 0
fi

echo "Auditing runners in $RUNNERS_DIR"
echo ""
printf "%-30s %-30s %-10s %s\n" "RUNNER" "REPO" "STATUS" "NOTE"
printf "%-30s %-30s %-10s %s\n" "------" "----" "------" "----"

ORPHANS=()

for runner_dir in "$RUNNERS_DIR"/runner-*; do
  [ -d "$runner_dir" ] || continue
  name="$(basename "$runner_dir")"
  config_file="$runner_dir/.runner"

  if [ ! -f "$config_file" ]; then
    printf "%-30s %-30s %-10s %s\n" "$name" "(no .runner file)" "UNKNOWN" "skipping"
    continue
  fi

  url=$(jq -r '.gitHubUrl' "$config_file" 2>/dev/null || echo "")
  repo_full=$(echo "$url" | sed -E 's|https://github.com/||')

  if [ -z "$repo_full" ]; then
    printf "%-30s %-30s %-10s %s\n" "$name" "(unparseable URL)" "UNKNOWN" ""
    continue
  fi

  api_status=$(gh api "repos/${repo_full}" --jq '.archived // false' 2>&1 || echo "ERROR")

  if echo "$api_status" | grep -qi "not found"; then
    printf "%-30s %-30s %-10s %s\n" "$name" "$repo_full" "ORPHAN" "repo 404"
    ORPHANS+=("$name ($repo_full)")
  elif [ "$api_status" = "true" ]; then
    printf "%-30s %-30s %-10s %s\n" "$name" "$repo_full" "ARCHIVED" "repo archived"
    ORPHANS+=("$name ($repo_full)")
  elif [ "$api_status" = "false" ]; then
    printf "%-30s %-30s %-10s %s\n" "$name" "$repo_full" "OK" ""
  else
    printf "%-30s %-30s %-10s %s\n" "$name" "$repo_full" "ERROR" "$(echo "$api_status" | head -1)"
  fi
done

echo ""
if [ ${#ORPHANS[@]} -eq 0 ]; then
  echo "No orphan runners detected."
else
  echo "Orphan runners (${#ORPHANS[@]}):"
  for o in "${ORPHANS[@]}"; do
    echo "  - $o"
  done
  echo ""
  echo "To remove an orphan:"
  echo "  gh api -X DELETE /repos/<owner>/<repo>/actions/runners/<id>"
  echo "  sudo systemctl stop  actions.runner.<owner>-<repo>.<runner-name>.service"
  echo "  sudo systemctl disable actions.runner.<owner>-<repo>.<runner-name>.service"
  echo "  rm -rf \$HOME/actions-runners/<runner-name>"
fi
