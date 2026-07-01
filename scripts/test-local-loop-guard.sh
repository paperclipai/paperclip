#!/usr/bin/env bash
# Test suite for scripts/local-loop-guard.sh
# SAG-3582: LES §4 prohibition #1 mechanical enforcement
#
# Scenarios:
#   T1  - solo invocation acquires lock and exits 0
#   T2  - concurrent second invocation exits non-zero
#   T2b - rejection message names the holding PID
#   T3  - lock released on normal exit (next acquire succeeds)
#   T4  - lock released after SIGTERM (next acquire succeeds)
#
# Usage: bash scripts/test-local-loop-guard.sh

set -u

GUARD="$(cd "$(dirname "$0")" && pwd)/local-loop-guard.sh"
LOCK_FILE="${HOME}/.paperclip/run/local-loop.lock"
PASS=0
FAIL=0

# Kill any background jobs we started, then clean the lock file.
cleanup_all() {
    local job_pids
    job_pids=$(jobs -p 2>/dev/null) || true
    if [[ -n "${job_pids}" ]]; then
        # shellcheck disable=SC2086
        kill ${job_pids} 2>/dev/null || true
        # shellcheck disable=SC2086
        wait ${job_pids} 2>/dev/null || true
    fi
    rm -f "${LOCK_FILE}"
}
trap cleanup_all EXIT INT TERM

pass() { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf 'FAIL: %s — %s\n' "$1" "$2" >&2; FAIL=$((FAIL + 1)); }

check_exit() {
    local desc="$1" expected="$2" actual="$3"
    if [[ "${actual}" -eq "${expected}" ]]; then
        pass "${desc}"
    else
        fail "${desc}" "expected exit ${expected}, got ${actual}"
    fi
}

# Guard the test against a missing guard file (the TDD red state).
if [[ ! -f "${GUARD}" ]]; then
    printf 'GUARD NOT FOUND: %s\n' "${GUARD}" >&2
    exit 1
fi

rm -f "${LOCK_FILE}"

# ── T1: solo invocation acquires the lock and exits 0 ────────────────────────
(
    # Source the guard inside a subshell; when the subshell exits the fd closes
    # and the flock is released automatically.
    # shellcheck disable=SC1090
    . "${GUARD}"
)
check_exit "T1 solo acquire exits 0" 0 $?
rm -f "${LOCK_FILE}"

# ── T2 / T2b: concurrent second invocation rejected; PID named ───────────────
# Start a holder in exec-wrapper mode (guard acquires lock, then execs sleep).
"${GUARD}" sleep 30 &
HOLDER_PID=$!
sleep 0.3  # give holder time to acquire and write its PID

T2_EXIT=0
T2_OUT=$("${GUARD}" sleep 0 2>&1) || T2_EXIT=$?

kill "${HOLDER_PID}" 2>/dev/null || true
wait "${HOLDER_PID}" 2>/dev/null || true

if [[ ${T2_EXIT} -ne 0 ]]; then
    pass "T2 concurrent second invocation rejected (exit ${T2_EXIT})"
else
    fail "T2 concurrent second invocation rejected" "expected non-zero exit, got 0"
fi

if echo "${T2_OUT}" | grep -q "${HOLDER_PID}"; then
    pass "T2b rejection message names holder PID (${HOLDER_PID})"
else
    fail "T2b rejection message names holder PID" \
        "output='${T2_OUT}' does not contain PID ${HOLDER_PID}"
fi
rm -f "${LOCK_FILE}"

# ── T3: lock released on normal exit ─────────────────────────────────────────
"${GUARD}" sleep 0        # acquire + immediate exit (normal)
sleep 0.1                 # let OS propagate fd close

T3_EXIT=0
"${GUARD}" sleep 0 || T3_EXIT=$?
check_exit "T3 lock released on normal exit" 0 "${T3_EXIT}"
rm -f "${LOCK_FILE}"

# ── T4: lock released after SIGTERM ──────────────────────────────────────────
"${GUARD}" sleep 30 &
HOLDER_PID=$!
sleep 0.3

kill -TERM "${HOLDER_PID}" 2>/dev/null || true
wait "${HOLDER_PID}" 2>/dev/null || true
sleep 0.3  # give trap / OS time to close fd

T4_EXIT=0
"${GUARD}" sleep 0 || T4_EXIT=$?
check_exit "T4 lock released after SIGTERM" 0 "${T4_EXIT}"
rm -f "${LOCK_FILE}"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
printf '%d passed, %d failed\n' "${PASS}" "${FAIL}"
[[ ${FAIL} -eq 0 ]]
