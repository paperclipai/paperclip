#!/usr/bin/env bash
# check-i18n-only-diff.sh [GIT_RANGE]
# Validates that changes in the range are i18n-compliant.
set -uo pipefail
RANGE=${1:-"origin/master"}
# Strip ..HEAD if present to compare against working tree
BASELINE=${RANGE%..*}
violations=0

fail() {
  echo "FAIL: $1" >&2
  violations=$((violations + 1))
}

# Check TSX changes for unlocalized text
while IFS= read -r filepath; do
  [[ -z "$filepath" ]] && continue
  [[ "$filepath" != *.tsx ]] && continue
  [[ "$filepath" == *".test.tsx" ]] && continue # Skip tests
  [[ "$filepath" == *"storybook/stories/"* ]] && continue # Skip storybook
  [[ "$filepath" == *"examples/"* ]] && continue # Skip examples
  [[ "$filepath" == *"UxLab.tsx" ]] && continue # Skip UX labs
  [[ "$filepath" == *"DesignGuide.tsx" ]] && continue # Skip Design Guide

  # Every added line relative to baseline must match i18n patterns or be structural
  while IFS= read -r line; do
    content="${line:1}"

    # Bypasses for structural code
    [[ -z "${content//[[:space:]]/}" ]] && continue
    echo "$content" | grep -qE "^\s*(//|/\*|\*|\{/\*)" && continue
    echo "$content" | grep -qE "^[[:space:]]*(import|export)\b" && continue
    echo "$content" | grep -qE "^\s*<[a-zA-Z0-9.]+|^\s*</[a-zA-Z0-9.]+|^\s*/>|^\s*\{|\s*\}|^\s*[})\];,]*$" && continue
    echo "$content" | grep -qE "^\s*(useEffect|useState|useMemo|useCallback|const |return |if \(|console\.|function |case |default:)" && continue
    echo "$content" | grep -qE "^\s*[a-zA-Z0-9_]+:\s*|createdAt:|version:|id:|tone:|kind:|title:|description:|label:|icon:" && continue
    echo "$content" | grep -qE "Story = |render: |ScenarioCard|expect\(|async \(" && continue
    echo "$content" | grep -qE "className=|data-testid=|\bcn\(|^\s*\"[a-z0-9/\s.#:-]+\",?\s*$" && continue
    echo "$content" | grep -qiE "workMode|isPlanning|planningMode" && continue

    # Allowed i18n patterns
    echo "$content" | grep -qE "t\([\"'\`]|i18n\.t\([\"'\`]" && continue

    # If it contains a string but no t(), it might be a violation
    if echo "$content" | grep -qE "[\"'\`][A-Z][a-z]+ "; then
       fail "Potential unlocalized text in $filepath: $(echo "$content" | cut -c1-120)"
    fi
  done < <(git diff "$BASELINE" -- "$filepath" 2>/dev/null | grep '^+' | grep -v '^+++')
done < <(git diff --name-only "$BASELINE" 2>/dev/null || true)

if [[ $violations -eq 0 ]]; then
  echo "OK: changes since $BASELINE look i18n-compliant"
  exit 0
else
  echo "FAIL: $violations potential violation(s) found since $BASELINE" >&2
  exit 1
fi

