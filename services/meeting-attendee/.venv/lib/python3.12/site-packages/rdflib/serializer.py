"""Serializer plugin interface.

The RDF serialization plugins used during
[RDFlib's common serialization of a graph][rdflib.graph.Graph.serialize]
is described in this module.

TODO: info for how to write a serializer that can plugin to rdflib.
See also [`rdflib.plugin`][rdflib.plugin]

All builtin RDF Serializer are listed
under [`rdflib.plugins.serializers`][rdflib.plugins.serializers].
"""

from __future__ import annotations

from typing import IO, TYPE_CHECKING, Any, Optional, TypeVar, Union

from rdflib.term import URIRef

if TYPE_CHECKING:
    from rdflib.graph import Graph


__all__ = ["Serializer"]

_StrT = TypeVar("_StrT", bound=str)


class Serializer:
    """Base class for RDF Serializer.

    New Serializer can be registered as plugin as described
    in [`rdflib.plugin`][rdflib.plugin].
    """

    def __init__(self, store: Graph):
        self.store: Graph = store
        self.encoding: str = "utf-8"
        self.base: Optional[str] = None

    def serialize(
        self,
        stream: IO[bytes],
        base: Optional[str] = None,
        encoding: Optional[str] = None,
        **args: Any,
    ) -> None:
        """Abstract method. Print [Graph][rdflib.graph.Graph].
        Used in [Graph.serialize][rdflib.graph.Graph.serialize]

        Serialize Graph

        Args:
            stream: The destination to serialize the graph to.
            base: The base IRI for formats that support it.
            encoding: Encoding of output.
            args: Additional arguments to pass to the Serializer that will be used.
        """

    def relativize(self, uri: _StrT) -> Union[_StrT, URIRef]:
        base = self.base
        if base is not None and uri.startswith(base):
            # type error: Incompatible types in assignment (expression has type "str", variable has type "Node")
            uri = URIRef(uri.replace(base, "", 1))  # type: ignore[assignment]
        return uri
