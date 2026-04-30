# metadata.py

"""Functionality to read and write metadata for CSV files.

This module implements (partially) the W3C recommendation
"Metadata Vocabulary for Tabular Data".

.. seealso:: https://www.w3.org/TR/tabular-metadata/
"""
import io
import re
import json
import shutil
import decimal
import pathlib
import typing
import zipfile
import operator
import warnings
import functools
import itertools
import contextlib
import collections
from urllib.parse import urljoin, urlparse, urlunparse

from language_tags import tags
import attr
import requests
import uritemplate

from . import utils
from .datatypes import DATATYPES
from .dsv import Dialect as BaseDialect, UnicodeReaderWithLineNumber, UnicodeWriter
from .frictionless import DataPackage
from . import jsonld

DEFAULT = object()

__all__ = [
    'TableGroup',
    'Table', 'Column', 'ForeignKey',
    'Link', 'NaturalLanguage',
    'Datatype',
    'is_url',
    'CSVW',
]

NAMESPACES = {
    'csvw': 'http://www.w3.org/ns/csvw#',
    'rdf': 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    'rdfs': 'http://www.w3.org/2000/01/rdf-schema#',
    'xsd': 'http://www.w3.org/2001/XMLSchema#',
    'dc': 'http://purl.org/dc/terms/',
    'dcat': 'http://www.w3.org/ns/dcat#',
    'prov': 'http://www.w3.org/ns/prov#',
    'schema': 'http://schema.org/',
    "as": "https://www.w3.org/ns/activitystreams#",
    "cc": "http://creativecommons.org/ns#",
    "ctag": "http://commontag.org/ns#",
    "dc11": "http://purl.org/dc/elements/1.1/",
    "dctypes": "http://purl.org/dc/dcmitype/",
    "dqv": "http://www.w3.org/ns/dqv#",
    "duv": "https://www.w3.org/ns/duv#",
    "foaf": "http://xmlns.com/foaf/0.1/",
    "gr": "http://purl.org/goodrelations/v1#",
    "grddl": "http://www.w3.org/2003/g/data-view#",
    "ical": "http://www.w3.org/2002/12/cal/icaltzd#",
    "jsonld": "http://www.w3.org/ns/json-ld#",
    "ldp": "http://www.w3.org/ns/ldp#",
    "ma": "http://www.w3.org/ns/ma-ont#",
    "oa": "http://www.w3.org/ns/oa#",
    "odrl": "http://www.w3.org/ns/odrl/2/",
    "og": "http://ogp.me/ns#",
    "org": "http://www.w3.org/ns/org#",
    "owl": "http://www.w3.org/2002/07/owl#",
    "qb": "http://purl.org/linked-data/cube#",
    "rdfa": "http://www.w3.org/ns/rdfa#",
    "rev": "http://purl.org/stuff/rev#",
    "rif": "http://www.w3.org/2007/rif#",
    "rr": "http://www.w3.org/ns/r2rml#",
    "sd": "http://www.w3.org/ns/sparql-service-description#",
    "sioc": "http://rdfs.org/sioc/ns#",
    "skos": "http://www.w3.org/2004/02/skos/core#",
    "skosxl": "http://www.w3.org/2008/05/skos-xl#",
    "sosa": "http://www.w3.org/ns/sosa/",
    "ssn": "http://www.w3.org/ns/ssn/",
    "time": "http://www.w3.org/2006/time#",
    "v": "http://rdf.data-vocabulary.org/#",
    "vcard": "http://www.w3.org/2006/vcard/ns#",
    "void": "http://rdfs.org/ns/void#",
    "wdr": "http://www.w3.org/2007/05/powder#",
    "wrds": "http://www.w3.org/2007/05/powder-s#",
    "xhv": "http://www.w3.org/1999/xhtml/vocab#",
    "xml": "http://www.w3.org/XML/1998/namespace",
}
CSVW_TERMS = """Cell
Column
Datatype
Dialect
Direction
ForeignKey
JSON
NumericFormat
Row
Schema
Table
TableGroup
TableReference
Transformation
aboutUrl
base
columnReference
columns
commentPrefix
datatype
decimalChar
default
delimiter
describes
dialect
doubleQuote
encoding
foreignKeys
format
groupChar
header
headerRowCount
json
lang
length
lineTerminators
maxExclusive
maxInclusive
maxLength
maximum
minExclusive
minInclusive
minLength
minimum
name
notes
null
ordered
pattern
primaryKey
propertyUrl
quoteChar
reference
referencedRows
required
resource
row
rowTitles
rownum
schemaReference
scriptFormat
separator
skipBlankRows
skipColumns
skipInitialSpace
skipRows
source
suppressOutput
tableDirection
tableSchema
tables
targetFormat
textDirection
titles
transformations
trim
uriTemplate
url
valueUrl
virtual""".split()
is_url = utils.is_url


class Invalid:
    pass


INVALID = Invalid()


@attr.s
class Dialect(BaseDialect):
    """
    The spec is ambiguous regarding a default for the commentPrefix property:

    > commentPrefix
    >     An atomic property that sets the comment prefix flag to the single provided value, which
    >     MUST be a string. The default is "#".

    vs.

    > comment prefix
    >     A string that, when it appears at the beginning of a row, indicates that the row is a
    >     comment that should be associated as a rdfs:comment annotation to the table. This is set
    >     by the commentPrefix property of a dialect description. The default is null, which means
    >     no rows are treated as comments. A value other than null may mean that the source numbers
    >     of rows are different from their numbers.

    So, in order to pass the number formatting tests, with column names like `##.#`, we chose
    the second reading - i.e. by default no rows are treated as comments.
    """
    commentPrefix = attr.ib(
        default=None,
        converter=functools.partial(utils.converter, str, None, allow_none=True),
        validator=attr.validators.optional(attr.validators.instance_of(str)))


def json_open(filename, mode='r', encoding='utf-8'):
    assert encoding == 'utf-8'
    return io.open(filename, mode, encoding=encoding)


def get_json(fname) -> typing.Union[list, dict]:
    fname = str(fname)
    if is_url(fname):
        return requests.get(fname).json(object_pairs_hook=collections.OrderedDict)
    with json_open(fname) as f:
        return json.load(f, object_pairs_hook=collections.OrderedDict)


def log_or_raise(msg, log=None, level='warning', exception_cls=ValueError):
    if log:
        getattr(log, level)(msg)
    else:
        raise exception_cls(msg)


def nolog(level='warning'):
    from types import MethodType

    class Log(object):
        pass

    log = Log()
    setattr(log, level, MethodType(lambda *args, **kw: None, log))
    return log


class URITemplate(uritemplate.URITemplate):

    def __eq__(self, other):
        if isinstance(other, str):
            return self.uri == other
        if not hasattr(other, 'uri'):
            return False
        return super(URITemplate, self).__eq__(other)

    def asdict(self, **kw):
        return '{}'.format(self)


def uri_template_property():
    """

    Note: We do not currently provide support for supplying the "_" variables like "_row"
    when expanding a URI template.

    .. seealso:: http://w3c.github.io/csvw/metadata/#uri-template-properties
    """
    def converter_uriTemplate(v):
        if v is None:
            return None
        if not isinstance(v, str):
            warnings.warn('Invalid value for aboutUrl property')
            return INVALID
        return URITemplate(v)

    return attr.ib(
        default=None,
        validator=attr.validators.optional(attr.validators.instance_of((URITemplate, Invalid))),
        converter=converter_uriTemplate)


class Link:
    """

    .. seealso:: http://w3c.github.io/csvw/metadata/#link-properties
    """

    def __init__(self, string: typing.Union[str, pathlib.Path]):
        if not isinstance(string, (str, pathlib.Path)):
            raise ValueError('Invalid value for link property')
        self.string = string

    def __str__(self):
        return self.string

    def asdict(self, omit_defaults=True):
        return self.string

    def __eq__(self, other):
        # FIXME: Only naive, un-resolved comparison is supported at the moment.
        return self.string == other.string if isinstance(other, Link) else False

    def resolve(self, base):
        """
        Resolve a `Link` relative to `base`.

        :param base:
        :return: Either a string, representing a URL, or a `pathlib.Path` object, representing \
        a local file.
        """
        if hasattr(base, 'joinpath'):
            if is_url(self.string):
                return self.string
            return (base if base.is_dir() else base.parent) / self.string
        return urljoin(base, self.string)


def link_property(required=False):
    return attr.ib(
        default=None,
        validator=attr.validators.optional(attr.validators.instance_of(Link)),
        converter=lambda v: v if v is None else Link(v))


class NaturalLanguage(collections.OrderedDict):
    """

    .. seealso:: http://w3c.github.io/csvw/metadata/#natural-language-properties
    """

    def __init__(self, value):
        super(NaturalLanguage, self).__init__()
        self.value = value
        if isinstance(self.value, str):
            self[None] = [self.value]
        elif isinstance(self.value, (list, tuple)):
            if not all(isinstance(v, str) for v in self.value):
                warnings.warn('titles with array values containing non-string values are ignored')
            else:
                self[None] = list(self.value)
        elif isinstance(self.value, dict):
            for k, v in self.value.items():
                if not tags.check(k):
                    raise ValueError('Invalid language tag for NaturalLanguage')
                if not isinstance(v, (list, tuple)):
                    v = [v]
                titles = []
                for vv in v:
                    if isinstance(vv, str):
                        titles.append(vv)
                    else:
                        warnings.warn('Title with value which is not a string is ignored')
                self[k] = titles
        else:
            raise ValueError('invalid value type for NaturalLanguage')

    def asdict(self, omit_defaults=True):
        if list(self) == [None]:
            if len(self[None]) == 1:
                return self.getfirst()
            return self[None]
        return collections.OrderedDict(
            ('und' if k is None else k, v[0] if len(v) == 1 else v)
            for k, v in self.items())

    def add(self, string, lang=None):
        if lang not in self:
            self[lang] = []
        self[lang].append(string)

    def __str__(self):
        return self.getfirst() or next(iter(self.values()))[0]

    def getfirst(self, lang=None):
        return self.get(lang, [None])[0]


def valid_id_property(v):
    if not isinstance(v, str):
        warnings.warn('Inconsistent link property')
        return None
    if v.startswith('_'):
        raise ValueError('Invalid @id property: {}'.format(v))
    return v


def valid_common_property(v):
    if isinstance(v, dict):
        if not {k[1:] for k in v if k.startswith('@')}.issubset(
                {'id', 'language', 'type', 'value'}):
            raise ValueError(
                "Aside from @value, @type, @language, and @id, the properties used on an object "
                "MUST NOT start with @.")
        if '@value' in v:
            if len(v) > 1:
                if len(v) > 2 \
                        or set(v.keys()) not in [{'@value', '@language'}, {'@value', '@type'}] \
                        or not isinstance(v['@value'], (str, bool, int, decimal.Decimal)):
                    raise ValueError(
                        "If a @value property is used on an object, that object MUST NOT have "
                        "any other properties aside from either @type or @language, and MUST "
                        "NOT have both @type and @language as properties. The value of the "
                        "@value property MUST be a string, number, or boolean value.")
        if '@language' in v and '@value' not in v:
            raise ValueError(
                "A @language property MUST NOT be used on an object unless it also has a "
                "@value property.")
        if '@id' in v:
            v['@id'] = valid_id_property(v['@id'])
        if '@language' in v:
            if not (isinstance(v['@language'], str) and tags.check(v['@language'])):
                warnings.warn('Invalid language tag')
                del v['@language']
        if '@type' in v:
            vv = v['@type']
            if isinstance(vv, str):
                if vv.startswith('_:'):
                    raise ValueError(
                        'The value of any @id or @type contained within a metadata document '
                        'MUST NOT be a blank node.')
                if not is_url(vv) and \
                        not any(vv == ns or vv.startswith(ns + ':') for ns in NAMESPACES) and \
                        vv not in CSVW_TERMS:
                    raise ValueError(
                        'The value of any member of @type MUST be either a term defined in '
                        '[csvw-context], a prefixed name where the prefix is a term defined in '
                        '[csvw-context], or an absolute URL.')
            elif not isinstance(vv, (list, dict)):
                raise ValueError('Invalid datatype for @type')
        return {k: valid_common_property(vv) for k, vv in v.items()}
    if isinstance(v, list):
        return [valid_common_property(vv) for vv in v]
    return v


@attr.s
class DescriptionBase:
    """Container for
    - common properties (see http://w3c.github.io/csvw/metadata/#common-properties)
    - @-properties.
    """

    common_props = attr.ib(default=attr.Factory(dict))
    at_props = attr.ib(default=attr.Factory(dict))

    @classmethod
    def partition_properties(cls,
                             d: typing.Union[dict, typing.Any],
                             type_name: typing.Optional[str] = None,
                             strict=True) -> typing.Union[dict, None]:
        if d and not isinstance(d, dict):
            return
        fields = attr.fields_dict(cls)
        type_name = type_name or cls.__name__
        c, a, dd = {}, {}, {}
        for k, v in (d or {}).items():
            if k.startswith('@'):
                if k == '@id':
                    v = valid_id_property(v)
                if k == '@type' and v != type_name:
                    raise ValueError('Invalid @type property {} for {}'.format(v, type_name))
                a[k[1:]] = v
            elif ':' in k:
                c[k] = valid_common_property(v)
            else:
                if strict and (k not in fields):
                    warnings.warn('Invalid property {} for {}'.format(k, type_name))
                else:
                    dd[k] = v
        return dict(common_props=c, at_props=a, **dd)

    @classmethod
    def fromvalue(cls, d: dict):
        return cls(**cls.partition_properties(d))

    def _iter_dict_items(self, omit_defaults):
        def _asdict_single(v):
            return v.asdict(omit_defaults=omit_defaults) if hasattr(v, 'asdict') else v

        def _asdict_multiple(v):
            if isinstance(v, (list, tuple)):
                return [_asdict_single(vv) for vv in v]
            return _asdict_single(v)

        for k, v in sorted(self.at_props.items()):
            yield '@' + k, _asdict_multiple(v)

        for k, v in sorted(self.common_props.items()):
            yield k, _asdict_multiple(v)

        for k, v in utils.attr_asdict(self, omit_defaults=omit_defaults).items():
            if k not in ('common_props', 'at_props'):
                yield k, _asdict_multiple(v)

    def asdict(self, omit_defaults=True) -> dict:
        # Note: The `null` property is the only inherited, list-valued property where the default
        # is not the empty list. Thus, to allow setting it to empty, we must treat `null` as
        # special case here.
        # See also https://www.w3.org/TR/tabular-metadata/#dfn-inherited-property
        return collections.OrderedDict(
            (k, v) for k, v in self._iter_dict_items(omit_defaults)
            if (k == 'null' or (v not in ([], {}))))


def optional_int():
    return attr.ib(
        default=None,
        validator=attr.validators.optional(attr.validators.instance_of(int)),
        converter=lambda v: v if v is None else int(v))


@attr.s
class Datatype(DescriptionBase):
    """
    A datatype description

        Cells within tables may be annotated with a datatype which indicates the type of the values
        obtained by parsing the string value of the cell.

    .. seealso:: `<https://www.w3.org/TR/tabular-metadata/#datatypes>`_
    """

    base = attr.ib(
        default=None,
        converter=functools.partial(
            utils.converter,
            str, 'string', allow_none=True, cond=lambda ss: ss is None or ss in DATATYPES),
        validator=attr.validators.optional(attr.validators.in_(DATATYPES)))
    format = attr.ib(default=None)
    length = optional_int()
    minLength = optional_int()
    maxLength = optional_int()
    minimum = attr.ib(default=None)
    maximum = attr.ib(default=None)
    minInclusive = attr.ib(default=None)
    maxInclusive = attr.ib(default=None)
    minExclusive = attr.ib(default=None)
    maxExclusive = attr.ib(default=None)

    @classmethod
    def fromvalue(cls, v: typing.Union[str, dict, 'Datatype']) -> 'Datatype':
        """
        :param v: Initialization data for `cls`; either a single string that is the main datatype \
        of the values of the cell or a datatype description object, i.e. a `dict` or a `cls` \
        instance.
        :return: An instance of `cls`
        """
        if isinstance(v, str):
            return cls(base=v)

        if isinstance(v, dict):
            v.setdefault('base', 'string')
            return cls(**cls.partition_properties(v))

        if isinstance(v, cls):
            return v

        raise ValueError(v)

    def __attrs_post_init__(self):
        for attr_ in [
            'minimum', 'maximum', 'minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive'
        ]:
            if getattr(self, attr_) is not None:
                setattr(self, attr_, self.parse(getattr(self, attr_)))

        if self.length is not None:
            if self.minLength is not None and self.length < self.minLength:
                raise ValueError('minLength > length')

            if self.maxLength is not None:
                if self.length > self.maxLength:
                    raise ValueError('maxLength < length')

        if self.minLength is not None and self.maxLength is not None \
                and self.minLength > self.maxLength:
            raise ValueError('minLength > maxLength')

        if not isinstance(self.derived_description, dict):
            raise ValueError()  # pragma: no cover

        if not isinstance(
                self.basetype(),
                tuple((DATATYPES[name] for name in ['decimal', 'float', 'datetime', 'duration']))):
            if any([getattr(self, at) for at in
                    'minimum maximum minExclusive maxExclusive minInclusive maxInclusive'.split()]):
                raise ValueError(
                    'Applications MUST raise an error if minimum, minInclusive, maximum, '
                    'maxInclusive, minExclusive, or maxExclusive are specified and the base '
                    'datatype is not a numeric, date/time, or duration type.')

        if not isinstance(
                self.basetype(),
                (DATATYPES['string'], DATATYPES['base64Binary'], DATATYPES['hexBinary'])):
            if self.length or self.minLength or self.maxLength:
                raise ValueError(
                    'Applications MUST raise an error if length, maxLength, or minLength are '
                    'specified and the base datatype is not string or one of its subtypes, or a '
                    'binary type.')

        if (self.minInclusive and self.minExclusive) or (self.maxInclusive and self.maxExclusive):
            raise ValueError(
                'Applications MUST raise an error if both minInclusive and minExclusive are '
                'specified, or if both maxInclusive and maxExclusive are specified.')

        if (self.minInclusive and self.maxExclusive and self.maxExclusive <= self.minInclusive) or \
                (self.minInclusive and self.maxInclusive and self.maxInclusive < self.minInclusive):
            raise ValueError('')

        if (self.minExclusive and self.maxExclusive and self.maxExclusive <= self.minExclusive) or (
                self.minExclusive and self.maxInclusive and self.maxInclusive <= self.minExclusive):
            raise ValueError('')

        if 'id' in self.at_props and any(
                self.at_props['id'] == NAMESPACES['xsd'] + dt for dt in DATATYPES):
            raise ValueError('datatype @id MUST NOT be the URL of a built-in datatype.')

        if isinstance(self.basetype(), DATATYPES['decimal']) and \
                'pattern' in self.derived_description:
            if not set(self.derived_description['pattern']).issubset(set('#0.,;%‰E-+')):
                self.format = None
                warnings.warn('Invalid number pattern')

    def asdict(self, omit_defaults=True):
        res = DescriptionBase.asdict(self, omit_defaults=omit_defaults)
        for attr_ in [
            'minimum', 'maximum', 'minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive'
        ]:
            if attr_ in res:
                res[attr_] = self.formatted(res[attr_])
        if len(res) == 1 and 'base' in res:
            return res['base']
        return res

    @property
    def basetype(self):
        return DATATYPES[self.base]

    @property
    def derived_description(self):
        return self.basetype.derived_description(self)

    def formatted(self, v):
        return self.basetype.to_string(v, **self.derived_description)

    def parse(self, v):
        if v is None:
            return v
        return self.basetype.to_python(v, **self.derived_description)

    def validate(self, v):
        if v is None:
            return v
        try:
            l_ = len(v or '')
            if self.length is not None and l_ != self.length:
                raise ValueError('value must have length {}'.format(self.length))
            if self.minLength is not None and l_ < self.minLength:
                raise ValueError('value must have at least length {}'.format(self.minLength))
            if self.maxLength is not None and l_ > self.maxLength:
                raise ValueError('value must have at most length {}'.format(self.maxLength))
        except TypeError:
            pass
        if self.basetype.minmax:
            if self.minimum is not None and v < self.minimum:
                raise ValueError('value must be >= {}'.format(self.minimum))
            if self.minInclusive is not None and v < self.minInclusive:
                raise ValueError('value must be >= {}'.format(self.minInclusive))
            if self.minExclusive is not None and v <= self.minExclusive:
                raise ValueError('value must be > {}'.format(self.minExclusive))
            if self.maximum is not None and v > self.maximum:
                raise ValueError('value must be <= {}'.format(self.maximum))
            if self.maxInclusive is not None and v > self.maxInclusive:
                raise ValueError('value must be <= {}'.format(self.maxInclusive))
            if self.maxExclusive is not None and v >= self.maxExclusive:
                raise ValueError('value must be < {}'.format(self.maxExclusive))
        return v

    def read(self, v):
        return self.validate(self.parse(v))


def converter_null(v):
    res = [] if v is None else (v if isinstance(v, list) else [v])
    if not all(isinstance(vv, str) for vv in res):
        warnings.warn('Invalid null property')
        return [""]
    return res


def converter_lang(v):
    if not tags.check(v):
        warnings.warn('Invalid language tag')
        return 'und'
    return v


@attr.s
class Description(DescriptionBase):
    """Adds support for inherited properties.

    .. seealso:: http://w3c.github.io/csvw/metadata/#inherited-properties
    """

    # To be able to resolve inheritance chains, we also provide a place to store a
    # reference to the containing object. Note that this attribute is ignored when judging
    # equality between objects. Thus, identically specified columns of different tables will be
    # considered equal.
    _parent = attr.ib(default=None, repr=False, eq=False)

    aboutUrl = uri_template_property()
    datatype = attr.ib(
        default=None,
        converter=lambda v: v if not v else Datatype.fromvalue(v))
    default = attr.ib(
        default="",
        converter=functools.partial(utils.converter, str, "", allow_list=False),
    )
    lang = attr.ib(default="und", converter=converter_lang)
    null = attr.ib(default=attr.Factory(lambda: [""]), converter=converter_null)
    ordered = attr.ib(
        default=None,
        converter=functools.partial(utils.converter, bool, False, allow_none=True),
    )
    propertyUrl = uri_template_property()
    required = attr.ib(default=None)
    separator = attr.ib(
        converter=functools.partial(utils.converter, str, None, allow_none=True),
        default=None,
    )
    textDirection = attr.ib(
        default=None,
        converter=functools.partial(
            utils.converter,
            str, None, allow_none=True, cond=lambda v: v in [None, "ltr", "rtl", "auto", "inherit"])
    )
    valueUrl = uri_template_property()

    def inherit(self, attr):
        v = getattr(self, attr)
        if v is None and self._parent:
            return self._parent.inherit(attr) if hasattr(self._parent, 'inherit') \
                else getattr(self._parent, attr)
        return v

    def inherit_null(self):
        if self.null == [""]:
            if self._parent and hasattr(self._parent, 'inherit_null'):
                return self._parent.inherit_null()
        return self.null


def converter_titles(v):
    try:
        return v if v is None else NaturalLanguage(v)
    except ValueError:
        warnings.warn('Invalid titles property')
        return None


@attr.s
class Column(Description):
    """
    A column description is an object that describes a single column.

        The description provides additional human-readable documentation for a column, as well as
        additional information that may be used to validate the cells within the column, create a
        user interface for data entry, or inform conversion into other formats.

    .. seealso:: `<https://www.w3.org/TR/tabular-metadata/#columns>`_
    """
    name = attr.ib(
        default=None,
        converter=functools.partial(utils.converter, str, None, allow_none=True)
    )
    suppressOutput = attr.ib(
        default=False,
        converter=functools.partial(utils.converter, bool, False))
    titles = attr.ib(
        default=None,
        validator=attr.validators.optional(attr.validators.instance_of(NaturalLanguage)),
        converter=converter_titles)
    virtual = attr.ib(default=False, converter=functools.partial(utils.converter, bool, False))
    _number = attr.ib(default=None, repr=False)

    def __str__(self):
        return self.name or \
            (self.titles and self.titles.getfirst()) or \
            '_col.{}'.format(self._number)

    def has_title(self, v):
        if self.name and self.name == v:
            return True
        for tag, titles in (self.titles or {}).items():
            if v in titles:
                return tag or 'und'
        return False

    @property
    def header(self):
        return '{}'.format(self)

    def read(self, v, strict=True):
        required = self.inherit('required')
        null = self.inherit_null()
        default = self.inherit('default')
        separator = self.inherit('separator')
        datatype = self.inherit('datatype')

        if not v:
            v = default

        if required and v in null:
            if not strict:
                warnings.warn('required column value is missing')
            raise ValueError('required column value is missing')

        if separator:
            if not v:
                v = []
            elif v in null:
                v = None
            else:
                v = (vv or default for vv in v.split(separator))
                v = [None if vv in null else vv for vv in v]
        elif v in null:
            v = None

        if datatype:
            if isinstance(v, list):
                try:
                    return [datatype.read(vv) for vv in v]
                except ValueError:
                    if not strict:
                        warnings.warn('Invalid value for list element.')
                        return v
                    raise
            return datatype.read(v)
        return v

    def write(self, v):
        sep = self.inherit('separator')
        null = self.inherit_null()
        datatype = self.inherit('datatype')

        def fmt(v):
            if v is None:
                return null[0]
            if datatype:
                return datatype.formatted(v)
            return v

        if sep:
            return sep.join(fmt(vv) for vv in v or [])
        return fmt(v)


def column_reference():
    return attr.ib(
        default=None,
        validator=attr.validators.optional(attr.validators.instance_of(list)),
        converter=lambda v: v if isinstance(v, list) or v is None else [v])


@attr.s
class Reference:

    resource = link_property()
    schemaReference = link_property()
    columnReference = column_reference()

    def __attrs_post_init__(self):
        if self.resource is not None and self.schemaReference is not None:
            raise ValueError(self)


@attr.s
class ForeignKey:

    columnReference = column_reference()
    reference = attr.ib(default=None)

    @classmethod
    def fromdict(cls, d):
        if isinstance(d, dict):
            try:
                _ = Reference(**d['reference'])
            except TypeError:
                raise ValueError('Invalid reference property')
            if not set(d.keys()).issubset({'columnReference', 'reference'}):
                raise ValueError('Invalid foreignKey spec')
        kw = dict(d, reference=Reference(**d['reference']))
        return cls(**kw)

    def asdict(self, **kw):
        res = utils.attr_asdict(self, **kw)
        res['reference'] = utils.attr_asdict(res['reference'], **kw)
        return res


def converter_foreignKeys(v):
    res = []
    for d in functools.partial(utils.converter, dict, None)(v):
        try:
            res.append(ForeignKey.fromdict(d))
        except TypeError:
            warnings.warn('Invalid foreignKeys spec')
    return res


@attr.s
class Schema(Description):
    """
    A schema description is an object that encodes the information about a schema, which describes
    the structure of a table.

    :ivar columns: `list` of :class:`Column` descriptions.
    :ivar foreignKeys: `list` of :class:`ForeignKey` descriptions.

    .. seealso:: `<https://www.w3.org/TR/tabular-metadata/#schemas>`_
    """
    columns = attr.ib(
        default=attr.Factory(list),
        converter=lambda v: [
            Column.fromvalue(c) for c in functools.partial(utils.converter, dict, None)(
                functools.partial(utils.converter, list, [])(v))])
    foreignKeys = attr.ib(
        default=attr.Factory(list),
        converter=lambda v: [] if v is None else converter_foreignKeys(v))
    primaryKey = column_reference()
    rowTitles = attr.ib(
        default=attr.Factory(list),
        converter=lambda v: v if isinstance(v, list) else [v],
    )

    def __attrs_post_init__(self):
        virtual, seen, names = False, set(), set()
        for i, col in enumerate(self.columns):
            if col.name and (col.name.startswith('_') or re.search(r'\s', col.name)):
                warnings.warn('Invalid column name')
            if col.virtual:  # first virtual column sets the flag
                virtual = True
            elif virtual:  # non-virtual column after virtual column!
                raise ValueError('no non-virtual column allowed after virtual columns')
            if not virtual:
                if col.header in seen:
                    warnings.warn('Duplicate column name!')
                if col.name:
                    if col.name in names:
                        raise ValueError('Duplicate column name {}'.format(col.name))
                    names.add(col.name)
                seen.add(col.header)
            col._parent = self
            col._number = i + 1
        for colref in self.primaryKey or []:
            col = self.columndict.get(colref)
            if col and not col.name:
                warnings.warn('A primaryKey referenced column MUST have a `name` property')
                self.primaryKey = None

    @classmethod
    def fromvalue(cls, v):
        if isinstance(v, str):
            try:
                # The schema is referenced with a URL
                v = requests.get(v).json()
            except:  # pragma: no cover # noqa: E722
                return v
        if not isinstance(v, dict):
            if isinstance(v, int):
                warnings.warn('Invalid value for tableSchema property')
            v = {}
        return cls(**cls.partition_properties(v))

    @property
    def columndict(self):
        return {c.header: c for c in self.columns}

    def get_column(self, name, strict=False):
        col = self.columndict.get(name)
        assert (not strict) or (col and col.name)
        if not col:
            for c in self.columns:
                if c.titles and c.titles.getfirst() == name:
                    return c
                if c.propertyUrl and c.propertyUrl.uri == name:
                    return c
        return col


def dialect_props(d):
    if not isinstance(d, dict):
        warnings.warn('Invalid dialect spec')
        return {}
    partitioned = Description.partition_properties(d, type_name='Dialect', strict=False)
    del partitioned['at_props']
    del partitioned['common_props']
    if partitioned.get('headerRowCount'):
        partitioned['header'] = True
    return partitioned


def valid_transformations(instance, attribute, value):
    if not isinstance(value, list):
        warnings.warn('Invalid transformations property')
    for tr in value:
        Description.partition_properties(tr, type_name='Template')


@attr.s
class TableLike(Description):
    """
    A CSVW description object as encountered "in the wild", i.e. identified by URL on the web or
    as file on disk.

    Since `TableLike` objects may be instantiated from "externally referenced" objects
    (via file paths or URLs), they have the necessary means to resolve
    `link properties <https://www.w3.org/TR/tabular-metadata/#link-properties>`_

    .. code-block:: python

        >>> from csvw import Table, TableGroup, Link
        >>> t = Table.from_file('tests/fixtures/csv.txt-table-metadata.json')
        >>> Link('abc.txt').resolve(t.base)
        PosixPath('tests/fixtures/abc.txt')
        >>> tg = TableGroup.from_url(
        ...     'https://raw.githubusercontent.com/cldf/csvw/master/tests/fixtures/'
        ...     'csv.txt-metadata.json')
        >>> str(tg.tables[0].url)
        'csv.txt'
        >>> tg.tables[0].url.resolve(tg.base)
        'https://raw.githubusercontent.com/cldf/csvw/master/tests/fixtures/csv.txt'

    and `URI template properties <https://www.w3.org/TR/tabular-metadata/#uri-template-properties>`_
    (see :meth:`~TableLike.expand`).
    """
    dialect = attr.ib(
        default=None,
        converter=lambda v: v if (v is None or isinstance(v, str))
        else Dialect(**dialect_props(v)))
    notes = attr.ib(default=attr.Factory(list))
    tableDirection = attr.ib(
        default='auto',
        converter=functools.partial(
            utils.converter, str, 'auto', cond=lambda s: s in ['rtl', 'ltr', 'auto']),
        validator=attr.validators.in_(['rtl', 'ltr', 'auto']))
    tableSchema = attr.ib(
        default=None,
        converter=lambda v: Schema.fromvalue(v))
    transformations = attr.ib(
        validator=valid_transformations,
        default=attr.Factory(list),
    )
    url = link_property()
    _fname = attr.ib(default=None)  # The path of the metadata file.

    def __attrs_post_init__(self):
        if isinstance(self.dialect, str):
            self.dialect = Dialect(**dialect_props(get_json(Link(self.dialect).resolve(self.base))))
        if self.tableSchema and not (isinstance(self.tableSchema, str)):
            self.tableSchema._parent = self
        if 'id' in self.at_props and self.at_props['id'] is None:
            self.at_props['id'] = self.base
        ctx = self.at_props.get('context')
        if isinstance(ctx, list):
            for obj in ctx:
                if (isinstance(obj, dict) and not set(obj.keys()).issubset({'@base', '@language'}))\
                        or (isinstance(obj, str) and obj != 'http://www.w3.org/ns/csvw'):
                    raise ValueError(
                        'The @context MUST have one of the following values: An array composed '
                        'of a string followed by an object, where the string is '
                        'http://www.w3.org/ns/csvw and the object represents a local context '
                        'definition, which is restricted to contain either or both of'
                        '@base and @language.')
                if isinstance(obj, dict) and '@language' in obj:
                    if not tags.check(obj['@language']):
                        warnings.warn('Invalid value for @language property')
                        del obj['@language']

    def get_column(self, spec):
        return self.tableSchema.get_column(spec) if self.tableSchema else None

    @classmethod
    def from_file(cls, fname: typing.Union[str, pathlib.Path], data=None) -> 'TableLike':
        """
        Instantiate a CSVW Table or TableGroup description from a metadata file.
        """
        if is_url(str(fname)):
            return cls.from_url(str(fname), data=data)
        res = cls.fromvalue(data or get_json(fname))
        res._fname = pathlib.Path(fname)
        return res

    @classmethod
    def from_url(cls, url: str, data=None) -> 'TableLike':
        """
        Instantiate a CSVW Table or TableGroup description from a metadata file specified by URL.
        """
        data = data or get_json(url)
        url = urlparse(url)
        data.setdefault('@base', urlunparse((url.scheme, url.netloc, url.path, '', '', '')))
        for table in data.get('tables', [data]):
            if isinstance(table, dict) and isinstance(table.get('tableSchema'), str):
                table['tableSchema'] = Link(table['tableSchema']).resolve(data['@base'])
        res = cls.fromvalue(data)
        return res

    def to_file(self, fname: typing.Union[str, pathlib.Path], omit_defaults=True) -> pathlib.Path:
        """
        Write a CSVW Table or TableGroup description as JSON object to a local file.

        :param omit_defaults: The CSVW spec specifies defaults for most properties of most \
        description objects. If `omit_defaults==True`, these properties will be pruned from \
        the JSON object.
        """
        fname = utils.ensure_path(fname)
        data = self.asdict(omit_defaults=omit_defaults)
        with json_open(str(fname), 'w') as f:
            json.dump(data, f, indent=4, separators=(',', ': '))
        return fname

    @property
    def base(self) -> typing.Union[str, pathlib.Path]:
        """
        The "base" to resolve relative links against.
        """
        at_props = self._parent.at_props if self._parent else self.at_props
        ctxbase = None
        for obj in self.at_props.get('context', []):
            if isinstance(obj, dict) and '@base' in obj:
                ctxbase = obj['@base']
        if 'base' in at_props:
            if ctxbase:
                # If present, its value MUST be a string that is interpreted as a URL which is
                # resolved against the location of the metadata document to provide the
                # **base URL** for other URLs in the metadata document.
                return Link(ctxbase).resolve(at_props['base'])
            return at_props['base']
        return self._parent._fname.parent if (self._parent and self._parent._fname) else \
            (self._fname.parent if self._fname else None)

    def expand(self, tmpl: URITemplate, row: dict, _row, _name=None, qname=False) -> str:
        """
        Expand a `URITemplate` using `row`, `_row` and `_name` as context and resolving the result
        against `TableLike.url`.

        .. code-block:: python

            >>> from csvw import URITemplate, TableGroup
            >>> tg = TableGroup.from_url(
            ...     'https://raw.githubusercontent.com/cldf/csvw/master/tests/fixtures/'
            ...     'csv.txt-metadata.json')
            >>> tg.expand(URITemplate('/path?{a}{#b}'), dict(a='1', b='2'), None)
            'https://raw.githubusercontent.com/path?1#2'

        """
        if tmpl is INVALID:
            return self.url.resolve(self.base)

        for prefix, url in NAMESPACES.items():
            if tmpl.uri.startswith(prefix + ':'):
                # If the URI Template is a QName, we expand it to a URL to prevent `Link.resolve`
                # from turning it into a local path.
                res = '{}{}'.format(url, tmpl.uri.split(':')[1])
                break
        else:
            res = Link(
                tmpl.expand(
                    _row=_row,
                    _name=_name,
                    **{_k: _v for _k, _v in row.items() if isinstance(_k, str)}
                )).resolve(self.url.resolve(self.base) if self.url else self.base)
        if not isinstance(res, pathlib.Path):
            if qname:
                for prefix, url in NAMESPACES.items():
                    if res.startswith(url):
                        res = res.replace(url, prefix + ':')
                        break
        return res


@attr.s
class Table(TableLike):
    """
    A table description is an object that describes a table within a CSV file.

    `Table` objects provide access to schema manipulation either by manipulating the `tableSchema`
    property directly or via higher-level methods like :meth:`~Table.add_foreign_key`

    `Table` objects also mediate read/write access to the actual data through

    - :meth:`~Table.write`
    - :meth:`~Table.iterdicts`

    .. seealso:: `<https://www.w3.org/TR/tabular-metadata/#tables>`_
    """
    suppressOutput = attr.ib(default=False)
    _comments = []

    def add_foreign_key(self, colref, ref_resource, ref_colref):
        """
        Add a foreign key constraint to `tableSchema.foreignKeys`.

        :param colref: Column reference for the foreign key.
        :param ref_resource: Referenced table.
        :param ref_colref: Column reference of the key in the referenced table.
        """
        colref = [colref] if not isinstance(colref, (tuple, list)) else colref
        if not all(col in [c.name for c in self.tableSchema.columns] for col in colref):
            raise ValueError('unknown column in foreignKey {0}'.format(colref))

        self.tableSchema.foreignKeys.append(ForeignKey.fromdict({
            'columnReference': colref,
            'reference': {'resource': ref_resource, 'columnReference': ref_colref}
        }))

    def __attrs_post_init__(self):
        TableLike.__attrs_post_init__(self)
        if not self.url:
            raise ValueError('url property is required for Tables')

    @property
    def local_name(self) -> typing.Union[str, None]:
        return self.url.string if self.url else None

    def _get_dialect(self) -> Dialect:
        return self.dialect or (self._parent and self._parent.dialect) or Dialect()

    def write(self,
              items: typing.Iterable[typing.Union[dict, list, tuple]],
              fname: typing.Optional[typing.Union[str, pathlib.Path]] = DEFAULT,
              base: typing.Optional[typing.Union[str, pathlib.Path]] = None,
              strict: typing.Optional[bool] = False,
              _zipped: typing.Optional[bool] = False) -> typing.Union[str, int]:
        """
        Write row items to a CSV file according to the table schema.

        :param items: Iterator of `dict` storing the data per row.
        :param fname: Name of the file to which to write the data.
        :param base: Base directory relative to which to interpret table urls.
        :param strict: Flag signaling to use strict mode when writing. This will raise `ValueError`\
        if any row (dict) passed in `items` contains unspecified fieldnames.
        :param _zipped: Flag signaling whether the resulting data file should be zipped.
        :return: The CSV content if `fname==None` else the number of rows written.
        """
        dialect = self._get_dialect()
        non_virtual_cols = [c for c in self.tableSchema.columns if not c.virtual]
        if fname is DEFAULT:
            fname = self.url.resolve(pathlib.Path(base) if base else self.base)

        rowcount = 0
        with UnicodeWriter(fname, dialect=dialect) as writer:
            if dialect.header:
                writer.writerow([c.header for c in non_virtual_cols])
            for item in items:
                if isinstance(item, (list, tuple)):
                    row = [col.write(item[i]) for i, col in enumerate(non_virtual_cols)]
                else:
                    if strict:
                        add = set(item.keys()) - {'{}'.format(col) for col in non_virtual_cols}
                        if add:
                            raise ValueError("dict contains fields not in fieldnames: {}".format(
                                ', '.join("'{}'".format(field) for field in add)))
                    row = [
                        col.write(item.get(
                            col.header, item.get('{}'.format(col))))
                        for col in non_virtual_cols]
                rowcount += 1
                writer.writerow(row)
            if fname is None:
                return writer.read()
        if fname and _zipped:
            fpath = pathlib.Path(fname)
            with zipfile.ZipFile(
                str(fpath.parent.joinpath(fpath.name + '.zip')),
                'w',
                compression=zipfile.ZIP_DEFLATED
            ) as zipf:
                zipf.write(str(fpath), arcname=fpath.name)
            fpath.unlink()
        return rowcount

    def check_primary_key(self, log=None, items=None) -> bool:
        success = True
        if items is not None:
            warnings.warn('the items argument of check_primary_key '
                          'is deprecated (its content will be ignored)')  # pragma: no cover
        if self.tableSchema.primaryKey:
            get_pk = operator.itemgetter(*self.tableSchema.primaryKey)
            seen = set()
            # Read all rows in the table, ignoring errors:
            for fname, lineno, row in self.iterdicts(log=nolog(), with_metadata=True):
                pk = get_pk(row)
                if pk in seen:
                    log_or_raise(
                        '{0}:{1} duplicate primary key: {2}'.format(fname, lineno, pk),
                        log=log)
                    success = False
                else:
                    seen.add(pk)
        return success

    def __iter__(self):
        return self.iterdicts()

    def iterdicts(
            self,
            log=None,
            with_metadata=False,
            fname=None,
            _Row=collections.OrderedDict,
            strict=True,
    ) -> typing.Generator[dict, None, None]:
        """Iterate over the rows of the table

        Create an iterator that maps the information in each row to a `dict` whose keys are
        the column names of the table and whose values are the values in the corresponding
        table cells, or for virtual columns (which have no values) the valueUrl for that
        column. This includes columns not specified in the table specification.

        Note: If the resolved data filename does not exist - but there is a zip file of the form
        `fname+'.zip'`, we try to read the data from this file after unzipping.

        :param log: Logger object (default None) The object that reports parsing errors.\
        If none is given, parsing errors raise ValueError instead.
        :param bool with_metadata: (default False) Also yield fname and lineno
        :param fname: file-like, pathlib.Path, or str (default None)\
        The file to be read. Defaults to inheriting from a parent object, if one exists.
        :param strict: Flag signaling whether data is read strictly - i.e. raising `ValueError` \
        when invalid data is encountered - or not - i.e. only issueing a warning and returning \
        invalid data as `str` as provided by the undelying DSV reader.
        :return: A generator of dicts or triples (fname, lineno, dict) if with_metadata
        """
        dialect = self._get_dialect()
        fname = fname or self.url.resolve(self.base)
        colnames, virtualcols, requiredcols = [], [], set()
        for col in self.tableSchema.columns:
            if col.virtual:
                if col.valueUrl:
                    virtualcols.append((col.header, col.valueUrl))
            else:
                colnames.append(col.header)
            if col.required:
                requiredcols.add(col.header)

        with contextlib.ExitStack() as stack:
            if is_url(fname):
                handle = io.TextIOWrapper(
                    io.BytesIO(requests.get(str(fname)).content), encoding=dialect.encoding)
            else:
                handle = fname
                fpath = pathlib.Path(fname)
                if not fpath.exists():
                    zipfname = fpath.parent.joinpath(fpath.name + '.zip')
                    if zipfname.exists():
                        zipf = stack.enter_context(zipfile.ZipFile(str(zipfname)))
                        handle = io.TextIOWrapper(
                            zipf.open([n for n in zipf.namelist() if n.endswith(fpath.name)][0]),
                            encoding=dialect.encoding)

            reader = stack.enter_context(UnicodeReaderWithLineNumber(handle, dialect=dialect))
            reader = iter(reader)

            # If the data file has a header row, this row overrides the header as
            # specified in the metadata.
            if dialect.header:
                try:
                    _, header = next(reader)
                    if not strict:
                        if self.tableSchema.columns and len(self.tableSchema.columns) < len(header):
                            warnings.warn('Column number mismatch')
                        for name, col in zip(header, self.tableSchema.columns):
                            res = col.has_title(name)
                            if (not col.name) and not res:
                                warnings.warn('Incompatible table models')
                            if isinstance(res, str) and res.split('-')[0] not in [
                                    'und', (self.lang or 'und').split('-')[0]]:
                                warnings.warn('Incompatible column titles')
                except StopIteration:  # pragma: no cover
                    return
            else:
                header = colnames

            # If columns in the data are ordered as in the spec, we can match values to
            # columns by index, rather than looking up columns by name.
            if (header == colnames) or \
                    (len(self.tableSchema.columns) >= len(header) and not strict):
                # Note that virtual columns are only allowed to come **after** regular ones,
                # so we can simply zip the whole columns list, and silently ignore surplus
                # virtual columns.
                header_cols = list(zip(header, self.tableSchema.columns))
            elif not strict and self.tableSchema.columns and \
                    (len(self.tableSchema.columns) < len(header)):
                header_cols = []
                for i, cname in enumerate(header):
                    try:
                        header_cols.append((cname, self.tableSchema.columns[i]))
                    except IndexError:
                        header_cols.append((
                            '_col.{}'.format(i + 1),
                            Column.fromvalue({'name': '_col.{}'.format(i + 1)})))
            else:
                header_cols = [(h, self.tableSchema.get_column(h)) for h in header]
            header_cols = [(j, h, c) for j, (h, c) in enumerate(header_cols)]
            missing = requiredcols - set(c.header for j, h, c in header_cols if c)
            if missing:
                raise ValueError('{0} is missing required columns {1}'.format(fname, missing))

            for lineno, row in reader:
                required = {h: j for j, h, c in header_cols if c and c.required}
                res = _Row()
                error = False
                if (not header_cols) and row:
                    header_cols = [
                        (i,
                         '_col.{}'.format(i + 1),
                         Column.fromvalue({'name': '_col.{}'.format(i + 1)}))
                        for i, _ in enumerate(row)]
                for (j, k, col), v in zip(header_cols, row):
                    # see http://w3c.github.io/csvw/syntax/#parsing-cells
                    if col:
                        try:
                            res[col.header] = col.read(v, strict=strict)
                        except ValueError as e:
                            if not strict:
                                warnings.warn(
                                    'Invalid column value: {} {}; {}'.format(v, col.datatype, e))
                                res[col.header] = v
                            else:
                                log_or_raise(
                                    '{0}:{1}:{2} {3}: {4}'.format(fname, lineno, j + 1, k, e),
                                    log=log)
                                error = True
                        if k in required:
                            del required[k]
                    else:
                        if strict:
                            warnings.warn(
                                'Unspecified column "{0}" in table {1}'.format(k, self.local_name))
                        res[k] = v

                for k, j in required.items():
                    if k not in res:
                        log_or_raise(
                            '{0}:{1}:{2} {3}: {4}'.format(
                                fname, lineno, j + 1, k, 'required column value is missing'),
                            log=log)
                        error = True

                # Augment result with regular columns not provided in the data:
                for key in colnames:
                    res.setdefault(key, None)

                # Augment result with virtual columns:
                for key, valueUrl in virtualcols:
                    res[key] = valueUrl.expand(**res)

                if not error:
                    if with_metadata:
                        yield fname, lineno, res
                    else:
                        yield res
        self._comments = reader.comments


def converter_tables(v):
    res = []
    for vv in v:
        if not isinstance(vv, (dict, Table)):
            warnings.warn('Invalid value for Table spec')
        else:
            res.append(Table.fromvalue(vv) if isinstance(vv, dict) else vv)
    return res


@attr.s
class TableGroup(TableLike):
    """
    A table group description is an object that describes a group of tables.

    A `TableGroup` delegates most of its responsibilities to the `Table` objects listed in its
    `tables` property. For convenience, `TableGroup` provides methods to
    - read data from all tables: :meth:`TableGroup.read`
    - write data for all tables: :meth:`TableGroup.write`

    It also provides a method to check the referential integrity of data in related tables via
    :meth:`TableGroup.check_referential_integrity`

    .. seealso:: `<https://www.w3.org/TR/tabular-metadata/#table-groups>`_
    """
    tables = attr.ib(repr=False, default=attr.Factory(list), converter=converter_tables)

    def __attrs_post_init__(self):
        TableLike.__attrs_post_init__(self)
        for table in self.tables:
            table._parent = self

    @classmethod
    def from_frictionless_datapackage(cls, dp):
        return DataPackage(dp).to_tablegroup(cls)

    def read(self):
        """
        Read all data of a TableGroup
        """
        return {tname: list(t.iterdicts()) for tname, t in self.tabledict.items()}

    def write(self,
              fname: typing.Union[str, pathlib.Path],
              strict: typing.Optional[bool] = False,
              _zipped: typing.Optional[bool] = False,
              **items: typing.Iterable[typing.Union[list, tuple, dict]]):
        """
        Write a TableGroup's data and metadata to files.

        :param fname: Filename for the metadata file.
        :param items: Keyword arguments are used to pass iterables of rows per table, where the \
        table URL is specified as keyword.
        """
        fname = pathlib.Path(fname)
        for tname, rows in items.items():
            self.tabledict[tname].write(rows, base=fname.parent, strict=strict, _zipped=_zipped)
        self.to_file(fname)

    def copy(self, dest: typing.Union[pathlib.Path, str]):
        """
        Write a TableGroup's data and metadata to files relative to `dest`, adapting the `base`
        attribute.

        :param dest:
        :return:
        """
        dest = pathlib.Path(dest)
        for table in self.tables:
            shutil.copy(str(table.url.resolve(self.base)), str(table.url.resolve(dest)))
        self._fname = dest / self._fname.name
        self.to_file(self._fname)

    @property
    def tabledict(self) -> typing.Dict[str, Table]:
        return {t.local_name: t for t in self.tables}

    def foreign_keys(self) -> typing.List[typing.Tuple[Table, list, Table, list]]:
        return [
            (
                self.tabledict[fk.reference.resource.string],
                fk.reference.columnReference,
                t,
                fk.columnReference)
            for t in self.tables for fk in t.tableSchema.foreignKeys
            if not fk.reference.schemaReference]

    def validate_schema(self, strict=False):
        try:
            for st, sc, tt, tc in self.foreign_keys():
                if len(sc) != len(tc):
                    raise ValueError(
                        'Foreign key error: non-matching number of columns in source and target')
                for scol, tcol in zip(sc, tc):
                    scolumn = st.tableSchema.get_column(scol, strict=strict)
                    tcolumn = tt.tableSchema.get_column(tcol, strict=strict)
                    if not (scolumn and tcolumn):
                        raise ValueError(
                            'Foregin key error: missing column "{}" or "{}"'.format(scol, tcol))
                    if scolumn.datatype and tcolumn.datatype and \
                            scolumn.datatype.base != tcolumn.datatype.base:
                        raise ValueError(
                            'Foregin key error: non-matching datatype "{}:{}" or "{}:{}"'.format(
                                scol, scolumn.datatype.base, tcol, tcolumn.datatype.base))
        except (KeyError, AssertionError) as e:
            raise ValueError('Foreign key error: missing table "{}" referenced'.format(e))

    def check_referential_integrity(self, data=None, log=None, strict=False):
        """
        Strict validation does not allow for nullable foreign key columns.
        """
        if data is not None:
            warnings.warn('the data argument of check_referential_integrity '
                          'is deprecated (its content will be ignored)')  # pragma: no cover
        if strict:
            for t in self.tables:
                for fk in t.tableSchema.foreignKeys:
                    for row in t:
                        if any(row.get(col) is None for col in fk.columnReference):
                            raise ValueError('Foreign key column is null: {} {}'.format(
                                [row.get(col) for col in fk.columnReference], fk.columnReference))
        try:
            self.validate_schema()
            success = True
        except ValueError as e:
            success = False
            log_or_raise(str(e), log=log, level='error')
        fkeys = self.foreign_keys()
        # FIXME: We only support Foreign Key references between tables!
        fkeys = sorted(fkeys, key=lambda x: (x[0].local_name, x[1], x[2].local_name))
        # Grouping by local_name of tables - even though we'd like to have the table objects
        # around, too. This it to prevent going down the rabbit hole of comparing table objects
        # for equality, when comparison of the string names is enough.
        for _, grp in itertools.groupby(fkeys, lambda x: x[0].local_name):
            grp = list(grp)
            table = grp[0][0]
            t_fkeys = [(key, [(child, ref) for _, _, child, ref in kgrp])
                       for key, kgrp in itertools.groupby(grp, lambda x: x[1])]
            get_seen = [(operator.itemgetter(*key), set()) for key, _ in t_fkeys]
            for row in table.iterdicts(log=log):
                for get, seen in get_seen:
                    if get(row) in seen:
                        # column references for a foreign key are not unique!
                        if strict:
                            success = False
                    seen.add(get(row))
            for (key, children), (_, seen) in zip(t_fkeys, get_seen):
                single_column = (len(key) == 1)
                for child, ref in children:
                    get_ref = operator.itemgetter(*ref)
                    for fname, lineno, item in child.iterdicts(log=log, with_metadata=True):
                        colref = get_ref(item)
                        if colref is None:
                            continue
                        elif single_column and isinstance(colref, list):
                            # We allow list-valued columns as foreign key columns in case
                            # it's not a composite key. If a foreign key is list-valued, we
                            # check for a matching row for each of the values in the list.
                            colrefs = colref
                        else:
                            colrefs = [colref]
                        for colref in colrefs:
                            if not single_column and None in colref:  # pragma: no cover
                                # TODO: raise if any(c is not None for c in colref)?
                                continue
                            elif colref not in seen:
                                log_or_raise(
                                    '{0}:{1} Key `{2}` not found in table {3}'.format(
                                        fname,
                                        lineno,
                                        colref,
                                        table.url.string),
                                    log=log)
                                success = False
        return success


class CSVW:
    """
    Python API to read CSVW described data and convert it to JSON.
    """
    def __init__(self, url: str, md_url: typing.Optional[str] = None, validate: bool = False):
        self.warnings = []
        w = None
        with contextlib.ExitStack() as stack:
            if validate:
                w = stack.enter_context(warnings.catch_warnings(record=True))

            no_header = False
            try:
                md = get_json(md_url or url)
                # The URL could be read as JSON document, thus, the user supplied us with overriding
                # metadata as per https://w3c.github.io/csvw/syntax/#overriding-metadata
            except json.decoder.JSONDecodeError:
                # So we got a CSV file, no JSON. Let's locate metadata using the other methods.
                md, no_header = self.locate_metadata(url)

            self.no_metadata = set(md.keys()) == {'@context', 'url'}
            if "http://www.w3.org/ns/csvw" not in md.get('@context', ''):
                raise ValueError('Invalid or no @context')
            if 'tables' in md:
                if not md['tables'] or not isinstance(md['tables'], list):
                    raise ValueError('Invalid TableGroup with empty tables property')
                if is_url(url):
                    self.t = TableGroup.from_url(url, data=md)
                    self.t.validate_schema(strict=True)
                else:
                    self.t = TableGroup.from_file(url, data=md)
            else:
                if is_url(url):
                    self.t = Table.from_url(url, data=md)
                    if no_header:
                        if self.t.dialect:
                            self.t.dialect.header = False  # pragma: no cover
                        else:
                            self.t.dialect = Dialect(header=False)
                else:
                    self.t = Table.from_file(url, data=md)
            self.tables = self.t.tables if isinstance(self.t, TableGroup) else [self.t]
            for table in self.tables:
                for col in table.tableSchema.columns:
                    if col.name and (re.search(r'\s', col.name) or col.name.startswith('_')):
                        col.name = None
            self.common_props = self.t.common_props
        if w:
            self.warnings.extend(w)

    @property
    def is_valid(self) -> bool:
        """
        Performs CSVW validation.

        .. note::

            For this to also catch problems during metadata location, the
            `CSVW` instance must be initialized with `validate=True`.
        """
        if self.warnings:
            return False
        with warnings.catch_warnings(record=True) as w:
            for table in self.tables:
                for _ in table.iterdicts(strict=False):
                    pass
                if not table.check_primary_key():  # pragma: no cover
                    warnings.warn('Duplicate primary key')
            if not self.tablegroup.check_referential_integrity(strict=True):
                warnings.warn('Referential integrity check failed')
            if w:
                self.warnings.extend(w)
        return not bool(self.warnings)

    @property
    def tablegroup(self):
        return self.t if isinstance(self.t, TableGroup) else \
            TableGroup(at_props={'base': self.t.base}, tables=self.tables)

    @staticmethod
    def locate_metadata(url=None) -> typing.Tuple[dict, bool]:
        """
        Implements metadata discovery as specified in
        `§5. Locating Metadata <https://w3c.github.io/csvw/syntax/#locating-metadata>`_
        """
        def describes(md, url):
            for table in md.get('tables', [md]):
                # FIXME: We check whether the metadata describes a CSV file just superficially,
                # by comparing the last path components of the respective URLs.
                if url.split('/')[-1] == table['url'].split('/')[-1]:
                    return True
            return False

        no_header = False
        if url and is_url(url):
            # §5.2 Link Header
            # https://w3c.github.io/csvw/syntax/#link-header
            res = requests.head(url)
            no_header = bool(re.search(r'header\s*=\s*absent', res.headers.get('content-type', '')))
            desc = res.links.get('describedby')
            if desc and desc['type'] in [
                    "application/csvm+json", "application/ld+json", "application/json"]:
                md = get_json(Link(desc['url']).resolve(url))
                if describes(md, url):
                    return md, no_header
                else:
                    warnings.warn('Ignoring linked metadata because it does not reference the data')

            # §5.3 Default Locations and Site-wide Location Configuration
            # https://w3c.github.io/csvw/syntax/
            # #default-locations-and-site-wide-location-configuration
            res = requests.get(Link('/.well-known/csvm').resolve(url))
            locs = res.text if res.status_code == 200 else '{+url}-metadata.json\ncsv-metadata.json'
            for line in locs.split('\n'):
                res = requests.get(Link(URITemplate(line).expand(url=url)).resolve(url))
                if res.status_code == 200:
                    try:
                        md = res.json()
                        if describes(md, url):
                            return md, no_header
                        warnings.warn('Ignoring metadata because it does not reference the data')
                    except json.JSONDecodeError:
                        pass

            # §5.4 Embedded Metadata
            # https://w3c.github.io/csvw/syntax/#embedded-metadata
            # We only recognize column names read from the first row of a CSV file.
        elif url:
            # Default Locations for local files:
            if pathlib.Path(str(url) + '-metadata.json').exists():
                return get_json(pathlib.Path(str(url) + '-metadata.json')), no_header
        res = {
            '@context': "http://www.w3.org/ns/csvw",
            'url': url,
        }
        if not is_url(url or ''):
            # No metadata detected for a local CSV file. To make table reading work, we set the
            # directory as @base and the filename as url property of the description.
            p = pathlib.Path(url)
            res['@base'] = str(p)
            res['url'] = p.name
        return res, no_header

    def to_json(self, minimal=False):
        """
        Implements algorithm described in `<https://w3c.github.io/csvw/csv2json/#standard-mode>`_
        """
        res = collections.OrderedDict()
        # Insert any notes and non-core annotations specified for the group of tables into object
        # G according to the rules provided in § 5. JSON-LD to JSON.
        if self.t.common_props and not isinstance(self.t, Table):
            res.update(jsonld.to_json(self.t.common_props, flatten_list=True))
        res['tables'] = [
            self._table_to_json(table) for table in self.tables if not table.suppressOutput]
        if minimal:
            return list(
                itertools.chain(*[[r['describes'][0] for r in t['row']] for t in res['tables']]))

        return res

    def _table_to_json(self, table):
        res = collections.OrderedDict()
        # FIXME: id
        res['url'] = str(table.url.resolve(table.base))
        if 'id' in table.at_props:
            res['@id'] = table.at_props['id']
        if table.notes:
            res['notes'] = jsonld.to_json(table.notes)
        # Insert any notes and non-core annotations specified for the group of tables into object
        # G according to the rules provided in § 5. JSON-LD to JSON.
        res.update(jsonld.to_json(table.common_props))

        cols = collections.OrderedDict([(col.header, col) for col in table.tableSchema.columns])
        for col in cols.values():
            col.propertyUrl = col.inherit('propertyUrl')
            col.valueUrl = col.inherit('valueUrl')

        row = [
            self._row_to_json(table, cols, row, rownum, rowsourcenum)
            for rownum, (_, rowsourcenum, row) in enumerate(
                table.iterdicts(with_metadata=True, strict=False), start=1)
        ]
        if table._comments:
            res['rdfs:comment'] = [c[1] for c in table._comments]
        res['row'] = row
        return res

    def _row_to_json(self, table, cols, row, rownum, rowsourcenum):
        res = collections.OrderedDict()
        res['url'] = '{}#row={}'.format(table.url.resolve(table.base), rowsourcenum)
        res['rownum'] = rownum
        if table.tableSchema.rowTitles:
            res['titles'] = [
                t for t in [row.get(name) for name in table.tableSchema.rowTitles] if t]
            if len(res['titles']) == 1:
                res['titles'] = res['titles'][0]
        # Insert any notes and non-core annotations specified for the group of tables into object
        # G according to the rules provided in § 5. JSON-LD to JSON.

        res['describes'] = self._describes(table, cols, row, rownum)
        return res

    def _describes(self, table, cols, row, rownum):
        triples = []

        aboutUrl = table.tableSchema.inherit('aboutUrl')
        if aboutUrl:
            triples.append(jsonld.Triple(
                about=None, property='@id', value=table.expand(aboutUrl, row, _row=rownum)))

        for i, (k, v) in enumerate(row.items(), start=1):
            col = cols.get(k)
            if col and (col.suppressOutput or col.virtual):
                continue

            # Skip null values:
            null = col.inherit_null() if col else table.inherit_null()
            if (null and v in null) or v == "" or (v is None) or \
                    (col and col.separator and v == []):
                continue

            triples.append(jsonld.Triple.from_col(
                table,
                col,
                row,
                '_col.{}'.format(i)
                if (not table.tableSchema.columns and not self.no_metadata) else k,
                v,
                rownum))

        for col in table.tableSchema.columns:
            if col.virtual:
                triples.append(jsonld.Triple.from_col(table, col, row, col.header, None, rownum))
        return jsonld.group_triples(triples)
