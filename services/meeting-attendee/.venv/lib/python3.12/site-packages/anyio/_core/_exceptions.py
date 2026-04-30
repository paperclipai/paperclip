from __future__ import annotations

import sys
from collections.abc import Generator
from textwrap import dedent
from typing import Any

if sys.version_info < (3, 11):
    from exceptiongroup import BaseExceptionGroup


class BrokenResourceError(Exception):
    """
    Raised when trying to use a resource that has been rendered unusable due to external
    causes (e.g. a send stream whose peer has disconnected).
    """


class BrokenWorkerProcess(Exception):
    """
    Raised by :meth:`~anyio.to_process.run_sync` if the worker process terminates abruptly or
    otherwise misbehaves.
    """


class BrokenWorkerInterpreter(Exception):
    """
    Raised by :meth:`~anyio.to_interpreter.run_sync` if an unexpected exception is
    raised in the subinterpreter.
    """

    def __init__(self, excinfo: Any):
        # This was adapted from concurrent.futures.interpreter.ExecutionFailed
        msg = excinfo.formatted
        if not msg:
            if excinfo.type and excinfo.msg:
                msg = f"{excinfo.type.__name__}: {excinfo.msg}"
            else:
                msg = excinfo.type.__name__ or excinfo.msg

        super().__init__(msg)
        self.excinfo = excinfo

    def __str__(self) -> str:
        try:
            formatted = self.excinfo.errdisplay
        except Exception:
            return super().__str__()
        else:
            return dedent(
                f"""
                {super().__str__()}

                Uncaught in the interpreter:

                {formatted}
                """.strip()
            )


class BusyResourceError(Exception):
    """
    Raised when two tasks are trying to read from or write to the same resource
    concurrently.
    """

    def __init__(self, action: str):
        super().__init__(f"Another task is already {action} this resource")


class ClosedResourceError(Exception):
    """Raised when trying to use a resource that has been closed."""


class ConnectionFailed(OSError):
    """
    Raised when a connection attempt fails.

    .. note:: This class inherits from :exc:`OSError` for backwards compatibility.
    """


def iterate_exceptions(
    exception: BaseException,
) -> Generator[BaseException, None, None]:
    if isinstance(exception, BaseExceptionGroup):
        for exc in exception.exceptions:
            yield from iterate_exceptions(exc)
    else:
        yield exception


class DelimiterNotFound(Exception):
    """
    Raised during
    :meth:`~anyio.streams.buffered.BufferedByteReceiveStream.receive_until` if the
    maximum number of bytes has been read without the delimiter being found.
    """

    def __init__(self, max_bytes: int) -> None:
        super().__init__(
            f"The delimiter was not found among the first {max_bytes} bytes"
        )


class EndOfStream(Exception):
    """
    Raised when trying to read from a stream that has been closed from the other end.
    """


class IncompleteRead(Exception):
    """
    Raised during
    :meth:`~anyio.streams.buffered.BufferedByteReceiveStream.receive_exactly` or
    :meth:`~anyio.streams.buffered.BufferedByteReceiveStream.receive_until` if the
    connection is closed before the requested amount of bytes has been read.
    """

    def __init__(self) -> None:
        super().__init__(
            "The stream was closed before the read operation could be completed"
        )


class TypedAttributeLookupError(LookupError):
    """
    Raised by :meth:`~anyio.TypedAttributeProvider.extra` when the given typed attribute
    is not found and no default value has been given.
    """


class WouldBlock(Exception):
    """Raised by ``X_nowait`` functions if ``X()`` would block."""


class NoEventLoopError(RuntimeError):
    """
    Raised by several functions that require an event loop to be running in the current
    thread when there is no running event loop.

    This is also raised by :func:`.from_thread.run` and :func:`.from_thread.run_sync`
    if not calling from an AnyIO worker thread, and no ``token`` was passed.
    """


class RunFinishedError(RuntimeError):
    """
    Raised by :func:`.from_thread.run` and :func:`.from_thread.run_sync` if the event
    loop associated with the explicitly passed token has already finished.
    """

    def __init__(self) -> None:
        super().__init__(
            "The event loop associated with the given token has already finished"
        )
