#!/usr/bin/env python3
"""Validate the complete execution path, not just its final file mode."""

from pathlib import Path
import stat
import sys


def root_owned_chain(path):
    candidate = Path(path)
    if not candidate.is_absolute():
        raise ValueError("expected absolute path")
    paths = [candidate, candidate.resolve(strict=True)]
    for full in paths:
        for part in (Path("/"), *reversed(full.parents[:-1]), full):
            info = part.lstat()
            if info.st_uid != 0:
                raise ValueError(f"non-root owner: {part}")
            if not stat.S_ISLNK(info.st_mode) and info.st_mode & 0o022:
                raise ValueError(f"agent-writable path: {part}")
    return True


def private_source(path, service_uid):
    candidate = Path(path)
    info = candidate.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise ValueError("credential must be a regular file")
    if info.st_uid != service_uid or info.st_mode & 0o077:
        raise ValueError("credential owner or mode is unsafe")
    parent = candidate.parent
    while parent != Path("/"):
        info = parent.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_mode & 0o022:
            raise ValueError(f"credential parent is writable: {parent}")
        if info.st_uid not in (0, service_uid):
            raise ValueError(f"credential parent has unexpected owner: {parent}")
        if info.st_uid == service_uid and info.st_mode & 0o007:
            raise ValueError(f"credential parent is traversable by others: {parent}")
        parent = parent.parent
    return True


def main(paths):
    for path in paths:
        root_owned_chain(path)
    print(f"root-owned path chains: {len(paths)} PASS")


if __name__ == "__main__":
    main(sys.argv[1:])
