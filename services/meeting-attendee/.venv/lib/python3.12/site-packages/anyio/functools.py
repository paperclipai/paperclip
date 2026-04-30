from __future__ import annotations

__all__ = (
    "AsyncCacheInfo",
    "AsyncCacheParameters",
    "AsyncLRUCacheWrapper",
    "cache",
    "lru_cache",
    "reduce",
)

import functools
import sys
from collections import OrderedDict
from collections.abc import (
    AsyncIterable,
    Awaitable,
    Callable,
    Coroutine,
    Hashable,
    Iterable,
)
from functools import update_wrapper
from inspect import iscoroutinefunction
from typing import (
    Any,
    Generic,
    NamedTuple,
    TypedDict,
    TypeVar,
    cast,
    final,
    overload,
)
from weakref import WeakKeyDictionary

from ._core._eventloop import current_time
from ._core._synchronization import Lock
from .lowlevel import RunVar, checkpoint

if sys.version_info >= (3, 11):
    from typing import ParamSpec
else:
    from typing_extensions import ParamSpec

T = TypeVar("T")
S = TypeVar("S")
P = ParamSpec("P")
lru_cache_items: RunVar[
    WeakKeyDictionary[
        AsyncLRUCacheWrapper[Any, Any],
        OrderedDict[
            Hashable,
            tuple[_InitialMissingType, Lock, float | None]
            | tuple[Any, None, float | None],
        ],
    ]
] = RunVar("lru_cache_items")


class _InitialMissingType:
    pass


initial_missing: _InitialMissingType = _InitialMissingType()


class AsyncCacheInfo(NamedTuple):
    hits: int
    misses: int
    maxsize: int | None
    currsize: int
    ttl: int | None


class AsyncCacheParameters(TypedDict):
    maxsize: int | None
    typed: bool
    always_checkpoint: bool
    ttl: int | None


class _LRUMethodWrapper(Generic[T]):
    def __init__(self, wrapper: AsyncLRUCacheWrapper[..., T], instance: object):
        self.__wrapper = wrapper
        self.__instance = instance

    def cache_info(self) -> AsyncCacheInfo:
        return self.__wrapper.cache_info()

    def cache_parameters(self) -> AsyncCacheParameters:
        return self.__wrapper.cache_parameters()

    def cache_clear(self) -> None:
        self.__wrapper.cache_clear()

    async def __call__(self, *args: Any, **kwargs: Any) -> T:
        if self.__instance is None:
            return await self.__wrapper(*args, **kwargs)

        return await self.__wrapper(self.__instance, *args, **kwargs)


@final
class AsyncLRUCacheWrapper(Generic[P, T]):
    def __init__(
        self,
        func: Callable[P, Awaitable[T]],
        maxsize: int | None,
        typed: bool,
        always_checkpoint: bool,
        ttl: int | None,
    ):
        self.__wrapped__ = func
        self._hits: int = 0
        self._misses: int = 0
        self._maxsize = max(maxsize, 0) if maxsize is not None else None
        self._currsize: int = 0
        self._typed = typed
        self._always_checkpoint = always_checkpoint
        self._ttl = ttl
        update_wrapper(self, func)

    def cache_info(self) -> AsyncCacheInfo:
        return AsyncCacheInfo(
            self._hits, self._misses, self._maxsize, self._currsize, self._ttl
        )

    def cache_parameters(self) -> AsyncCacheParameters:
        return {
            "maxsize": self._maxsize,
            "typed": self._typed,
            "always_checkpoint": self._always_checkpoint,
            "ttl": self._ttl,
        }

    def cache_clear(self) -> None:
        if cache := lru_cache_items.get(None):
            cache.pop(self, None)
            self._hits = self._misses = self._currsize = 0

    async def __call__(self, *args: P.args, **kwargs: P.kwargs) -> T:
        # Easy case first: if maxsize == 0, no caching is done
        if self._maxsize == 0:
            value = await self.__wrapped__(*args, **kwargs)
            self._misses += 1
            return value

        # The key is constructed as a flat tuple to avoid memory overhead
        key: tuple[Any, ...] = args
        if kwargs:
            # initial_missing is used as a separator
            key += (initial_missing,) + sum(kwargs.items(), ())

        if self._typed:
            key += tuple(type(arg) for arg in args)
            if kwargs:
                key += (initial_missing,) + tuple(type(val) for val in kwargs.values())

        try:
            cache = lru_cache_items.get()
        except LookupError:
            cache = WeakKeyDictionary()
            lru_cache_items.set(cache)

        try:
            cache_entry = cache[self]
        except KeyError:
            cache_entry = cache[self] = OrderedDict()

        cached_value: T | _InitialMissingType
        try:
            cached_value, lock, expires_at = cache_entry[key]
        except KeyError:
            # We're the first task to call this function
            cached_value, lock, expires_at = (
                initial_missing,
                Lock(fast_acquire=not self._always_checkpoint),
                None,
            )
            cache_entry[key] = cached_value, lock, expires_at

        if lock is None:
            if expires_at is not None and current_time() >= expires_at:
                self._currsize -= 1
                cached_value, lock, expires_at = (
                    initial_missing,
                    Lock(fast_acquire=not self._always_checkpoint),
                    None,
                )
                cache_entry[key] = cached_value, lock, expires_at
            else:
                # The value was already cached
                self._hits += 1
                cache_entry.move_to_end(key)
                if self._always_checkpoint:
                    await checkpoint()

                return cast(T, cached_value)

        async with lock:
            # Check if another task filled the cache while we acquired the lock
            if (cached_value := cache_entry[key][0]) is initial_missing:
                self._misses += 1
                if self._maxsize is not None and self._currsize >= self._maxsize:
                    cache_entry.popitem(last=False)
                else:
                    self._currsize += 1

                value = await self.__wrapped__(*args, **kwargs)
                expires_at = (
                    current_time() + self._ttl if self._ttl is not None else None
                )
                cache_entry[key] = value, None, expires_at
            else:
                # Another task filled the cache while we were waiting for the lock
                self._hits += 1
                cache_entry.move_to_end(key)
                value = cast(T, cached_value)

        return value

    def __get__(
        self, instance: object, owner: type | None = None
    ) -> _LRUMethodWrapper[T]:
        wrapper = _LRUMethodWrapper(self, instance)
        update_wrapper(wrapper, self.__wrapped__)
        return wrapper


class _LRUCacheWrapper(Generic[T]):
    def __init__(
        self, maxsize: int | None, typed: bool, always_checkpoint: bool, ttl: int | None
    ):
        self._maxsize = maxsize
        self._typed = typed
        self._always_checkpoint = always_checkpoint
        self._ttl = ttl

    @overload
    def __call__(  # type: ignore[overload-overlap]
        self, func: Callable[P, Coroutine[Any, Any, T]], /
    ) -> AsyncLRUCacheWrapper[P, T]: ...

    @overload
    def __call__(
        self, func: Callable[..., T], /
    ) -> functools._lru_cache_wrapper[T]: ...

    def __call__(
        self, f: Callable[P, Coroutine[Any, Any, T]] | Callable[..., T], /
    ) -> AsyncLRUCacheWrapper[P, T] | functools._lru_cache_wrapper[T]:
        if iscoroutinefunction(f):
            return AsyncLRUCacheWrapper(
                f, self._maxsize, self._typed, self._always_checkpoint, self._ttl
            )

        return functools.lru_cache(maxsize=self._maxsize, typed=self._typed)(f)  # type: ignore[arg-type]


@overload
def cache(  # type: ignore[overload-overlap]
    func: Callable[P, Coroutine[Any, Any, T]], /
) -> AsyncLRUCacheWrapper[P, T]: ...


@overload
def cache(func: Callable[..., T], /) -> functools._lru_cache_wrapper[T]: ...


def cache(
    func: Callable[..., T] | Callable[P, Coroutine[Any, Any, T]], /
) -> AsyncLRUCacheWrapper[P, T] | functools._lru_cache_wrapper[T]:
    """
    A convenient shortcut for :func:`lru_cache` with ``maxsize=None``.

    This is the asynchronous equivalent to :func:`functools.cache`.

    """
    return lru_cache(maxsize=None)(func)


@overload
def lru_cache(
    *,
    maxsize: int | None = ...,
    typed: bool = ...,
    always_checkpoint: bool = ...,
    ttl: int | None = ...,
) -> _LRUCacheWrapper[Any]: ...


@overload
def lru_cache(  # type: ignore[overload-overlap]
    func: Callable[P, Coroutine[Any, Any, T]], /
) -> AsyncLRUCacheWrapper[P, T]: ...


@overload
def lru_cache(func: Callable[..., T], /) -> functools._lru_cache_wrapper[T]: ...


def lru_cache(
    func: Callable[P, Coroutine[Any, Any, T]] | Callable[..., T] | None = None,
    /,
    *,
    maxsize: int | None = 128,
    typed: bool = False,
    always_checkpoint: bool = False,
    ttl: int | None = None,
) -> (
    AsyncLRUCacheWrapper[P, T] | functools._lru_cache_wrapper[T] | _LRUCacheWrapper[Any]
):
    """
    An asynchronous version of :func:`functools.lru_cache`.

    If a synchronous function is passed, the standard library
    :func:`functools.lru_cache` is applied instead.

    :param always_checkpoint: if ``True``, every call to the cached function will be
        guaranteed to yield control to the event loop at least once
    :param ttl: time in seconds after which to invalidate cache entries

    .. note:: Caches and locks are managed on a per-event loop basis.

    """
    if func is None:
        return _LRUCacheWrapper[Any](maxsize, typed, always_checkpoint, ttl)

    if not callable(func):
        raise TypeError("the first argument must be callable")

    return _LRUCacheWrapper[T](maxsize, typed, always_checkpoint, ttl)(func)


@overload
async def reduce(
    function: Callable[[T, S], Awaitable[T]],
    iterable: Iterable[S] | AsyncIterable[S],
    /,
    initial: T,
) -> T: ...


@overload
async def reduce(
    function: Callable[[T, T], Awaitable[T]],
    iterable: Iterable[T] | AsyncIterable[T],
    /,
) -> T: ...


async def reduce(  # type: ignore[misc]
    function: Callable[[T, T], Awaitable[T]] | Callable[[T, S], Awaitable[T]],
    iterable: Iterable[T] | Iterable[S] | AsyncIterable[T] | AsyncIterable[S],
    /,
    initial: T | _InitialMissingType = initial_missing,
) -> T:
    """
    Asynchronous version of :func:`functools.reduce`.

    :param function: a coroutine function that takes two arguments: the accumulated
        value and the next element from the iterable
    :param iterable: an iterable or async iterable
    :param initial: the initial value (if missing, the first element of the iterable is
        used as the initial value)

    """
    element: Any
    function_called = False
    if isinstance(iterable, AsyncIterable):
        async_it = iterable.__aiter__()
        if initial is initial_missing:
            try:
                value = cast(T, await async_it.__anext__())
            except StopAsyncIteration:
                raise TypeError(
                    "reduce() of empty sequence with no initial value"
                ) from None
        else:
            value = cast(T, initial)

        async for element in async_it:
            value = await function(value, element)
            function_called = True
    elif isinstance(iterable, Iterable):
        it = iter(iterable)
        if initial is initial_missing:
            try:
                value = cast(T, next(it))
            except StopIteration:
                raise TypeError(
                    "reduce() of empty sequence with no initial value"
                ) from None
        else:
            value = cast(T, initial)

        for element in it:
            value = await function(value, element)
            function_called = True
    else:
        raise TypeError("reduce() argument 2 must be an iterable or async iterable")

    # Make sure there is at least one checkpoint, even if an empty iterable and an
    # initial value were given
    if not function_called:
        await checkpoint()

    return value
