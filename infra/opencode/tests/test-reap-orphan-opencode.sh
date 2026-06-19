#!/usr/bin/env bash
# Tests for reap-orphan-opencode.sh
# Run: bash infra/opencode/tests/test-reap-orphan-opencode.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAPER="$SCRIPT_DIR/../reap-orphan-opencode.sh"

PASS=0
FAIL=0
ERRORS=()

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc — expected '$expected', got '$actual'"
    ERRORS+=("$desc")
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc — '$needle' not found in output"
    echo "        output: $haystack"
    ERRORS+=("$desc")
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    echo "  FAIL: $desc — '$needle' unexpectedly found in output"
    echo "        output: $haystack"
    ERRORS+=("$desc")
    FAIL=$((FAIL + 1))
  else
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  fi
}

assert_file_not_contains() {
  local desc="$1" needle="$2" file="$3"
  if grep -qF "$needle" "$file" 2>/dev/null; then
    echo "  FAIL: $desc — '$needle' found in $file"
    ERRORS+=("$desc")
    FAIL=$((FAIL + 1))
  else
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  fi
}

# ── Source reaper in library mode to expose is_orphan without running main ──
# shellcheck disable=SC1090
REAP_LIB_MODE=1 source "$REAPER"

echo ""
echo "=== Unit tests: is_orphan predicate ==="

echo ""
echo "--- reparented (PPID==1) + old enough → should reap ---"
if is_orphan 12345 1 "systemd" 400; then
  assert_eq "PPID=1 parent=systemd etimes=400 → orphan" "orphan" "orphan"
else
  assert_eq "PPID=1 parent=systemd etimes=400 → orphan" "orphan" "not_orphan"
fi

echo ""
echo "--- reparented (parent comm=systemd) + old enough → should reap ---"
if is_orphan 12346 1234 "systemd" 600; then
  assert_eq "parent_comm=systemd etimes=600 → orphan" "orphan" "orphan"
else
  assert_eq "parent_comm=systemd etimes=600 → orphan" "orphan" "not_orphan"
fi

echo ""
echo "--- parent comm=init + old enough → should reap ---"
if is_orphan 12347 1 "init" 350; then
  assert_eq "parent_comm=init etimes=350 → orphan" "orphan" "orphan"
else
  assert_eq "parent_comm=init etimes=350 → orphan" "orphan" "not_orphan"
fi

echo ""
echo "--- live parent (node) → skip even if old ---"
if is_orphan 12348 999 "node" 1800; then
  assert_eq "parent_comm=node etimes=1800 → not orphan" "not_orphan" "orphan"
else
  assert_eq "parent_comm=node etimes=1800 → not orphan" "not_orphan" "not_orphan"
fi

echo ""
echo "--- live parent (opencode) → skip ---"
if is_orphan 12349 888 "opencode" 500; then
  assert_eq "parent_comm=opencode etimes=500 → not orphan" "not_orphan" "orphan"
else
  assert_eq "parent_comm=opencode etimes=500 → not orphan" "not_orphan" "not_orphan"
fi

echo ""
echo "--- live parent (paperclipai) → skip ---"
if is_orphan 12350 777 "paperclipai" 700; then
  assert_eq "parent_comm=paperclipai etimes=700 → not orphan" "not_orphan" "orphan"
else
  assert_eq "parent_comm=paperclipai etimes=700 → not orphan" "not_orphan" "not_orphan"
fi

echo ""
echo "--- live parent (heartbeat) → skip ---"
if is_orphan 12351 666 "heartbeat" 900; then
  assert_eq "parent_comm=heartbeat etimes=900 → not orphan" "not_orphan" "orphan"
else
  assert_eq "parent_comm=heartbeat etimes=900 → not orphan" "not_orphan" "not_orphan"
fi

echo ""
echo "--- too young (etimes < REAP_AGE_SEC) → skip ---"
if is_orphan 12352 1 "systemd" 100; then
  assert_eq "PPID=1 etimes=100 (young) → not orphan" "not_orphan" "orphan"
else
  assert_eq "PPID=1 etimes=100 (young) → not orphan" "not_orphan" "not_orphan"
fi

echo ""
echo "--- exactly at threshold (REAP_AGE_SEC default=300) → not yet ---"
REAP_AGE_SEC=300
if is_orphan 12353 1 "systemd" 299; then
  assert_eq "etimes=299 < 300 → not orphan" "not_orphan" "orphan"
else
  assert_eq "etimes=299 < 300 → not orphan" "not_orphan" "not_orphan"
fi

echo ""
echo "--- exactly at threshold → reap ---"
if is_orphan 12354 1 "systemd" 300; then
  assert_eq "etimes=300 >= 300 → orphan" "orphan" "orphan"
else
  assert_eq "etimes=300 >= 300 → orphan" "orphan" "not_orphan"
fi

# ── DRY-RUN unit test ────────────────────────────────────────────────────────
echo ""
echo "=== Unit tests: dry-run produces no kill ==="

MOCK_DIR="$(mktemp -d)"
MOCK_PS="$MOCK_DIR/ps"
TMP_DRYRUN_LOG="$(mktemp)"

# Mock ps matching the reaper's exact call format:
#   ps -eo pid=,ppid=,etimes=,args=    → 4 columns
#   ps -p $ppid -o comm=               → single comm string
cat > "$MOCK_PS" <<'MOCKEOF'
#!/usr/bin/env bash
# Detect single-process comm lookup: ps -p <pid> -o comm=
if [[ "$*" == *"-p "* && "$*" == *"comm="* ]]; then
  # Extract the pid from -p <pid>
  pid=""
  prev=""
  for arg in "$@"; do
    if [[ "$prev" == "-p" ]]; then pid="$arg"; fi
    prev="$arg"
  done
  case "$pid" in
    1)    echo "systemd" ;;  # orphan's parent
    5000) echo "bash"    ;;  # live child's parent (a real process)
    *)    echo ""        ;;
  esac
  exit 0
fi
# Main snapshot: 4 columns (pid ppid etimes args) — matches ps -eo pid=,ppid=,etimes=,args=
# Orphan candidate: PPID=1 (systemd), age=400s, args match "opencode models"
echo "88001 1 400 /home/user/.opencode/bin/opencode models"
# Live child: PPID=5000 (bash), not eligible
echo "88002 5000 600 /home/user/.opencode/bin/opencode run"
# Unrelated process: should be ignored
echo "88003 1 999 /usr/bin/python3 server.py"
MOCKEOF
chmod +x "$MOCK_PS"

echo ""
echo "--- dry-run: log shows DRY-RUN, no REAP pid= line ---"
output="$(REAP_DRY_RUN=1 REAP_AGE_SEC=300 REAP_LOG="$TMP_DRYRUN_LOG" \
  PATH="$MOCK_DIR:$PATH" bash "$REAPER" 2>&1)" || true
combined="$output$(<"$TMP_DRYRUN_LOG" 2>/dev/null)"
assert_contains "dry-run log contains DRY-RUN marker" "DRY-RUN" "$combined"
assert_not_contains "dry-run log has no REAP pid= line" "REAP pid=" "$combined"
rm -f "$TMP_DRYRUN_LOG"
rm -rf "$MOCK_DIR"

# ── Integration / live test ──────────────────────────────────────────────────
echo ""
echo "=== Integration test: live orphan detection ==="

# Use a fake "opencode" binary so ps -eo args= shows "...opencode models"
FAKE_OC_BIN="$(mktemp -d)/opencode"
cat > "$FAKE_OC_BIN" <<'FAKEEOF'
#!/usr/bin/env bash
# Fake opencode — just sleeps so the live test can observe and reap it
sleep 300
FAKEEOF
chmod +x "$FAKE_OC_BIN"

TMP_LIVE_LOG="$(mktemp)"
REAP_AGE_SEC_FOR_LIVE=2

# Spawn a parent subshell that owns the fake opencode models process
(
  "$FAKE_OC_BIN" models &
  CHILD_PID=$!
  echo "$CHILD_PID" > /tmp/live_test_child.pid
  sleep 60  # parent stays alive until killed
) &
FAKE_PARENT_PID=$!

sleep 0.5
CHILD_PID="$(cat /tmp/live_test_child.pid 2>/dev/null || echo "")"

if [[ -z "$CHILD_PID" ]] || ! kill -0 "$CHILD_PID" 2>/dev/null; then
  echo "  SKIP: live test — could not spawn fake child"
else
  CHILD_PPID="$(ps -p "$CHILD_PID" -o ppid= 2>/dev/null | tr -d ' ')" || CHILD_PPID=""

  if [[ "$CHILD_PPID" == "$FAKE_PARENT_PID" ]]; then
    echo "  INFO: child $CHILD_PID alive under parent $FAKE_PARENT_PID"

    # Spawn a live-parented fake that must NOT be reaped (parent = current shell $$)
    "$FAKE_OC_BIN" run &
    LIVE_CHILD_PID=$!
    sleep 0.2

    # Orphan the first child by killing its parent
    kill -TERM "$FAKE_PARENT_PID" 2>/dev/null || true
    wait "$FAKE_PARENT_PID" 2>/dev/null || true
    sleep 1  # let reparenting to PID 1 settle

    # Wait until child is old enough for the short threshold
    sleep "$REAP_AGE_SEC_FOR_LIVE"

    REAP_AGE_SEC="$REAP_AGE_SEC_FOR_LIVE" REAP_LOG="$TMP_LIVE_LOG" REAP_DRY_RUN=0 \
      bash "$REAPER" || true
    sleep 1

    if kill -0 "$CHILD_PID" 2>/dev/null; then
      assert_eq "orphaned child was reaped" "reaped" "still_alive"
    else
      assert_eq "orphaned child was reaped" "reaped" "reaped"
    fi

    if kill -0 "$LIVE_CHILD_PID" 2>/dev/null; then
      assert_eq "live-parented child survived" "alive" "alive"
    else
      assert_eq "live-parented child survived" "alive" "reaped"
    fi

    kill -TERM "$LIVE_CHILD_PID" 2>/dev/null || true
    kill -TERM "$CHILD_PID" 2>/dev/null || true
    wait "$LIVE_CHILD_PID" 2>/dev/null || true
  else
    echo "  SKIP: live test — PPID mismatch ($CHILD_PPID vs $FAKE_PARENT_PID)"
  fi
fi

kill -TERM "$FAKE_PARENT_PID" 2>/dev/null || true
wait "$FAKE_PARENT_PID" 2>/dev/null || true
rm -f /tmp/live_test_child.pid "$TMP_LIVE_LOG"
rm -rf "$(dirname "$FAKE_OC_BIN")"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [[ "$FAIL" -gt 0 ]]; then
  echo "Failed tests:"
  for e in "${ERRORS[@]}"; do echo "  - $e"; done
  exit 1
fi
exit 0
