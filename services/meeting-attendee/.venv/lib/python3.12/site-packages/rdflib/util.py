"""
Some utility functions.

Miscellaneous utilities

* list2set
* first
* uniq
* more_than

Term characterisation and generation

* to_term
* from_n3

Date/time utilities

* date_time
* parse_date_time

"""

from __future__ import annotations

from calendar import timegm
from os.path import splitext

# from time import daylight
from time import altzone, gmtime, localtime, time, timezone
from typing import (
    TYPE_CHECKING,
    Any,
    Callable,
    Dict,
    Hashable,
    Iterable,
    Iterator,
    List,
    Optional,
    Set,
    Tuple,
    TypeVar,
    Union,
    overload,
)
from urllib.parse import quote, urlsplit, urlunsplit

import rdflib.graph  # avoid circular dependency
import rdflib.namespace
import rdflib.term
from rdflib.compat import sign

if TYPE_CHECKING:
    from rdflib.graph import Graph


__all__ = [
    "list2set",
    "first",
    "uniq",
    "more_than",
    "to_term",
    "from_n3",
    "date_time",
    "parse_date_time",
    "guess_format",
    "find_roots",
    "get_tree",
    "_coalesce",
    "_iri2uri",
]

_HashableT = TypeVar("_HashableT", bound=Hashable)
_AnyT = TypeVar("_AnyT")


SUFFIX_FORMAT_MAP = {
    "xml": "xml",
    "rdf": "xml",
    "owl": "xml",
    "n3": "n3",
    "ttl": "turtle",
    "nt": "nt",
    "trix": "trix",
    "xhtml": "rdfa",
    "html": "rdfa",
    "svg": "rdfa",
    "nq": "nquads",
    "nquads": "nquads",
    "trig": "trig",
    "json": "json-ld",
    "jsonld": "json-ld",
    "json-ld": "json-ld",
}


FORMAT_MIMETYPE_MAP = {
    "xml": ["application/rdf+xml"],
    "n3": ["text/n3"],
    "turtle": ["text/turtle"],
    "nt": ["application/n-triples"],
    "trix": ["application/trix"],
    "rdfa": ["text/html", "application/xhtml+xml"],
    "nquads": ["application/n-quads"],
    "trig": ["application/trig"],
    "json-ld": ["application/ld+json"],
}


RESPONSE_TABLE_FORMAT_MIMETYPE_MAP = {
    "xml": ["application/sparql-results+xml"],
    "json": ["application/sparql-results+json"],
    "csv": ["text/csv"],
    "tsv": ["text/tab-separated-values"],
}


def list2set(seq: Iterable[_HashableT]) -> List[_HashableT]:
    """
    Return a new list without duplicates.
    Preserves the order, unlike set(seq)
    """
    seen = set()
    # type error: "add" of "set" does not return a value
    return [x for x in seq if x not in seen and not seen.add(x)]  # type: ignore[func-returns-value]


def first(seq: Iterable[_AnyT]) -> Optional[_AnyT]:
    """
    return the first element in a python sequence
    for graphs, use graph.value instead
    """
    for result in seq:
        return result
    return None


def uniq(sequence: Iterable[str], strip: int = 0) -> Set[str]:
    """removes duplicate strings from the sequence."""
    if strip:
        return set(s.strip() for s in sequence)
    else:
        return set(sequence)


def more_than(sequence: Iterable[Any], number: int) -> int:
    "Returns 1 if sequence has more items than number and 0 if not."
    i = 0
    for item in sequence:
        i += 1
        if i > number:
            return 1
    return 0


def to_term(
    s: Optional[str], default: Optional[rdflib.term.Identifier] = None
) -> Optional[rdflib.term.Identifier]:
    """
    Creates and returns an Identifier of type corresponding
    to the pattern of the given positional argument string `s`:

    '' returns the `default` keyword argument value or `None`

    '<s>' returns `URIRef(s)` (i.e. without angle brackets)

    '"s"' returns `Literal(s)` (i.e. without doublequotes)

    '_s' returns `BNode(s)` (i.e. without leading underscore)

    """
    if not s:
        return default
    elif s.startswith("<") and s.endswith(">"):
        return rdflib.term.URIRef(s[1:-1])
    elif s.startswith('"') and s.endswith('"'):
        return rdflib.term.Literal(s[1:-1])
    elif s.startswith("_"):
        return rdflib.term.BNode(s)
    else:
        msg = "Unrecognised term syntax: '%s'" % s
        raise Exception(msg)


def from_n3(
    s: str,
    default: Optional[str] = None,
    backend: Optional[str] = None,
    nsm: Optional[rdflib.namespace.NamespaceManager] = None,
) -> Optional[Union[rdflib.term.Node, str]]:
    r'''Creates the Identifier corresponding to the given n3 string.

    ```python
    >>> from rdflib.term import URIRef, Literal
    >>> from rdflib.namespace import NamespaceManager
    >>> from_n3('<http://ex.com/foo>') == URIRef('http://ex.com/foo')
    True
    >>> from_n3('"foo"@de') == Literal('foo', lang='de')
    True
    >>> from_n3('"""multi\nline\nstring"""@en') == Literal(
    ...     'multi\nline\nstring', lang='en')
    True
    >>> from_n3('42') == Literal(42)
    True
    >>> from_n3(Literal(42).n3()) == Literal(42)
    True
    >>> from_n3('"42"^^xsd:integer') == Literal(42)
    True
    >>> from rdflib import RDFS
    >>> from_n3('rdfs:label') == RDFS['label']
    True
    >>> nsm = NamespaceManager(rdflib.graph.Graph())
    >>> nsm.bind('dbpedia', 'http://dbpedia.org/resource/')
    >>> berlin = URIRef('http://dbpedia.org/resource/Berlin')
    >>> from_n3('dbpedia:Berlin', nsm=nsm) == berlin
    True

    ```
    '''
    if not s:
        return default
    if s.startswith("<"):
        # Hack: this should correctly handle strings with either native unicode
        # characters, or \u1234 unicode escapes.
        return rdflib.term.URIRef(
            s[1:-1].encode("raw-unicode-escape").decode("unicode-escape")
        )
    elif s.startswith('"'):
        if s.startswith('"""'):
            quotes = '"""'
        else:
            quotes = '"'
        value, rest = s.rsplit(quotes, 1)
        value = value[len(quotes) :]  # strip leading quotes
        datatype = None
        language = None

        # as a given datatype overrules lang-tag check for it first
        dtoffset = rest.rfind("^^")
        if dtoffset >= 0:
            # found a datatype
            # datatype has to come after lang-tag so ignore everything before
            # see: http://www.w3.org/TR/2011/WD-turtle-20110809/
            # #prod-turtle2-RDFLiteral
            datatype = from_n3(rest[dtoffset + 2 :], default, backend, nsm)
        else:
            if rest.startswith("@"):
                language = rest[1:]  # strip leading at sign

        value = value.replace(r"\"", '"')
        # unicode-escape interprets \xhh as an escape sequence,
        # but n3 does not define it as such.
        value = value.replace(r"\x", r"\\x")
        # Hack: this should correctly handle strings with either native unicode
        # characters, or \u1234 unicode escapes.
        value = value.encode("raw-unicode-escape").decode("unicode-escape")
        # type error: Argument 3 to "Literal" has incompatible type "Union[Node, str, None]"; expected "Optional[str]"
        return rdflib.term.Literal(value, language, datatype)  # type: ignore[arg-type]
    elif s == "true" or s == "false":
        return rdflib.term.Literal(s == "true")
    elif (
        s.lower()
        .replace(".", "", 1)
        .replace("-", "", 1)
        .replace("e", "", 1)
        .isnumeric()
    ):
        if "e" in s.lower():
            return rdflib.term.Literal(s, datatype=rdflib.namespace.XSD.double)
        if "." in s:
            return rdflib.term.Literal(float(s), datatype=rdflib.namespace.XSD.decimal)
        return rdflib.term.Literal(int(s), datatype=rdflib.namespace.XSD.integer)

    elif s.startswith("{"):
        identifier = from_n3(s[1:-1])
        # type error: Argument 1 to "QuotedGraph" has incompatible type "Optional[str]"; expected "Union[Store, str]"
        # type error: Argument 2 to "QuotedGraph" has incompatible type "Union[Node, str, None]"; expected "Union[IdentifiedNode, str, None]"
        return rdflib.graph.QuotedGraph(backend, identifier)  # type: ignore[arg-type]
    elif s.startswith("["):
        identifier = from_n3(s[1:-1])
        # type error: Argument 1 to "Graph" has incompatible type "Optional[str]"; expected "Union[Store, str]"
        # type error: Argument 2 to "Graph" has incompatible type "Union[Node, str, None]"; expected "Union[IdentifiedNode, str, None]"
        return rdflib.graph.Graph(backend, identifier)  # type: ignore[arg-type]
    elif s.startswith("_:"):
        return rdflib.term.BNode(s[2:])
    elif ":" in s:
        if nsm is None:
            # instantiate default NamespaceManager and rely on its defaults
            nsm = rdflib.namespace.NamespaceManager(rdflib.graph.Graph())
        prefix, last_part = s.split(":", 1)
        ns = dict(nsm.namespaces())[prefix]
        return rdflib.namespace.Namespace(ns)[last_part]
    else:
        return rdflib.term.BNode(s)


def date_time(t=None, local_time_zone=False):
    """http://www.w3.org/TR/NOTE-datetime ex: 1997-07-16T19:20:30Z

    ```python
    >>> date_time(1126482850)
    '2005-09-11T23:54:10Z'

    @@ this will change depending on where it is run
    #>>> date_time(1126482850, local_time_zone=True)
    #'2005-09-11T19:54:10-04:00'

    >>> date_time(1)
    '1970-01-01T00:00:01Z'

    >>> date_time(0)
    '1970-01-01T00:00:00Z'

    ```
    """
    if t is None:
        t = time()

    if local_time_zone:
        time_tuple = localtime(t)
        if time_tuple[8]:
            tz_mins = altzone // 60
        else:
            tz_mins = timezone // 60
        tzd = "-%02d:%02d" % (tz_mins // 60, tz_mins % 60)
    else:
        time_tuple = gmtime(t)
        tzd = "Z"

    year, month, day, hh, mm, ss, wd, y, z = time_tuple
    s = "%0004d-%02d-%02dT%02d:%02d:%02d%s" % (year, month, day, hh, mm, ss, tzd)
    return s


def parse_date_time(val: str) -> int:
    """always returns seconds in UTC

    ```python
    # tests are written like this to make any errors easier to understand
    >>> parse_date_time('2005-09-11T23:54:10Z') - 1126482850.0
    0.0

    >>> parse_date_time('2005-09-11T16:54:10-07:00') - 1126482850.0
    0.0

    >>> parse_date_time('1970-01-01T00:00:01Z') - 1.0
    0.0

    >>> parse_date_time('1970-01-01T00:00:00Z') - 0.0
    0.0
    >>> parse_date_time("2005-09-05T10:42:00") - 1125916920.0
    0.0

    ```
    """

    if "T" not in val:
        val += "T00:00:00Z"

    ymd, time = val.split("T")
    hms, tz_str = time[0:8], time[8:]

    if not tz_str or tz_str == "Z":
        time = time[:-1]
        tz_offset = 0
    else:
        signed_hrs = int(tz_str[:3])
        mins = int(tz_str[4:6])
        secs = (sign(signed_hrs) * mins + signed_hrs * 60) * 60
        tz_offset = -secs

    year, month, day = ymd.split("-")
    hour, minute, second = hms.split(":")

    t = timegm(
        (int(year), int(month), int(day), int(hour), int(minute), int(second), 0, 0, 0)
    )
    t = t + tz_offset
    return t


def guess_format(fpath: str, fmap: Optional[Dict[str, str]] = None) -> Optional[str]:
    """
    Guess RDF serialization based on file suffix. Uses
    `SUFFIX_FORMAT_MAP` unless `fmap` is provided.

    Example:
        ```python
        >>> guess_format('path/to/file.rdf')
        'xml'
        >>> guess_format('path/to/file.owl')
        'xml'
        >>> guess_format('path/to/file.ttl')
        'turtle'
        >>> guess_format('path/to/file.json')
        'json-ld'
        >>> guess_format('path/to/file.xhtml')
        'rdfa'
        >>> guess_format('path/to/file.svg')
        'rdfa'
        >>> guess_format('path/to/file.xhtml', {'xhtml': 'grddl'})
        'grddl'

        ```

        This also works with just the suffixes, with or without leading dot, and
        regardless of letter case:

        ```python
        >>> guess_format('.rdf')
        'xml'
        >>> guess_format('rdf')
        'xml'
        >>> guess_format('RDF')
        'xml'

        ```
    """
    fmap = fmap or SUFFIX_FORMAT_MAP
    return fmap.get(_get_ext(fpath)) or fmap.get(fpath.lower())


def _get_ext(fpath: str, lower: bool = True) -> str:
    """
    Gets the file extension from a file(path); stripped of leading '.' and in
    lower case.

    Example:
        ```python
        >>> _get_ext("path/to/file.txt")
        'txt'
        >>> _get_ext("OTHER.PDF")
        'pdf'
        >>> _get_ext("noext")
        ''
        >>> _get_ext(".rdf")
        'rdf'

        ```
    """
    ext = splitext(fpath)[-1]
    if ext == "" and fpath.startswith("."):
        ext = fpath
    if lower:
        ext = ext.lower()
    if ext.startswith("."):
        ext = ext[1:]
    return ext


def find_roots(
    graph: Graph,
    prop: rdflib.term.URIRef,
    roots: Optional[Set[rdflib.term.Node]] = None,
) -> Set[rdflib.term.Node]:
    """Find the roots in some sort of transitive hierarchy.

    find_roots(graph, rdflib.RDFS.subClassOf)
    will return a set of all roots of the sub-class hierarchy

    Assumes triple of the form (child, prop, parent), i.e. the direction of
    `RDFS.subClassOf` or `SKOS.broader`
    """

    non_roots: Set[rdflib.term.Node] = set()
    if roots is None:
        roots = set()
    for x, y in graph.subject_objects(prop):
        non_roots.add(x)
        if x in roots:
            roots.remove(x)
        if y not in non_roots:
            roots.add(y)
    return roots


def get_tree(
    graph: Graph,
    root: rdflib.term.Node,
    prop: rdflib.term.URIRef,
    mapper: Callable[[rdflib.term.Node], rdflib.term.Node] = lambda x: x,
    sortkey: Optional[Callable[[Any], Any]] = None,
    done: Optional[Set[rdflib.term.Node]] = None,
    dir: str = "down",
) -> Optional[Tuple[rdflib.term.Node, List[Any]]]:
    """
    Return a nested list/tuple structure representing the tree
    built by the transitive property given, starting from the root given

    i.e.

    ```python
    get_tree(
        graph,
        rdflib.URIRef("http://xmlns.com/foaf/0.1/Person"),
        rdflib.RDFS.subClassOf,
    )
    ```

    will return the structure for the subClassTree below person.

    dir='down' assumes triple of the form (child, prop, parent),
    i.e. the direction of RDFS.subClassOf or SKOS.broader
    Any other dir traverses in the other direction
    """

    if done is None:
        done = set()
    if root in done:
        # type error: Return value expected
        return  # type: ignore[return-value]
    done.add(root)
    tree = []

    branches: Iterator[rdflib.term.Node]
    if dir == "down":
        branches = graph.subjects(prop, root)
    else:
        branches = graph.objects(root, prop)

    for branch in branches:
        t = get_tree(graph, branch, prop, mapper, sortkey, done, dir)
        if t:
            tree.append(t)

    return (mapper(root), sorted(tree, key=sortkey))


@overload
def _coalesce(*args: Optional[_AnyT], default: _AnyT) -> _AnyT: ...


@overload
def _coalesce(
    *args: Optional[_AnyT], default: Optional[_AnyT] = ...
) -> Optional[_AnyT]: ...


def _coalesce(
    *args: Optional[_AnyT], default: Optional[_AnyT] = None
) -> Optional[_AnyT]:
    """
    This is a null coalescing function, it will return the first non-`None`
    argument passed to it, otherwise it will return `default` which is `None`
    by default.

    For more info regarding the rationale of this function see deferred
    [PEP 505](https://peps.python.org/pep-0505/).

    Args:
        *args: Values to consider as candidates to return, the first arg that
            is not `None` will be returned. If no argument is passed this function
            will return None.
        default: The default value to return if none of the args are not `None`.

    Returns:
        The first `args` that is not `None`, otherwise the value of
            `default` if there are no `args` or if all `args` are `None`.
    """
    for arg in args:
        if arg is not None:
            return arg
    return default


_RFC3986_SUBDELIMS = "!$&'()*+,;="
"""
`sub-delims` production from
[RFC 3986, section 2.2](https://www.rfc-editor.org/rfc/rfc3986.html#section-2.2).
"""

_RFC3986_PCHAR_NU = "%" + _RFC3986_SUBDELIMS + ":@"
"""
The non-unreserved characters in the `pchar` production from RFC 3986.
"""

_QUERY_SAFE_CHARS = _RFC3986_PCHAR_NU + "/?"
"""
The non-unreserved characters that are safe to use in in the query and fragment
components.

```
pchar         = unreserved / pct-encoded / sub-delims / ":" / "@" query
= *( pchar / "/" / "?" ) fragment      = *( pchar / "/" / "?" )
```
"""

_USERNAME_SAFE_CHARS = _RFC3986_SUBDELIMS + "%"
"""
The non-unreserved characters that are safe to use in the username and password
components.

```
userinfo      = *( unreserved / pct-encoded / sub-delims / ":" )
```

":" is excluded as this is only used for the username and password components,
and they are treated separately.
"""

_PATH_SAFE_CHARS = _RFC3986_PCHAR_NU + "/"
"""
The non-unreserved characters that are safe to use in the path component.

This is based on various path-related productions from RFC 3986.
"""


def _iri2uri(iri: str) -> str:
    """
    Prior art:

    - [iri_to_uri from Werkzeug](https://github.com/pallets/werkzeug/blob/92c6380248c7272ee668e1f8bbd80447027ccce2/src/werkzeug/urls.py#L926-L931)

    ```python
    >>> _iri2uri("https://dbpedia.org/resource/Almería")
    'https://dbpedia.org/resource/Almer%C3%ADa'

    ```
    """
    # https://datatracker.ietf.org/doc/html/rfc3986
    # https://datatracker.ietf.org/doc/html/rfc3305

    parts = urlsplit(iri)
    (scheme, netloc, path, query, fragment) = parts

    # Just support http/https, otherwise return the iri unaltered
    if scheme not in ["http", "https"]:
        return iri

    path = quote(path, safe=_PATH_SAFE_CHARS)
    query = quote(query, safe=_QUERY_SAFE_CHARS)
    fragment = quote(fragment, safe=_QUERY_SAFE_CHARS)

    if parts.hostname:
        netloc = parts.hostname.encode("idna").decode("ascii")
    else:
        netloc = ""

    if ":" in netloc:
        # Quote IPv6 addresses
        netloc = f"[{netloc}]"

    if parts.port:
        netloc = f"{netloc}:{parts.port}"

    if parts.username:
        auth = quote(parts.username, safe=_USERNAME_SAFE_CHARS)
        if parts.password:
            pass_quoted = quote(parts.password, safe=_USERNAME_SAFE_CHARS)
            auth = f"{auth}:{pass_quoted}"
        netloc = f"{auth}@{netloc}"

    uri = urlunsplit((scheme, netloc, path, query, fragment))

    if iri.endswith("#") and not uri.endswith("#"):
        uri += "#"

    return uri
