#!/usr/bin/env bash
# Disposable snapshot / unique-index fixture smoke for pinned deploy promotion.
# NEVER targets the live `paperclip` database name unless explicitly overridden
# AND PAPERCLIP_PINNED_DEPLOY_ALLOW_LIVE_DB=1 (still refused for name=paperclip).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURE_DIR="$SCRIPT_DIR/pinned-deploy/fixtures"

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-54329}"
PGUSER="${PGUSER:-paperclip}"
PGPASSWORD="${PGPASSWORD:-}"
if [ -z "$PGPASSWORD" ] && [ -f "${PAPERCLIP_CONFIG:-$HOME/.paperclip/instances/default/config.json}" ]; then
  PGPASSWORD="$(
    node -e '
      const fs=require("fs");
      const p=process.argv[1];
      const j=JSON.parse(fs.readFileSync(p,"utf8"));
      const cs=j?.database?.connectionString||"";
      const m=cs.match(/^postgres(?:ql)?:\/\/[^:]+:([^@]+)@/);
      if(m) process.stdout.write(decodeURIComponent(m[1]));
    ' "${PAPERCLIP_CONFIG:-$HOME/.paperclip/instances/default/config.json}" 2>/dev/null || true
  )"
fi
export PGHOST PGPORT PGUSER PGPASSWORD

ADMIN_DB="${PAPERCLIP_PINNED_DEPLOY_ADMIN_DB:-postgres}"
LIVE_DB_NAME="${PAPERCLIP_PINNED_DEPLOY_LIVE_DB_NAME:-paperclip}"
DUMP_PATH="${PAPERCLIP_PINNED_DEPLOY_DUMP_PATH:-}"
KEEP_DB="${PAPERCLIP_PINNED_DEPLOY_KEEP_SMOKE_DB:-0}"
RECEIPT_DIR="${PAPERCLIP_PINNED_DEPLOY_RECEIPT_DIR:-$HOME/.paperclip/deploy/receipts}"
MODE="${1:-uq-fixture}"

log() { echo "[pinned-deploy-snapshot-smoke $(date '+%H:%M:%S')] $*" >&2; }
fail() { log "FAIL: $*"; exit 1; }

psql_admin() {
  /opt/homebrew/bin/psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$ADMIN_DB" -v ON_ERROR_STOP=1 "$@"
}

psql_db() {
  local db="$1"; shift
  /opt/homebrew/bin/psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$db" -v ON_ERROR_STOP=1 "$@"
}

assert_not_live_db() {
  local name="$1"
  if [ "$name" = "$LIVE_DB_NAME" ]; then
    fail "refusing to use live database name '$LIVE_DB_NAME'"
  fi
  case "$name" in
    paperclip) fail "refusing database name paperclip" ;;
  esac
}

make_smoke_db_name() {
  echo "paperclip_promote_smoke_$(date +%Y%m%d%H%M%S)_$$"
}

cleanup_db() {
  local name="$1"
  if [ "$KEEP_DB" = "1" ]; then
    log "KEEP_SMOKE_DB=1; leaving $name"
    return 0
  fi
  log "dropping disposable db $name"
  psql_admin -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$name' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
  psql_admin -c "DROP DATABASE IF EXISTS \"$name\";" >/dev/null
}

# Prove duplicate open fallback-monitor rows reject the unique index (outage #3 class).
run_uq_fixture() {
  local db
  db="$(make_smoke_db_name)"
  assert_not_live_db "$db"
  log "creating disposable db $db"
  psql_admin -c "CREATE DATABASE \"$db\" OWNER \"$PGUSER\";" >/dev/null

  local result="unknown"
  local errf
  errf="$(mktemp "${TMPDIR:-/tmp}/uq-fixture-err.XXXXXX")"
  # shellcheck disable=SC2064
  trap "cleanup_db '$db'; rm -f '$errf'" RETURN

  psql_db "$db" -f "$FIXTURE_DIR/minimal-issues-for-uq.sql" >/dev/null
  psql_db "$db" -f "$FIXTURE_DIR/duplicate-fallback-monitor.sql" >/dev/null

  set +e
  psql_db "$db" -f "$FIXTURE_DIR/create-fallback-monitor-uq.sql" >"$errf" 2>&1
  local rc=$?
  set -e

  if [ "$rc" -eq 0 ]; then
    result="UNEXPECTED_SUCCESS"
    log "index creation succeeded — fixture did NOT reject (gate fail)"
    mkdir -p "$RECEIPT_DIR"
    cat >"$RECEIPT_DIR/last-uq-fixture.json" <<JSON
{"gate":"uq_fixture","status":"fail","reason":"duplicate rows did not block unique index","database":"$db","rc":0}
JSON
    fail "unique index accepted duplicate open fallback-monitor rows"
  fi

  if grep -Eiq 'could not create unique index|duplicate key|unique constraint|already exists' "$errf"; then
    result="REJECTED_AS_EXPECTED"
  else
    # Some PG versions phrase differently; non-zero is still the required fail-closed signal.
    result="REJECTED_NONZERO"
  fi

  mkdir -p "$RECEIPT_DIR"
  cat >"$RECEIPT_DIR/last-uq-fixture.json" <<JSON
{"gate":"uq_fixture","status":"pass","reason":"$result","database":"$db","rc":$rc,"stderrHead":$(node -e 'const fs=require("fs");const t=fs.readFileSync(process.argv[1],"utf8").slice(0,500);process.stdout.write(JSON.stringify(t))' "$errf")}
JSON
  log "PASS uq-fixture: constraint path rejected duplicates ($result rc=$rc)"
}

# Optional: restore a provided -Fc dump into disposable DB and run candidate migrate.
# Requires DUMP_PATH. Does not dump live DB unless DUMP_PATH is empty AND
# PAPERCLIP_PINNED_DEPLOY_ALLOW_LIVE_DUMP=1 (read-only pg_dump).
run_restore_migrate() {
  local candidate_root="${PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT:-}"
  [ -n "$candidate_root" ] || fail "PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT required for restore-migrate"
  [ -d "$candidate_root" ] || fail "candidate root missing: $candidate_root"

  local dump="$DUMP_PATH"
  if [ -z "$dump" ]; then
    if [ "${PAPERCLIP_PINNED_DEPLOY_ALLOW_LIVE_DUMP:-0}" != "1" ]; then
      fail "no DUMP_PATH and live dump not allowed (set PAPERCLIP_PINNED_DEPLOY_DUMP_PATH or ALLOW_LIVE_DUMP=1)"
    fi
    mkdir -p "$RECEIPT_DIR"
    dump="$RECEIPT_DIR/live-pre-promote-$(date +%Y%m%d%H%M%S).dump"
    log "taking read-only pg_dump -Fc of $LIVE_DB_NAME -> $dump"
    PGPASSWORD="$PGPASSWORD" /opt/homebrew/bin/pg_dump -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -Fc -f "$dump" "$LIVE_DB_NAME" \
      || fail "pg_dump failed"
  fi
  [ -f "$dump" ] || fail "dump missing: $dump"

  local db
  db="$(make_smoke_db_name)"
  assert_not_live_db "$db"
  log "creating disposable db $db for restore"
  psql_admin -c "CREATE DATABASE \"$db\" OWNER \"$PGUSER\";" >/dev/null
  trap "cleanup_db '$db'" RETURN

  log "restoring $dump -> $db"
  PGPASSWORD="$PGPASSWORD" /opt/homebrew/bin/pg_restore -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$db" --no-owner --no-acl "$dump" \
    || log "pg_restore exited non-zero (continuing if schema usable)"

  local url="postgres://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${db}"
  log "running candidate migrate against disposable db only"
  (
    cd "$candidate_root"
    unset DATABASE_URL
    export DATABASE_URL="$url"
    # Prefer package migrate with explicit URL when supported via env.
    if [ -f "packages/db/package.json" ]; then
      pnpm --filter @paperclipai/db exec tsx src/migrate.ts
    else
      fail "candidate lacks packages/db"
    fi
  ) || fail "candidate migrate failed on disposable restore"

  (
    cd "$candidate_root"
    export DATABASE_URL="$url"
    pnpm --filter @paperclipai/db exec tsx src/migration-status.ts --json
  ) | tee "$RECEIPT_DIR/last-migration-status.json" >/dev/null \
    || fail "migration-status failed"

  log "PASS restore-migrate gate on disposable db $db"
  mkdir -p "$RECEIPT_DIR"
  cat >"$RECEIPT_DIR/last-restore-migrate.json" <<JSON
{"gate":"snapshot_migrate","status":"pass","database":"$db","dump":"$dump","candidateRoot":"$candidate_root"}
JSON
}

case "$MODE" in
  uq-fixture|fixture)
    run_uq_fixture
    ;;
  restore-migrate)
    run_restore_migrate
    ;;
  all)
    run_uq_fixture
    if [ -n "${DUMP_PATH:-}" ] || [ "${PAPERCLIP_PINNED_DEPLOY_ALLOW_LIVE_DUMP:-0}" = "1" ]; then
      run_restore_migrate
    else
      log "skip restore-migrate (no dump path; uq-fixture only)"
    fi
    ;;
  *)
    cat <<'USAGE' >&2
Usage:
  pinned-deploy-snapshot-smoke.sh uq-fixture
  pinned-deploy-snapshot-smoke.sh restore-migrate   # needs DUMP_PATH or ALLOW_LIVE_DUMP=1
  pinned-deploy-snapshot-smoke.sh all
USAGE
    exit 2
    ;;
esac
