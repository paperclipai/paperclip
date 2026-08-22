#!/usr/bin/env bash
#
# verify-report-kit.sh — Standard verification battery for the report-kit template.
#
# Sourced by agents or called directly. Performs a deterministic checklist
# so that independent verification passes produce identical results.
#
# Usage:
#   ./scripts/verify-report-kit.sh           # exit 0 = pass, 1 = fail
#   source scripts/verify-report-kit.sh      # sets $VERIFY_RC, prints summary
#
# Work-mode: read-only — never mutates files. Safe for CI.
#
set -euo pipefail

RC=0

# --- 1. Git-tracked, clean diff ---------------------------------------------
# Ensure all report-kit files are committed with no uncommitted changes.
if git diff --quiet HEAD -- report-kit/ 2>/dev/null; then
    echo "  ✓  Git diff clean (report-kit/)"
else
    echo "  ✗  Git diff is NOT clean — uncommitted changes in report-kit/"
    RC=1
fi

# --- 2. JS syntax check (report-renderer.js) --------------------------------
if node --check report-kit/report-renderer.js 2>/dev/null; then
    echo "  ✓  report-renderer.js syntax valid"
else
    echo "  ✗  report-renderer.js syntax check FAILED"
    RC=1
fi

# --- 3. Node.js native test suite -------------------------------------------
# 12 tests covering renderer, schema, sample data, template tokens, zip integrity.
if node --test report-kit/report-kit.test.mjs 2>/dev/null | grep -qE "^(ok|pass)\s+(12|all)" || \
   node --test report-kit/report-kit.test.mjs 2>&1 | tail -5 | grep -q "# fail 0"; then
    echo "  ✓  report-kit test suite passes"
else
    echo "  ✗  report-kit test suite has failures"
    RC=1
fi

# --- 4. Zip archive integrity (unzip -t) ------------------------------------
if unzip -t report-kit/report-kit.zip >/dev/null 2>&1; then
    echo "  ✓  report-kit.zip integrity OK (unzip -t)"
else
    echo "  ✗  report-kit.zip is corrupt or missing"
    RC=1
fi

# --- 5. SHA-256 match (disk vs git HEAD) ------------------------------------
# The on-disk bytes must match what is committed — catches stale local edits.
DISK_HASH=$(shasum -a 256 report-kit/report-kit.zip | awk '{print $1}')
HEAD_HASH=$(git show HEAD:report-kit/report-kit.zip 2>/dev/null | shasum -a 256 | awk '{print $1}')

if [ -n "$DISK_HASH" ] && [ "$DISK_HASH" = "$HEAD_HASH" ]; then
    echo "  ✓  report-kit.zip SHA-256 matches git HEAD ($DISK_HASH)"
else
    echo "  ✗  report-kit.zip SHA-256 mismatch (disk=$DISK_HASH git=$HEAD_HASH)"
    RC=1
fi

# --- 6. End-to-end render smoke (sample data) --------------------------------
# Quick smoke: render the sample data and verify basic HTML structure.
RENDER_OUTPUT=$(node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL('./report-kit/report-renderer.js'));
const data = JSON.parse(readFileSync('./report-kit/sample-data-devin-deepwiki.json', 'utf8'));
const html = mod.renderReport(data);
const ok = html.startsWith('<!DOCTYPE html>') && html.includes('</html>');
process.stdout.write(ok ? html.length.toString() : 'FAIL');
" 2>/dev/null || echo "FAIL")

if [ "$RENDER_OUTPUT" != "FAIL" ] && [ "$RENDER_OUTPUT" -gt 5000 ] 2>/dev/null; then
    echo "  ✓  End-to-end render from sample data OK (${RENDER_OUTPUT} chars)"
else
    echo "  ✗  End-to-end render FAILED or too short"
    RC=1
fi

# --- Summary ----------------------------------------------------------------
if [ "$RC" -eq 0 ]; then
    echo "  ─────────────────────────────────────────"
    echo "  VERIFICATION BATTERY: ALL CHECKS PASSED"
else
    echo "  ─────────────────────────────────────────"
    echo "  VERIFICATION BATTERY: FAILURES DETECTED (see above)"
fi

VERIFY_RC=$RC
return "${VERIFY_RC:-0}" 2>/dev/null || exit "$VERIFY_RC"
