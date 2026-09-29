#!/bin/sh
set -eu
set +x
credential=$1
expected_role=$2
IFS= read -r url < "$credential" || [ -n "${url-}" ]
# Synthetic URLs use alphanumeric credentials; split them into libpq environment
# variables so no credential appears in the psql command line.
authority=${url#postgres://}
user_info=${authority%%@*}
host_and_db=${authority#*@}
host_and_port=${host_and_db%%/*}
PGUSER=${user_info%%:*}
PGPASSWORD=${user_info#*:}
PGHOST=${host_and_port%%:*}
PGPORT=${host_and_port##*:}
PGDATABASE=${host_and_db#*/}
export PGUSER PGPASSWORD PGHOST PGPORT PGDATABASE
actual_role=$(psql -w -X -A -t -q -c 'SELECT current_user' 2>/dev/null)
[ "$actual_role" = "$expected_role" ]
if [ "$expected_role" = pc_service ]; then
  psql -w -X -A -t -q -c 'SELECT count(*) FROM protected' >/dev/null 2>&1
else
  if psql -w -X -A -t -q -c 'SELECT count(*) FROM protected' >/dev/null 2>&1; then
    exit 7
  fi
fi
