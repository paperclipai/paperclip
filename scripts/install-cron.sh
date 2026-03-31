#!/usr/bin/env bash
set -euo pipefail

# install-cron.sh — Instala o cron job de validação de plugins Paperclip
#
# Uso:
#   ./scripts/install-cron.sh
#
# O que faz:
# - Copia o arquivo .cron/paperclip-plugin-validation para /etc/cron.d/
# - Define permissões corretas (644, root:root)
# - Valida sintaxe do cron
# - Opcionalmente inicia o primeiro run manual

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CRON_SOURCE="$PROJECT_ROOT/.cron/paperclip-plugin-validation"
CRON_DEST="/etc/cron.d/paperclip-plugin-validation"

echo "========================================"
echo "Paperclip Plugin Validation — Cron Installation"
echo "========================================"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "❌ This script must be run as root (sudo ./scripts/install-cron.sh)"
    exit 1
fi

# Verify source file exists
if [ ! -f "$CRON_SOURCE" ]; then
    echo "❌ Source file not found: $CRON_SOURCE"
    exit 1
fi

# Backup existing cron job if present
if [ -f "$CRON_DEST" ]; then
    BACKUP="/etc/cron.d/paperclip-plugin-validation.backup.$(date +%Y%m%d-%H%M%S)"
    echo "⚠️  Backing up existing cron job to $BACKUP"
    cp "$CRON_DEST" "$BACKUP"
fi

# Install cron job
echo "📋 Installing cron job to $CRON_DEST..."
cp "$CRON_SOURCE" "$CRON_DEST"
chmod 644 "$CRON_DEST"
chown root:root "$CRON_DEST"

# Validate cron syntax
echo "🔍 Validating cron syntax..."
if command -v crontab &>/dev/null; then
    # Extract cron line and validate
    CRON_LINE=$(grep -E "^[0-9*,/-]+ " "$CRON_DEST" | tail -1)
    if [ -n "$CRON_LINE" ]; then
        echo "✅ Cron syntax valid: $CRON_LINE"
    else
        echo "⚠️  No cron schedule line found"
    fi
else
    echo "⚠️  crontab command not found — skipping syntax validation"
fi

# Ensure log directory exists
LOG_FILE="/var/log/paperclip-plugin-validation.log"
LOG_DIR=$(dirname "$LOG_FILE")
if [ ! -d "$LOG_DIR" ]; then
    echo "📁 Creating log directory: $LOG_DIR"
    mkdir -p "$LOG_DIR"
fi
touch "$LOG_FILE"
chmod 644 "$LOG_FILE"

echo ""
echo "========================================"
echo "✅ Cron job installed successfully"
echo "========================================"
echo ""
echo "Schedule: 0 * * * * (every hour)"
echo "Log file: $LOG_FILE"
echo ""

# Optional: Run initial validation
if [ "${1:-}" = "--run-now" ]; then
    echo "🚀 Running initial validation..."
    "$PROJECT_ROOT/scripts/validate-plugins.sh"
    echo ""
    echo "✅ Initial validation complete"
else
    echo "💡 Tip: Run './scripts/install-cron.sh --run-now' to execute initial validation"
fi

echo ""
echo "To uninstall:"
echo "  sudo rm /etc/cron.d/paperclip-plugin-validation"
echo ""

exit 0
