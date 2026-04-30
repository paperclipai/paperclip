from __future__ import annotations

import math
import sys
import threading
from collections.abc import Awaitable, Callable, Generator
from contextlib import contextmanager
from contextvars import Token
from importlib import import_module
from typing import TYPE_CHECKING, Any, TypeVar

from ._exceptions import NoEventLoopError

if sys.version_info >= (3, 11):
    from typing import TypeVarTuple, Unpack
else:
    from typing_extensions import TypeVarTuple, Unpack

sniffio: Any
try:
    import sniffio
except ModuleNotFoundError:
    sniffio = None

if TYPE_CHECKING:
    from ..abc import AsyncBackend

# This must be updated when new backends are introduced
BACKENDS = "asyncio", "trio"

T_Retval = TypeVar("T_Retval")
PosArgsT = TypeVarTuple("PosArgsT")

threadlocals = threading.local()
loaded_backends: dict[str, type[AsyncBackend]] = {}


def run(
    func: Callable[[Unpack[PosArgsT]], Awaitable[T_Retval]],
    *args: Unpack[PosArgsT],
    backend: str = "asyncio",
    backend_options: dict[str, Any] | None = None,
) -> T_Retval:
    """
    Run the given coroutine function in an asynchronous event loop.

    The current thread must not be already running an event loop.

    :param func: a coroutine function
    :param args: positional arguments to ``func``
    :param backend: name of the asynchronous event loop implementation – currently
        either ``asyncio`` or ``trio``
    :param backend_options: keyword arguments to call the backend ``run()``
        implementation with (documented :ref:`here <backend options>`)
    :return: the return value of the coroutine function
    :raises RuntimeError: if an asynchronous event loop is already running in this
        thread
    :raises LookupError: if the named backend is not found

    """
    if asynclib_name := current_async_library():
        raise RuntimeError(f"Already running {asynclib_name} in this thread")

    try:
        async_backend = get_async_backend(backend)
    except ImportError as exc:
        raise LookupError(f"No such backend: {backend}") from exc

    token = None
    if asynclib_name is None:
        # Since we're in control of the event loop, we can cache the name of the async
        # library
        token = set_current_async_library(backend)

    try:
        backend_options = backend_options or {}
        return async_backend.run(func, args, {}, backend_options)
    finally:
        reset_current_async_library(token)


async def sleep(delay: float) -> None:
    """
    Pause the current task for the specified duration.

    :param delay: the duration, in seconds

    """
    return await get_async_backend().sleep(delay)


async def sleep_forever() -> None:
    """
    Pause the current task until it's cancelled.

    This is a shortcut for ``sleep(math.inf)``.

    .. versionadded:: 3.1

    """
    await sleep(math.inf)


async def sleep_until(deadline: float) -> None:
    """
    Pause the current task until the given time.

    :param deadline: the absolute time to wake up at (according to the internal
        monotonic clock of the event loop)

    .. versionadded:: 3.1

    """
    now = current_time()
    await sleep(max(deadline - now, 0))


def current_time() -> float:
    """
    Return the current value of the event loop's internal clock.

    :return: the clock value (seconds)
    :raises NoEventLoopError: if no supported asynchronous event loop is running in the
        current thread

    """
    return get_async_backend().current_time()


def get_all_backends() -> tuple[str, ...]:
    """Return a tuple of the names of all built-in backends."""
    return BACKENDS


def get_available_backends() -> tuple[str, ...]:
    """
    Test for the availability of built-in backends.

    :return a tuple of the built-in backend names that were successfully imported

    .. versionadded:: 4.12

    """
    available_backends: list[str] = []
    for backend_name in get_all_backends():
        try:
            get_async_backend(backend_name)
        except ImportError:
            continue

        available_backends.append(backend_name)

    return tuple(available_backends)


def get_cancelled_exc_class() -> type[BaseException]:
    """
    Return the current async library's cancellation exception class.

    :raises NoEventLoopError: if no supported asynchronous event loop is running in the
        current thread

    """
    return get_async_backend().cancelled_exception_class()


#
# Private API
#


@contextmanager
def claim_worker_thread(
    backend_class: type[AsyncBackend], token: object
) -> Generator[Any, None, None]:
    from ..lowlevel import EventLoopToken

    threadlocals.current_token = EventLoopToken(backend_class, token)
    try:
        yield
    finally:
        del threadlocals.current_token


def get_async_backend(asynclib_name: str | None = None) -> type[AsyncBackend]:
    if asynclib_name is None:
        asynclib_name = current_async_library()
        if not asynclib_name:
            raise NoEventLoopError(
                f"Not currently running on any asynchronous event loop. "
                f"Available async backends: {', '.join(get_all_backends())}"
            )

    # We use our own dict instead of sys.modules to get the already imported back-end
    # class because the appropriate modules in sys.modules could potentially be only
    # partially initialized
    try:
        return loaded_backends[asynclib_name]
    except KeyError:
        module = import_module(f"anyio._backends._{asynclib_name}")
        loaded_backends[asynclib_name] = module.backend_class
        return module.backend_class


def current_async_library() -> str | None:
    if sniffio is None:
        # If sniffio is not installed, we assume we're either running asyncio or nothing
        import asyncio

        try:
            asyncio.get_running_loop()
            return "asyncio"
        except RuntimeError:
            pass
    else:
        try:
            return sniffio.current_async_library()
        except sniffio.AsyncLibraryNotFoundError:
            pass

    return None


def set_current_async_library(asynclib_name: str | None) -> Token | None:
    # no-op if sniffio is not installed
    if sniffio is None:
        return None

    return sniffio.current_async_library_cvar.set(asynclib_name)


def reset_current_async_library(token: Token | None) -> None:
    if token is not None:
        sniffio.current_async_library_cvar.reset(token)
