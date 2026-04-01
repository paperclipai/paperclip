#!/usr/bin/env bash
set -euo pipefail

# validate-plugins.sh — Validação autônoma do sistema de plugins Paperclip
#
# Executa validação completa do sistema de plugins:
# - SDK typecheck e testes unitários
# - E2E lifecycle tests (sem dependência Postgres)
# - Build de todos os plugins
# - Validação de documentação
#
# Uso:
#   ./scripts/validate-plugins.sh
#   # Ou via cron: 0 * * * * /root/paperclip-repo/scripts/validate-plugins.sh >> /var/log/paperclip-plugin-validation.log 2>&1
#
# Output:
#   - Logs detalhados em stdout
#   - JSON report em /tmp/paperclip-plugin-validation-<timestamp>.json

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

# Config
TIMESTAMP=$(date -Iseconds)
COMMIT=$(git rev-parse --short HEAD)
REPORT_FILE="/tmp/paperclip-plugin-validation-$(date +%Y%m%d-%H%M%S).json"

# Initialize counters
declare -A STEP_DURATION
declare -A STEP_STATUS
TOTAL_START=$(date +%s)

echo "========================================"
echo "Paperclip Plugin System Validation"
echo "Timestamp: $TIMESTAMP"
echo "Commit: $COMMIT"
echo "========================================"
echo ""

# ── Documentation Sync Helpers ────────────────────────────────────────
get_doc_field_line() {
    local file="$1"
    local field="$2"
    grep -m1 "^\\*\\*${field}\\*\\* " "$file" || true
}

validate_doc_status_sync() {
    local doc_readme="$PROJECT_ROOT/doc/plugins/README.md"
    local package_readme="$PROJECT_ROOT/packages/plugins/README.md"
    local doc_status_line pkg_status_line
    local doc_updated_line pkg_updated_line
    local doc_updated_date pkg_updated_date

    doc_status_line="$(get_doc_field_line "$doc_readme" "Status:")"
    pkg_status_line="$(get_doc_field_line "$package_readme" "Status:")"
    doc_updated_line="$(get_doc_field_line "$doc_readme" "Last Updated:")"
    pkg_updated_line="$(get_doc_field_line "$package_readme" "Last Updated:")"

    if [ -z "$doc_status_line" ] || [ -z "$pkg_status_line" ] || [ -z "$doc_updated_line" ] || [ -z "$pkg_updated_line" ]; then
        echo "❌ Documentation status sync failed: missing status metadata"
        echo "   doc/plugins/README.md status: ${doc_status_line:-<missing>}"
        echo "   packages/plugins/README.md status: ${pkg_status_line:-<missing>}"
        return 1
    fi

    if [ "$doc_status_line" != "$pkg_status_line" ]; then
        echo "❌ Documentation status sync failed: status lines differ"
        echo "   doc/plugins/README.md: $doc_status_line"
        echo "   packages/plugins/README.md: $pkg_status_line"
        return 1
    fi

    doc_updated_date="${doc_updated_line#\*\*Last Updated:\*\* }"
    doc_updated_date="${doc_updated_date%% *}"
    pkg_updated_date="${pkg_updated_line#\*\*Last Updated:\*\* }"
    pkg_updated_date="${pkg_updated_date%% *}"

    if [ "$doc_updated_date" != "$pkg_updated_date" ]; then
        echo "❌ Documentation status sync failed: last updated dates differ"
        echo "   doc/plugins/README.md: $doc_updated_date"
        echo "   packages/plugins/README.md: $pkg_updated_date"
        return 1
    fi

    echo "✅ Documentation status sync passed"
}

# ── Step 0: Script Self-Tests ──────────────────────────────────────────
echo "[0/7] Script Self-Tests..."
STEP_START=$(date +%s)
if "$PROJECT_ROOT/scripts/test-validate-plugins.sh" > /dev/null 2>&1 && \
   "$PROJECT_ROOT/scripts/test-install-cron.sh" > /dev/null 2>&1; then
    STEP_DURATION[self_tests]=$(($(date +%s) - STEP_START))
    STEP_STATUS[self_tests]="pass"
    echo "✅ Script self-tests passed (${STEP_DURATION[self_tests]}s)"
else
    STEP_DURATION[self_tests]=$(($(date +%s) - STEP_START))
    STEP_STATUS[self_tests]="fail"
    echo "❌ Script self-tests failed"
    exit 1
fi
echo ""

# ── Step 1: SDK Typecheck ──────────────────────────────────────────────
echo "[1/7] SDK Typecheck..."
STEP_START=$(date +%s)
if pnpm --filter @paperclipai/plugin-sdk typecheck; then
    STEP_DURATION[typecheck]=$(($(date +%s) - STEP_START))
    STEP_STATUS[typecheck]="pass"
    echo "✅ SDK typecheck passed (${STEP_DURATION[typecheck]}s)"
else
    STEP_DURATION[typecheck]=$(($(date +%s) - STEP_START))
    STEP_STATUS[typecheck]="fail"
    echo "❌ SDK typecheck failed"
    exit 1
fi
echo ""

# ── Step 2: SDK Unit Tests ─────────────────────────────────────────────
echo "[2/7] SDK Unit Tests..."
STEP_START=$(date +%s)
if pnpm --filter @paperclipai/plugin-sdk test; then
    STEP_DURATION[tests]=$(($(date +%s) - STEP_START))
    STEP_STATUS[tests]="pass"
    echo "✅ SDK tests passed (${STEP_DURATION[tests]}s)"
else
    STEP_DURATION[tests]=$(($(date +%s) - STEP_START))
    STEP_STATUS[tests]="fail"
    echo "❌ SDK tests failed"
    exit 1
fi
echo ""

# ── Step 3: Plugin E2E Lifecycle Tests ─────────────────────────────────
echo "[3/7] Plugin E2E Lifecycle Tests..."
STEP_START=$(date +%s)
if pnpm test -- plugin-e2e-lifecycle; then
    STEP_DURATION[e2e]=$(($(date +%s) - STEP_START))
    STEP_STATUS[e2e]="pass"
    echo "✅ E2E lifecycle tests passed (${STEP_DURATION[e2e]}s)"
else
    STEP_DURATION[e2e]=$(($(date +%s) - STEP_START))
    STEP_STATUS[e2e]="fail"
    echo "❌ E2E lifecycle tests failed"
    exit 1
fi
echo ""

# ── Step 4: Plugin Typecheck (PARALLEL) ─────────────────────────────────
echo "[4/7] Plugin Typecheck (all plugins, parallel)..."
STEP_START=$(date +%s)
PLUGIN_STATUS=()
TYPECHECK_PIDS=()

# Start all typechecks in parallel
for plugin in playwright-mcp ruflo-bridge skills-hub; do
    echo "  Typechecking @paperclipai/plugin-$plugin (background)..."
    (
        if pnpm --filter @paperclipai/plugin-$plugin typecheck > /tmp/typecheck-$plugin.log 2>&1; then
            echo "PASS" > /tmp/typecheck-$plugin.status
        else
            echo "FAIL" > /tmp/typecheck-$plugin.status
        fi
    ) &
    TYPECHECK_PIDS+=($!)
done

# Wait for all typechecks and check results
for i in "${!TYPECHECK_PIDS[@]}"; do
    plugin=$(echo "playwright-mcp ruflo-bridge skills-hub" | cut -d' ' -f$((i+1)))
    wait ${TYPECHECK_PIDS[$i]}
    if [ "$(cat /tmp/typecheck-$plugin.status)" = "PASS" ]; then
        PLUGIN_STATUS+=("\"$plugin\": \"pass\"")
        echo "  ✅ $plugin passed"
    else
        PLUGIN_STATUS+=("\"$plugin\": \"fail\"")
        echo "  ❌ $plugin failed"
        cat /tmp/typecheck-$plugin.log
        STEP_DURATION[typecheck]=$(($(date +%s) - STEP_START))
        STEP_STATUS[typecheck]="fail"
        exit 1
    fi
done
STEP_DURATION[typecheck]=$(($(date +%s) - STEP_START))
STEP_STATUS[typecheck]="pass"
echo "✅ All plugins typecheck passed (${STEP_DURATION[typecheck]}s)"
echo ""

# ── Step 5: Plugin Build (PARALLEL) ─────────────────────────────────────
echo "[5/7] Plugin Build (all plugins, parallel)..."
STEP_START=$(date +%s)
BUILD_PIDS=()

# Start all builds in parallel
for plugin in playwright-mcp ruflo-bridge skills-hub; do
    echo "  Building @paperclipai/plugin-$plugin (background)..."
    (
        if pnpm --filter @paperclipai/plugin-$plugin build > /tmp/build-$plugin.log 2>&1; then
            echo "PASS" > /tmp/build-$plugin.status
        else
            echo "FAIL" > /tmp/build-$plugin.status
        fi
    ) &
    BUILD_PIDS+=($!)
done

# Wait for all builds and check results
for i in "${!BUILD_PIDS[@]}"; do
    plugin=$(echo "playwright-mcp ruflo-bridge skills-hub" | cut -d' ' -f$((i+1)))
    wait ${BUILD_PIDS[$i]}
    if [ "$(cat /tmp/build-$plugin.status)" = "PASS" ]; then
        echo "  ✅ $plugin built"
    else
        echo "  ❌ $plugin build failed"
        cat /tmp/build-$plugin.log
        STEP_DURATION[build]=$(($(date +%s) - STEP_START))
        STEP_STATUS[build]="fail"
        exit 1
    fi
done
STEP_DURATION[build]=$(($(date +%s) - STEP_START))
STEP_STATUS[build]="pass"
echo "✅ All plugins built successfully (${STEP_DURATION[build]}s)"
echo ""

# ── Step 6: Documentation Validation ───────────────────────────────────
echo "[6/7] Documentation Validation..."
STEP_START=$(date +%s)
DOCS_STATUS=()
if ! validate_doc_status_sync; then
    STEP_DURATION[docs]=$(($(date +%s) - STEP_START))
    STEP_STATUS[docs]="fail"
    exit 1
fi

if [ ! -f "doc/plugins/README.md" ]; then
    echo "❌ doc/plugins/README.md not found"
    DOCS_STATUS+=("\"doc/plugins/README.md\": \"missing\"")
else
    DOCS_STATUS+=("\"doc/plugins/README.md\": \"present\"")
fi

if [ ! -f "doc/plugins/PLUGIN_SPEC.md" ]; then
    echo "❌ doc/plugins/PLUGIN_SPEC.md not found"
    DOCS_STATUS+=("\"doc/plugins/PLUGIN_SPEC.md\": \"missing\"")
else
    DOCS_STATUS+=("\"doc/plugins/PLUGIN_SPEC.md\": \"present\"")
fi

if [ ! -f "doc/plugins/PLUGIN_AUTHORING_GUIDE.md" ]; then
    echo "❌ doc/plugins/PLUGIN_AUTHORING_GUIDE.md not found"
    DOCS_STATUS+=("\"doc/plugins/PLUGIN_AUTHORING_GUIDE.md\": \"missing\"")
else
    DOCS_STATUS+=("\"doc/plugins/PLUGIN_AUTHORING_GUIDE.md\": \"present\"")
fi

for plugin in playwright-mcp ruflo-bridge skills-hub; do
    if [ ! -f "packages/plugins/$plugin/README.md" ]; then
        echo "❌ packages/plugins/$plugin/README.md not found"
        DOCS_STATUS+=("\"packages/plugins/$plugin/README.md\": \"missing\"")
    else
        DOCS_STATUS+=("\"packages/plugins/$plugin/README.md\": \"present\"")
    fi
done

if [[ "${DOCS_STATUS[@]}" == *"missing"* ]]; then
    STEP_DURATION[docs]=$(($(date +%s) - STEP_START))
    STEP_STATUS[docs]="fail"
    exit 1
fi

STEP_DURATION[docs]=$(($(date +%s) - STEP_START))
STEP_STATUS[docs]="pass"
echo "✅ Documentation validation passed (${STEP_DURATION[docs]}s)"
echo ""

# ── Step 7: Install Script Validation ──────────────────────────────────
echo "[7/7] Install Script Validation..."
STEP_START=$(date +%s)
if [ -f "$PROJECT_ROOT/scripts/install-cron.sh" ] && [ -x "$PROJECT_ROOT/scripts/install-cron.sh" ]; then
    STEP_DURATION[install_script]=$(($(date +%s) - STEP_START))
    STEP_STATUS[install_script]="pass"
    echo "✅ Install script present and executable (${STEP_DURATION[install_script]}s)"
else
    STEP_DURATION[install_script]=$(($(date +%s) - STEP_START))
    STEP_STATUS[install_script]="fail"
    echo "❌ Install script missing or not executable"
    exit 1
fi
echo ""

# ── Summary ────────────────────────────────────────────────────────────
TOTAL_END=$(date +%s)
TOTAL_DURATION=$((TOTAL_END - TOTAL_START))

echo "========================================"
echo "✅ ALL VALIDATIONS PASSED"
echo "Timestamp: $TIMESTAMP"
echo "Commit: $COMMIT"
echo "Total Duration: ${TOTAL_DURATION}s"
echo "========================================"
echo ""

# Generate JSON report
cat > "$REPORT_FILE" << EOF
{
  "timestamp": "$TIMESTAMP",
  "commit": "$COMMIT",
  "overall_status": "pass",
  "total_duration_seconds": $TOTAL_DURATION,
  "steps": {
    "self_tests": {"status": "${STEP_STATUS[self_tests]:-pass}", "duration_seconds": ${STEP_DURATION[self_tests]:-0}},
    "typecheck": {"status": "${STEP_STATUS[typecheck]:-pass}", "duration_seconds": ${STEP_DURATION[typecheck]:-0}},
    "tests": {"status": "${STEP_STATUS[tests]:-pass}", "duration_seconds": ${STEP_DURATION[tests]:-0}},
    "e2e": {"status": "${STEP_STATUS[e2e]:-pass}", "duration_seconds": ${STEP_DURATION[e2e]:-0}},
    "typecheck_plugins": {"status": "${STEP_STATUS[typecheck]:-pass}", "duration_seconds": ${STEP_DURATION[typecheck]:-0}},
    "build": {"status": "${STEP_STATUS[build]:-pass}", "duration_seconds": ${STEP_DURATION[build]:-0}},
    "docs": {"status": "${STEP_STATUS[docs]:-pass}", "duration_seconds": ${STEP_DURATION[docs]:-0}},
    "install_script": {"status": "${STEP_STATUS[install_script]:-pass}", "duration_seconds": ${STEP_DURATION[install_script]:-0}}
  },
  "plugins": {
    $(IFS=,; echo "${PLUGIN_STATUS[*]}")
  },
  "documentation": {
    $(IFS=,; echo "${DOCS_STATUS[*]}")
  }
}
EOF

echo "📄 JSON Report: $REPORT_FILE"
echo ""

exit 0
