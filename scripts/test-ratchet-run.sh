#!/usr/bin/env bash
# Full-workspace test run + ratchet check, out of band from the deploy.
#
# ⛔ SAFETY FIRST — read before changing any of this.
# On 2026-08-23 an unbounded `npx vitest run` over the whole workspace on the
# serving Mac drove load average to 209, stretched live /api/health from 0.18s
# to 4.2s, and aborted an in-flight promote (its pre-flight probe is curl -m 5).
# The Studio serves the fleet continuously; there is no quiet hour. So this
# script NEVER runs the workspace in one unbounded pass. It:
#   * refuses to start while a deployment lease is held,
#   * refuses to start when the box is already loaded,
#   * runs one PACKAGE AT A TIME, niced, with bounded workers,
#   * re-checks load between shards and backs off,
#   * merges the per-shard results into a single ratchet verdict.
#
# A loaded run also LIES: heartbeat-process-recovery reported 29 failures under
# saturation and 4 when run alone. Never seed a baseline from a loaded run.
set -uo pipefail

ROOT="${PAPERCLIP_SOURCE_ROOT:-$HOME/paperclip}"
STATE_DIR="${PAPERCLIP_PINNED_DEPLOY_STATE_DIR:-$HOME/.paperclip/deploy}"
RECEIPT="${PAPERCLIP_TEST_RATCHET_RECEIPT:-$STATE_DIR/test-ratchet-verdict.json}"
SHARD_DIR="${PAPERCLIP_TEST_RATCHET_SHARD_DIR:-$STATE_DIR/test-ratchet-shards}"
BASELINE="${PAPERCLIP_TEST_RATCHET_BASELINE:-$ROOT/test-baseline.json}"
LEASE_DIR="${PAPERCLIP_PINNED_DEPLOY_LEASE_DIR:-$STATE_DIR/deployment-lease}"
MAX_WORKERS="${PAPERCLIP_TEST_RATCHET_MAX_WORKERS:-2}"
# Refuse above this 1-minute load average.
#
# Measured on the Studio 2026-08-23: 10 CPUs, 1m load swinging 36-61 minute to
# minute with the fleet running. This box is NEVER quiet, so this is
# deliberately not a "wait for an idle machine" check — that would block
# forever, or burn the whole wait budget and abort. It is a "do not pile onto an
# existing storm" check: normal operation and its spikes pass, while the
# self-inflicted saturation that broke a deploy that day (209) does not.
# Two niced workers on top of steady state is a rounding error; two workers on
# top of a storm is an outage.
MAX_LOAD="${PAPERCLIP_TEST_RATCHET_MAX_LOAD:-80}"
COOLDOWN_SEC="${PAPERCLIP_TEST_RATCHET_COOLDOWN_SEC:-20}"
# Live-health watchdog. Load is a proxy; what actually matters is whether the
# control plane still answers. On 2026-08-23 an unbounded run stretched
# /api/health from 0.18s to 4.2s and aborted an in-flight promote (its
# pre-flight probe is curl -m 5). A shard can run for many minutes, so checking
# load only BETWEEN shards is not enough — this polls during them and kills the
# shard the moment the server starts suffering.
HEALTH_URL="${PAPERCLIP_TEST_RATCHET_HEALTH_URL:-http://127.0.0.1:3100/api/health}"
HEALTH_MAX_SEC="${PAPERCLIP_TEST_RATCHET_HEALTH_MAX_SEC:-2}"
HEALTH_POLL_SEC="${PAPERCLIP_TEST_RATCHET_HEALTH_POLL_SEC:-10}"
HEALTH_STRIKES="${PAPERCLIP_TEST_RATCHET_HEALTH_STRIKES:-3}"

# One probe: prints "ok" only when the control plane answers 200 fast enough.
health_ok() {
  local out code secs
  out="$(curl -s -m 8 -o /dev/null -w '%{http_code} %{time_total}' "$HEALTH_URL" 2>/dev/null)" || return 1
  code="${out%% *}"; secs="${out##* }"
  [ "$code" = "200" ] || return 1
  awk -v a="$secs" -v b="$HEALTH_MAX_SEC" 'BEGIN{exit !(a<=b)}'
}

# Watchdog: polls health while $1 (a shard pid) runs; kills it after
# HEALTH_STRIKES consecutive bad probes. Strikes reset on recovery so a single
# slow sample never aborts a run.
watch_health() {
  local target_pid="$1" strikes=0
  while kill -0 "$target_pid" 2>/dev/null; do
    if health_ok; then
      strikes=0
    else
      strikes=$((strikes + 1))
      log "health probe failed (${strikes}/${HEALTH_STRIKES})"
      if [ "$strikes" -ge "$HEALTH_STRIKES" ]; then
        log "ABORTING SHARD: control plane unhealthy ${strikes} consecutive probes — the fleet comes first"
        kill -TERM "$target_pid" 2>/dev/null
        sleep 5
        kill -KILL "$target_pid" 2>/dev/null
        return 1
      fi
    fi
    sleep "$HEALTH_POLL_SEC"
  done
  return 0
}

log() { echo "[test-ratchet-run $(date '+%H:%M:%S')] $*" >&2; }

load_1m() { uptime | sed -E 's/.*load averages?: *([0-9.]+).*/\1/'; }

wait_for_quiet() {
  local waited=0 limit="${1:-600}"
  while :; do
    local l; l="$(load_1m)"
    if [ "$(printf '%.0f' "$l")" -le "$MAX_LOAD" ]; then return 0; fi
    if [ "$waited" -ge "$limit" ]; then
      log "load $l still above $MAX_LOAD after ${limit}s — the box is in a storm, not merely busy"
      return 1
    fi
    log "load $l above $MAX_LOAD — waiting ${COOLDOWN_SEC}s"
    sleep "$COOLDOWN_SEC"; waited=$((waited + COOLDOWN_SEC))
  done
}

# A deploy in flight owns the box. Never compete with it.
if [ -e "$LEASE_DIR/owner.json" ]; then
  log "REFUSING: a deployment lease is held ($LEASE_DIR). Try again after the deploy."
  exit 3
fi

# Health gates FIRST: it is a cheap, decisive probe, and an unhealthy control
# plane should be refused immediately rather than after a ten-minute load wait.
# Never start against an already-suffering server — that is exactly the state
# where adding test load does real damage.
if ! health_ok; then
  log "REFUSING: control plane at $HEALTH_URL is not answering 200 within ${HEALTH_MAX_SEC}s."
  exit 3
fi

if ! wait_for_quiet 600; then
  log "REFUSING: machine too busy to measure honestly (a loaded run inflates failures)."
  exit 3
fi


cd "$ROOT" || { log "cannot cd $ROOT"; exit 1; }
mkdir -p "$SHARD_DIR"; rm -f "$SHARD_DIR"/*.json 2>/dev/null

started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
sha="$(git rev-parse HEAD 2>/dev/null || echo unknown)"

# One shard per workspace package that actually has tests.
# NOTE: macOS ships bash 3.2 — no `mapfile`, no `globstar`. Using either makes
# the shard list silently EMPTY, and the run then measures nothing while
# reporting success, which is far worse than not running at all. Keep this
# loop bash-3.2 clean, and assert non-empty before doing any work.
SHARD_LIST="$(
  { ls -d packages/*/ packages/adapters/*/ 2>/dev/null; echo server/; echo cli/; echo ui/; } \
  | sed 's:/$::' | sort -u
)"
[ -n "$SHARD_LIST" ] || { log "REFUSING: shard discovery produced nothing"; exit 1; }

results_args=""
shard_count=0
ABORTED_BY_WATCHDOG=0
while IFS= read -r pkg; do
  [ -n "$pkg" ] || continue
  [ -d "$ROOT/$pkg" ] || continue
  # bash 3.2: no globstar, so use find rather than compgen -G '**'
  if [ -z "$(find "$ROOT/$pkg/src" -name '*.test.ts' -print -quit 2>/dev/null)" ]; then
    continue
  fi
  out="$SHARD_DIR/$(echo "$pkg" | tr '/' '_').json"
  wait_for_quiet 600 || { log "aborting remaining shards: box stayed busy"; break; }
  log "shard: $pkg"
  ( cd "$ROOT/$pkg" && nice -n 19 npx vitest run \
      --reporter=json --outputFile="$out" --maxWorkers="$MAX_WORKERS" >/dev/null 2>&1 ) &
  shard_pid=$!
  if ! watch_health "$shard_pid"; then
    log "shard $pkg aborted by the health watchdog; stopping the whole run"
    rm -f "$out"
    ABORTED_BY_WATCHDOG=1
    break
  fi
  wait "$shard_pid" 2>/dev/null
  if [ -f "$out" ]; then
    results_args="$results_args --results $out"
    shard_count=$((shard_count + 1))
  else
    log "shard produced no results: $pkg"
  fi
done <<EOF
$SHARD_LIST
EOF

if [ "$ABORTED_BY_WATCHDOG" = "1" ]; then
  log "REFUSING to publish a verdict: the run was aborted to protect the control plane."
  log "A partial run is not a measurement — no receipt written, baseline untouched."
  exit 3
fi

if [ "$shard_count" -eq 0 ]; then
  log "no shard results produced"; exit 1
fi
log "merged $shard_count shard result files"

# shellcheck disable=SC2086 -- results_args is a deliberately word-split flag list
check_out="$(node "$ROOT/scripts/test-ratchet.mjs" check $results_args --baseline "$BASELINE" 2>&1)"
check_rc=$?
finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "$check_out"

status=pass; [ "$check_rc" -eq 0 ] || status=fail

node - "$RECEIPT" "$status" "$sha" "$started" "$finished" "$BASELINE" "$SHARD_DIR" <<'NODE'
const fs = require("node:fs"), path = require("node:path");
const [receipt, status, sha, startedAt, finishedAt, baseline, shardDir] = process.argv.slice(2);
let failing = 0, baselineSize = null, shards = 0;
for (const f of fs.readdirSync(shardDir).filter((n) => n.endsWith(".json"))) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(shardDir, f), "utf8"));
    shards += 1;
    failing += (r.testResults || []).reduce((n, s) => {
      const a = s.assertionResults || [];
      if (a.length === 0 && s.status === "failed") return n + 1;
      return n + a.filter((x) => x.status === "failed").length;
    }, 0);
  } catch {}
}
try { baselineSize = (JSON.parse(fs.readFileSync(baseline, "utf8")).known || []).length; } catch {}
fs.writeFileSync(receipt, JSON.stringify({
  schemaVersion: 1, status, sha, startedAt, finishedAt, shards, failing, baselineSize,
  regressions: baselineSize == null ? null : Math.max(0, failing - baselineSize),
}, null, 2) + "\n");
NODE

log "$status (sha $sha) — receipt $RECEIPT"
[ "$status" = "pass" ] || exit 1
