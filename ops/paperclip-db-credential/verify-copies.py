#!/usr/bin/env python3
"""Check named carriers and all regular worktree files without printing secrets."""

import argparse
import json
import os
import re
import stat
from pathlib import Path


INLINE_URL = re.compile(rb"postgres(?:ql)?://[^\s:'\"]+:[^\s@'\"]+@", re.I)


def candidates(carriers: list[Path], worktree_roots: list[Path]):
    for carrier in carriers:
        yield carrier, True
    for root in worktree_roots:
        if root.is_symlink() or not root.is_dir():
            yield root, False
            continue
        walk_errors = []
        for directory, dirs, files in os.walk(root, followlinks=False, onerror=walk_errors.append):
            # os.walk leaves symlinked directories in dirs without visiting them.
            # Report every one so an agent-readable copy cannot hide behind it.
            for name in dirs:
                if (Path(directory) / name).is_symlink():
                    yield Path(directory) / name, False
            for name in files:
                yield Path(directory) / name, False
        for error in walk_errors:
            yield Path(error.filename), False


def contains_old_url(path: Path, old_url: bytes) -> bool:
    overlap = b""
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            data = overlap + chunk
            if old_url in data:
                return True
            overlap = data[-(len(old_url) - 1):] if len(old_url) > 1 else b""
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--old-url-file", required=True, type=Path)
    parser.add_argument("--carrier", action="append", default=[], type=Path)
    parser.add_argument("--worktree-root", action="append", default=[], type=Path)
    args = parser.parse_args()
    old_url = args.old_url_file.read_bytes().strip()
    if not old_url:
        parser.error("old URL source is empty")
    paths = list(dict.fromkeys(candidates(args.carrier, args.worktree_root)))
    if not paths:
        parser.error("at least one carrier or worktree root is required")

    failures = 0
    checked = 0
    for root in args.worktree_root:
        if root.is_symlink() or not root.is_dir():
            print(f"INVALID_WORKTREE_ROOT {root}")
            failures += 1
    for path, is_carrier in paths:
        if path in args.worktree_root:
            continue
        try:
            info = path.lstat()
        except FileNotFoundError:
            print(f"MISSING {path}")
            failures += 1
            continue
        if stat.S_ISLNK(info.st_mode):
            print(f"SYMLINK {path}")
            failures += 1
            continue
        if not stat.S_ISREG(info.st_mode):
            print(f"NONFILE {path}")
            failures += 1
            continue
        try:
            has_old_url = contains_old_url(path, old_url)
            is_instance_config = path.name == "config.json" and path.parent.name == ".paperclip"
            data = path.read_bytes() if is_carrier or is_instance_config or path.name == ".env" else b""
        except OSError:
            print(f"UNREADABLE {path}")
            failures += 1
            continue
        checked += 1
        reasons = []
        if has_old_url:
            reasons.append("old-url-copy")
        if (is_carrier or is_instance_config or path.name == ".env") and INLINE_URL.search(data):
            reasons.append("inline-db-credential")
        if is_instance_config:
            try:
                config = json.loads(data)
                if config.get("database", {}).get("connectionString"):
                    reasons.append("config-connection-string")
            except (ValueError, TypeError, AttributeError):
                reasons.append("invalid-config-json")
        if path.name == ".env" and re.search(rb"^\s*DATABASE_(?:MIGRATION_)?URL\s*=", data, re.M):
            reasons.append("env-db-url")
        if reasons:
            print(f"FAIL {path} mode={stat.S_IMODE(info.st_mode):04o} uid={info.st_uid} reasons={','.join(reasons)}")
            failures += 1
    print(f"Copy scan: checked={checked} failures={failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
