from __future__ import annotations

import io
import os
import pathlib
from typing import Sequence, cast, overload
from typing_extensions import TypeVar, TypeGuard

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
from ._utils import is_list, is_mapping, is_tuple_t, is_mapping_t, is_sequence_t

_T = TypeVar("_T")


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
            f"{prefix} to be bytes, an io.IOBase instance, PathLike or a tuple but received {type(obj)} instead. See https://github.com/anthropics/anthropic-sdk-python/tree/main#file-uploads"
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


def deepcopy_with_paths(item: _T, paths: Sequence[Sequence[str]]) -> _T:
    """Copy only the containers along the given paths.

    Used to guard against mutation by extract_files without copying the entire structure.
    Only dicts and lists that lie on a path are copied; everything else
    is returned by reference.

    For example, given paths=[["foo", "files", "file"]] and the structure:
        {
            "foo": {
                "bar": {"baz": {}},
                "files": {"file": <content>}
            }
        }
    The root dict, "foo", and "files" are copied (they lie on the path).
    "bar" and "baz" are returned by reference (off the path).
    """
    return _deepcopy_with_paths(item, paths, 0)


def _deepcopy_with_paths(item: _T, paths: Sequence[Sequence[str]], index: int) -> _T:
    if not paths:
        return item
    if is_mapping(item):
        key_to_paths: dict[str, list[Sequence[str]]] = {}
        for path in paths:
            if index < len(path):
                key_to_paths.setdefault(path[index], []).append(path)

        # if no path continues through this mapping, it won't be mutated and copying it is redundant
        if not key_to_paths:
            return item

        result = dict(item)
        for key, subpaths in key_to_paths.items():
            if key in result:
                result[key] = _deepcopy_with_paths(result[key], subpaths, index + 1)
        return cast(_T, result)
    if is_list(item):
        array_paths = [path for path in paths if index < len(path) and path[index] == "<array>"]

        # if no path expects a list here, nothing will be mutated inside it - return by reference
        if not array_paths:
            return cast(_T, item)
        return cast(_T, [_deepcopy_with_paths(entry, array_paths, index + 1) for entry in item])
    return item
