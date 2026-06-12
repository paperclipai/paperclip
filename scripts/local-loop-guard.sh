#!/usr/bin/env bash
# local-loop-guard.sh — Single-runner guard for local loop/daemon scripts.
# SAG-3582 — enforces LES §4 prohibition #1: no unbounded background loop
# daemon on the local box.  Pattern mirrors the safe-write skill (SAG-1459).
#
# USAGE — source mode (holds the lock for the lifetime of the calling script):
#   . "$(dirname "$0")/../scripts/local-loop-guard.sh"
#
# USAGE — exec-wrapper mode (holds the lock while CMD runs, then exits):
#   scripts/local-loop-guard.sh CMD [ARGS...]
#
# The guard acquires an exclusive non-blocking flock on the well-known pidfile
# ~/.paperclip/run/local-loop.lock.  If the lock is already held, it exits
# non-zero and prints the holding PID to stderr.  The lock is released on
# normal exit and on EXIT/INT/TERM so a crash cannot strand it.
#
# Requires: bash 4.1+, flock(1) (util-linux).

_LLG_LOCK_DIR="${HOME}/.paperclip/run"
_LLG_LOCK_FILE="${_LLG_LOCK_DIR}/local-loop.lock"

mkdir -p "${_LLG_LOCK_DIR}" || {
    printf 'local-loop-guard: ERROR — cannot create lock dir %s\n' \
        "${_LLG_LOCK_DIR}" >&2
    exit 1
}

# Open the lock file for append (creates it if absent) and get an
# auto-assigned file descriptor (bash 4.1+ {var}>>file syntax).
exec {_LLG_FD}>>"${_LLG_LOCK_FILE}" || {
    printf 'local-loop-guard: ERROR — cannot open lock file %s\n' \
        "${_LLG_LOCK_FILE}" >&2
    exit 1
}

# Try a non-blocking exclusive flock.  On failure, read the holding PID from
# the lock file, close our fd, and exit non-zero with a clear message.
if ! flock -n "${_LLG_FD}"; then
    _llg_holder_pid="$(cat "${_LLG_LOCK_FILE}" 2>/dev/null || echo "unknown")"
    # Print the rejection message BEFORE closing the fd.  "exec N>&- 2>/dev/null"
    # would permanently redirect this shell's stderr to /dev/null; avoid that.
    printf 'local-loop-guard: REFUSED — local loop daemon already running (PID %s). Only one instance may run at a time.\n' \
        "${_llg_holder_pid}" >&2
    exec {_LLG_FD}>&- || true
    exit 1
fi

# We hold the lock.  Overwrite the file with our PID so the next contender can
# name us in its rejection message.
printf '%s\n' "$$" > "${_LLG_LOCK_FILE}"

# Release the lock and close the fd on any exit, including signals.
_llg_cleanup() {
    flock -u "${_LLG_FD}" 2>/dev/null || true
    exec {_LLG_FD}>&- || true
}
trap '_llg_cleanup' EXIT INT TERM

# Exec-wrapper mode: if arguments are given, replace this process with CMD.
# The fd is inherited across exec so the flock remains held until CMD exits.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]] && [[ $# -gt 0 ]]; then
    exec "$@"
fi
