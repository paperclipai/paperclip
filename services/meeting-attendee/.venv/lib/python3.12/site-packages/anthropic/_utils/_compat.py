from __future__ import annotations

import sys
import typing_extensions
from typing import Any, Type, Union, Literal, Optional
from datetime import date, datetime
from typing_extensions import get_args as _get_args, get_origin as _get_origin

from .._types import StrBytesIntFloat
from ._datetime_parse import parse_date as _parse_date, parse_datetime as _parse_datetime

_LITERAL_TYPES = {Literal, typing_extensions.Literal}


def get_args(tp: type[Any]) -> tuple[Any, ...]:
    return _get_args(tp)


def get_origin(tp: type[Any]) -> type[Any] | None:
    return _get_origin(tp)


def is_union(tp: Optional[Type[Any]]) -> bool:
    if sys.version_info < (3, 10):
        return tp is Union  # type: ignore[comparison-overlap]
    else:
        import types

        return tp is Union or tp is types.UnionType  # type: ignore[comparison-overlap]


def is_typeddict(tp: Type[Any]) -> bool:
    return typing_extensions.is_typeddict(tp)


def is_literal_type(tp: Type[Any]) -> bool:
    return get_origin(tp) in _LITERAL_TYPES


def parse_date(value: Union[date, StrBytesIntFloat]) -> date:
    return _parse_date(value)


def parse_datetime(value: Union[datetime, StrBytesIntFloat]) -> datetime:
    return _parse_datetime(value)
