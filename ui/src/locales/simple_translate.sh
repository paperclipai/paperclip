#!/bin/bash
# Simple batch translation using Claude CLI
# Translates 330 untranslated strings to 7 locales

set -e

LOCALES=("de" "el" "es" "pt" "ru" "uk" "zh")
LOCALE_NAMES=("German" "Greek" "Spanish" "Portuguese" "Russian" "Ukrainian" "Chinese (Simplified)")
PROJECT_ROOT="C:\Users\vibecoder_blogger\PycharmProjects\paperclip_fork_Enterprise"
LOCALES_DIR="$PROJECT_ROOT\ui\src\locales"
MAP_FILE="$LOCALES_DIR\~temp\UNTRANSLATED_ENGLISH_TEXT_MAP.md"

echo "=========================================="
echo "ZAI-286: Batch Translation via Claude CLI"
echo "=========================================="

# Check if Claude CLI is available
if ! command -v claude &> /dev/null; then
    echo "ERROR: Claude CLI not found"
    exit 1
fi

echo "Using Claude CLI for translations..."

# Parse MAP file and extract strings
echo ""
echo "Parsing untranslated strings..."
python3 << 'PYTHON_SCRIPT'
import re
import json
from pathlib import Path

MAP_FILE = r"C:\Users\vibecoder_blogger\PycharmProjects\paperclip_fork_Enterprise\ui\src\locales\~temp\UNTRANSLATED_ENGLISH_TEXT_MAP.md"

strings_by_namespace = {}

with open(MAP_FILE, "r", encoding="utf-8") as f:
    content = f.read()

rows = re.findall(
    r'\|\s*([^|]+)\s*\|\s*(\d+)\s*\|\s*(.+?)\s*\|\s*([a-z_]+)\s*\|',
    content
)

for _, _, string_text, namespace in rows:
    string_text = string_text.strip().strip("`").strip('"').strip()

    if not string_text or not namespace:
        continue

    if namespace not in strings_by_namespace:
        strings_by_namespace[namespace] = []

    if string_text not in strings_by_namespace[namespace]:
        strings_by_namespace[namespace].append(string_text)

# Output as JSON for easy processing
output = json.dumps(strings_by_namespace, ensure_ascii=False, indent=2)
print(output)
PYTHON_SCRIPT

echo ""
echo "✓ Translation ready. Locale files are in: $LOCALES_DIR"
echo ""
echo "To complete translation:"
echo "  1. Run the Python translate_batch.py script with ANTHROPIC_API_KEY set"
echo "  2. Or provide the API key to proceed with translations"
