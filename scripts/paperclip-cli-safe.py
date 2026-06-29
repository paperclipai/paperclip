#!/usr/bin/env python3

"""Safely materialize multiline text and JSON for paperclipai CLI calls."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path


USAGE = """Usage:
  scripts/paperclip-cli-safe.py [--dry-run] <paperclipai args...>

Supported file-backed flags:
  --comment-file <path|->
  --payload-file <path|->
  --body-file <path|->
"""


def fail(message: str) -> int:
    print(message, file=sys.stderr)
    return 1


def read_stdin_once(cache: dict[str, str | None]) -> str:
    if cache["value"] is None:
        cache["value"] = sys.stdin.read()
    return cache["value"] or ""


def materialize_tempfile(body: str, suffix: str) -> str:
    handle = tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", delete=False, suffix=suffix)
    try:
        handle.write(body)
    finally:
        handle.close()
    return handle.name


def cleanup_temp_paths(paths: list[str]) -> None:
    for path in paths:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass


def resolve_paperclip_command() -> list[str]:
    repo_path = os.environ.get("PAPERCLIP_REPO", "")
    env_file = Path(os.environ.get("PAPERCLIP_ENV_FILE", Path.home() / ".paperclip" / "paperclip-host.env"))

    if not repo_path and env_file.is_file():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            if line.startswith("PAPERCLIP_REPO="):
                repo_path = line.split("=", 1)[1]

    if repo_path:
        repo = Path(repo_path)
        tsx = repo / "cli" / "node_modules" / "tsx" / "dist" / "cli.mjs"
        entry = repo / "cli" / "src" / "index.ts"
        if tsx.is_file() and entry.is_file():
            return ["node", str(tsx), str(entry)]

    return ["paperclipai"]


def main(argv: list[str]) -> int:
    if not argv or argv in (["-h"], ["--help"]):
        print(USAGE)
        return 0

    dry_run = False
    if argv and argv[0] == "--dry-run":
        dry_run = True
        argv = argv[1:]

    if not argv:
        print(USAGE, file=sys.stderr)
        return 1

    stdin_cache: dict[str, str | None] = {"value": None}
    translated: list[str] = []
    temp_paths: list[str] = []
    i = 0

    while i < len(argv):
        arg = argv[i]
        if arg in {"--comment-file", "--payload-file", "--body-file"}:
            if i + 1 >= len(argv):
                cleanup_temp_paths(temp_paths)
                return fail(f"Missing value for {arg}.")
            value = argv[i + 1]
            if value == "-":
                suffix = ".json" if arg == "--payload-file" else ".md"
                temp_path = materialize_tempfile(read_stdin_once(stdin_cache), suffix)
                temp_paths.append(temp_path)
                translated.extend([arg, temp_path])
            else:
                translated.extend([arg, value])
            i += 2
            continue
        translated.append(arg)
        i += 1

    command = [*resolve_paperclip_command(), *translated]

    if dry_run:
        import json

        print(json.dumps({"command": command}, indent=2))
        cleanup_temp_paths(temp_paths)
        return 0

    try:
        completed = subprocess.run(command, check=False)
        return completed.returncode
    finally:
        cleanup_temp_paths(temp_paths)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
