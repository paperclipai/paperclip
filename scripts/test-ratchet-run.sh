#!/usr/bin/env bash
# Full-workspace test run + ratchet check, out of band from the deploy.
#
# The full suite is dominated by slow remote/sandbox tests, so it cannot run
# inline on a promote. This script runs it, checks the result against
# test-baseline.json, and writes a verdict receipt that the promote pipeline's
# `test_ratchet` gate consumes (and rejects when stale).
#
# Intended to run on a schedule (launchd) and on demand.
set -uo pipefail

ROOT="${PAPERCLIP_SOURCE_ROOT:-$HOME/paperclip}"
STATE_DIR="${PAPERCLIP_PINNED_DEPLOY_STATE_DIR:-$HOME/.paperclip/deploy}"
RECEIPT="${PAPERCLIP_TEST_RATCHET_RECEIPT:-$STATE_DIR/test-ratchet-verdict.json}"
RESULTS="${PAPERCLIP_TEST_RATCHET_RESULTS:-$STATE_DIR/test-ratchet-results.json}"
BASELINE="${PAPERCLIP_TEST_RATCHET_BASELINE:-$ROOT/test-baseline.json}"

mkdir -p "$STATE_DIR"
cd "$ROOT" || { echo "test-ratchet-run: cannot cd $ROOT" >&2; exit 1; }

started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
sha="$(git rev-parse HEAD 2>/dev/null || echo unknown)"

# The vitest exit code is NOT the verdict — a red suite that is fully baselined
# is a pass for our purposes. The ratchet check decides.
npx vitest run --reporter=json --outputFile="$RESULTS" >/dev/null 2>&1
check_out="$(node "$ROOT/scripts/test-ratchet.mjs" check --results "$RESULTS" --baseline "$BASELINE" 2>&1)"
check_rc=$?
finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "$check_out"

status=pass
[ "$check_rc" -eq 0 ] || status=fail

node - "$RECEIPT" "$status" "$sha" "$started" "$finished" "$RESULTS" "$BASELINE" <<'NODE'
const fs = require("node:fs");
const [receipt, status, sha, startedAt, finishedAt, results, baseline] = process.argv.slice(2);
let regressions = null, failing = null, baselineSize = null;
try {
  const r = JSON.parse(fs.readFileSync(results, "utf8"));
  failing = (r.testResults || []).reduce((n, s) => {
    const a = s.assertionResults || [];
    if (a.length === 0 && s.status === "failed") return n + 1;
    return n + a.filter((x) => x.status === "failed").length;
  }, 0);
} catch {}
try { baselineSize = (JSON.parse(fs.readFileSync(baseline, "utf8")).known || []).length; } catch {}
if (failing != null && baselineSize != null) regressions = Math.max(0, failing - baselineSize);
fs.writeFileSync(receipt, JSON.stringify({
  schemaVersion: 1, status, sha, startedAt, finishedAt, failing, baselineSize, regressions,
}, null, 2) + "\n");
NODE

echo "test-ratchet-run: $status (sha $sha) — receipt $RECEIPT"
[ "$status" = "pass" ] || exit 1
