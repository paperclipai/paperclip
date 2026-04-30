"""
Large parts of this module are taken from the `isodate` package.
https://pypi.org/project/isodate/
Modifications are made to isodate features to allow compatibility with
XSD dates and durations that are not necessarily valid ISO8601 strings.

Copyright (c) 2024, Ashley Sommer, and RDFLib contributors
Copyright (c) 2021, Hugo van Kemenade and contributors
Copyright (c) 2009-2018, Gerhard Weis and contributors
Copyright (c) 2009, Gerhard Weis
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
- Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
- Redistributions in binary form must reproduce the above copyright
notice, this list of conditions and the following disclaimer in the
documentation and/or other materials provided with the distribution.
- Neither the name of the <organization> nor the
names of its contributors may be used to endorse or promote products
derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL <COPYRIGHT HOLDER> BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
"""

from __future__ import annotations

import re
import sys
from datetime import date, datetime, time, timedelta
from decimal import ROUND_FLOOR, Decimal
from typing import List, Tuple, Union, cast

if sys.version_info[:3] < (3, 11, 0):
    from isodate import parse_date, parse_datetime, parse_time
else:
    # On python 3.11, use the built-in parsers
    parse_date = date.fromisoformat
    parse_datetime = datetime.fromisoformat
    parse_time = time.fromisoformat


def fquotmod(
    val: Decimal, low: Union[Decimal, int], high: Union[Decimal, int]
) -> Tuple[int, Decimal]:
    """A divmod function with boundaries."""
    # assumes that all the maths is done with Decimals.
    # divmod for Decimal uses truncate instead of floor as builtin
    # divmod, so we have to do it manually here.
    a: Decimal = val - low
    b: Union[Decimal, int] = high - low
    div: Decimal = (a / b).to_integral(ROUND_FLOOR)
    mod: Decimal = a - div * b
    # if we were not using Decimal, it would look like this.
    # div, mod = divmod(val - low, high - low)
    mod += low
    return int(div), mod


def max_days_in_month(year: int, month: int) -> int:
    """
    Determines the number of days of a specific month in a specific year.
    """
    if month in (1, 3, 5, 7, 8, 10, 12):
        return 31
    if month in (4, 6, 9, 11):
        return 30
    if month < 1 or month > 12:
        raise ValueError("Month must be in 1..12")
    # Month is February
    if ((year % 400) == 0) or ((year % 100) != 0) and ((year % 4) == 0):
        return 29
    return 28


class Duration:
    """A class which represents a duration.

    The difference to datetime.timedelta is, that this class handles also
    differences given in years and months.
    A Duration treats differences given in year, months separately from all
    other components.

    A Duration can be used almost like any timedelta object, however there
    are some restrictions:
    - It is not really possible to compare Durations, because it is unclear,
    whether a duration of 1 year is bigger than 365 days or not.
    - Equality is only tested between the two (year, month vs. timedelta)
    basic components.

    A Duration can also be converted into a datetime object, but this requires
    a start date or an end date.

    The algorithm to add a duration to a date is defined at
    http://www.w3.org/TR/xmlschema-2/#adding-durations-to-dateTimes
    """

    def __init__(
        self,
        days: float = 0,
        seconds: float = 0,
        microseconds: float = 0,
        milliseconds: float = 0,
        minutes: float = 0,
        hours: float = 0,
        weeks: float = 0,
        months: Union[Decimal, float, int, str] = 0,
        years: Union[Decimal, float, int, str] = 0,
    ):
        """
        Initialise this Duration instance with the given parameters.
        """
        if not isinstance(months, Decimal):
            months = Decimal(str(months))
        if not isinstance(years, Decimal):
            years = Decimal(str(years))
        new_years, months = fquotmod(months, 0, 12)
        self.months = months
        self.years = Decimal(years + new_years)
        self.tdelta = timedelta(
            days, seconds, microseconds, milliseconds, minutes, hours, weeks
        )
        if self.years < 0 and self.tdelta.days < 0:
            raise ValueError("Duration cannot have negative years and negative days")

    def __getstate__(self):
        return self.__dict__

    def __setstate__(self, state):
        self.__dict__.update(state)

    def __getattr__(self, name):
        """
        Provide direct access to attributes of included timedelta instance.
        """
        return getattr(self.tdelta, name)

    def __str__(self):
        """
        Return a string representation of this duration similar to timedelta.
        """
        params = []
        if self.years:
            params.append("%d years" % self.years)
        if self.months:
            fmt = "%d months"
            if self.months <= 1:
                fmt = "%d month"
            params.append(fmt % self.months)
        params.append(str(self.tdelta))
        return ", ".join(params)

    def __repr__(self):
        """
        Return a string suitable for repr(x) calls.
        """
        return "%s.%s(%d, %d, %d, years=%s, months=%s)" % (
            self.__class__.__module__,
            self.__class__.__name__,
            self.tdelta.days,
            self.tdelta.seconds,
            self.tdelta.microseconds,
            str(self.years),
            str(self.months),
        )

    def __hash__(self):
        """
        Return a hash of this instance so that it can be used in, for
        example, dicts and sets.
        """
        return hash((self.tdelta, self.months, self.years))

    def __neg__(self):
        """A simple unary minus.

        Returns a new Duration instance with all it's negated.
        """
        negduration = Duration(years=-self.years, months=-self.months)
        negduration.tdelta = -self.tdelta
        return negduration

    def __add__(self, other: Union[Duration, timedelta, date, datetime]):
        """
        Durations can be added with Duration, timedelta, date and datetime
        objects.
        """
        if isinstance(other, Duration):
            newduration = Duration(
                years=self.years + other.years, months=self.months + other.months
            )
            newduration.tdelta = self.tdelta + other.tdelta
            return newduration
        elif isinstance(other, timedelta):
            newduration = Duration(years=self.years, months=self.months)
            newduration.tdelta = self.tdelta + other
            return newduration
        try:
            # try anything that looks like a date or datetime
            # 'other' has attributes year, month, day
            # and relies on 'timedelta + other' being implemented
            if not (float(self.years).is_integer() and float(self.months).is_integer()):
                raise ValueError(
                    "fractional years or months not supported for date calculations"
                )
            newmonth: Decimal = Decimal(other.month) + self.months
            carry, newmonth = fquotmod(newmonth, 1, 13)
            newyear: int = other.year + int(self.years) + carry
            maxdays: int = max_days_in_month(newyear, int(newmonth))
            newday: Union[int, float]
            if other.day > maxdays:
                newday = maxdays
            else:
                newday = other.day
            newdt = other.replace(year=newyear, month=int(newmonth), day=newday)
            # does a timedelta + date/datetime
            return self.tdelta + newdt
        except AttributeError:
            # other probably was not a date/datetime compatible object
            pass
        # we have tried everything .... return a NotImplemented
        return NotImplemented

    __radd__ = __add__

    def __mul__(self, other):
        if isinstance(other, int):
            newduration = Duration(years=self.years * other, months=self.months * other)
            newduration.tdelta = self.tdelta * other
            return newduration
        return NotImplemented

    __rmul__ = __mul__

    def __sub__(self, other: Union[Duration, timedelta]):
        """
        It is possible to subtract Duration and timedelta objects from Duration
        objects.
        """
        if isinstance(other, Duration):
            newduration = Duration(
                years=self.years - other.years, months=self.months - other.months
            )
            newduration.tdelta = self.tdelta - other.tdelta
            return newduration
        try:
            # do maths with our timedelta object ....
            newduration = Duration(years=self.years, months=self.months)
            newduration.tdelta = self.tdelta - other
            return newduration
        except TypeError:
            # looks like timedelta - other is not implemented
            pass
        return NotImplemented

    def __rsub__(self, other: Union[timedelta, date, datetime]):
        """
        It is possible to subtract Duration objects from date, datetime and
        timedelta objects.
        """
        # TODO: there is some weird behaviour in date - timedelta ...
        #       if timedelta has seconds or microseconds set, then
        #       date - timedelta != date + (-timedelta)
        #       for now we follow this behaviour to avoid surprises when mixing
        #       timedeltas with Durations, but in case this ever changes in
        #       the stdlib we can just do:
        #       return -self + other
        #       instead of all the current code

        if isinstance(other, timedelta):
            tmpdur = Duration()
            tmpdur.tdelta = other
            return tmpdur - self
        try:
            # check if other behaves like a date/datetime object
            # does it have year, month, day and replace?
            if not (float(self.years).is_integer() and float(self.months).is_integer()):
                raise ValueError(
                    "fractional years or months not supported for date calculations"
                )
            newmonth: Decimal = Decimal(other.month) - self.months
            carry, newmonth = fquotmod(newmonth, 1, 13)
            newyear: int = other.year - int(self.years) + carry
            maxdays: int = max_days_in_month(newyear, int(newmonth))
            newday: Union[int, float]
            if other.day > maxdays:
                newday = maxdays
            else:
                newday = other.day
            newdt = other.replace(year=newyear, month=int(newmonth), day=newday)
            return newdt - self.tdelta
        except AttributeError:
            # other probably was not compatible with data/datetime
            pass
        return NotImplemented

    def __eq__(self, other):
        """
        If the years, month part and the timedelta part are both equal, then
        the two Durations are considered equal.
        """
        if isinstance(other, Duration):
            if (self.years * 12 + self.months) == (
                other.years * 12 + other.months
            ) and self.tdelta == other.tdelta:
                return True
            return False
        # check if other con be compared against timedelta object
        # will raise an AssertionError when optimisation is off
        if self.years == 0 and self.months == 0:
            return self.tdelta == other
        return False

    def __ne__(self, other):
        """
        If the years, month part or the timedelta part is not equal, then
        the two Durations are considered not equal.
        """
        if isinstance(other, Duration):
            if (self.years * 12 + self.months) != (
                other.years * 12 + other.months
            ) or self.tdelta != other.tdelta:
                return True
            return False
        # check if other can be compared against timedelta object
        # will raise an AssertionError when optimisation is off
        if self.years == 0 and self.months == 0:
            return self.tdelta != other
        return True

    def totimedelta(self, start=None, end=None):
        """Convert this duration into a timedelta object.

        This method requires a start datetime or end datetime, but raises
        an exception if both are given.
        """
        if start is None and end is None:
            raise ValueError("start or end required")
        if start is not None and end is not None:
            raise ValueError("only start or end allowed")
        if start is not None:
            return (start + self) - start
        return end - (end - self)


ISO8601_PERIOD_REGEX = re.compile(
    r"^(?P<sign>[+-])?"
    r"P(?!\b)"
    r"(?P<years>[0-9]+([,.][0-9]+)?Y)?"
    r"(?P<months>[0-9]+([,.][0-9]+)?M)?"
    r"(?P<weeks>[0-9]+([,.][0-9]+)?W)?"
    r"(?P<days>[0-9]+([,.][0-9]+)?D)?"
    r"((?P<separator>T)(?P<hours>[0-9]+([,.][0-9]+)?H)?"
    r"(?P<minutes>[0-9]+([,.][0-9]+)?M)?"
    r"(?P<seconds>[0-9]+([,.][0-9]+)?S)?)?$"
)
# regular expression to parse ISO duration strings.


def parse_xsd_duration(
    dur_string: str, as_timedelta_if_possible: bool = True
) -> Union[Duration, timedelta]:
    """Parses an ISO 8601 durations into datetime.timedelta or Duration objects.

    If the ISO date string does not contain years or months, a timedelta
    instance is returned, else a Duration instance is returned.

    The following duration formats are supported:

    -`PnnW`                  duration in weeks
    -`PnnYnnMnnDTnnHnnMnnS`  complete duration specification
    -`PYYYYMMDDThhmmss`      basic alternative complete date format
    -`PYYYY-MM-DDThh:mm:ss`  extended alternative complete date format
    -`PYYYYDDDThhmmss`       basic alternative ordinal date format
    -`PYYYY-DDDThh:mm:ss`    extended alternative ordinal date format

    The '-' is optional.

    Limitations:  ISO standard defines some restrictions about where to use
    fractional numbers and which component and format combinations are
    allowed. This parser implementation ignores all those restrictions and
    returns something when it is able to find all necessary components.
    In detail:
    - it does not check, whether only the last component has fractions.
    - it allows weeks specified with all other combinations
    The alternative format does not support durations with years, months or
    days set to 0.
    """
    if not isinstance(dur_string, str):
        raise TypeError(f"Expecting a string: {dur_string!r}")
    match = ISO8601_PERIOD_REGEX.match(dur_string)
    if not match:
        # try alternative format:
        if dur_string.startswith("P"):
            durdt = parse_datetime(dur_string[1:])
            if as_timedelta_if_possible and durdt.year == 0 and durdt.month == 0:
                # FIXME: currently not possible in alternative format
                # create timedelta
                return timedelta(
                    days=durdt.day,
                    seconds=durdt.second,
                    microseconds=durdt.microsecond,
                    minutes=durdt.minute,
                    hours=durdt.hour,
                )
            else:
                # create Duration
                return Duration(
                    days=durdt.day,
                    seconds=durdt.second,
                    microseconds=durdt.microsecond,
                    minutes=durdt.minute,
                    hours=durdt.hour,
                    months=durdt.month,
                    years=durdt.year,
                )
        raise ValueError("Unable to parse duration string " + dur_string)
    groups = match.groupdict()
    for key, val in groups.items():
        if key not in ("separator", "sign"):
            if val is None:
                groups[key] = "0n"
            # print groups[key]
            if key in ("years", "months"):
                groups[key] = Decimal(groups[key][:-1].replace(",", "."))
            else:
                # these values are passed into a timedelta object,
                # which works with floats.
                groups[key] = float(groups[key][:-1].replace(",", "."))
    ret: Union[Duration, timedelta]
    if as_timedelta_if_possible and groups["years"] == 0 and groups["months"] == 0:
        ret = timedelta(
            days=groups["days"],  # type: ignore[arg-type]
            hours=groups["hours"],  # type: ignore[arg-type]
            minutes=groups["minutes"],  # type: ignore[arg-type]
            seconds=groups["seconds"],  # type: ignore[arg-type]
            weeks=groups["weeks"],  # type: ignore[arg-type]
        )
        if groups["sign"] == "-":
            ret = timedelta(0) - ret
    else:
        ret = Duration(
            years=cast(Decimal, groups["years"]),
            months=cast(Decimal, groups["months"]),
            days=groups["days"],  # type: ignore[arg-type]
            hours=groups["hours"],  # type: ignore[arg-type]
            minutes=groups["minutes"],  # type: ignore[arg-type]
            seconds=groups["seconds"],  # type: ignore[arg-type]
            weeks=groups["weeks"],  # type: ignore[arg-type]
        )
        if groups["sign"] == "-":
            ret = Duration(0) - ret

    return ret


def duration_isoformat(tdt: Union[Duration, timedelta], in_weeks: bool = False) -> str:
    if not in_weeks:
        ret: List[str] = []
        minus = False
        has_year_or_month = False
        if isinstance(tdt, Duration):
            if tdt.years == 0 and tdt.months == 0:
                pass  # don't do anything, we have no year or month
            else:
                has_year_or_month = True
                months = tdt.years * 12 + tdt.months
                if months < 0:
                    minus = True
                    months = abs(months)
                # We can use divmod instead of fquotmod here because its month_count
                # not month_index, and we don't have any negative months at this point.
                new_years, new_months = divmod(months, 12)
                if new_years:
                    ret.append(str(new_years) + "Y")
                if tdt.months:
                    ret.append(str(new_months) + "M")
            tdt = tdt.tdelta
        usecs: int = ((tdt.days * 86400) + tdt.seconds) * 1000000 + tdt.microseconds
        if usecs < 0:
            if minus:
                raise ValueError(
                    "Duration cannot have negative years and negative days"
                )
            elif has_year_or_month:
                raise ValueError(
                    "Duration cannot have positive years and months but negative days"
                )
            minus = True
            usecs = abs(usecs)
        if usecs == 0:
            # No delta parts other than years and months
            pass
        else:
            seconds, usecs = divmod(usecs, 1000000)
            minutes, seconds = divmod(seconds, 60)
            hours, minutes = divmod(minutes, 60)
            days, hours = divmod(hours, 24)
            if days:
                ret.append(str(days) + "D")
            if hours or minutes or seconds or usecs:
                ret.append("T")
                if hours:
                    ret.append(str(hours) + "H")
                if minutes:
                    ret.append(str(minutes) + "M")
                if seconds or usecs:
                    if usecs:
                        ret.append(("%d.%06d" % (seconds, usecs)).rstrip("0"))
                    else:
                        ret.append("%d" % seconds)
                    ret.append("S")
        if ret:
            return ("-P" if minus else "P") + "".join(ret)
        else:
            # at least one component has to be there.
            return "-P0D" if minus else "P0D"
    else:
        if tdt.days < 0:
            return f"-P{abs(tdt.days // 7)}W"
        return f"P{tdt.days // 7}W"


def xsd_datetime_isoformat(dt: datetime):
    if dt.microsecond == 0:
        no_tz_str = dt.strftime("%Y-%m-%dT%H:%M:%S")
    else:
        no_tz_str = dt.strftime("%Y-%m-%dT%H:%M:%S.%f")
    if dt.tzinfo is None:
        return no_tz_str
    else:
        offset_string = dt.strftime("%z")
        if offset_string == "+0000":
            return no_tz_str + "Z"
        first_char = offset_string[0]
        if first_char == "+" or first_char == "-":
            offset_string = offset_string[1:]
            sign = first_char
        else:
            sign = "+"
        tz_part = sign + offset_string[:2] + ":" + offset_string[2:]
        return no_tz_str + tz_part


def parse_xsd_date(date_string: str):
    """
    XSD Dates have more features than ISO8601 dates, specifically
    XSD allows timezones on dates, that must be stripped off.
    Also, XSD requires dashed separators, while ISO8601 is optional.
    RDFLib test suite has some date strings with times, the times are expected
    to be dropped during parsing.
    """
    if date_string.endswith("Z") or date_string.endswith("z"):
        date_string = date_string[:-1]
    if date_string.startswith("-"):
        date_string = date_string[1:]
        minus = True
    else:
        minus = False
    if "T" in date_string:
        # RDFLib test suite has some strange date strings, with times.
        # this has the side effect of also dropping the
        # TZ part, that is not wanted anyway for a date.
        date_string = date_string.split("T")[0]
    else:
        has_plus = date_string.rfind("+")
        if has_plus > 0:
            # Drop the +07:00 timezone part
            date_string = date_string[:has_plus]
        else:
            split_parts = date_string.rsplit("-", 1)
            if len(split_parts) > 1 and ":" in split_parts[-1]:
                # Drop the -09:00 timezone part
                date_string = split_parts[0]
    if "-" not in date_string:
        raise ValueError("XSD Date string must contain at least two dashes")
    return parse_date(date_string if not minus else ("-" + date_string))


# Parse XSD Datetime is the same as ISO8601 Datetime
# It uses datetime.fromisoformat for python 3.11 and above
# or isodate.parse_datetime for older versions
# parse_xsd_datetime = parse_datetime

# Parse XSD Time is the same as ISO8601 Time
# It uses time.fromisoformat for python 3.11 and above
# or isodate.parse_time for older versions
# parse_xsd_time = parse_time
