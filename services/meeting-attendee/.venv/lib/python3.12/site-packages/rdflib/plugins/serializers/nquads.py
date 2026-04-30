from __future__ import annotations

import warnings
from typing import IO, Any, Optional

from rdflib.graph import DATASET_DEFAULT_GRAPH_ID, ConjunctiveGraph, Graph
from rdflib.plugins.serializers.nt import _quoteLiteral
from rdflib.serializer import Serializer
from rdflib.term import Literal

__all__ = ["NQuadsSerializer"]


class NQuadsSerializer(Serializer):
    """NQuads RDF graph serializer."""

    def __init__(self, store: Graph):
        if not store.context_aware:
            raise Exception(
                "NQuads serialization only makes " "sense for context-aware stores!"
            )

        super(NQuadsSerializer, self).__init__(store)
        self.store: ConjunctiveGraph

    def serialize(
        self,
        stream: IO[bytes],
        base: Optional[str] = None,
        encoding: Optional[str] = None,
        **kwargs: Any,
    ) -> None:
        if base is not None:
            warnings.warn("NQuadsSerializer does not support base.")
        if encoding is not None and encoding.lower() != self.encoding.lower():
            warnings.warn(
                "NQuadsSerializer does not use custom encoding. "
                f"Given encoding was: {encoding}"
            )
        encoding = self.encoding
        for context in self.store.contexts():
            for triple in context:
                stream.write(
                    _nq_row(triple, context.identifier).encode(encoding, "replace")
                )
        stream.write("\n".encode("latin-1"))


def _nq_row(triple, context):
    graph_name = context.n3() if context and context != DATASET_DEFAULT_GRAPH_ID else ""
    if isinstance(triple[2], Literal):
        return "%s %s %s %s .\n" % (
            triple[0].n3(),
            triple[1].n3(),
            _quoteLiteral(triple[2]),
            graph_name,
        )
    else:
        return "%s %s %s %s .\n" % (
            triple[0].n3(),
            triple[1].n3(),
            triple[2].n3(),
            graph_name,
        )
