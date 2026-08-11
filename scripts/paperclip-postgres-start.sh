#!/usr/bin/env bash
# Foreground entrypoint for the default Paperclip Postgres service.
# launchd owns this script, and this script execs postgres so the DB lifecycle is
# independent of source-server reloads.
set -euo pipefail

ROOT="${PAPERCLIP_SOURCE_ROOT:-$HOME/paperclip}"
PGDATA="${PAPERCLIP_POSTGRES_DATA_DIR:-$HOME/.paperclip/instances/default/db}"
PGPORT="${PAPERCLIP_POSTGRES_PORT:-54329}"
PGBIN_DIR="${PAPERCLIP_EMBEDDED_POSTGRES_BIN_DIR:-$ROOT/node_modules/.pnpm/@embedded-postgres+darwin-arm64@18.1.0-beta.16/node_modules/@embedded-postgres/darwin-arm64/native/bin}"
LOG_DIR="${PAPERCLIP_POSTGRES_LOG_DIR:-$ROOT/.devlogs}"
POSTGRES="$PGBIN_DIR/postgres"
INITDB="$PGBIN_DIR/initdb"
PGPIDFILE="$PGDATA/postmaster.pid"
PS_COMMAND="${PAPERCLIP_POSTGRES_PS_COMMAND:-ps}"

log() { echo "[paperclip-postgres $(date '+%H:%M:%S')] $*" >&2; }

read_postmaster_pid() {
  local raw
  raw="$(head -1 "$PGPIDFILE" 2>/dev/null || true)"
  case "$raw" in
    ''|*[!0-9]*) return 1 ;;
    *) printf '%s\n' "$raw" ;;
  esac
}

process_matches_expected_postgres() {
  local pid="$1" comm command_line
  kill -0 "$pid" 2>/dev/null || return 1
  comm="$($PS_COMMAND -p "$pid" -o comm= 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' || true)"
  [ "$(basename "$comm")" = "postgres" ] || return 1
  command_line="$($PS_COMMAND -ww -p "$pid" -o command= 2>/dev/null || true)"
  case " $command_line " in
    *" -D $PGDATA "*) ;;
    *) return 1 ;;
  esac
  case " $command_line " in
    *" -p $PGPORT "*) ;;
    *) return 1 ;;
  esac
  return 0
}

if [ ! -x "$POSTGRES" ] || [ ! -x "$INITDB" ]; then
  log "missing embedded-postgres binaries in $PGBIN_DIR"
  exit 1
fi

mkdir -p "$PGDATA" "$LOG_DIR"

if [ ! -f "$PGDATA/PG_VERSION" ]; then
  pwfile="$(mktemp "${TMPDIR:-/tmp}/paperclip-postgres-pw.XXXXXX")"
  trap 'rm -f "$pwfile"' EXIT
  printf '%s\n' "paperclip" > "$pwfile"
  log "initializing postgres data dir $PGDATA"
  "$INITDB" -D "$PGDATA" --username=paperclip --pwfile="$pwfile" --encoding=UTF8 --locale=C --lc-messages=C
  rm -f "$pwfile"
  trap - EXIT
fi

while [ -f "$PGPIDFILE" ]; do
  if ! pg_pid="$(read_postmaster_pid)"; then
    log "removing malformed stale postmaster marker $PGPIDFILE"
    rm -f "$PGPIDFILE"
    break
  fi

  if process_matches_expected_postgres "$pg_pid"; then
    log "expected postmaster already running at pid $pg_pid; waiting to take over after it exits"
    while process_matches_expected_postgres "$pg_pid"; do
      sleep 2
    done
    continue
  fi

  current_pid="$(read_postmaster_pid 2>/dev/null || true)"
  if [ "$current_pid" = "$pg_pid" ]; then
    log "removing stale postmaster marker for pid $pg_pid (process identity/data-dir/port mismatch)"
    rm -f "$PGPIDFILE"
  fi
done

log "starting postgres on port $PGPORT with data dir $PGDATA"
exec "$POSTGRES" -D "$PGDATA" -p "$PGPORT" -c "shared_buffers=${PAPERCLIP_PG_SHARED_BUFFERS:-512MB}"
