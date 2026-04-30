from __future__ import annotations

import collections
import collections.abc
import typing
from typing import Any

from pydantic_core import PydanticOmit, core_schema

SEQUENCE_ORIGIN_MAP: dict[Any, Any] = {
    typing.Deque: collections.deque,  # noqa: UP006
    collections.deque: collections.deque,
    list: list,
    typing.List: list,  # noqa: UP006
    tuple: tuple,
    typing.Tuple: tuple,  # noqa: UP006
    set: set,
    typing.AbstractSet: set,
    typing.Set: set,  # noqa: UP006
    frozenset: frozenset,
    typing.FrozenSet: frozenset,  # noqa: UP006
    typing.Sequence: list,
    typing.MutableSequence: list,
    typing.MutableSet: set,
    # this doesn't handle subclasses of these
    # parametrized typing.Set creates one of these
    collections.abc.MutableSet: set,
    collections.abc.Set: frozenset,
}


def serialize_sequence_via_list(
    v: Any, handler: core_schema.SerializerFunctionWrapHandler, info: core_schema.SerializationInfo
) -> Any:
    items: list[Any] = []

    mapped_origin = SEQUENCE_ORIGIN_MAP.get(type(v), None)
    if mapped_origin is None:
        # we shouldn't hit this branch, should probably add a serialization error or something
        return v

    for index, item in enumerate(v):
        try:
            v = handler(item, index)
        except PydanticOmit:  # noqa: PERF203
            pass
        else:
            items.append(v)

    if info.mode_is_json():
        return items
    else:
        return mapped_origin(items)
