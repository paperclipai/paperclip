#!/bin/sh
echo "=== claude setup-token starting ==="
echo "=== Watch here for the auth URL ==="
echo ""

# Run with a pseudo-tty via script(1) so claude doesn't detect headless and bail
claude setup-token 2>&1
EXIT=$?

echo ""
echo "=== setup-token exited with code $EXIT ==="
echo "=== Copy the token above, then delete this Railway service ==="

# Stay alive so you can read the logs
sleep infinity
