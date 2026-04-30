"""
This module defines the different types of terms. Terms are the kinds of
objects that can appear in a quoted/asserted triple. This includes those
that are core to RDF:

* [Blank Nodes][rdflib.term.BNode] - Blank Nodes
* [URI References][rdflib.term.URIRef] - URI References
* [Literals][rdflib.term.Literal] - Literals (which consist of a literal value, datatype and language tag)

Those that extend the RDF model into N3:

* [`QuotedGraph`][rdflib.graph.QuotedGraph] - Formulae
* [`Variable`][rdflib.term.Variable] - Universal Quantifications (Variables)

And those that are primarily for matching against 'Nodes' in the
underlying Graph:

* REGEX Expressions
* Date Ranges
* Numerical Ranges
"""

from __future__ import annotations

import abc
import re
from fractions import Fraction

__all__ = [
    "bind",
    "_is_valid_uri",
    "Node",
    "IdentifiedNode",
    "Identifier",
    "URIRef",
    "BNode",
    "Literal",
    "Variable",
]
import logging
import math
import warnings
import xml.dom.minidom
from base64 import b64decode, b64encode
from binascii import hexlify, unhexlify
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from re import compile, sub
from types import GeneratorType
from typing import (
    TYPE_CHECKING,
    Any,
    Callable,
    Dict,
    Generator,
    List,
    Optional,
    Tuple,
    Type,
    TypeVar,
    Union,
)
from urllib.parse import urldefrag, urljoin, urlparse
from uuid import uuid4

import rdflib
import rdflib.util
from rdflib.compat import long_type

from .xsd_datetime import (  # type: ignore[attr-defined]
    Duration,
    duration_isoformat,
    parse_datetime,
    parse_time,
    parse_xsd_date,
    parse_xsd_duration,
)

if TYPE_CHECKING:
    from .namespace import NamespaceManager
    from .paths import AlternativePath, InvPath, NegatedPath, Path, SequencePath

_HAS_HTML5RDF = False

try:
    import html5rdf

    _HAS_HTML5RDF = True
except ImportError:
    html5rdf = None

_SKOLEM_DEFAULT_AUTHORITY = "https://rdflib.github.io"

logger = logging.getLogger(__name__)
skolem_genid = "/.well-known/genid/"
rdflib_skolem_genid = "/.well-known/genid/rdflib/"
skolems: Dict[str, BNode] = {}


_invalid_uri_chars = '<>" {}|\\^`'


def _is_valid_uri(uri: str) -> bool:
    for c in _invalid_uri_chars:
        if c in uri:
            return False
    return True


_lang_tag_regex = compile("^[a-zA-Z]+(?:-[a-zA-Z0-9]+)*$")


def _is_valid_langtag(tag: str) -> bool:
    return bool(_lang_tag_regex.match(tag))


def _is_valid_unicode(value: Union[str, bytes]) -> bool:
    """
    Verify that the provided value can be converted into a Python
    unicode object.
    """
    if isinstance(value, bytes):
        coding_func, param = getattr(value, "decode"), "utf-8"
    else:
        coding_func, param = str, value

    # try to convert value into unicode
    try:
        coding_func(param)
    except UnicodeError:
        return False
    return True


class Node(abc.ABC):
    """A Node in the Graph."""

    __slots__ = ()

    @abc.abstractmethod
    def n3(self, namespace_manager: Optional[NamespaceManager] = None) -> str: ...


class Identifier(Node, str):  # allow Identifiers to be Nodes in the Graph
    """See http://www.w3.org/2002/07/rdf-identifer-terminology/
    regarding choice of terminology."""

    __slots__ = ()

    def __new__(cls, value: str):
        return str.__new__(cls, value)

    def eq(self, other: Any) -> bool:
        """A "semantic"/interpreted equality function,
        by default, same as __eq__"""
        return self.__eq__(other)

    def neq(self, other: Any) -> bool:
        """A "semantic"/interpreted not equal function,
        by default, same as __ne__"""
        return self.__ne__(other)

    def __ne__(self, other: Any) -> bool:
        return not self.__eq__(other)

    def __eq__(self, other: Any) -> bool:
        """Equality for Nodes.

        ```python
        >>> BNode("foo")==None
        False
        >>> BNode("foo")==URIRef("foo")
        False
        >>> URIRef("foo")==BNode("foo")
        False
        >>> BNode("foo")!=URIRef("foo")
        True
        >>> URIRef("foo")!=BNode("foo")
        True
        >>> Variable('a')!=URIRef('a')
        True
        >>> Variable('a')!=Variable('a')
        False

        ```
        """

        if type(self) is type(other):
            return str(self) == str(other)
        else:
            return False

    def __gt__(self, other: Any) -> bool:
        """This implements ordering for Nodes.

        This tries to implement this:
        http://www.w3.org/TR/sparql11-query/#modOrderBy

        Variables are not included in the SPARQL list, but
        they are greater than BNodes and smaller than everything else
        """
        if other is None:
            return True  # everything bigger than None
        elif type(self) is type(other):
            return str(self) > str(other)
        elif isinstance(other, Node):
            return _ORDERING[type(self)] > _ORDERING[type(other)]

        return NotImplemented

    def __lt__(self, other: Any) -> bool:
        if other is None:
            return False  # Nothing is less than None
        elif type(self) is type(other):
            return str(self) < str(other)
        elif isinstance(other, Node):
            return _ORDERING[type(self)] < _ORDERING[type(other)]

        return NotImplemented

    def __le__(self, other: Any) -> bool:
        r = self.__lt__(other)
        if r:
            return True
        return self == other

    def __ge__(self, other: Any) -> bool:
        r = self.__gt__(other)
        if r:
            return True
        return self == other

    # type error: Argument 1 of "startswith" is incompatible with supertype "str"; supertype defines the argument type as "Union[str, Tuple[str, ...]]"
    # FIXME: this does not accommodate prefix of type Tuple[str, ...] which is a
    # valid for str.startswith
    def startswith(self, prefix: str, start=..., end=...) -> bool:  # type: ignore[override] # FIXME
        return str(self).startswith(str(prefix))

    # use parent's hash for efficiency reasons
    # clashes of 'foo', URIRef('foo') and Literal('foo') are typically so rare
    # that they don't justify additional overhead. Notice that even in case of
    # clash __eq__ is still the fallback and very quick in those cases.
    __hash__ = str.__hash__


class IdentifiedNode(Identifier):
    """
    An abstract class, primarily defined to identify Nodes that are not Literals.

    The name "Identified Node" is not explicitly defined in the RDF specification, but can be drawn from this section: https://www.w3.org/TR/rdf-concepts/#section-URI-Vocabulary
    """

    __slots__ = ()

    def __getnewargs__(self) -> Tuple[str]:
        return (str(self),)

    def n3(self, namespace_manager: Optional[NamespaceManager] = None) -> str:
        raise NotImplementedError()

    def toPython(self) -> str:  # noqa: N802
        return str(self)


class URIRef(IdentifiedNode):
    """[RDF 1.1's IRI Section](https://www.w3.org/TR/rdf11-concepts/#section-IRIs)

    !!! info "Terminology"
        Documentation on RDF outside of RDFLib uses the term IRI or URI whereas this class is called URIRef. This is because it was made when the first version of the RDF specification was current, and it used the term *URIRef*, see [RDF 1.0 URIRef](http://www.w3.org/TR/rdf-concepts/#section-Graph-URIref)

    An IRI (Internationalized Resource Identifier) within an RDF graph is a Unicode string that conforms to the syntax defined in RFC 3987.

    IRIs in the RDF abstract syntax MUST be absolute, and MAY contain a fragment identifier.

    IRIs are a generalization of URIs [RFC3986] that permits a wider range of Unicode characters.
    """

    __slots__ = ()

    __or__: Callable[[URIRef, Union[URIRef, Path]], AlternativePath]
    __invert__: Callable[[URIRef], InvPath]
    __neg__: Callable[[URIRef], NegatedPath]
    __truediv__: Callable[[URIRef, Union[URIRef, Path]], SequencePath]

    def __new__(cls, value: str, base: Optional[str] = None):
        if base is not None:
            ends_in_hash = value.endswith("#")
            # type error: Argument "allow_fragments" to "urljoin" has incompatible type "int"; expected "bool"
            value = urljoin(base, value, allow_fragments=1)  # type: ignore[arg-type]
            if ends_in_hash:
                if not value.endswith("#"):
                    value += "#"

        if not _is_valid_uri(value):
            logger.warning(
                f"{value} does not look like a valid URI, trying to serialize this will break."
            )

        try:
            rt = str.__new__(cls, value)
        except UnicodeDecodeError:
            # type error: No overload variant of "__new__" of "str" matches argument types "Type[URIRef]", "str", "str"
            rt = str.__new__(cls, value, "utf-8")  # type: ignore[call-overload]
        return rt

    def n3(self, namespace_manager: Optional[NamespaceManager] = None) -> str:
        """This will do a limited check for valid URIs,
        essentially just making sure that the string includes no illegal
        characters (`<, >, ", {, }, |, \\, `, ^`)

        Args:
            namespace_manager: if not None, will be used to make up a prefixed name
        """

        if not _is_valid_uri(self):
            raise Exception(
                f'"{self}" does not look like a valid URI, I cannot serialize this as N3/Turtle. Perhaps you wanted to urlencode it?'
            )

        if namespace_manager:
            return namespace_manager.normalizeUri(self)
        else:
            return f"<{self}>"

    def defrag(self) -> URIRef:
        if "#" in self:
            url, frag = urldefrag(self)
            return URIRef(url)
        else:
            return self

    @property
    def fragment(self) -> str:
        """Return the URL Fragment

        ```python
        >>> URIRef("http://example.com/some/path/#some-fragment").fragment
        'some-fragment'
        >>> URIRef("http://example.com/some/path/").fragment
        ''

        ```
        """
        return urlparse(self).fragment

    def __reduce__(self) -> Tuple[Type[URIRef], Tuple[str]]:
        return (URIRef, (str(self),))

    def __repr__(self) -> str:
        if self.__class__ is URIRef:
            clsName = "rdflib.term.URIRef"  # noqa: N806
        else:
            clsName = self.__class__.__name__  # noqa: N806

        return f"{clsName}({str.__repr__(self)})"

    def __add__(self, other) -> URIRef:
        return self.__class__(str(self) + other)

    def __radd__(self, other) -> URIRef:
        return self.__class__(other + str(self))

    def __mod__(self, other) -> URIRef:
        return self.__class__(str(self) % other)

    def de_skolemize(self) -> BNode:
        """Create a Blank Node from a skolem URI, in accordance
        with http://www.w3.org/TR/rdf11-concepts/#section-skolemization.
        This function accepts only rdflib type skolemization, to provide
        a round-tripping within the system.

        Added in version 4.0
        """
        if isinstance(self, RDFLibGenid):
            parsed_uri = urlparse(f"{self}")
            return BNode(value=parsed_uri.path[len(rdflib_skolem_genid) :])
        elif isinstance(self, Genid):
            bnode_id = f"{self}"
            if bnode_id in skolems:
                return skolems[bnode_id]
            else:
                retval = BNode()
                skolems[bnode_id] = retval
                return retval
        else:
            raise Exception(f"<{self}> is not a skolem URI")


class Genid(URIRef):
    __slots__ = ()

    @staticmethod
    def _is_external_skolem(uri: Any) -> bool:
        if not isinstance(uri, str):
            uri = str(uri)
        parsed_uri = urlparse(uri)
        gen_id = parsed_uri.path.rfind(skolem_genid)
        if gen_id != 0:
            return False
        return True


class RDFLibGenid(Genid):
    __slots__ = ()

    @staticmethod
    def _is_rdflib_skolem(uri: Any) -> bool:
        if not isinstance(uri, str):
            uri = str(uri)
        parsed_uri = urlparse(uri)
        if (
            parsed_uri.params != ""
            or parsed_uri.query != ""
            or parsed_uri.fragment != ""
        ):
            return False
        gen_id = parsed_uri.path.rfind(rdflib_skolem_genid)
        if gen_id != 0:
            return False
        return True


def _unique_id() -> str:
    # Used to read: """Create a (hopefully) unique prefix"""
    # now retained merely to leave internal API unchanged.
    # From BNode.__new__() below ...
    #
    # acceptable bnode value range for RDF/XML needs to be
    # something that can be serialzed as a nodeID for N3
    #
    # BNode identifiers must be valid NCNames" _:[A-Za-z][A-Za-z0-9]*
    # http://www.w3.org/TR/2004/REC-rdf-testcases-20040210/#nodeID
    return "N"  # ensure that id starts with a letter


class BNode(IdentifiedNode):
    """
    RDF 1.1's Blank Nodes Section: https://www.w3.org/TR/rdf11-concepts/#section-blank-nodes

    Blank Nodes are local identifiers for unnamed nodes in RDF graphs that are used in
    some concrete RDF syntaxes or RDF store implementations. They are always locally
    scoped to the file or RDF store, and are not persistent or portable identifiers for
    blank nodes. The identifiers for Blank Nodes are not part of the RDF abstract
    syntax, but are entirely dependent on particular concrete syntax or implementation
    (such as Turtle, JSON-LD).

    ---

    RDFLib's `BNode` class makes unique IDs for all the Blank Nodes in a Graph but you
    should *never* expect, or reply on, BNodes' IDs to match across graphs, or even for
    multiple copies of the same graph, if they are regenerated from some non-RDFLib
    source, such as loading from RDF data.
    """

    __slots__ = ()

    def __new__(
        cls,
        value: Optional[str] = None,
        _sn_gen: Optional[Union[Callable[[], str], Generator]] = None,
        _prefix: str = _unique_id(),
    ):
        """
        # only store implementations should pass in a value
        """
        if value is None:
            # so that BNode values do not collide with ones created with
            # a different instance of this module at some other time.
            if _sn_gen is not None:
                if callable(_sn_gen):
                    sn_result: Union[str, Generator] = _sn_gen()
                else:
                    sn_result = _sn_gen
                if isinstance(sn_result, GeneratorType):
                    node_id = next(sn_result)
                else:
                    node_id = sn_result
            else:
                node_id = uuid4().hex
            # note, for two (and only two) string variables,
            # concat with + is faster than f"{x}{y}"
            value = _prefix + f"{node_id}"
        else:
            # TODO: check that value falls within acceptable bnode value range
            # for RDF/XML needs to be something that can be serialized
            # as a nodeID for N3 ??  Unless we require these
            # constraints be enforced elsewhere?
            pass  # assert is_ncname(str(value)), "BNode identifiers
            # must be valid NCNames" _:[A-Za-z][A-Za-z0-9]*
            # http://www.w3.org/TR/2004/REC-rdf-testcases-20040210/#nodeID
        # type error: Incompatible return value type (got "Identifier", expected "BNode")
        return Identifier.__new__(cls, value)

    def n3(self, namespace_manager: Optional[NamespaceManager] = None) -> str:
        # note - for two strings, concat with + is faster than f"{x}{y}"
        return "_:" + self

    def __reduce__(self) -> Tuple[Type[BNode], Tuple[str]]:
        return (BNode, (str(self),))

    def __repr__(self) -> str:
        if self.__class__ is BNode:
            clsName = "rdflib.term.BNode"  # noqa: N806
        else:
            clsName = self.__class__.__name__  # noqa: N806
        return f"{clsName}({str.__repr__(self)})"

    def skolemize(
        self, authority: Optional[str] = None, basepath: Optional[str] = None
    ) -> URIRef:
        """Create a URIRef "skolem" representation of the BNode, in accordance
        with http://www.w3.org/TR/rdf11-concepts/#section-skolemization

        Added in version 4.0
        """
        if authority is None:
            authority = _SKOLEM_DEFAULT_AUTHORITY
        if basepath is None:
            basepath = rdflib_skolem_genid
        skolem = basepath + str(self)
        return URIRef(urljoin(authority, skolem))


class Literal(Identifier):
    """

    RDF 1.1's Literals Section: http://www.w3.org/TR/rdf-concepts/#section-Graph-Literal

    Literals are used for values such as strings, numbers, and dates.

    A literal in an RDF graph consists of two or three elements:

    * a lexical form, being a Unicode string, which SHOULD be in Normal Form C
    * a datatype IRI, being an IRI identifying a datatype that determines how the lexical form maps to a literal value, and
    * if and only if the datatype IRI is `http://www.w3.org/1999/02/22-rdf-syntax-ns#langString`, a non-empty language tag. The language tag MUST be well-formed according to section 2.2.9 of `Tags for identifying languages <http://tools.ietf.org/html/bcp47>`_.

    A literal is a language-tagged string if the third element is present. Lexical representations of language tags MAY be converted to lower case. The value space of language tags is always in lower case.

    ---

    For valid XSD datatypes, the lexical form is optionally normalized
    at construction time. Default behaviour is set by `rdflib.NORMALIZE_LITERALS`
    and can be overridden by the normalize parameter to `__new__`

    Equality and hashing of Literals are done based on the lexical form, i.e.:

    ```python
    >>> from rdflib.namespace import XSD
    >>> Literal('01') != Literal('1')  # clear - strings differ
    True

    ```

    but with data-type they get normalized:

    ```python
    >>> Literal('01', datatype=XSD.integer) != Literal('1', datatype=XSD.integer)
    False

    ```

    unless disabled:

    ```python
    >>> Literal('01', datatype=XSD.integer, normalize=False) != Literal('1', datatype=XSD.integer)
    True

    ```

    Value based comparison is possible:

    ```python
    >>> Literal('01', datatype=XSD.integer).eq(Literal('1', datatype=XSD.float))
    True

    ```

    The eq method also provides limited support for basic python types:

    ```python
    >>> Literal(1).eq(1) # fine - int compatible with xsd:integer
    True
    >>> Literal('a').eq('b') # fine - str compatible with plain-lit
    False
    >>> Literal('a', datatype=XSD.string).eq('a') # fine - str compatible with xsd:string
    True
    >>> Literal('a').eq(1) # not fine, int incompatible with plain-lit
    NotImplemented

    ```

    Greater-than/less-than ordering comparisons are also done in value
    space, when compatible datatypes are used.  Incompatible datatypes
    are ordered by DT, or by lang-tag.  For other nodes the ordering
    is None < BNode < URIRef < Literal

    Any comparison with non-rdflib Node are "NotImplemented"
    In PY3 this is an error.

    ```python
    >>> from rdflib import Literal, XSD
    >>> lit2006 = Literal('2006-01-01',datatype=XSD.date)
    >>> lit2006.toPython()
    datetime.date(2006, 1, 1)
    >>> lit2006 < Literal('2007-01-01',datatype=XSD.date)
    True
    >>> Literal(datetime.utcnow()).datatype
    rdflib.term.URIRef('http://www.w3.org/2001/XMLSchema#dateTime')
    >>> Literal(1) > Literal(2) # by value
    False
    >>> Literal(1) > Literal(2.0) # by value
    False
    >>> Literal('1') > Literal(1) # by DT
    True
    >>> Literal('1') < Literal('1') # by lexical form
    False
    >>> Literal('a', lang='en') > Literal('a', lang='fr') # by lang-tag
    False
    >>> Literal(1) > URIRef('foo') # by node-type
    True

    ```

    The > < operators will eat this NotImplemented and throw a TypeError (py3k):

    ```python
    >>> Literal(1).__gt__(2.0)
    NotImplemented

    ```
    """

    _value: Any
    _language: Optional[str]
    # NOTE: _datatype should maybe be of type URIRef, and not optional.
    _datatype: Optional[URIRef]
    _ill_typed: Optional[bool]
    __slots__ = ("_language", "_datatype", "_value", "_ill_typed")

    def __new__(
        cls,
        lexical_or_value: Any,
        lang: Optional[str] = None,
        datatype: Optional[str] = None,
        normalize: Optional[bool] = None,
    ):
        """Create a new Literal instance."""
        if lang == "":
            lang = None  # no empty lang-tags in RDF

        normalize = normalize if normalize is not None else rdflib.NORMALIZE_LITERALS

        if lang is not None and datatype is not None:
            raise TypeError(
                "A Literal can only have one of lang or datatype, "
                "per http://www.w3.org/TR/rdf-concepts/#section-Graph-Literal"
            )

        if lang is not None and not _is_valid_langtag(lang):
            raise ValueError(f"'{str(lang)}' is not a valid language tag!")

        if datatype is not None:
            datatype = URIRef(datatype)

        value = None
        ill_typed: Optional[bool] = None
        if isinstance(lexical_or_value, Literal):
            # create from another Literal instance

            lang = lang or lexical_or_value.language
            if datatype is not None:
                # override datatype
                value = _castLexicalToPython(lexical_or_value, datatype)
            else:
                datatype = lexical_or_value.datatype
                value = lexical_or_value.value

        elif isinstance(lexical_or_value, str) or isinstance(lexical_or_value, bytes):
            # passed a string
            # try parsing lexical form of datatyped literal
            value = _castLexicalToPython(lexical_or_value, datatype)
            if datatype is not None and datatype in _toPythonMapping:
                # datatype is a recognized datatype IRI:
                # https://www.w3.org/TR/rdf11-concepts/#dfn-recognized-datatype-iris
                dt_uri: URIRef = URIRef(datatype)
                checker = _check_well_formed_types.get(dt_uri, _well_formed_by_value)
                well_formed = checker(lexical_or_value, value)
                ill_typed = ill_typed or (not well_formed)
            if value is not None and normalize:
                _value, _datatype = _castPythonToLiteral(value, datatype)
                if _value is not None and _is_valid_unicode(_value):
                    lexical_or_value = _value

        else:
            # passed some python object
            value = lexical_or_value
            _value, _datatype = _castPythonToLiteral(lexical_or_value, datatype)

            _datatype = None if _datatype is None else URIRef(_datatype)

            datatype = rdflib.util._coalesce(datatype, _datatype)
            if _value is not None:
                lexical_or_value = _value
            if datatype is not None:
                lang = None

        if isinstance(lexical_or_value, bytes):
            lexical_or_value = lexical_or_value.decode("utf-8")

        if datatype in (_XSD_NORMALISED_STRING, _XSD_TOKEN):
            lexical_or_value = _normalise_XSD_STRING(lexical_or_value)

        if datatype in (_XSD_TOKEN,):
            lexical_or_value = _strip_and_collapse_whitespace(lexical_or_value)

        try:
            inst = str.__new__(cls, lexical_or_value)
        except UnicodeDecodeError:
            inst = str.__new__(cls, lexical_or_value, "utf-8")

        inst._language = lang
        inst._datatype = datatype
        inst._value = value
        inst._ill_typed = ill_typed

        return inst

    def normalize(self) -> Literal:
        """
        Returns a new literal with a normalised lexical representation
        of this literal

        ```python
        >>> from rdflib import XSD
        >>> Literal("01", datatype=XSD.integer, normalize=False).normalize()
        rdflib.term.Literal('1', datatype=rdflib.term.URIRef('http://www.w3.org/2001/XMLSchema#integer'))

        ```

        Illegal lexical forms for the datatype given are simply passed on

        ```python
        >>> Literal("a", datatype=XSD.integer, normalize=False)
        rdflib.term.Literal('a', datatype=rdflib.term.URIRef('http://www.w3.org/2001/XMLSchema#integer'))

        ```
        """

        if self.value is not None:
            return Literal(self.value, datatype=self.datatype, lang=self.language)
        else:
            return self

    @property
    def ill_typed(self) -> Optional[bool]:
        """
        For `recognized datatype IRIs
        <https://www.w3.org/TR/rdf11-concepts/#dfn-recognized-datatype-iris>`_,
        this value will be `True` if the literal is ill formed, otherwise it
        will be `False`. `Literal.value` (i.e. the `literal value <https://www.w3.org/TR/rdf11-concepts/#dfn-literal-value>`_) should always be defined if this property is `False`, but should not be considered reliable if this property is `True`.

        If the literal's datatype is `None` or not in the set of `recognized datatype IRIs
        <https://www.w3.org/TR/rdf11-concepts/#dfn-recognized-datatype-iris>`_ this value will be `None`.
        """
        return self._ill_typed

    @property
    def value(self) -> Any:
        return self._value

    @property
    def language(self) -> Optional[str]:
        return self._language

    @property
    def datatype(self) -> Optional[URIRef]:
        return self._datatype

    def __reduce__(
        self,
    ) -> Tuple[Type[Literal], Tuple[str, Union[str, None], Union[str, None]]]:
        return (
            Literal,
            (str(self), self.language, self.datatype),
        )

    def __getstate__(self) -> Tuple[None, Dict[str, Union[str, None]]]:
        return (None, dict(language=self.language, datatype=self.datatype))

    def __setstate__(self, arg: Tuple[Any, Dict[str, Any]]) -> None:
        _, d = arg
        self._language = d["language"]
        self._datatype = d["datatype"]

    def __add__(self, val: Any) -> Literal:
        """
        ```python
        >>> from rdflib.namespace import XSD
        >>> Literal(1) + 1
        rdflib.term.Literal('2', datatype=rdflib.term.URIRef('http://www.w3.org/2001/XMLSchema#integer'))
        >>> Literal("1") + "1"
        rdflib.term.Literal('11')

        # Handling dateTime/date/time based operations in Literals
        >>> a = Literal('2006-01-01T20:50:00', datatype=XSD.dateTime)
        >>> b = Literal('P31D', datatype=XSD.duration)
        >>> (a + b)
        rdflib.term.Literal('2006-02-01T20:50:00', datatype=rdflib.term.URIRef('http://www.w3.org/2001/XMLSchema#dateTime'))
        >>> from rdflib.namespace import XSD
        >>> a = Literal('2006-07-01T20:52:00', datatype=XSD.dateTime)
        >>> b = Literal('P122DT15H58M', datatype=XSD.duration)
        >>> (a + b)
        rdflib.term.Literal('2006-11-01T12:50:00', datatype=rdflib.term.URIRef('http://www.w3.org/2001/XMLSchema#dateTime'))

        ```
        """

        # if no val is supplied, return this Literal
        if val is None:
            return self

        # convert the val to a Literal, if it isn't already one
        if not isinstance(val, Literal):
            val = Literal(val)

        # if self is datetime based and value is duration
        if (
            self.datatype in (_XSD_DATETIME, _XSD_DATE)
            and val.datatype in _TIME_DELTA_TYPES
        ):
            date1: Union[datetime, date] = self.toPython()
            duration: Union[Duration, timedelta] = val.toPython()
            difference = date1 + duration
            return Literal(difference, datatype=self.datatype)

        # if self is time based and value is duration
        elif self.datatype == _XSD_TIME and val.datatype in _TIME_DELTA_TYPES:
            selfv: time = self.toPython()
            valv: Union[Duration, timedelta] = val.toPython()
            sdt = datetime.combine(date(2000, 1, 1), selfv) + valv
            return Literal(sdt.time(), datatype=self.datatype)

        # if self is datetime based and value is not or vice versa
        elif (
            (
                self.datatype in _ALL_DATE_AND_TIME_TYPES
                and val.datatype not in _ALL_DATE_AND_TIME_TYPES
            )
            or (
                self.datatype not in _ALL_DATE_AND_TIME_TYPES
                and val.datatype in _ALL_DATE_AND_TIME_TYPES
            )
            or (
                self.datatype in _TIME_DELTA_TYPES
                and (
                    (val.datatype not in _TIME_DELTA_TYPES)
                    or (self.datatype != val.datatype)
                )
            )
        ):
            raise TypeError(
                f"Cannot add a Literal of datatype {str(val.datatype)} to a Literal of datatype {str(self.datatype)}"
            )

        # if the datatypes are the same, just add the Python values and convert back
        if self.datatype == val.datatype:
            return Literal(
                self.toPython() + val.toPython(), self.language, datatype=self.datatype
            )
        # if the datatypes are not the same but are both numeric, add the Python values and strip off decimal junk
        # (i.e. tiny numbers (more than 17 decimal places) and trailing zeros) and return as a decimal
        elif (
            self.datatype in _NUMERIC_LITERAL_TYPES
            and val.datatype in _NUMERIC_LITERAL_TYPES
        ):
            return Literal(
                Decimal(
                    f"{round(Decimal(self.toPython()) + Decimal(val.toPython()), 15):f}".rstrip(
                        "0"
                    ).rstrip(
                        "."
                    )
                ),
                datatype=_XSD_DECIMAL,
            )
        # in all other cases, perform string concatenation
        else:
            try:
                s = str.__add__(self, val)
            except TypeError:
                s = str(self.value) + str(val)

            # if the original datatype is string-like, use that
            if self.datatype in _STRING_LITERAL_TYPES:
                new_datatype = self.datatype
            # if not, use string
            else:
                new_datatype = _XSD_STRING

            return Literal(s, self.language, datatype=new_datatype)

    def __sub__(self, val: Any) -> Literal:
        """Implements subtraction between Literals or between a Literal and a Python object.

        Example:
            ```python
            from rdflib.namespace import XSD

            # Basic numeric subtraction
            Literal(2) - 1
            # rdflib.term.Literal('1', datatype=rdflib.term.URIRef('http://www.w3.org/2001/XMLSchema#integer'))

            Literal(1.1) - 1.0
            # rdflib.term.Literal('0.10000000000000009', datatype=rdflib.term.URIRef('http://www.w3.org/2001/XMLSchema#double'))

            Literal(1.1) - 1
            # rdflib.term.Literal('0.1', datatype=rdflib.term.URIRef('http://www.w3.org/2001/XMLSchema#decimal'))

            Literal(1.1, datatype=XSD.float) - Literal(1.0, datatype=XSD.float)
            # rdflib.term.Literal('0.10000000000000009', datatype=rdflib.term.URIRef('http://www.w3.org/2001/XMLSchema#float'))

            # This will raise a TypeError
            Literal("1.1") - 1.0
            # TypeError: Not a number; rdflib.term.Literal('1.1')

            Literal(1.1, datatype=XSD.integer) - Literal(1.0, datatype=XSD.integer)
            # rdflib.term.Literal('0.10000000000000009', datatype=rdflib.term.URIRef('http://www.w3.org/2001/XMLSchema#integer'))

            # Handling dateTime/date/time based operations in Literals
            a = Literal('2006-01-01T20:50:00', datatype=XSD.dateTime)
            b = Literal('2006-02-01T20:50:00', datatype=XSD.dateTime)
            (b - a)
            # rdflib.term.Literal('P31D', datatype=rdflib.term.URIRef('http://www.w3.org/2001/XMLSchema#duration'))

            a = Literal('2006-07-01T20:52:00', datatype=XSD.dateTime)
            b = Literal('2006-11-01T12:50:00', datatype=XSD.dateTime)
            (a - b)
            # rdflib.term.Literal('-P122DT15H58M', datatype=rdflib.term.URIRef('http://www.w3.org/2001/XMLSchema#duration'))
            (b - a)
            # rdflib.term.Literal('P122DT15H58M', datatype=rdflib.term.URIRef('http://www.w3.org/2001/XMLSchema#duration'))
            ```
        """
        # if no val is supplied, return this Literal
        if val is None:
            return self

        # convert the val to a Literal, if it isn't already one
        if not isinstance(val, Literal):
            val = Literal(val)

        if not getattr(self, "datatype"):
            raise TypeError(
                "Minuend Literal must have Numeric, Date, Datetime or Time datatype."
            )
        elif not getattr(val, "datatype"):
            raise TypeError(
                "Subtrahend Literal must have Numeric, Date, Datetime or Time datatype."
            )

        if (
            self.datatype in (_XSD_DATETIME, _XSD_DATE)
            and val.datatype in _TIME_DELTA_TYPES
        ):
            date1: Union[datetime, date] = self.toPython()
            duration: Union[Duration, timedelta] = val.toPython()
            difference = date1 - duration
            return Literal(difference, datatype=self.datatype)

        # if self is time based and value is duration
        elif self.datatype == _XSD_TIME and val.datatype in _TIME_DELTA_TYPES:
            selfv: time = self.toPython()
            valv: Union[Duration, timedelta] = val.toPython()
            sdt = datetime.combine(date(2000, 1, 1), selfv) - valv
            return Literal(sdt.time(), datatype=self.datatype)

        # if the datatypes are the same, just subtract the Python values and convert back
        if self.datatype == val.datatype:
            if self.datatype == _XSD_TIME:
                sdt = datetime.combine(date.today(), self.toPython())
                vdt = datetime.combine(date.today(), val.toPython())
                return Literal(sdt - vdt, datatype=_XSD_DURATION)
            else:
                return Literal(
                    self.toPython() - val.toPython(),
                    self.language,
                    datatype=(
                        _XSD_DURATION
                        if self.datatype in (_XSD_DATETIME, _XSD_DATE, _XSD_TIME)
                        else self.datatype
                    ),
                )

        # if the datatypes are not the same but are both numeric, subtract the Python values and strip off decimal junk
        # (i.e. tiny numbers (more than 17 decimal places) and trailing zeros) and return as a decimal
        elif (
            self.datatype in _NUMERIC_LITERAL_TYPES
            and val.datatype in _NUMERIC_LITERAL_TYPES
        ):
            return Literal(
                Decimal(
                    f"{round(Decimal(self.toPython()) - Decimal(val.toPython()), 15):f}".rstrip(
                        "0"
                    ).rstrip(
                        "."
                    )
                ),
                datatype=_XSD_DECIMAL,
            )
        # in all other cases, perform string concatenation
        else:
            raise TypeError(
                f"Cannot subtract a Literal of datatype {str(val.datatype)} from a Literal of datatype {str(self.datatype)}"
            )

    def __bool__(self) -> bool:
        """Determines the truth value of the Literal.

        Used for if statements, bool(literal), etc.
        """
        if self.value is not None:
            return bool(self.value)
        return len(self) != 0

    def __neg__(self) -> Literal:
        """Implements unary negation for Literals with numeric values.

        Example:
            ```python
            # Negating an integer Literal
            -Literal(1)
            # rdflib.term.Literal('-1', datatype=rdflib.term.URIRef('http://www.w3.org/2001/XMLSchema#integer'))

            # Negating a float Literal
            -Literal(10.5)
            # rdflib.term.Literal('-10.5', datatype=rdflib.term.URIRef('http://www.w3.org/2001/XMLSchema#double'))

            # Using a string with a datatype
            from rdflib.namespace import XSD
            -Literal("1", datatype=XSD.integer)
            # rdflib.term.Literal('-1', datatype=rdflib.term.URIRef('http://www.w3.org/2001/XMLSchema#integer'))

            # This will raise a TypeError
            -Literal("1")
            # TypeError: Not a number; rdflib.term.Literal('1')
            ```
        """

        if isinstance(self.value, (int, long_type, float)):
            return Literal(self.value.__neg__())
        else:
            raise TypeError(f"Not a number; {self!r}")

    def __pos__(self) -> Literal:
        """Implements unary plus operation for Literals with numeric values.

        Example:
            ```python
            # Applying unary plus to an integer Literal
            +Literal(1)
            # rdflib.term.Literal('1', datatype=rdflib.term.URIRef('http://www.w3.org/2001/XMLSchema#integer'))

            # Applying unary plus to a negative integer Literal
            +Literal(-1)
            # rdflib.term.Literal('-1', datatype=rdflib.term.URIRef('http://www.w3.org/2001/XMLSchema#integer'))

            # Using a string with a datatype
            from rdflib.namespace import XSD
            +Literal("-1", datatype=XSD.integer)
            # rdflib.term.Literal('-1', datatype=rdflib.term.URIRef('http://www.w3.org/2001/XMLSchema#integer'))

            # This will raise a TypeError
            +Literal("1")
            # TypeError: Not a number; rdflib.term.Literal('1')
            ```
        """
        if isinstance(self.value, (int, long_type, float)):
            return Literal(self.value.__pos__())
        else:
            raise TypeError(f"Not a number; {self!r}")

    def __abs__(self) -> Literal:
        """Implements absolute value operation for Literals with numeric values.

        Example:
            ```python
            # Absolute value of a negative integer Literal
            abs(Literal(-1))
            # rdflib.term.Literal('1', datatype=rdflib.term.URIRef('http://www.w3.org/2001/XMLSchema#integer'))

            # Using a string with a datatype
            from rdflib.namespace import XSD
            abs(Literal("-1", datatype=XSD.integer))
            # rdflib.term.Literal('1', datatype=rdflib.term.URIRef('http://www.w3.org/2001/XMLSchema#integer'))

            # This will raise a TypeError
            abs(Literal("1"))
            # TypeError: Not a number; rdflib.term.Literal('1')
            ```
        """
        if isinstance(self.value, (int, long_type, float)):
            return Literal(self.value.__abs__())
        else:
            raise TypeError(f"Not a number; {self!r}")

    def __invert__(self) -> Literal:
        """Implements bitwise NOT operation for Literals with numeric values.

        Example:
            ```python
            # Bitwise NOT of a negative integer Literal
            ~(Literal(-1))
            # rdflib.term.Literal('0', datatype=rdflib.term.URIRef('http://www.w3.org/2001/XMLSchema#integer'))

            # Using a string with a datatype
            from rdflib.namespace import XSD
            ~(Literal("-1", datatype=XSD.integer))
            # rdflib.term.Literal('0', datatype=rdflib.term.URIRef('http://www.w3.org/2001/XMLSchema#integer'))

            # This will raise a TypeError
            ~(Literal("1"))
            # TypeError: Not a number; rdflib.term.Literal('1')
            ```
        """
        if isinstance(self.value, (int, long_type, float)):
            # type error: Unsupported operand type for ~ ("float")
            return Literal(self.value.__invert__())  # type: ignore[operator] # FIXME
        else:
            raise TypeError(f"Not a number; {self!r}")

    def __gt__(self, other: Any) -> bool:
        """Implements the greater-than comparison for Literals.

        This is the base method for ordering comparisons - other comparison methods delegate here.

        Implements the ordering rules described in http://www.w3.org/TR/sparql11-query/#modOrderBy

        In summary:
        1. Literals with compatible data-types are ordered in value space
        2. Incompatible datatypes are ordered by their datatype URIs
        3. Literals with language tags are ordered by their language tags
        4. Plain literals come before xsd:string literals
        5. In the node order: None < BNode < URIRef < Literal

        Example:
            ```python
            from rdflib import XSD
            from decimal import Decimal

            # Comparing numeric literals in value space
            Literal(1) > Literal(2)  # int/int
            # False

            Literal(2.0) > Literal(1)  # double/int
            # True

            Literal(Decimal("3.3")) > Literal(2.0)  # decimal/double
            # True

            Literal(Decimal("3.3")) < Literal(4.0)  # decimal/double
            # True

            # Comparing string literals
            Literal('b') > Literal('a')  # plain lit/plain lit
            # True

            Literal('b') > Literal('a', datatype=XSD.string)  # plain lit/xsd:str
            # True

            # Incompatible datatypes ordered by DT
            Literal(1) > Literal("2")  # int>string
            # False

            # Langtagged literals ordered by lang tag
            Literal("a", lang="en") > Literal("a", lang="fr")
            # False
            ```
        """
        if other is None:
            return True  # Everything is greater than None
        if isinstance(other, Literal):
            # Fast path for comparing numeric literals
            # that are not ill-typed and don't have a None value
            if (
                (
                    self.datatype in _NUMERIC_LITERAL_TYPES
                    and other.datatype in _NUMERIC_LITERAL_TYPES
                )
                and ((not self.ill_typed) and (not other.ill_typed))
                and (self.value is not None and other.value is not None)
            ):
                return self.value > other.value

            # plain-literals and xsd:string literals
            # are "the same"
            dtself = rdflib.util._coalesce(self.datatype, default=_XSD_STRING)
            dtother = rdflib.util._coalesce(other.datatype, default=_XSD_STRING)

            if dtself != dtother:
                if rdflib.DAWG_LITERAL_COLLATION:
                    return NotImplemented
                else:
                    return dtself > dtother

            if self.language != other.language:
                if not self.language:
                    return False
                elif not other.language:
                    return True
                else:
                    return self.language > other.language

            if self.value is not None and other.value is not None:
                if type(self.value) in _TOTAL_ORDER_CASTERS:
                    caster = _TOTAL_ORDER_CASTERS[type(self.value)]
                    return caster(self.value) > caster(other.value)

                try:
                    return self.value > other.value
                except TypeError:
                    pass

            if str(self) != str(other):
                return str(self) > str(other)

            # same language, same lexical form, check real dt
            # plain-literals come before xsd:string!
            if self.datatype != other.datatype:
                if self.datatype is None:
                    return False
                elif other.datatype is None:
                    return True
                else:
                    return self.datatype > other.datatype

            return False  # they are the same

        elif isinstance(other, Node):
            return True  # Literal are the greatest!
        else:
            return NotImplemented  # we can only compare to nodes

    def __lt__(self, other: Any) -> bool:
        if other is None:
            return False  # Nothing is less than None
        if isinstance(other, Literal):
            try:
                return not self.__gt__(other) and not self.eq(other)
            except TypeError:
                return NotImplemented
        if isinstance(other, Node):
            return False  # all nodes are less-than Literals

        return NotImplemented

    def __le__(self, other: Any) -> bool:
        """Less than or equal operator for Literals.

        Example:
            ```python
            from rdflib.namespace import XSD
            Literal('2007-01-01T10:00:00', datatype=XSD.dateTime) <= Literal('2007-01-01T10:00:00', datatype=XSD.dateTime)
            # True
            ```
        """
        r = self.__lt__(other)
        if r:
            return True
        try:
            return self.eq(other)
        except TypeError:
            return NotImplemented

    def __ge__(self, other: Any) -> bool:
        r = self.__gt__(other)
        if r:
            return True
        try:
            return self.eq(other)
        except TypeError:
            return NotImplemented

    def _comparable_to(self, other: Any) -> bool:
        """Helper method to decide which things are meaningful to rich-compare with this literal."""
        if isinstance(other, Literal):
            if self.datatype is not None and other.datatype is not None:
                # two datatyped literals
                if (
                    self.datatype not in XSDToPython
                    or other.datatype not in XSDToPython
                ):
                    # non XSD DTs must match
                    if self.datatype != other.datatype:
                        return False

            else:
                # xsd:string may be compared with plain literals
                if not (self.datatype == _XSD_STRING and not other.datatype) or (
                    other.datatype == _XSD_STRING and not self.datatype
                ):
                    return False

                # if given lang-tag has to be case insensitive equal
                if (self.language or "").lower() != (other.language or "").lower():
                    return False

        return True

    # type error: Signature of "__hash__" incompatible with supertype "Identifier"
    #  Superclass: def __hash__(self: str) -> int
    #  Subclass: def __hash__(self) -> int
    #  NOTE for type ignore: This can possibly be fixed by changing how __hash__ is implemented in Identifier
    def __hash__(self) -> int:  # type: ignore[override]
        """Hash function for Literals to enable their use as dictionary keys.

        Example:
            ```python
            from rdflib.namespace import XSD
            a = {Literal('1', datatype=XSD.integer):'one'}
            Literal('1', datatype=XSD.double) in a
            # False
            ```

        Notes:
            "Called for the key object for dictionary operations,
            and by the built-in function hash(). Should return
            a 32-bit integer usable as a hash value for
            dictionary operations. The only required property
            is that objects which compare equal have the same
            hash value; it is advised to somehow mix together
            (e.g., using exclusive or) the hash values for the
            components of the object that also play a part in
            comparison of objects." -- 3.4.1 Basic customization (Python)

            "Two literals are equal if and only if all of the following hold:
            * The strings of the two lexical forms compare equal, character by character.
            * Either both or neither have language tags.
            * The language tags, if any, compare equal.
            * Either both or neither have datatype URIs.
            * The two datatype URIs, if any, compare equal, character by character."
            -- 6.5.1 Literal Equality (RDF: Concepts and Abstract Syntax)
        """
        # don't use super()... for efficiency reasons, see Identifier.__hash__
        res = str.__hash__(self)
        # Directly accessing the member is faster than the property.
        if self._language:
            res ^= hash(self._language.lower())
        if self._datatype is not None:
            res ^= hash(self._datatype)
        return res

    def __eq__(self, other: Any) -> bool:
        """Equality operator for Literals.

        Literals are only equal to other literals.

        Notes:
            "Two literals are equal if and only if all of the following hold:
            * The strings of the two lexical forms compare equal, character by character.
            * Either both or neither have language tags.
            * The language tags, if any, compare equal.
            * Either both or neither have datatype URIs.
            * The two datatype URIs, if any, compare equal, character by character."
            -- 6.5.1 Literal Equality (RDF: Concepts and Abstract Syntax)

        Example:
            ```python
            Literal("1", datatype=URIRef("foo")) == Literal("1", datatype=URIRef("foo"))
            # True
            Literal("1", datatype=URIRef("foo")) == Literal("1", datatype=URIRef("foo2"))
            # False

            Literal("1", datatype=URIRef("foo")) == Literal("2", datatype=URIRef("foo"))
            # False
            Literal("1", datatype=URIRef("foo")) == "asdf"
            # False

            from rdflib import XSD
            Literal('2007-01-01', datatype=XSD.date) == Literal('2007-01-01', datatype=XSD.date)
            # True
            Literal('2007-01-01', datatype=XSD.date) == date(2007, 1, 1)
            # False

            Literal("one", lang="en") == Literal("one", lang="en")
            # True
            Literal("hast", lang='en') == Literal("hast", lang='de')
            # False

            Literal("1", datatype=XSD.integer) == Literal(1)
            # True
            Literal("1", datatype=XSD.integer) == Literal("01", datatype=XSD.integer)
            # True
            ```
        """
        if self is other:
            return True
        if other is None:
            return False
        # Directly accessing the member is faster than the property.
        if isinstance(other, Literal):
            return (
                self._datatype == other._datatype
                and (self._language.lower() if self._language else None)
                == (other._language.lower() if other._language else None)
                and str.__eq__(self, other)
            )

        return False

    def eq(self, other: Any) -> bool:
        """Compare the value of this literal with something else.

        This comparison can be done in two ways:

        1. With the value of another literal - comparisons are then done in literal "value space"
            according to the rules of XSD subtype-substitution/type-promotion

        2. With a Python object:
           * string objects can be compared with plain-literals or those with datatype xsd:string
           * bool objects with xsd:boolean
           * int, long or float with numeric xsd types
           * date, time, datetime objects with xsd:date, xsd:time, xsd:datetime

        Any other operations returns NotImplemented.
        """
        if isinstance(other, Literal):
            # Fast path for comparing numeric literals
            # that are not ill-typed and don't have a None value
            if (
                (
                    self.datatype in _NUMERIC_LITERAL_TYPES
                    and other.datatype in _NUMERIC_LITERAL_TYPES
                )
                and ((not self.ill_typed) and (not other.ill_typed))
                and (self.value is not None and other.value is not None)
            ):
                if self.value is not None and other.value is not None:
                    return self.value == other.value
                else:
                    if str.__eq__(self, other):
                        return True
                    raise TypeError(
                        # TODO: Should this use repr strings in the error message?
                        "I cannot know that these two lexical forms do not map to the "
                        f"same value: {self} and {other}"
                    )
            if (self.language or "").lower() != (other.language or "").lower():
                return False

            dtself = rdflib.util._coalesce(self.datatype, default=_XSD_STRING)
            dtother = rdflib.util._coalesce(other.datatype, default=_XSD_STRING)

            if dtself == _XSD_STRING and dtother == _XSD_STRING:
                # string/plain literals, compare on lexical form
                return str.__eq__(self, other)

            # XML can be compared to HTML, only if html5rdf is enabled
            if (
                (dtself in _XML_COMPARABLE and dtother in _XML_COMPARABLE)
                and
                # Ill-typed can be None if unknown, but we don't want it to be True.
                ((self.ill_typed is not True) and (other.ill_typed is not True))
                and (self.value is not None and other.value is not None)
            ):
                return _isEqualXMLNode(self.value, other.value)

            if dtself != dtother:
                if rdflib.DAWG_LITERAL_COLLATION:
                    raise TypeError(
                        f"I don't know how to compare literals with datatypes {self.datatype} and {other.datatype}"
                    )
                else:
                    return False

            # matching non-string DTs now - do we compare values or
            # lexical form first?  comparing two ints is far quicker -
            # maybe there are counter examples

            if self.value is not None and other.value is not None:
                return self.value == other.value
            else:
                if str.__eq__(self, other):
                    return True

                if self.datatype == _XSD_STRING:
                    return False  # string value space=lexical space

                # matching DTs, but not matching, we cannot compare!
                raise TypeError(
                    # TODO: Should this use repr strings in the error message?
                    "I cannot know that these two lexical forms do not map to the same "
                    f"value: {self} and {other}"
                )

        elif isinstance(other, Node):
            return False  # no non-Literal nodes are equal to a literal

        elif isinstance(other, str):
            # only plain-literals can be directly compared to strings

            # TODO: Is "blah"@en eq "blah" ?
            if self.language is not None:
                return False

            if self.datatype == _XSD_STRING or self.datatype is None:
                return str(self) == other

        elif isinstance(other, (int, long_type, float)):
            if self.datatype in _NUMERIC_LITERAL_TYPES:
                return self.value == other
        elif isinstance(other, (date, datetime, time)):
            if self.datatype in (_XSD_DATETIME, _XSD_DATE, _XSD_TIME):
                return self.value == other
        elif isinstance(other, (timedelta, Duration)):
            if self.datatype in (
                _XSD_DURATION,
                _XSD_DAYTIMEDURATION,
                _XSD_YEARMONTHDURATION,
            ):
                return self.value == other
        # NOTE for type ignore: bool is a subclass of int so this won't ever run.
        elif isinstance(other, bool):  # type: ignore[unreachable, unused-ignore]
            if self.datatype == _XSD_BOOLEAN:
                return self.value == other

        return NotImplemented

    def neq(self, other: Any) -> bool:
        return not self.eq(other)

    def n3(self, namespace_manager: Optional[NamespaceManager] = None) -> str:
        r'''Returns a representation in the N3 format.

        ```python
        >>> Literal("foo").n3()
        '"foo"'

        ```

        Strings with newlines or triple-quotes:

        ```python
        >>> Literal("foo\nbar").n3()
        '"""foo\nbar"""'
        >>> Literal("''\'").n3()
        '"\'\'\'"'
        >>> Literal('"""').n3()
        '"\\"\\"\\""'

        ```

        Language:

        ```python
        >>> Literal("hello", lang="en").n3()
        '"hello"@en'

        ```

        Datatypes:

        ```python
        >>> Literal(1).n3()
        '"1"^^<http://www.w3.org/2001/XMLSchema#integer>'
        >>> Literal(1.0).n3()
        '"1.0"^^<http://www.w3.org/2001/XMLSchema#double>'
        >>> Literal(True).n3()
        '"true"^^<http://www.w3.org/2001/XMLSchema#boolean>'

        ```

        Datatype and language isn't allowed (datatype takes precedence):

        ```python
        >>> Literal(1, lang="en").n3()
        '"1"^^<http://www.w3.org/2001/XMLSchema#integer>'

        ```

        Custom datatype:

        ```python
        >>> footype = URIRef("http://example.org/ns#foo")
        >>> Literal("1", datatype=footype).n3()
        '"1"^^<http://example.org/ns#foo>'

        ```

        Passing a namespace-manager will use it to abbreviate datatype URIs:

        ```python
        >>> from rdflib import Graph
        >>> Literal(1).n3(Graph().namespace_manager)
        '"1"^^xsd:integer'

        ```
        '''
        if namespace_manager:
            return self._literal_n3(qname_callback=namespace_manager.normalizeUri)
        else:
            return self._literal_n3()

    def _literal_n3(
        self,
        use_plain: bool = False,
        qname_callback: Optional[Callable[[URIRef], Optional[str]]] = None,
    ) -> str:
        """Internal method for N3 serialization with more options.

        Args:
            use_plain: Whether to use plain literal (shorthand) output
            qname_callback: Function to convert URIs to prefixed names

        Example:
            Using plain literal (shorthand) output:

            ```python
            >>> from rdflib.namespace import XSD

            >>> Literal(1)._literal_n3(use_plain=True)
            '1'

            >>> Literal(1.0)._literal_n3(use_plain=True)
            '1e+00'

            >>> Literal(1.0, datatype=XSD.decimal)._literal_n3(use_plain=True)
            '1.0'

            >>> Literal(1.0, datatype=XSD.float)._literal_n3(use_plain=True)
            '"1.0"^^<http://www.w3.org/2001/XMLSchema#float>'

            >>> Literal("foo", datatype=XSD.string)._literal_n3(use_plain=True)
            '"foo"^^<http://www.w3.org/2001/XMLSchema#string>'

            >>> Literal(True)._literal_n3(use_plain=True)
            'true'

            >>> Literal(False)._literal_n3(use_plain=True)
            'false'

            >>> Literal(1.91)._literal_n3(use_plain=True)
            '1.91e+00'

            ```

            Only limited precision available for floats:

            ```python
            >>> Literal(0.123456789)._literal_n3(use_plain=True)
            '1.234568e-01'

            >>> Literal('0.123456789', datatype=XSD.decimal)._literal_n3(use_plain=True)
            '0.123456789'

            ```

            Using callback for datatype QNames:

            ```python
            >>> Literal(1)._literal_n3(qname_callback=lambda uri: "xsd:integer")
            '"1"^^xsd:integer'

            ```
        """
        if use_plain and self.datatype in _PLAIN_LITERAL_TYPES:
            if self.value is not None:
                # If self is inf or NaN, we need a datatype
                # (there is no plain representation)
                if self.datatype in _NUMERIC_INF_NAN_LITERAL_TYPES:
                    try:
                        v = float(self)
                        if math.isinf(v) or math.isnan(v):
                            return self._literal_n3(False, qname_callback)
                    except ValueError:
                        return self._literal_n3(False, qname_callback)

                # this is a bit of a mess -
                # we try to produce "pretty" output
                # that is compatible with n3 (turtle) notation
                if self.datatype == _XSD_DOUBLE:
                    return sub("\\.?0*e", "e", f"{float(self):e}")
                elif self.datatype == _XSD_DECIMAL:
                    s = f"{self}"  # f"{self}" is faster than "%s" % self and str(self)
                    if "." not in s and "e" not in s and "E" not in s:
                        s += ".0"
                    return s
                elif self.datatype == _XSD_BOOLEAN:
                    return f"{self}".lower()
                else:
                    return f"{self}"

        encoded: str = self._quote_encode()

        datatype = self.datatype
        quoted_dt = None
        if datatype is not None:
            if qname_callback:
                quoted_dt = qname_callback(datatype)
            if not quoted_dt:
                quoted_dt = f"<{datatype}>"
            if datatype in _NUMERIC_INF_NAN_LITERAL_TYPES:
                try:
                    v = float(self)
                    if math.isinf(v):
                        # py string reps: float: 'inf', Decimal: 'Infinity"
                        # both need to become "INF" in xsd datatypes
                        encoded = encoded.replace("inf", "INF").replace(
                            "Infinity", "INF"
                        )
                    if math.isnan(v):
                        encoded = encoded.replace("nan", "NaN")
                except ValueError:
                    # if we can't cast to float something is wrong, but we can
                    # still serialize. Warn user about it
                    warnings.warn(f"Serializing weird numerical {self!r}")

        language = self.language
        if language:
            return f"{encoded}@{language}"
        elif datatype:
            return f"{encoded}^^{quoted_dt}"
        else:
            return encoded

    def _quote_encode(self) -> str:
        # This simpler encoding doesn't work; a newline gets encoded as "\\n",
        # which is ok in sourcecode, but we want "\n".
        # encoded = self.encode('unicode-escape').replace(
        #        '\\', '\\\\').replace('"','\\"')
        # encoded = self.replace.replace('\\', '\\\\').replace('"','\\"')

        # NOTE: Could in theory chose quotes based on quotes appearing in the
        # string, i.e. '"' and "'", but N3/turtle doesn't allow "'"(?).

        if "\n" in self:
            # Triple quote this string.
            encoded = self.replace("\\", "\\\\")
            if '"""' in self:
                # is this ok?
                encoded = encoded.replace('"""', '\\"\\"\\"')
            if encoded[-1] == '"' and encoded[-2] != "\\":
                encoded = encoded[:-1] + "\\" + '"'
            # TODO: Replace usage of %s here with fstrings
            # when we have ability to escape \r and \n inside
            # f-string inline function calls
            return '"""%s"""' % encoded.replace("\r", "\\r")
        else:
            return '"%s"' % self.replace("\n", "\\n").replace("\\", "\\\\").replace(
                '"', '\\"'
            ).replace("\r", "\\r")

    def __repr__(self) -> str:
        args = [str.__repr__(self)]
        if self.language is not None:
            args.append("lang=" + repr(self.language))
        if self.datatype is not None:
            args.append("datatype=" + repr(self.datatype))
        if self.__class__ == Literal:
            clsName = "rdflib.term.Literal"  # noqa: N806
        else:
            clsName = self.__class__.__name__  # noqa: N806
        return f"{clsName}({', '.join(args)})"

    def toPython(self) -> Any:  # noqa: N802
        """
        Returns an appropriate python datatype derived from this RDF Literal
        """

        if self.value is not None:
            return self.value
        return self


def _parseXML(xmlstring: str) -> xml.dom.minidom.Document:  # noqa: N802
    retval = xml.dom.minidom.parseString(
        f"<rdflibtoplevelelement>{xmlstring}</rdflibtoplevelelement>"
    )
    retval.normalize()
    return retval


def _parse_html(lexical_form: str) -> xml.dom.minidom.DocumentFragment:
    """
    Parse the lexical form of an HTML literal into a document fragment
    using the `dom` from html5rdf tree builder.

    Args:
        lexical_form: The lexical form of the HTML literal.

    Returns:
        A document fragment representing the HTML literal.

    Raises:
        html5rdf.html5parser.ParseError: If the lexical form is not valid HTML.
    """
    parser = html5rdf.HTMLParser(
        tree=html5rdf.treebuilders.getTreeBuilder("dom"), strict=True
    )
    try:
        result: xml.dom.minidom.DocumentFragment = parser.parseFragment(lexical_form)
    except html5rdf.html5parser.ParseError as e:
        logger.info(f"Failed to parse HTML: {e}")
        raise e
    result.normalize()
    return result


def _write_html(value: xml.dom.minidom.DocumentFragment) -> bytes:
    """
    Serialize a document fragment representing an HTML literal into
    its lexical form.

    Args:
        value: A document fragment representing an HTML literal.

    Returns:
        The lexical form of the HTML literal.
    """
    result = html5rdf.serialize(value, tree="dom")
    return result


def _writeXML(  # noqa: N802
    xmlnode: Union[xml.dom.minidom.Document, xml.dom.minidom.DocumentFragment]
) -> bytes:
    if isinstance(xmlnode, xml.dom.minidom.DocumentFragment):
        d = xml.dom.minidom.Document()
        d.childNodes += xmlnode.childNodes
        xmlnode = d
    s = xmlnode.toxml("utf-8")
    # for clean round-tripping, remove headers -- I have great and
    # specific worries that this will blow up later, but this margin
    # is too narrow to contain them
    if s.startswith(b'<?xml version="1.0" encoding="utf-8"?>'):
        s = s[38:]
    if s.startswith(b"<rdflibtoplevelelement>"):
        s = s[23:-24]
    if s == b"<rdflibtoplevelelement/>":
        s = b""
    return s


def _unhexlify(value: Union[str, bytes, Literal]) -> bytes:
    # In Python 3.2, unhexlify does not support str (only bytes)
    if isinstance(value, str):
        value = value.encode()
    return unhexlify(value)


def _parseBoolean(value: Union[str, bytes]) -> bool:  # noqa: N802
    """
    Boolean is a datatype with value space {true,false},
    lexical space {"true", "false","1","0"} and
    lexical-to-value mapping {"true"→true, "false"→false, "1"→true, "0"→false}.
    """
    true_accepted_values = ["1", "true", b"1", b"true"]
    false_accepted_values = ["0", "false", b"0", b"false"]
    new_value = value.lower()
    if new_value in true_accepted_values:
        return True
    if new_value not in false_accepted_values:
        warnings.warn(
            f"Parsing weird boolean, {value!r} does not map to True or False",
            category=UserWarning,
        )
    return False


def _well_formed_by_value(lexical: Union[str, bytes], value: Any) -> bool:
    """
    This function is used as the fallback for detecting ill-typed/ill-formed
    literals and operates on the asumption that if a value (i.e.
    `Literal.value`) could be determined for a Literal then it is not
    ill-typed/ill-formed.

    This function will be called with `Literal.lexical` and `Literal.value` as arguments.
    """
    return value is not None


def _well_formed_unsignedlong(lexical: Union[str, bytes], value: Any) -> bool:
    """
    xsd:unsignedInteger and xsd:unsignedLong must not be negative
    """
    return len(lexical) > 0 and isinstance(value, long_type) and value >= 0


def _well_formed_boolean(lexical: Union[str, bytes], value: Any) -> bool:
    """
    Boolean is a datatype with value space {true,false},
    lexical space {"true", "false","1","0"} and
    lexical-to-value mapping {"true"→true, "false"→false, "1"→true, "0"→false}.
    """
    return lexical in ("true", b"true", "false", b"false", "1", b"1", "0", b"0")


def _well_formed_int(lexical: Union[str, bytes], value: Any) -> bool:
    """
    The value space of xs:int is the set of common single size integers (32 bits),
    i.e., the integers between -2147483648 and 2147483647,
    its lexical space allows any number of insignificant leading zeros.
    """
    return (
        len(lexical) > 0
        and isinstance(value, int)
        and (-2147483648 <= value <= 2147483647)
    )


def _well_formed_unsignedint(lexical: Union[str, bytes], value: Any) -> bool:
    """
    xsd:unsignedInt has a 32bit value of between 0 and 4294967295
    """
    return len(lexical) > 0 and isinstance(value, int) and (0 <= value <= 4294967295)


def _well_formed_short(lexical: Union[str, bytes], value: Any) -> bool:
    """
    The value space of xs:short is the set of common short integers (16 bits),
    i.e., the integers between -32768 and 32767,
    its lexical space allows any number of insignificant leading zeros.
    """
    return len(lexical) > 0 and isinstance(value, int) and (-32768 <= value <= 32767)


def _well_formed_unsignedshort(lexical: Union[str, bytes], value: Any) -> bool:
    """
    xsd:unsignedShort has a 16bit value of between 0 and 65535
    """
    return len(lexical) > 0 and isinstance(value, int) and (0 <= value <= 65535)


def _well_formed_byte(lexical: Union[str, bytes], value: Any) -> bool:
    """
    The value space of xs:byte is the set of common single byte integers (8 bits),
    i.e., the integers between -128 and 127,
    its lexical space allows any number of insignificant leading zeros.
    """
    return len(lexical) > 0 and isinstance(value, int) and (-128 <= value <= 127)


def _well_formed_unsignedbyte(lexical: Union[str, bytes], value: Any) -> bool:
    """
    xsd:unsignedByte has a 8bit value of between 0 and 255
    """
    return len(lexical) > 0 and isinstance(value, int) and (0 <= value <= 255)


def _well_formed_non_negative_integer(lexical: Union[str, bytes], value: Any) -> bool:
    return isinstance(value, int) and value >= 0


def _well_formed_positive_integer(lexical: Union[str, bytes], value: Any) -> bool:
    return isinstance(value, int) and value > 0


def _well_formed_non_positive_integer(lexical: Union[str, bytes], value: Any) -> bool:
    return isinstance(value, int) and value <= 0


def _well_formed_negative_integer(lexical: Union[str, bytes], value: Any) -> bool:
    return isinstance(value, int) and value < 0


# Cannot import Namespace/XSD because of circular dependencies
_XSD_PFX = "http://www.w3.org/2001/XMLSchema#"
_RDF_PFX = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"

_RDF_XMLLITERAL = URIRef(_RDF_PFX + "XMLLiteral")
_RDF_HTMLLITERAL = URIRef(_RDF_PFX + "HTML")

_XSD_STRING = URIRef(_XSD_PFX + "string")
_XSD_NORMALISED_STRING = URIRef(_XSD_PFX + "normalizedString")
_XSD_TOKEN = URIRef(_XSD_PFX + "token")

_XSD_FLOAT = URIRef(_XSD_PFX + "float")
_XSD_DOUBLE = URIRef(_XSD_PFX + "double")
_XSD_DECIMAL = URIRef(_XSD_PFX + "decimal")
_XSD_INTEGER = URIRef(_XSD_PFX + "integer")
_XSD_BOOLEAN = URIRef(_XSD_PFX + "boolean")

_XSD_DATETIME = URIRef(_XSD_PFX + "dateTime")
_XSD_DATE = URIRef(_XSD_PFX + "date")
_XSD_TIME = URIRef(_XSD_PFX + "time")
_XSD_DURATION = URIRef(_XSD_PFX + "duration")
_XSD_DAYTIMEDURATION = URIRef(_XSD_PFX + "dayTimeDuration")
_XSD_YEARMONTHDURATION = URIRef(_XSD_PFX + "yearMonthDuration")

_OWL_RATIONAL = URIRef("http://www.w3.org/2002/07/owl#rational")
_XSD_B64BINARY = URIRef(_XSD_PFX + "base64Binary")
_XSD_HEXBINARY = URIRef(_XSD_PFX + "hexBinary")
_XSD_GYEAR = URIRef(_XSD_PFX + "gYear")
_XSD_GYEARMONTH = URIRef(_XSD_PFX + "gYearMonth")
# TODO: gMonthDay, gDay, gMonth

_NUMERIC_LITERAL_TYPES: Tuple[URIRef, ...] = (
    _XSD_INTEGER,
    _XSD_DECIMAL,
    _XSD_DOUBLE,
    URIRef(_XSD_PFX + "float"),
    URIRef(_XSD_PFX + "byte"),
    URIRef(_XSD_PFX + "int"),
    URIRef(_XSD_PFX + "long"),
    URIRef(_XSD_PFX + "negativeInteger"),
    URIRef(_XSD_PFX + "nonNegativeInteger"),
    URIRef(_XSD_PFX + "nonPositiveInteger"),
    URIRef(_XSD_PFX + "positiveInteger"),
    URIRef(_XSD_PFX + "short"),
    URIRef(_XSD_PFX + "unsignedByte"),
    URIRef(_XSD_PFX + "unsignedInt"),
    URIRef(_XSD_PFX + "unsignedLong"),
    URIRef(_XSD_PFX + "unsignedShort"),
)

# these have "native" syntax in N3/SPARQL
_PLAIN_LITERAL_TYPES: Tuple[URIRef, ...] = (
    _XSD_INTEGER,
    _XSD_BOOLEAN,
    _XSD_DOUBLE,
    _XSD_DECIMAL,
    _OWL_RATIONAL,
)

# these have special INF and NaN XSD representations
_NUMERIC_INF_NAN_LITERAL_TYPES: Tuple[URIRef, ...] = (
    URIRef(_XSD_PFX + "float"),
    _XSD_DOUBLE,
    _XSD_DECIMAL,
)

# these need dedicated operators
_DATE_AND_TIME_TYPES: Tuple[URIRef, ...] = (
    _XSD_DATETIME,
    _XSD_DATE,
    _XSD_TIME,
)

# These are recognized datatype IRIs
# (https://www.w3.org/TR/rdf11-concepts/#dfn-recognized-datatype-iris) that
# represents durations.
_TIME_DELTA_TYPES: Tuple[URIRef, ...] = (
    _XSD_DURATION,
    _XSD_DAYTIMEDURATION,
)

_ALL_DATE_AND_TIME_TYPES: Tuple[URIRef, ...] = _DATE_AND_TIME_TYPES + _TIME_DELTA_TYPES

# the following types need special treatment for reasonable sorting because
# certain instances can't be compared to each other. We treat this by
# partitioning and then sorting within those partitions.
_TOTAL_ORDER_CASTERS: Dict[Type[Any], Callable[[Any], Any]] = {
    datetime: lambda value: (
        # naive vs. aware
        value.tzinfo is not None and value.tzinfo.utcoffset(value) is not None,
        value,
    ),
    time: lambda value: (
        # naive vs. aware
        value.tzinfo is not None and value.tzinfo.utcoffset(None) is not None,
        value,
    ),
    xml.dom.minidom.Document: lambda value: value.toxml(),
}


_STRING_LITERAL_TYPES: Tuple[URIRef, ...] = (
    _XSD_STRING,
    _RDF_XMLLITERAL,
    _RDF_HTMLLITERAL,
    URIRef(_XSD_PFX + "normalizedString"),
    URIRef(_XSD_PFX + "token"),
)

_StrT = TypeVar("_StrT", bound=str)


def _py2literal(
    obj: Any,
    pType: Any,  # noqa: N803
    castFunc: Optional[Callable[[Any], Any]],  # noqa: N803
    dType: Optional[_StrT],  # noqa: N803
) -> Tuple[Any, Optional[_StrT]]:
    if castFunc is not None:
        return castFunc(obj), dType
    elif dType is not None:
        return obj, dType
    else:
        return obj, None


def _castPythonToLiteral(  # noqa: N802
    obj: Any, datatype: Optional[str]
) -> Tuple[Any, Optional[str]]:
    """
    Casts a tuple of a python type and a special datatype URI to a tuple of the lexical value and a
    datatype URI (or None)
    """
    castFunc: Optional[Callable[[Any], Union[str, bytes]]]  # noqa: N806
    dType: Optional[str]  # noqa: N806
    for (pType, dType), castFunc in _SpecificPythonToXSDRules:  # noqa: N806
        if isinstance(obj, pType) and dType == datatype:
            return _py2literal(obj, pType, castFunc, dType)

    for pType, (castFunc, dType) in _GenericPythonToXSDRules:  # noqa: N806
        if isinstance(obj, pType):
            return _py2literal(obj, pType, castFunc, dType)
    return obj, None  # TODO: is this right for the fall through case?


# Mappings from Python types to XSD datatypes and back (borrowed from sparta)
# datetime instances are also instances of date... so we need to order these.

# SPARQL/Turtle/N3 has shortcuts for integer, double, decimal
# python has only float - to be in tune with sparql/n3/turtle
# we default to XSD.double for float literals

# python ints are promoted to longs when overflowing
# python longs have no limit
# both map to the abstract integer type,
# rather than some concrete bit-limited datatype
_GenericPythonToXSDRules: List[
    Tuple[Type[Any], Tuple[Optional[Callable[[Any], Union[str, bytes]]], Optional[str]]]
] = [
    (str, (None, None)),
    (float, (None, _XSD_DOUBLE)),
    (bool, (lambda i: str(i).lower(), _XSD_BOOLEAN)),
    (int, (None, _XSD_INTEGER)),
    (long_type, (None, _XSD_INTEGER)),
    (Decimal, (lambda i: f"{i:f}", _XSD_DECIMAL)),
    (datetime, (lambda i: i.isoformat(), _XSD_DATETIME)),
    (date, (lambda i: i.isoformat(), _XSD_DATE)),
    (time, (lambda i: i.isoformat(), _XSD_TIME)),
    (Duration, (lambda i: duration_isoformat(i), _XSD_DURATION)),
    (timedelta, (lambda i: duration_isoformat(i), _XSD_DAYTIMEDURATION)),
    (xml.dom.minidom.Document, (_writeXML, _RDF_XMLLITERAL)),
    (Fraction, (None, _OWL_RATIONAL)),
]

if html5rdf is not None:
    # This is a bit dirty, by accident the html5rdf parser produces
    # DocumentFragments, and the xml parser Documents, letting this
    # decide what datatype to use makes roundtripping easier, but its a
    # bit random.

    # This must happen before _GenericPythonToXSDRules is assigned to
    # _OriginalGenericPythonToXSDRules.
    _GenericPythonToXSDRules.append(
        (xml.dom.minidom.DocumentFragment, (_write_html, _RDF_HTMLLITERAL))
    )

_OriginalGenericPythonToXSDRules = list(_GenericPythonToXSDRules)

_SpecificPythonToXSDRules: List[
    Tuple[Tuple[Type[Any], str], Optional[Callable[[Any], Union[str, bytes]]]]
] = [
    ((date, _XSD_GYEAR), lambda val: val.strftime("%Y").zfill(4)),
    ((date, _XSD_GYEARMONTH), lambda val: val.strftime("%Y-%m").zfill(7)),
    ((str, _XSD_HEXBINARY), hexlify),
    ((bytes, _XSD_HEXBINARY), hexlify),
    ((str, _XSD_B64BINARY), b64encode),
    ((bytes, _XSD_B64BINARY), b64encode),
]

_OriginalSpecificPythonToXSDRules = list(_SpecificPythonToXSDRules)

XSDToPython: Dict[Optional[str], Optional[Callable[[str], Any]]] = {
    None: None,  # plain literals map directly to value space
    URIRef(_XSD_PFX + "time"): parse_time,
    URIRef(_XSD_PFX + "date"): parse_xsd_date,
    URIRef(_XSD_PFX + "dateTime"): parse_datetime,
    URIRef(_XSD_PFX + "duration"): parse_xsd_duration,
    URIRef(_XSD_PFX + "dayTimeDuration"): parse_xsd_duration,
    URIRef(_XSD_PFX + "yearMonthDuration"): parse_xsd_duration,
    URIRef(_XSD_PFX + "hexBinary"): _unhexlify,
    URIRef(_XSD_PFX + "string"): None,
    URIRef(_XSD_PFX + "normalizedString"): None,
    URIRef(_XSD_PFX + "token"): None,
    URIRef(_XSD_PFX + "language"): None,
    URIRef(_XSD_PFX + "boolean"): _parseBoolean,
    URIRef(_XSD_PFX + "decimal"): Decimal,
    URIRef(_XSD_PFX + "integer"): long_type,
    URIRef(_XSD_PFX + "nonPositiveInteger"): long_type,
    URIRef(_XSD_PFX + "long"): long_type,
    URIRef(_XSD_PFX + "nonNegativeInteger"): long_type,
    URIRef(_XSD_PFX + "negativeInteger"): long_type,
    URIRef(_XSD_PFX + "int"): int,
    URIRef(_XSD_PFX + "unsignedLong"): long_type,
    URIRef(_XSD_PFX + "positiveInteger"): long_type,
    URIRef(_XSD_PFX + "short"): int,
    URIRef(_XSD_PFX + "unsignedInt"): int,
    URIRef(_XSD_PFX + "byte"): int,
    URIRef(_XSD_PFX + "unsignedShort"): int,
    URIRef(_XSD_PFX + "unsignedByte"): int,
    URIRef(_XSD_PFX + "float"): float,
    URIRef(_XSD_PFX + "double"): float,
    URIRef(_XSD_PFX + "base64Binary"): b64decode,
    URIRef(_XSD_PFX + "anyURI"): None,
    _RDF_XMLLITERAL: _parseXML,
}

if html5rdf is not None:
    # It is probably best to keep this close to the definition of
    # _GenericPythonToXSDRules so nobody misses it.
    XSDToPython[_RDF_HTMLLITERAL] = _parse_html
    _XML_COMPARABLE: Tuple[URIRef, ...] = (_RDF_XMLLITERAL, _RDF_HTMLLITERAL)
else:
    _XML_COMPARABLE = (_RDF_XMLLITERAL,)

_check_well_formed_types: Dict[URIRef, Callable[[Union[str, bytes], Any], bool]] = {
    URIRef(_XSD_PFX + "boolean"): _well_formed_boolean,
    URIRef(_XSD_PFX + "nonPositiveInteger"): _well_formed_non_positive_integer,
    URIRef(_XSD_PFX + "nonNegativeInteger"): _well_formed_non_negative_integer,
    URIRef(_XSD_PFX + "negativeInteger"): _well_formed_negative_integer,
    URIRef(_XSD_PFX + "positiveInteger"): _well_formed_positive_integer,
    URIRef(_XSD_PFX + "int"): _well_formed_int,
    URIRef(_XSD_PFX + "short"): _well_formed_short,
    URIRef(_XSD_PFX + "byte"): _well_formed_byte,
    URIRef(_XSD_PFX + "unsignedInt"): _well_formed_unsignedint,
    URIRef(_XSD_PFX + "unsignedLong"): _well_formed_unsignedlong,
    URIRef(_XSD_PFX + "unsignedShort"): _well_formed_unsignedshort,
    URIRef(_XSD_PFX + "unsignedByte"): _well_formed_unsignedbyte,
}

_toPythonMapping: Dict[Optional[str], Optional[Callable[[str], Any]]] = {}  # noqa: N816

_toPythonMapping.update(XSDToPython)


def _reset_bindings() -> None:
    """Reset lexical<->value space binding for `Literal`."""
    _toPythonMapping.clear()
    _toPythonMapping.update(XSDToPython)

    _GenericPythonToXSDRules.clear()
    _GenericPythonToXSDRules.extend(_OriginalGenericPythonToXSDRules)

    _SpecificPythonToXSDRules.clear()
    _SpecificPythonToXSDRules.extend(_OriginalSpecificPythonToXSDRules)


def _castLexicalToPython(  # noqa: N802
    lexical: Union[str, bytes], datatype: Optional[URIRef]
) -> Any:
    """Map a lexical form to the value-space for the given datatype.

    Returns:
        A python object for the value or `None`
    """
    try:
        conv_func = _toPythonMapping[datatype]
    except KeyError:
        # no conv_func -> unknown data-type
        return None

    if conv_func is not None:
        try:
            # type error: Argument 1 has incompatible type "Union[str, bytes]"; expected "str"
            # NOTE for type ignore: various functions in _toPythonMapping will
            # only work for str, so there is some inconsistency here, the right
            # approach may be to change lexical to be of str type but this will
            # require runtime changes.
            return conv_func(lexical)  # type: ignore[arg-type]
        except Exception:
            logger.warning(
                f"Failed to convert Literal lexical form to value. Datatype={datatype}, Converter={conv_func}",
                exc_info=True,
            )
            # not a valid lexical representation for this dt
            return None
    else:
        # no conv func means 1-1 lexical<->value-space mapping
        try:
            return str(lexical)
        except UnicodeDecodeError:
            # type error: Argument 1 to "str" has incompatible type "Union[str, bytes]"; expected "bytes"
            # NOTE for type ignore: code assumes that lexical is of type bytes
            # at this point.
            return str(lexical, "utf-8")  # type: ignore[arg-type]


_AnyT = TypeVar("_AnyT", bound=Any)


def _normalise_XSD_STRING(lexical_or_value: _AnyT) -> _AnyT:  # noqa: N802
    """Replaces \\t, \\n, \\r (#x9 (tab), #xA (linefeed), and #xD (carriage return)) with space without any whitespace collapsing."""
    if isinstance(lexical_or_value, str):
        # type error: Incompatible return value type (got "str", expected "_AnyT")  [return-value]
        # NOTE for type ignore: this is an issue with mypy: https://github.com/python/mypy/issues/10003
        return lexical_or_value.replace("\t", " ").replace("\n", " ").replace("\r", " ")  # type: ignore[return-value]
    return lexical_or_value


def _strip_and_collapse_whitespace(lexical_or_value: _AnyT) -> _AnyT:
    if isinstance(lexical_or_value, str):
        # Use regex to substitute contiguous whitespace into a single whitespace. Strip trailing whitespace.
        # type error: Incompatible return value type (got "str", expected "_AnyT")  [return-value]
        # NOTE for type ignore: this is an issue with mypy: https://github.com/python/mypy/issues/10003
        return re.sub(" +", " ", lexical_or_value.strip())  # type: ignore[return-value]
    return lexical_or_value


def bind(
    datatype: str,
    pythontype: Type[Any],
    constructor: Optional[Callable[[str], Any]] = None,
    lexicalizer: Optional[Callable[[Any], Union[str, bytes]]] = None,
    datatype_specific: bool = False,
) -> None:
    """
    register a new datatype<->pythontype binding

    Args:
        constructor: An optional function for converting lexical forms
            into a Python instances, if not given the pythontype
            is used directly
        lexicalizer: An optional function for converting python objects to
            lexical form, if not given object.__str__ is used
        datatype_specific: Makes the lexicalizer function be accessible
            from the pair (pythontype, datatype) if set to True
            or from the pythontype otherwise. False by default
    """
    if datatype_specific and datatype is None:
        raise Exception("No datatype given for a datatype-specific binding")

    if datatype in _toPythonMapping:
        logger.warning(f"datatype '{datatype}' was already bound. Rebinding.")

    if constructor is None:
        constructor = pythontype
    _toPythonMapping[datatype] = constructor
    if datatype_specific:
        _SpecificPythonToXSDRules.append(((pythontype, datatype), lexicalizer))
    else:
        _GenericPythonToXSDRules.append((pythontype, (lexicalizer, datatype)))


class Variable(Identifier):
    """
    A Variable - this is used for querying, or in Formula aware
    graphs, where Variables can be stored
    """

    __slots__ = ()

    def __new__(cls, value: str):
        if len(value) == 0:
            raise Exception("Attempted to create variable with empty string as name!")
        if value[0] == "?":
            value = value[1:]
        return str.__new__(cls, value)

    def __repr__(self) -> str:
        if self.__class__ is Variable:
            clsName = "rdflib.term.Variable"  # noqa: N806
        else:
            clsName = self.__class__.__name__  # noqa: N806

        return f"{clsName}({str.__repr__(self)})"

    def toPython(self) -> str:  # noqa: N802
        return "?" + self

    def n3(self, namespace_manager: Optional[NamespaceManager] = None) -> str:
        return "?" + self

    def __reduce__(self) -> Tuple[Type[Variable], Tuple[str]]:
        return (Variable, (str(self),))


# Nodes are ordered like this
# See http://www.w3.org/TR/sparql11-query/#modOrderBy
# we leave "space" for more subclasses of Node elsewhere
# default-dict to grazefully fail for new subclasses
_ORDERING: Dict[Type[Node], int] = defaultdict(int)
_ORDERING.update({BNode: 10, Variable: 20, URIRef: 30, Literal: 40})


def _isEqualXMLNode(  # noqa: N802
    node: Union[
        None,
        xml.dom.minidom.Attr,
        xml.dom.minidom.Comment,
        xml.dom.minidom.Document,
        xml.dom.minidom.DocumentFragment,
        xml.dom.minidom.DocumentType,
        xml.dom.minidom.Element,
        xml.dom.minidom.Entity,
        xml.dom.minidom.Notation,
        xml.dom.minidom.ProcessingInstruction,
        xml.dom.minidom.Text,
    ],
    other: Union[
        None,
        xml.dom.minidom.Attr,
        xml.dom.minidom.Comment,
        xml.dom.minidom.Document,
        xml.dom.minidom.DocumentFragment,
        xml.dom.minidom.DocumentType,
        xml.dom.minidom.Element,
        xml.dom.minidom.Entity,
        xml.dom.minidom.Notation,
        xml.dom.minidom.ProcessingInstruction,
        xml.dom.minidom.Text,
    ],
) -> bool:
    # importing xml.dom.minidom.Node as XMLNode to avoid confusion with
    # rdflib.term.Node
    from xml.dom.minidom import Node as XMLNode

    def recurse():
        # Recursion through the children
        # In Python2, the semantics of 'map' is such that the check on
        # length would be unnecessary. In Python 3,
        # the semantics of map has changed (why, oh why???) and the check
        # for the length becomes necessary...
        # type error: Item "None" of "Union[None, Attr, Comment, Document, DocumentFragment, DocumentType, Element, Entity, Notation, ProcessingInstruction, Text]" has no attribute "childNodes"
        if len(node.childNodes) != len(other.childNodes):  # type: ignore[union-attr]
            return False
        # type error: Item "None" of "Union[None, Attr, Comment, Document, DocumentFragment, DocumentType, Element, Entity, Notation, ProcessingInstruction, Text]" has no attribute "childNodes"
        for nc, oc in map(lambda x, y: (x, y), node.childNodes, other.childNodes):  # type: ignore[union-attr]
            if not _isEqualXMLNode(nc, oc):
                return False
        # if we got here then everything is fine:
        return True

    if node is None or other is None:
        return False

    if node.nodeType != other.nodeType:
        return False

    if node.nodeType in [XMLNode.DOCUMENT_NODE, XMLNode.DOCUMENT_FRAGMENT_NODE]:
        return recurse()

    elif node.nodeType == XMLNode.ELEMENT_NODE:
        if TYPE_CHECKING:
            assert isinstance(node, xml.dom.minidom.Element)
            assert isinstance(other, xml.dom.minidom.Element)
        # Get the basics right
        if not (
            node.tagName == other.tagName and node.namespaceURI == other.namespaceURI
        ):
            return False

        # Handle the (namespaced) attributes; the namespace setting key
        # should be ignored, though
        # Note that the minidom orders the keys already, so we do not have
        # to worry about that, which is a bonus...
        n_keys = [
            k
            for k in node.attributes.keysNS()
            if k[0] != "http://www.w3.org/2000/xmlns/"
        ]
        o_keys = [
            k
            for k in other.attributes.keysNS()
            if k[0] != "http://www.w3.org/2000/xmlns/"
        ]
        if len(n_keys) != len(o_keys):
            return False
        for k in n_keys:
            if not (
                k in o_keys
                and node.getAttributeNS(k[0], k[1]) == other.getAttributeNS(k[0], k[1])
            ):
                return False

        # if we got here, the attributes are all right, we can go down
        # the tree recursively
        return recurse()

    elif node.nodeType in [
        XMLNode.TEXT_NODE,
        XMLNode.COMMENT_NODE,
        XMLNode.CDATA_SECTION_NODE,
        XMLNode.NOTATION_NODE,
    ]:
        if TYPE_CHECKING:
            assert isinstance(
                node,
                (
                    xml.dom.minidom.Text,
                    xml.dom.minidom.Comment,
                    xml.dom.minidom.CDATASection,
                    xml.dom.minidom.Notation,
                ),
            )
            assert isinstance(
                other,
                (
                    xml.dom.minidom.Text,
                    xml.dom.minidom.Comment,
                    xml.dom.minidom.CDATASection,
                    xml.dom.minidom.Notation,
                ),
            )
        # type error: Item "Notation" of "Union[Comment, Document, Notation, Text]" has no attribute "data"
        return node.data == other.data  # type: ignore[union-attr] # FIXME

    elif node.nodeType == XMLNode.PROCESSING_INSTRUCTION_NODE:
        if TYPE_CHECKING:
            assert isinstance(node, xml.dom.minidom.ProcessingInstruction)
            assert isinstance(other, xml.dom.minidom.ProcessingInstruction)
        return node.data == other.data and node.target == other.target

    elif node.nodeType == XMLNode.ENTITY_NODE:
        return node.nodeValue == other.nodeValue

    elif node.nodeType == XMLNode.DOCUMENT_TYPE_NODE:
        if TYPE_CHECKING:
            assert isinstance(node, xml.dom.minidom.DocumentType)
            assert isinstance(other, xml.dom.minidom.DocumentType)
        return node.publicId == other.publicId and node.systemId == other.systemId

    else:
        # should not happen, in fact
        raise Exception(f"I dont know how to compare XML Node type: {node.nodeType}")
