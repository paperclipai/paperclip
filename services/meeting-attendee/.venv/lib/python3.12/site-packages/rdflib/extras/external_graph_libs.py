"""Convert (to and) from rdflib graphs to other well known graph libraries.

Currently the following libraries are supported:

- networkx: MultiDiGraph, DiGraph, Graph
- graph_tool: Graph

Doctests in this file are all skipped, as we can't run them conditionally if
networkx or graph_tool are available and they would err otherwise.
see `../../test/test_extras_external_graph_libs.py` for conditional tests
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Dict, List

if TYPE_CHECKING:
    from rdflib.graph import Graph


logger = logging.getLogger(__name__)


def _identity(x):
    return x


def _rdflib_to_networkx_graph(
    graph: Graph,
    nxgraph,
    calc_weights: bool,
    edge_attrs,
    transform_s=_identity,
    transform_o=_identity,
):
    """Helper method for multidigraph, digraph and graph.

    Modifies nxgraph in-place!

    Args:
        graph: an rdflib.Graph.
        nxgraph: a networkx.Graph/DiGraph/MultiDigraph.
        calc_weights: If True adds a 'weight' attribute to each edge according
            to the count of s,p,o triples between s and o, which is meaningful
            for Graph/DiGraph.
        edge_attrs: Callable to construct edge data from s, p, o.
            'triples' attribute is handled specially to be merged.
            'weight' should not be generated if calc_weights==True.
            (see invokers below!)
        transform_s: Callable to transform node generated from s.
        transform_o: Callable to transform node generated from o.
    """
    assert callable(edge_attrs)
    assert callable(transform_s)
    assert callable(transform_o)
    import networkx as nx

    for s, p, o in graph:
        ts, to = transform_s(s), transform_o(o)  # apply possible transformations
        data = nxgraph.get_edge_data(ts, to)
        if data is None or isinstance(nxgraph, nx.MultiDiGraph):
            # no edge yet, set defaults
            data = edge_attrs(s, p, o)
            if calc_weights:
                data["weight"] = 1
            nxgraph.add_edge(ts, to, **data)
        else:
            # already have an edge, just update attributes
            if calc_weights:
                data["weight"] += 1
            if "triples" in data:
                d = edge_attrs(s, p, o)
                data["triples"].extend(d["triples"])


def rdflib_to_networkx_multidigraph(
    graph: Graph, edge_attrs=lambda s, p, o: {"key": p}, **kwds
):
    r"""Converts the given graph into a networkx.MultiDiGraph.

    The subjects and objects are the later nodes of the MultiDiGraph.
    The predicates are used as edge keys (to identify multi-edges).

    Args:
        graph: a rdflib.Graph.
        edge_attrs: Callable to construct later edge_attributes. It receives
            3 variables (s, p, o) and should construct a dictionary that is
            passed to networkx's add_edge(s, o, \*\*attrs) function.

            By default this will include setting the MultiDiGraph key=p here.
            If you don't want to be able to re-identify the edge later on, you
            can set this to `lambda s, p, o: {}`. In this case MultiDiGraph's
            default (increasing ints) will be used.

    Returns:
        networkx.MultiDiGraph

    Example:
        ```python
        >>> from rdflib import Graph, URIRef, Literal
        >>> g = Graph()
        >>> a, b, l = URIRef('a'), URIRef('b'), Literal('l')
        >>> p, q = URIRef('p'), URIRef('q')
        >>> edges = [(a, p, b), (a, q, b), (b, p, a), (b, p, l)]
        >>> for t in edges:
        ...     g.add(t)
        ...
        >>> mdg = rdflib_to_networkx_multidigraph(g)
        >>> len(mdg.edges())
        4
        >>> mdg.has_edge(a, b)
        True
        >>> mdg.has_edge(a, b, key=p)
        True
        >>> mdg.has_edge(a, b, key=q)
        True

        >>> mdg = rdflib_to_networkx_multidigraph(g, edge_attrs=lambda s,p,o: {})
        >>> mdg.has_edge(a, b, key=0)
        True
        >>> mdg.has_edge(a, b, key=1)
        True
        ```
    """
    import networkx as nx

    mdg = nx.MultiDiGraph()
    _rdflib_to_networkx_graph(graph, mdg, False, edge_attrs, **kwds)
    return mdg


def rdflib_to_networkx_digraph(
    graph: Graph,
    calc_weights: bool = True,
    edge_attrs=lambda s, p, o: {"triples": [(s, p, o)]},
    **kwds,
):
    r"""Converts the given graph into a networkx.DiGraph.

    As an rdflib.Graph() can contain multiple edges between nodes, by default
    adds the a 'triples' attribute to the single DiGraph edge with a list of
    all triples between s and o.
    Also by default calculates the edge weight as the length of triples.

    Args:
        graph: a rdflib.Graph.
        calc_weights: If true calculate multi-graph edge-count as edge 'weight'
        edge_attrs: Callable to construct later edge_attributes. It receives
            3 variables (s, p, o) and should construct a dictionary that is passed to
            networkx's add_edge(s, o, \*\*attrs) function.

            By default this will include setting the 'triples' attribute here,
            which is treated specially by us to be merged. Other attributes of
            multi-edges will only contain the attributes of the first edge.
            If you don't want the 'triples' attribute for tracking, set this to
            `lambda s, p, o: {}`.

    Returns: networkx.DiGraph

    Example:
        ```python
        >>> from rdflib import Graph, URIRef, Literal
        >>> g = Graph()
        >>> a, b, l = URIRef('a'), URIRef('b'), Literal('l')
        >>> p, q = URIRef('p'), URIRef('q')
        >>> edges = [(a, p, b), (a, q, b), (b, p, a), (b, p, l)]
        >>> for t in edges:
        ...     g.add(t)
        ...
        >>> dg = rdflib_to_networkx_digraph(g)
        >>> dg[a][b]['weight']
        2
        >>> sorted(dg[a][b]['triples']) == [(a, p, b), (a, q, b)]
        True
        >>> len(dg.edges())
        3
        >>> dg.size()
        3
        >>> dg.size(weight='weight')
        4.0

        >>> dg = rdflib_to_networkx_graph(g, False, edge_attrs=lambda s,p,o:{})
        >>> 'weight' in dg[a][b]
        False
        >>> 'triples' in dg[a][b]
        False
        ```
    """
    import networkx as nx

    dg = nx.DiGraph()
    _rdflib_to_networkx_graph(graph, dg, calc_weights, edge_attrs, **kwds)
    return dg


def rdflib_to_networkx_graph(
    graph: Graph,
    calc_weights: bool = True,
    edge_attrs=lambda s, p, o: {"triples": [(s, p, o)]},
    **kwds,
):
    r"""Converts the given graph into a networkx.Graph.

    As an [`rdflib.Graph()`][rdflib.Graph] can contain multiple directed edges between nodes, by
    default adds the a 'triples' attribute to the single DiGraph edge with a list of triples between s and o in graph.
    Also by default calculates the edge weight as the `len(triples)`.

    Args:
        graph: a rdflib.Graph.
        calc_weights: If true calculate multi-graph edge-count as edge 'weight'
        edge_attrs: Callable to construct later edge_attributes. It receives
            3 variables (s, p, o) and should construct a dictionary that is
            passed to networkx's add_edge(s, o, \*\*attrs) function.

            By default this will include setting the 'triples' attribute here,
            which is treated specially by us to be merged. Other attributes of
            multi-edges will only contain the attributes of the first edge.
            If you don't want the 'triples' attribute for tracking, set this to
            `lambda s, p, o: {}`.

    Returns:
        networkx.Graph

    Example:
        ```python
        >>> from rdflib import Graph, URIRef, Literal
        >>> g = Graph()
        >>> a, b, l = URIRef('a'), URIRef('b'), Literal('l')
        >>> p, q = URIRef('p'), URIRef('q')
        >>> edges = [(a, p, b), (a, q, b), (b, p, a), (b, p, l)]
        >>> for t in edges:
        ...     g.add(t)
        ...
        >>> ug = rdflib_to_networkx_graph(g)
        >>> ug[a][b]['weight']
        3
        >>> sorted(ug[a][b]['triples']) == [(a, p, b), (a, q, b), (b, p, a)]
        True
        >>> len(ug.edges())
        2
        >>> ug.size()
        2
        >>> ug.size(weight='weight')
        4.0

        >>> ug = rdflib_to_networkx_graph(g, False, edge_attrs=lambda s,p,o:{})
        >>> 'weight' in ug[a][b]
        False
        >>> 'triples' in ug[a][b]
        False
        ```
    """
    import networkx as nx

    g = nx.Graph()
    _rdflib_to_networkx_graph(graph, g, calc_weights, edge_attrs, **kwds)
    return g


def rdflib_to_graphtool(
    graph: Graph,
    v_prop_names: List[str] = ["term"],
    e_prop_names: List[str] = ["term"],
    transform_s=lambda s, p, o: {"term": s},
    transform_p=lambda s, p, o: {"term": p},
    transform_o=lambda s, p, o: {"term": o},
):
    """Converts the given graph into a graph_tool.Graph().

    The subjects and objects are the later vertices of the Graph.
    The predicates become edges.

    Args:
        graph: a rdflib.Graph.
        v_prop_names: a list of names for the vertex properties. The default is set
            to ['term'] (see transform_s, transform_o below).
        e_prop_names: a list of names for the edge properties.
        transform_s: callable with s, p, o input. Should return a dictionary
            containing a value for each name in v_prop_names. By default is set
            to {'term': s} which in combination with v_prop_names = ['term']
            adds s as 'term' property to the generated vertex for s.
        transform_p: similar to transform_s, but wrt. e_prop_names. By default
            returns {'term': p} which adds p as a property to the generated
            edge between the vertex for s and the vertex for o.
        transform_o: similar to transform_s.

    Returns: graph_tool.Graph()

    Example:
        ```python
        >>> from rdflib import Graph, URIRef, Literal
        >>> g = Graph()
        >>> a, b, l = URIRef('a'), URIRef('b'), Literal('l')
        >>> p, q = URIRef('p'), URIRef('q')
        >>> edges = [(a, p, b), (a, q, b), (b, p, a), (b, p, l)]
        >>> for t in edges:
        ...     g.add(t)
        ...
        >>> mdg = rdflib_to_graphtool(g)
        >>> len(list(mdg.edges()))
        4
        >>> from graph_tool import util as gt_util
        >>> vpterm = mdg.vertex_properties['term']
        >>> va = gt_util.find_vertex(mdg, vpterm, a)[0]
        >>> vb = gt_util.find_vertex(mdg, vpterm, b)[0]
        >>> vl = gt_util.find_vertex(mdg, vpterm, l)[0]
        >>> (va, vb) in [(e.source(), e.target()) for e in list(mdg.edges())]
        True
        >>> epterm = mdg.edge_properties['term']
        >>> len(list(gt_util.find_edge(mdg, epterm, p))) == 3
        True
        >>> len(list(gt_util.find_edge(mdg, epterm, q))) == 1
        True

        >>> mdg = rdflib_to_graphtool(
        ...     g,
        ...     e_prop_names=[str('name')],
        ...     transform_p=lambda s, p, o: {str('name'): unicode(p)})
        >>> epterm = mdg.edge_properties['name']
        >>> len(list(gt_util.find_edge(mdg, epterm, unicode(p)))) == 3
        True
        >>> len(list(gt_util.find_edge(mdg, epterm, unicode(q)))) == 1
        True
        ```
    """
    # pytype error: Can't find module 'graph_tool'.
    import graph_tool as gt  # pytype: disable=import-error

    g = gt.Graph()

    vprops = [(vpn, g.new_vertex_property("object")) for vpn in v_prop_names]
    for vpn, vprop in vprops:
        g.vertex_properties[vpn] = vprop
    eprops = [(epn, g.new_edge_property("object")) for epn in e_prop_names]
    for epn, eprop in eprops:
        g.edge_properties[epn] = eprop
    node_to_vertex: Dict[Any, Any] = {}
    for s, p, o in graph:
        sv = node_to_vertex.get(s)
        if sv is None:
            v = g.add_vertex()
            node_to_vertex[s] = v
            tmp_props = transform_s(s, p, o)
            for vpn, vprop in vprops:
                vprop[v] = tmp_props[vpn]
            sv = v

        ov = node_to_vertex.get(o)
        if ov is None:
            v = g.add_vertex()
            node_to_vertex[o] = v
            tmp_props = transform_o(s, p, o)
            for vpn, vprop in vprops:
                vprop[v] = tmp_props[vpn]
            ov = v

        e = g.add_edge(sv, ov)
        tmp_props = transform_p(s, p, o)
        for epn, eprop in eprops:
            eprop[e] = tmp_props[epn]
    return g
