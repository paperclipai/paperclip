from __future__ import annotations

from typing import IO, Optional

from rdflib.graph import Graph
from rdflib.query import Result, ResultParser


class GraphResultParser(ResultParser):
    # type error: Signature of "parse" incompatible with supertype "ResultParser"
    def parse(self, source: IO, content_type: Optional[str]) -> Result:  # type: ignore[override]
        res = Result("CONSTRUCT")  # hmm - or describe?type_)
        res.graph = Graph()
        res.graph.parse(source, format=content_type)

        return res
