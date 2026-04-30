try:
    import pytz
except ModuleNotFoundError:
    pytz = None

try:
    import zoneinfo
except ModuleNotFoundError:
    zoneinfo = None


def _get_tzinfo(tzenv: str):
    """Get the tzinfo from `zoneinfo` or `pytz`

    :param tzenv: timezone in the form of Continent/City
    :return: tzinfo object or None if not found
    """
    if pytz:
        try:
            return pytz.timezone(tzenv)
        except pytz.UnknownTimeZoneError:
            pass
    else:
        try:
            return zoneinfo.ZoneInfo(tzenv)
        except ValueError as ve:
            # This is somewhat hacky, but since _validate_tzfile_path() doesn't
            # raise a specific error type, we'll need to check the message to be
            # one we know to be from that function.
            # If so, we pretend it meant that the TZ didn't exist, for the benefit
            # of `babel.localtime` catching the `LookupError` raised by
            # `_get_tzinfo_or_raise()`.
            # See https://github.com/python-babel/babel/issues/1092
            if str(ve).startswith("ZoneInfo keys "):
                return None
        except zoneinfo.ZoneInfoNotFoundError:
            pass

    return None


def _get_tzinfo_or_raise(tzenv: str):
    tzinfo = _get_tzinfo(tzenv)
    if tzinfo is None:
        raise LookupError(
            f"Can not find timezone {tzenv}. \n"
            "Timezone names are generally in the form `Continent/City`.",
        )
    return tzinfo


def _get_tzinfo_from_file(tzfilename: str):
    with open(tzfilename, 'rb') as tzfile:
        if pytz:
            return pytz.tzfile.build_tzinfo('local', tzfile)
        else:
            return zoneinfo.ZoneInfo.from_file(tzfile)
