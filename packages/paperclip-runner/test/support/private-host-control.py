"""Test-only unnamed fd4 handoff; stdout contains bounded control receipts only."""
import fcntl
import json
import os
import signal
import socket
import subprocess
import sys
import threading

LIMIT = 16 * 1024


def process_identity(pid):
    if sys.platform.startswith("linux"):
        with open(f"/proc/{pid}/stat") as state:
            fields = state.read(4096).rsplit(")", 1)[1].split()
        return f"{int(fields[2])}:{int(fields[19])}"
    if sys.platform == "darwin":
        import ctypes

        class BsdInfo(ctypes.Structure):
            _fields_ = [("prefix", ctypes.c_uint32 * 12),
                        ("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32),
                        ("suffix", ctypes.c_uint32 * 6),
                        ("seconds", ctypes.c_uint64), ("micros", ctypes.c_uint64)]

        info = BsdInfo()
        lib = ctypes.CDLL("/usr/lib/libproc.dylib")
        # PROC_PIDTBSDINFO includes PGID and microsecond process birth identity.
        if lib.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info)) != ctypes.sizeof(info) or info.prefix[3] != pid:
            raise OSError("process identity unavailable")
        return f"{info.suffix[1]}:{info.seconds}:{info.micros}"
    raise OSError("unsupported test host")


def cleanup():
    pid, group = int(sys.argv[2]), int(sys.argv[3])
    expected = sys.argv[4]
    if pid <= 1 or group <= 1 or not expected.startswith(f"{group}:") or process_identity(pid) != expected:
        raise OSError("process ownership changed")
    os.killpg(group, signal.SIGKILL)


def emit(value):
    sys.stdout.write(json.dumps(value) + "\n")
    sys.stdout.flush()


def main():
    left, right = socket.socketpair()
    # Duplicate above fd4 before closing originals: either original may be fd4.
    parent_fd = fcntl.fcntl(left.fileno(), fcntl.F_DUPFD_CLOEXEC, 5)
    child_fd = fcntl.fcntl(right.fileno(), fcntl.F_DUPFD_CLOEXEC, 5)
    left.close()
    right.close()
    parent = socket.socket(fileno=parent_fd)
    os.dup2(child_fd, 4, inheritable=True)
    os.close(child_fd)
    try:
        child = subprocess.Popen(
            sys.argv[1:] + ["--host-control-fd", "4"],
            pass_fds=(4,), stdin=subprocess.DEVNULL, stdout=sys.stderr, stderr=sys.stderr,
        )
    finally:
        os.close(4)
    def close_channel(*_):
        try:
            parent.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        parent.close()

    signal.signal(signal.SIGTERM, close_channel)
    output = threading.Lock()
    try:
        identity = process_identity(child.pid)
        if not identity.startswith(f"{os.getpgrp()}:"):
            raise OSError("unexpected native group")
    except Exception:
        close_channel()
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(os.getpgrp(), signal.SIGKILL)
        raise
    emit({"fixture": "started", "pid": child.pid, "identity": identity})

    def forward():
        try:
            parent.settimeout(10)
            reader = parent.makefile("rb")
            while True:
                frame = sys.stdin.buffer.readline(LIMIT + 1)
                if not frame:
                    break
                if len(frame) > LIMIT or not frame.endswith(b"\n"):
                    break
                with output:
                    parent.sendall(frame)
                    reply = reader.readline(LIMIT + 1)
                    if not reply or len(reply) > LIMIT or not reply.endswith(b"\n"):
                        break
                    sys.stdout.buffer.write(reply)
                    sys.stdout.buffer.flush()
        except (OSError, ValueError):
            pass
        finally:
            close_channel()

    threading.Thread(target=forward, daemon=True).start()
    # Never report completion based on the wrapper's own lifetime.
    code = child.wait()
    with output:
        emit({"fixture": "exited", "code": code if code >= 0 else None,
              "signal": signal.Signals(-code).name if code < 0 else None})


if __name__ == "__main__":
    try:
        if len(sys.argv) == 5 and sys.argv[1] == "--cleanup":
            cleanup()
        else:
            main()
    except Exception:
        # Do not reflect subprocess arguments, ticket frames, or provider output.
        sys.exit(1)
