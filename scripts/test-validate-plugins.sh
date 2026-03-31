#!/usr/bin/env bash
#
# validate-plugins.sh — Teste unitário do script de validação
#
# Testa a estrutura e comportamento do validate-plugins.sh sem executar
# a validação completa (que levaria ~30s).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VALIDATE_SCRIPT="$PROJECT_ROOT/scripts/validate-plugins.sh"

echo "========================================"
echo "Validate Plugins Script — Unit Tests"
echo "========================================"
echo ""

PASS=0
FAIL=0

# Test helper
test_file_exists() {
    local file="$1"
    local desc="$2"
    if [ -f "$file" ]; then
        echo "✅ $desc"
        PASS=$((PASS + 1))
    else
        echo "❌ $desc: $file not found"
        FAIL=$((FAIL + 1))
    fi
}

test_file_executable() {
    local file="$1"
    local desc="$2"
    if [ -x "$file" ]; then
        echo "✅ $desc"
        PASS=$((PASS + 1))
    else
        echo "❌ $desc: $file not executable"
        FAIL=$((FAIL + 1))
    fi
}

test_contains() {
    local file="$1"
    local pattern="$2"
    local desc="$3"
    if grep -q "$pattern" "$file"; then
        echo "✅ $desc"
        PASS=$((PASS + 1))
    else
        echo "❌ $desc: pattern '$pattern' not found"
        FAIL=$((FAIL + 1))
    fi
}

# Tests
echo "[Script Structure]"
test_file_exists "$VALIDATE_SCRIPT" "validate-plugins.sh exists"
test_file_executable "$VALIDATE_SCRIPT" "validate-plugins.sh is executable"
test_contains "$VALIDATE_SCRIPT" "#!/usr/bin/env bash" "Has bash shebang"
test_contains "$VALIDATE_SCRIPT" "set -euo pipefail" "Has strict mode"

echo ""
echo "[Validation Steps]"
test_contains "$VALIDATE_SCRIPT" "SDK Typecheck" "Has SDK typecheck step"
test_contains "$VALIDATE_SCRIPT" "SDK Unit Tests" "Has SDK tests step"
test_contains "$VALIDATE_SCRIPT" "Plugin E2E Lifecycle Tests" "Has E2E tests step"
test_contains "$VALIDATE_SCRIPT" "Plugin Typecheck" "Has plugin typecheck step"
test_contains "$VALIDATE_SCRIPT" "Plugin Build" "Has plugin build step"
test_contains "$VALIDATE_SCRIPT" "Documentation Validation" "Has docs validation step"

echo ""
echo "[Report Generation]"
test_contains "$VALIDATE_SCRIPT" "REPORT_FILE=" "Generates JSON report"
test_contains "$VALIDATE_SCRIPT" '"overall_status"' "Report has overall_status field"
test_contains "$VALIDATE_SCRIPT" '"total_duration_seconds"' "Report has duration field"

echo ""
echo "[Cron Integration]"
CRON_FILE="$PROJECT_ROOT/.cron/paperclip-plugin-validation"
test_file_exists "$CRON_FILE" "Cron job file exists"
test_contains "$CRON_FILE" "validate-plugins.sh" "Cron references validate script"

echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed"
echo "========================================"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi

exit 0
