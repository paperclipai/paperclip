"""
This module defines a Duration class.

The class Duration allows to define durations in years and months and can be
used as limited replacement for timedelta objects.
"""

from datetime import timedelta
from decimal import ROUND_FLOOR, Decimal


def fquotmod(val, low, high):
    """
    A divmod function with boundaries.

    """
    # assumes that all the maths is done with Decimals.
    # divmod for Decimal uses truncate instead of floor as builtin
    # divmod, so we have to do it manually here.
    a, b = val - low, high - low
    div = (a / b).to_integral(ROUND_FLOOR)
    mod = a - div * b
    # if we were not using Decimal, it would look like this.
    # div, mod = divmod(val - low, high - low)
    mod += low
    return int(div), mod


def max_days_in_month(year, month):
    """
    Determines the number of days of a specific month in a specific year.
    """
    if month in (1, 3, 5, 7, 8, 10, 12):
        return 31
    if month in (4, 6, 9, 11):
        return 30
    if ((year % 400) == 0) or ((year % 100) != 0) and ((year % 4) == 0):
        return 29
    return 28


class Duration:
    """
    A class which represents a duration.

    The difference to datetime.timedelta is, that this class handles also
    differences given in years and months.
    A Duration treats differences given in year, months separately from all
    other components.

    A Duration can be used almost like any timedelta object, however there
    are some restrictions:
      * It is not really possible to compare Durations, because it is unclear,
        whether a duration of 1 year is bigger than 365 days or not.
      * Equality is only tested between the two (year, month vs. timedelta)
        basic components.

    A Duration can also be converted into a datetime object, but this requires
    a start date or an end date.

    The algorithm to add a duration to a date is defined at
    http://www.w3.org/TR/xmlschema-2/#adding-durations-to-dateTimes
    """

    def __init__(
        self,
        days=0,
        seconds=0,
        microseconds=0,
        milliseconds=0,
        minutes=0,
        hours=0,
        weeks=0,
        months=0,
        years=0,
    ):
        """
        Initialise this Duration instance with the given parameters.
        """
        if not isinstance(months, Decimal):
            months = Decimal(str(months))
        if not isinstance(years, Decimal):
            years = Decimal(str(years))
        self.months = months
        self.years = years
        self.tdelta = timedelta(
            days, seconds, microseconds, milliseconds, minutes, hours, weeks
        )

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
        return "%s.%s(%d, %d, %d, years=%d, months=%d)" % (
            self.__class__.__module__,
            self.__class__.__name__,
            self.tdelta.days,
            self.tdelta.seconds,
            self.tdelta.microseconds,
            self.years,
            self.months,
        )

    def __hash__(self):
        """
        Return a hash of this instance so that it can be used in, for
        example, dicts and sets.
        """
        return hash((self.tdelta, self.months, self.years))

    def __neg__(self):
        """
        A simple unary minus.

        Returns a new Duration instance with all it's negated.
        """
        negduration = Duration(years=-self.years, months=-self.months)
        negduration.tdelta = -self.tdelta
        return negduration

    def __add__(self, other):
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
        try:
            # try anything that looks like a date or datetime
            # 'other' has attributes year, month, day
            # and relies on 'timedelta + other' being implemented
            if not (float(self.years).is_integer() and float(self.months).is_integer()):
                raise ValueError(
                    "fractional years or months not supported" " for date calculations"
                )
            newmonth = other.month + self.months
            carry, newmonth = fquotmod(newmonth, 1, 13)
            newyear = other.year + self.years + carry
            maxdays = max_days_in_month(newyear, newmonth)
            if other.day > maxdays:
                newday = maxdays
            else:
                newday = other.day
            newdt = other.replace(
                year=int(newyear), month=int(newmonth), day=int(newday)
            )
            # does a timedelta + date/datetime
            return self.tdelta + newdt
        except AttributeError:
            # other probably was not a date/datetime compatible object
            pass
        try:
            # try if other is a timedelta
            # relies on timedelta + timedelta supported
            newduration = Duration(years=self.years, months=self.months)
            newduration.tdelta = self.tdelta + other
            return newduration
        except AttributeError:
            # ignore ... other probably was not a timedelta compatible object
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

    def __sub__(self, other):
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

    def __rsub__(self, other):
        """
        It is possible to subtract Duration objects from date, datetime and
        timedelta objects.

        TODO: there is some weird behaviour in date - timedelta ...
              if timedelta has seconds or microseconds set, then
              date - timedelta != date + (-timedelta)
              for now we follow this behaviour to avoid surprises when mixing
              timedeltas with Durations, but in case this ever changes in
              the stdlib we can just do:
                return -self + other
              instead of all the current code
        """
        if isinstance(other, timedelta):
            tmpdur = Duration()
            tmpdur.tdelta = other
            return tmpdur - self
        try:
            # check if other behaves like a date/datetime object
            # does it have year, month, day and replace?
            if not (float(self.years).is_integer() and float(self.months).is_integer()):
                raise ValueError(
                    "fractional years or months not supported" " for date calculations"
                )
            newmonth = other.month - self.months
            carry, newmonth = fquotmod(newmonth, 1, 13)
            newyear = other.year - self.years + carry
            maxdays = max_days_in_month(newyear, newmonth)
            if other.day > maxdays:
                newday = maxdays
            else:
                newday = other.day
            newdt = other.replace(
                year=int(newyear), month=int(newmonth), day=int(newday)
            )
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
        """
        Convert this duration into a timedelta object.

        This method requires a start datetime or end datetimem, but raises
        an exception if both are given.
        """
        if start is None and end is None:
            raise ValueError("start or end required")
        if start is not None and end is not None:
            raise ValueError("only start or end allowed")
        if start is not None:
            return (start + self) - start
        return end - (end - self)
