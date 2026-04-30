"""A pure Python package providing the core RDF constructs.

The packages is intended to provide the core RDF types and interfaces
for working with RDF. The package defines a plugin interface for
parsers, stores, and serializers that other packages can use to
implement parsers, stores, and serializers that will plug into the
rdflib package.

The primary interface `rdflib` exposes to work with RDF is
[`rdflib.graph.Graph`][rdflib.graph.Graph].

A tiny example:

```python
>>> from rdflib import Graph, URIRef, Literal

>>> g = Graph()
>>> result = g.parse("http://www.w3.org/2000/10/swap/test/meet/blue.rdf")

>>> print("graph has %s statements." % len(g))
graph has 4 statements.
>>>
>>> for s, p, o in g:
...     if (s, p, o) not in g:
...         raise Exception("It better be!")

>>> s = g.serialize(format='nt')
>>>
>>> sorted(g) == [
...  (URIRef("http://meetings.example.com/cal#m1"),
...   URIRef("http://www.example.org/meeting_organization#homePage"),
...   URIRef("http://meetings.example.com/m1/hp")),
...  (URIRef("http://www.example.org/people#fred"),
...   URIRef("http://www.example.org/meeting_organization#attending"),
...   URIRef("http://meetings.example.com/cal#m1")),
...  (URIRef("http://www.example.org/people#fred"),
...   URIRef("http://www.example.org/personal_details#GivenName"),
...   Literal("Fred")),
...  (URIRef("http://www.example.org/people#fred"),
...   URIRef("http://www.example.org/personal_details#hasEmail"),
...   URIRef("mailto:fred@example.com"))
... ]
True

```
"""

import logging
import sys
from importlib import metadata

_DISTRIBUTION_METADATA = metadata.metadata("rdflib")

__docformat__ = "restructuredtext en"

__version__: str = _DISTRIBUTION_METADATA["Version"]
__date__ = "2026-02-13"

__all__ = [
    "URIRef",
    "BNode",
    "IdentifiedNode",
    "Literal",
    "Node",
    "Variable",
    "Namespace",
    "Dataset",
    "Graph",
    "ConjunctiveGraph",
    "BRICK",
    "CSVW",
    "DC",
    "DCAT",
    "DCMITYPE",
    "DCTERMS",
    "DOAP",
    "FOAF",
    "ODRL2",
    "ORG",
    "OWL",
    "PROF",
    "PROV",
    "QB",
    "RDF",
    "RDFS",
    "SDO",
    "SH",
    "SKOS",
    "SOSA",
    "SSN",
    "TIME",
    "VANN",
    "VOID",
    "XMLNS",
    "XSD",
    "util",
    "plugin",
    "query",
    "NORMALIZE_LITERALS",
]

logger = logging.getLogger(__name__)

try:
    import __main__

    if (
        not hasattr(__main__, "__file__")
        and sys.stdout is not None
        and hasattr(sys.stderr, "isatty")
        and sys.stderr.isatty()
    ):
        # show log messages in interactive mode
        logger.setLevel(logging.INFO)
        logger.addHandler(logging.StreamHandler())
    del __main__
except ImportError:
    # Main already imported from elsewhere
    import warnings

    warnings.warn("__main__ already imported", ImportWarning)
    del warnings

del sys


NORMALIZE_LITERALS = True
"""
If True - Literals lexical forms are normalized when created.
I.e. the lexical forms is parsed according to data-type, then the
stored lexical form is the re-serialized value that was parsed.

Illegal values for a datatype are simply kept.  The normalized keyword
for Literal.__new__ can override this.

For example:

```python
>>> from rdflib import Literal,XSD
>>> Literal("01", datatype=XSD.int)
rdflib.term.Literal("1", datatype=rdflib.term.URIRef("http://www.w3.org/2001/XMLSchema#integer"))

```

This flag may be changed at any time, but will only affect literals
created after that time, previously created literals will remain
(un)normalized.

"""


DAWG_LITERAL_COLLATION = False
"""DAWG_LITERAL_COLLATION determines how literals are ordered or compared
to each other.

In SPARQL, applying the >,<,>=,<= operators to literals of
incompatible data-types is an error, i.e:

`Literal(2)>Literal('cake')` is neither true nor false, but an error.

This is a problem in PY3, where lists of Literals of incompatible
types can no longer be sorted.

Setting this flag to True gives you strict DAWG/SPARQL compliance,
setting it to False will order Literals with incompatible datatypes by
datatype URI

In particular, this determines how the rich comparison operators for
Literal work, eq, `__neq__`, `__lt__`, etc.
"""


from rdflib.graph import ConjunctiveGraph, Dataset, Graph
from rdflib.namespace import (
    BRICK,
    CSVW,
    DC,
    DCAT,
    DCMITYPE,
    DCTERMS,
    DOAP,
    FOAF,
    ODRL2,
    ORG,
    OWL,
    PROF,
    PROV,
    QB,
    RDF,
    RDFS,
    SDO,
    SH,
    SKOS,
    SOSA,
    SSN,
    TIME,
    VANN,
    VOID,
    XMLNS,
    XSD,
    Namespace,
)
from rdflib.term import BNode, IdentifiedNode, Literal, Node, URIRef, Variable

from rdflib import plugin, query, util  # isort:skip
from rdflib.container import *  # isort:skip # noqa: F403
