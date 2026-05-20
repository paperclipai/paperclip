#!/usr/bin/env python3
import subprocess
import sys
import os
import shutil


def resolve_hermes_path() -> str:
    configured = os.environ.get("HERMES_WSL_PATH")
    if configured:
        return configured

    found = shutil.which("hermes")
    if found:
        return found

    home_fallback = os.path.expanduser("~/.local/bin/hermes")
    if os.path.exists(home_fallback):
        return home_fallback

    return "hermes"


def main() -> int:
    if len(sys.argv) < 2:
        print("paperclip hermes bridge: missing query file", file=sys.stderr)
        return 2

    query_file = sys.argv[1]
    with open(query_file, "r", encoding="utf-8") as handle:
        query = handle.read()

    command = [resolve_hermes_path(), "chat", "-q", query]
    command.extend(sys.argv[2:])
    return subprocess.run(command).returncode


if __name__ == "__main__":
    raise SystemExit(main())
