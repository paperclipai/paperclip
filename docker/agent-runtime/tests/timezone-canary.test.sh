#!/bin/sh
set -eu

canary="${1:-$(dirname "$0")/../timezone-canary.sh}"
expected="timezone-canary: ok zone=America/New_York winter=-0500/EST summer=-0400/EDT"
actual="$($canary)"

if [ "$actual" != "$expected" ]; then
  echo "timezone-canary.test: expected '$expected', got '$actual'" >&2
  exit 1
fi

echo "timezone-canary.test: ok"
