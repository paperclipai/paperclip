#!/usr/bin/env bash
# nightly-repo-hygiene.sh — Non-destructive repo hygiene audit for /opt/paperclip
#
# Captures git status and classifies dirty files into categories.
# Outputs a concise markdown report to reports/repo-hygiene/latest.md.
# Never modifies the working tree. Exits 0 even when the repo is dirty.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REPORT_DIR="$REPO_ROOT/reports/repo-hygiene"
REPORT_FILE="$REPORT_DIR/latest.md"
TIMESTAMP="$(date --utc +'%Y-%m-%dT%H:%M:%SZ')"
GIT_HASH="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "unknown")"
GIT_BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")"

mkdir -p "$REPORT_DIR"

# ── Collect git status ──────────────────────────────────────────────
STATUS_OUTPUT="$(git -C "$REPO_ROOT" status --short 2>/dev/null || true)"
NO_TOTAL="$(echo "$STATUS_OUTPUT" | grep -c . || true)"

# ── Parse status lines ──────────────────────────────────────────────
STAGED=$(echo "$STATUS_OUTPUT" | grep -c '^[MARCD]' || true)
UNSTAGED_MODIFIED=$(echo "$STATUS_OUTPUT" | grep -c '^.[M]' || true)
DELETED=$(echo "$STATUS_OUTPUT" | grep -c '^.[D]' || true)
RENAMED=$(echo "$STATUS_OUTPUT" | grep -c '^R' || true)
UNTRACKED=$(echo "$STATUS_OUTPUT" | grep -c '^?' || true)

# ── Categorize untracked files ─────────────────────────────────────
untracked_scripts=()
untracked_env=()
untracked_artifacts=()
untracked_generated=()
untracked_source=()
untracked_docs=()
untracked_migrations=()
untracked_other=()
untracked_secrets=()

while IFS= read -r line; do
  file="${line:3}"
  case "$file" in
    .env*|*/.env*|*.key|*.pem|*.cert|*secret*|*token*|*credential*|*password*)
      untracked_secrets+=("$file") ;;
    supabase/.temp/*|.vite/*|coverage/*)
      untracked_artifacts+=("$file") ;;
    *.log|*.tmp|*.pid|*.sock|*.trace|*.dump)
      untracked_artifacts+=("$file") ;;
    *.tsbuildinfo|*/dist/*|*/build/*|*.generated.*|drizzle/meta/*)
      untracked_generated+=("$file") ;;
    *migration*|*migrate*|supabase/migrations/*|drizzle/*.sql)
      untracked_migrations+=("$file") ;;
    *.sh|*.bash|*.mjs|*.cjs|scripts/*)
      untracked_scripts+=("$file") ;;
    *.md|docs/*)
      untracked_docs+=("$file") ;;
    *.ts|*.tsx|*.js|*.jsx|*.py|*.go|*.rs|*.java|*.kt|*.rb|*.php|*.css|*.scss|*.sql)
      untracked_source+=("$file") ;;
    *)
      untracked_other+=("$file") ;;
  esac
done < <(echo "$STATUS_OUTPUT" | grep '^?' || true)

# ── Categorize tracked (staged+unstaged) changes ──────────────────
staged_source=()
staged_docs=()
staged_lockfile=()
staged_config=()
staged_migration=()
staged_other=()

unstaged_source=()
unstaged_docs=()
unstaged_lockfile=()
unstaged_config=()
unstaged_migration=()
unstaged_other=()

while IFS= read -r line; do
  file="${line:3}"
  index="${line:0:1}"
  worktree="${line:1:1}"

  case "$file" in
    *.md|docs/*)
      [ "$index" != " " ] && staged_docs+=("$file")
      [ "$worktree" != " " ] && unstaged_docs+=("$file") ;;
    package-lock.json|yarn.lock|pnpm-lock.yaml|*.lock)
      [ "$index" != " " ] && staged_lockfile+=("$file")
      [ "$worktree" != " " ] && unstaged_lockfile+=("$file") ;;
    *migration*|*migrate*|supabase/migrations/*|drizzle/*.sql)
      [ "$index" != " " ] && staged_migration+=("$file")
      [ "$worktree" != " " ] && unstaged_migration+=("$file") ;;
    *.json|*.yaml|*.yml|*.toml|*.ini|*.cfg|*.conf|.env*|*/.env*)
      [ "$index" != " " ] && staged_config+=("$file")
      [ "$worktree" != " " ] && unstaged_config+=("$file") ;;
    *.ts|*.tsx|*.js|*.jsx|*.py|*.go|*.rs|*.java|*.kt|*.rb|*.php|*.css|*.scss|*.sql|*.hbs|*.ejs|*.vue|*.svelte)
      [ "$index" != " " ] && staged_source+=("$file")
      [ "$worktree" != " " ] && unstaged_source+=("$file") ;;
    *)
      [ "$index" != " " ] && staged_other+=("$file")
      [ "$worktree" != " " ] && unstaged_other+=("$file") ;;
  esac
done < <(echo "$STATUS_OUTPUT" | grep -v '^?' || true)

# ── Suspicious / flagged items ─────────────────────────────────────
flagged_items=()

# Untracked scripts
if [ "${#untracked_scripts[@]}" -gt 0 ]; then
  flagged_items+=("**Untracked scripts** (${#untracked_scripts[@]}):")
  for f in "${untracked_scripts[@]}"; do flagged_items+=("  - \`$f\`"); done
fi

# Untracked secrets / env files
if [ "${#untracked_secrets[@]}" -gt 0 ]; then
  flagged_items+=("**Possible secrets or env files** (${#untracked_secrets[@]}):")
  for f in "${untracked_secrets[@]}"; do flagged_items+=("  - \`$f\`"); done
fi

# Lockfile changes
total_lock=$(( ${#staged_lockfile[@]} + ${#unstaged_lockfile[@]} ))
if [ "$total_lock" -gt 0 ]; then
  flagged_items+=("**Lockfile changes** ($total_lock):")
  for f in "${staged_lockfile[@]}"; do flagged_items+=("  - \`$f\` (staged)"); done
  for f in "${unstaged_lockfile[@]}"; do flagged_items+=("  - \`$f\` (unstaged)"); done
fi

# Generated files in source paths (unstaged .js/.js.map/.d.ts in src/)
generated_in_source=()
while IFS= read -r line; do
  file="${line:3}"
  if echo "$file" | grep -qE '/(src|packages)/.*\.(js|js\.map|d\.ts|d\.ts\.map)$'; then
    generated_in_source+=("$file")
  fi
done < <(echo "$STATUS_OUTPUT" | grep -v '^?' || true)

if [ "${#generated_in_source[@]}" -gt 0 ]; then
  flagged_items+=("**Generated files in source paths** (${#generated_in_source[@]}):")
  for f in "${generated_in_source[@]}"; do flagged_items+=("  - \`$f\`"); done
fi

# Broad cross-system changes (touches 3+ top-level directories)
declare -A top_level_dirs
while IFS= read -r line; do
  file="${line:3}"
  topdir="${file%%/*}"
  if [ "$topdir" != "$file" ]; then
    top_level_dirs["$topdir"]=1
  fi
done < <(echo "$STATUS_OUTPUT")
cross_count=${#top_level_dirs[@]}
if [ "$cross_count" -ge 3 ]; then
  dirs_list=""
  for d in "${!top_level_dirs[@]}"; do dirs_list="$dirs_list, $d"; done
  dirs_list="${dirs_list#, }"
  flagged_items+=("**Broad cross-system changes** — touches $cross_count top-level directories: $dirs_list")
fi

# Untracked generated/artifact files
if [ "${#untracked_generated[@]}" -gt 0 ]; then
  flagged_items+=("**Untracked generated/build files** (${#untracked_generated[@]}):")
  for f in "${untracked_generated[@]}"; do flagged_items+=("  - \`$f\`"); done
fi

if [ "${#untracked_artifacts[@]}" -gt 0 ]; then
  flagged_items+=("**Untracked runtime artifacts** (${#untracked_artifacts[@]}):")
  for f in "${untracked_artifacts[@]}"; do flagged_items+=("  - \`$f\`"); done
fi

# Untracked migration files
if [ "${#untracked_migrations[@]}" -gt 0 ]; then
  flagged_items+=("**Untracked migration files** (${#untracked_migrations[@]}):")
  for f in "${untracked_migrations[@]}"; do flagged_items+=("  - \`$f\`"); done
fi

# Staged+unstaged migration changes
total_mig=$(( ${#staged_migration[@]} + ${#unstaged_migration[@]} ))
if [ "$total_mig" -gt 0 ]; then
  flagged_items+=("**Migration file changes** ($total_mig):")
  for f in "${staged_migration[@]}"; do flagged_items+=("  - \`$f\` (staged)"); done
  for f in "${unstaged_migration[@]}"; do flagged_items+=("  - \`$f\` (unstaged)"); done
fi

# ── Generate report ──────────────────────────────────────────────────
{
  echo "# Repo Hygiene Audit — /opt/paperclip"
  echo ""
  echo "**Generated:** $TIMESTAMP"
  echo "**Branch:** $GIT_BRANCH"
  echo "**Commit:** \`$GIT_HASH\`"
  echo ""
  echo "---"
  echo ""
  echo "## Summary"
  echo ""
  echo "| Category | Count |"
  echo "|----------|-------|"
  echo "| Total dirty files | $NO_TOTAL |"
  echo "| Staged | $STAGED |"
  echo "| Unstaged modified | $UNSTAGED_MODIFIED |"
  echo "| Deleted | $DELETED |"
  echo "| Renamed | $RENAMED |"
  echo "| Untracked | $UNTRACKED |"
  echo ""
  echo "## Change Breakdown"
  echo ""
  echo "### Staged ($STAGED)"
  if [ "$STAGED" -gt 0 ]; then
    echo "- Source code: ${#staged_source[@]}"
    echo "- Docs: ${#staged_docs[@]}"
    echo "- Config: ${#staged_config[@]}"
    echo "- Lockfiles: ${#staged_lockfile[@]}"
    echo "- Migrations: ${#staged_migration[@]}"
    echo "- Other: ${#staged_other[@]}"
  else
    echo "_None._"
  fi
  echo ""
  echo "### Unstaged Modified ($UNSTAGED_MODIFIED)"
  if [ "$UNSTAGED_MODIFIED" -gt 0 ]; then
    echo "- Source code: ${#unstaged_source[@]}"
    echo "- Docs: ${#unstaged_docs[@]}"
    echo "- Config: ${#unstaged_config[@]}"
    echo "- Lockfiles: ${#unstaged_lockfile[@]}"
    echo "- Migrations: ${#unstaged_migration[@]}"
    echo "- Other: ${#unstaged_other[@]}"
  else
    echo "_None._"
  fi
  echo ""
  echo "### Untracked ($UNTRACKED)"
  if [ "$UNTRACKED" -gt 0 ]; then
    echo "- Scripts: ${#untracked_scripts[@]}"
    echo "- Source code: ${#untracked_source[@]}"
    echo "- Docs: ${#untracked_docs[@]}"
    echo "- Env/secrets: ${#untracked_secrets[@]}"
    echo "- Generated/build: ${#untracked_generated[@]}"
    echo "- Runtime artifacts: ${#untracked_artifacts[@]}"
    echo "- Migrations: ${#untracked_migrations[@]}"
    echo "- Other: ${#untracked_other[@]}"
  else
    echo "_None._"
  fi
  echo ""
  echo "---"
  echo ""
  echo "## Detailed Status"
  echo ""
  echo '```'
  echo "$STATUS_OUTPUT"
  echo '```'
  echo ""
  echo "---"
  echo ""
  echo "## Flagged Items"
  echo ""

  if [ "${#flagged_items[@]}" -gt 0 ]; then
    for item in "${flagged_items[@]}"; do
      echo "$item"
    done
  else
    echo "_No suspicious items detected._"
  fi
  echo ""
  echo "---"
  echo ""
  echo "## Assessment"
  echo ""

  severity="clean"
  if [ "${#untracked_secrets[@]}" -gt 0 ]; then
    severity="⚠️ **Review needed** — possible secrets or env files present"
  elif [ "${#flagged_items[@]}" -gt 4 ]; then
    severity="👀 **Dirty — needs review** (${#flagged_items[@]} flagged items)"
  elif [ "$NO_TOTAL" -gt 0 ]; then
    severity="📝 **Dirty but understood** ($NO_TOTAL files, ${#flagged_items[@]} flagged)"
  fi
  echo "**State:** $severity"
  echo ""
  echo "_Audit performed by \`scripts/repo-hygiene/nightly-repo-hygiene.sh\`. No files were modified._"

} > "$REPORT_FILE"

echo "Repo hygiene report written to $REPORT_FILE"
echo "Summary: $NO_TOTAL dirty files, ${#flagged_items[@]} flagged items"
exit 0
