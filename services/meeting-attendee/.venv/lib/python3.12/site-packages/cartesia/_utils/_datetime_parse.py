"""
This file contains code from https://github.com/pydantic/pydantic/blob/main/pydantic/v1/datetime_parse.py
without the Pydantic v1 specific errors.
"""

from __future__ import annotations

import re
from typing import Dict, Union, Optional
from datetime import date, datetime, timezone, timedelta

from .._types import StrBytesIntFloat

date_expr = r"(?P<year>\d{4})-(?P<month>\d{1,2})-(?P<day>\d{1,2})"
time_expr = (
    r"(?P<hour>\d{1,2}):(?P<minute>\d{1,2})"
    r"(?::(?P<second>\d{1,2})(?:\.(?P<microsecond>\d{1,6})\d{0,6})?)?"
    r"(?P<tzinfo>Z|[+-]\d{2}(?::?\d{2})?)?$"
)

date_re = re.compile(f"{date_expr}$")
datetime_re = re.compile(f"{date_expr}[T ]{time_expr}")


EPOCH = datetime(1970, 1, 1)
# if greater than this, the number is in ms, if less than or equal it's in seconds
# (in seconds this is 11th October 2603, in ms it's 20th August 1970)
MS_WATERSHED = int(2e10)
# slightly more than datetime.max in ns - (datetime.max - EPOCH).total_seconds() * 1e9
MAX_NUMBER = int(3e20)


def _get_numeric(value: StrBytesIntFloat, native_expected_type: str) -> Union[None, int, float]:
    if isinstance(value, (int, float)):
        return value
    try:
        return float(value)
    except ValueError:
        return None
    except TypeError:
        raise TypeError(f"invalid type; expected {native_expected_type}, string, bytes, int or float") from None


def _from_unix_seconds(seconds: Union[int, float]) -> datetime:
    if seconds > MAX_NUMBER:
        return datetime.max
    elif seconds < -MAX_NUMBER:
        return datetime.min

    while abs(seconds) > MS_WATERSHED:
        seconds /= 1000
    dt = EPOCH + timedelta(seconds=seconds)
    return dt.replace(tzinfo=timezone.utc)


def _parse_timezone(value: Optional[str]) -> Union[None, int, timezone]:
    if value == "Z":
        return timezone.utc
    elif value is not None:
        offset_mins = int(value[-2:]) if len(value) > 3 else 0
        offset = 60 * int(value[1:3]) + offset_mins
        if value[0] == "-":
            offset = -offset
        return timezone(timedelta(minutes=offset))
    else:
        return None


def parse_datetime(value: Union[datetime, StrBytesIntFloat]) -> datetime:
    """
    Parse a datetime/int/float/string and return a datetime.datetime.

    This function supports time zone offsets. When the input contains one,
    the output uses a timezone with a fixed offset from UTC.

    Raise ValueError if the input is well formatted but not a valid datetime.
    Raise ValueError if the input isn't well formatted.
    """
    if isinstance(value, datetime):
        return value

    number = _get_numeric(value, "datetime")
    if number is not None:
        return _from_unix_seconds(number)

    if isinstance(value, bytes):
        value = value.decode()

    assert not isinstance(value, (float, int))

    match = datetime_re.match(value)
    if match is None:
        raise ValueError("invalid datetime format")

    kw = match.groupdict()
    if kw["microsecond"]:
        kw["microsecond"] = kw["microsecond"].ljust(6, "0")

    tzinfo = _parse_timezone(kw.pop("tzinfo"))
    kw_: Dict[str, Union[None, int, timezone]] = {k: int(v) for k, v in kw.items() if v is not None}
    kw_["tzinfo"] = tzinfo

    return datetime(**kw_)  # type: ignore


def parse_date(value: Union[date, StrBytesIntFloat]) -> date:
    """
    Parse a date/int/float/string and return a datetime.date.

    Raise ValueError if the input is well formatted but not a valid date.
    Raise ValueError if the input isn't well formatted.
    """
    if isinstance(value, date):
        if isinstance(value, datetime):
            return value.date()
        else:
            return value

    number = _get_numeric(value, "date")
    if number is not None:
        return _from_unix_seconds(number).date()

    if isinstance(value, bytes):
        value = value.decode()

    assert not isinstance(value, (float, int))
    match = date_re.match(value)
    if match is None:
        raise ValueError("invalid date format")

    kw = {k: int(v) for k, v in match.groupdict().items()}

    try:
        return date(**kw)
    except ValueError:
        raise ValueError("invalid date format") from None
