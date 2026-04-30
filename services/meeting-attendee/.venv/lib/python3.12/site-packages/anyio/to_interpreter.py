from __future__ import annotations

__all__ = (
    "run_sync",
    "current_default_interpreter_limiter",
)

import atexit
import os
import sys
from collections import deque
from collections.abc import Callable
from typing import Any, Final, TypeVar

from . import current_time, to_thread
from ._core._exceptions import BrokenWorkerInterpreter
from ._core._synchronization import CapacityLimiter
from .lowlevel import RunVar

if sys.version_info >= (3, 11):
    from typing import TypeVarTuple, Unpack
else:
    from typing_extensions import TypeVarTuple, Unpack

if sys.version_info >= (3, 14):
    from concurrent.interpreters import ExecutionFailed, create

    def _interp_call(
        func: Callable[..., Any], args: tuple[Any, ...]
    ) -> tuple[Any, bool]:
        try:
            retval = func(*args)
        except BaseException as exc:
            return exc, True
        else:
            return retval, False

    class _Worker:
        last_used: float = 0

        def __init__(self) -> None:
            self._interpreter = create()

        def destroy(self) -> None:
            self._interpreter.close()

        def call(
            self,
            func: Callable[..., T_Retval],
            args: tuple[Any, ...],
        ) -> T_Retval:
            try:
                res, is_exception = self._interpreter.call(_interp_call, func, args)
            except ExecutionFailed as exc:
                raise BrokenWorkerInterpreter(exc.excinfo) from exc

            if is_exception:
                raise res

            return res
elif sys.version_info >= (3, 13):
    import _interpqueues
    import _interpreters

    UNBOUND: Final = 2  # I have no clue how this works, but it was used in the stdlib
    FMT_UNPICKLED: Final = 0
    FMT_PICKLED: Final = 1
    QUEUE_PICKLE_ARGS: Final = (FMT_PICKLED, UNBOUND)
    QUEUE_UNPICKLE_ARGS: Final = (FMT_UNPICKLED, UNBOUND)

    _run_func = compile(
        """
import _interpqueues
from _interpreters import NotShareableError
from pickle import loads, dumps, HIGHEST_PROTOCOL

QUEUE_PICKLE_ARGS = (1, 2)
QUEUE_UNPICKLE_ARGS = (0, 2)

item = _interpqueues.get(queue_id)[0]
try:
    func, args = loads(item)
    retval = func(*args)
except BaseException as exc:
    is_exception = True
    retval = exc
else:
    is_exception = False

try:
    _interpqueues.put(queue_id, (retval, is_exception), *QUEUE_UNPICKLE_ARGS)
except NotShareableError:
    retval = dumps(retval, HIGHEST_PROTOCOL)
    _interpqueues.put(queue_id, (retval, is_exception), *QUEUE_PICKLE_ARGS)
    """,
        "<string>",
        "exec",
    )

    class _Worker:
        last_used: float = 0

        def __init__(self) -> None:
            self._interpreter_id = _interpreters.create()
            self._queue_id = _interpqueues.create(1, *QUEUE_UNPICKLE_ARGS)
            _interpreters.set___main___attrs(
                self._interpreter_id, {"queue_id": self._queue_id}
            )

        def destroy(self) -> None:
            _interpqueues.destroy(self._queue_id)
            _interpreters.destroy(self._interpreter_id)

        def call(
            self,
            func: Callable[..., T_Retval],
            args: tuple[Any, ...],
        ) -> T_Retval:
            import pickle

            item = pickle.dumps((func, args), pickle.HIGHEST_PROTOCOL)
            _interpqueues.put(self._queue_id, item, *QUEUE_PICKLE_ARGS)
            exc_info = _interpreters.exec(self._interpreter_id, _run_func)
            if exc_info:
                raise BrokenWorkerInterpreter(exc_info)

            res = _interpqueues.get(self._queue_id)
            (res, is_exception), fmt = res[:2]
            if fmt == FMT_PICKLED:
                res = pickle.loads(res)

            if is_exception:
                raise res

            return res
else:

    class _Worker:
        last_used: float = 0

        def __init__(self) -> None:
            raise RuntimeError("subinterpreters require at least Python 3.13")

        def call(
            self,
            func: Callable[..., T_Retval],
            args: tuple[Any, ...],
        ) -> T_Retval:
            raise NotImplementedError

        def destroy(self) -> None:
            pass


DEFAULT_CPU_COUNT: Final = 8  # this is just an arbitrarily selected value
MAX_WORKER_IDLE_TIME = (
    30  # seconds a subinterpreter can be idle before becoming eligible for pruning
)

T_Retval = TypeVar("T_Retval")
PosArgsT = TypeVarTuple("PosArgsT")

_idle_workers = RunVar[deque[_Worker]]("_available_workers")
_default_interpreter_limiter = RunVar[CapacityLimiter]("_default_interpreter_limiter")


def _stop_workers(workers: deque[_Worker]) -> None:
    for worker in workers:
        worker.destroy()

    workers.clear()


async def run_sync(
    func: Callable[[Unpack[PosArgsT]], T_Retval],
    *args: Unpack[PosArgsT],
    limiter: CapacityLimiter | None = None,
) -> T_Retval:
    """
    Call the given function with the given arguments in a subinterpreter.

    .. warning:: On Python 3.13, the :mod:`concurrent.interpreters` module was not yet
        available, so the code path for that Python version relies on an undocumented,
        private API. As such, it is recommended to not rely on this function for anything
        mission-critical on Python 3.13.

    :param func: a callable
    :param args: the positional arguments for the callable
    :param limiter: capacity limiter to use to limit the total number of subinterpreters
        running (if omitted, the default limiter is used)
    :return: the result of the call
    :raises BrokenWorkerInterpreter: if there's an internal error in a subinterpreter

    """
    if limiter is None:
        limiter = current_default_interpreter_limiter()

    try:
        idle_workers = _idle_workers.get()
    except LookupError:
        idle_workers = deque()
        _idle_workers.set(idle_workers)
        atexit.register(_stop_workers, idle_workers)

    async with limiter:
        try:
            worker = idle_workers.pop()
        except IndexError:
            worker = _Worker()

    try:
        return await to_thread.run_sync(
            worker.call,
            func,
            args,
            limiter=limiter,
        )
    finally:
        # Prune workers that have been idle for too long
        now = current_time()
        while idle_workers:
            if now - idle_workers[0].last_used <= MAX_WORKER_IDLE_TIME:
                break

            await to_thread.run_sync(idle_workers.popleft().destroy, limiter=limiter)

        worker.last_used = current_time()
        idle_workers.append(worker)


def current_default_interpreter_limiter() -> CapacityLimiter:
    """
    Return the capacity limiter used by default to limit the number of concurrently
    running subinterpreters.

    Defaults to the number of CPU cores.

    :return: a capacity limiter object

    """
    try:
        return _default_interpreter_limiter.get()
    except LookupError:
        limiter = CapacityLimiter(os.cpu_count() or DEFAULT_CPU_COUNT)
        _default_interpreter_limiter.set(limiter)
        return limiter
