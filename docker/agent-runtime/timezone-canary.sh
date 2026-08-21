#!/bin/sh
set -eu

export LC_ALL=C

zone="America/New_York"
zone_file="/usr/share/zoneinfo/$zone"

if [ ! -r "$zone_file" ]; then
  echo "timezone-canary: missing $zone_file" >&2
  exit 1
fi

assert_instant() {
  instant="$1"
  expected="$2"
  actual="$(TZ="$zone" date --date="$instant" '+%Y-%m-%dT%H:%M:%S %z %Z')"

  if [ "$actual" != "$expected" ]; then
    echo "timezone-canary: $instant expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

assert_instant "2024-01-15T12:00:00Z" "2024-01-15T07:00:00 -0500 EST"
assert_instant "2024-07-01T12:00:00Z" "2024-07-01T08:00:00 -0400 EDT"

echo "timezone-canary: ok zone=$zone winter=-0500/EST summer=-0400/EDT"
