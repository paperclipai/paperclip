#!/usr/bin/env bash
#
# test-install-cron.sh — Teste unitário do script de instalação do cron
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_SCRIPT="$PROJECT_ROOT/scripts/install-cron.sh"
CRON_SOURCE="$PROJECT_ROOT/.cron/paperclip-plugin-validation"

echo "========================================"
echo "Install Cron Script — Unit Tests"
echo "========================================"
echo ""

PASS=0
FAIL=0

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

echo "[Script Structure]"
test_file_exists "$INSTALL_SCRIPT" "install-cron.sh exists"
test_file_executable "$INSTALL_SCRIPT" "install-cron.sh is executable"
test_contains "$INSTALL_SCRIPT" "#!/usr/bin/env bash" "Has bash shebang"
test_contains "$INSTALL_SCRIPT" "set -euo pipefail" "Has strict mode"

echo ""
echo "[Root Check]"
test_contains "$INSTALL_SCRIPT" "EUID" "Checks for root privileges"
test_contains "$INSTALL_SCRIPT" "must be run as root" "Has root error message"

echo ""
echo "[Installation Logic]"
test_contains "$INSTALL_SCRIPT" "/etc/cron.d/paperclip-plugin-validation" "Installs to /etc/cron.d/"
test_contains "$INSTALL_SCRIPT" "chmod 644" "Sets correct permissions"
test_contains "$INSTALL_SCRIPT" "chown root:root" "Sets correct ownership"
test_contains "$INSTALL_SCRIPT" "backup" "Creates backup of existing cron"

echo ""
echo "[Validation]"
test_contains "$INSTALL_SCRIPT" "crontab" "Validates cron syntax"
test_contains "$INSTALL_SCRIPT" "LOG_FILE" "Configures log file"

echo ""
echo "[Source File]"
test_file_exists "$CRON_SOURCE" "Cron source file exists"
test_contains "$CRON_SOURCE" "0 * * * *" "Has hourly schedule"

echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed"
echo "========================================"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi

exit 0
