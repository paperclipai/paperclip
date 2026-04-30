from __future__ import annotations

from collections.abc import Awaitable, Callable, Iterator
from typing import Any, ParamSpec, Protocol

P = ParamSpec("P")


_Scope = Any
_Receive = Callable[[], Awaitable[Any]]
_Send = Callable[[Any], Awaitable[None]]
# Since `starlette.types.ASGIApp` type differs from `ASGIApplication` from `asgiref`
# we need to define a more permissive version of ASGIApp that doesn't cause type errors.
_ASGIApp = Callable[[_Scope, _Receive, _Send], Awaitable[None]]


class _MiddlewareFactory(Protocol[P]):
    def __call__(self, app: _ASGIApp, /, *args: P.args, **kwargs: P.kwargs) -> _ASGIApp: ...  # pragma: no cover


class Middleware:
    def __init__(self, cls: _MiddlewareFactory[P], *args: P.args, **kwargs: P.kwargs) -> None:
        self.cls = cls
        self.args = args
        self.kwargs = kwargs

    def __iter__(self) -> Iterator[Any]:
        as_tuple = (self.cls, self.args, self.kwargs)
        return iter(as_tuple)

    def __repr__(self) -> str:
        class_name = self.__class__.__name__
        args_strings = [f"{value!r}" for value in self.args]
        option_strings = [f"{key}={value!r}" for key, value in self.kwargs.items()]
        name = getattr(self.cls, "__name__", "")
        args_repr = ", ".join([name] + args_strings + option_strings)
        return f"{class_name}({args_repr})"
