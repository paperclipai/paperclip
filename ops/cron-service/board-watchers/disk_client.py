#!/usr/bin/env python3
"""Send one bounded disk signal through the root-owned reporter socket."""

import json
import os
import socket
import sys


def main():
    if len(sys.argv) != 2 or sys.argv[1] != "escalate":
        raise SystemExit("usage: disk_client.py escalate")
    request = json.dumps({"event": "critical"}).encode() + b"\n"
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(35)
        connection.connect(os.environ.get("DISK_REPORT_SOCKET", "/run/paperclip-cron/disk-report.sock"))
        connection.sendall(request)
        with connection.makefile("rb") as stream:
            result = stream.readline(257)
    if not json.loads(result).get("ok"):
        raise SystemExit("disk signal rejected")


if __name__ == "__main__":
    main()
