"""
Utilities for interacting with SHACL Shapes Graphs more easily.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Optional, Union

from rdflib import BNode, Graph, Literal, URIRef, paths
from rdflib.collection import Collection
from rdflib.namespace import RDF, SH
from rdflib.paths import Path
from rdflib.term import Node

if TYPE_CHECKING:
    from rdflib.term import IdentifiedNode


class SHACLPathError(Exception):
    pass


# Map the variable length path operators to the corresponding SHACL path predicates
_PATH_MOD_TO_PRED = {
    paths.ZeroOrMore: SH.zeroOrMorePath,
    paths.OneOrMore: SH.oneOrMorePath,
    paths.ZeroOrOne: SH.zeroOrOnePath,
}


# This implementation is roughly based on
# pyshacl.helper.sparql_query_helper::SPARQLQueryHelper._shacl_path_to_sparql_path
def parse_shacl_path(
    shapes_graph: Graph,
    path_identifier: Node,
) -> Union[URIRef, Path]:
    """
    Parse a valid SHACL path (e.g. the object of a triple with predicate sh:path)
    from a [`Graph`][rdflib.graph.Graph] as a [`URIRef`][rdflib.term.URIRef] if the path
    is simply a predicate or a [`Path`][rdflib.paths.Path] otherwise.

    Args:
        shapes_graph: A [`Graph`][rdflib.graph.Graph] containing the path to be parsed
        path_identifier: A [`Node`][rdflib.term.Node] of the path

    Returns:
        A [`URIRef`][rdflib.term.URIRef] or a [`Path`][rdflib.paths.Path]
    """
    path: Optional[Union[URIRef, Path]] = None

    # Literals are not allowed.
    if isinstance(path_identifier, Literal):
        raise TypeError("Literals are not a valid SHACL path.")

    # If a path is a URI, that's the whole path.
    elif isinstance(path_identifier, URIRef):
        if path_identifier == RDF.nil:
            raise SHACLPathError(
                "A list of SHACL Paths must contain at least two path items."
            )
        path = path_identifier

    # Handle Sequence Paths
    elif shapes_graph.value(path_identifier, RDF.first) is not None:
        sequence = list(shapes_graph.items(path_identifier))
        if len(sequence) < 2:
            raise SHACLPathError(
                "A list of SHACL Sequence Paths must contain at least two path items."
            )
        path = paths.SequencePath(
            *(parse_shacl_path(shapes_graph, path) for path in sequence)
        )

    # Handle sh:inversePath
    elif inverse_path := shapes_graph.value(path_identifier, SH.inversePath):
        path = paths.InvPath(parse_shacl_path(shapes_graph, inverse_path))

    # Handle sh:alternativePath
    elif alternative_path := shapes_graph.value(path_identifier, SH.alternativePath):
        alternatives = list(shapes_graph.items(alternative_path))
        if len(alternatives) < 2:
            raise SHACLPathError(
                "List of SHACL alternate paths must have at least two path items."
            )
        path = paths.AlternativePath(
            *(
                parse_shacl_path(shapes_graph, alternative)
                for alternative in alternatives
            )
        )

    # Handle sh:zeroOrMorePath
    elif zero_or_more_path := shapes_graph.value(path_identifier, SH.zeroOrMorePath):
        path = paths.MulPath(parse_shacl_path(shapes_graph, zero_or_more_path), "*")

    # Handle sh:oneOrMorePath
    elif one_or_more_path := shapes_graph.value(path_identifier, SH.oneOrMorePath):
        path = paths.MulPath(parse_shacl_path(shapes_graph, one_or_more_path), "+")

    # Handle sh:zeroOrOnePath
    elif zero_or_one_path := shapes_graph.value(path_identifier, SH.zeroOrOnePath):
        path = paths.MulPath(parse_shacl_path(shapes_graph, zero_or_one_path), "?")

    # Raise error if none of the above options were found
    elif path is None:
        raise SHACLPathError(f"Cannot parse {repr(path_identifier)} as a SHACL Path.")

    return path


def _build_path_component(
    graph: Graph, path_component: URIRef | Path
) -> IdentifiedNode:
    """
    Helper method that implements the recursive component of SHACL path
    triple construction.

    Args:
        graph: A [`Graph`][rdflib.graph.Graph] into which to insert triples
        graph_component: A [`URIRef`][rdflib.term.URIRef] or
            [`Path`][rdflib.paths.Path] that is part of a path expression

    Returns:
        The [`IdentifiedNode`][rdflib.term.IdentifiedNode] of the resource in the
            graph that corresponds to the provided path_component
    """
    # Literals or other types are not allowed
    if not isinstance(path_component, (URIRef, Path)):
        raise TypeError(
            f"Objects of type {type(path_component)} are not valid "
            + "components of a SHACL path."
        )

    # If the path component is a URI, return it
    elif isinstance(path_component, URIRef):
        return path_component
    # Otherwise, the path component is represented as a blank node
    bnode = BNode()

    # Handle Sequence Paths
    if isinstance(path_component, paths.SequencePath):
        # Sequence paths are a Collection directly with at least two items
        if len(path_component.args) < 2:
            raise SHACLPathError(
                "A list of SHACL Sequence Paths must contain at least two path items."
            )
        Collection(
            graph,
            bnode,
            [_build_path_component(graph, arg) for arg in path_component.args],
        )

    # Handle Inverse Paths
    elif isinstance(path_component, paths.InvPath):
        graph.add(
            (bnode, SH.inversePath, _build_path_component(graph, path_component.arg))
        )

    # Handle Alternative Paths
    elif isinstance(path_component, paths.AlternativePath):
        # Alternative paths are a Collection but referenced by sh:alternativePath
        # with at least two items
        if len(path_component.args) < 2:
            raise SHACLPathError(
                "List of SHACL alternate paths must have at least two path items."
            )
        coll = Collection(
            graph,
            BNode(),
            [_build_path_component(graph, arg) for arg in path_component.args],
        )
        graph.add((bnode, SH.alternativePath, coll.uri))

    # Handle Variable Length Paths
    elif isinstance(path_component, paths.MulPath):
        # Get the predicate corresponding to the path modifiier
        pred = _PATH_MOD_TO_PRED.get(path_component.mod)
        if pred is None:
            raise SHACLPathError(f"Unknown path modifier {path_component.mod}")
        graph.add((bnode, pred, _build_path_component(graph, path_component.path)))

    # Return the blank node created for the provided path_component
    return bnode


def build_shacl_path(
    path: URIRef | Path, target_graph: Graph | None = None
) -> tuple[IdentifiedNode, Graph | None]:
    """
    Build the SHACL Path triples for a path given by a [`URIRef`][rdflib.term.URIRef] for
    simple paths or a [`Path`][rdflib.paths.Path] for complex paths.

    Returns an [`IdentifiedNode`][rdflib.term.IdentifiedNode] for the path (which should be
    the object of a triple with predicate `sh:path`) and the graph into which any
    new triples were added.

    Args:
        path: A [`URIRef`][rdflib.term.URIRef] or a [`Path`][rdflib.paths.Path]
        target_graph: Optionally, a [`Graph`][rdflib.graph.Graph] into which to put
            constructed triples. If not provided, a new graph will be created

    Returns:
        A (path_identifier, graph) tuple where:
            - path_identifier: If path is a [`URIRef`][rdflib.term.URIRef], this is simply
            the provided path. If path is a [`Path`][rdflib.paths.Path], this is
            the [`BNode`][rdflib.term.BNode] corresponding to the root of the SHACL
            path expression added to the graph.
            - graph: None if path is a [`URIRef`][rdflib.term.URIRef] (as no new triples
            are constructed). If path is a [`Path`][rdflib.paths.Path], this is either the
            target_graph provided or a new graph into which the path triples were added.
    """
    # If a path is a URI, that's the whole path. No graph needs to be constructed.
    if isinstance(path, URIRef):
        return path, None

    # Create a graph if one was not provided
    if target_graph is None:
        target_graph = Graph()

    # Recurse through the path to build the graph representation
    return _build_path_component(target_graph, path), target_graph
