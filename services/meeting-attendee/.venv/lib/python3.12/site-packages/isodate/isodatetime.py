"""
This module defines a method to parse an ISO 8601:2004 date time string.

For this job it uses the parse_date and parse_time methods defined in date
and time module.
"""

from datetime import datetime

from isodate.isodates import parse_date
from isodate.isoerror import ISO8601Error
from isodate.isostrf import DATE_EXT_COMPLETE, TIME_EXT_COMPLETE, TZ_EXT, strftime
from isodate.isotime import parse_time


def parse_datetime(datetimestring):
    """
    Parses ISO 8601 date-times into datetime.datetime objects.

    This function uses parse_date and parse_time to do the job, so it allows
    more combinations of date and time representations, than the actual
    ISO 8601:2004 standard allows.
    """
    try:
        datestring, timestring = datetimestring.split("T")
    except ValueError:
        raise ISO8601Error(
            "ISO 8601 time designator 'T' missing. Unable to"
            " parse datetime string %r" % datetimestring
        )
    tmpdate = parse_date(datestring)
    tmptime = parse_time(timestring)
    return datetime.combine(tmpdate, tmptime)


def datetime_isoformat(
    tdt, format=DATE_EXT_COMPLETE + "T" + TIME_EXT_COMPLETE + TZ_EXT
):
    """
    Format datetime strings.

    This method is just a wrapper around isodate.isostrf.strftime and uses
    Extended-Complete as default format.
    """
    return strftime(tdt, format)
