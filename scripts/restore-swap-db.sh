#!/usr/bin/env bash
set -euo pipefail

# restore-swap-db.sh — swap a restored database in for the live one, and never
# leave the deployment without a database named `paperclip`.
#
# The swap is two renames:
#
#   ALTER DATABASE paperclip          RENAME TO paperclip_prior
#   ALTER DATABASE paperclip_restored RENAME TO paperclip
#
# Run as two separate statements, there is a moment with no database called
# `paperclip`, and anything that stops the operator there — the second rename
# failing, Ctrl-C, the SSH session dropping, SIGKILL — strands the deployment:
# starting Paperclip then fails, or initializes an empty database over the top.
# ALTER DATABASE ... RENAME is transactional in PostgreSQL, so this script runs
# both in one transaction and that moment never exists outside it:
#
#   1. Preflight. Both databases must exist and `paperclip_prior` must not,
#      so a stranded or half-done earlier attempt is recognised before anything
#      is renamed rather than after.
#   2. Every other connection to the live and the restored database is
#      terminated first. A psql left open from the verify step is the usual
#      reason a rename fails; removing the cause beats handling the failure.
#   3. BEGIN; both renames; COMMIT — in one psql session. A failed rename, an
#      interrupt, a dropped connection or a killed client before COMMIT rolls
#      the whole transaction back on the server: both names are what they were.
#   4. Afterwards the catalog is read back and printed, so "done" is a
#      statement about what is there, not about what was attempted.
#
# `--rollback` is for a deployment stranded by a swap typed by hand as two
# separate statements: it renames `paperclip_prior` back to `paperclip`.
#
# Usage:
#   restore-swap-db.sh [--live <name>] [--restored <name>] [--prior <name>] -- <psql command...>
#   restore-swap-db.sh --rollback [--live <name>] [--prior <name>] -- <psql command...>
#
# Everything after `--` is the psql invocation, exactly as the runbook's
# $PSQL array: e.g. `-- docker compose -f compose.yaml exec -T db psql -U paperclip`
# or `-- psql -h db.internal -U paperclip`. It is run with `-d postgres`, so
# it must not name a database itself.

LIVE="paperclip"
RESTORED="paperclip_restored"
PRIOR="paperclip_prior"
ROLLBACK=0

usage() {
  echo "usage: $0 [--live <name>] [--restored <name>] [--prior <name>] [--rollback] -- <psql command...>" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --live)     [ $# -ge 2 ] || usage; LIVE="$2"; shift 2 ;;
    --restored) [ $# -ge 2 ] || usage; RESTORED="$2"; shift 2 ;;
    --prior)    [ $# -ge 2 ] || usage; PRIOR="$2"; shift 2 ;;
    --rollback) ROLLBACK=1; shift ;;
    --) shift; break ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
[ $# -gt 0 ] || { echo "no psql command given after --" >&2; usage; }
PSQL=("$@")

for name in "$LIVE" "$RESTORED" "$PRIOR"; do
  case "$name" in
    ''|*[!A-Za-z0-9_]*) echo "database names must be [A-Za-z0-9_]+, got: '$name'" >&2; exit 2 ;;
  esac
done

# All statements go to the maintenance database: renaming a database needs a
# session that is not connected to it.
q() { "${PSQL[@]}" -d postgres -v ON_ERROR_STOP=1 -Atq --no-psqlrc "$@"; }

db_exists() {
  [ "$(q -c "select count(*) from pg_database where datname = '$1'")" = "1" ]
}

list_dbs() {
  q -c "select datname from pg_database where datname in ('$LIVE', '$RESTORED', '$PRIOR') order by 1" | paste -sd ' ' -
}

terminate_others() {
  # Every session on the named database except our own. The count is printed
  # because a terminated connection is something the operator should know
  # about, even though it is not an error.
  local n
  n="$(q -c "select count(pg_terminate_backend(pid)) from pg_stat_activity
              where datname = '$1' and pid <> pg_backend_pid()")"
  if [ "$n" != "0" ]; then
    echo "terminated $n connection(s) to $1"
  fi
}

if [ "$ROLLBACK" -eq 1 ]; then
  if db_exists "$LIVE"; then
    echo "FAIL: a database named $LIVE exists; nothing to roll back. Present: $(list_dbs)" >&2
    exit 1
  fi
  if ! db_exists "$PRIOR"; then
    echo "FAIL: no database named $PRIOR to roll back from. Present: $(list_dbs)" >&2
    exit 1
  fi
  terminate_others "$PRIOR"
  q -c "ALTER DATABASE \"$PRIOR\" RENAME TO \"$LIVE\""
  echo "rolled back: $PRIOR renamed back to $LIVE. Present: $(list_dbs)"
  exit 0
fi

# 1. Preflight — refuse before renaming anything.
if ! db_exists "$LIVE"; then
  if db_exists "$PRIOR"; then
    echo "FAIL: no database named $LIVE, but $PRIOR exists: an earlier swap was" >&2
    echo "      interrupted between its two renames. Present: $(list_dbs)" >&2
    echo "      Put the original back first:" >&2
    echo "        $0 --rollback --live $LIVE --prior $PRIOR -- ${PSQL[*]}" >&2
    echo "      then re-run the swap." >&2
  else
    echo "FAIL: no database named $LIVE. Present: $(list_dbs)" >&2
  fi
  exit 1
fi
if ! db_exists "$RESTORED"; then
  echo "FAIL: no database named $RESTORED. Load the dump into it first (restore step 3). Present: $(list_dbs)" >&2
  exit 1
fi
if db_exists "$PRIOR"; then
  echo "FAIL: $PRIOR already exists — the rollback copy of an earlier restore." >&2
  echo "      Drop it, or rename it aside, before swapping again; this script" >&2
  echo "      will not overwrite a rollback point. Present: $(list_dbs)" >&2
  exit 1
fi

# 2. Remove the usual cause of a failed second rename before starting.
terminate_others "$LIVE"
terminate_others "$RESTORED"

# 3. Both renames in one transaction: all or nothing, on the server's side.
fault=""
if [ "${RESTORE_SWAP_TEST_FAULT:-}" = "between-renames" ]; then
  # Test hook: the session dies between the two renames, as it would if the
  # SSH session dropped or the client was killed at the worst moment.
  fault="SELECT pg_terminate_backend(pg_backend_pid());"
fi
if ! q <<SQL
BEGIN;
ALTER DATABASE "$LIVE" RENAME TO "$PRIOR";
$fault
ALTER DATABASE "$RESTORED" RENAME TO "$LIVE";
COMMIT;
SQL
then
  echo "FAIL: the swap did not commit, so nothing was renamed. Present: $(list_dbs)" >&2
  exit 1
fi
echo "$LIVE renamed to $PRIOR"
echo "$RESTORED renamed to $LIVE"

# 4. Say what is there, not what was attempted.
if ! db_exists "$LIVE" || ! db_exists "$PRIOR" || db_exists "$RESTORED"; then
  echo "FAIL: catalog does not show the expected result. Present: $(list_dbs)" >&2
  exit 1
fi
echo "SWAP COMPLETE: $LIVE is the restored database, $PRIOR is the rollback copy. Present: $(list_dbs)"
