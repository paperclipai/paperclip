from __future__ import annotations

from typing import NoReturn, TypeVar

from attrs import define as _define, frozen as _frozen

_T = TypeVar("_T")


def define(cls: type[_T]) -> type[_T]:  # pragma: no cover
    cls.__init_subclass__ = _do_not_subclass
    return _define(cls)


def frozen(cls: type[_T]) -> type[_T]:
    cls.__init_subclass__ = _do_not_subclass
    return _frozen(cls)


class UnsupportedSubclassing(Exception):
    def __str__(self):
        return (
            "Subclassing is not part of referencing's public API. "
            "If no other suitable API exists for what you're trying to do, "
            "feel free to file an issue asking for one."
        )


@staticmethod
def _do_not_subclass() -> NoReturn:  # pragma: no cover
    raise UnsupportedSubclassing()
