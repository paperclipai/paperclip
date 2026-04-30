"""
DSV data can be surprisingly diverse. While Python's `csv` module offers out-of-the-box support
for the basic formatting parameters, CSVW recognizes a couple more, like `skipColumns` or
`skipRows`.

.. seealso::

    - `<https://www.w3.org/TR/2015/REC-tabular-metadata-20151217/#dialect-descriptions>`_
    - `<https://docs.python.org/3/library/csv.html#dialects-and-formatting-parameters>`_
    - `<https://specs.frictionlessdata.io/csv-dialect/>`_
"""
import attr
import warnings
import functools

from . import utils

__all__ = ['Dialect']

ENCODING_MAP = {
    'UTF-8-BOM': 'utf-8-sig',  # Recognize the name of this encoding in R.
}


# FIXME: replace with attrs.validators.ge(0) from attrs 21.3.0
def _non_negative(instance, attribute, value):
    if value < 0:  # pragma: no cover
        raise ValueError('{0} is not a valid {1}'.format(value, attribute.name))


non_negative_int = [attr.validators.instance_of(int), _non_negative]


def convert_encoding(s):
    s = utils.converter(str, 'utf-8', s)
    try:
        _ = 'x'.encode(ENCODING_MAP.get(s, s))
        return s
    except LookupError:
        warnings.warn('Invalid value for property: {}'.format(s))
        return 'utf-8'


@attr.s
class Dialect(object):
    """
    A CSV dialect specification.

    .. seealso:: `<https://www.w3.org/TR/2015/REC-tabular-metadata-20151217/#dialect-descriptions>`_
    """

    encoding = attr.ib(
        default='utf-8',
        converter=convert_encoding,
        validator=attr.validators.instance_of(str))

    lineTerminators = attr.ib(
        converter=functools.partial(utils.converter, list, ['\r\n', '\n']),
        default=attr.Factory(lambda: ['\r\n', '\n']))

    quoteChar = attr.ib(
        converter=functools.partial(utils.converter, str, '"', allow_none=True),
        default='"',
    )

    doubleQuote = attr.ib(
        default=True,
        converter=functools.partial(utils.converter, bool, True),
        validator=attr.validators.instance_of(bool))

    skipRows = attr.ib(
        default=0,
        converter=functools.partial(utils.converter, int, 0, cond=lambda s: s >= 0),
        validator=non_negative_int)

    commentPrefix = attr.ib(
        default='#',
        converter=functools.partial(utils.converter, str, '#', allow_none=True),
        validator=attr.validators.optional(attr.validators.instance_of(str)))

    header = attr.ib(
        default=True,
        converter=functools.partial(utils.converter, bool, True),
        validator=attr.validators.instance_of(bool))

    headerRowCount = attr.ib(
        default=1,
        converter=functools.partial(utils.converter, int, 1, cond=lambda s: s >= 0),
        validator=non_negative_int)

    delimiter = attr.ib(
        default=',',
        converter=functools.partial(utils.converter, str, ','),
        validator=attr.validators.instance_of(str))

    skipColumns = attr.ib(
        default=0,
        converter=functools.partial(utils.converter, int, 0, cond=lambda s: s >= 0),
        validator=non_negative_int)

    skipBlankRows = attr.ib(
        default=False,
        converter=functools.partial(utils.converter, bool, False),
        validator=attr.validators.instance_of(bool))

    skipInitialSpace = attr.ib(
        default=False,
        converter=functools.partial(utils.converter, bool, False),
        validator=attr.validators.instance_of(bool))

    trim = attr.ib(
        default='false',
        validator=attr.validators.in_(['true', 'false', 'start', 'end']),
        converter=lambda v: functools.partial(
            utils.converter,
            (str, bool), 'false')('{0}'.format(v).lower() if isinstance(v, bool) else v))

    def updated(self, **kw):
        res = self.__class__(**attr.asdict(self))
        for k, v in kw.items():
            setattr(res, k, v)
        return res

    @functools.cached_property
    def escape_character(self):
        return None if self.quoteChar is None else ('"' if self.doubleQuote else '\\')

    @functools.cached_property
    def line_terminators(self):
        return [self.lineTerminators] \
            if isinstance(self.lineTerminators, str) else self.lineTerminators

    @functools.cached_property
    def trimmer(self):
        return {
            'true': lambda s: s.strip(),
            'false': lambda s: s,
            'start': lambda s: s.lstrip(),
            'end': lambda s: s.rstrip()
        }[self.trim]

    def asdict(self, omit_defaults=True):
        return utils.attr_asdict(self, omit_defaults=omit_defaults)

    @property
    def python_encoding(self):
        return ENCODING_MAP.get(self.encoding, self.encoding)

    def as_python_formatting_parameters(self):
        return {
            'delimiter': self.delimiter,
            'doublequote': self.doubleQuote,
            # We have to hack around incompatible ways escape char is interpreted in csvw
            # and python's csv lib:
            'escapechar': self.escape_character if not self.doubleQuote else None,
            'lineterminator': self.line_terminators[0],
            'quotechar': self.quoteChar,
            'skipinitialspace': self.skipInitialSpace,
            'strict': True,
        }
