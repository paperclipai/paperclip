#!/usr/bin/env bash
# End-to-end proof that `paperclipai update` works ACROSS VERSIONS, including
# database migrations, against a real managed install with a live service.
#
# Journey (real GitHub, real embedded Postgres, real systemd/launchd service):
#   install --ref BASE (payload with N migrations) -> onboard + service active
#   -> point the tracked ref at NEXT (payload with N+1 migrations; NEXT adds a
#      probe migration creating table `e2e_update_probe`)
#   -> update --check (exit 10) -> update --yes
#   -> assert: pre-update DB backup written, payload flipped, service healthy,
#      probe migration applied to the real database (visible in a pg dump),
#      the database cluster was reused (no re-initialization)
#   -> update --rollback -> old payload must still boot against the migrated DB
#
# The tracked-ref edit in install.json simulates the real user state "installed
# from this ref a while ago, the ref has since gained migrations" without having
# to mutate refs on GitHub while the test runs.
#
# Env knobs:
#   E2E_REPO                  GitHub repo (default: paperclipai/paperclip)
#   E2E_UPDATE_BASE_REF       ref to install first (required; e.g. test/e2e-update-base)
#   E2E_UPDATE_NEXT_REF       ref to update to (required; BASE + one probe migration)
#   E2E_BOOTSTRAP_CLI         path to an already-built bootstrap CLI entry point
#                             (dist/index.js); when unset, builds one from BASE
#   E2E_SERVICE_TIMEOUT_SECS  service active/health wait (default 300)
set -uo pipefail

E2E_REPO="${E2E_REPO:-paperclipai/paperclip}"
BASE_REF="${E2E_UPDATE_BASE_REF:?E2E_UPDATE_BASE_REF is required}"
NEXT_REF="${E2E_UPDATE_NEXT_REF:?E2E_UPDATE_NEXT_REF is required}"
E2E_SERVICE_TIMEOUT_SECS="${E2E_SERVICE_TIMEOUT_SECS:-300}"

# Clean environment, then isolate ALL Paperclip state (managed store, config,
# embedded Postgres, backups) under a dedicated home for this test.
for var in $(env | grep -o '^PAPERCLIP_[A-Z_]*' || true); do unset "$var"; done
unset NODE_ENV npm_config_prefix 2>/dev/null || true
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export CI="${CI:-1}"
export PAPERCLIP_HOME="$HOME/.paperclip-e2e-update"

SHIM="$HOME/.local/bin/paperclipai"
STORE="$PAPERCLIP_HOME/cli"
BACKUP_DIR="$PAPERCLIP_HOME/instances/default/data/backups"
RESULTS=()
FAILED=0

note()  { printf '\n\033[1;34m== %s ==\033[0m\n' "$*"; }
pass()  { RESULTS+=("PASS  $1"); printf '\033[1;32mPASS\033[0m %s\n' "$1"; }
fail_() { RESULTS+=("FAIL  $1"); printf '\033[1;31mFAIL\033[0m %s\n' "$1"; FAILED=1; }

shim() { "$SHIM" "$@"; }
current_target() { readlink "$STORE/current" 2>/dev/null || echo "<missing>"; }
backup_count() { ls "$BACKUP_DIR" 2>/dev/null | grep -c -E '\.sql(\.gz)?$'; }
newest_backup() { ls -t "$BACKUP_DIR"/*.sql* 2>/dev/null | head -1; }
dump_text() { case "$1" in *.gz) gunzip -c "$1" ;; *) cat "$1" ;; esac; }
first_run_count() { shim service logs -n 2000 2>/dev/null | grep -c "first-run embedded PostgreSQL" || true; }

wait_active() {
  local deadline=$(( $(date +%s) + E2E_SERVICE_TIMEOUT_SECS )) status_json=""
  while [ "$(date +%s)" -lt "$deadline" ]; do
    status_json="$(shim service status --json 2>/dev/null || true)"
    if echo "$status_json" | grep -q '"active"[[:space:]]*:[[:space:]]*true'; then return 0; fi
    sleep 5
  done
  echo "last status: ${status_json:-<none>}"
  shim service logs -n 80 || true
  return 1
}

cleanup() {
  shim service stop >/dev/null 2>&1 || true
  shim service uninstall >/dev/null 2>&1 || true
  shim uninstall >/dev/null 2>&1 || true
}
trap cleanup EXIT

note "0. Preflight"
uname -a
node --version && npm --version
command -v corepack >/dev/null || npm install -g corepack
[ -e "$SHIM" ] && { echo "shim already exists at $SHIM — refusing to run"; exit 2; }
[ -d "$PAPERCLIP_HOME" ] && { echo "$PAPERCLIP_HOME already exists — refusing to run"; exit 2; }
if [ "$(uname -s)" = "Linux" ] && [ ! -S "/run/user/$(id -u)/bus" ]; then
  echo "no systemd user bus at /run/user/$(id -u)/bus — this test needs a real service"; exit 2
fi
echo "repo=$E2E_REPO base=$BASE_REF next=$NEXT_REF paperclip_home=$PAPERCLIP_HOME"

if [ -n "${E2E_BOOTSTRAP_CLI:-}" ] && [ -f "$E2E_BOOTSTRAP_CLI" ]; then
  BOOTSTRAP_CLI="$E2E_BOOTSTRAP_CLI"
  note "1. Bootstrap CLI reused: $BOOTSTRAP_CLI"
else
  note "1. Bootstrap: build the CLI from the GitHub tarball of $BASE_REF"
  BOOT="$HOME/e2e-upd-bootstrap"
  mkdir -p "$BOOT"
  curl --fail --silent --show-error --location \
      "https://codeload.github.com/$E2E_REPO/tar.gz/$BASE_REF" \
    | tar -xz --strip-components=1 -C "$BOOT" || { fail_ "1a bootstrap tarball"; exit 1; }
  ( cd "$BOOT" \
      && corepack pnpm install --frozen-lockfile > "$HOME/e2e-upd-bootstrap-install.log" 2>&1 \
      && bash scripts/build-npm.sh --skip-checks --skip-typecheck > "$HOME/e2e-upd-bootstrap-build.log" 2>&1 ) \
    || { tail -40 "$HOME"/e2e-upd-bootstrap-*.log; fail_ "1b bootstrap build"; exit 1; }
  TARBALL="$(cd "$BOOT/cli" && npm pack --silent 2>/dev/null | tail -1)"
  mkdir -p "$HOME/e2e-upd-bootstrap-cli"
  ( cd "$HOME/e2e-upd-bootstrap-cli" && npm install --no-fund --no-audit "$BOOT/cli/$TARBALL" > "$HOME/e2e-upd-bootstrap-npm.log" 2>&1 ) \
    || { tail -40 "$HOME/e2e-upd-bootstrap-npm.log"; fail_ "1c bootstrap npm install"; exit 1; }
  BOOTSTRAP_CLI="$HOME/e2e-upd-bootstrap-cli/node_modules/paperclipai/dist/index.js"
fi
node "$BOOTSTRAP_CLI" --version >/dev/null || { fail_ "1d bootstrap CLI smoke"; exit 1; }
pass "1 bootstrap CLI ready"

note "2. install --ref $BASE_REF (the 'old version' the user installed a while ago)"
if node "$BOOTSTRAP_CLI" install --repo "$E2E_REPO" --ref "$BASE_REF" --yes; then
  pass "2a install base ref exits 0"
else
  fail_ "2a install base ref exits 0"; exit 1
fi
BASE_TARGET="$(current_target)"
case "$BASE_TARGET" in
  *"installs/git/"*) pass "2b current -> git payload ($(basename "$BASE_TARGET"))" ;;
  *) fail_ "2b current -> git payload (got: $BASE_TARGET)"; exit 1 ;;
esac

note "3. onboard + service start on the old version (initializes the database)"
if shim onboard --yes --install-service; then
  pass "3a onboard --yes --install-service exits 0"
else
  fail_ "3a onboard --yes --install-service exits 0"; exit 1
fi
if wait_active; then
  pass "3b service active on base version"
else
  fail_ "3b service active on base version"; exit 1
fi
FIRST_RUN_BEFORE="$(first_run_count)"
PG_VERSION_FILE="$(find "$PAPERCLIP_HOME" -name PG_VERSION 2>/dev/null | head -1)"
PG_INODE_BEFORE="$([ -n "$PG_VERSION_FILE" ] && ls -i "$PG_VERSION_FILE" | awk '{print $1}')"
[ -n "$PG_VERSION_FILE" ] && pass "3c embedded Postgres cluster initialized" || fail_ "3c embedded Postgres cluster found"

note "4. baseline dump: probe table must NOT exist on the old schema"
if shim db-backup >/dev/null 2>&1; then
  pass "4a db-backup on base version exits 0"
else
  fail_ "4a db-backup on base version exits 0"
fi
BASELINE_DUMP="$(newest_backup)"
if [ -n "$BASELINE_DUMP" ] && ! dump_text "$BASELINE_DUMP" | grep -q "e2e_update_probe"; then
  pass "4b baseline schema has no e2e_update_probe table"
else
  fail_ "4b baseline schema has no e2e_update_probe table (dump: ${BASELINE_DUMP:-<none>})"
fi
BACKUPS_BEFORE="$(backup_count)"

note "5. simulate time passing: tracked ref now points at $NEXT_REF (adds one migration)"
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  m.ref = process.argv[2];
  fs.writeFileSync(p, JSON.stringify(m, null, 2));
' "$STORE/install.json" "$NEXT_REF" && pass "5a tracked ref updated in install.json" || fail_ "5a tracked ref update"

shim update --check --json; CHECK_EXIT=$?
if [ "$CHECK_EXIT" -eq 10 ]; then
  pass "5b update --check sees the new version (exit 10)"
else
  fail_ "5b update --check sees the new version (got exit $CHECK_EXIT)"
fi

note "6. update --yes (backup -> build new payload -> flip -> restart service)"
if shim update --yes > "$HOME/e2e-upd-update.log" 2>&1; then
  pass "6a update --yes exits 0"
else
  tail -40 "$HOME/e2e-upd-update.log"; fail_ "6a update --yes exits 0"; exit 1
fi
tail -5 "$HOME/e2e-upd-update.log"
BACKUPS_AFTER="$(backup_count)"
if [ "$BACKUPS_AFTER" -gt "$BACKUPS_BEFORE" ]; then
  pass "6b pre-update database backup was written ($BACKUPS_BEFORE -> $BACKUPS_AFTER)"
else
  fail_ "6b pre-update database backup was written ($BACKUPS_BEFORE -> $BACKUPS_AFTER)"
fi
NEXT_TARGET="$(current_target)"
if [ "$NEXT_TARGET" != "$BASE_TARGET" ] && [ "${NEXT_TARGET#*installs/git/}" != "$NEXT_TARGET" ]; then
  pass "6c payload flipped to new git payload ($(basename "$NEXT_TARGET"))"
else
  fail_ "6c payload flipped (before: $BASE_TARGET after: $NEXT_TARGET)"
fi

note "7. service healthy on the new version, with the migration applied"
if wait_active; then
  pass "7a service active after update"
else
  fail_ "7a service active after update"; exit 1
fi
if shim service logs -n 2000 2>/dev/null | grep -q "e2e_update_probe"; then
  pass "7b service logs mention applying the probe migration"
else
  fail_ "7b service logs mention applying the probe migration"
fi
if shim db-backup >/dev/null 2>&1; then
  pass "7c db-backup on new version exits 0"
else
  fail_ "7c db-backup on new version exits 0"
fi
POST_DUMP="$(newest_backup)"
if [ -n "$POST_DUMP" ] && dump_text "$POST_DUMP" | grep -q "e2e_update_probe"; then
  pass "7d probe migration table exists in the real database after update"
else
  fail_ "7d probe migration table exists in the real database (dump: ${POST_DUMP:-<none>})"
fi

note "8. data continuity: same database cluster, not re-initialized"
FIRST_RUN_AFTER="$(first_run_count)"
if [ "$FIRST_RUN_AFTER" = "$FIRST_RUN_BEFORE" ]; then
  pass "8a no new first-run database initialization after update ($FIRST_RUN_BEFORE -> $FIRST_RUN_AFTER)"
else
  fail_ "8a no new first-run database initialization ($FIRST_RUN_BEFORE -> $FIRST_RUN_AFTER)"
fi
PG_INODE_AFTER="$([ -n "$PG_VERSION_FILE" ] && ls -i "$PG_VERSION_FILE" 2>/dev/null | awk '{print $1}')"
if [ -n "$PG_INODE_BEFORE" ] && [ "$PG_INODE_AFTER" = "$PG_INODE_BEFORE" ]; then
  pass "8b embedded Postgres cluster reused (same PG_VERSION inode)"
else
  fail_ "8b embedded Postgres cluster reused (inode $PG_INODE_BEFORE -> ${PG_INODE_AFTER:-<gone>})"
fi

note "9. rollback: old payload must still boot against the migrated database"
if shim update --rollback; then
  pass "9a update --rollback exits 0"
else
  fail_ "9a update --rollback exits 0"
fi
case "$(current_target)" in
  "$BASE_TARGET") pass "9b rollback restored the base payload" ;;
  *) fail_ "9b rollback restored the base payload (got: $(current_target))" ;;
esac
if wait_active; then
  pass "9c rolled-back service is active against the migrated schema"
else
  fail_ "9c rolled-back service is active against the migrated schema"
fi

note "10. cleanup"
shim service stop >/dev/null 2>&1 || true
if shim service uninstall && shim uninstall; then
  pass "10a service uninstall + uninstall exit 0"
else
  fail_ "10a service uninstall + uninstall exit 0"
fi
trap - EXIT

note "RESULTS ($E2E_REPO $BASE_REF -> $NEXT_REF on $(uname -sm))"
printf '%s\n' "${RESULTS[@]}"
if [ "$FAILED" = "1" ]; then echo; echo "OVERALL: FAIL"; exit 1; fi
echo; echo "OVERALL: PASS"
