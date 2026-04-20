#!/bin/bash
# Start real_trader + dashboard in parallel
set -e

echo "Starting Real Trading Bot + Dashboard..."

mkdir -p data

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
