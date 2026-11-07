#!/bin/sh
# Assert that PID 1 in this container reaps orphans the kernel re-parents onto it.
#
# Regression test for the zombie-exhaustion outage: with node as PID 1 and no
# init, orphaned descendants of agent runs (git, claude, esbuild, sh, ...) are
# never wait()ed, so they pin as zombies at ~79/h until the cgroup pid limit is
# exhausted and *every* fork() in the container fails.
#
# Designed to run inside the image under its real ENTRYPOINT, so PID 1 is
# exactly what a production container gets:
#
#   docker run --rm -i <image> sh -s < scripts/assert-orphan-reaping.sh
#
# Exits 0 when the orphan is reaped, non-zero (with the observed state) when it
# is left in Z.
set -e

init_comm="$(cat /proc/1/comm)"
echo "PID 1 = $init_comm"
if [ "$init_comm" != "tini" ]; then
    echo "FAIL: PID 1 is '$init_comm', expected an init (tini)" >&2
    exit 1
fi

pidfile="$(mktemp)"
trap 'rm -f "$pidfile"' EXIT

# Read a field of /proc/<pid>/stat past the comm field, so a command name
# containing spaces or parens cannot shift the offset. Field 1 of the remainder
# is the state, field 2 is the ppid. Empty output means the pid is gone.
stat_field() {
    sed -e 's/^.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f"$2"
}

# The leader exits immediately, orphaning the grandchild onto PID 1. The
# grandchild publishes its own pid, then exits ~5s later. That lifetime is what
# keeps the adoption check below honest: it must always land on a live process,
# never on a corpse whose exit merely happened to outrun a slow leader.
sh -c 'sh -c '\''echo $$ > "$0"; exec sleep 5'\'' "$1" & exit 0' _ "$pidfile"

i=0
while [ ! -s "$pidfile" ]; do
    i=$((i + 1))
    if [ "$i" -gt 100 ]; then
        echo "FAIL: grandchild never reported its pid" >&2
        exit 1
    fi
    sleep 0.05
done
gpid="$(cat "$pidfile")"

# The kernel re-parents the grandchild only once the leader has finished
# exiting, and that can lag the grandchild's pid-file write. Sampling the ppid
# once would read a leader that is merely slow to exit as a re-parenting
# failure, so poll instead: the leader exits unconditionally, so ppid 1 is
# reached in bounded time whenever adoption works at all.
i=0
while :; do
    ppid="$(stat_field "$gpid" 2)"
    if [ "$ppid" = "1" ]; then
        break
    fi
    if [ -z "$ppid" ]; then
        echo "FAIL: grandchild pid $gpid vanished before adoption could be observed; the probe proved nothing" >&2
        exit 1
    fi
    i=$((i + 1))
    if [ "$i" -gt 20 ]; then
        echo "FAIL: grandchild still parented to $ppid after 20 polls, never adopted by PID 1; the probe proved nothing" >&2
        exit 1
    fi
    sleep 0.05
done
echo "orphaned grandchild pid=$gpid reparented to ppid=$ppid"

# Give an unreaped zombie a generous window to show itself before calling the
# reap successful -- a pass here must mean "reaped", never "checked too early".
i=0
while [ "$i" -lt 100 ]; do
    if [ ! -e "/proc/$gpid" ]; then
        echo "PASS: PID 1 reaped orphaned pid $gpid"
        exit 0
    fi
    i=$((i + 1))
    sleep 0.1
done

state="$(stat_field "$gpid" 1)"
echo "FAIL: pid $gpid still present after 100 polls (state=$state); PID 1 ('$init_comm') is not reaping adopted orphans" >&2
exit 1
