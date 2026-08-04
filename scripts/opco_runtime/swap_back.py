#!/usr/bin/env python3
"""Gate a bounded fallback swap-back command on the served projection."""

from __future__ import annotations

import argparse
import subprocess
import sys

from projection import require_projection


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--swap-command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.preflight:
        return 0 if require_projection() else 1
    if not args.swap_command:
        parser.error("--swap-command is required")
    if not require_projection():
        return 1
    return subprocess.run(args.swap_command, check=False).returncode


if __name__ == "__main__":
    sys.exit(main())
