#!/usr/bin/env bash
set -euo pipefail

LIVE="paperclip"
RESTORED="paperclip_restored"
PRIOR="paperclip_prior"
ROLLBACK=0
FRESH=0

usage() {
  local code="${1:-2}"
  if [ "$code" -eq 0 ]; then help_text; else help_text >&2; fi
  exit "$code"
}

help_text() {
  cat <<'EOF'
restore-swap-db.sh: swap a restored database in for the live one, and never
leave the deployment without a database named `paperclip`.

Usage:
  restore-swap-db.sh [--live <name>] [--restored <name>] [--prior <name>] -- <psql command...>
  restore-swap-db.sh --fresh [--live <name>] [--restored <name>] -- <psql command...>
  restore-swap-db.sh --rollback [--live <name>] [--prior <name>] -- <psql command...>

The swap renames the live database to the prior name and the restored database
to the live name, both in one transaction. A failed rename, an interrupt, a
dropped connection or a killed client before COMMIT rolls both renames back.
Before it renames anything, the script requires the live and the restored
database to exist and the prior name to be free. It terminates every other
connection to both databases, and it reads the catalog back afterwards.

Options:
  --live <name>       the database Paperclip uses, default paperclip
  --restored <name>   the database the dump was loaded into, default
                      paperclip_restored
  --prior <name>      the name the live database is kept under as the rollback
                      copy, default paperclip_prior
  --fresh             the target cluster has no live database yet, for example
                      a new PostgreSQL that an embedded deployment moves to.
                      Renames the restored database to the live name. Refuses
                      if the live or the prior database exists
  --rollback          for a deployment stranded by a swap typed by hand as two
                      separate statements: renames the prior database back to
                      the live name
  -h, --help          print this help

Everything after `--` is the psql invocation, as the runbook's $PSQL array:
for example `-- docker compose -f compose.yaml exec -T db psql -U paperclip` or
`-- psql -h db.internal -U paperclip`. The script runs it with `-d postgres`,
so it must not name a database itself.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --live)     [ $# -ge 2 ] || usage; LIVE="$2"; shift 2 ;;
    --restored) [ $# -ge 2 ] || usage; RESTORED="$2"; shift 2 ;;
    --prior)    [ $# -ge 2 ] || usage; PRIOR="$2"; shift 2 ;;
    --rollback) ROLLBACK=1; shift ;;
    --fresh)    FRESH=1; shift ;;
    --) shift; break ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
[ $# -gt 0 ] || { echo "no psql command given after --" >&2; usage; }
PSQL=("$@")
if [ "$ROLLBACK" -eq 1 ] && [ "$FRESH" -eq 1 ]; then
  echo "--rollback and --fresh cannot be combined" >&2
  usage
fi

for name in "$LIVE" "$RESTORED" "$PRIOR"; do
  case "$name" in
    ''|*[!A-Za-z0-9_]*) echo "database names must be [A-Za-z0-9_]+, got: '$name'" >&2; exit 2 ;;
  esac
done

q() { "${PSQL[@]}" -d postgres -v ON_ERROR_STOP=1 -Atq --no-psqlrc "$@"; }

db_exists() {
  [ "$(q -c "select count(*) from pg_database where datname = '$1'")" = "1" ]
}

list_dbs() {
  q -c "select datname from pg_database where datname in ('$LIVE', '$RESTORED', '$PRIOR') order by 1" | paste -sd ' ' -
}

terminate_others() {
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

if [ "$FRESH" -eq 1 ]; then
  if db_exists "$LIVE"; then
    echo "FAIL: a database named $LIVE exists, so this is not a fresh target." >&2
    echo "      Run the swap without --fresh. Present: $(list_dbs)" >&2
    exit 1
  fi
  if db_exists "$PRIOR"; then
    echo "FAIL: no database named $LIVE, but $PRIOR exists: an earlier swap was" >&2
    echo "      interrupted between its two renames. Present: $(list_dbs)" >&2
    echo "      Put the original back first:" >&2
    echo "        $0 --rollback --live $LIVE --prior $PRIOR -- ${PSQL[*]}" >&2
    exit 1
  fi
  if ! db_exists "$RESTORED"; then
    echo "FAIL: no database named $RESTORED. Load the dump into it first (restore step 3). Present: $(list_dbs)" >&2
    exit 1
  fi
  terminate_others "$RESTORED"
  q -c "ALTER DATABASE \"$RESTORED\" RENAME TO \"$LIVE\""
  echo "$RESTORED renamed to $LIVE"
  if ! db_exists "$LIVE" || db_exists "$RESTORED"; then
    echo "FAIL: catalog does not show the expected result. Present: $(list_dbs)" >&2
    exit 1
  fi
  echo "FRESH TARGET READY: $LIVE is the restored database; there is no prior copy. Present: $(list_dbs)"
  exit 0
fi

if ! db_exists "$LIVE"; then
  if db_exists "$PRIOR"; then
    echo "FAIL: no database named $LIVE, but $PRIOR exists: an earlier swap was" >&2
    echo "      interrupted between its two renames. Present: $(list_dbs)" >&2
    echo "      Put the original back first:" >&2
    echo "        $0 --rollback --live $LIVE --prior $PRIOR -- ${PSQL[*]}" >&2
    echo "      then re-run the swap." >&2
  else
    echo "FAIL: no database named $LIVE. Present: $(list_dbs)" >&2
    echo "      If this cluster is a fresh target with no Paperclip database yet," >&2
    echo "      re-run with --fresh." >&2
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

terminate_others "$LIVE"
terminate_others "$RESTORED"

fault=""
if [ "${RESTORE_SWAP_TEST_FAULT:-}" = "between-renames" ]; then
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

if ! db_exists "$LIVE" || ! db_exists "$PRIOR" || db_exists "$RESTORED"; then
  echo "FAIL: catalog does not show the expected result. Present: $(list_dbs)" >&2
  exit 1
fi
echo "SWAP COMPLETE: $LIVE is the restored database, $PRIOR is the rollback copy. Present: $(list_dbs)"
