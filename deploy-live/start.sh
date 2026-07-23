#!/bin/bash
# Start real_trader + dashboard in parallel
set -e

echo "Starting Real Trading Bot + Dashboard..."

# Honor DATA_DIR for both mkdir and the SQLite guard. Original script used
# literal 'data'; my Plan 3 cutover guard introduced DATA_DIR-aware logic
# and that needs to flow through every directory reference here.
DATA_DIR="${DATA_DIR:-./data}"
mkdir -p "${DATA_DIR}"

# Plan 3 cutover guard: refuse to start if USE_SQLITE_STATE=true is requested
# but the SQLite state file is missing (would silently start without persisted
# positions). Force operator to either run migrate_to_sqlite.py first, or set
# USE_SQLITE_STATE=false explicitly.
if [ "${USE_SQLITE_STATE:-false}" = "true" ] && [ ! -f "${DATA_DIR}/state.db" ]; then
    echo "FATAL: USE_SQLITE_STATE=true but ${DATA_DIR}/state.db is missing." >&2
    echo "Run 'python migrate_to_sqlite.py' first, or unset USE_SQLITE_STATE." >&2
    exit 1
fi

# Start dashboard
python -u dashboard.py &
DASH_PID=$!

# Start trader
python -u real_trader.py &
TRADER_PID=$!

# Wait for either to exit
wait -n $DASH_PID $TRADER_PID

echo "Process exited, shutting down..."
kill $DASH_PID $TRADER_PID 2>/dev/null
wait
exit 1
