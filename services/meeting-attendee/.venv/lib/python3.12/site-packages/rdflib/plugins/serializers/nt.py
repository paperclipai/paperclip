from __future__ import annotations

import codecs
import warnings
from typing import IO, TYPE_CHECKING, Any, Optional, Tuple, Union

from rdflib.graph import Graph
from rdflib.serializer import Serializer
from rdflib.term import Literal

if TYPE_CHECKING:
    from rdflib.graph import _TripleType

"""
N-Triples RDF graph serializer for RDFLib.
See <http://www.w3.org/TR/rdf-testcases/#ntriples> for details about the
format.
"""

__all__ = ["NTSerializer"]


class NTSerializer(Serializer):
    """Serializes RDF graphs to NTriples format."""

    def __init__(self, store: Graph):
        Serializer.__init__(self, store)

    def serialize(
        self,
        stream: IO[bytes],
        base: Optional[str] = None,
        encoding: Optional[str] = "utf-8",
        **kwargs: Any,
    ) -> None:
        if base is not None:
            warnings.warn("NTSerializer does not support base.")
        if encoding != "utf-8":
            warnings.warn(
                "NTSerializer always uses UTF-8 encoding. "
                f"Given encoding was: {encoding}"
            )

        for triple in self.store:
            stream.write(_nt_row(triple).encode())


class NT11Serializer(NTSerializer):
    """Serializes RDF graphs to RDF 1.1 NTriples format.

    Exactly like nt - only utf8 encoded.
    """

    def __init__(self, store: Graph):
        Serializer.__init__(self, store)  # default to utf-8


def _nt_row(triple: _TripleType) -> str:
    if isinstance(triple[2], Literal):
        return "%s %s %s .\n" % (
            triple[0].n3(),
            triple[1].n3(),
            _quoteLiteral(triple[2]),
        )
    else:
        return "%s %s %s .\n" % (triple[0].n3(), triple[1].n3(), triple[2].n3())


def _quoteLiteral(l_: Literal) -> str:  # noqa: N802
    """A simpler version of term.Literal.n3()"""

    encoded = _quote_encode(l_)

    if l_.language:
        if l_.datatype:
            raise Exception("Literal has datatype AND language!")
        return "%s@%s" % (encoded, l_.language)
    elif l_.datatype:
        return "%s^^<%s>" % (encoded, l_.datatype)
    else:
        return "%s" % encoded


def _quote_encode(l_: str) -> str:
    return '"%s"' % l_.replace("\\", "\\\\").replace("\n", "\\n").replace(
        '"', '\\"'
    ).replace("\r", "\\r")


def _nt_unicode_error_resolver(
    err: UnicodeError,
) -> Tuple[Union[str, bytes], int]:
    """
    Do unicode char replaces as defined in https://www.w3.org/TR/2004/REC-rdf-testcases-20040210/#ntrip_strings
    """

    def _replace_single(c):
        c = ord(c)
        fmt = "\\u%04X" if c <= 0xFFFF else "\\U%08X"
        return fmt % c

    # type error: "UnicodeError" has no attribute "object"
    # type error: "UnicodeError" has no attribute "start"
    # type error: "UnicodeError" has no attribute "end"
    string = err.object[err.start : err.end]  # type: ignore[attr-defined]
    # type error: "UnicodeError" has no attribute "end"
    return "".join(_replace_single(c) for c in string), err.end  # type: ignore[attr-defined]


codecs.register_error("_rdflib_nt_escape", _nt_unicode_error_resolver)
