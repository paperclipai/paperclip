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

# The leader exits immediately, orphaning the grandchild onto PID 1. The
# grandchild publishes its own pid, then exits ~1s later.
sh -c 'sh -c '\''echo $$ > "$0"; exec sleep 1'\'' "$1" & exit 0' _ "$pidfile"

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

ppid="$(awk '{print $4}' "/proc/$gpid/stat" 2>/dev/null || echo gone)"
echo "orphaned grandchild pid=$gpid reparented to ppid=$ppid"
if [ "$ppid" != "1" ]; then
    echo "FAIL: grandchild was not orphaned onto PID 1 (ppid=$ppid); the probe proved nothing" >&2
    exit 1
fi

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

# Field 3 of /proc/<pid>/stat, read past the comm field so a command name
# containing spaces or parens cannot shift the offset.
state="$(sed -e 's/^.*) //' -e 's/ .*//' "/proc/$gpid/stat" 2>/dev/null || echo gone)"
echo "FAIL: pid $gpid still present after 10s (state=$state); PID 1 ('$init_comm') is not reaping adopted orphans" >&2
exit 1
