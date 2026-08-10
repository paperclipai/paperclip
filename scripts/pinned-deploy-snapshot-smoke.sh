#!/usr/bin/env bash
# Disposable snapshot / unique-index / isolated boot+API smoke for pinned deploy.
# NEVER targets the live `paperclip` database name unless explicitly overridden
# AND PAPERCLIP_PINNED_DEPLOY_ALLOW_LIVE_DB=1 (still refused for name=paperclip).
#
# Modes:
#   uq-fixture       — unique-index duplicate reject on disposable DB
#   restore-migrate  — dump restore + migrate + status + disposable-port boot/API
#   boot-api         — boot/API only against an existing disposable DB URL
#   all              — uq-fixture then restore-migrate when dump available
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURE_DIR="$SCRIPT_DIR/pinned-deploy/fixtures"
STUB_SERVER="$FIXTURE_DIR/boot-api-stub-server.mjs"

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
BANNED_PORTS="${PAPERCLIP_PINNED_DEPLOY_BANNED_PORTS:-3100,3101,13100,13101}"
BOOT_STUB="${PAPERCLIP_PINNED_DEPLOY_BOOT_STUB:-0}"
SMOKE_PORT="${PAPERCLIP_PINNED_DEPLOY_SMOKE_PORT:-}"
HEALTH_TIMEOUT_S="${PAPERCLIP_PINNED_DEPLOY_HEALTH_TIMEOUT_S:-90}"

# Process bookkeeping for bounded cleanup (candidate only).
SMOKE_DB_NAME=""
SMOKE_SERVER_PID=""
SMOKE_INSTANCE_HOME=""
SMOKE_LOG_FILE=""

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
    "") fail "refusing empty database name" ;;
  esac
  # Hard refuse any name that does not look disposable.
  case "$name" in
    paperclip_promote_smoke_*|paperclip_boot_smoke_*) ;;
    *)
      if [ "${PAPERCLIP_PINNED_DEPLOY_ALLOW_CUSTOM_SMOKE_DB:-0}" != "1" ]; then
        fail "refusing non-disposable database name '$name' (expected paperclip_promote_smoke_* or paperclip_boot_smoke_*)"
      fi
      ;;
  esac
}

make_smoke_db_name() {
  local prefix="${1:-paperclip_promote_smoke}"
  echo "${prefix}_$(date +%Y%m%d%H%M%S)_$$"
}

build_database_url() {
  local db="$1"
  node -e '
    const [user, pass, host, port, db] = process.argv.slice(1);
    const u = new URL("postgres://localhost");
    u.username = user;
    u.password = pass;
    u.hostname = host;
    u.port = String(port);
    u.pathname = "/" + db;
    process.stdout.write(u.toString());
  ' "$PGUSER" "$PGPASSWORD" "$PGHOST" "$PGPORT" "$db"
}

cleanup_db() {
  local name="$1"
  if [ -z "$name" ]; then
    return 0
  fi
  # Safety: never drop live DB even if KEEP fails open.
  if [ "$name" = "$LIVE_DB_NAME" ] || [ "$name" = "paperclip" ]; then
    log "REFUSING cleanup of protected database name '$name'"
    return 1
  fi
  case "$name" in
    paperclip_promote_smoke_*|paperclip_boot_smoke_*) ;;
    *)
      if [ "${PAPERCLIP_PINNED_DEPLOY_ALLOW_CUSTOM_SMOKE_DB:-0}" != "1" ]; then
        log "REFUSING cleanup of non-disposable database name '$name'"
        return 1
      fi
      ;;
  esac
  if [ "$KEEP_DB" = "1" ]; then
    log "KEEP_SMOKE_DB=1; leaving $name"
    return 0
  fi
  log "dropping disposable db $name"
  psql_admin -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$name' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
  psql_admin -c "DROP DATABASE IF EXISTS \"$name\";" >/dev/null
}

stop_smoke_server() {
  if [ -n "${SMOKE_SERVER_PID:-}" ] && kill -0 "$SMOKE_SERVER_PID" 2>/dev/null; then
    log "stopping smoke candidate pid=$SMOKE_SERVER_PID"
    kill -TERM "$SMOKE_SERVER_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$SMOKE_SERVER_PID" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$SMOKE_SERVER_PID" 2>/dev/null; then
      kill -KILL "$SMOKE_SERVER_PID" 2>/dev/null || true
    fi
  fi
  SMOKE_SERVER_PID=""
}

full_cleanup() {
  stop_smoke_server
  if [ -n "${SMOKE_DB_NAME:-}" ]; then
    cleanup_db "$SMOKE_DB_NAME" || true
    SMOKE_DB_NAME=""
  fi
  if [ -n "${SMOKE_INSTANCE_HOME:-}" ] && [ -d "${SMOKE_INSTANCE_HOME:-}" ]; then
    rm -rf "$SMOKE_INSTANCE_HOME" 2>/dev/null || true
    SMOKE_INSTANCE_HOME=""
  fi
}

pick_disposable_port() {
  if [ -n "${SMOKE_PORT:-}" ]; then
    case ",$BANNED_PORTS," in
      *",$SMOKE_PORT,"*) fail "SMOKE_PORT $SMOKE_PORT is banned (live fleet ports)" ;;
    esac
    echo "$SMOKE_PORT"
    return 0
  fi
  BANNED_PORTS="$BANNED_PORTS" node -e '
    const net = require("net");
    const banned = new Set(String(process.env.BANNED_PORTS || "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n)));
    function tryListen(port) {
      return new Promise((resolve) => {
        const s = net.createServer();
        s.unref();
        s.on("error", () => resolve(null));
        s.listen(port, "127.0.0.1", () => {
          s.close(() => resolve(port));
        });
      });
    }
    (async () => {
      for (let i = 0; i < 200; i++) {
        const p = 37000 + Math.floor(Math.random() * 4000);
        if (banned.has(p) || banned.has(p + 10000)) continue;
        const got = await tryListen(p);
        if (got != null) {
          process.stdout.write(String(got));
          process.exit(0);
        }
      }
      process.exit(1);
    })();
  ' || fail "could not allocate disposable smoke port"
}

wait_for_health() {
  local base="$1"
  local timeout_s="${2:-$HEALTH_TIMEOUT_S}"
  local url="$base/api/health"
  local start now
  start="$(date +%s)"
  while true; do
    if curl -fsS "$url" >/tmp/pinned-deploy-health.$$.json 2>/dev/null; then
      if node -e '
        const fs=require("fs");
        const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
        if (j.status !== "ok") process.exit(2);
      ' /tmp/pinned-deploy-health.$$.json; then
        cat /tmp/pinned-deploy-health.$$.json
        rm -f /tmp/pinned-deploy-health.$$.json
        return 0
      fi
    fi
    now="$(date +%s)"
    if [ $((now - start)) -ge "$timeout_s" ]; then
      rm -f /tmp/pinned-deploy-health.$$.json
      fail "health check timed out after ${timeout_s}s at $url"
    fi
    sleep 0.5
  done
}

# Authenticated (local_trusted board actor, or cookie session when authenticated)
# issue create + read against the isolated candidate only.
run_authenticated_issue_smoke() {
  local base="$1"
  local health_json="$2"
  local tmp companies_json company_id create_json issue_id read_json
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/pinned-issue-smoke.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN

  local mode
  mode="$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.deploymentMode||"")' "$health_json")"

  # Cookie jar path used only for deploymentMode=authenticated.
  local cookie_jar=""
  if [ "$mode" = "authenticated" ]; then
    cookie_jar="$tmp/cookies.txt"
    local email="pinned-smoke-$$@example.invalid"
    local password="SmokePass_$$_Aa1"
    # Best-effort sign-up; sign-in if already present.
    curl -sS -c "$cookie_jar" -b "$cookie_jar" \
      -H "Content-Type: application/json" \
      -d "{\"name\":\"Pinned Smoke\",\"email\":\"$email\",\"password\":\"$password\"}" \
      "$base/api/auth/sign-up/email" >/dev/null 2>&1 || true
    curl -fsS -c "$cookie_jar" -b "$cookie_jar" \
      -H "Content-Type: application/json" \
      -d "{\"email\":\"$email\",\"password\":\"$password\"}" \
      "$base/api/auth/sign-in/email" >/dev/null \
      || fail "authenticated mode: sign-in failed"
  fi
  # local_trusted: board actor is implicit (local_implicit) — still an authenticated board path.

  if [ -n "$cookie_jar" ]; then
    companies_json="$(curl -fsS -b "$cookie_jar" -c "$cookie_jar" "$base/api/companies")" \
      || fail "GET /api/companies failed"
  else
    companies_json="$(curl -fsS "$base/api/companies")" \
      || fail "GET /api/companies failed"
  fi
  company_id="$(node -e '
    const j=JSON.parse(process.argv[1]);
    if (!Array.isArray(j) || j.length === 0) process.exit(2);
    process.stdout.write(String(j[0].id||""));
  ' "$companies_json")" || fail "no companies available for issue smoke"
  [ -n "$company_id" ] || fail "empty company id"

  if [ -n "$cookie_jar" ]; then
    create_json="$(curl -fsS -b "$cookie_jar" -c "$cookie_jar" \
      -H "Content-Type: application/json" \
      -X POST \
      -d "{\"title\":\"pinned-deploy-snapshot-smoke $$\",\"description\":\"disposable isolated candidate smoke\",\"status\":\"backlog\",\"allowDuplicate\":true}" \
      "$base/api/companies/$company_id/issues")" \
      || fail "authenticated issue create failed"
  else
    create_json="$(curl -fsS \
      -H "Content-Type: application/json" \
      -X POST \
      -d "{\"title\":\"pinned-deploy-snapshot-smoke $$\",\"description\":\"disposable isolated candidate smoke\",\"status\":\"backlog\",\"allowDuplicate\":true}" \
      "$base/api/companies/$company_id/issues")" \
      || fail "authenticated issue create failed"
  fi

  issue_id="$(node -e '
    const j=JSON.parse(process.argv[1]);
    if (!j.id) process.exit(2);
    process.stdout.write(String(j.id));
  ' "$create_json")" || fail "create response missing id"

  if [ -n "$cookie_jar" ]; then
    read_json="$(curl -fsS -b "$cookie_jar" -c "$cookie_jar" "$base/api/issues/$issue_id")" \
      || fail "authenticated issue read failed"
  else
    read_json="$(curl -fsS "$base/api/issues/$issue_id")" \
      || fail "authenticated issue read failed"
  fi
  node -e '
    const created=JSON.parse(process.argv[1]);
    const read=JSON.parse(process.argv[2]);
    if (read.id !== created.id) process.exit(2);
    if (!String(read.title||"").includes("pinned-deploy-snapshot-smoke")) process.exit(3);
  ' "$create_json" "$read_json" || fail "issue read mismatch"

  log "PASS authenticated issue create/read id=$issue_id company=$company_id mode=${mode:-local_trusted}"
  echo "$issue_id"
}

write_isolated_instance_config() {
  local home_dir="$1" instance_id="$2" db_url="$3" port="$4"
  local root key_src key_dst
  root="$home_dir/instances/$instance_id"
  mkdir -p "$root/logs" "$root/data/storage" "$root/secrets" "$root/data/backups"
  key_src="${PAPERCLIP_PINNED_DEPLOY_SECRETS_KEY:-$HOME/.paperclip/instances/default/secrets/master.key}"
  key_dst="$root/secrets/master.key"
  if [ -f "$key_src" ]; then
    cp "$key_src" "$key_dst"
    chmod 600 "$key_dst"
  else
    # Fresh key if default unavailable (stub path / bare CI).
    openssl rand -hex 32 >"$key_dst" 2>/dev/null || head -c 32 /dev/urandom | xxd -p -c 64 >"$key_dst"
    chmod 600 "$key_dst"
  fi
  node -e '
    const fs = require("fs");
    const [root, dbUrl, port, keyPath] = process.argv.slice(1);
    const cfg = {
      // This must remain a valid persisted Paperclip config: the isolated smoke
      // server reads it through the same schema as production.
      $meta: { version: 1, updatedAt: new Date().toISOString(), source: "doctor" },
      database: {
        mode: "postgres",
        connectionString: dbUrl,
        embeddedPostgresDataDir: root + "/db",
        // The external disposable DATABASE_URL is authoritative here, but the
        // schema still requires a valid positive value in the config file.
        embeddedPostgresPort: 54329,
        backup: { enabled: false, intervalMinutes: 60, retentionDays: 1, dir: root + "/data/backups" },
      },
      logging: { mode: "file", logDir: root + "/logs" },
      server: {
        deploymentMode: "local_trusted",
        exposure: "private",
        bind: "loopback",
        host: "127.0.0.1",
        port: Number(port),
        allowedHostnames: [],
        serveUi: false,
      },
      telemetry: { enabled: false },
      auth: { baseUrlMode: "auto", disableSignUp: false },
      storage: {
        provider: "local_disk",
        localDisk: { baseDir: root + "/data/storage" },
      },
      secrets: {
        provider: "local_encrypted",
        strictMode: false,
        localEncrypted: { keyFilePath: keyPath },
      },
    };
    fs.writeFileSync(root + "/config.json", JSON.stringify(cfg, null, 2) + "\n");
  ' "$root" "$db_url" "$port" "$key_dst"
}

start_candidate_server() {
  local candidate_root="$1" db_url="$2" port="$3"
  SMOKE_INSTANCE_HOME="$(mktemp -d "${TMPDIR:-/tmp}/pinned-smoke-home.XXXXXX")"
  local instance_id="pindsSmoke$$"
  write_isolated_instance_config "$SMOKE_INSTANCE_HOME" "$instance_id" "$db_url" "$port"
  SMOKE_LOG_FILE="$SMOKE_INSTANCE_HOME/instances/$instance_id/logs/smoke-server.log"
  mkdir -p "$(dirname "$SMOKE_LOG_FILE")"

  if [ "$BOOT_STUB" = "1" ]; then
    log "starting BOOT_STUB server on :$port"
    (
      unset DATABASE_URL
      export PORT="$port" HOST=127.0.0.1
      exec node "$STUB_SERVER"
    ) >"$SMOKE_LOG_FILE" 2>&1 &
    SMOKE_SERVER_PID=$!
    return 0
  fi

  [ -d "$candidate_root" ] || fail "candidate root missing: $candidate_root"
  [ -f "$candidate_root/server/src/index.ts" ] || fail "candidate lacks server/src/index.ts"

  log "starting candidate server from $candidate_root on :$port (isolated instance)"
  (
    cd "$candidate_root"
    unset DATABASE_URL
    export DATABASE_URL="$db_url"
    export PORT="$port"
    export HOST=127.0.0.1
    export PAPERCLIP_HOME="$SMOKE_INSTANCE_HOME"
    export PAPERCLIP_INSTANCE_ID="$instance_id"
    export PAPERCLIP_DEPLOYMENT_MODE=local_trusted
    export PAPERCLIP_DEPLOYMENT_EXPOSURE=private
    export HEARTBEAT_SCHEDULER_ENABLED=false
    export PAPERCLIP_DB_BACKUP_ENABLED=false
    export PAPERCLIP_UI_DEV_MIDDLEWARE=false
    export SERVE_UI=false
    export PAPERCLIP_STARTUP_GATE=0
    # Prefer package filter when workspace present.
    if [ -f "pnpm-workspace.yaml" ]; then
      exec pnpm --filter @paperclipai/server exec tsx src/index.ts
    else
      exec pnpm exec tsx server/src/index.ts
    fi
  ) >"$SMOKE_LOG_FILE" 2>&1 &
  SMOKE_SERVER_PID=$!
}

run_boot_api_smoke() {
  local db_name="$1"
  local candidate_root="${2:-${PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT:-}}"
  local db_url port base health_json issue_id

  assert_not_live_db "$db_name"
  port="$(pick_disposable_port)"
  case ",$BANNED_PORTS," in
    *",$port,"*) fail "refusing banned port $port" ;;
  esac

  db_url="$(build_database_url "$db_name")"
  start_candidate_server "$candidate_root" "$db_url" "$port"
  # Ensure server child is reaped even on failure paths inside this function.
  # shellcheck disable=SC2064
  trap "stop_smoke_server" RETURN

  if ! kill -0 "$SMOKE_SERVER_PID" 2>/dev/null; then
    fail "smoke server exited immediately; log: ${SMOKE_LOG_FILE:-none}"
  fi

  base="http://127.0.0.1:$port"
  log "waiting for $base/api/health"
  health_json="$(wait_for_health "$base" "$HEALTH_TIMEOUT_S")"
  log "health ok on :$port"

  issue_id="$(run_authenticated_issue_smoke "$base" "$health_json")"

  stop_smoke_server
  trap - RETURN

  mkdir -p "$RECEIPT_DIR"
  cat >"$RECEIPT_DIR/last-boot-api-smoke.json" <<JSON
{
  "gate": "snapshot_boot_api",
  "status": "pass",
  "database": "$db_name",
  "port": $port,
  "bannedPorts": "$BANNED_PORTS",
  "bootStub": $([ "$BOOT_STUB" = "1" ] && echo true || echo false),
  "candidateRoot": $(node -e 'process.stdout.write(JSON.stringify(process.argv[1]||""))' "$candidate_root"),
  "issueId": "$issue_id",
  "health": $(node -e 'process.stdout.write(process.argv[1])' "$health_json")
}
JSON
  log "PASS boot-api smoke on disposable port $port db=$db_name"
}

# Prove duplicate open fallback-monitor rows reject the unique index (outage #3 class).
run_uq_fixture() {
  local db
  db="$(make_smoke_db_name)"
  assert_not_live_db "$db"
  SMOKE_DB_NAME="$db"
  log "creating disposable db $db"
  psql_admin -c "CREATE DATABASE \"$db\" OWNER \"$PGUSER\";" >/dev/null

  local result="unknown"
  local errf
  errf="$(mktemp "${TMPDIR:-/tmp}/uq-fixture-err.XXXXXX")"
  # shellcheck disable=SC2064
  trap "cleanup_db '$db'; rm -f '$errf'; SMOKE_DB_NAME=\"\"" RETURN

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
    result="REJECTED_NONZERO"
  fi

  mkdir -p "$RECEIPT_DIR"
  cat >"$RECEIPT_DIR/last-uq-fixture.json" <<JSON
{"gate":"uq_fixture","status":"pass","reason":"$result","database":"$db","rc":$rc,"stderrHead":$(node -e 'const fs=require("fs");const t=fs.readFileSync(process.argv[1],"utf8").slice(0,500);process.stdout.write(JSON.stringify(t))' "$errf")}
JSON
  log "PASS uq-fixture: constraint path rejected duplicates ($result rc=$rc)"
  cleanup_db "$db"
  SMOKE_DB_NAME=""
  trap - RETURN
  rm -f "$errf"
}

# Restore dump -> disposable DB -> candidate migrate/status -> disposable-port boot/API.
# Removes only the disposable DB. Never touches live DB name paperclip for writes.
run_restore_migrate() {
  local candidate_root="${PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT:-}"
  if [ "$BOOT_STUB" != "1" ]; then
    [ -n "$candidate_root" ] || fail "PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT required for restore-migrate"
    [ -d "$candidate_root" ] || fail "candidate root missing: $candidate_root"
  else
    candidate_root="${candidate_root:-$REPO_ROOT}"
  fi

  local dump="$DUMP_PATH"
  local db
  db="$(make_smoke_db_name)"
  assert_not_live_db "$db"
  SMOKE_DB_NAME="$db"
  # shellcheck disable=SC2064
  trap "full_cleanup" EXIT

  if [ "$BOOT_STUB" = "1" ] && [ -z "$dump" ] && [ "${PAPERCLIP_PINNED_DEPLOY_ALLOW_LIVE_DUMP:-0}" != "1" ]; then
    # Unit-test path: empty disposable DB + HTTP stub (no live dump, no live ports).
    log "BOOT_STUB=1 without dump: creating empty disposable db $db"
    psql_admin -c "CREATE DATABASE \"$db\" OWNER \"$PGUSER\";" >/dev/null
  else
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

    log "creating disposable db $db for restore"
    psql_admin -c "CREATE DATABASE \"$db\" OWNER \"$PGUSER\";" >/dev/null

    log "restoring $dump -> $db"
    PGPASSWORD="$PGPASSWORD" /opt/homebrew/bin/pg_restore -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$db" --no-owner --no-acl "$dump" \
      || log "pg_restore exited non-zero (continuing if schema usable)"

    local url
    url="$(build_database_url "$db")"
    log "running candidate migrate against disposable db only"
    (
      cd "$candidate_root"
      unset DATABASE_URL
      export DATABASE_URL="$url"
      if [ -f "packages/db/package.json" ]; then
        pnpm --filter @paperclipai/db exec tsx src/migrate.ts
      else
        fail "candidate lacks packages/db"
      fi
    ) || fail "candidate migrate failed on disposable restore"

    mkdir -p "$RECEIPT_DIR"
    (
      cd "$candidate_root"
      export DATABASE_URL="$url"
      pnpm --filter @paperclipai/db exec tsx src/migration-status.ts --json
    ) | tee "$RECEIPT_DIR/last-migration-status.json" >/dev/null \
      || fail "migration-status failed"
  fi

  log "running disposable-port boot + /api/health + authenticated issue create/read"
  run_boot_api_smoke "$db" "$candidate_root"

  log "PASS restore-migrate + boot-api gate on disposable db $db"
  mkdir -p "$RECEIPT_DIR"
  cat >"$RECEIPT_DIR/last-restore-migrate.json" <<JSON
{
  "gate": "snapshot_migrate",
  "status": "pass",
  "database": "$db",
  "dump": $(node -e 'process.stdout.write(JSON.stringify(process.argv[1]||""))' "${dump:-}"),
  "candidateRoot": $(node -e 'process.stdout.write(JSON.stringify(process.argv[1]||""))' "$candidate_root"),
  "bootApiReceipt": "last-boot-api-smoke.json"
}
JSON

  full_cleanup
  trap - EXIT
}

run_boot_api_only() {
  local db_url="${DATABASE_URL:-${PAPERCLIP_PINNED_DEPLOY_SMOKE_DATABASE_URL:-}}"
  local candidate_root="${PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT:-$REPO_ROOT}"
  local db_name

  if [ -n "$db_url" ]; then
    db_name="$(node -e 'try{const u=new URL(process.argv[1]);process.stdout.write(u.pathname.replace(/^\//,""))}catch{process.exit(2)}' "$db_url")" \
      || fail "could not parse database name from DATABASE_URL"
  else
    db_name="$(make_smoke_db_name paperclip_boot_smoke)"
    assert_not_live_db "$db_name"
    SMOKE_DB_NAME="$db_name"
    log "boot-api: creating empty disposable db $db_name"
    psql_admin -c "CREATE DATABASE \"$db_name\" OWNER \"$PGUSER\";" >/dev/null
  fi

  assert_not_live_db "$db_name"
  SMOKE_DB_NAME="$db_name"
  # shellcheck disable=SC2064
  trap "full_cleanup" EXIT
  run_boot_api_smoke "$db_name" "$candidate_root"
  full_cleanup
  trap - EXIT
}

case "$MODE" in
  uq-fixture|fixture)
    run_uq_fixture
    ;;
  restore-migrate|snapshot-smoke)
    run_restore_migrate
    ;;
  boot-api)
    run_boot_api_only
    ;;
  all)
    run_uq_fixture
    if [ -n "${DUMP_PATH:-}" ] || [ "${PAPERCLIP_PINNED_DEPLOY_ALLOW_LIVE_DUMP:-0}" = "1" ] || [ "$BOOT_STUB" = "1" ]; then
      run_restore_migrate
    else
      log "skip restore-migrate (no dump path; uq-fixture only)"
    fi
    ;;
  *)
    cat <<'USAGE' >&2
Usage:
  pinned-deploy-snapshot-smoke.sh uq-fixture
  pinned-deploy-snapshot-smoke.sh restore-migrate   # DUMP_PATH or ALLOW_LIVE_DUMP=1; boots disposable port + API smoke
  pinned-deploy-snapshot-smoke.sh boot-api          # disposable DB + boot/API only (BOOT_STUB=1 for unit tests)
  pinned-deploy-snapshot-smoke.sh all

Env:
  PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT   candidate worktree (required for real boot)
  PAPERCLIP_PINNED_DEPLOY_DUMP_PATH        pg_dump -Fc path
  PAPERCLIP_PINNED_DEPLOY_ALLOW_LIVE_DUMP  1 = read-only dump of live DB name
  PAPERCLIP_PINNED_DEPLOY_BOOT_STUB        1 = HTTP stub instead of real server (tests)
  PAPERCLIP_PINNED_DEPLOY_SMOKE_PORT       optional fixed disposable port
  PAPERCLIP_PINNED_DEPLOY_BANNED_PORTS     default 3100,3101,13100,13101
USAGE
    exit 2
    ;;
esac
