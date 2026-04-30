"""
This implements the Tab Separated SPARQL Result Format

It is implemented with pyparsing, reusing the elements from the SPARQL Parser
"""

from __future__ import annotations

import codecs
import typing
from typing import IO, Union

from pyparsing import (
    FollowedBy,
    LineEnd,
    Literal,
    Optional,
    ParserElement,
    Suppress,
    ZeroOrMore,
)

from rdflib.plugins.sparql.parser import (
    BLANK_NODE_LABEL,
    IRIREF,
    LANGTAG,
    STRING_LITERAL1,
    STRING_LITERAL2,
    BooleanLiteral,
    NumericLiteral,
    Var,
)
from rdflib.plugins.sparql.parserutils import Comp, CompValue, Param
from rdflib.query import Result, ResultParser
from rdflib.term import BNode, Identifier, URIRef
from rdflib.term import Literal as RDFLiteral

ParserElement.set_default_whitespace_chars(" \n")


String = STRING_LITERAL1 | STRING_LITERAL2

RDFLITERAL = Comp(
    "literal",
    Param("string", String)
    + Optional(
        Param("lang", LANGTAG.leave_whitespace())
        | Literal("^^").leave_whitespace()
        + Param("datatype", IRIREF).leave_whitespace()
    ),
)

NONE_VALUE = object()

EMPTY = FollowedBy(LineEnd()) | FollowedBy("\t")
EMPTY.set_parse_action(lambda x: NONE_VALUE)

TERM = RDFLITERAL | IRIREF | BLANK_NODE_LABEL | NumericLiteral | BooleanLiteral

ROW = (EMPTY | TERM) + ZeroOrMore(Suppress("\t") + (EMPTY | TERM))
ROW.parse_with_tabs()

HEADER = Var + ZeroOrMore(Suppress("\t") + Var)
HEADER.parse_with_tabs()


class TSVResultParser(ResultParser):
    """Parses SPARQL TSV results into a Result object."""

    # type error: Signature of "parse" incompatible with supertype "ResultParser"  [override]
    def parse(self, source: IO, content_type: typing.Optional[str] = None) -> Result:  # type: ignore[override]
        if isinstance(source.read(0), bytes):
            # if reading from source returns bytes do utf-8 decoding
            # type error: Incompatible types in assignment (expression has type "StreamReader", variable has type "IO[Any]")
            source = codecs.getreader("utf-8")(source)  # type: ignore[assignment]

        r = Result("SELECT")

        header = source.readline()

        r.vars = list(HEADER.parse_string(header.strip(), parse_all=True))
        r.bindings = []
        while True:
            line = source.readline()
            if not line:
                break
            line = line.strip("\n")
            if line == "":
                continue

            row = ROW.parse_string(line, parse_all=True)
            this_row_dict = {}
            for var, val_read in zip(r.vars, row):
                val = self.convertTerm(val_read)
                if val is None:
                    # Skip unbound vars
                    continue
                this_row_dict[var] = val
            # Preserve solution row cardinality, including fully-unbound rows.
            r.bindings.append(this_row_dict)
        return r

    def convertTerm(
        self, t: Union[object, RDFLiteral, BNode, CompValue, URIRef]
    ) -> typing.Optional[Identifier]:
        if t is NONE_VALUE:
            return None
        if isinstance(t, CompValue):
            if t.name == "literal":
                return RDFLiteral(t.string, lang=t.lang, datatype=t.datatype)
            else:
                raise Exception("I dont know how to handle this: %s" % (t,))
        elif isinstance(t, (RDFLiteral, BNode, URIRef)):
            return t
        else:
            raise ValueError(f"Unexpected type {type(t)} found in TSV result")
