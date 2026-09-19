#!/usr/bin/env python3
"""Argv-free Paperclip API client.

WHY THIS EXISTS
---------------
On Linux a process's arguments are world-readable: ``/proc/<pid>/cmdline`` is
mode 0444 and ``ps -ww -eo args`` shows it to every account on the box. So::

    curl -H "Authorization: Bearer $PAPERCLIP_API_KEY" ...

publishes this run's credential to every other process on the host for the
lifetime of the call, and drops it into any ``ps`` output, crash dump or
monitoring snapshot taken during that window. A run JWT is a bearer credential
with no revocation path, so a neighbour that copies one can act as this agent
until the token expires.

This client reads the credential from the environment straight into memory. Its
own argv is just ``[python3, paperclip-api.py, METHOD, PATH]``.

USAGE
-----
    python3 paperclip-api.py GET   /api/agents/me
    python3 paperclip-api.py POST  /api/issues/$PAPERCLIP_TASK_ID/comments @body.json
    python3 paperclip-api.py PATCH /api/issues/$PAPERCLIP_TASK_ID '{"status":"done"}'

Prints the HTTP status on the first line and the response body after it.

Retry policy: GET/HEAD may be retried freely. A mutation that fails with a
transport error may already be queued server side -- retrying it creates
duplicates, so surface the failure instead.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_TIMEOUT = 90


def api_base(env=None) -> str:
    env = env or os.environ
    base = env["PAPERCLIP_API_URL"].rstrip("/")
    return base[:-4] if base.endswith("/api") else base


def call(method: str, path: str, body=None, timeout: int = DEFAULT_TIMEOUT):
    """Return (status, text). The credential never leaves this process's memory."""
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": "Bearer " + os.environ["PAPERCLIP_API_KEY"]}
    run_id = os.environ.get("PAPERCLIP_RUN_ID")
    if run_id:
        # Required on every mutating request so the action is attributable to
        # this heartbeat run.
        headers["X-Paperclip-Run-Id"] = run_id
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(api_base() + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode()


def main(argv) -> int:
    if len(argv) < 3:
        print(__doc__)
        return 2
    method, path = argv[1].upper(), argv[2]
    body = None
    if len(argv) > 3:
        raw = argv[3]
        body = json.loads(open(raw[1:]).read() if raw.startswith("@") else raw)
    status, text = call(method, path, body)
    print(status)
    print(text)
    return 0 if 200 <= status < 300 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
