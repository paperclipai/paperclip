from __future__ import annotations

import functools
import sys
from collections.abc import Awaitable, Callable, Generator
from contextlib import AbstractAsyncContextManager, contextmanager
from typing import Any, Generic, Protocol, TypeVar, overload

from starlette.types import Scope

if sys.version_info >= (3, 13):  # pragma: no cover
    from inspect import iscoroutinefunction
    from typing import TypeIs
else:  # pragma: no cover
    from asyncio import iscoroutinefunction

    from typing_extensions import TypeIs

has_exceptiongroups = True
if sys.version_info < (3, 11):  # pragma: no cover
    try:
        from exceptiongroup import BaseExceptionGroup  # type: ignore[unused-ignore,import-not-found]
    except ImportError:
        has_exceptiongroups = False

T = TypeVar("T")
AwaitableCallable = Callable[..., Awaitable[T]]


@overload
def is_async_callable(obj: AwaitableCallable[T]) -> TypeIs[AwaitableCallable[T]]: ...


@overload
def is_async_callable(obj: Any) -> TypeIs[AwaitableCallable[Any]]: ...


def is_async_callable(obj: Any) -> Any:
    while isinstance(obj, functools.partial):
        obj = obj.func

    return iscoroutinefunction(obj) or (callable(obj) and iscoroutinefunction(obj.__call__))


T_co = TypeVar("T_co", covariant=True)


class AwaitableOrContextManager(
    Awaitable[T_co], AbstractAsyncContextManager[T_co], Protocol[T_co]
): ...  # pragma: no branch


class SupportsAsyncClose(Protocol):
    async def close(self) -> None: ...  # pragma: no cover


SupportsAsyncCloseType = TypeVar("SupportsAsyncCloseType", bound=SupportsAsyncClose, covariant=False)


class AwaitableOrContextManagerWrapper(Generic[SupportsAsyncCloseType]):
    __slots__ = ("aw", "entered")

    def __init__(self, aw: Awaitable[SupportsAsyncCloseType]) -> None:
        self.aw = aw

    def __await__(self) -> Generator[Any, None, SupportsAsyncCloseType]:
        return self.aw.__await__()

    async def __aenter__(self) -> SupportsAsyncCloseType:
        self.entered = await self.aw
        return self.entered

    async def __aexit__(self, *args: Any) -> None | bool:
        await self.entered.close()
        return None


@contextmanager
def collapse_excgroups() -> Generator[None, None, None]:
    try:
        yield
    except BaseException as exc:
        if has_exceptiongroups:  # pragma: no cover
            while isinstance(exc, BaseExceptionGroup) and len(exc.exceptions) == 1:
                exc = exc.exceptions[0]

        raise exc


def get_route_path(scope: Scope) -> str:
    path: str = scope["path"]
    root_path = scope.get("root_path", "")
    if not root_path:
        return path

    if not path.startswith(root_path):
        return path

    if path == root_path:
        return ""

    if path[len(root_path)] == "/":
        return path[len(root_path) :]

    return path
