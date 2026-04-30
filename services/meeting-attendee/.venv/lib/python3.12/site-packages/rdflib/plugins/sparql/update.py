"""
Code for carrying out Update Operations
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Iterator, Mapping, Optional, Sequence

from rdflib.graph import Graph
from rdflib.plugins.sparql.evaluate import evalBGP, evalPart
from rdflib.plugins.sparql.evalutils import _fillTemplate, _join
from rdflib.plugins.sparql.parserutils import CompValue
from rdflib.plugins.sparql.sparql import FrozenDict, QueryContext, Update
from rdflib.term import Identifier, URIRef, Variable


def _graphOrDefault(ctx: QueryContext, g: str) -> Optional[Graph]:
    if g == "DEFAULT":
        return ctx.graph
    else:
        return ctx.dataset.get_context(g)


def _graphAll(ctx: QueryContext, g: str) -> Sequence[Graph]:
    """
    return a list of graphs
    """
    if g == "DEFAULT":
        # type error: List item 0 has incompatible type "Optional[Graph]"; expected "Graph"
        return [ctx.graph]  # type: ignore[list-item]
    elif g == "NAMED":
        return [
            # type error: Item "None" of "Optional[Graph]" has no attribute "identifier"
            c
            for c in ctx.dataset.contexts()
            if c.identifier != ctx.graph.identifier  # type: ignore[union-attr]
        ]
    elif g == "ALL":
        return list(ctx.dataset.contexts())
    else:
        return [ctx.dataset.get_context(g)]


def evalLoad(ctx: QueryContext, u: CompValue) -> None:
    """
    http://www.w3.org/TR/sparql11-update/#load
    """

    if TYPE_CHECKING:
        assert isinstance(u.iri, URIRef)

    if u.graphiri:
        ctx.load(u.iri, default=False, into=u.graphiri)
    else:
        ctx.load(u.iri, default=True)


def evalCreate(ctx: QueryContext, u: CompValue) -> None:
    """
    http://www.w3.org/TR/sparql11-update/#create
    """
    g = ctx.dataset.get_context(u.graphiri)
    if len(g) > 0:
        raise Exception("Graph %s already exists." % g.identifier)
    raise Exception("Create not implemented!")


def evalClear(ctx: QueryContext, u: CompValue) -> None:
    """
    http://www.w3.org/TR/sparql11-update/#clear
    """
    for g in _graphAll(ctx, u.graphiri):
        g.remove((None, None, None))


def evalDrop(ctx: QueryContext, u: CompValue) -> None:
    """
    http://www.w3.org/TR/sparql11-update/#drop
    """
    if ctx.dataset.store.graph_aware:
        for g in _graphAll(ctx, u.graphiri):
            ctx.dataset.store.remove_graph(g)
    else:
        evalClear(ctx, u)


def evalInsertData(ctx: QueryContext, u: CompValue) -> None:
    """
    http://www.w3.org/TR/sparql11-update/#insertData
    """
    # add triples
    g = ctx.graph
    g += u.triples
    # add quads
    # u.quads is a dict of graphURI=>[triples]
    for g in u.quads:
        # type error: Argument 1 to "get_context" of "ConjunctiveGraph" has incompatible type "Optional[Graph]"; expected "Union[IdentifiedNode, str, None]"
        cg = ctx.dataset.get_context(g)  # type: ignore[arg-type]
        cg += u.quads[g]


def evalDeleteData(ctx: QueryContext, u: CompValue) -> None:
    """
    http://www.w3.org/TR/sparql11-update/#deleteData
    """
    # remove triples
    g = ctx.graph
    g -= u.triples

    # remove quads
    # u.quads is a dict of graphURI=>[triples]
    for g in u.quads:
        # type error: Argument 1 to "get_context" of "ConjunctiveGraph" has incompatible type "Optional[Graph]"; expected "Union[IdentifiedNode, str, None]"
        cg = ctx.dataset.get_context(g)  # type: ignore[arg-type]
        cg -= u.quads[g]


def evalDeleteWhere(ctx: QueryContext, u: CompValue) -> None:
    """
    http://www.w3.org/TR/sparql11-update/#deleteWhere
    """

    res: Iterator[FrozenDict] = evalBGP(ctx, u.triples)
    for g in u.quads:
        cg = ctx.dataset.get_context(g)
        c = ctx.pushGraph(cg)
        res = _join(res, list(evalBGP(c, u.quads[g])))

    # type error: Incompatible types in assignment (expression has type "FrozenBindings", variable has type "QueryContext")
    for c in res:  # type: ignore[assignment]
        g = ctx.graph
        g -= _fillTemplate(u.triples, c)

        for g in u.quads:
            cg = ctx.dataset.get_context(c.get(g))
            cg -= _fillTemplate(u.quads[g], c)


def evalModify(ctx: QueryContext, u: CompValue) -> None:
    originalctx = ctx

    # Using replaces the dataset for evaluating the where-clause
    dg: Optional[Graph]
    if u.using:
        otherDefault = False
        for d in u.using:
            if d.default:
                if not otherDefault:
                    # replace current default graph
                    dg = Graph()
                    ctx = ctx.pushGraph(dg)
                    otherDefault = True

                ctx.load(d.default, default=True)

            elif d.named:
                g = d.named
                ctx.load(g, default=False)

    # "The WITH clause provides a convenience for when an operation
    # primarily refers to a single graph. If a graph name is specified
    # in a WITH clause, then - for the purposes of evaluating the
    # WHERE clause - this will define an RDF Dataset containing a
    # default graph with the specified name, but only in the absence
    # of USING or USING NAMED clauses. In the presence of one or more
    # graphs referred to in USING clauses and/or USING NAMED clauses,
    # the WITH clause will be ignored while evaluating the WHERE
    # clause."
    if not u.using and u.withClause:
        g = ctx.dataset.get_context(u.withClause)
        ctx = ctx.pushGraph(g)

    res = evalPart(ctx, u.where)

    if u.using:
        if otherDefault:
            ctx = originalctx  # restore original default graph
        if u.withClause:
            g = ctx.dataset.get_context(u.withClause)
            ctx = ctx.pushGraph(g)

    for c in list(res):
        # TODO: Make this more intentional and without the weird type checking logic
        #       once ConjunctiveGraph is removed and Dataset no longer inherits from
        #       Graph.
        dg = ctx.graph if type(ctx.graph) is Graph else ctx.dataset.default_context
        if u.delete:
            # type error: Unsupported left operand type for - ("None")
            # type error: Unsupported operand types for - ("Graph" and "Generator[Tuple[Identifier, Identifier, Identifier], None, None]")
            dg -= _fillTemplate(u.delete.triples, c)  # type: ignore[operator]

            for g, q in u.delete.quads.items():
                cg = ctx.dataset.get_context(c.get(g))
                cg -= _fillTemplate(q, c)

        if u.insert:
            # type error: Unsupported left operand type for + ("None")
            # type error: Unsupported operand types for + ("Graph" and "Generator[Tuple[Identifier, Identifier, Identifier], None, None]")
            dg += _fillTemplate(u.insert.triples, c)  # type: ignore[operator]

            for g, q in u.insert.quads.items():
                cg = ctx.dataset.get_context(c.get(g))
                cg += _fillTemplate(q, c)


def evalAdd(ctx: QueryContext, u: CompValue) -> None:
    """

    add all triples from src to dst

    http://www.w3.org/TR/sparql11-update/#add
    """
    src, dst = u.graph

    srcg = _graphOrDefault(ctx, src)
    dstg = _graphOrDefault(ctx, dst)

    # type error: Item "None" of "Optional[Graph]" has no attribute "identifier"
    if srcg.identifier == dstg.identifier:  # type: ignore[union-attr]
        return

    # type error: Unsupported left operand type for + ("None")
    dstg += srcg  # type: ignore[operator]


def evalMove(ctx: QueryContext, u: CompValue) -> None:
    """

    remove all triples from dst
    add all triples from src to dst
    remove all triples from src

    http://www.w3.org/TR/sparql11-update/#move
    """

    src, dst = u.graph

    srcg = _graphOrDefault(ctx, src)
    dstg = _graphOrDefault(ctx, dst)

    # type error: Item "None" of "Optional[Graph]" has no attribute "identifier"
    if srcg.identifier == dstg.identifier:  # type: ignore[union-attr]
        return

    # type error: Item "None" of "Optional[Graph]" has no attribute "remove"
    dstg.remove((None, None, None))  # type: ignore[union-attr]

    # type error: Unsupported left operand type for + ("None")
    dstg += srcg  # type: ignore[operator]

    if ctx.dataset.store.graph_aware:
        # type error: Argument 1 to "remove_graph" of "Store" has incompatible type "Optional[Graph]"; expected "Graph"
        ctx.dataset.store.remove_graph(srcg)  # type: ignore[arg-type]
    else:
        # type error: Item "None" of "Optional[Graph]" has no attribute "remove"
        srcg.remove((None, None, None))  # type: ignore[union-attr]


def evalCopy(ctx: QueryContext, u: CompValue) -> None:
    """

    remove all triples from dst
    add all triples from src to dst

    http://www.w3.org/TR/sparql11-update/#copy
    """

    src, dst = u.graph

    srcg = _graphOrDefault(ctx, src)
    dstg = _graphOrDefault(ctx, dst)

    # type error: Item "None" of "Optional[Graph]" has no attribute "remove"
    if srcg.identifier == dstg.identifier:  # type: ignore[union-attr]
        return

    # type error: Item "None" of "Optional[Graph]" has no attribute "remove"
    dstg.remove((None, None, None))  # type: ignore[union-attr]

    # type error: Unsupported left operand type for + ("None")
    dstg += srcg  # type: ignore[operator]


def evalUpdate(
    graph: Graph,
    update: Update,
    initBindings: Optional[Mapping[str, Identifier]] = None,
) -> None:
    """http://www.w3.org/TR/sparql11-update/#updateLanguage

    'A request is a sequence of operations [...] Implementations MUST
    ensure that operations of a single request are executed in a
    fashion that guarantees the same effects as executing them in
    lexical order.

    Operations all result either in success or failure.

    If multiple operations are present in a single request, then a
    result of failure from any operation MUST abort the sequence of
    operations, causing the subsequent operations to be ignored.'

    This will return None on success and raise Exceptions on error

    !!! warning "Security Considerations"

        This method can access indirectly requested network endpoints, for
        example, query processing will attempt to access network endpoints
        specified in `SERVICE` directives.

        When processing untrusted or potentially malicious queries, measures
        should be taken to restrict network and file access.

        For information on available security measures, see the RDFLib
        [Security Considerations](../security_considerations.md)
        documentation.

    """

    for u in update.algebra:
        initBindings = dict((Variable(k), v) for k, v in (initBindings or {}).items())

        ctx = QueryContext(graph, initBindings=initBindings)
        ctx.prologue = u.prologue

        try:
            if u.name == "Load":
                evalLoad(ctx, u)
            elif u.name == "Clear":
                evalClear(ctx, u)
            elif u.name == "Drop":
                evalDrop(ctx, u)
            elif u.name == "Create":
                evalCreate(ctx, u)
            elif u.name == "Add":
                evalAdd(ctx, u)
            elif u.name == "Move":
                evalMove(ctx, u)
            elif u.name == "Copy":
                evalCopy(ctx, u)
            elif u.name == "InsertData":
                evalInsertData(ctx, u)
            elif u.name == "DeleteData":
                evalDeleteData(ctx, u)
            elif u.name == "DeleteWhere":
                evalDeleteWhere(ctx, u)
            elif u.name == "Modify":
                evalModify(ctx, u)
            else:
                raise Exception("Unknown update operation: %s" % (u,))
        except:  # noqa: E722
            if not u.silent:
                raise
