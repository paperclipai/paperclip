from __future__ import annotations

__all__ = (
    "EventLoopToken",
    "RunvarToken",
    "RunVar",
    "checkpoint",
    "checkpoint_if_cancelled",
    "cancel_shielded_checkpoint",
    "current_token",
)

import enum
from dataclasses import dataclass
from types import TracebackType
from typing import Any, Generic, Literal, TypeVar, final, overload
from weakref import WeakKeyDictionary

from ._core._eventloop import get_async_backend
from .abc import AsyncBackend

T = TypeVar("T")
D = TypeVar("D")


async def checkpoint() -> None:
    """
    Check for cancellation and allow the scheduler to switch to another task.

    Equivalent to (but more efficient than)::

        await checkpoint_if_cancelled()
        await cancel_shielded_checkpoint()

    .. versionadded:: 3.0

    """
    await get_async_backend().checkpoint()


async def checkpoint_if_cancelled() -> None:
    """
    Enter a checkpoint if the enclosing cancel scope has been cancelled.

    This does not allow the scheduler to switch to a different task.

    .. versionadded:: 3.0

    """
    await get_async_backend().checkpoint_if_cancelled()


async def cancel_shielded_checkpoint() -> None:
    """
    Allow the scheduler to switch to another task but without checking for cancellation.

    Equivalent to (but potentially more efficient than)::

        with CancelScope(shield=True):
            await checkpoint()

    .. versionadded:: 3.0

    """
    await get_async_backend().cancel_shielded_checkpoint()


@final
@dataclass(frozen=True, repr=False)
class EventLoopToken:
    """
    An opaque object that holds a reference to an event loop.

    .. versionadded:: 4.11.0
    """

    backend_class: type[AsyncBackend]
    native_token: object


def current_token() -> EventLoopToken:
    """
    Return a token object that can be used to call code in the current event loop from
    another thread.

    :raises NoEventLoopError: if no supported asynchronous event loop is running in the
        current thread

    .. versionadded:: 4.11.0

    """
    backend_class = get_async_backend()
    raw_token = backend_class.current_token()
    return EventLoopToken(backend_class, raw_token)


_run_vars: WeakKeyDictionary[object, dict[RunVar[Any], Any]] = WeakKeyDictionary()


class _NoValueSet(enum.Enum):
    NO_VALUE_SET = enum.auto()


class RunvarToken(Generic[T]):
    __slots__ = "_var", "_value", "_redeemed"

    def __init__(self, var: RunVar[T], value: T | Literal[_NoValueSet.NO_VALUE_SET]):
        self._var = var
        self._value: T | Literal[_NoValueSet.NO_VALUE_SET] = value
        self._redeemed = False

    def __enter__(self) -> RunvarToken[T]:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        self._var.reset(self)


class RunVar(Generic[T]):
    """
    Like a :class:`~contextvars.ContextVar`, except scoped to the running event loop.

    Can be used as a context manager, Just like :class:`~contextvars.ContextVar`, that
    will reset the variable to its previous value when the context block is exited.
    """

    __slots__ = "_name", "_default"

    NO_VALUE_SET: Literal[_NoValueSet.NO_VALUE_SET] = _NoValueSet.NO_VALUE_SET

    def __init__(
        self, name: str, default: T | Literal[_NoValueSet.NO_VALUE_SET] = NO_VALUE_SET
    ):
        self._name = name
        self._default = default

    @property
    def _current_vars(self) -> dict[RunVar[T], T]:
        native_token = current_token().native_token
        try:
            return _run_vars[native_token]
        except KeyError:
            run_vars = _run_vars[native_token] = {}
            return run_vars

    @overload
    def get(self, default: D) -> T | D: ...

    @overload
    def get(self) -> T: ...

    def get(
        self, default: D | Literal[_NoValueSet.NO_VALUE_SET] = NO_VALUE_SET
    ) -> T | D:
        try:
            return self._current_vars[self]
        except KeyError:
            if default is not RunVar.NO_VALUE_SET:
                return default
            elif self._default is not RunVar.NO_VALUE_SET:
                return self._default

        raise LookupError(
            f'Run variable "{self._name}" has no value and no default set'
        )

    def set(self, value: T) -> RunvarToken[T]:
        current_vars = self._current_vars
        token = RunvarToken(self, current_vars.get(self, RunVar.NO_VALUE_SET))
        current_vars[self] = value
        return token

    def reset(self, token: RunvarToken[T]) -> None:
        if token._var is not self:
            raise ValueError("This token does not belong to this RunVar")

        if token._redeemed:
            raise ValueError("This token has already been used")

        if token._value is _NoValueSet.NO_VALUE_SET:
            try:
                del self._current_vars[self]
            except KeyError:
                pass
        else:
            self._current_vars[self] = token._value

        token._redeemed = True

    def __repr__(self) -> str:
        return f"<RunVar name={self._name!r}>"
