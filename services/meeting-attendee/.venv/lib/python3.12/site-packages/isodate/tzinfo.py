"""
This module provides some datetime.tzinfo implementations.

All those classes are taken from the Python documentation.
"""

import time
from datetime import timedelta, tzinfo

ZERO = timedelta(0)
# constant for zero time offset.


class Utc(tzinfo):
    """UTC

    Universal time coordinated time zone.
    """

    def utcoffset(self, dt):
        """
        Return offset from UTC in minutes east of UTC, which is ZERO for UTC.
        """
        return ZERO

    def tzname(self, dt):
        """
        Return the time zone name corresponding to the datetime object dt,
        as a string.
        """
        return "UTC"

    def dst(self, dt):
        """
        Return the daylight saving time (DST) adjustment, in minutes east
        of UTC.
        """
        return ZERO

    def __reduce__(self):
        """
        When unpickling a Utc object, return the default instance below, UTC.
        """
        return _Utc, ()


UTC = Utc()
# the default instance for UTC.


def _Utc():
    """
    Helper function for unpickling a Utc object.
    """
    return UTC


class FixedOffset(tzinfo):
    """
    A class building tzinfo objects for fixed-offset time zones.

    Note that FixedOffset(0, 0, "UTC") or FixedOffset() is a different way to
    build a UTC tzinfo object.
    """

    def __init__(self, offset_hours=0, offset_minutes=0, name="UTC"):
        """
        Initialise an instance with time offset and name.
        The time offset should be positive for time zones east of UTC
        and negate for time zones west of UTC.
        """
        self.__offset = timedelta(hours=offset_hours, minutes=offset_minutes)
        self.__name = name

    def utcoffset(self, dt):
        """
        Return offset from UTC in minutes of UTC.
        """
        return self.__offset

    def tzname(self, dt):
        """
        Return the time zone name corresponding to the datetime object dt, as a
        string.
        """
        return self.__name

    def dst(self, dt):
        """
        Return the daylight saving time (DST) adjustment, in minutes east of
        UTC.
        """
        return ZERO

    def __repr__(self):
        """
        Return nicely formatted repr string.
        """
        return "<FixedOffset %r>" % self.__name


STDOFFSET = timedelta(seconds=-time.timezone)
# locale time zone offset

# calculate local daylight saving offset if any.
if time.daylight:
    DSTOFFSET = timedelta(seconds=-time.altzone)
else:
    DSTOFFSET = STDOFFSET

DSTDIFF = DSTOFFSET - STDOFFSET
# difference between local time zone and local DST time zone


class LocalTimezone(tzinfo):
    """
    A class capturing the platform's idea of local time.
    """

    def utcoffset(self, dt):
        """
        Return offset from UTC in minutes of UTC.
        """
        if self._isdst(dt):
            return DSTOFFSET
        else:
            return STDOFFSET

    def dst(self, dt):
        """
        Return daylight saving offset.
        """
        if self._isdst(dt):
            return DSTDIFF
        else:
            return ZERO

    def tzname(self, dt):
        """
        Return the time zone name corresponding to the datetime object dt, as a
        string.
        """
        return time.tzname[self._isdst(dt)]

    def _isdst(self, dt):
        """
        Returns true if DST is active for given datetime object dt.
        """
        tt = (
            dt.year,
            dt.month,
            dt.day,
            dt.hour,
            dt.minute,
            dt.second,
            dt.weekday(),
            0,
            -1,
        )
        stamp = time.mktime(tt)
        tt = time.localtime(stamp)
        return tt.tm_isdst > 0


# the default instance for local time zone.
LOCAL = LocalTimezone()
