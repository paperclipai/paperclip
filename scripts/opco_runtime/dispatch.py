#!/usr/bin/env python3
"""Dispatch a bounded OpCo routine only after served projection preflight."""

from __future__ import annotations

import argparse
import subprocess
import sys

from projection import require_projection


COMPANIES = {"kiss": "ThinkStack KISS", "capital": "ThinkStack Capital"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--company", choices=COMPANIES)
    parser.add_argument("--routine-command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.preflight:
        return 0 if require_projection() else 1
    if not args.company or not args.routine_command:
        parser.error("--company and --routine-command are required for dispatch")
    if not require_projection():
        return 1
    print(f"dispatching bounded routine for {COMPANIES[args.company]}")
    return subprocess.run(args.routine_command, check=False).returncode


if __name__ == "__main__":
    sys.exit(main())
