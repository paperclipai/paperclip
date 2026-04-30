"""
This module implements a parser and serializer for the CSV SPARQL result
formats

http://www.w3.org/TR/sparql11-results-csv-tsv/
"""

from __future__ import annotations

import codecs
import csv
from io import BufferedIOBase, TextIOBase
from typing import IO, Dict, List, Optional, Union, cast

from rdflib.plugins.sparql.processor import SPARQLResult
from rdflib.query import Result, ResultParser, ResultSerializer
from rdflib.term import BNode, Identifier, Literal, URIRef, Variable


class CSVResultParser(ResultParser):
    """Parses SPARQL CSV results into a Result object."""

    def __init__(self):
        self.delim = ","

    # type error: Signature of "parse" incompatible with supertype "ResultParser"
    def parse(self, source: IO, content_type: Optional[str] = None) -> Result:  # type: ignore[override]
        r = Result("SELECT")

        # type error: Incompatible types in assignment (expression has type "StreamReader", variable has type "IO[Any]")
        if isinstance(source.read(0), bytes):
            # if reading from source returns bytes do utf-8 decoding
            # type error: Incompatible types in assignment (expression has type "StreamReader", variable has type "IO[Any]")
            source = codecs.getreader("utf-8")(source)  # type: ignore[assignment]

        reader = csv.reader(source, delimiter=self.delim)
        r.vars = [Variable(x) for x in next(reader)]
        r.bindings = []

        for row in reader:
            r.bindings.append(self.parseRow(row, r.vars))

        return r

    def parseRow(
        self, row: List[str], v: List[Variable]
    ) -> Dict[Variable, Union[BNode, URIRef, Literal]]:
        return dict(
            (var, val)
            for var, val in zip(v, [self.convertTerm(t) for t in row])
            if val is not None
        )

    def convertTerm(self, t: str) -> Optional[Union[BNode, URIRef, Literal]]:
        if t == "":
            return None
        if t.startswith("_:"):
            return BNode(t)  # or generate new IDs?
        if t.startswith("http://") or t.startswith("https://"):  # TODO: more?
            return URIRef(t)
        return Literal(t)


class CSVResultSerializer(ResultSerializer):
    """Serializes SPARQL results into CSV format."""

    def __init__(self, result: SPARQLResult):
        ResultSerializer.__init__(self, result)

        self.delim = ","
        if result.type != "SELECT":
            raise Exception("CSVSerializer can only serialize select query results")

    def serialize(self, stream: IO, encoding: str = "utf-8", **kwargs) -> None:
        # the serialiser writes bytes in the given encoding
        # in py3 csv.writer is unicode aware and writes STRINGS,
        # so we encode afterward

        import codecs

        # TODO: Find a better solution for all this casting
        writable_stream = cast(Union[TextIOBase, BufferedIOBase], stream)
        if isinstance(writable_stream, TextIOBase):
            string_stream: TextIOBase = writable_stream
        else:
            byte_stream = cast(BufferedIOBase, writable_stream)
            string_stream = cast(TextIOBase, codecs.getwriter(encoding)(byte_stream))

        out = csv.writer(string_stream, delimiter=self.delim)

        vs = [self.serializeTerm(v, encoding) for v in self.result.vars]  # type: ignore[union-attr]
        out.writerow(vs)
        for row in self.result.bindings:
            out.writerow(
                [self.serializeTerm(row.get(v), encoding) for v in self.result.vars]  # type: ignore[union-attr]
            )

    def serializeTerm(
        self, term: Optional[Identifier], encoding: str
    ) -> Union[str, Identifier]:
        if term is None:
            return ""
        elif isinstance(term, BNode):
            return f"_:{term}"
        else:
            return term
