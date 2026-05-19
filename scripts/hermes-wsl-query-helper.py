#!/usr/bin/env python3
import subprocess
import sys
import os


HERMES_PATH = os.environ.get("HERMES_WSL_PATH", "hermes")


def main() -> int:
    if len(sys.argv) < 2:
        print("paperclip hermes bridge: missing query file", file=sys.stderr)
        return 2

    query_file = sys.argv[1]
    with open(query_file, "r", encoding="utf-8") as handle:
        query = handle.read()

    command = [HERMES_PATH, "chat", "-q", query]
    command.extend(sys.argv[2:])
    return subprocess.run(command).returncode


if __name__ == "__main__":
    raise SystemExit(main())
