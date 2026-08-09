#!/usr/bin/env bash
# Fail-closed pinned deploy-worktree promotion (TSMC-19813 / plan TSMC-19809).
#
# Contract (TSKB0268 / TSKB0362):
#   - All mandatory gates must pass before the deploy pointer can move.
#   - A failed gate MUST NOT change the live deploy pointer.
#   - This script never installs/reloads launchd, never claims :3100, and never
#     mutates the live database unless an explicit dangerous flag is set (still
#     refused for DB name paperclip on migrate).
#
# Default command is dry-run friendly. Live pointer flip requires BOTH:
#   --allow-live-pointer AND PAPERCLIP_PINNED_DEPLOY_ALLOW_LIVE=1
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SOURCE_ROOT="${PAPERCLIP_SOURCE_ROOT:-$HOME/paperclip}"
DEPLOY_ROOT="${PAPERCLIP_DEPLOY_ROOT:-$HOME/paperclip-deploy}"
CANDIDATE_ROOT="${PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT:-$HOME/paperclip-deploy.candidate}"
STATE_DIR="${PAPERCLIP_PINNED_DEPLOY_STATE_DIR:-$HOME/.paperclip/deploy}"
RECEIPT_DIR="${PAPERCLIP_PINNED_DEPLOY_RECEIPT_DIR:-$STATE_DIR/receipts}"
CURRENT_RECEIPT="${PAPERCLIP_DEPLOY_RECEIPT:-$STATE_DIR/current-receipt.json}"
APPROVED_BRANCH="${PAPERCLIP_PINNED_DEPLOY_APPROVED_BRANCH:-live}"

# Heavy gates (typecheck / dev-watch-gate) can be stubbed in unit tests only.
SKIP_HEAVY="${PAPERCLIP_PINNED_DEPLOY_SKIP_HEAVY:-0}"

log() { echo "[pinned-deploy-promote $(date '+%Y-%m-%dT%H:%M:%S%z')] $*" >&2; }
fail() { log "FAIL: $*"; exit 1; }

mkdir -p "$RECEIPT_DIR" "$STATE_DIR"

usage() {
  cat <<'USAGE' >&2
Usage: pinned-deploy-promote.sh <command> [args]

Commands:
  prepare-candidate <sha>   Detached worktree at CANDIDATE_ROOT for committed SHA
                            (also provisions deps + .paperclip/.env — TSMC-20021)
  run-gates                 Run all mandatory gates; update working receipt
  promote-pointer           Atomically stage candidate -> DEPLOY_ROOT if gates green
                            (requires --allow-live-pointer and ALLOW_LIVE=1;
                            re-asserts .paperclip/.env on the staged tree)
  promote-and-restart       promote-pointer then kickstart deploy LaunchAgent
                            with a zero-loss live-run handoff (same dual allow
                            flags; sanctioned single door)
  rollback-drill            Non-production pointer swap drill under STATE_DIR/drill
  lint-plists               Render+plutil templates via pinned-deploy-verify.sh
  uq-fixture                Disposable unique-index duplicate reject smoke
  full-dry-run <sha>        prepare + gates + uq + lint; NEVER moves live pointer
  show-receipt [path]       Print receipt JSON

Env:
  PAPERCLIP_SOURCE_ROOT PAPERCLIP_DEPLOY_ROOT PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT
  PAPERCLIP_PINNED_DEPLOY_STATE_DIR PAPERCLIP_PINNED_DEPLOY_RECEIPT_DIR
  PAPERCLIP_PINNED_DEPLOY_ALLOW_LIVE=1   # required with --allow-live-pointer
  PAPERCLIP_PINNED_DEPLOY_SKIP_HEAVY=1   # tests only
  PAPERCLIP_PINNED_DEPLOY_LAUNCHD_LABEL  # default ie.thinkstack.paperclip-deploy
  PAPERCLIP_PINNED_DEPLOY_API_URL        # default http://127.0.0.1:3100
  PAPERCLIP_PINNED_DEPLOY_RESTART_TIMEOUT_SECONDS # default 150
USAGE
}

working_receipt_path() {
  echo "$RECEIPT_DIR/working-receipt.json"
}

init_receipt() {
  local sha="$1"
  local actor rollback subject ts
  actor="${PAPERCLIP_PINNED_DEPLOY_ACTOR:-${USER:-unknown}}"
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  rollback=""
  if [ -d "$DEPLOY_ROOT/.git" ] || [ -f "$DEPLOY_ROOT/.git" ]; then
    rollback="$(git -C "$DEPLOY_ROOT" rev-parse HEAD 2>/dev/null || true)"
  fi
  if [ -z "$rollback" ] && [ -f "$CURRENT_RECEIPT" ]; then
    rollback="$(node -e 'const j=require("fs").readFileSync(process.argv[1],"utf8");const o=JSON.parse(j);process.stdout.write(o.candidateSha||o.deploySha||"")' "$CURRENT_RECEIPT" 2>/dev/null || true)"
  fi
  subject="$(git -C "$SOURCE_ROOT" log -1 --pretty=%s "$sha" 2>/dev/null || echo "")"
  cat >"$(working_receipt_path)" <<JSON
{
  "schemaVersion": 1,
  "issue": "TSMC-19813",
  "candidateSha": "$sha",
  "commitSubject": $(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$subject"),
  "actor": "$actor",
  "timestamp": "$ts",
  "rollbackSha": "$rollback",
  "sourceRoot": "$SOURCE_ROOT",
  "candidateRoot": "$CANDIDATE_ROOT",
  "deployRoot": "$DEPLOY_ROOT",
  "approvedBranch": "$APPROVED_BRANCH",
  "gates": {},
  "failedGateCount": 0,
  "mandatoryGates": [
    "committed_sha",
    "worktree_env",
    "candidate_deps",
    "plist_lint",
    "uq_fixture",
    "source_gate",
    "server_typecheck"
  ],
  "deployPointerMutated": false,
  "liveCutover": false
}
JSON
  log "initialized working receipt for $sha at $(working_receipt_path)"
}

# Linked git worktrees refuse to boot without .paperclip/.env
# (bootstrapDevRunnerWorktreeEnv). Production deploy uses an intentionally
# empty defaults file — presence is the contract, not secret values (TSMC-20021).
ensure_worktree_env() {
  local root="$1"
  [ -n "$root" ] || fail "ensure_worktree_env requires root"
  [ -d "$root" ] || fail "ensure_worktree_env: root missing: $root"
  mkdir -p "$root/.paperclip"
  local envf="$root/.paperclip/.env"
  if [ -f "$envf" ]; then
    log "worktree env already present: $envf"
    return 0
  fi
  cat >"$envf" <<'EOF'
# Pinned deploy worktree env (auto-provisioned by pinned-deploy-promote / TSMC-20021).
# Intentionally empty: defaults reproduce main-tree behaviour; this IS the production server.
EOF
  log "wrote worktree env $envf"
}

# Fresh worktrees have no node_modules; gates need esbuild + built workspace pkgs.
provision_candidate_deps() {
  local root="$1"
  [ -d "$root" ] || fail "provision_candidate_deps: root missing: $root"

  ensure_worktree_env "$root"
  if [ ! -f "$root/.paperclip/.env" ]; then
    receipt_set_gate "worktree_env" "fail" "missing .paperclip/.env after ensure"
    fail "worktree_env gate failed"
  fi
  receipt_set_gate "worktree_env" "pass" ".paperclip/.env present"

  if [ "$SKIP_HEAVY" = "1" ]; then
    receipt_set_gate "candidate_deps" "pass" "skipped heavy (test mode)"
    return 0
  fi

  log "pnpm install --prefer-offline in $root"
  if ! (cd "$root" && pnpm install --prefer-offline); then
    receipt_set_gate "candidate_deps" "fail" "pnpm install failed"
    fail "candidate_deps install failed"
  fi

  log "build @paperclipai/shared + @paperclipai/plugin-sdk in $root"
  if ! (cd "$root" && pnpm --filter @paperclipai/shared build && pnpm --filter @paperclipai/plugin-sdk build); then
    receipt_set_gate "candidate_deps" "fail" "shared/plugin-sdk build failed"
    fail "candidate_deps build failed"
  fi
  receipt_set_gate "candidate_deps" "pass" "install + shared/plugin-sdk build ok"
}

receipt_set_gate() {
  local name="$1" status="$2" detail="${3:-}"
  local path
  path="$(working_receipt_path)"
  [ -f "$path" ] || fail "no working receipt; run prepare-candidate first"
  # stdin scripts: argv[1+] are the explicit args (no synthetic script path).
node - "$path" "$name" "$status" "$detail" <<'NODE'
const fs = require("fs");
const [path, name, status, detail] = process.argv.slice(2);
const r = JSON.parse(fs.readFileSync(path, "utf8"));
r.gates = r.gates || {};
r.gates[name] = {
  status,
  detail: detail || "",
  at: new Date().toISOString(),
};
const mandatory = new Set(r.mandatoryGates || []);
let failed = 0;
for (const [k, g] of Object.entries(r.gates)) {
  if (mandatory.has(k) && g.status !== "pass") failed += 1;
}
// Also count mandatory missing later in assert
r.failedGateCount = failed;
fs.writeFileSync(path, JSON.stringify(r, null, 2) + "\n");
NODE
}

assert_gates_green() {
  local path="${1:-$(working_receipt_path)}"
  node - "$path" <<'NODE'
const fs = require("fs");
const path = process.argv[2];
const r = JSON.parse(fs.readFileSync(path, "utf8"));
const mandatory = r.mandatoryGates || [];
const missing = [];
const failed = [];
for (const g of mandatory) {
  const gate = (r.gates || {})[g];
  if (!gate) missing.push(g);
  else if (gate.status !== "pass") failed.push(g);
}
if (missing.length || failed.length) {
  console.error(JSON.stringify({ missing, failed, failedGateCount: r.failedGateCount }, null, 2));
  process.exit(1);
}
if ((r.failedGateCount || 0) !== 0) {
  console.error("failedGateCount nonzero", r.failedGateCount);
  process.exit(1);
}
process.exit(0);
NODE
}

finalize_receipt_copy() {
  local sha
  sha="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(r.candidateSha)' "$(working_receipt_path)")"
  local dest="$RECEIPT_DIR/receipt-${sha}-$(date +%Y%m%dT%H%M%SZ).json"
  cp "$(working_receipt_path)" "$dest"
  log "wrote durable receipt $dest"
  echo "$dest"
}

cmd_prepare_candidate() {
  local sha="${1:-}"
  [ -n "$sha" ] || fail "prepare-candidate requires <sha>"
  [ -d "$SOURCE_ROOT/.git" ] || [ -f "$SOURCE_ROOT/.git" ] || fail "SOURCE_ROOT is not a git checkout: $SOURCE_ROOT"

  # Resolve to full SHA; must be committed object.
  local full
  full="$(git -C "$SOURCE_ROOT" rev-parse --verify "${sha}^{commit}" 2>/dev/null)" \
    || fail "SHA not a committed object in $SOURCE_ROOT: $sha"

  # Reachable from approved branch tip (or is an ancestor of it).
  if ! git -C "$SOURCE_ROOT" merge-base --is-ancestor "$full" "refs/heads/$APPROVED_BRANCH" 2>/dev/null; then
    # Allow when approved branch name missing in test repos: check object exists only if SKIP
    if [ "$SKIP_HEAVY" = "1" ]; then
      log "SKIP_HEAVY: not enforcing ancestry on $APPROVED_BRANCH"
    else
      fail "SHA $full is not an ancestor of $APPROVED_BRANCH"
    fi
  fi

  # Dirty tree on source must not be promoted as if committed.
  if [ "$SKIP_HEAVY" != "1" ]; then
    if ! git -C "$SOURCE_ROOT" diff --quiet "$full" -- 2>/dev/null; then
      log "note: source working tree differs from candidate SHA (expected); promoting committed SHA only"
    fi
  fi

  init_receipt "$full"
  receipt_set_gate "committed_sha" "pass" "object $full"

  if [ -e "$CANDIDATE_ROOT" ]; then
    log "removing prior candidate root $CANDIDATE_ROOT"
    # Only remove if it looks like our worktree
    if git -C "$SOURCE_ROOT" worktree list --porcelain 2>/dev/null | grep -q "worktree $CANDIDATE_ROOT"; then
      git -C "$SOURCE_ROOT" worktree remove --force "$CANDIDATE_ROOT" 2>/dev/null \
        || rm -rf "$CANDIDATE_ROOT"
    else
      rm -rf "$CANDIDATE_ROOT"
    fi
  fi

  log "adding detached worktree $CANDIDATE_ROOT @ $full"
  git -C "$SOURCE_ROOT" worktree add --detach "$CANDIDATE_ROOT" "$full" \
    || fail "worktree add failed"

  local head
  head="$(git -C "$CANDIDATE_ROOT" rev-parse HEAD)"
  [ "$head" = "$full" ] || fail "candidate HEAD $head != $full"

  # TSMC-20021: bare worktree is not bootable/gateable until deps + .env exist.
  provision_candidate_deps "$CANDIDATE_ROOT"

  log "candidate ready HEAD=$head"
}

cmd_lint_plists() {
  if bash "$SCRIPT_DIR/pinned-deploy-verify.sh" lint; then
    receipt_set_gate "plist_lint" "pass" "plutil lint ok"
  else
    receipt_set_gate "plist_lint" "fail" "plutil lint failed"
    fail "plist_lint gate failed"
  fi
}

cmd_uq_fixture() {
  if bash "$SCRIPT_DIR/pinned-deploy-snapshot-smoke.sh" uq-fixture; then
    receipt_set_gate "uq_fixture" "pass" "duplicate rows rejected unique index"
  else
    receipt_set_gate "uq_fixture" "fail" "uq fixture did not reject"
    fail "uq_fixture gate failed"
  fi
}

cmd_source_gate() {
  if [ "$SKIP_HEAVY" = "1" ]; then
    receipt_set_gate "source_gate" "pass" "skipped heavy (test mode)"
    return 0
  fi
  local root="${PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT:-$CANDIDATE_ROOT}"
  [ -d "$root" ] || fail "candidate root missing for source_gate: $root"
  if (cd "$root" && node server/scripts/dev-watch-gate.mjs); then
    receipt_set_gate "source_gate" "pass" "dev-watch-gate.mjs ok"
  else
    receipt_set_gate "source_gate" "fail" "dev-watch-gate.mjs failed"
    fail "source_gate failed"
  fi
}

cmd_server_typecheck() {
  if [ "$SKIP_HEAVY" = "1" ]; then
    receipt_set_gate "server_typecheck" "pass" "skipped heavy (test mode)"
    return 0
  fi
  local root="${PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT:-$CANDIDATE_ROOT}"
  [ -d "$root" ] || fail "candidate root missing for typecheck: $root"
  if (cd "$root" && pnpm --filter @paperclipai/server typecheck); then
    receipt_set_gate "server_typecheck" "pass" "server typecheck ok"
  else
    receipt_set_gate "server_typecheck" "fail" "server typecheck failed"
    fail "server_typecheck failed"
  fi
}

cmd_run_gates() {
  [ -f "$(working_receipt_path)" ] || fail "no working receipt"
  # committed_sha should already be pass from prepare
  cmd_lint_plists
  cmd_uq_fixture
  cmd_source_gate
  cmd_server_typecheck
  if assert_gates_green "$(working_receipt_path)"; then
    log "all mandatory gates green"
    finalize_receipt_copy >/dev/null
  else
    receipt_set_gate "aggregate" "fail" "one or more mandatory gates red"
    fail "gates not green — deploy pointer will not be changed"
  fi
}

# Atomic pointer promotion: only after green gates + dual allow flags.
cmd_promote_pointer() {
  local allow_flag=0
  for arg in "$@"; do
    [ "$arg" = "--allow-live-pointer" ] && allow_flag=1
  done
  if [ "$allow_flag" != "1" ] || [ "${PAPERCLIP_PINNED_DEPLOY_ALLOW_LIVE:-0}" != "1" ]; then
    fail "promote-pointer refused: need --allow-live-pointer AND PAPERCLIP_PINNED_DEPLOY_ALLOW_LIVE=1 (no live cutover in default path)"
  fi
  [ -f "$(working_receipt_path)" ] || fail "no working receipt"
  if ! assert_gates_green "$(working_receipt_path)"; then
    fail "promote-pointer refuse: gates not green — pointer unchanged at $DEPLOY_ROOT"
  fi
  [ -d "$CANDIDATE_ROOT" ] || fail "candidate root missing: $CANDIDATE_ROOT"

  local staging parent
  parent="$(dirname "$DEPLOY_ROOT")"
  staging="$parent/.paperclip-deploy.staging-$$"
  local backup=""
  if [ -e "$DEPLOY_ROOT" ]; then
    backup="$parent/.paperclip-deploy.prev-$$"
  fi

  log "staging candidate -> $staging"
  rm -rf "$staging"
  # Prefer hardlink-friendly copy of worktree content without .git cross-links mess:
  # move worktree directory into place via rename of a sync'd tree.
  mkdir -p "$staging"
  # Use rsync if present else cp
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$CANDIDATE_ROOT"/ "$staging"/
  else
    cp -a "$CANDIDATE_ROOT"/. "$staging"/
  fi

  # Re-assert worktree env on the staged tree before pointer swap (TSMC-20021).
  # rsync should already carry it from candidate, but missing env crash-loops launchd.
  ensure_worktree_env "$staging"
  [ -f "$staging/.paperclip/.env" ] || fail "staging missing .paperclip/.env after ensure"

  if [ -n "$backup" ]; then
    log "moving existing deploy to $backup"
    mv "$DEPLOY_ROOT" "$backup"
  fi
  mv "$staging" "$DEPLOY_ROOT"

  # Final belt-and-braces on the live pointer path.
  ensure_worktree_env "$DEPLOY_ROOT"
  [ -f "$DEPLOY_ROOT/.paperclip/.env" ] || fail "DEPLOY_ROOT missing .paperclip/.env after promote"

  # Finalize transition metadata on the working receipt FIRST, then write the
  # durable immutable copy so the receipt that lands under receipts/ includes
  # deployPointerMutated / promotedAt / paths (TSMC-19814 finding 2).
  node - "$(working_receipt_path)" "$CURRENT_RECEIPT" <<'NODE'
const fs = require("fs");
const [working, current] = process.argv.slice(2);
const r = JSON.parse(fs.readFileSync(working, "utf8"));
r.deployPointerMutated = true;
r.liveCutover = true;
r.promotedAt = new Date().toISOString();
r.currentReceiptPath = current;
// durable path filled after finalize_receipt_copy
fs.writeFileSync(working, JSON.stringify(r, null, 2) + "\n");
NODE

  local durable
  durable="$(finalize_receipt_copy)"
  node - "$(working_receipt_path)" "$CURRENT_RECEIPT" "$durable" <<'NODE'
const fs = require("fs");
const [working, current, durable] = process.argv.slice(2);
const r = JSON.parse(fs.readFileSync(working, "utf8"));
r.durableReceiptPath = durable;
// Postcondition: transition metadata must be present before any durable copy is trusted.
if (r.deployPointerMutated !== true || !r.promotedAt) {
  console.error("receipt postcondition failed: missing transition metadata");
  process.exit(1);
}
const body = JSON.stringify(r, null, 2) + "\n";
fs.writeFileSync(working, body);
fs.writeFileSync(current, body);
// Rewrite the durable receipt so it matches the final postcondition (same content).
fs.writeFileSync(durable, body);
NODE
  log "PROMOTION COMPLETE deployRoot=$DEPLOY_ROOT receipt=$CURRENT_RECEIPT durable=$durable"
  log "NOTE: promote-pointer does not reload launchd; use promote-and-restart for the sanctioned single door"
}

# A hot restart marker is written only after the pointer is safely promoted and
# immediately before launchd receives its restart signal.  The old server then
# snapshots live children and the new process adopts them.  This is deliberately
# part of the single sanctioned deploy door: a raw kickstart previously stranded
# active runners during an otherwise healthy release.
live_api_base() {
  local raw="${PAPERCLIP_PINNED_DEPLOY_API_URL:-http://127.0.0.1:3100}"
  raw="${raw%/}"
  echo "${raw%/api}"
}

read_live_server_pid() {
  local api_base="$1"
  curl -fsS --max-time 5 "$api_base/api/health" \
    | node -e '
      let raw = "";
      process.stdin.on("data", (chunk) => { raw += chunk; });
      process.stdin.on("end", () => {
        try {
          const body = JSON.parse(raw);
          const pid = Number(body?.instance?.pid);
          if (!Number.isInteger(pid) || pid <= 0) process.exit(2);
          process.stdout.write(String(pid));
        } catch { process.exit(2); }
      });
    '
}

request_hot_restart_handoff() {
  local api_base="$1" old_pid="$2"
  [ -f "$SOURCE_ROOT/scripts/request-hot-restart.ts" ] \
    || fail "promote-and-restart: hot-restart request script missing from source tree"
  log "writing hot-restart handoff intent for live server pid $old_pid"
  (
    cd "$SOURCE_ROOT"
    PAPERCLIP_API_URL="$api_base" node --import tsx scripts/request-hot-restart.ts --server-pid "$old_pid"
  ) || fail "promote-and-restart: could not write hot-restart handoff intent"
}

record_hot_restart_report() {
  local report="$1" old_pid="$2"
  [ -f "$(working_receipt_path)" ] || fail "no working receipt while recording hot-restart report"
  node - "$(working_receipt_path)" "$report" "$old_pid" <<'NODE'
const fs = require("fs");
const [receiptPath, reportPath, expectedOldPid] = process.argv.slice(2);
const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
if (Number(report.previousServerPid) !== Number(expectedOldPid)) {
  throw new Error(`hot restart report targets ${report.previousServerPid}, expected ${expectedOldPid}`);
}
receipt.hotRestart = {
  reportPath,
  previousServerPid: report.previousServerPid,
  newServerPid: report.newServerPid,
  adoptedRunIds: Array.isArray(report.adoptedRunIds) ? report.adoptedRunIds : [],
  finalizedWhileDownRunIds: Array.isArray(report.finalizedWhileDownRunIds) ? report.finalizedWhileDownRunIds : [],
  lostRunIds: Array.isArray(report.lostRunIds) ? report.lostRunIds : [],
  completedAt: report.completedAt || null,
};
const body = JSON.stringify(receipt, null, 2) + "\n";
fs.writeFileSync(receiptPath, body);
// The pointer transition writes these receipts before the service restart.
// Bring every receipt copy forward so a later audit cannot mistake an
// unverified restart for an older promotion record.
for (const path of [receipt.currentReceiptPath, receipt.durableReceiptPath]) {
  if (typeof path === "string" && path.length > 0) fs.writeFileSync(path, body);
}
if (receipt.hotRestart.lostRunIds.length > 0) {
  console.error(JSON.stringify(receipt.hotRestart, null, 2));
  process.exit(3);
}
NODE
}

wait_for_hot_restart_report() {
  local api_base="$1" old_pid="$2"
  local instance_id="${PAPERCLIP_INSTANCE_ID:-default}"
  local paperclip_home="${PAPERCLIP_HOME:-$HOME/.paperclip}"
  local report="$paperclip_home/instances/$instance_id/hot-restart-report.json"
  local timeout="${PAPERCLIP_PINNED_DEPLOY_RESTART_TIMEOUT_SECONDS:-150}"
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    if [ -f "$report" ] && node - "$report" "$old_pid" <<'NODE'
const fs = require("fs");
const [path, oldPid] = process.argv.slice(2);
try {
  const report = JSON.parse(fs.readFileSync(path, "utf8"));
  const matchesOld = Number(report.previousServerPid) === Number(oldPid);
  const hasNew = Number.isInteger(Number(report.newServerPid)) && Number(report.newServerPid) > 0;
  process.exit(matchesOld && hasNew ? 0 : 1);
} catch { process.exit(1); }
NODE
    then
      record_hot_restart_report "$report" "$old_pid" \
        || fail "promote-and-restart: continuity failure recorded in $report"
      log "hot-restart continuity verified; report=$report"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  fail "promote-and-restart: no matching hot-restart report after ${timeout}s; deployment continuity is unverified"
}

# Single sanctioned door: pointer flip + zero-loss LaunchAgent handoff.
# Still requires dual allow flags; never touches source coexist agents.
cmd_promote_and_restart() {
  cmd_promote_pointer "$@"
  local api_base old_pid
  api_base="$(live_api_base)"
  old_pid="$(read_live_server_pid "$api_base")" \
    || fail "promote-and-restart: live health did not expose a valid server pid at $api_base"
  request_hot_restart_handoff "$api_base" "$old_pid"
  local label="${PAPERCLIP_PINNED_DEPLOY_LAUNCHD_LABEL:-ie.thinkstack.paperclip-deploy}"
  local uid domain target
  uid="$(id -u)"
  domain="gui/$uid"
  target="$domain/$label"
  if ! command -v launchctl >/dev/null 2>&1; then
    fail "promote-and-restart: launchctl not available"
  fi
  if launchctl print "$target" >/dev/null 2>&1; then
    log "kickstarting deploy LaunchAgent $target"
    launchctl kickstart -k "$target" \
      || fail "promote-and-restart: launchctl kickstart failed for $target"
    log "promote-and-restart: kickstart issued for $target"
    wait_for_hot_restart_report "$api_base" "$old_pid"
  else
    fail "promote-and-restart: LaunchAgent not loaded: $target (pointer already promoted; load plist then kickstart manually)"
  fi
}

# Non-production drill: operate only under STATE_DIR/drill
cmd_rollback_drill() {
  local drill_root="$STATE_DIR/drill"
  local fake_deploy="$drill_root/paperclip-deploy"
  local fake_candidate="$drill_root/paperclip-deploy.candidate"
  local fake_prev="$drill_root/paperclip-deploy.prev"
  mkdir -p "$drill_root"

  rm -rf "$fake_deploy" "$fake_candidate" "$fake_prev"
  mkdir -p "$fake_deploy" "$fake_candidate"
  echo "prev-sha-content" >"$fake_deploy/VERSION"
  echo "next-sha-content" >"$fake_candidate/VERSION"
  echo '{"candidateSha":"deadbeef","gates":{},"failedGateCount":0}' >"$drill_root/current-receipt.json"

  # Simulate failed gate must not swap
  local blocked="$drill_root/blocked-deploy"
  mkdir -p "$blocked"
  echo "untouched" >"$blocked/VERSION"
  mkdir -p "$drill_root/receipts"
  cat >"$drill_root/receipts/working-receipt.json" <<'JSON'
{
  "schemaVersion": 1,
  "candidateSha": "bad",
  "gates": {"committed_sha":{"status":"fail"}},
  "failedGateCount": 1,
  "mandatoryGates": ["committed_sha","worktree_env","candidate_deps","plist_lint","uq_fixture","source_gate","server_typecheck"],
  "deployPointerMutated": false
}
JSON
  # assert-green must reject red receipt
  if PAPERCLIP_PINNED_DEPLOY_RECEIPT_DIR="$drill_root/receipts" \
    PAPERCLIP_PINNED_DEPLOY_STATE_DIR="$drill_root" \
    bash "$SCRIPT_DIR/pinned-deploy-promote.sh" assert-green "$drill_root/receipts/working-receipt.json" 2>/dev/null; then
    fail "rollback-drill: assert-green accepted red receipt"
  fi
  # promote-pointer must refuse and leave marker
  if PAPERCLIP_DEPLOY_ROOT="$blocked" \
    PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT="$fake_candidate" \
    PAPERCLIP_PINNED_DEPLOY_RECEIPT_DIR="$drill_root/receipts" \
    PAPERCLIP_PINNED_DEPLOY_STATE_DIR="$drill_root" \
    PAPERCLIP_PINNED_DEPLOY_ALLOW_LIVE=1 \
    bash "$SCRIPT_DIR/pinned-deploy-promote.sh" promote-pointer --allow-live-pointer 2>/dev/null; then
    fail "rollback-drill: promote-pointer accepted red receipt"
  fi
  grep -q untouched "$blocked/VERSION" || fail "rollback-drill: blocked deploy marker was mutated"

  # Successful drill promote + rollback
  mv "$fake_deploy" "$fake_prev"
  mv "$fake_candidate" "$fake_deploy"
  grep -q next-sha-content "$fake_deploy/VERSION" || fail "drill promote failed"
  # rollback
  mv "$fake_deploy" "$fake_candidate"
  mv "$fake_prev" "$fake_deploy"
  grep -q prev-sha-content "$fake_deploy/VERSION" || fail "drill rollback failed"

  cat >"$drill_root/rollback-drill-receipt.json" <<JSON
{
  "gate": "rollback_drill",
  "status": "pass",
  "at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "note": "non-production pointer swap under $drill_root only; no launchd, no :3100, no live DB"
}
JSON
  log "PASS rollback-drill under $drill_root"
}

cmd_full_dry_run() {
  local sha="${1:-}"
  [ -n "$sha" ] || fail "full-dry-run requires <sha>"
  cmd_prepare_candidate "$sha"
  cmd_run_gates
  log "full-dry-run complete — live pointer NOT mutated (deployPointerMutated remains false unless promote-pointer)"
  node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(r.deployPointerMutated) process.exit(1); console.log(JSON.stringify({candidateSha:r.candidateSha,failedGateCount:r.failedGateCount,gates:Object.fromEntries(Object.entries(r.gates).map(([k,v])=>[k,v.status]))},null,2))' "$(working_receipt_path)"
}

# Allow tests to mark a gate failed without running it.
cmd_mark_gate() {
  local name="${1:-}" status="${2:-}"
  [ -n "$name" ] && [ -n "$status" ] || fail "mark-gate <name> <pass|fail>"
  receipt_set_gate "$name" "$status" "manual mark"
}

main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    prepare-candidate) cmd_prepare_candidate "$@" ;;
    run-gates) cmd_run_gates "$@" ;;
    promote-pointer) cmd_promote_pointer "$@" ;;
    promote-and-restart) cmd_promote_and_restart "$@" ;;
    rollback-drill) cmd_rollback_drill "$@" ;;
    lint-plists) 
      if [ -f "$(working_receipt_path)" ]; then cmd_lint_plists; else bash "$SCRIPT_DIR/pinned-deploy-verify.sh" lint; fi
      ;;
    uq-fixture)
      if [ -f "$(working_receipt_path)" ]; then cmd_uq_fixture; else bash "$SCRIPT_DIR/pinned-deploy-snapshot-smoke.sh" uq-fixture; fi
      ;;
    full-dry-run) cmd_full_dry_run "$@" ;;
    show-receipt)
      local p="${1:-$(working_receipt_path)}"
      cat "$p"
      ;;
    mark-gate) cmd_mark_gate "$@" ;;
    assert-green)
      assert_gates_green "${1:-$(working_receipt_path)}"
      ;;
    -h|--help|help|"") usage; [ -n "$cmd" ] || exit 2 ;;
    *) usage; fail "unknown command: $cmd" ;;
  esac
}

main "$@"
