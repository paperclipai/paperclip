#!/usr/bin/env bash
set -euo pipefail

# restore-smoke.sh — restore backup artifacts into a throwaway environment and
# assert the result is usable. This is the repeatable test behind
# docs/deploy/backup-restore.md: run it on a schedule, because an artifact
# nobody has restored is a guess.
#
# Usage:
#   scripts/restore-smoke.sh --db db-<ts>.sql.gz [--volume paperclip-<ts>.tar.gz]
#
# Options:
#   --db <file>          gzipped pg_dump artifact (required)
#   --volume <file>      gzipped tar of the data directory; enables the
#                        master-key and run-log checks, which are the two
#                        things a database-only restore loses silently
#   --image <ref>        postgres image, default postgres:17-alpine — match the
#                        major version the dump came from
#   --max-missing <n>    run-log refs allowed to be missing, default 0. Set it
#                        to the number the *source* deployment is known to
#                        lack (see restore-verify-logs.sh), never to whatever
#                        makes the check pass
#   --keep               leave the container and extracted tree behind
#
# Needs docker and tar on the host; psql runs inside the container, so the host
# needs no PostgreSQL client. Exits non-zero on the first failure.

DB_ARTIFACT=""
VOLUME_ARTIFACT=""
PG_IMAGE="postgres:17-alpine"
MAX_MISSING=0
KEEP=0

usage() {
  sed -n '3,29p' "$0" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --db)     [ $# -ge 2 ] || usage; DB_ARTIFACT="$2"; shift 2 ;;
    --volume) [ $# -ge 2 ] || usage; VOLUME_ARTIFACT="$2"; shift 2 ;;
    --image)  [ $# -ge 2 ] || usage; PG_IMAGE="$2"; shift 2 ;;
    --max-missing) [ $# -ge 2 ] || usage; MAX_MISSING="$2"; shift 2 ;;
    --keep)   KEEP=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

[ -n "$DB_ARTIFACT" ] || usage
[ -f "$DB_ARTIFACT" ] || { echo "FAIL: no such file: $DB_ARTIFACT" >&2; exit 1; }
if [ -n "$VOLUME_ARTIFACT" ] && [ ! -f "$VOLUME_ARTIFACT" ]; then
  echo "FAIL: no such file: $VOLUME_ARTIFACT" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTAINER="restore-smoke-$$"
EXTRACT_DIR=""

# The trap's own status must not leak into the script's exit code: bash reports
# the EXIT trap's last command as the exit status of an otherwise successful
# script, so a `[ -n "$EXTRACT_DIR" ] && ...` that is false here would turn a
# passing database-only run into exit 1.
cleanup() {
  if [ "$KEEP" -eq 1 ]; then
    echo "--keep: container $CONTAINER and ${EXTRACT_DIR:-(no extract dir)} left in place"
    return 0
  fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  if [ -n "$EXTRACT_DIR" ]; then
    rm -rf "$EXTRACT_DIR"
  fi
  return 0
}
trap cleanup EXIT

step() { echo; echo "=== $* ==="; }

# 1. The artifacts are intact. A truncated gzip is the most common bad surprise
#    and it costs a second to rule out before spending minutes on a restore.
step "artifact integrity"
gzip -t "$DB_ARTIFACT"
echo "ok: $DB_ARTIFACT"
if [ -n "$VOLUME_ARTIFACT" ]; then
  gzip -t "$VOLUME_ARTIFACT"
  echo "ok: $VOLUME_ARTIFACT"
fi

# 2. A clean database. POSTGRES_USER=paperclip is what makes the dump's
#    `OWNER TO`/`GRANT` statements resolve, and it makes that role a superuser
#    so `CREATE EXTENSION` succeeds.
step "clean $PG_IMAGE"
docker run -d --name "$CONTAINER" \
  -e POSTGRES_USER=paperclip \
  -e POSTGRES_DB=paperclip \
  -e POSTGRES_PASSWORD=restore-smoke \
  "$PG_IMAGE" >/dev/null

# Poll over TCP, not the unix socket. The postgres entrypoint runs a temporary
# server during initdb that listens on the socket only, so a socket-based
# pg_isready reports ready, we start loading, and the real startup pulls the
# server out from under us.
ready=0
for _ in $(seq 1 120); do
  if docker exec "$CONTAINER" \
      psql -U paperclip -d paperclip -h 127.0.0.1 -Atqc 'select 1' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "FAIL: $PG_IMAGE never accepted a TCP connection. Container log:" >&2
  docker logs "$CONTAINER" 2>&1 | tail -20 >&2
  exit 1
fi
echo "accepting connections"

# 3. Load it. ON_ERROR_STOP=1 is not optional: without it psql reports errors,
#    carries on, and exits 0 with a partially populated database.
step "load $DB_ARTIFACT"
gunzip -c "$DB_ARTIFACT" | docker exec -i "$CONTAINER" \
  psql -U paperclip -d paperclip -v ON_ERROR_STOP=1 --quiet --no-psqlrc
echo "load ok"

# 4. The SQL checker. It raises, so ON_ERROR_STOP turns a failed check into a
#    non-zero exit here.
step "restore-verify.sql"
docker exec -i "$CONTAINER" \
  psql -U paperclip -d paperclip -v ON_ERROR_STOP=1 -f - < "$SCRIPT_DIR/restore-verify.sql"

if [ -z "$VOLUME_ARTIFACT" ]; then
  echo
  echo "RESTORE SMOKE PASSED (database only)"
  echo "No --volume given, so the master key and the run-log files were NOT"
  echo "checked. A restore that passes here can still be missing every"
  echo "transcript and every stored credential."
  exit 0
fi

# 5. The data directory. Extracting one level off is the easiest mistake in the
#    whole runbook, and it looks like success until something opens a file.
step "extract $VOLUME_ARTIFACT"
EXTRACT_DIR="$(mktemp -d)"
tar -xzf "$VOLUME_ARTIFACT" -C "$EXTRACT_DIR" --strip-components=1
echo "extracted to $EXTRACT_DIR"

# 6. The master key. The database holds secret metadata encrypted against it;
#    without the file every stored credential is undecryptable, and nothing in
#    the database can tell you that.
step "secrets master key"
key_count=0
for key in "$EXTRACT_DIR"/instances/*/secrets/master.key; do
  [ -f "$key" ] || continue
  key_count=$((key_count + 1))
  mode="$(stat -c '%a' "$key")"
  echo "found $key (mode $mode)"
  if [ "$mode" != "600" ]; then
    echo "FAIL: master key mode is $mode, expected 600" >&2
    exit 1
  fi
done
if [ "$key_count" -eq 0 ]; then
  echo "FAIL: no instances/*/secrets/master.key in the archive." >&2
  echo "      Every stored credential is undecryptable from this artifact set," >&2
  echo "      or the archive was extracted at the wrong level." >&2
  exit 1
fi

# 7. The run logs the restored database points at. This is the one check that
#    needs both artifacts at once, and the one nothing else performs. Every
#    ref, not a sample: a sample makes the outcome a coin toss on a deployment
#    that has a few source-side dangling refs of its own.
step "run-log reachability (every ref, tolerance $MAX_MISSING)"
docker exec -i "$CONTAINER" psql -U paperclip -d paperclip -Atq --no-psqlrc -c \
  "select log_ref || E'\t' || created_at from heartbeat_runs
    where log_store = 'local_file' and log_ref is not null" \
  | "$SCRIPT_DIR/restore-verify-logs.sh" "$EXTRACT_DIR" --max-missing "$MAX_MISSING"

echo
echo "RESTORE SMOKE PASSED (database + data directory)"
