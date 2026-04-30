"""
This modules provides a method to parse an ISO 8601:2004 date string to a
python datetime.date instance.

It supports all basic, extended and expanded formats as described in the ISO
standard. The only limitations it has, are given by the Python datetime.date
implementation, which does not support dates before 0001-01-01.
"""

import re
from datetime import date, timedelta

from isodate.isoerror import ISO8601Error
from isodate.isostrf import DATE_EXT_COMPLETE, strftime

DATE_REGEX_CACHE = {}
# A dictionary to cache pre-compiled regular expressions.
# A set of regular expressions is identified, by number of year digits allowed
# and whether a plus/minus sign is required or not. (This option is changeable
# only for 4 digit years).


def build_date_regexps(yeardigits=4, expanded=False):
    """
    Compile set of regular expressions to parse ISO dates. The expressions will
    be created only if they are not already in REGEX_CACHE.

    It is necessary to fix the number of year digits, else it is not possible
    to automatically distinguish between various ISO date formats.

    ISO 8601 allows more than 4 digit years, on prior agreement, but then a +/-
    sign is required (expanded format). To support +/- sign for 4 digit years,
    the expanded parameter needs to be set to True.
    """
    if yeardigits != 4:
        expanded = True
    if (yeardigits, expanded) not in DATE_REGEX_CACHE:
        cache_entry = []
        # ISO 8601 expanded DATE formats allow an arbitrary number of year
        # digits with a leading +/- sign.
        if expanded:
            sign = 1
        else:
            sign = 0

        def add_re(regex_text):
            cache_entry.append(re.compile(r"\A" + regex_text + r"\Z"))

        # 1. complete dates:
        #    YYYY-MM-DD or +- YYYYYY-MM-DD... extended date format
        add_re(
            r"(?P<sign>[+-]){%d}(?P<year>[0-9]{%d})"
            r"-(?P<month>[0-9]{2})-(?P<day>[0-9]{2})" % (sign, yeardigits)
        )
        #    YYYYMMDD or +- YYYYYYMMDD... basic date format
        add_re(
            r"(?P<sign>[+-]){%d}(?P<year>[0-9]{%d})"
            r"(?P<month>[0-9]{2})(?P<day>[0-9]{2})" % (sign, yeardigits)
        )
        # 2. complete week dates:
        #    YYYY-Www-D or +-YYYYYY-Www-D ... extended week date
        add_re(
            r"(?P<sign>[+-]){%d}(?P<year>[0-9]{%d})"
            r"-W(?P<week>[0-9]{2})-(?P<day>[0-9]{1})" % (sign, yeardigits)
        )
        #    YYYYWwwD or +-YYYYYYWwwD ... basic week date
        add_re(
            r"(?P<sign>[+-]){%d}(?P<year>[0-9]{%d})W"
            r"(?P<week>[0-9]{2})(?P<day>[0-9]{1})" % (sign, yeardigits)
        )
        # 3. ordinal dates:
        #    YYYY-DDD or +-YYYYYY-DDD ... extended format
        add_re(
            r"(?P<sign>[+-]){%d}(?P<year>[0-9]{%d})"
            r"-(?P<day>[0-9]{3})" % (sign, yeardigits)
        )
        #    YYYYDDD or +-YYYYYYDDD ... basic format
        add_re(
            r"(?P<sign>[+-]){%d}(?P<year>[0-9]{%d})"
            r"(?P<day>[0-9]{3})" % (sign, yeardigits)
        )
        # 4. week dates:
        #    YYYY-Www or +-YYYYYY-Www ... extended reduced accuracy week date
        # 4. week dates:
        #    YYYY-Www or +-YYYYYY-Www ... extended reduced accuracy week date
        add_re(
            r"(?P<sign>[+-]){%d}(?P<year>[0-9]{%d})"
            r"-W(?P<week>[0-9]{2})" % (sign, yeardigits)
        )
        #    YYYYWww or +-YYYYYYWww ... basic reduced accuracy week date
        add_re(
            r"(?P<sign>[+-]){%d}(?P<year>[0-9]{%d})W"
            r"(?P<week>[0-9]{2})" % (sign, yeardigits)
        )
        # 5. month dates:
        #    YYY-MM or +-YYYYYY-MM ... reduced accuracy specific month
        # 5. month dates:
        #    YYY-MM or +-YYYYYY-MM ... reduced accuracy specific month
        add_re(
            r"(?P<sign>[+-]){%d}(?P<year>[0-9]{%d})"
            r"-(?P<month>[0-9]{2})" % (sign, yeardigits)
        )
        #    YYYMM or +-YYYYYYMM ... basic incomplete month date format
        add_re(
            r"(?P<sign>[+-]){%d}(?P<year>[0-9]{%d})"
            r"(?P<month>[0-9]{2})" % (sign, yeardigits)
        )
        # 6. year dates:
        #    YYYY or +-YYYYYY ... reduced accuracy specific year
        add_re(r"(?P<sign>[+-]){%d}(?P<year>[0-9]{%d})" % (sign, yeardigits))
        # 7. century dates:
        #    YY or +-YYYY ... reduced accuracy specific century
        add_re(r"(?P<sign>[+-]){%d}" r"(?P<century>[0-9]{%d})" % (sign, yeardigits - 2))

        DATE_REGEX_CACHE[(yeardigits, expanded)] = cache_entry
    return DATE_REGEX_CACHE[(yeardigits, expanded)]


def parse_date(datestring, yeardigits=4, expanded=False, defaultmonth=1, defaultday=1):
    """
    Parse an ISO 8601 date string into a datetime.date object.

    As the datetime.date implementation is limited to dates starting from
    0001-01-01, negative dates (BC) and year 0 can not be parsed by this
    method.

    For incomplete dates, this method chooses the first day for it. For
    instance if only a century is given, this method returns the 1st of
    January in year 1 of this century.

    supported formats: (expanded formats are shown with 6 digits for year)
      YYYYMMDD    +-YYYYYYMMDD      basic complete date
      YYYY-MM-DD  +-YYYYYY-MM-DD    extended complete date
      YYYYWwwD    +-YYYYYYWwwD      basic complete week date
      YYYY-Www-D  +-YYYYYY-Www-D    extended complete week date
      YYYYDDD     +-YYYYYYDDD       basic ordinal date
      YYYY-DDD    +-YYYYYY-DDD      extended ordinal date
      YYYYWww     +-YYYYYYWww       basic incomplete week date
      YYYY-Www    +-YYYYYY-Www      extended incomplete week date
      YYYMM       +-YYYYYYMM        basic incomplete month date
      YYY-MM      +-YYYYYY-MM       incomplete month date
      YYYY        +-YYYYYY          incomplete year date
      YY          +-YYYY            incomplete century date

    @param datestring: the ISO date string to parse
    @param yeardigits: how many digits are used to represent a year
    @param expanded: if True then +/- signs are allowed. This parameter
                     is forced to True, if yeardigits != 4

    @return: a datetime.date instance represented by datestring
    @raise ISO8601Error: if this function can not parse the datestring
    @raise ValueError: if datestring can not be represented by datetime.date
    """
    if yeardigits != 4:
        expanded = True
    isodates = build_date_regexps(yeardigits, expanded)
    for pattern in isodates:
        match = pattern.match(datestring)
        if match:
            groups = match.groupdict()
            # sign, century, year, month, week, day,
            # FIXME: negative dates not possible with python standard types
            sign = (groups["sign"] == "-" and -1) or 1
            if "century" in groups:
                return date(
                    sign * (int(groups["century"]) * 100 + 1), defaultmonth, defaultday
                )
            if "month" not in groups:  # weekdate or ordinal date
                ret = date(sign * int(groups["year"]), 1, 1)
                if "week" in groups:
                    isotuple = ret.isocalendar()
                    if "day" in groups:
                        days = int(groups["day"] or 1)
                    else:
                        days = 1
                    # if first week in year, do weeks-1
                    return ret + timedelta(
                        weeks=int(groups["week"]) - (((isotuple[1] == 1) and 1) or 0),
                        days=-isotuple[2] + days,
                    )
                elif "day" in groups:  # ordinal date
                    return ret + timedelta(days=int(groups["day"]) - 1)
                else:  # year date
                    return ret.replace(month=defaultmonth, day=defaultday)
            # year-, month-, or complete date
            if "day" not in groups or groups["day"] is None:
                day = defaultday
            else:
                day = int(groups["day"])
            return date(
                sign * int(groups["year"]), int(groups["month"]) or defaultmonth, day
            )
    raise ISO8601Error("Unrecognised ISO 8601 date format: %r" % datestring)


def date_isoformat(tdate, format=DATE_EXT_COMPLETE, yeardigits=4):
    """
    Format date strings.

    This method is just a wrapper around isodate.isostrf.strftime and uses
    Date-Extended-Complete as default format.
    """
    return strftime(tdate, format, yeardigits)
