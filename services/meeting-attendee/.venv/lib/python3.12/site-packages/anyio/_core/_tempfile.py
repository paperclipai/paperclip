from __future__ import annotations

import os
import sys
import tempfile
from collections.abc import Iterable
from io import BytesIO, TextIOWrapper
from types import TracebackType
from typing import (
    TYPE_CHECKING,
    Any,
    AnyStr,
    Generic,
    overload,
)

from .. import to_thread
from .._core._fileio import AsyncFile
from ..lowlevel import checkpoint_if_cancelled

if TYPE_CHECKING:
    from _typeshed import OpenBinaryMode, OpenTextMode, ReadableBuffer, WriteableBuffer


class TemporaryFile(Generic[AnyStr]):
    """
    An asynchronous temporary file that is automatically created and cleaned up.

    This class provides an asynchronous context manager interface to a temporary file.
    The file is created using Python's standard `tempfile.TemporaryFile` function in a
    background thread, and is wrapped as an asynchronous file using `AsyncFile`.

    :param mode: The mode in which the file is opened. Defaults to "w+b".
    :param buffering: The buffering policy (-1 means the default buffering).
    :param encoding: The encoding used to decode or encode the file. Only applicable in
        text mode.
    :param newline: Controls how universal newlines mode works (only applicable in text
        mode).
    :param suffix: The suffix for the temporary file name.
    :param prefix: The prefix for the temporary file name.
    :param dir: The directory in which the temporary file is created.
    :param errors: The error handling scheme used for encoding/decoding errors.
    """

    _async_file: AsyncFile[AnyStr]

    @overload
    def __init__(
        self: TemporaryFile[bytes],
        mode: OpenBinaryMode = ...,
        buffering: int = ...,
        encoding: str | None = ...,
        newline: str | None = ...,
        suffix: str | None = ...,
        prefix: str | None = ...,
        dir: str | None = ...,
        *,
        errors: str | None = ...,
    ): ...
    @overload
    def __init__(
        self: TemporaryFile[str],
        mode: OpenTextMode,
        buffering: int = ...,
        encoding: str | None = ...,
        newline: str | None = ...,
        suffix: str | None = ...,
        prefix: str | None = ...,
        dir: str | None = ...,
        *,
        errors: str | None = ...,
    ): ...

    def __init__(
        self,
        mode: OpenTextMode | OpenBinaryMode = "w+b",
        buffering: int = -1,
        encoding: str | None = None,
        newline: str | None = None,
        suffix: str | None = None,
        prefix: str | None = None,
        dir: str | None = None,
        *,
        errors: str | None = None,
    ) -> None:
        self.mode = mode
        self.buffering = buffering
        self.encoding = encoding
        self.newline = newline
        self.suffix: str | None = suffix
        self.prefix: str | None = prefix
        self.dir: str | None = dir
        self.errors = errors

    async def __aenter__(self) -> AsyncFile[AnyStr]:
        fp = await to_thread.run_sync(
            lambda: tempfile.TemporaryFile(
                self.mode,
                self.buffering,
                self.encoding,
                self.newline,
                self.suffix,
                self.prefix,
                self.dir,
                errors=self.errors,
            )
        )
        self._async_file = AsyncFile(fp)
        return self._async_file

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        await self._async_file.aclose()


class NamedTemporaryFile(Generic[AnyStr]):
    """
    An asynchronous named temporary file that is automatically created and cleaned up.

    This class provides an asynchronous context manager for a temporary file with a
    visible name in the file system. It uses Python's standard
    :func:`~tempfile.NamedTemporaryFile` function and wraps the file object with
    :class:`AsyncFile` for asynchronous operations.

    :param mode: The mode in which the file is opened. Defaults to "w+b".
    :param buffering: The buffering policy (-1 means the default buffering).
    :param encoding: The encoding used to decode or encode the file. Only applicable in
        text mode.
    :param newline: Controls how universal newlines mode works (only applicable in text
        mode).
    :param suffix: The suffix for the temporary file name.
    :param prefix: The prefix for the temporary file name.
    :param dir: The directory in which the temporary file is created.
    :param delete: Whether to delete the file when it is closed.
    :param errors: The error handling scheme used for encoding/decoding errors.
    :param delete_on_close: (Python 3.12+) Whether to delete the file on close.
    """

    _async_file: AsyncFile[AnyStr]

    @overload
    def __init__(
        self: NamedTemporaryFile[bytes],
        mode: OpenBinaryMode = ...,
        buffering: int = ...,
        encoding: str | None = ...,
        newline: str | None = ...,
        suffix: str | None = ...,
        prefix: str | None = ...,
        dir: str | None = ...,
        delete: bool = ...,
        *,
        errors: str | None = ...,
        delete_on_close: bool = ...,
    ): ...
    @overload
    def __init__(
        self: NamedTemporaryFile[str],
        mode: OpenTextMode,
        buffering: int = ...,
        encoding: str | None = ...,
        newline: str | None = ...,
        suffix: str | None = ...,
        prefix: str | None = ...,
        dir: str | None = ...,
        delete: bool = ...,
        *,
        errors: str | None = ...,
        delete_on_close: bool = ...,
    ): ...

    def __init__(
        self,
        mode: OpenBinaryMode | OpenTextMode = "w+b",
        buffering: int = -1,
        encoding: str | None = None,
        newline: str | None = None,
        suffix: str | None = None,
        prefix: str | None = None,
        dir: str | None = None,
        delete: bool = True,
        *,
        errors: str | None = None,
        delete_on_close: bool = True,
    ) -> None:
        self._params: dict[str, Any] = {
            "mode": mode,
            "buffering": buffering,
            "encoding": encoding,
            "newline": newline,
            "suffix": suffix,
            "prefix": prefix,
            "dir": dir,
            "delete": delete,
            "errors": errors,
        }
        if sys.version_info >= (3, 12):
            self._params["delete_on_close"] = delete_on_close

    async def __aenter__(self) -> AsyncFile[AnyStr]:
        fp = await to_thread.run_sync(
            lambda: tempfile.NamedTemporaryFile(**self._params)
        )
        self._async_file = AsyncFile(fp)
        return self._async_file

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        await self._async_file.aclose()


class SpooledTemporaryFile(AsyncFile[AnyStr]):
    """
    An asynchronous spooled temporary file that starts in memory and is spooled to disk.

    This class provides an asynchronous interface to a spooled temporary file, much like
    Python's standard :class:`~tempfile.SpooledTemporaryFile`. It supports asynchronous
    write operations and provides a method to force a rollover to disk.

    :param max_size: Maximum size in bytes before the file is rolled over to disk.
    :param mode: The mode in which the file is opened. Defaults to "w+b".
    :param buffering: The buffering policy (-1 means the default buffering).
    :param encoding: The encoding used to decode or encode the file (text mode only).
    :param newline: Controls how universal newlines mode works (text mode only).
    :param suffix: The suffix for the temporary file name.
    :param prefix: The prefix for the temporary file name.
    :param dir: The directory in which the temporary file is created.
    :param errors: The error handling scheme used for encoding/decoding errors.
    """

    _rolled: bool = False

    @overload
    def __init__(
        self: SpooledTemporaryFile[bytes],
        max_size: int = ...,
        mode: OpenBinaryMode = ...,
        buffering: int = ...,
        encoding: str | None = ...,
        newline: str | None = ...,
        suffix: str | None = ...,
        prefix: str | None = ...,
        dir: str | None = ...,
        *,
        errors: str | None = ...,
    ): ...
    @overload
    def __init__(
        self: SpooledTemporaryFile[str],
        max_size: int = ...,
        mode: OpenTextMode = ...,
        buffering: int = ...,
        encoding: str | None = ...,
        newline: str | None = ...,
        suffix: str | None = ...,
        prefix: str | None = ...,
        dir: str | None = ...,
        *,
        errors: str | None = ...,
    ): ...

    def __init__(
        self,
        max_size: int = 0,
        mode: OpenBinaryMode | OpenTextMode = "w+b",
        buffering: int = -1,
        encoding: str | None = None,
        newline: str | None = None,
        suffix: str | None = None,
        prefix: str | None = None,
        dir: str | None = None,
        *,
        errors: str | None = None,
    ) -> None:
        self._tempfile_params: dict[str, Any] = {
            "mode": mode,
            "buffering": buffering,
            "encoding": encoding,
            "newline": newline,
            "suffix": suffix,
            "prefix": prefix,
            "dir": dir,
            "errors": errors,
        }
        self._max_size = max_size
        if "b" in mode:
            super().__init__(BytesIO())  # type: ignore[arg-type]
        else:
            super().__init__(
                TextIOWrapper(  # type: ignore[arg-type]
                    BytesIO(),
                    encoding=encoding,
                    errors=errors,
                    newline=newline,
                    write_through=True,
                )
            )

    async def aclose(self) -> None:
        if not self._rolled:
            self._fp.close()
            return

        await super().aclose()

    async def _check(self) -> None:
        if self._rolled or self._fp.tell() <= self._max_size:
            return

        await self.rollover()

    async def rollover(self) -> None:
        if self._rolled:
            return

        self._rolled = True
        buffer = self._fp
        buffer.seek(0)
        self._fp = await to_thread.run_sync(
            lambda: tempfile.TemporaryFile(**self._tempfile_params)
        )
        await self.write(buffer.read())
        buffer.close()

    @property
    def closed(self) -> bool:
        return self._fp.closed

    async def read(self, size: int = -1) -> AnyStr:
        if not self._rolled:
            await checkpoint_if_cancelled()
            return self._fp.read(size)

        return await super().read(size)  # type: ignore[return-value]

    async def read1(self: SpooledTemporaryFile[bytes], size: int = -1) -> bytes:
        if not self._rolled:
            await checkpoint_if_cancelled()
            return self._fp.read1(size)

        return await super().read1(size)

    async def readline(self) -> AnyStr:
        if not self._rolled:
            await checkpoint_if_cancelled()
            return self._fp.readline()

        return await super().readline()  # type: ignore[return-value]

    async def readlines(self) -> list[AnyStr]:
        if not self._rolled:
            await checkpoint_if_cancelled()
            return self._fp.readlines()

        return await super().readlines()  # type: ignore[return-value]

    async def readinto(self: SpooledTemporaryFile[bytes], b: WriteableBuffer) -> int:
        if not self._rolled:
            await checkpoint_if_cancelled()
            self._fp.readinto(b)

        return await super().readinto(b)

    async def readinto1(self: SpooledTemporaryFile[bytes], b: WriteableBuffer) -> int:
        if not self._rolled:
            await checkpoint_if_cancelled()
            self._fp.readinto(b)

        return await super().readinto1(b)

    async def seek(self, offset: int, whence: int | None = os.SEEK_SET) -> int:
        if not self._rolled:
            await checkpoint_if_cancelled()
            return self._fp.seek(offset, whence)

        return await super().seek(offset, whence)

    async def tell(self) -> int:
        if not self._rolled:
            await checkpoint_if_cancelled()
            return self._fp.tell()

        return await super().tell()

    async def truncate(self, size: int | None = None) -> int:
        if not self._rolled:
            await checkpoint_if_cancelled()
            return self._fp.truncate(size)

        return await super().truncate(size)

    @overload
    async def write(self: SpooledTemporaryFile[bytes], b: ReadableBuffer) -> int: ...
    @overload
    async def write(self: SpooledTemporaryFile[str], b: str) -> int: ...

    async def write(self, b: ReadableBuffer | str) -> int:
        """
        Asynchronously write data to the spooled temporary file.

        If the file has not yet been rolled over, the data is written synchronously,
        and a rollover is triggered if the size exceeds the maximum size.

        :param s: The data to write.
        :return: The number of bytes written.
        :raises RuntimeError: If the underlying file is not initialized.

        """
        if not self._rolled:
            await checkpoint_if_cancelled()
            result = self._fp.write(b)
            await self._check()
            return result

        return await super().write(b)  # type: ignore[misc]

    @overload
    async def writelines(
        self: SpooledTemporaryFile[bytes], lines: Iterable[ReadableBuffer]
    ) -> None: ...
    @overload
    async def writelines(
        self: SpooledTemporaryFile[str], lines: Iterable[str]
    ) -> None: ...

    async def writelines(self, lines: Iterable[str] | Iterable[ReadableBuffer]) -> None:
        """
        Asynchronously write a list of lines to the spooled temporary file.

        If the file has not yet been rolled over, the lines are written synchronously,
        and a rollover is triggered if the size exceeds the maximum size.

        :param lines: An iterable of lines to write.
        :raises RuntimeError: If the underlying file is not initialized.

        """
        if not self._rolled:
            await checkpoint_if_cancelled()
            result = self._fp.writelines(lines)
            await self._check()
            return result

        return await super().writelines(lines)  # type: ignore[misc]


class TemporaryDirectory(Generic[AnyStr]):
    """
    An asynchronous temporary directory that is created and cleaned up automatically.

    This class provides an asynchronous context manager for creating a temporary
    directory. It wraps Python's standard :class:`~tempfile.TemporaryDirectory` to
    perform directory creation and cleanup operations in a background thread.

    :param suffix: Suffix to be added to the temporary directory name.
    :param prefix: Prefix to be added to the temporary directory name.
    :param dir: The parent directory where the temporary directory is created.
    :param ignore_cleanup_errors: Whether to ignore errors during cleanup
    :param delete: Whether to delete the directory upon closing (Python 3.12+).
    """

    def __init__(
        self,
        suffix: AnyStr | None = None,
        prefix: AnyStr | None = None,
        dir: AnyStr | None = None,
        *,
        ignore_cleanup_errors: bool = False,
        delete: bool = True,
    ) -> None:
        self.suffix: AnyStr | None = suffix
        self.prefix: AnyStr | None = prefix
        self.dir: AnyStr | None = dir
        self.ignore_cleanup_errors = ignore_cleanup_errors
        self.delete = delete

        self._tempdir: tempfile.TemporaryDirectory | None = None

    async def __aenter__(self) -> str:
        params: dict[str, Any] = {
            "suffix": self.suffix,
            "prefix": self.prefix,
            "dir": self.dir,
            "ignore_cleanup_errors": self.ignore_cleanup_errors,
        }
        if sys.version_info >= (3, 12):
            params["delete"] = self.delete

        self._tempdir = await to_thread.run_sync(
            lambda: tempfile.TemporaryDirectory(**params)
        )
        return await to_thread.run_sync(self._tempdir.__enter__)

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        if self._tempdir is not None:
            await to_thread.run_sync(
                self._tempdir.__exit__, exc_type, exc_value, traceback
            )

    async def cleanup(self) -> None:
        if self._tempdir is not None:
            await to_thread.run_sync(self._tempdir.cleanup)


@overload
async def mkstemp(
    suffix: str | None = None,
    prefix: str | None = None,
    dir: str | None = None,
    text: bool = False,
) -> tuple[int, str]: ...


@overload
async def mkstemp(
    suffix: bytes | None = None,
    prefix: bytes | None = None,
    dir: bytes | None = None,
    text: bool = False,
) -> tuple[int, bytes]: ...


async def mkstemp(
    suffix: AnyStr | None = None,
    prefix: AnyStr | None = None,
    dir: AnyStr | None = None,
    text: bool = False,
) -> tuple[int, str | bytes]:
    """
    Asynchronously create a temporary file and return an OS-level handle and the file
    name.

    This function wraps `tempfile.mkstemp` and executes it in a background thread.

    :param suffix: Suffix to be added to the file name.
    :param prefix: Prefix to be added to the file name.
    :param dir: Directory in which the temporary file is created.
    :param text: Whether the file is opened in text mode.
    :return: A tuple containing the file descriptor and the file name.

    """
    return await to_thread.run_sync(tempfile.mkstemp, suffix, prefix, dir, text)


@overload
async def mkdtemp(
    suffix: str | None = None,
    prefix: str | None = None,
    dir: str | None = None,
) -> str: ...


@overload
async def mkdtemp(
    suffix: bytes | None = None,
    prefix: bytes | None = None,
    dir: bytes | None = None,
) -> bytes: ...


async def mkdtemp(
    suffix: AnyStr | None = None,
    prefix: AnyStr | None = None,
    dir: AnyStr | None = None,
) -> str | bytes:
    """
    Asynchronously create a temporary directory and return its path.

    This function wraps `tempfile.mkdtemp` and executes it in a background thread.

    :param suffix: Suffix to be added to the directory name.
    :param prefix: Prefix to be added to the directory name.
    :param dir: Parent directory where the temporary directory is created.
    :return: The path of the created temporary directory.

    """
    return await to_thread.run_sync(tempfile.mkdtemp, suffix, prefix, dir)


async def gettempdir() -> str:
    """
    Asynchronously return the name of the directory used for temporary files.

    This function wraps `tempfile.gettempdir` and executes it in a background thread.

    :return: The path of the temporary directory as a string.

    """
    return await to_thread.run_sync(tempfile.gettempdir)


async def gettempdirb() -> bytes:
    """
    Asynchronously return the name of the directory used for temporary files in bytes.

    This function wraps `tempfile.gettempdirb` and executes it in a background thread.

    :return: The path of the temporary directory as bytes.

    """
    return await to_thread.run_sync(tempfile.gettempdirb)
