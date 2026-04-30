"""RDF4J utility functions."""

from __future__ import annotations

import io
import typing as t

from rdflib.graph import DATASET_DEFAULT_GRAPH_ID, Dataset, Graph
from rdflib.plugins.sparql.processor import prepareQuery
from rdflib.term import BNode, IdentifiedNode, URIRef

if t.TYPE_CHECKING:
    from rdflib.contrib.rdf4j.client import ObjectType, PredicateType, SubjectType


def build_context_param(
    params: dict[str, str],
    graph_name: IdentifiedNode | t.Iterable[IdentifiedNode] | str | None = None,
) -> None:
    """Build the RDF4J http context query parameters dictionary.

    !!! Note
        This mutates the params dictionary key `context`.

    Parameters:
        params: The `httpx.Request` parameter dictionary.
        graph_name: The graph name or iterable of graph names.

            This is the `context` query parameter value.
    """
    if graph_name is not None and isinstance(graph_name, IdentifiedNode):
        if graph_name == DATASET_DEFAULT_GRAPH_ID:
            # Special RDF4J null value for context-less statements.
            params["context"] = "null"
        else:
            params["context"] = graph_name.n3()
    elif graph_name is not None and isinstance(graph_name, str):
        params["context"] = URIRef(graph_name).n3()
    elif graph_name is not None and isinstance(graph_name, t.Iterable):
        # type error: "str" has no attribute "n3"
        graph_names = ",".join([x.n3() for x in graph_name])  # type: ignore[attr-defined]
        params["context"] = graph_names


def build_spo_param(
    params: dict[str, str],
    subj: SubjectType = None,
    pred: PredicateType = None,
    obj: ObjectType = None,
) -> None:
    """Build the RDF4J http subj, predicate, and object query parameters dictionary.

    !!! Note
        This mutates the params dictionary key `subj`, `pred`, and `obj`.

    Parameters:
        params: The `httpx.Request` parameter dictionary.
        subj: The `subj` query parameter value.
        pred: The `pred` query parameter value.
        obj: The `obj` query parameter value.
    """
    if subj is not None:
        params["subj"] = subj.n3()
    if pred is not None:
        params["pred"] = pred.n3()
    if obj is not None:
        params["obj"] = obj.n3()


def build_infer_param(
    params: dict[str, str],
    infer: bool = True,
) -> None:
    """Build the RDF4J http infer query parameters dictionary.

    !!! Note
        This mutates the params dictionary key `infer`.

    Parameters:
        params: The `httpx.Request` parameter dictionary.
        infer: The `infer` query parameter value.
    """
    if not infer:
        params["infer"] = "false"


def rdf_payload_to_stream(
    data: str | bytes | t.BinaryIO | Graph | Dataset,
) -> tuple[t.BinaryIO, bool]:
    """Convert an RDF payload into a file-like object.

    Parameters:
        data: The RDF payload.

            This can be a python `str`, `bytes`, `BinaryIO`, or a
            [`Graph`][rdflib.graph.Graph] or [`Dataset`][rdflib.graph.Dataset].

    Returns:
        A tuple containing the file-like object and a boolean indicating whether the
        immediate caller should close the stream.
    """
    stream: t.BinaryIO
    if isinstance(data, str):
        # Check if it looks like a file path. Assumes file path length is less than 260.
        if "\n" not in data and len(data) < 260:
            try:
                stream = open(data, "rb")
                should_close = True
            except (FileNotFoundError, OSError):
                # Treat as raw string content
                stream = io.BytesIO(data.encode("utf-8"))
                should_close = False
        else:
            # Treat as raw string content
            stream = io.BytesIO(data.encode("utf-8"))
            should_close = False
    elif isinstance(data, bytes):
        stream = io.BytesIO(data)
        should_close = False
    elif isinstance(data, (Graph, Dataset)):
        if data.context_aware:
            stream = io.BytesIO(
                data.serialize(format="application/n-quads", encoding="utf-8")
            )
        else:
            stream = io.BytesIO(
                data.serialize(format="application/n-triples", encoding="utf-8")
            )
        should_close = True
    else:
        # Assume it's already a file-like object
        stream = data
        should_close = False

    return stream, should_close


def build_sparql_query_accept_header(query: str, headers: dict[str, str]):
    """Build the SPARQL query accept header.

    !!! Note
        This mutates the headers dictionary key `Accept`.

    Parameters:
        query: The SPARQL query.
    """
    prepared_query = prepareQuery(query)
    if prepared_query.algebra.name in ("SelectQuery", "AskQuery"):
        headers["Accept"] = "application/sparql-results+json"
    elif prepared_query.algebra.name in ("ConstructQuery", "DescribeQuery"):
        headers["Accept"] = "application/n-triples"
    else:
        raise ValueError(f"Unsupported query type: {prepared_query.algebra.name}")


def validate_graph_name(graph_name: URIRef | t.Iterable[URIRef] | str | None):
    if (
        isinstance(graph_name, BNode)
        or isinstance(graph_name, t.Iterable)
        and any(isinstance(x, BNode) for x in graph_name)
    ):
        raise ValueError("Graph name must not be a BNode.")


def validate_no_bnodes(
    subj: SubjectType,
    pred: PredicateType,
    obj: ObjectType,
    graph_name: URIRef | t.Iterable[URIRef] | str | None,
) -> None:
    """Validate that the subject, predicate, and object are not BNodes."""
    if (
        isinstance(subj, BNode)
        or isinstance(pred, BNode)
        or isinstance(obj, BNode)
        or isinstance(graph_name, BNode)
    ):
        raise ValueError(
            "Subject, predicate, and object must not be a BNode: "
            f"{subj}, {pred}, {obj}"
        )
    validate_graph_name(graph_name)
