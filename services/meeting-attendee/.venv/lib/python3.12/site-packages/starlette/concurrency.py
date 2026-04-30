from __future__ import annotations

import functools
import warnings
from collections.abc import AsyncIterator, Callable, Coroutine, Iterable, Iterator
from typing import ParamSpec, TypeVar

import anyio.to_thread

P = ParamSpec("P")
T = TypeVar("T")


async def run_until_first_complete(*args: tuple[Callable, dict]) -> None:  # type: ignore[type-arg]
    warnings.warn(
        "run_until_first_complete is deprecated and will be removed in a future version.",
        DeprecationWarning,
    )

    async with anyio.create_task_group() as task_group:

        async def run(func: Callable[[], Coroutine]) -> None:  # type: ignore[type-arg]
            await func()
            task_group.cancel_scope.cancel()

        for func, kwargs in args:
            task_group.start_soon(run, functools.partial(func, **kwargs))


async def run_in_threadpool(func: Callable[P, T], *args: P.args, **kwargs: P.kwargs) -> T:
    func = functools.partial(func, *args, **kwargs)
    return await anyio.to_thread.run_sync(func)


class _StopIteration(Exception):
    pass


def _next(iterator: Iterator[T]) -> T:
    # We can't raise `StopIteration` from within the threadpool iterator
    # and catch it outside that context, so we coerce them into a different
    # exception type.
    try:
        return next(iterator)
    except StopIteration:
        raise _StopIteration


async def iterate_in_threadpool(
    iterator: Iterable[T],
) -> AsyncIterator[T]:
    as_iterator = iter(iterator)
    while True:
        try:
            yield await anyio.to_thread.run_sync(_next, as_iterator)
        except _StopIteration:
            break
