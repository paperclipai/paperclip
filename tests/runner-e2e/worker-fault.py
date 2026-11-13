"""Linux-only E2E fault injection. pidfd pins the process across PID reuse."""
import json
import os
import signal
import sys

mode, raw_pid, run_id, *expected = sys.argv[1:]
pid = int(raw_pid)
if sys.platform != "linux" or not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
    raise RuntimeError("Worker-crash qualification requires Linux pidfd support")
if pid <= 1 or pid == os.getpid() or mode not in ("inspect", "kill"):
    raise RuntimeError("Invalid fault target")
fd = os.pidfd_open(pid)
try:
    # Open the process handle before reading /proc. If the numeric PID is reused
    # during these reads, fdinfo below no longer names it. Sending via the handle
    # can only target the original process, never its replacement.
    with open(f"/proc/{pid}/stat") as source:
        start_ticks = source.read().rsplit(")", 1)[1].split()[19]
    with open(f"/proc/{pid}/cmdline", "rb") as source:
        args = source.read().decode().rstrip("\0").split("\0")
    if not any(args[i:i + 2] == ["--run-id", run_id] for i in range(len(args) - 1)):
        raise RuntimeError("Worker run ID does not match")
    with open(f"/proc/self/fdinfo/{fd}") as source:
        fields = dict(line.split(":", 1) for line in source if ":" in line)
    if int(fields.get("Pid", "-1").strip()) != pid:
        raise RuntimeError("Worker exited during identity check")
    if mode == "kill":
        if expected != [start_ticks]:
            raise RuntimeError("Worker start identity changed")
        signal.pidfd_send_signal(fd, signal.SIGKILL, None, 0)
    print(json.dumps({"pid": pid, "startTicks": start_ticks, "runId": run_id, "signalled": mode == "kill"}))
finally:
    os.close(fd)
