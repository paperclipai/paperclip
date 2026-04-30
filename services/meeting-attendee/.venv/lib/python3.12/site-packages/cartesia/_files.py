from __future__ import annotations

import io
import os
import pathlib
from typing import overload
from typing_extensions import TypeGuard

import anyio

from ._types import (
    FileTypes,
    FileContent,
    RequestFiles,
    HttpxFileTypes,
    Base64FileInput,
    HttpxFileContent,
    HttpxRequestFiles,
)
from ._utils import is_tuple_t, is_mapping_t, is_sequence_t


def is_base64_file_input(obj: object) -> TypeGuard[Base64FileInput]:
    return isinstance(obj, io.IOBase) or isinstance(obj, os.PathLike)


def is_file_content(obj: object) -> TypeGuard[FileContent]:
    return (
        isinstance(obj, bytes) or isinstance(obj, tuple) or isinstance(obj, io.IOBase) or isinstance(obj, os.PathLike)
    )


def assert_is_file_content(obj: object, *, key: str | None = None) -> None:
    if not is_file_content(obj):
        prefix = f"Expected entry at `{key}`" if key is not None else f"Expected file input `{obj!r}`"
        raise RuntimeError(
            f"{prefix} to be bytes, an io.IOBase instance, PathLike or a tuple but received {type(obj)} instead. See https://github.com/cartesia-ai/cartesia-python/tree/main#file-uploads"
        ) from None


@overload
def to_httpx_files(files: None) -> None: ...


@overload
def to_httpx_files(files: RequestFiles) -> HttpxRequestFiles: ...


def to_httpx_files(files: RequestFiles | None) -> HttpxRequestFiles | None:
    if files is None:
        return None

    if is_mapping_t(files):
        files = {key: _transform_file(file) for key, file in files.items()}
    elif is_sequence_t(files):
        files = [(key, _transform_file(file)) for key, file in files]
    else:
        raise TypeError(f"Unexpected file type input {type(files)}, expected mapping or sequence")

    return files


def _transform_file(file: FileTypes) -> HttpxFileTypes:
    if is_file_content(file):
        if isinstance(file, os.PathLike):
            path = pathlib.Path(file)
            return (path.name, path.read_bytes())

        return file

    if is_tuple_t(file):
        return (file[0], read_file_content(file[1]), *file[2:])

    raise TypeError(f"Expected file types input to be a FileContent type or to be a tuple")


def read_file_content(file: FileContent) -> HttpxFileContent:
    if isinstance(file, os.PathLike):
        return pathlib.Path(file).read_bytes()
    return file


@overload
async def async_to_httpx_files(files: None) -> None: ...


@overload
async def async_to_httpx_files(files: RequestFiles) -> HttpxRequestFiles: ...


async def async_to_httpx_files(files: RequestFiles | None) -> HttpxRequestFiles | None:
    if files is None:
        return None

    if is_mapping_t(files):
        files = {key: await _async_transform_file(file) for key, file in files.items()}
    elif is_sequence_t(files):
        files = [(key, await _async_transform_file(file)) for key, file in files]
    else:
        raise TypeError("Unexpected file type input {type(files)}, expected mapping or sequence")

    return files


async def _async_transform_file(file: FileTypes) -> HttpxFileTypes:
    if is_file_content(file):
        if isinstance(file, os.PathLike):
            path = anyio.Path(file)
            return (path.name, await path.read_bytes())

        return file

    if is_tuple_t(file):
        return (file[0], await async_read_file_content(file[1]), *file[2:])

    raise TypeError(f"Expected file types input to be a FileContent type or to be a tuple")


async def async_read_file_content(file: FileContent) -> HttpxFileContent:
    if isinstance(file, os.PathLike):
        return await anyio.Path(file).read_bytes()

    return file
