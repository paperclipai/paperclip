#!/usr/bin/env bash
set -euo pipefail

# Deploy agent instruction templates to ~/.paperclip/instances/default/companies/
#
# Usage:
#   ./deploy.sh              # Deploy all companies
#   ./deploy.sh --dry-run    # Show what would be deployed without making changes
#   ./deploy.sh --company AnytimeInterview  # Deploy one company only

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTANCE_DIR="$HOME/.paperclip/instances/default/companies"
PAPERCLIP_DB="postgresql://paperclip:paperclip@localhost:54329/paperclip"

# Find psql
PSQL=""
for candidate in psql /opt/homebrew/Cellar/libpq/*/bin/psql /usr/local/bin/psql; do
  if command -v "$candidate" &>/dev/null || [ -x "$candidate" ]; then
    PSQL="$candidate"
    break
  fi
done
if [ -z "$PSQL" ]; then
  # Try glob expansion
  for p in /opt/homebrew/Cellar/libpq/*/bin/psql; do
    [ -x "$p" ] && PSQL="$p" && break
  done
fi
if [ -z "$PSQL" ]; then
  echo "ERROR: psql not found. Install libpq or postgresql."
  exit 1
fi

DRY_RUN=false
FILTER_COMPANY=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run) DRY_RUN=true; shift ;;
    --company) FILTER_COMPANY="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Determine template group for a company
get_template_group() {
  local company_name="$1"
  case "$company_name" in
    DickBot) echo "dickbot" ;;
    Test) echo "test-company" ;;
    *) echo "product" ;;
  esac
}

# Map agent name/role to template subdirectory
get_template_dir() {
  local agent_name="$1"
  local agent_role="$2"
  local group="$3"

  case "$group" in
    dickbot)
      case "$agent_name" in
        CEO) echo "ceo" ;;
        Analyst) echo "analyst" ;;
        Pre-planner) echo "pre-planner" ;;
        Executor) echo "executor" ;;
        Supervisor) echo "supervisor" ;;
        *) echo "" ;;
      esac
      ;;
    test-company)
      case "$agent_role" in
        ceo) echo "ceo" ;;
        cto) echo "cto" ;;
        *) echo "" ;;
      esac
      ;;
    product)
      case "$agent_name" in
        CEO) echo "ceo" ;;
        Pre-planner) echo "pre-planner" ;;
        Executor) echo "executor" ;;
        Supervisor) echo "supervisor" ;;
        Security) echo "security" ;;
        Triage) echo "triage" ;;
        Test) echo "test" ;;
        *) echo "" ;;
      esac
      ;;
  esac
}

CHANGES=0
SKIPPED=0
ERRORS=0

# Query all active agents (status = idle or running)
AGENTS=$("$PSQL" "$PAPERCLIP_DB" -t -A -F'|' -c "
SELECT c.name, c.id, a.name, a.id, a.role
FROM agents a
JOIN companies c ON a.company_id = c.id
WHERE a.status IN ('idle', 'running')
ORDER BY c.name, a.name;
")

while IFS='|' read -r company_name company_id agent_name agent_id agent_role; do
  # Skip empty lines
  [[ -z "$company_name" ]] && continue

  # Skip if filtering by company
  if [[ -n "$FILTER_COMPANY" && "$company_name" != "$FILTER_COMPANY" ]]; then
    continue
  fi

  group=$(get_template_group "$company_name")
  template_subdir=$(get_template_dir "$agent_name" "$agent_role" "$group")

  if [[ -z "$template_subdir" ]]; then
    echo "SKIP: $company_name/$agent_name ($agent_role) — no template mapping"
    ((SKIPPED++))
    continue
  fi

  template_path="$SCRIPT_DIR/$group/$template_subdir"
  target_path="$INSTANCE_DIR/$company_id/agents/$agent_id/instructions"

  if [[ ! -d "$template_path" ]]; then
    echo "ERROR: Template dir missing: $template_path"
    ((ERRORS++))
    continue
  fi

  # Check each template file
  for template_file in "$template_path"/*.md; do
    [[ -f "$template_file" ]] || continue
    filename=$(basename "$template_file")
    target_file="$target_path/$filename"

    if [[ -f "$target_file" ]]; then
      # Compare checksums
      src_hash=$(md5 -q "$template_file")
      dst_hash=$(md5 -q "$target_file")
      if [[ "$src_hash" == "$dst_hash" ]]; then
        continue  # Identical, skip silently
      fi
    fi

    if $DRY_RUN; then
      echo "WOULD DEPLOY: $company_name/$agent_name/$filename"
    else
      mkdir -p "$target_path"
      cp "$template_file" "$target_file"
      echo "DEPLOYED: $company_name/$agent_name/$filename"
    fi
    ((CHANGES++))
  done
done <<< "$AGENTS"

echo ""
echo "=== Deploy Summary ==="
echo "Changes: $CHANGES"
echo "Skipped: $SKIPPED"
echo "Errors: $ERRORS"
if $DRY_RUN; then
  echo "(dry run — no files were modified)"
fi
