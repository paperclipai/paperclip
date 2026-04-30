from __future__ import annotations

import os
from pathlib import Path

import anyio

from .._types import FileTypes


def files_from_dir(directory: str | os.PathLike[str]) -> list[FileTypes]:
    path = Path(directory)

    files: list[FileTypes] = []
    _collect_files(path, path.parent, files)
    return files


def _collect_files(directory: Path, relative_to: Path, files: list[FileTypes]) -> None:
    for path in directory.iterdir():
        if path.is_dir():
            _collect_files(path, relative_to, files)
            continue

        files.append((path.relative_to(relative_to).as_posix(), path.read_bytes()))


async def async_files_from_dir(directory: str | os.PathLike[str]) -> list[FileTypes]:
    path = anyio.Path(directory)

    files: list[FileTypes] = []
    await _async_collect_files(path, path.parent, files)
    return files


async def _async_collect_files(directory: anyio.Path, relative_to: anyio.Path, files: list[FileTypes]) -> None:
    async for path in directory.iterdir():
        if await path.is_dir():
            await _async_collect_files(path, relative_to, files)
            continue

        files.append((path.relative_to(relative_to).as_posix(), await path.read_bytes()))
