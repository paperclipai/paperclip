"""
HextuplesSerializer RDF graph serializer for RDFLib.
See <https://github.com/ontola/hextuples> for details about the format.
"""

from __future__ import annotations

import json
import warnings
from typing import IO, Any, Callable, List, Optional, Type, Union, cast

from rdflib.graph import DATASET_DEFAULT_GRAPH_ID, ConjunctiveGraph, Dataset, Graph
from rdflib.namespace import RDF, XSD
from rdflib.serializer import Serializer
from rdflib.term import BNode, IdentifiedNode, Literal, URIRef

try:
    import orjson

    _HAS_ORJSON = True
except ImportError:
    orjson = None  # type: ignore[assignment, unused-ignore]
    _HAS_ORJSON = False

__all__ = ["HextuplesSerializer"]


class HextuplesSerializer(Serializer):
    """
    Serializes RDF graphs to NTriples format.
    """

    contexts: List[Union[Graph, IdentifiedNode]]
    dumps: Callable

    def __new__(cls, store: Union[Graph, Dataset, ConjunctiveGraph]):
        if _HAS_ORJSON:
            cls.str_local_id: Union[str, Any] = orjson.Fragment(b'"localId"')
            cls.str_global_id: Union[str, Any] = orjson.Fragment(b'"globalId"')
            cls.empty: Union[str, Any] = orjson.Fragment(b'""')
            cls.lang_str: Union[str, Any] = orjson.Fragment(
                b'"' + RDF.langString.encode("utf-8") + b'"'
            )
            cls.xsd_string: Union[str, Any] = orjson.Fragment(
                b'"' + XSD.string.encode("utf-8") + b'"'
            )
        else:
            cls.str_local_id = "localId"
            cls.str_global_id = "globalId"
            cls.empty = ""
            cls.lang_str = f"{RDF.langString}"
            cls.xsd_string = f"{XSD.string}"
        return super(cls, cls).__new__(cls)

    def __init__(self, store: Union[Graph, Dataset, ConjunctiveGraph]):
        self.default_context: Optional[Union[Graph, IdentifiedNode]]
        self.graph_type: Union[Type[Graph], Type[Dataset], Type[ConjunctiveGraph]]
        if isinstance(store, (Dataset, ConjunctiveGraph)):
            self.graph_type = (
                Dataset if isinstance(store, Dataset) else ConjunctiveGraph
            )
            self.contexts = list(store.contexts())
            if store.default_context:
                self.default_context = store.default_context
                self.contexts.append(store.default_context)
            else:
                self.default_context = None
        else:
            self.graph_type = Graph
            self.contexts = [store]
            self.default_context = None

        Serializer.__init__(self, store)

    def serialize(
        self,
        stream: IO[bytes],
        base: Optional[str] = None,
        encoding: Optional[str] = "utf-8",
        **kwargs: Any,
    ) -> None:
        if base is not None:
            warnings.warn(
                "base has no meaning for Hextuples serialization. "
                "I will ignore this value"
            )

        if encoding not in [None, "utf-8"]:
            warnings.warn(
                f"Hextuples files are always utf-8 encoded. "
                f"I was passed: {encoding}, "
                "but I'm still going to use utf-8 anyway!"
            )

        if self.store.formula_aware is True:
            raise Exception(
                "Hextuple serialization can't (yet) handle formula-aware stores"
            )
        context: Union[Graph, IdentifiedNode]
        context_str: Union[bytes, str]
        for context in self.contexts:
            for triple in context:
                # Generate context string just once, because it doesn't change
                # for every triple in this context
                context_str = cast(
                    Union[str, bytes],
                    (
                        self.empty
                        if self.graph_type is Graph
                        else (
                            orjson.Fragment('"' + self._context_str(context) + '"')
                            if _HAS_ORJSON
                            else self._context_str(context)
                        )
                    ),
                )
                hl = self._hex_line(triple, context_str)
                if hl is not None:
                    stream.write(hl if _HAS_ORJSON else hl.encode())

    def _hex_line(self, triple, context_str: Union[bytes, str]):
        if isinstance(
            triple[0], (URIRef, BNode)
        ):  # exclude QuotedGraph and other objects
            # value
            value = (
                triple[2]
                if isinstance(triple[2], Literal)
                else self._iri_or_bn(triple[2])
            )

            # datatype
            if isinstance(triple[2], URIRef):
                # datatype = "http://www.w3.org/1999/02/22-rdf-syntax-ns#namedNode"
                datatype = self.str_global_id
            elif isinstance(triple[2], BNode):
                # datatype = "http://www.w3.org/1999/02/22-rdf-syntax-ns#blankNode"
                datatype = self.str_local_id
            elif isinstance(triple[2], Literal):
                if triple[2].datatype is not None:
                    datatype = f"{triple[2].datatype}"
                else:
                    if triple[2].language is not None:  # language
                        datatype = self.lang_str
                    else:
                        datatype = self.xsd_string
            else:
                return None  # can't handle non URI, BN or Literal Object (QuotedGraph)

            # language
            if isinstance(triple[2], Literal):
                if triple[2].language is not None:
                    language = f"{triple[2].language}"
                else:
                    language = self.empty
            else:
                language = self.empty
            line_list = [
                self._iri_or_bn(triple[0]),
                triple[1],
                value,
                datatype,
                language,
                context_str,
            ]
            outline: Union[str, bytes]
            if _HAS_ORJSON:
                outline = orjson.dumps(line_list, option=orjson.OPT_APPEND_NEWLINE)
            else:
                outline = json.dumps(line_list) + "\n"
            return outline
        else:  # do not return anything for non-IRIs or BNs, e.g. QuotedGraph, Subjects
            return None

    def _iri_or_bn(self, i_):
        if isinstance(i_, URIRef):
            return f"{i_}"
        elif isinstance(i_, BNode):
            return f"{i_.n3()}"
        else:
            return None

    def _context_str(self, context: Union[Graph, IdentifiedNode]) -> str:
        context_identifier: IdentifiedNode = (
            context.identifier if isinstance(context, Graph) else context
        )
        if context_identifier == DATASET_DEFAULT_GRAPH_ID:
            return ""
        if self.default_context is not None:
            if (
                isinstance(self.default_context, IdentifiedNode)
                and context_identifier == self.default_context
            ):
                return ""
            elif (
                isinstance(self.default_context, Graph)
                and context_identifier == self.default_context.identifier
            ):
                return ""
        if self.graph_type is Graph:
            # Only emit a context name when serializing a Dataset or ConjunctiveGraph
            return ""
        return (
            f"{context_identifier}"
            if isinstance(context_identifier, URIRef)
            else context_identifier.n3()
        )
