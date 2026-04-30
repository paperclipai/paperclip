from __future__ import annotations

from typing import IO, Any, Optional

from rdflib.graph import ConjunctiveGraph, Graph
from rdflib.namespace import Namespace
from rdflib.plugins.serializers.xmlwriter import XMLWriter
from rdflib.serializer import Serializer
from rdflib.term import BNode, Literal, URIRef

__all__ = ["TriXSerializer"]

# TODO: Move this somewhere central
TRIXNS = Namespace("http://www.w3.org/2004/03/trix/trix-1/")
XMLNS = Namespace("http://www.w3.org/XML/1998/namespace")


class TriXSerializer(Serializer):
    """TriX RDF graph serializer."""

    def __init__(self, store: Graph):
        super(TriXSerializer, self).__init__(store)
        if not store.context_aware:
            raise Exception(
                "TriX serialization only makes sense for context-aware stores"
            )

    def serialize(
        self,
        stream: IO[bytes],
        base: Optional[str] = None,
        encoding: Optional[str] = None,
        **kwargs: Any,
    ) -> None:
        nm = self.store.namespace_manager

        self.writer = XMLWriter(stream, nm, encoding, extra_ns={"": TRIXNS})

        self.writer.push(TRIXNS["TriX"])
        # if base is given here, use that, if not and a base is set for the graph use that
        if base is None and self.store.base is not None:
            base = self.store.base
        if base is not None:
            self.writer.attribute("http://www.w3.org/XML/1998/namespacebase", base)
        self.writer.namespaces()

        if isinstance(self.store, ConjunctiveGraph):
            for subgraph in self.store.contexts():
                self._writeGraph(subgraph)
        elif isinstance(self.store, Graph):
            self._writeGraph(self.store)
        else:
            raise Exception(f"Unknown graph type: {type(self.store)}")

        self.writer.pop()
        stream.write("\n".encode("latin-1"))

    def _writeGraph(self, graph):  # noqa: N802
        self.writer.push(TRIXNS["graph"])
        if graph.base:
            self.writer.attribute(
                "http://www.w3.org/XML/1998/namespacebase", graph.base
            )
        if isinstance(graph.identifier, URIRef):
            self.writer.element(TRIXNS["uri"], content=str(graph.identifier))

        for triple in graph.triples((None, None, None)):
            self._writeTriple(triple)
        self.writer.pop()

    def _writeTriple(self, triple):  # noqa: N802
        self.writer.push(TRIXNS["triple"])
        for component in triple:
            if isinstance(component, URIRef):
                self.writer.element(TRIXNS["uri"], content=str(component))
            elif isinstance(component, BNode):
                self.writer.element(TRIXNS["id"], content=str(component))
            elif isinstance(component, Literal):
                if component.datatype:
                    self.writer.element(
                        TRIXNS["typedLiteral"],
                        content=str(component),
                        attributes={TRIXNS["datatype"]: str(component.datatype)},
                    )
                elif component.language:
                    self.writer.element(
                        TRIXNS["plainLiteral"],
                        content=str(component),
                        attributes={XMLNS["lang"]: str(component.language)},
                    )
                else:
                    self.writer.element(TRIXNS["plainLiteral"], content=str(component))
        self.writer.pop()
