#!/usr/bin/env python3
"""Validate MC inbound target before delegating to the shared dispatcher."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from projection import require_projection


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--payload")
    parser.add_argument("--dispatch-command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.preflight:
        return 0 if require_projection() else 1
    if not args.payload or not args.dispatch_command:
        parser.error("--payload and --dispatch-command are required")
    if not require_projection():
        return 1
    payload = json.loads(Path(args.payload).read_text())
    company = str(payload.get("company", "")).lower()
    if company not in {"kiss", "capital"}:
        print("unsupported MC inbound company; no routine assigned", file=sys.stderr)
        return 2
    return subprocess.run(args.dispatch_command, check=False).returncode


if __name__ == "__main__":
    sys.exit(main())
