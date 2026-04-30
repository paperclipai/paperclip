from __future__ import annotations

from typing import IO, Any, MutableMapping, Optional, Union

from rdflib.graph import Graph
from rdflib.namespace import RDF, Namespace
from rdflib.query import Result, ResultParser
from rdflib.term import Node, Variable

RS = Namespace("http://www.w3.org/2001/sw/DataAccess/tests/result-set#")


class RDFResultParser(ResultParser):
    def parse(self, source: Union[IO, Graph], **kwargs: Any) -> Result:
        return RDFResult(source, **kwargs)


class RDFResult(Result):
    def __init__(self, source: Union[IO, Graph], **kwargs: Any):
        if not isinstance(source, Graph):
            graph = Graph()
            graph.parse(source, **kwargs)
        else:
            graph = source

        rs = graph.value(predicate=RDF.type, object=RS.ResultSet)
        # there better be only one :)

        if rs is None:
            type_ = "CONSTRUCT"

            # use a new graph
            g = Graph()
            g += graph

        else:
            askAnswer = graph.value(rs, RS.boolean)

            if askAnswer is not None:
                type_ = "ASK"
            else:
                type_ = "SELECT"

        Result.__init__(self, type_)

        if type_ == "SELECT":
            # type error: Argument 1 to "Variable" has incompatible type "Node"; expected "str"
            self.vars = [Variable(v) for v in graph.objects(rs, RS.resultVariable)]  # type: ignore[arg-type]

            self.bindings = []

            for s in graph.objects(rs, RS.solution):
                sol: MutableMapping[Variable, Optional[Node]] = {}
                for b in graph.objects(s, RS.binding):
                    # type error: Argument 1 to "Variable" has incompatible type "Optional[Node]"; expected "str"
                    sol[Variable(graph.value(b, RS.variable))] = graph.value(  # type: ignore[arg-type]
                        b, RS.value
                    )
                # error: Argument 1 to "append" of "list" has incompatible type "MutableMapping[Variable, Optional[Node]]"; expected "Mapping[Variable, Identifier]"
                self.bindings.append(sol)  # type: ignore[arg-type]
        elif type_ == "ASK":
            # type error: Item "Node" of "Optional[Node]" has no attribute "value"
            # type error: Item "None" of "Optional[Node]" has no attribute "value"
            self.askAnswer = askAnswer.value  # type: ignore[union-attr]
            # type error: Item "Node" of "Optional[Node]" has no attribute "value"
            # type error: Item "None" of "Optional[Node]" has no attribute "value"
            if askAnswer.value is None:  # type: ignore[union-attr]
                raise Exception("Malformed boolean in ask answer!")
        elif type_ == "CONSTRUCT":
            self.graph = g
