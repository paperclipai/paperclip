"""
We model the hierarchy of basic datatypes using a class hierarchy.

`Derived datatypes <https://www.w3.org/TR/tabular-metadata/#derived-datatypes>`_ are implemented
via :class:`csvw.Datatype` which is
`composed of <https://realpython.com/inheritance-composition-python/#whats-composition>`_
a basic datatype and additional behaviour.

.. seealso:: http://w3c.github.io/csvw/metadata/#datatypes
"""
import re
import json as _json
import math
import base64
import typing
import decimal as _decimal
import binascii
import datetime
import warnings
import itertools
import collections

import isodate
import rfc3986
import dateutil.parser
import babel.numbers
import babel.dates
import jsonschema

if typing.TYPE_CHECKING:  # pragma: no cover
    import csvw

__all__ = ['DATATYPES']

DATATYPES = {}


def register(cls):
    DATATYPES[cls.name] = cls
    return cls


def to_binary(s, encoding='utf-8'):
    if not isinstance(s, bytes):
        return bytes(s, encoding=encoding)
    return s  # pragma: no cover


@register
class anyAtomicType:
    """
    A basic datatype consists of

    - a bag of attributes, most importantly a `name` which matches the name or alias of one of the \
      `CSVW built-in datatypes <https://www.w3.org/TR/tabular-metadata/#built-in-datatypes>`_
    - three staticmethods controlling marshalling and unmarshalling of Python objects to strings.

    Theses methods are orchestrated from :class:`csvw.Datatype` in its `read` and `formatted`
    methods.
    """
    name = 'any'
    minmax = False
    example = 'x'

    @classmethod
    def value_error(cls, v):
        raise ValueError('invalid lexical value for {}: {}'.format(cls.name, v))

    def __str__(self) -> str:
        return self.name

    @staticmethod
    def derived_description(datatype: "csvw.Datatype") -> dict:
        return {}

    @staticmethod
    def to_python(v: str, **kw) -> object:
        return v  # pragma: no cover

    @staticmethod
    def to_string(v: object, **kw) -> str:
        return '{}'.format(v)


@register
class string(anyAtomicType):
    """
    Maps to `str`.

        The lexical and value spaces of xs:string are the set of all possible strings composed of
        any character allowed in a XML 1.0 document without any treatment done on whitespaces.
    """
    name = 'string'

    @staticmethod
    def derived_description(datatype: "csvw.Datatype") -> dict:
        if datatype.format:
            # We wrap a regex specified as `format` property into a group and add `$` to
            # make sure the whole string is matched when validating.
            try:
                return {'regex': re.compile(r'({})$'.format(datatype.format))}
            except re.error:
                warnings.warn('Invalid regex pattern as datatype format')
        return {}

    @staticmethod
    def to_python(v, regex=None):
        if regex and not regex.match(v):
            string.value_error(v)
        return v


@register
class anyURI(string):
    """
    Maps to `rfc3986.URIReference`.

        This datatype corresponds normatively to the XLink href attribute. Its value space includes
        the URIs defined by the RFCs `2396 <https://datatracker.ietf.org/doc/html/rfc2396>`_ and
        `2732 <https://datatracker.ietf.org/doc/html/rfc2732>`_, but its lexical space doesn’t
        require the character escapes needed to include non-ASCII characters in URIs.

    .. note::

        We normalize URLs according to the rules in
        `RFC 3986 <https://datatracker.ietf.org/doc/html/rfc3986#section-6.2>`_ when serializing
        to `str`. Thus roundtripping isn't guaranteed.
    """
    name = 'anyURI'

    @staticmethod
    def to_python(v, regex=None):
        res = string.to_python(v, regex=regex)
        return rfc3986.URIReference.from_string(res.encode('utf-8'))

    @staticmethod
    def to_string(v, **kw):
        if hasattr(v, 'geturl'):
            # Presumably a `urllib.parse.ParseResult`.
            return v.geturl()
        if hasattr(v, 'unsplit'):
            # Presumable a `rfc3986.URIReference`
            return v.unsplit()
        assert isinstance(v, str)
        return rfc3986.normalize_uri(v)


@register
class NMTOKEN(string):
    """
    Maps to `str`

        The lexical and value spaces of xs:NMTOKEN are the set of XML 1.0 “name tokens,” i.e.,
        tokens composed of characters, digits, “.”, “:”, “-”, and the characters defined by Unicode,
        such as “combining” or “extender”.

        This type is usually called a “token.”

        Valid values include "Snoopy", "CMS", "1950-10-04", or "0836217462".

        Invalid values include "brought classical music to the Peanuts strip" (spaces are forbidden)
        or "bold,brash" (commas are forbidden).
    """
    name = "NMTOKEN"

    @staticmethod
    def to_python(v, regex=None):
        v = string.to_python(v, regex=regex)
        if not re.fullmatch(r'[\w.:-]*', v):
            NMTOKEN.value_error(v)
        return v


@register
class base64Binary(anyAtomicType):
    """
    Maps to `bytes`
    """
    name = 'base64Binary'
    example = 'YWJj'

    @staticmethod
    def to_python(v, **kw):
        try:
            res = to_binary(v, encoding='ascii')
        except UnicodeEncodeError:
            base64Binary.value_error(v[:10])
        try:
            res = base64.decodebytes(res)
        except Exception:
            raise ValueError('invalid base64 encoding')
        return res

    @staticmethod
    def to_string(v, **kw):
        return base64.encodebytes(v).decode().strip()


@register
class _binary(base64Binary):
    """
    Maps to `bytes`. Alias for :class:`base64Binary`
    """
    name = 'binary'


@register
class hexBinary(anyAtomicType):
    """
    Maps to `bytes`.

    .. note::

        We normalize to uppercase hex digits when seriializing to `str`. Thus, roundtripping is
        limited.
    """
    name = 'hexBinary'
    example = 'ab'

    @staticmethod
    def to_python(v, **kw):
        try:
            res = to_binary(v, encoding='ascii')
        except UnicodeEncodeError:
            hexBinary.value_error(v[:10])
        try:
            res = binascii.unhexlify(res)
        except (binascii.Error, TypeError):
            raise ValueError('invalid hexBinary encoding')
        return res

    @staticmethod
    def to_string(v, **kw):
        return binascii.hexlify(v).decode().upper()


@register
class boolean(anyAtomicType):
    """
    Maps to `bool`.

    .. code-block:: python

        >>> from csvw import Datatype
        >>> dt = Datatype.fromvalue({"base": "boolean", "format": "Yea|Nay"})
        >>> dt.read('Nay')
        False
        >>> dt.formatted(True)
        'Yea'

    .. seealso:: `<https://www.w3.org/TR/tabular-data-model/#formats-for-booleans>`_
    """

    name = 'boolean'
    example = 'false'

    @staticmethod
    def derived_description(datatype: "csvw.Datatype") -> dict:
        if datatype.format and isinstance(datatype.format, str) and datatype.format.count('|') == 1:
            true, false = [[v] for v in datatype.format.split('|')]
        else:
            if datatype.format and (
                    (not isinstance(datatype.format, str)) or (datatype.format.count('|') != 1)):
                warnings.warn('Invalid format spec for boolean')
            true, false = ['true', '1'], ['false', '0']
        return {'true': true, 'false': false}

    @staticmethod
    def to_python(s, true=('true', '1'), false=('false', '0')):
        if isinstance(s, bool) or s is None:
            return s
        if s in true:
            return True
        if s in false:
            return False
        raise boolean.value_error(s)

    @staticmethod
    def to_string(v, true=('true', '1'), false=('false', '0')):
        return (true if v else false)[0]


def with_tz(v, func, args, kw):
    tz_pattern = re.compile('(Z|[+-][0-2][0-9]:[0-5][0-9])$')
    tz = tz_pattern.search(v)
    if tz:
        v = v[:tz.start()]
        tz = tz.groups()[0]
    res = func(v, *args, **kw)
    if tz:
        dt = dateutil.parser.parse('{}{}'.format(datetime.datetime.now(), tz))
        res = datetime.datetime(
            res.year, res.month, res.day, res.hour, res.minute, res.second, res.microsecond,
            dt.tzinfo)
    return res


@register
class dateTime(anyAtomicType):
    """
    Maps to `datetime.datetime`.
    """
    name = 'datetime'
    minmax = True
    example = '2018-12-10T20:20:20'

    @staticmethod
    def derived_description(datatype: "csvw.Datatype") -> dict:
        return dt_format_and_regex(datatype.format)

    @staticmethod
    def _parse(v, cls, regex, tz_marker=None):
        v = v.strip()
        try:
            comps = regex.match(v).groupdict()
        except AttributeError:  # pragma: no cover
            dateTime.value_error(v)
        if comps.get('extramicroseconds'):
            raise ValueError('Extra microseconds')
        if comps.get('microsecond'):
            # We have to convert decimal fractions of seconds to microseconds.
            # This is done by first chopping off anything under 6 decimal places,
            # then (in case we got less precision) right-padding with 0 to get a
            # 6-digit number.
            comps['microsecond'] = comps['microsecond'][:6].ljust(6, '0')
        if cls == datetime.datetime and 'year' not in comps:
            d = datetime.date.today()
            for a in ['year', 'month', 'day']:
                comps[a] = getattr(d, a)
        res = cls(**{k: int(v) for k, v in comps.items() if v is not None})
        if tz_marker:
            # Let dateutils take care of parsing the timezone info:
            res = res.replace(tzinfo=dateutil.parser.parse(v).tzinfo)
        return res

    @staticmethod
    def to_python(v, regex=None, fmt=None, tz_marker=None, pattern=None):
        if pattern and regex:
            match = regex.match(v)
            if not match:
                raise ValueError('{} -- {} -- {}'.format(pattern, v, regex))  # pragma:
        try:
            return dateutil.parser.isoparse(v)
        except ValueError:
            return dateTime._parse(v, datetime.datetime, regex, tz_marker=tz_marker)

    @staticmethod
    def to_string(v, regex=None, fmt=None, tz_marker=None, pattern=None):
        if pattern:
            return babel.dates.format_datetime(v, tzinfo=v.tzinfo, format=pattern)
        return v.isoformat()


@register
class _dateTime(dateTime):
    """
    Maps to `datetime.datetime`. Alias for :class:`dateTime`
    """
    name = 'dateTime'


@register
class date(dateTime):
    """
    Maps to `datetime.datetime` (in order to be able to preserve timezone information).
    """
    name = 'date'
    example = '2018-12-10'

    @staticmethod
    def derived_description(datatype: "csvw.Datatype") -> dict:
        try:
            return dt_format_and_regex(datatype.format or 'yyyy-MM-dd')
        except ValueError:
            warnings.warn('Invalid date format')
            return dt_format_and_regex('yyyy-MM-dd')

    @staticmethod
    def to_python(v, regex=None, fmt=None, tz_marker=None, pattern=None):
        return with_tz(
            v.strip(), dateTime.to_python, [], dict(regex=regex, fmt=fmt, pattern=pattern))

    @staticmethod
    def to_string(v, regex=None, fmt=None, tz_marker=None, pattern=None):
        from babel.dates import format_date
        if pattern:
            return format_date(v, format=pattern, locale='en')
        return dateTime.to_string(v, regex=regex, fmt=fmt, tz_marker=tz_marker, pattern=pattern)


@register
class dateTimeStamp(dateTime):
    """
    Maps to `datetime.datetime`.
    """
    name = 'dateTimeStamp'
    example = '2018-12-10T20:20:20'

    @staticmethod
    def derived_description(datatype: "csvw.Datatype") -> dict:
        res = dt_format_and_regex(datatype.format or 'yyyy-MM-ddTHH:mm:ss.SSSSSSXXX')
        if not res['tz_marker']:
            raise ValueError('dateTimeStamp must have timezone marker')
        return res


@register
class _time(dateTime):
    """
    Maps to `datetime.datetime` (in order to be able to preserve timezone information).
    """
    name = 'time'
    example = '20:20:20'

    @staticmethod
    def derived_description(datatype: "csvw.Datatype") -> dict:
        return dt_format_and_regex(datatype.format or 'HH:mm:ss', no_date=True)

    @staticmethod
    def to_python(v, regex=None, fmt=None, tz_marker=None, pattern=None):
        if pattern and 'x' in pattern.lower():
            return dateutil.parser.parse('{}T{}'.format(datetime.date.today().isoformat(), v))
        assert regex is not None
        return with_tz(v, dateTime._parse, [datetime.datetime, regex], dict(tz_marker=tz_marker))

    @staticmethod
    def to_string(v, regex=None, fmt=None, tz_marker=None, pattern=None):
        return babel.dates.format_time(v, tzinfo=v.tzinfo, format=pattern)


@register
class duration(anyAtomicType):
    """
    Maps to `datetime.timedelta`.

    .. code-block: python

        >>> from csvw import Datatype
        >>> dt = Datatype.fromvalue("datetime")
        >>> duration = Datatype.fromvalue("duration")
        >>> dt.formatted(dt.read("2022-06-24T12:00:00") + duration.read("P1MT2H"))
        '2022-07-24T14:00:00'

    """
    name = 'duration'
    example = 'P3Y6M4DT12H30M5S'

    @staticmethod
    def derived_description(datatype: "csvw.Datatype") -> dict:
        return {'format': datatype.format}

    @staticmethod
    def to_python(v, format=None, **kw):
        if format and not re.match(format, v):
            raise ValueError
        return isodate.parse_duration(v)

    @staticmethod
    def to_string(v, format=None, **kw):
        return isodate.duration_isoformat(v)


@register
class dayTimeDuration(duration):
    """
    Maps to `datetime.timedelta`.
    """
    name = 'dayTimeDuration'


@register
class yearMonthDuration(duration):
    """
    Maps to `datetime.timedelta`.
    """
    name = 'yearMonthDuration'


@register
class decimal(anyAtomicType):
    """
    Maps to `decimal.Decimal`.

        xs:decimal is the datatype that represents the set of all the decimal numbers with
        arbitrary lengths. Its lexical space allows any number of insignificant leading and
        trailing zeros (after the decimal point).

        There is no support for scientific notations.

        Valid values include: "123.456", "+1234.456", "-1234.456", "-.456", or "-456".

        The following values would be invalid: [...] "1234.456E+2" (scientific notation ("E+2")
        is forbidden).

    XML-Schema restricts the lexical space by disallowing "thousand separator" and forcing the
    decimal separator to be ".". But these limitations can be overcome within CSVW using a
    `derived datatype <https://www.w3.org/TR/tabular-data-model/#formats-for-numeric-types>`_:

    .. code-block:: python

        >>> from csvw import Datatype
        >>> dt = Datatype.fromvalue(
        ...     {"base": "decimal", "format": {"groupChar": ".", "decimalChar": ","}})
        >>> dt.read("1.234,5")
        Decimal('1234.5')

    .. note::

        While mapping to `decimal.Decimal` rather than `float` makes handling of the Python object
        somewhat cumbersome, it makes sure we can roundtrip values correctly.
    """
    name = 'decimal'
    minmax = True
    example = '5'

    _special = {
        'INF': 'Infinity',
        '-INF': '-Infinity',
        'NaN': 'NaN',
    }
    _reverse_special = {v: k for k, v in _special.items()}

    @staticmethod
    def derived_description(datatype: "csvw.Datatype") -> dict:
        if datatype.format:
            return datatype.format if isinstance(datatype.format, dict) \
                else {'pattern': datatype.format}
        return {}

    @staticmethod
    def to_python(v, pattern=None, decimalChar=None, groupChar=None):
        if isinstance(v, str) and 'e' in v.lower():
            raise ValueError('Invalid value for decimal')

        if isinstance(v, str) and re.search('{0}{0}+'.format(re.escape(groupChar or ',')), v):
            raise ValueError('Invalid value for decimal')

        if groupChar is None and pattern and ',' in pattern:
            groupChar = ','
        if decimalChar is None and pattern and '.' in pattern:
            decimalChar = '.'
        if pattern and not NumberPattern(pattern).is_valid(
                v.replace(groupChar or ',', ',').replace(decimalChar or '.', '.')):
            raise ValueError(
                'Invalid value "{}" for decimal with pattern "{}"'.format(v, pattern))

        factor = 1
        if isinstance(v, str):
            if v in decimal._special:
                warnings.warn('Invalid special value for decimal')
                return _decimal.Decimal(decimal._special[v])
            if groupChar:
                v = v.replace(groupChar, '')
            if decimalChar and decimalChar != '.':
                v = v.replace(decimalChar, '.')
            for c, factor in [('%', _decimal.Decimal('0.01')), ('‰', _decimal.Decimal('0.001'))]:
                if c in v:
                    v = v.replace(c, '')
                    break
            else:
                factor = 1
        try:
            return _decimal.Decimal(v) * factor
        except (TypeError, _decimal.InvalidOperation):
            decimal.value_error(v)

    @staticmethod
    def to_string(v, pattern=None, decimalChar=None, groupChar=None):
        if '{}'.format(v) in decimal._reverse_special:
            return decimal._reverse_special['{}'.format(v)]

        if pattern:
            v = babel.numbers.format_decimal(v, pattern, 'en')
            if decimalChar:
                v = v.replace('.', decimalChar)
            if groupChar:
                v = v.replace(',', groupChar)
            return v

        fmt = '{}' if groupChar is None else '{:,}'
        try:
            neg = v < 0
        except TypeError:
            neg = None
        v = fmt.format(v)
        if 'e' in v.lower():  # detect scientific notation
            digits, exp = v.lower().split('e')
            digits = digits.replace('.', '').replace('-', '')
            exp = int(exp)
            zero_padding = '0' * (abs(int(exp)) - 1)
            sign = '-' if neg else ''
            return '{}{}{}.0'.format(sign, digits, zero_padding) if exp > 0 else (
                '{}0.{}{}'.format(sign, zero_padding, digits))

        if groupChar or decimalChar:
            def repl(m):
                if m.group('c') == ',':
                    return groupChar
                if m.group('c') == '.':
                    return decimalChar
            r = '(?P<c>[{}])'.format(re.escape((decimalChar or '') + (groupChar or '')))
            v = re.sub(r, repl, v)
        return v


@register
class integer(decimal):
    """
    Maps to `int`.
    """
    name = 'integer'
    range = None

    @classmethod
    def to_python(cls, v, **kw):
        res = decimal.to_python(v, **kw)
        numerator, denominator = res.as_integer_ratio()
        if denominator == 1:
            if cls.range and not (cls.range[0] <= numerator <= cls.range[1]):
                raise ValueError("{} must be an integer between {} and {}, but got ".format(
                    cls.name, cls.range[0], cls.range[1]), v)
            return numerator
        raise ValueError('Invalid value for integer')


@register
class _int(integer):
    """
    Maps to `int`. Alias for :class:`integer`.
    """
    name = 'int'


@register
class unsignedInt(integer):
    """
    Maps to `int`.

        The value space of xs:unsignedInt is the integers between 0 and 4294967295, i.e., the
        unsigned values that can fit in a word of 32 bits. Its lexical space allows an optional “+”
        sign and leading zeros before the significant digits.

        The decimal point (even when followed only by insignificant zeros) is forbidden.

        Valid values include "4294967295", "0", "+0000000000000000000005", or "1".

        Invalid values include "-1" and "1.".
    """
    name = 'unsignedInt'
    range = (0, 4294967295)


@register
class unsignedShort(integer):
    """
    Maps to `int`.

        The value space of xs:unsignedShort is the integers between 0 and 65535, i.e., the unsigned
        values that can fit in a word of 16 bits. Its lexical space allows an optional “+” sign and
        leading zeros before the significant digits.

        The decimal point (even when followed only by insignificant zeros) is forbidden.

        Valid values include "65535", "0", "+0000000000000000000005", or "1".

        Invalid values include "-1" and "1." .
    """
    name = 'unsignedShort'
    range = (0, 65535)


@register
class unsignedLong(integer):
    """
    Maps to `int`.

        The value space of xs:unsignedLong is the integers between 0 and 18446744073709551615, i.e.,
        the unsigned values that can fit in a word of 64 bits. Its lexical space allows an optional
        “+” sign and leading zeros before the significant digits.

        The decimal point (even when followed only by insignificant zeros) is forbidden.

        Valid values include "18446744073709551615", "0", "+0000000000000000000005", or "1".

        Invalid values include "-1" and "1.".
    """
    name = 'unsignedLong'
    range = (0, 18446744073709551615)


@register
class unsignedByte(integer):
    """
    Maps to `int`.

        The value space of xs:unsignedByte is the integers between 0 and 255, i.e., the unsigned
        values that can fit in a word of 8 bits. Its lexical space allows an optional “+” sign and
        leading zeros before the significant digits.

        The lexical space does not allow values expressed in other numeration bases (such as
        hexadecimal, octal, or binary).

        The decimal point (even when followed only by insignificant zeros) is forbidden.

        Valid values include "255", "0", "+0000000000000000000005", or "1".

        Invalid values include "-1" and "1.".
    """
    name = 'unsignedByte'
    range = (0, 255)


@register
class short(integer):
    """
    Maps to `int`.

        The value space of xs:short is the set of common short integers (16 bits), i.e., the
        integers between -32768 and 32767; its lexical space allows any number of insignificant
        leading zeros.

        The decimal point (even when followed only by insignificant zeros) is forbidden.

        Valid values include "-32768", "0", "-0000000000000000000005", or "32767".

        Invalid values include "32768" and "1.".
    """
    name = 'short'
    range = (-32768, 32767)


@register
class long(integer):
    """
    Maps to `int`.

        The value space of xs:long is the set of common double-size integers (64 bits), i.e., the
        integers between -9223372036854775808 and 9223372036854775807; its lexical space allows any
        number of insignificant leading zeros.

        The decimal point (even when followed only by insignificant zeros) is forbidden.

        Valid values for xs:long include "-9223372036854775808", "0", "-0000000000000000000005", or
        "9223372036854775807".

        Invalid values include "9223372036854775808" and "1.".
    """
    name = 'long'
    range = (-9223372036854775808, 9223372036854775807)


@register
class byte(integer):
    """
    Maps to `int`.

        The value space of xs:byte is the integers between -128 and 127, i.e., the signed values
        that can fit in a word of 8 bits. Its lexical space allows an optional sign and leading
        zeros before the significant digits.

        The lexical space does not allow values expressed in other numeration bases (such as
        hexadecimal, octal, or binary).

        Valid values for byte include 27, -34, +105, and 0.

        Invalid values include 0A, 1524, and INF.
    """
    name = 'byte'
    range = (-128, 127)


@register
class nonNegativeInteger(integer):
    """
    Maps to `int`.
    """
    name = 'nonNegativeInteger'
    range = (0, math.inf)


@register
class positiveInteger(integer):
    """
    Maps to `int`.
    """
    name = 'positiveInteger'
    range = (1, math.inf)


@register
class nonPositiveInteger(integer):
    """
    Maps to `int`.
    """
    name = 'nonPositiveInteger'
    example = '-5'
    range = (-math.inf, 0)


@register
class negativeInteger(integer):
    """
    Maps to `int`.
    """
    name = 'negativeInteger'
    example = '-5'
    range = (-math.inf, -1)


@register
class _float(anyAtomicType):
    """
    Maps to `float`.

    .. note::

        Due to the well known issues with representing floating point numbers, roundtripping may
        not work correctly.

    .. seealso:: `<https://docs.python.org/3/tutorial/floatingpoint.html>`_
    """
    name = 'float'
    minmax = True
    example = '5.3'

    @staticmethod
    def derived_description(datatype: "csvw.Datatype") -> dict:
        if datatype.format:
            return datatype.format if isinstance(datatype.format, dict) \
                else {'pattern': datatype.format}
        return {}

    @staticmethod
    def to_python(v, pattern=None, **kw):
        if pattern and not NumberPattern(pattern).is_valid(v):
            raise ValueError(
                'Invalid value "{}" for number with pattern "{}"'.format(v, pattern))

        try:
            return float(v)
        except (TypeError, ValueError):
            _float.value_error(v)

    @staticmethod
    def to_string(v, **kw):
        return '{}'.format(v)


@register
class number(_float):
    """
    Maps to `float`.
    """
    name = 'number'


@register
class double(_float):
    """
    Maps to `float`.
    """
    name = 'double'


@register
class normalizedString(string):
    """
    Maps to `str`.

        The lexical space of xs:normalizedString is unconstrained (any valid XML character may be
        used), and its value space is the set of strings after whitespace replacement (i.e., after
        any occurrence of #x9 (tab), #xA (linefeed), and #xD (carriage return) have been replaced
        by an occurrence of #x20 (space) without any whitespace collapsing).

    .. note::

        The CSVW test suite (specifically in `test036 <https://w3c.github.io/csvw/tests/#test036>`_
        and `test037 <https://w3c.github.io/csvw/tests/#test037>`_) requires that `normalizedString`
        is also trimmed, i.e. stripped from leading and trailing whitespace. So that's we do.
    """
    name = 'normalizedString'

    @staticmethod
    def to_python(v, regex=None):
        if v:
            for c in '\r\n\t':
                v = v.replace(c, ' ')
            v = v.strip()
        return string.to_python(v, '')


@register
class QName(string):
    """
    Maps to `str`.
    """
    name = 'QName'


@register
class gDay(string):
    """
    Maps to `str`.
    """
    name = 'gDay'


@register
class gMonth(string):
    """
    Maps to `str`.
    """
    name = 'gMonth'


@register
class gMonthDay(string):
    """
    Maps to `str`.
    """
    name = 'gMonthDay'


@register
class gYear(string):
    """
    Maps to `str`.
    """
    name = 'gYear'


@register
class gYearMonth(string):
    """
    Maps to `str`.
    """
    name = 'gYearMonth'


@register
class xml(string):
    """
    Maps to `str`.
    """
    name = 'xml'


@register
class html(string):
    """
    Maps to `str`.
    """
    name = 'html'


@register
class json(string):
    """
    Maps to `str`, `list` or `dict`, i.e. to the result of `json.loads`.

    .. code-block:: python

        >>> from csvw import Datatype
        >>> dt = Datatype.fromvalue("json")
        >>> d = dt.read("{}")
        >>> d["a"] = '123'
        >>> dt.formatted(d)
        '{"a": "123"}'

    Additional constraints on JSON data can be imposed by specifying
    `JSON Schema <https://json-schema.org/>`_ documents as `format` annotation:

    .. code-block:: python

        >>> from csvw import Datatype
        >>> dt = Datatype.fromvalue({"base": "json", "format": '{"type": "object"}'})
        >>> dt.read('{}')
        OrderedDict()
        >>> dt.read('4')
        ...
        jsonschema.exceptions.ValidationError: 4 is not of type 'object'
        ...
        ValueError: invalid lexical value for json: 4

    .. note::

        To ensure proper roundtripping, we load the JSON strings using the
        `object_pairs_hook=collections.OrderedDict` keyword.
    """
    name = 'json'
    example = '{"a": [1,2]}'

    @staticmethod
    def derived_description(datatype: "csvw.Datatype") -> dict:
        if datatype.format:
            try:
                schema = _json.loads(datatype.format)
                try:
                    jsonschema.validate({}, schema=schema)
                    return {'schema': schema}
                except jsonschema.ValidationError:
                    return {'schema': schema}
                except jsonschema.SchemaError:
                    warnings.warn('Invalid JSON schema as datatype format')
            except _json.JSONDecodeError:
                pass
        return {}

    # FIXME: ignored **kw?
    # why not just to_python = staticmethod(_json.loads)?
    @staticmethod
    def to_python(v, schema=None, **kw):
        res = _json.loads(v, object_pairs_hook=collections.OrderedDict)
        if schema:
            try:
                jsonschema.validate(res, schema=schema)
            except jsonschema.ValidationError:
                json.value_error(v)
        return res

    @staticmethod
    def to_string(v, **kw):
        return _json.dumps(v)


def dt_format_and_regex(fmt, no_date=False):
    """

    .. seealso:: http://w3c.github.io/csvw/syntax/#formats-for-dates-and-times
    """
    if fmt is None:
        return {'fmt': None, 'tz_marker': None, 'regex': None, 'pattern': None}

    if isinstance(fmt, dict) and list(fmt.keys()) == ['pattern']:
        fmt = fmt['pattern']

    pattern = fmt

    # First, we strip off an optional timezone marker:
    tz_marker = None
    match = re.search('(?P<marker> ?[xX]{1,3})$', fmt)
    if match:
        tz_marker = match.group('marker')
        if len(set(tz_marker.strip())) != 1:  # mixing x and X is not allowed!
            raise ValueError(fmt)
        fmt = fmt[:match.start()]

    date_patterns = {
        "yyyy-MM-dd",  # e.g., 2015-03-22
        "yyyyMMdd",  # e.g., 20150322
        "dd-MM-yyyy",  # e.g., 22-03-2015
        "d-M-yyyy",  # e.g., 22-3-2015
        "MM-dd-yyyy",  # e.g., 03-22-2015
        "M-d-yyyy",  # e.g., 3-22-2015
        "dd/MM/yyyy",  # e.g., 22/03/2015
        "d/M/yyyy",  # e.g., 22/3/2015
        "MM/dd/yyyy",  # e.g., 03/22/2015
        "M/d/yyyy",  # e.g., 3/22/2015
        "dd.MM.yyyy",  # e.g., 22.03.2015
        "d.M.yyyy",  # e.g., 22.3.2015
        "MM.dd.yyyy",  # e.g., 03.22.2015
        "M.d.yyyy",  # e.g., 3.22.2015
    }

    time_patterns = {"HH:mm:ss", "HHmmss", "HH:mm", "HHmm"}

    # We map dateTime component markers to corresponding fromat specs and regular
    # expressions used for formatting and parsing.
    translate = {
        'yyyy': ('{dt.year:04d}', '(?P<year>[0-9]{4})'),
        'MM': ('{dt.month:02d}', '(?P<month>[0-9]{2})'),
        'dd': ('{dt.day:02d}', '(?P<day>[0-9]{2})'),
        'M': ('{dt.month}', '(?P<month>[0-9]{1,2})'),
        'd': ('{dt.day}', '(?P<day>[0-9]{1,2})'),
        'HH': ('{dt.hour:02d}', '(?P<hour>[0-9]{2})'),
        'mm': ('{dt.minute:02d}', '(?P<minute>[0-9]{2})'),
        'ss': ('{dt.second:02d}', '(?P<second>[0-9]{2})'),
    }

    for dt_sep in ' T':  # Only a single space or "T" may separate date and time format.
        # Since space or "T" isn't allowed anywhere else in the format, checking whether
        # we are dealing with a date or dateTime format is simple:
        if dt_sep in fmt:
            break
    else:
        dt_sep = None

    if dt_sep:
        dfmt, tfmt = fmt.split(dt_sep)
    elif no_date:
        dfmt, tfmt = None, fmt
    else:
        dfmt, tfmt = fmt, None

    msecs = None  # The maximal number of decimal places for fractions of seconds.
    if tfmt and '.' in tfmt:  # There is a microseconds marker.
        tfmt, msecs = tfmt.split('.')  # Strip it off ...
        if set(msecs) != {'S'}:  # ... make sure it's valid ...
            raise ValueError(fmt)
        msecs = len(msecs)   # ... and store it's length.

    # Now we can check whether the bare date and time formats are valid:
    if (dfmt and dfmt not in date_patterns) or (tfmt and tfmt not in time_patterns):
        raise ValueError(fmt)

    regex, format = '', ''  # Initialize the output.

    if dfmt:
        for d_sep in '.-/':  # Determine the separator used for date components.
            if d_sep in dfmt:
                break
        else:
            d_sep = None

        if d_sep:
            # Iterate over date components, converting them to string format specs and regular
            # expressions.
            for i, part in enumerate(dfmt.split(d_sep)):
                if i > 0:
                    format += d_sep
                    regex += re.escape(d_sep)
                f, r = translate[part]
                format += f
                regex += r
        else:
            for _, chars in itertools.groupby(dfmt, lambda k: k):
                f, r = translate[''.join(chars)]
                format += f
                regex += r

    if dt_sep:
        format += dt_sep
        regex += re.escape(dt_sep)

    if tfmt:
        # For time components the only valid separator is ":".
        if ':' in tfmt:
            for i, part in enumerate(tfmt.split(':')):
                if i > 0:
                    format += ':'
                    regex += re.escape(':')
                f, r = translate[part]
                format += f
                regex += r
        else:
            for _, chars in itertools.groupby(tfmt, lambda k: k):
                f, r = translate[''.join(chars)]
                format += f
                regex += r

    # Fractions of seconds are a bit of a problem, because datetime objects only offer
    # microseconds.
    if msecs:
        format += '.{microsecond:.%s}' % msecs
        regex += r'(\.(?P<microsecond>[0-9]{1,%s})(?![0-9]))?' % msecs
        regex += r'(\.(?P<extramicroseconds>[0-9]{%s,})(?![0-9]))?' % (msecs + 1,)

    return {'regex': re.compile(regex), 'fmt': format, 'tz_marker': tz_marker, 'pattern': pattern}


class NumberPattern:
    """
    Implementations MUST recognise number format patterns containing the symbols 0, #, the specified
    decimalChar (or "." if unspecified), the specified groupChar (or "," if unspecified), E, +, %
    and ‰.

    The number of # placeholder characters before the decimal do not matter, since no limit is
    placed on the maximum number of digits. There should, however, be at least one zero someplace
    in the pattern.
    """

    def __init__(self, pattern):
        assert pattern.count(';') <= 1
        self.positive, _, self.negative = pattern.partition(';')
        if not self.negative:
            self.negative = '-' + self.positive.replace('+', '')

    @property
    def primary_grouping_size(self):
        comps = self.positive.split('.')[0].split(',')
        if len(comps) > 1:
            return comps[-1].count('#') + comps[-1].count('0')

    @property
    def secondary_grouping_size(self):
        comps = self.positive.split('.')[0].split(',')
        if len(comps) > 2:
            return comps[1].count('#') + comps[1].count('0')
        return self.primary_grouping_size

    @property
    def min_digits_before_decimal_point(self):
        integral_part = self.positive.split('.')[0]
        match = re.search('([0]+)$', integral_part)
        if match:
            return len(match.groups()[0])

    @property
    def exponent_digits(self):
        _, _, exponent = self.positive.lower().partition('e')
        i = 0
        for c in exponent:
            if c in '0#':
                i += 1
            elif c in ',':
                continue
            else:
                break
        return i

    @property
    def decimal_digits(self):
        i = 0
        _, _, decimal_part = self.positive.partition('.')
        for c in decimal_part:
            if c in '#0':
                i += 1
            if c == 'E':
                break
        return i

    @property
    def significant_decimal_digits(self):
        i = 0
        _, _, decimal_part = self.positive.partition('.')
        for c in decimal_part:
            if c == '0':
                i += 1
            if c in ['E', '#']:
                break
        return i

    def is_valid(self, s):
        def digits(ss):
            return [c for c in ss if c not in '.,E+-%‰']

        integral_part, _, decimal_part = s.partition('.')
        decimal_part, _, exponent = decimal_part.lower().partition('e')
        groups = integral_part.split(',')
        significant, leadingzero, skip = [], False, True
        for c in ''.join(groups):
            if c in ['+', '-', '%',  # fixme: permil
                     ]:
                continue
            if c == '0' and skip:
                leadingzero = True
                continue
            if c != '0':
                skip = False
            significant.append(c)
        if not significant and leadingzero:
            significant = ['0']
        if self.min_digits_before_decimal_point and \
                len(significant) < self.min_digits_before_decimal_point:
            return False
        if self.primary_grouping_size and groups:
            if len(digits(groups[-1])) > self.primary_grouping_size:
                return False
            if len(groups) > 1 and len(digits(groups[-1])) < self.primary_grouping_size:
                return False
        if self.secondary_grouping_size and len(groups) > 1:
            for i, group in enumerate(groups[:-1]):
                if i == 0:
                    if len(digits(group)) > self.secondary_grouping_size:
                        return False
                else:
                    if len(digits(group)) != self.secondary_grouping_size:
                        return False
        if decimal_part:
            if len(digits(decimal_part)) > self.decimal_digits:
                return False
        if self.significant_decimal_digits:
            if (not decimal_part) or (len(digits(decimal_part)) < self.significant_decimal_digits):
                return False

        if self.exponent_digits and 'e' in s.lower():
            if len(digits(s.lower().split('e')[-1])) > self.exponent_digits:
                return False

        return True
