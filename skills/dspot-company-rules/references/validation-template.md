# Validation Script Template

This is the standard scaffold for DSpot project and agent validation scripts.
Copy and adapt for your project. The goal is a single runnable script that any
agent can execute to confirm the environment is healthy before starting work.

---

## Project Validation Script

**Location:** `<project-root>/scripts/validate.sh` (or `.py`, `.ts` — pick what fits)

**When to run:** At the start of every heartbeat, before any project work begins.

```bash
#!/usr/bin/env bash
# validate.sh — Project health check
# Exit 0 = healthy. Exit 1 = problems found. Always print structured output.

set -euo pipefail

PASS=0
FAIL=0
WARNINGS=()
ERRORS=()

check() {
  local label="$1"
  local result="$2"   # "ok" | "fail" | "warn"
  local detail="${3:-}"

  if [[ "$result" == "ok" ]]; then
    echo "  [OK]   $label"
    (( PASS++ )) || true
  elif [[ "$result" == "warn" ]]; then
    echo "  [WARN] $label: $detail"
    WARNINGS+=("$label: $detail")
  else
    echo "  [FAIL] $label: $detail"
    ERRORS+=("$label: $detail")
    (( FAIL++ )) || true
  fi
}

echo "=== Project Validation: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo ""

# ── 1. Config correctness ─────────────────────────────────────────────────────
echo "-- Config"

# Example: required env vars
[[ -n "${DATABASE_URL:-}" ]] \
  && check "DATABASE_URL set" "ok" \
  || check "DATABASE_URL set" "fail" "variable is missing"

# Example: config file exists and is valid JSON/YAML
# [[ -f "config/settings.json" ]] \
#   && check "settings.json exists" "ok" \
#   || check "settings.json exists" "fail" "file not found"

echo ""

# ── 2. Data integrity ─────────────────────────────────────────────────────────
echo "-- Data integrity"

# Example: check that a critical table/file is non-empty
# ROW_COUNT=$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM companies")
# [[ "$ROW_COUNT" -gt 0 ]] \
#   && check "companies table non-empty" "ok" \
#   || check "companies table non-empty" "fail" "0 rows"

echo "  (no data checks configured — add project-specific assertions here)"
echo ""

# ── 3. Dependency checks ──────────────────────────────────────────────────────
echo "-- Dependencies"

# Example: required CLI tools
for tool in node pnpm git; do
  command -v "$tool" &>/dev/null \
    && check "$tool available" "ok" \
    || check "$tool available" "fail" "not found in PATH"
done

echo ""

# ── Summary ───────────────────────────────────────────────────────────────────
echo "=== Summary ==="
echo "  Passed:   $PASS"
echo "  Warnings: ${#WARNINGS[@]}"
echo "  Failed:   $FAIL"

if [[ ${#ERRORS[@]} -gt 0 ]]; then
  echo ""
  echo "Errors:"
  for e in "${ERRORS[@]}"; do echo "  - $e"; done
fi

if [[ ${#WARNINGS[@]} -gt 0 ]]; then
  echo ""
  echo "Warnings:"
  for w in "${WARNINGS[@]}"; do echo "  - $w"; done
fi

echo ""
if [[ $FAIL -gt 0 ]]; then
  echo "RESULT: UNHEALTHY — fix errors before proceeding"
  exit 1
else
  echo "RESULT: HEALTHY"
  exit 0
fi
```

---

## Agent Self-Validation Script

**Location:** `<project-root>/scripts/agent-self-check.sh`

**When to run:** At the start of every heartbeat, before picking up any task.

```bash
#!/usr/bin/env bash
# agent-self-check.sh — Agent workspace and capability check
# Exit 0 = ready. Exit 1 = not ready, surface blocker before working.

set -euo pipefail

PASS=0
FAIL=0
ERRORS=()

check() {
  local label="$1"
  local result="$2"
  local detail="${3:-}"
  if [[ "$result" == "ok" ]]; then
    echo "  [OK]   $label"
    (( PASS++ )) || true
  else
    echo "  [FAIL] $label: $detail"
    ERRORS+=("$label: $detail")
    (( FAIL++ )) || true
  fi
}

echo "=== Agent Self-Check: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo ""

# ── 1. Workspace access ───────────────────────────────────────────────────────
echo "-- Workspace"

[[ -d "${PROJECT_DIR:-$(pwd)}" ]] \
  && check "Project directory accessible" "ok" \
  || check "Project directory accessible" "fail" "dir not found: ${PROJECT_DIR:-$(pwd)}"

[[ -f "${AGENTS_MD_PATH:-AGENTS.md}" ]] \
  && check "AGENTS.md present" "ok" \
  || check "AGENTS.md present" "fail" "instructions file missing"

echo ""

# ── 2. Tool availability ──────────────────────────────────────────────────────
echo "-- Tools"

# Add checks for tools your agent depends on
for tool in git node; do
  command -v "$tool" &>/dev/null \
    && check "$tool available" "ok" \
    || check "$tool available" "fail" "not found in PATH"
done

# Paperclip API reachable
if [[ -n "${PAPERCLIP_API_URL:-}" ]]; then
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${PAPERCLIP_API_URL}/api/health" 2>/dev/null || echo "000")
  [[ "$HTTP_STATUS" == "200" ]] \
    && check "Paperclip API reachable" "ok" \
    || check "Paperclip API reachable" "fail" "HTTP $HTTP_STATUS"
else
  check "Paperclip API URL set" "fail" "PAPERCLIP_API_URL not set"
fi

echo ""

# ── 3. Instruction completeness ───────────────────────────────────────────────
echo "-- Instructions"

AGENTS_FILE="${AGENTS_MD_PATH:-AGENTS.md}"
if [[ -f "$AGENTS_FILE" ]]; then
  WORD_COUNT=$(wc -w < "$AGENTS_FILE")
  [[ "$WORD_COUNT" -gt 50 ]] \
    && check "AGENTS.md non-trivial ($WORD_COUNT words)" "ok" \
    || check "AGENTS.md non-trivial" "fail" "only $WORD_COUNT words — may be incomplete"
fi

echo ""

# ── Summary ───────────────────────────────────────────────────────────────────
echo "=== Summary ==="
echo "  Passed: $PASS  Failed: $FAIL"

if [[ ${#ERRORS[@]} -gt 0 ]]; then
  echo ""
  echo "Blockers:"
  for e in "${ERRORS[@]}"; do echo "  - $e"; done
  echo ""
  echo "RESULT: NOT READY — resolve blockers before taking any task"
  exit 1
else
  echo ""
  echo "RESULT: READY"
  exit 0
fi
```

---

## Exit Codes and Output Format

| Exit code | Meaning |
|-----------|---------|
| `0` | All checks passed — healthy/ready |
| `1` | One or more checks failed — do not proceed |

**Structured output rules:**
- Always print a header line with timestamp
- Use `[OK]`, `[WARN]`, `[FAIL]` prefixes for each check
- Print a `=== Summary ===` block at the end with counts
- Print `RESULT: HEALTHY` / `RESULT: UNHEALTHY` as the final line

This makes the output machine-parseable by other agents and easy to scan in logs.

---

## Adding New Checks

1. Copy a `check` call block from above.
2. Replace the label and condition.
3. Use `"ok"` for pass, `"fail"` for hard failure, `"warn"` for soft warning.
4. Commit the updated script alongside the work that made it necessary.
