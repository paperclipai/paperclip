"""
Converting the 'parse-tree' output of pyparsing to a SPARQL Algebra expression

http://www.w3.org/TR/sparql11-query/#sparqlQuery
"""

from __future__ import annotations

import collections
import functools
import operator
import typing
from functools import reduce
from typing import (
    Any,
    Callable,
    DefaultDict,
    Dict,
    Iterable,
    List,
    Mapping,
    Optional,
    Set,
    Tuple,
    overload,
)

from pyparsing import ParseResults

from rdflib.paths import (
    AlternativePath,
    InvPath,
    MulPath,
    NegatedPath,
    Path,
    SequencePath,
)
from rdflib.plugins.sparql.operators import TrueFilter, and_
from rdflib.plugins.sparql.operators import simplify as simplifyFilters
from rdflib.plugins.sparql.parserutils import CompValue, Expr
from rdflib.plugins.sparql.sparql import Prologue, Query, Update

# ---------------------------
# Some convenience methods
from rdflib.term import BNode, Identifier, Literal, URIRef, Variable


def OrderBy(p: CompValue, expr: List[CompValue]) -> CompValue:
    return CompValue("OrderBy", p=p, expr=expr)


def ToMultiSet(p: typing.Union[List[Dict[Variable, str]], CompValue]) -> CompValue:
    return CompValue("ToMultiSet", p=p)


def Union(p1: CompValue, p2: CompValue) -> CompValue:
    return CompValue("Union", p1=p1, p2=p2)


def Join(p1: CompValue, p2: Optional[CompValue]) -> CompValue:
    return CompValue("Join", p1=p1, p2=p2)


def Minus(p1: CompValue, p2: CompValue) -> CompValue:
    return CompValue("Minus", p1=p1, p2=p2)


def Graph(term: Identifier, graph: CompValue) -> CompValue:
    return CompValue("Graph", term=term, p=graph)


def BGP(
    triples: Optional[List[Tuple[Identifier, Identifier, Identifier]]] = None
) -> CompValue:
    return CompValue("BGP", triples=triples or [])


def LeftJoin(p1: CompValue, p2: CompValue, expr) -> CompValue:
    return CompValue("LeftJoin", p1=p1, p2=p2, expr=expr)


def Filter(expr: Expr, p: CompValue) -> CompValue:
    return CompValue("Filter", expr=expr, p=p)


def Extend(
    p: CompValue, expr: typing.Union[Identifier, Expr], var: Variable
) -> CompValue:
    return CompValue("Extend", p=p, expr=expr, var=var)


def Values(res: List[Dict[Variable, str]]) -> CompValue:
    return CompValue("values", res=res)


def Project(p: CompValue, PV: List[Variable]) -> CompValue:
    return CompValue("Project", p=p, PV=PV)


def Group(p: CompValue, expr: Optional[List[Variable]] = None) -> CompValue:
    return CompValue("Group", p=p, expr=expr)


def _knownTerms(
    triple: Tuple[Identifier, Identifier, Identifier],
    varsknown: Set[typing.Union[BNode, Variable]],
    varscount: Dict[Identifier, int],
) -> Tuple[int, int, bool]:
    return (
        len(
            [
                x
                for x in triple
                if x not in varsknown and isinstance(x, (Variable, BNode))
            ]
        ),
        -sum(varscount.get(x, 0) for x in triple),
        not isinstance(triple[2], Literal),
    )


def reorderTriples(
    l_: Iterable[Tuple[Identifier, Identifier, Identifier]]
) -> List[Tuple[Identifier, Identifier, Identifier]]:
    """
    Reorder triple patterns so that we execute the
    ones with most bindings first
    """

    def _addvar(term: str, varsknown: Set[typing.Union[Variable, BNode]]):
        if isinstance(term, (Variable, BNode)):
            varsknown.add(term)

    # NOTE on type errors: most of these are because the same variable is used
    # for different types.

    # type error: List comprehension has incompatible type List[Tuple[None, Tuple[Identifier, Identifier, Identifier]]]; expected List[Tuple[Identifier, Identifier, Identifier]]
    l_ = [(None, x) for x in l_]  # type: ignore[misc]
    varsknown: Set[typing.Union[BNode, Variable]] = set()
    varscount: Dict[Identifier, int] = collections.defaultdict(int)
    for t in l_:
        for c in t[1]:
            if isinstance(c, (Variable, BNode)):
                varscount[c] += 1
    i = 0

    # Done in steps, sort by number of bound terms
    # the top block of patterns with the most bound terms is kept
    # the rest is resorted based on the vars bound after the first
    # block is evaluated

    # we sort by decorate/undecorate, since we need the value of the sort keys

    while i < len(l_):
        # type error: Generator has incompatible item type "Tuple[Any, Identifier]"; expected "Tuple[Identifier, Identifier, Identifier]"
        # type error: Argument 1 to "_knownTerms" has incompatible type "Identifier"; expected "Tuple[Identifier, Identifier, Identifier]"
        l_[i:] = sorted((_knownTerms(x[1], varsknown, varscount), x[1]) for x in l_[i:])  # type: ignore[misc,arg-type]
        # type error: Incompatible types in assignment (expression has type "str", variable has type "Tuple[Identifier, Identifier, Identifier]")
        t = l_[i][0][0]  # type: ignore[assignment] # top block has this many terms bound
        j = 0
        while i + j < len(l_) and l_[i + j][0][0] == t:
            for c in l_[i + j][1]:
                _addvar(c, varsknown)
            j += 1
        i += 1

    # type error: List comprehension has incompatible type List[Identifier]; expected List[Tuple[Identifier, Identifier, Identifier]]
    return [x[1] for x in l_]  # type: ignore[misc]


def triples(
    l: typing.Union[  # noqa: E741
        List[List[Identifier]], List[Tuple[Identifier, Identifier, Identifier]]
    ]
) -> List[Tuple[Identifier, Identifier, Identifier]]:
    _l = reduce(lambda x, y: x + y, l)
    if (len(_l) % 3) != 0:
        raise Exception("these aint triples")
    return reorderTriples((_l[x], _l[x + 1], _l[x + 2]) for x in range(0, len(_l), 3))


# type error: Missing return statement
def translatePName(  # type: ignore[return]
    p: typing.Union[CompValue, str], prologue: Prologue
) -> Optional[Identifier]:
    """
    Expand prefixed/relative URIs
    """
    if isinstance(p, CompValue):
        if p.name == "pname":
            # type error: Incompatible return value type (got "Union[CompValue, str, None]", expected "Optional[Identifier]")
            return prologue.absolutize(p)  # type: ignore[return-value]
        if p.name == "literal":
            # type error: Argument "datatype" to "Literal" has incompatible type "Union[CompValue, str, None]"; expected "Optional[str]"
            return Literal(
                p.string, lang=p.lang, datatype=prologue.absolutize(p.datatype)  # type: ignore[arg-type]
            )
    elif isinstance(p, URIRef):
        # type error: Incompatible return value type (got "Union[CompValue, str, None]", expected "Optional[Identifier]")
        return prologue.absolutize(p)  # type: ignore[return-value]


@overload
def translatePath(p: URIRef) -> None: ...


@overload
def translatePath(p: CompValue) -> Path: ...


# type error: Missing return statement
def translatePath(p: typing.Union[CompValue, URIRef]) -> Optional[Path]:  # type: ignore[return]
    """
    Translate PropertyPath expressions
    """

    if isinstance(p, CompValue):
        if p.name == "PathAlternative":
            if len(p.part) == 1:
                return p.part[0]
            else:
                return AlternativePath(*p.part)

        elif p.name == "PathSequence":
            if len(p.part) == 1:
                return p.part[0]
            else:
                return SequencePath(*p.part)

        elif p.name == "PathElt":
            if not p.mod:
                return p.part
            else:
                if isinstance(p.part, list):
                    if len(p.part) != 1:
                        raise Exception("Denkfehler!")

                    return MulPath(p.part[0], p.mod)
                else:
                    return MulPath(p.part, p.mod)

        elif p.name == "PathEltOrInverse":
            if isinstance(p.part, list):
                if len(p.part) != 1:
                    raise Exception("Denkfehler!")
                return InvPath(p.part[0])
            else:
                return InvPath(p.part)

        elif p.name == "PathNegatedPropertySet":
            if isinstance(p.part, list):
                return NegatedPath(AlternativePath(*p.part))
            else:
                return NegatedPath(p.part)


def translateExists(
    e: typing.Union[Expr, Literal, Variable, URIRef]
) -> typing.Union[Expr, Literal, Variable, URIRef]:
    """
    Translate the graph pattern used by EXISTS and NOT EXISTS
    http://www.w3.org/TR/sparql11-query/#sparqlCollectFilters
    """

    def _c(n):
        if isinstance(n, CompValue):
            if n.name in ("Builtin_EXISTS", "Builtin_NOTEXISTS"):
                n.graph = translateGroupGraphPattern(n.graph)
                if n.graph.name == "Filter":
                    # filters inside (NOT) EXISTS can see vars bound outside
                    n.graph.no_isolated_scope = True

    e = traverse(e, visitPost=_c)

    return e


def collectAndRemoveFilters(parts: List[CompValue]) -> Optional[Expr]:
    """FILTER expressions apply to the whole group graph pattern in which
    they appear.

    http://www.w3.org/TR/sparql11-query/#sparqlCollectFilters
    """

    filters = []

    i = 0
    while i < len(parts):
        p = parts[i]
        if p.name == "Filter":
            filters.append(translateExists(p.expr))
            parts.pop(i)
        else:
            i += 1

    if filters:
        # type error: Argument 1 to "and_" has incompatible type "*List[Union[Expr, Literal, Variable]]"; expected "Expr"
        return and_(*filters)  # type: ignore[arg-type]

    return None


def translateGroupOrUnionGraphPattern(graphPattern: CompValue) -> Optional[CompValue]:
    A: Optional[CompValue] = None

    for g in graphPattern.graph:
        g = translateGroupGraphPattern(g)
        if not A:
            A = g
        else:
            A = Union(A, g)
    return A


def translateGraphGraphPattern(graphPattern: CompValue) -> CompValue:
    return Graph(graphPattern.term, translateGroupGraphPattern(graphPattern.graph))


def translateInlineData(graphPattern: CompValue) -> CompValue:
    return ToMultiSet(translateValues(graphPattern))


def translateGroupGraphPattern(graphPattern: CompValue) -> CompValue:
    """
    http://www.w3.org/TR/sparql11-query/#convertGraphPattern
    """

    if graphPattern.translated:
        # This occurs if it is attempted to translate a group graph pattern twice,
        # which occurs with nested (NOT) EXISTS filters. Simply return the already
        # translated pattern instead.
        return graphPattern
    if graphPattern.name == "SubSelect":
        # The first output from translate cannot be None for a subselect query
        # as it can only be None for certain DESCRIBE queries.
        # type error: Argument 1 to "ToMultiSet" has incompatible type "Optional[CompValue]";
        #   expected "Union[List[Dict[Variable, str]], CompValue]"
        return ToMultiSet(translate(graphPattern)[0])  # type: ignore[arg-type]

    if not graphPattern.part:
        graphPattern.part = []  # empty { }

    filters = collectAndRemoveFilters(graphPattern.part)

    g: List[CompValue] = []
    for p in graphPattern.part:
        if p.name == "TriplesBlock":
            # merge adjacent TripleBlocks
            if not (g and g[-1].name == "BGP"):
                g.append(BGP())
            g[-1]["triples"] += triples(p.triples)
        else:
            g.append(p)

    G = BGP()
    for p in g:
        if p.name == "OptionalGraphPattern":
            A = translateGroupGraphPattern(p.graph)
            if A.name == "Filter":
                G = LeftJoin(G, A.p, A.expr)
            else:
                G = LeftJoin(G, A, TrueFilter)
        elif p.name == "MinusGraphPattern":
            G = Minus(p1=G, p2=translateGroupGraphPattern(p.graph))
        elif p.name == "GroupOrUnionGraphPattern":
            G = Join(p1=G, p2=translateGroupOrUnionGraphPattern(p))
        elif p.name == "GraphGraphPattern":
            G = Join(p1=G, p2=translateGraphGraphPattern(p))
        elif p.name == "InlineData":
            G = Join(p1=G, p2=translateInlineData(p))
        elif p.name == "ServiceGraphPattern":
            G = Join(p1=G, p2=p)
        elif p.name in ("BGP", "Extend"):
            G = Join(p1=G, p2=p)
        elif p.name == "Bind":
            # translateExists will translate the expression if it is EXISTS, and otherwise return
            # the expression as is. This is needed because EXISTS has a graph pattern
            # which must be translated to work properly during evaluation.
            G = Extend(G, translateExists(p.expr), p.var)

        else:
            raise Exception(
                "Unknown part in GroupGraphPattern: %s - %s" % (type(p), p.name)
            )

    if filters:
        G = Filter(expr=filters, p=G)

    # Mark this graph pattern as translated
    G.translated = True

    return G


class StopTraversal(Exception):  # noqa: N818
    def __init__(self, rv: bool):
        self.rv = rv


def _traverse(
    e: Any,
    visitPre: Callable[[Any], Any] = lambda n: None,
    visitPost: Callable[[Any], Any] = lambda n: None,
):
    """Traverse a parse-tree, visit each node

    if visit functions return a value, replace current node
    """
    _e = visitPre(e)
    if _e is not None:
        return _e

    if e is None:
        return None

    if isinstance(e, (list, ParseResults)):
        return [_traverse(x, visitPre, visitPost) for x in e]
    elif isinstance(e, tuple):
        return tuple([_traverse(x, visitPre, visitPost) for x in e])

    elif isinstance(e, CompValue):
        for k, val in e.items():
            e[k] = _traverse(val, visitPre, visitPost)

    _e = visitPost(e)
    if _e is not None:
        return _e

    return e


def _traverseAgg(e: Any, visitor: Callable[[Any, Any], Any] = lambda n, v: None):
    """
    Traverse a parse-tree, visit each node

    if visit functions return a value, replace current node
    """

    res = []

    if isinstance(e, (list, ParseResults, tuple)):
        res = [_traverseAgg(x, visitor) for x in e]
    elif isinstance(e, CompValue):
        for k, val in e.items():
            if val is not None:
                res.append(_traverseAgg(val, visitor))

    return visitor(e, res)


def traverse(
    tree,
    visitPre: Callable[[Any], Any] = lambda n: None,
    visitPost: Callable[[Any], Any] = lambda n: None,
    complete: Optional[bool] = None,
) -> Any:
    """
    Traverse tree, visit each node with visit function
    visit function may raise StopTraversal to stop traversal
    if complete!=None, it is returned on complete traversal,
    otherwise the transformed tree is returned
    """
    try:
        r = _traverse(tree, visitPre, visitPost)
        if complete is not None:
            return complete
        return r
    except StopTraversal as st:
        return st.rv


def _hasAggregate(x) -> None:
    """
    Traverse parse(sub)Tree
    return true if any aggregates are used
    """

    if isinstance(x, CompValue):
        if x.name.startswith("Aggregate_"):
            raise StopTraversal(True)


# type error: Missing return statement
def _aggs(e, A) -> Optional[Variable]:  # type: ignore[return]
    """
    Collect Aggregates in A
    replaces aggregates with variable references
    """

    # TODO: nested Aggregates?

    if isinstance(e, CompValue) and e.name.startswith("Aggregate_"):
        A.append(e)
        aggvar = Variable("__agg_%d__" % len(A))
        e["res"] = aggvar
        return aggvar


# type error: Missing return statement
def _findVars(x, res: Set[Variable]) -> Optional[CompValue]:  # type: ignore[return]
    """
    Find all variables in a tree
    """
    if isinstance(x, Variable):
        res.add(x)
    if isinstance(x, CompValue):
        if x.name == "Bind":
            res.add(x.var)
            return x  # stop recursion and finding vars in the expr
        elif x.name == "SubSelect":
            if x.projection:
                res.update(v.var or v.evar for v in x.projection)

            return x


def _addVars(x, children: List[Set[Variable]]) -> Set[Variable]:
    """
    find which variables may be bound by this part of the query
    """
    if isinstance(x, Variable):
        return set([x])
    elif isinstance(x, CompValue):
        if x.name == "RelationalExpression":
            x["_vars"] = set()
        elif x.name == "Extend":
            # vars only used in the expr for a bind should not be included
            x["_vars"] = reduce(
                operator.or_,
                [child for child, part in zip(children, x) if part != "expr"],
                set(),
            )

        else:
            x["_vars"] = set(reduce(operator.or_, children, set()))

            if x.name == "SubSelect":
                if x.projection:
                    s = set(v.var or v.evar for v in x.projection)
                else:
                    s = set()

                return s

        return x["_vars"]

    return reduce(operator.or_, children, set())


# type error: Missing return statement
def _sample(e: typing.Union[CompValue, List[Expr], Expr, List[str], Variable], v: Optional[Variable] = None) -> Optional[CompValue]:  # type: ignore[return]
    """
    For each unaggregated variable V in expr
    Replace V with Sample(V)
    """
    if isinstance(e, CompValue) and e.name.startswith("Aggregate_"):
        return e  # do not replace vars in aggregates
    if isinstance(e, Variable) and v != e:
        return CompValue("Aggregate_Sample", vars=e)


def _simplifyFilters(e: Any) -> Any:
    if isinstance(e, Expr):
        return simplifyFilters(e)


def translateAggregates(
    q: CompValue, M: CompValue
) -> Tuple[CompValue, List[Tuple[Variable, Variable]]]:
    E: List[Tuple[Variable, Variable]] = []
    A: List[CompValue] = []

    # collect/replace aggs in :
    #    select expr as ?var
    if q.projection:
        for v in q.projection:
            if v.evar:
                v.expr = traverse(v.expr, functools.partial(_sample, v=v.evar))
                v.expr = traverse(v.expr, functools.partial(_aggs, A=A))

    # having clause
    if traverse(q.having, _hasAggregate, complete=True):
        q.having = traverse(q.having, _sample)
        traverse(q.having, functools.partial(_aggs, A=A))

    # order by
    if traverse(q.orderby, _hasAggregate, complete=False):
        q.orderby = traverse(q.orderby, _sample)
        traverse(q.orderby, functools.partial(_aggs, A=A))

    # sample all other select vars
    # TODO: only allowed for vars in group-by?
    if q.projection:
        for v in q.projection:
            if v.var:
                rv = Variable("__agg_%d__" % (len(A) + 1))
                A.append(CompValue("Aggregate_Sample", vars=v.var, res=rv))
                E.append((rv, v.var))

    return CompValue("AggregateJoin", A=A, p=M), E


def translateValues(
    v: CompValue,
) -> typing.Union[List[Dict[Variable, str]], CompValue]:
    # if len(v.var)!=len(v.value):
    #     raise Exception("Unmatched vars and values in ValueClause: "+str(v))

    res: List[Dict[Variable, str]] = []
    if not v.var:
        return res
    if not v.value:
        return res
    if not isinstance(v.value[0], list):
        for val in v.value:
            res.append({v.var[0]: val})
    else:
        for vals in v.value:
            res.append(dict(zip(v.var, vals)))

    return Values(res)


def translate(q: CompValue) -> Tuple[Optional[CompValue], List[Variable]]:
    """
    http://www.w3.org/TR/sparql11-query/#convertSolMod
    """

    _traverse(q, _simplifyFilters)

    q.where = traverse(q.where, visitPost=translatePath)

    # TODO: Var scope test
    VS: Set[Variable] = set()

    # All query types have a WHERE clause EXCEPT some DESCRIBE queries
    # where only explicit IRIs are provided.
    if q.name == "DescribeQuery":
        # For DESCRIBE queries, use the vars provided in q.var.
        # If there is no WHERE clause, vars should be explicit IRIs to describe.
        # If there is a WHERE clause, vars can be any combination of explicit IRIs
        # and variables.
        VS = set(q.var)

        # If there is no WHERE clause, just return the vars projected
        if q.where is None:
            return None, list(VS)

        # Otherwise, evaluate the WHERE clause like SELECT DISTINCT
        else:
            q.modifier = "DISTINCT"

    else:
        traverse(q.where, functools.partial(_findVars, res=VS))

    # depth-first recursive generation of mapped query tree
    M = translateGroupGraphPattern(q.where)

    aggregate = False
    if q.groupby:
        conditions = []
        # convert "GROUP BY (?expr as ?var)" to an Extend
        for c in q.groupby.condition:
            if isinstance(c, CompValue) and c.name == "GroupAs":
                M = Extend(M, c.expr, c.var)
                c = c.var
            conditions.append(c)

        M = Group(p=M, expr=conditions)
        aggregate = True
    elif (
        traverse(q.having, _hasAggregate, complete=False)
        or traverse(q.orderby, _hasAggregate, complete=False)
        or any(
            traverse(x.expr, _hasAggregate, complete=False)
            for x in q.projection or []
            if x.evar
        )
    ):
        # if any aggregate is used, implicit group by
        M = Group(p=M)
        aggregate = True

    if aggregate:
        M, aggregateAliases = translateAggregates(q, M)
    else:
        aggregateAliases = []

    # Need to remove the aggregate var aliases before joining to VALUES;
    # else the variable names won't match up correctly when aggregating.
    for alias, var in aggregateAliases:
        M = Extend(M, alias, var)

    # HAVING
    if q.having:
        M = Filter(expr=and_(*q.having.condition), p=M)

    # VALUES
    if q.valuesClause:
        M = Join(p1=M, p2=ToMultiSet(translateValues(q.valuesClause)))

    if not q.projection:
        # select *

        # Find the first child projection in each branch of the mapped query tree,
        # then include the variables it projects out in our projected variables.
        for child_projection in _find_first_child_projections(M):
            VS |= set(child_projection.PV)

        PV = list(VS)
    else:
        E = list()
        PV = list()
        for v in q.projection:
            if v.var:
                if v not in PV:
                    PV.append(v.var)
            elif v.evar:
                if v not in PV:
                    PV.append(v.evar)

                E.append((v.expr, v.evar))
            else:
                raise Exception("I expected a var or evar here!")

        for e, v in E:
            M = Extend(M, e, v)

    # ORDER BY
    if q.orderby:
        M = OrderBy(
            M,
            [
                CompValue("OrderCondition", expr=c.expr, order=c.order)
                for c in q.orderby.condition
            ],
        )

    # PROJECT
    M = Project(M, PV)

    if q.modifier:
        if q.modifier == "DISTINCT":
            M = CompValue("Distinct", p=M)
        elif q.modifier == "REDUCED":
            M = CompValue("Reduced", p=M)

    if q.limitoffset:
        offset = 0
        if q.limitoffset.offset is not None:
            offset = q.limitoffset.offset.toPython()

        if q.limitoffset.limit is not None:
            M = CompValue(
                "Slice", p=M, start=offset, length=q.limitoffset.limit.toPython()
            )
        else:
            M = CompValue("Slice", p=M, start=offset)

    return M, PV


def _find_first_child_projections(M: CompValue) -> Iterable[CompValue]:
    """
    Recursively find the first child instance of a Projection operation in each of
    the branches of the query execution plan/tree.
    """

    for child_op in M.values():
        if isinstance(child_op, CompValue):
            if child_op.name == "Project":
                yield child_op
            else:
                for child_projection in _find_first_child_projections(child_op):
                    yield child_projection


# type error: Missing return statement
def simplify(n: Any) -> Optional[CompValue]:  # type: ignore[return]
    """Remove joins to empty BGPs"""
    if isinstance(n, CompValue):
        if n.name == "Join":
            if n.p1.name == "BGP" and len(n.p1.triples) == 0:
                return n.p2
            if n.p2.name == "BGP" and len(n.p2.triples) == 0:
                return n.p1
        elif n.name == "BGP":
            n["triples"] = reorderTriples(n.triples)
            return n


def analyse(n: Any, children: Any) -> bool:
    """
    Some things can be lazily joined.
    This propegates whether they can up the tree
    and sets lazy flags for all joins
    """

    if isinstance(n, CompValue):
        if n.name == "Join":
            n["lazy"] = all(children)
            return False
        elif n.name in ("Slice", "Distinct"):
            return False
        else:
            return all(children)
    else:
        return True


def translatePrologue(
    p: ParseResults,
    base: Optional[str],
    initNs: Optional[Mapping[str, Any]] = None,
    prologue: Optional[Prologue] = None,
) -> Prologue:
    if prologue is None:
        prologue = Prologue()
        prologue.base = ""
    if base:
        prologue.base = base
    if initNs:
        for k, v in initNs.items():
            prologue.bind(k, v)

    x: CompValue
    for x in p:
        if x.name == "Base":
            prologue.base = x.iri
        elif x.name == "PrefixDecl":
            prologue.bind(x.prefix, prologue.absolutize(x.iri))

    return prologue


def translateQuads(
    quads: CompValue,
) -> Tuple[
    List[Tuple[Identifier, Identifier, Identifier]],
    DefaultDict[str, List[Tuple[Identifier, Identifier, Identifier]]],
]:
    if quads.triples:
        alltriples = triples(quads.triples)
    else:
        alltriples = []

    allquads: DefaultDict[str, List[Tuple[Identifier, Identifier, Identifier]]] = (
        collections.defaultdict(list)
    )

    if quads.quadsNotTriples:
        for q in quads.quadsNotTriples:
            if q.triples:
                allquads[q.term] += triples(q.triples)

    return alltriples, allquads


def translateUpdate1(u: CompValue, prologue: Prologue) -> CompValue:
    if u.name in ("Load", "Clear", "Drop", "Create"):
        pass  # no translation needed
    elif u.name in ("Add", "Move", "Copy"):
        pass
    elif u.name in ("InsertData", "DeleteData", "DeleteWhere"):
        t, q = translateQuads(u.quads)
        u["quads"] = q
        u["triples"] = t
        if u.name in ("DeleteWhere", "DeleteData"):
            pass  # TODO: check for bnodes in triples
    elif u.name == "Modify":
        if u.delete:
            u.delete["triples"], u.delete["quads"] = translateQuads(u.delete.quads)
        if u.insert:
            u.insert["triples"], u.insert["quads"] = translateQuads(u.insert.quads)
        u["where"] = translateGroupGraphPattern(u.where)
    else:
        raise Exception("Unknown type of update operation: %s" % u)

    u.prologue = prologue
    return u


def translateUpdate(
    q: CompValue,
    base: Optional[str] = None,
    initNs: Optional[Mapping[str, Any]] = None,
) -> Update:
    """
    Returns a list of SPARQL Update Algebra expressions
    """

    res: List[CompValue] = []
    prologue = None
    if not q.request:
        # type error: Incompatible return value type (got "List[CompValue]", expected "Update")
        return res  # type: ignore[return-value]
    for p, u in zip(q.prologue, q.request):
        prologue = translatePrologue(p, base, initNs, prologue)

        # absolutize/resolve prefixes
        u = traverse(u, visitPost=functools.partial(translatePName, prologue=prologue))
        u = _traverse(u, _simplifyFilters)

        u = traverse(u, visitPost=translatePath)

        res.append(translateUpdate1(u, prologue))

    # type error: Argument 1 to "Update" has incompatible type "Optional[Any]"; expected "Prologue"
    return Update(prologue, res)  # type: ignore[arg-type]


def translateQuery(
    q: ParseResults,
    base: Optional[str] = None,
    initNs: Optional[Mapping[str, Any]] = None,
) -> Query:
    """
    Translate a query-parsetree to a SPARQL Algebra Expression

    Return a rdflib.plugins.sparql.sparql.Query object
    """

    # We get in: (prologue, query)

    prologue = translatePrologue(q[0], base, initNs)

    # absolutize/resolve prefixes
    q[1] = traverse(
        q[1], visitPost=functools.partial(translatePName, prologue=prologue)
    )

    P, PV = translate(q[1])
    datasetClause = q[1].datasetClause
    if q[1].name == "ConstructQuery":
        template = triples(q[1].template) if q[1].template else None

        res = CompValue(q[1].name, p=P, template=template, datasetClause=datasetClause)
    else:
        res = CompValue(q[1].name, p=P, datasetClause=datasetClause, PV=PV)

    res = traverse(res, visitPost=simplify)
    _traverseAgg(res, visitor=analyse)
    _traverseAgg(res, _addVars)

    return Query(prologue, res)


class ExpressionNotCoveredException(Exception):  # noqa: N818
    pass


class _AlgebraTranslator:
    """Translator of a Query's algebra to its equivalent SPARQL (string).

    Coded as a class to support storage of state during the translation process,
    without use of a file.

    Anticipated Usage:

    ```python
    translated_query = _AlgebraTranslator(query).translateAlgebra()
    ```

    An external convenience function which wraps the above call,
    `translateAlgebra`, is supplied, so this class does not need to be
    referenced by client code at all in normal use.
    """

    def __init__(self, query_algebra: Query):
        self.query_algebra = query_algebra
        self.aggr_vars: DefaultDict[Identifier, List[Identifier]] = (
            collections.defaultdict(list)
        )
        self._alg_translation: str = ""

    def _replace(
        self,
        old: str,
        new: str,
        search_from_match: str = None,
        search_from_match_occurrence: int = None,
        count: int = 1,
    ):
        def find_nth(haystack, needle, n):
            start = haystack.lower().find(needle)
            while start >= 0 and n > 1:
                start = haystack.lower().find(needle, start + len(needle))
                n -= 1
            return start

        if search_from_match and search_from_match_occurrence:
            position = find_nth(
                self._alg_translation, search_from_match, search_from_match_occurrence
            )
            filedata_pre = self._alg_translation[:position]
            filedata_post = self._alg_translation[position:].replace(old, new, count)
            self._alg_translation = filedata_pre + filedata_post
        else:
            self._alg_translation = self._alg_translation.replace(old, new, count)

    def convert_node_arg(
        self, node_arg: typing.Union[Identifier, CompValue, Expr, str]
    ) -> str:
        if isinstance(node_arg, Identifier):
            if node_arg in self.aggr_vars.keys():
                grp_var = self.aggr_vars[node_arg].pop(0).n3()
                return grp_var
            else:
                return node_arg.n3()
        elif isinstance(node_arg, CompValue):
            return "{" + node_arg.name + "}"
        elif isinstance(node_arg, str):
            return node_arg
        else:
            raise ExpressionNotCoveredException(
                "The expression {0} might not be covered yet.".format(node_arg)
            )

    def sparql_query_text(self, node):
        """<https://www.w3.org/TR/sparql11-query/#sparqlSyntax>"""

        if isinstance(node, CompValue):
            # 18.2 Query Forms
            if node.name == "SelectQuery":
                self._alg_translation = "-*-SELECT-*- " + "{" + node.p.name + "}"

            # 18.2 Graph Patterns
            elif node.name == "BGP":
                # Identifiers or Paths
                # Negated path throws a type error. Probably n3() method of negated paths should be fixed
                triples = "".join(
                    triple[0].n3() + " " + triple[1].n3() + " " + triple[2].n3() + "."
                    for triple in node.triples
                )
                self._replace("{BGP}", triples)
                # The dummy -*-SELECT-*- is placed during a SelectQuery or Multiset pattern in order to be able
                # to match extended variables in a specific Select-clause (see "Extend" below)
                self._replace("-*-SELECT-*-", "SELECT", count=-1)
                # If there is no "Group By" clause the placeholder will simply be deleted. Otherwise there will be
                # no matching {GroupBy} placeholder because it has already been replaced by "group by variables"
                self._replace("{GroupBy}", "", count=-1)
                self._replace("{Having}", "", count=-1)
            elif node.name == "Join":
                self._replace(
                    "{Join}", "{" + node.p1.name + "}{" + node.p2.name + "}"
                )  #
            elif node.name == "LeftJoin":
                self._replace(
                    "{LeftJoin}",
                    "{" + node.p1.name + "}OPTIONAL{{" + node.p2.name + "}}",
                )
            elif node.name == "Filter":
                if isinstance(node.expr, CompValue):
                    expr = node.expr.name
                else:
                    raise ExpressionNotCoveredException(
                        "This expression might not be covered yet."
                    )
                if node.p:
                    # Filter with p=AggregateJoin = Having
                    if node.p.name == "AggregateJoin":
                        self._replace("{Filter}", "{" + node.p.name + "}")
                        self._replace("{Having}", "HAVING({" + expr + "})")
                    else:
                        self._replace(
                            "{Filter}", "FILTER({" + expr + "}) {" + node.p.name + "}"
                        )
                else:
                    self._replace("{Filter}", "FILTER({" + expr + "})")

            elif node.name == "Union":
                self._replace(
                    "{Union}", "{{" + node.p1.name + "}}UNION{{" + node.p2.name + "}}"
                )
            elif node.name == "Graph":
                expr = "GRAPH " + node.term.n3() + " {{" + node.p.name + "}}"
                self._replace("{Graph}", expr)
            elif node.name == "Extend":
                query_string = self._alg_translation.lower()
                select_occurrences = query_string.count("-*-select-*-")
                self._replace(
                    node.var.n3(),
                    "("
                    + self.convert_node_arg(node.expr)
                    + " as "
                    + node.var.n3()
                    + ")",
                    search_from_match="-*-select-*-",
                    search_from_match_occurrence=select_occurrences,
                )
                self._replace("{Extend}", "{" + node.p.name + "}")
            elif node.name == "Minus":
                expr = "{" + node.p1.name + "}MINUS{{" + node.p2.name + "}}"
                self._replace("{Minus}", expr)
            elif node.name == "Group":
                group_by_vars = []
                if node.expr:
                    for var in node.expr:
                        if isinstance(var, Identifier):
                            group_by_vars.append(var.n3())
                        else:
                            raise ExpressionNotCoveredException(
                                "This expression might not be covered yet."
                            )
                    self._replace("{Group}", "{" + node.p.name + "}")
                    self._replace(
                        "{GroupBy}", "GROUP BY " + " ".join(group_by_vars) + " "
                    )
                else:
                    self._replace("{Group}", "{" + node.p.name + "}")
            elif node.name == "AggregateJoin":
                self._replace("{AggregateJoin}", "{" + node.p.name + "}")
                for agg_func in node.A:
                    if isinstance(agg_func.res, Identifier):
                        identifier = agg_func.res.n3()
                    else:
                        raise ExpressionNotCoveredException(
                            "This expression might not be covered yet."
                        )
                    self.aggr_vars[agg_func.res].append(agg_func.vars)

                    agg_func_name = agg_func.name.split("_")[1]
                    distinct = ""
                    if agg_func.distinct:
                        distinct = agg_func.distinct + " "
                    if agg_func_name == "GroupConcat":
                        self._replace(
                            identifier,
                            "GROUP_CONCAT"
                            + "("
                            + distinct
                            + agg_func.vars.n3()
                            + ";SEPARATOR="
                            + agg_func.separator.n3()
                            + ")",
                        )
                    else:
                        self._replace(
                            identifier,
                            agg_func_name.upper()
                            + "("
                            + distinct
                            + self.convert_node_arg(agg_func.vars)
                            + ")",
                        )
                    # For non-aggregated variables the aggregation function "sample" is automatically assigned.
                    # However, we do not want to have "sample" wrapped around non-aggregated variables. That is
                    # why we replace it. If "sample" is used on purpose it will not be replaced as the alias
                    # must be different from the variable in this case.
                    self._replace(
                        "(SAMPLE({0}) as {0})".format(
                            self.convert_node_arg(agg_func.vars)
                        ),
                        self.convert_node_arg(agg_func.vars),
                    )
            elif node.name == "GroupGraphPatternSub":
                self._replace(
                    "GroupGraphPatternSub",
                    " ".join([self.convert_node_arg(pattern) for pattern in node.part]),
                )
            elif node.name == "TriplesBlock":
                self._replace(
                    "{TriplesBlock}",
                    "".join(
                        triple[0].n3()
                        + " "
                        + triple[1].n3()
                        + " "
                        + triple[2].n3()
                        + "."
                        for triple in node.triples
                    ),
                )

            # 18.2 Solution modifiers
            elif node.name == "ToList":
                raise ExpressionNotCoveredException(
                    "This expression might not be covered yet."
                )
            elif node.name == "OrderBy":
                order_conditions = []
                for c in node.expr:
                    if isinstance(c.expr, Identifier):
                        var = c.expr.n3()
                        if c.order is not None:
                            cond = c.order + "(" + var + ")"
                        else:
                            cond = var
                        order_conditions.append(cond)
                    else:
                        raise ExpressionNotCoveredException(
                            "This expression might not be covered yet."
                        )
                self._replace("{OrderBy}", "{" + node.p.name + "}")
                self._replace("{OrderConditions}", " ".join(order_conditions) + " ")
            elif node.name == "Project":
                project_variables = []
                for var in node.PV:
                    if isinstance(var, Identifier):
                        project_variables.append(var.n3())
                    else:
                        raise ExpressionNotCoveredException(
                            "This expression might not be covered yet."
                        )
                order_by_pattern = ""
                if node.p.name == "OrderBy":
                    order_by_pattern = "ORDER BY {OrderConditions}"
                self._replace(
                    "{Project}",
                    " ".join(project_variables)
                    + "{{"
                    + node.p.name
                    + "}}"
                    + "{GroupBy}"
                    + order_by_pattern
                    + "{Having}",
                )
            elif node.name == "Distinct":
                self._replace("{Distinct}", "DISTINCT {" + node.p.name + "}")
            elif node.name == "Reduced":
                self._replace("{Reduced}", "REDUCED {" + node.p.name + "}")
            elif node.name == "Slice":
                slice = "OFFSET " + str(node.start) + " LIMIT " + str(node.length)
                self._replace("{Slice}", "{" + node.p.name + "}" + slice)
            elif node.name == "ToMultiSet":
                if node.p.name == "values":
                    self._replace("{ToMultiSet}", "{{" + node.p.name + "}}")
                else:
                    self._replace(
                        "{ToMultiSet}", "{-*-SELECT-*- " + "{" + node.p.name + "}" + "}"
                    )

            # 18.2 Property Path

            # 17 Expressions and Testing Values
            # # 17.3 Operator Mapping
            elif node.name == "RelationalExpression":
                expr = self.convert_node_arg(node.expr)
                op = node.op
                if isinstance(list, type(node.other)):
                    other = (
                        "("
                        + ", ".join(self.convert_node_arg(expr) for expr in node.other)
                        + ")"
                    )
                else:
                    other = self.convert_node_arg(node.other)
                condition = "{left} {operator} {right}".format(
                    left=expr, operator=op, right=other
                )
                self._replace("{RelationalExpression}", condition)
            elif node.name == "ConditionalAndExpression":
                inner_nodes = " && ".join(
                    [self.convert_node_arg(expr) for expr in node.other]
                )
                self._replace(
                    "{ConditionalAndExpression}",
                    self.convert_node_arg(node.expr) + " && " + inner_nodes,
                )
            elif node.name == "ConditionalOrExpression":
                inner_nodes = " || ".join(
                    [self.convert_node_arg(expr) for expr in node.other]
                )
                self._replace(
                    "{ConditionalOrExpression}",
                    "(" + self.convert_node_arg(node.expr) + " || " + inner_nodes + ")",
                )
            elif node.name == "MultiplicativeExpression":
                left_side = self.convert_node_arg(node.expr)
                multiplication = left_side
                for i, operator in enumerate(node.op):
                    multiplication += (
                        operator + " " + self.convert_node_arg(node.other[i]) + " "
                    )
                self._replace("{MultiplicativeExpression}", multiplication)
            elif node.name == "AdditiveExpression":
                left_side = self.convert_node_arg(node.expr)
                addition = left_side
                for i, operator in enumerate(node.op):
                    addition += (
                        operator + " " + self.convert_node_arg(node.other[i]) + " "
                    )
                self._replace("{AdditiveExpression}", addition)
            elif node.name == "UnaryNot":
                self._replace("{UnaryNot}", "!" + self.convert_node_arg(node.expr))

            # # 17.4 Function Definitions
            # # # 17.4.1 Functional Forms
            elif node.name.endswith("BOUND"):
                bound_var = self.convert_node_arg(node.arg)
                self._replace("{Builtin_BOUND}", "bound(" + bound_var + ")")
            elif node.name.endswith("IF"):
                arg2 = self.convert_node_arg(node.arg2)
                arg3 = self.convert_node_arg(node.arg3)

                if_expression = (
                    "IF(" + "{" + node.arg1.name + "}, " + arg2 + ", " + arg3 + ")"
                )
                self._replace("{Builtin_IF}", if_expression)
            elif node.name.endswith("COALESCE"):
                self._replace(
                    "{Builtin_COALESCE}",
                    "COALESCE("
                    + ", ".join(self.convert_node_arg(arg) for arg in node.arg)
                    + ")",
                )
            elif node.name.endswith("Builtin_EXISTS"):
                # The node's name which we get with node.graph.name returns "Join" instead of GroupGraphPatternSub
                # According to https://www.w3.org/TR/2013/REC-sparql11-query-20130321/#rExistsFunc
                # ExistsFunc can only have a GroupGraphPattern as parameter. However, when we print the query algebra
                # we get a GroupGraphPatternSub
                self._replace(
                    "{Builtin_EXISTS}", "EXISTS " + "{{" + node.graph.name + "}}"
                )
                traverse(node.graph, visitPre=self.sparql_query_text)
                return node.graph
            elif node.name.endswith("Builtin_NOTEXISTS"):
                # The node's name which we get with node.graph.name returns "Join" instead of GroupGraphPatternSub
                # According to https://www.w3.org/TR/2013/REC-sparql11-query-20130321/#rNotExistsFunc
                # NotExistsFunc can only have a GroupGraphPattern as parameter. However, when we print the query algebra
                # we get a GroupGraphPatternSub
                self._replace(
                    "{Builtin_NOTEXISTS}", "NOT EXISTS " + "{{" + node.graph.name + "}}"
                )
                traverse(node.graph, visitPre=self.sparql_query_text)
                return node.graph
            # # # # 17.4.1.5 logical-or: Covered in "RelationalExpression"
            # # # # 17.4.1.6 logical-and: Covered in "RelationalExpression"
            # # # # 17.4.1.7 RDFterm-equal: Covered in "RelationalExpression"
            elif node.name.endswith("sameTerm"):
                self._replace(
                    "{Builtin_sameTerm}",
                    "SAMETERM("
                    + self.convert_node_arg(node.arg1)
                    + ", "
                    + self.convert_node_arg(node.arg2)
                    + ")",
                )
            # # # # IN: Covered in "RelationalExpression"
            # # # # NOT IN: Covered in "RelationalExpression"

            # # # 17.4.2 Functions on RDF Terms
            elif node.name.endswith("Builtin_isIRI"):
                self._replace(
                    "{Builtin_isIRI}", "isIRI(" + self.convert_node_arg(node.arg) + ")"
                )
            elif node.name.endswith("Builtin_isBLANK"):
                self._replace(
                    "{Builtin_isBLANK}",
                    "isBLANK(" + self.convert_node_arg(node.arg) + ")",
                )
            elif node.name.endswith("Builtin_isLITERAL"):
                self._replace(
                    "{Builtin_isLITERAL}",
                    "isLITERAL(" + self.convert_node_arg(node.arg) + ")",
                )
            elif node.name.endswith("Builtin_isNUMERIC"):
                self._replace(
                    "{Builtin_isNUMERIC}",
                    "isNUMERIC(" + self.convert_node_arg(node.arg) + ")",
                )
            elif node.name.endswith("Builtin_STR"):
                self._replace(
                    "{Builtin_STR}", "STR(" + self.convert_node_arg(node.arg) + ")"
                )
            elif node.name.endswith("Builtin_LANG"):
                self._replace(
                    "{Builtin_LANG}", "LANG(" + self.convert_node_arg(node.arg) + ")"
                )
            elif node.name.endswith("Builtin_DATATYPE"):
                self._replace(
                    "{Builtin_DATATYPE}",
                    "DATATYPE(" + self.convert_node_arg(node.arg) + ")",
                )
            elif node.name.endswith("Builtin_IRI"):
                self._replace(
                    "{Builtin_IRI}", "IRI(" + self.convert_node_arg(node.arg) + ")"
                )
            elif node.name.endswith("Builtin_BNODE"):
                self._replace(
                    "{Builtin_BNODE}", "BNODE(" + self.convert_node_arg(node.arg) + ")"
                )
            elif node.name.endswith("STRDT"):
                self._replace(
                    "{Builtin_STRDT}",
                    "STRDT("
                    + self.convert_node_arg(node.arg1)
                    + ", "
                    + self.convert_node_arg(node.arg2)
                    + ")",
                )
            elif node.name.endswith("Builtin_STRLANG"):
                self._replace(
                    "{Builtin_STRLANG}",
                    "STRLANG("
                    + self.convert_node_arg(node.arg1)
                    + ", "
                    + self.convert_node_arg(node.arg2)
                    + ")",
                )
            elif node.name.endswith("Builtin_UUID"):
                self._replace("{Builtin_UUID}", "UUID()")
            elif node.name.endswith("Builtin_STRUUID"):
                self._replace("{Builtin_STRUUID}", "STRUUID()")

            # # # 17.4.3 Functions on Strings
            elif node.name.endswith("Builtin_STRLEN"):
                self._replace(
                    "{Builtin_STRLEN}",
                    "STRLEN(" + self.convert_node_arg(node.arg) + ")",
                )
            elif node.name.endswith("Builtin_SUBSTR"):
                args = [self.convert_node_arg(node.arg), node.start]
                if node.length:
                    args.append(node.length)
                expr = "SUBSTR(" + ", ".join(args) + ")"
                self._replace("{Builtin_SUBSTR}", expr)
            elif node.name.endswith("Builtin_UCASE"):
                self._replace(
                    "{Builtin_UCASE}", "UCASE(" + self.convert_node_arg(node.arg) + ")"
                )
            elif node.name.endswith("Builtin_LCASE"):
                self._replace(
                    "{Builtin_LCASE}", "LCASE(" + self.convert_node_arg(node.arg) + ")"
                )
            elif node.name.endswith("Builtin_STRSTARTS"):
                self._replace(
                    "{Builtin_STRSTARTS}",
                    "STRSTARTS("
                    + self.convert_node_arg(node.arg1)
                    + ", "
                    + self.convert_node_arg(node.arg2)
                    + ")",
                )
            elif node.name.endswith("Builtin_STRENDS"):
                self._replace(
                    "{Builtin_STRENDS}",
                    "STRENDS("
                    + self.convert_node_arg(node.arg1)
                    + ", "
                    + self.convert_node_arg(node.arg2)
                    + ")",
                )
            elif node.name.endswith("Builtin_CONTAINS"):
                self._replace(
                    "{Builtin_CONTAINS}",
                    "CONTAINS("
                    + self.convert_node_arg(node.arg1)
                    + ", "
                    + self.convert_node_arg(node.arg2)
                    + ")",
                )
            elif node.name.endswith("Builtin_STRBEFORE"):
                self._replace(
                    "{Builtin_STRBEFORE}",
                    "STRBEFORE("
                    + self.convert_node_arg(node.arg1)
                    + ", "
                    + self.convert_node_arg(node.arg2)
                    + ")",
                )
            elif node.name.endswith("Builtin_STRAFTER"):
                self._replace(
                    "{Builtin_STRAFTER}",
                    "STRAFTER("
                    + self.convert_node_arg(node.arg1)
                    + ", "
                    + self.convert_node_arg(node.arg2)
                    + ")",
                )
            elif node.name.endswith("Builtin_ENCODE_FOR_URI"):
                self._replace(
                    "{Builtin_ENCODE_FOR_URI}",
                    "ENCODE_FOR_URI(" + self.convert_node_arg(node.arg) + ")",
                )
            elif node.name.endswith("Builtin_CONCAT"):
                expr = "CONCAT({vars})".format(
                    vars=", ".join(self.convert_node_arg(elem) for elem in node.arg)
                )
                self._replace("{Builtin_CONCAT}", expr)
            elif node.name.endswith("Builtin_LANGMATCHES"):
                self._replace(
                    "{Builtin_LANGMATCHES}",
                    "LANGMATCHES("
                    + self.convert_node_arg(node.arg1)
                    + ", "
                    + self.convert_node_arg(node.arg2)
                    + ")",
                )
            elif node.name.endswith("REGEX"):
                args = [
                    self.convert_node_arg(node.text),
                    self.convert_node_arg(node.pattern),
                ]
                expr = "REGEX(" + ", ".join(args) + ")"
                self._replace("{Builtin_REGEX}", expr)
            elif node.name.endswith("REPLACE"):
                self._replace(
                    "{Builtin_REPLACE}",
                    "REPLACE("
                    + self.convert_node_arg(node.arg)
                    + ", "
                    + self.convert_node_arg(node.pattern)
                    + ", "
                    + self.convert_node_arg(node.replacement)
                    + ")",
                )

            # # # 17.4.4 Functions on Numerics
            elif node.name == "Builtin_ABS":
                self._replace(
                    "{Builtin_ABS}", "ABS(" + self.convert_node_arg(node.arg) + ")"
                )
            elif node.name == "Builtin_ROUND":
                self._replace(
                    "{Builtin_ROUND}", "ROUND(" + self.convert_node_arg(node.arg) + ")"
                )
            elif node.name == "Builtin_CEIL":
                self._replace(
                    "{Builtin_CEIL}", "CEIL(" + self.convert_node_arg(node.arg) + ")"
                )
            elif node.name == "Builtin_FLOOR":
                self._replace(
                    "{Builtin_FLOOR}", "FLOOR(" + self.convert_node_arg(node.arg) + ")"
                )
            elif node.name == "Builtin_RAND":
                self._replace("{Builtin_RAND}", "RAND()")

            # # # 17.4.5 Functions on Dates and Times
            elif node.name == "Builtin_NOW":
                self._replace("{Builtin_NOW}", "NOW()")
            elif node.name == "Builtin_YEAR":
                self._replace(
                    "{Builtin_YEAR}", "YEAR(" + self.convert_node_arg(node.arg) + ")"
                )
            elif node.name == "Builtin_MONTH":
                self._replace(
                    "{Builtin_MONTH}", "MONTH(" + self.convert_node_arg(node.arg) + ")"
                )
            elif node.name == "Builtin_DAY":
                self._replace(
                    "{Builtin_DAY}", "DAY(" + self.convert_node_arg(node.arg) + ")"
                )
            elif node.name == "Builtin_HOURS":
                self._replace(
                    "{Builtin_HOURS}", "HOURS(" + self.convert_node_arg(node.arg) + ")"
                )
            elif node.name == "Builtin_MINUTES":
                self._replace(
                    "{Builtin_MINUTES}",
                    "MINUTES(" + self.convert_node_arg(node.arg) + ")",
                )
            elif node.name == "Builtin_SECONDS":
                self._replace(
                    "{Builtin_SECONDS}",
                    "SECONDS(" + self.convert_node_arg(node.arg) + ")",
                )
            elif node.name == "Builtin_TIMEZONE":
                self._replace(
                    "{Builtin_TIMEZONE}",
                    "TIMEZONE(" + self.convert_node_arg(node.arg) + ")",
                )
            elif node.name == "Builtin_TZ":
                self._replace(
                    "{Builtin_TZ}", "TZ(" + self.convert_node_arg(node.arg) + ")"
                )

            # # # 17.4.6 Hash functions
            elif node.name == "Builtin_MD5":
                self._replace(
                    "{Builtin_MD5}", "MD5(" + self.convert_node_arg(node.arg) + ")"
                )
            elif node.name == "Builtin_SHA1":
                self._replace(
                    "{Builtin_SHA1}", "SHA1(" + self.convert_node_arg(node.arg) + ")"
                )
            elif node.name == "Builtin_SHA256":
                self._replace(
                    "{Builtin_SHA256}",
                    "SHA256(" + self.convert_node_arg(node.arg) + ")",
                )
            elif node.name == "Builtin_SHA384":
                self._replace(
                    "{Builtin_SHA384}",
                    "SHA384(" + self.convert_node_arg(node.arg) + ")",
                )
            elif node.name == "Builtin_SHA512":
                self._replace(
                    "{Builtin_SHA512}",
                    "SHA512(" + self.convert_node_arg(node.arg) + ")",
                )

            # Other
            elif node.name == "values":
                columns = []
                for key in node.res[0].keys():
                    if isinstance(key, Identifier):
                        columns.append(key.n3())
                    else:
                        raise ExpressionNotCoveredException(
                            "The expression {0} might not be covered yet.".format(key)
                        )
                values = "VALUES (" + " ".join(columns) + ")"

                rows = ""
                for elem in node.res:
                    row = []
                    for term in elem.values():
                        if isinstance(term, Identifier):
                            row.append(
                                term.n3()
                            )  # n3() is not part of Identifier class but every subclass has it
                        elif isinstance(term, str):
                            row.append(term)
                        else:
                            raise ExpressionNotCoveredException(
                                "The expression {0} might not be covered yet.".format(
                                    term
                                )
                            )
                    rows += "(" + " ".join(row) + ")"

                self._replace("values", values + "{" + rows + "}")
            elif node.name == "ServiceGraphPattern":
                self._replace(
                    "{ServiceGraphPattern}",
                    "SERVICE "
                    + self.convert_node_arg(node.term)
                    + "{"
                    + node.graph.name
                    + "}",
                )
                traverse(node.graph, visitPre=self.sparql_query_text)
                return node.graph
            # else:
            #     raise ExpressionNotCoveredException("The expression {0} might not be covered yet.".format(node.name))

    def translateAlgebra(self) -> str:
        traverse(self.query_algebra.algebra, visitPre=self.sparql_query_text)
        return self._alg_translation


def translateAlgebra(query_algebra: Query) -> str:
    """
    Translates a SPARQL 1.1 algebra tree into the corresponding query string.

    Args:
        query_algebra: An algebra returned by `translateQuery`.

    Returns:
        The query form generated from the SPARQL 1.1 algebra tree for
            SELECT queries.
    """
    query_from_algebra = _AlgebraTranslator(
        query_algebra=query_algebra
    ).translateAlgebra()
    return query_from_algebra


def pprintAlgebra(q) -> None:
    def pp(p, ind="    "):
        # if isinstance(p, list):
        #     print "[ "
        #     for x in p: pp(x,ind)
        #     print "%s ]"%ind
        #     return
        if not isinstance(p, CompValue):
            print(p)
            return
        print("%s(" % (p.name,))
        for k in p:
            print(
                "%s%s ="
                % (
                    ind,
                    k,
                ),
                end=" ",
            )
            pp(p[k], ind + "    ")
        print("%s)" % ind)

    try:
        pp(q.algebra)
    except AttributeError:
        # it's update, just a list
        for x in q:
            pp(x)
