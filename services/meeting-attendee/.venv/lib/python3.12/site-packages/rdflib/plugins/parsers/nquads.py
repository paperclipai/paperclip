"""
This is a rdflib plugin for parsing NQuad files into Conjunctive
graphs that can be used and queried. The store that backs the graph
*must* be able to handle contexts.

```python
>>> from rdflib import ConjunctiveGraph, URIRef, Namespace
>>> g = ConjunctiveGraph()
>>> data = open("test/data/nquads.rdflib/example.nquads", "rb")
>>> g.parse(data, format="nquads") # doctest:+ELLIPSIS
<Graph identifier=... (<class 'rdflib.graph.ConjunctiveGraph'>)>
>>> assert len(g.store) == 449
>>> # There should be 16 separate contexts
>>> assert len([x for x in g.store.contexts()]) == 16
>>> # is the name of entity E10009 "Arco Publications"?
>>> #   (in graph http://bibliographica.org/entity/E10009)
>>> # Looking for:
>>> # <http://bibliographica.org/entity/E10009>
>>> #   <http://xmlns.com/foaf/0.1/name>
>>> #   "Arco Publications"
>>> #   <http://bibliographica.org/entity/E10009>
>>> s = URIRef("http://bibliographica.org/entity/E10009")
>>> FOAF = Namespace("http://xmlns.com/foaf/0.1/")
>>> assert(g.value(s, FOAF.name).eq("Arco Publications"))

```
"""

from __future__ import annotations

from codecs import getreader
from typing import Any, MutableMapping, Optional

from rdflib.exceptions import ParserError as ParseError
from rdflib.graph import ConjunctiveGraph, Dataset, Graph
from rdflib.parser import InputSource

# Build up from the NTriples parser:
from rdflib.plugins.parsers.ntriples import W3CNTriplesParser, r_tail, r_wspace
from rdflib.term import BNode

__all__ = ["NQuadsParser"]

_BNodeContextType = MutableMapping[str, BNode]


class NQuadsParser(W3CNTriplesParser):

    # type error: Signature of "parse" incompatible with supertype "W3CNTriplesParser"
    def parse(  # type: ignore[override]
        self,
        inputsource: InputSource,
        sink: Graph,
        bnode_context: Optional[_BNodeContextType] = None,
        skolemize: bool = False,
        **kwargs: Any,
    ):
        """Parse inputsource as an N-Quads file.

        Args:
            inputsource: The source of N-Quads-formatted data.
            sink: The graph where parsed quads will be stored.
            bnode_context: Optional dictionary mapping blank node identifiers to
                [`BNode`][rdflib.term.BNode] instances.
                See `.W3CNTriplesParser.parse` for more details.
            skolemize: Whether to skolemize blank nodes.

        Returns:
            The Dataset containing the parsed quads.

        Raises:
            AssertionError: If the sink store is not context-aware.
            ParseError: If the input is not a file-like object or contains invalid lines.
        """
        assert (
            sink.store.context_aware
        ), "NQuadsParser must be given a context-aware store."
        # Set default_union to True to mimic ConjunctiveGraph behavior
        ds = Dataset(store=sink.store, default_union=True)
        ds_default = ds.default_context  # the DEFAULT_DATASET_GRAPH_ID
        new_default_context = None
        if isinstance(sink, (Dataset, ConjunctiveGraph)):
            new_default_context = sink.default_context
        elif sink.identifier is not None:
            if sink.identifier == ds_default.identifier:
                new_default_context = sink
            else:
                new_default_context = ds.get_context(sink.identifier)

        if new_default_context is not None:
            ds.default_context = new_default_context
            ds.remove_graph(ds_default)  # remove the original unused default graph
        # type error: Incompatible types in assignment (expression has type "ConjunctiveGraph", base class "W3CNTriplesParser" defined the type as "Union[DummySink, NTGraphSink]")
        self.sink: Dataset = ds  # type: ignore[assignment]
        self.skolemize = skolemize

        source = inputsource.getCharacterStream()
        if not source:
            source = inputsource.getByteStream()
            source = getreader("utf-8")(source)

        if not hasattr(source, "read"):
            raise ParseError("Item to parse must be a file-like object.")

        self.file = source
        self.buffer = ""
        while True:
            self.line = __line = self.readline()
            if self.line is None:
                break
            try:
                self.parseline(bnode_context)
            except ParseError as msg:
                raise ParseError("Invalid line (%s):\n%r" % (msg, __line))

        return self.sink

    def parseline(self, bnode_context: Optional[_BNodeContextType] = None) -> None:
        self.eat(r_wspace)
        if (not self.line) or self.line.startswith("#"):
            return  # The line is empty or a comment

        subject = self.subject(bnode_context)
        self.eat(r_wspace)

        predicate = self.predicate()
        self.eat(r_wspace)

        obj = self.object(bnode_context)
        self.eat(r_wspace)

        context = self.uriref() or self.nodeid(bnode_context)
        self.eat(r_tail)

        if self.line:
            raise ParseError("Trailing garbage")
        # Must have a context aware store - add on a normal Graph
        # discards anything where the ctx != graph.identifier
        if context:
            self.sink.get_context(context).add((subject, predicate, obj))
        else:
            self.sink.default_context.add((subject, predicate, obj))
