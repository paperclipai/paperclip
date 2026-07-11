#!/usr/bin/env bash
# 2-slot cargo build semaphore (AA-2014).
#
# Replaces the machine-wide `flock /tmp/cargo-global.lock` mutex, which bounded
# ALL Architect cargo at concurrency 1 regardless of per-worktree target dirs or
# maxConcurrentRuns. This bounds it at 2 instead: two concurrent Bevy debug
# builds fit the box (8 cores / 31 GB), a third waits.
#
# Correctness note: the slot lock must be held for the *entire* lifetime of the
# wrapped command. We hold it via a fixed numeric fd (9 or 8) opened with
# `exec N>`. Numeric fds are inherited by children and are NOT close-on-exec
# (unlike bash's auto-allocated {var} fds), so running the command as a child
# while the fd stays open in this shell keeps the flock held until the child
# exits. Do NOT rewrite this to `exec` into the command under an auto-fd — that
# would drop the lock at exec and reintroduce unbounded concurrency.
#
# Each slot pins a disjoint core set so two concurrent builds don't fight over
# the same cores (replaces the old single `taskset -c 0-5`). Override the lock
# directory with CARGO_SEM_DIR (tests use this).
#
# Usage: cargo-sem.sh <command> [args...]
set -u
D="${CARGO_SEM_DIR:-/tmp}"

run() { nice -n19 ionice -c3 taskset -c "$1" "${@:2}"; }

# slot 1 (cores 0-3), non-blocking
exec 9>"$D/cargo-slot-1.lock"
if flock -n 9; then run "0-3" "$@"; rc=$?; exec 9>&-; exit "$rc"; fi
exec 9>&-

# slot 2 (cores 4-7), non-blocking
exec 8>"$D/cargo-slot-2.lock"
if flock -n 8; then run "4-7" "$@"; rc=$?; exec 8>&-; exit "$rc"; fi
exec 8>&-

# both slots busy: block until slot 1 frees (caps live builds at 2)
exec 9>"$D/cargo-slot-1.lock"; flock 9; run "0-3" "$@"; exit "$?"
