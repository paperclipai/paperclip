from __future__ import annotations

import collections
from typing import (
    Any,
    DefaultDict,
    Generator,
    Iterable,
    Mapping,
    Set,
    Tuple,
    TypeVar,
    Union,
    overload,
)

from rdflib.plugins.sparql.operators import EBV
from rdflib.plugins.sparql.parserutils import CompValue, Expr
from rdflib.plugins.sparql.sparql import (
    FrozenBindings,
    FrozenDict,
    NotBoundError,
    QueryContext,
    SPARQLError,
)
from rdflib.term import BNode, Identifier, Literal, URIRef, Variable

_ContextType = Union[FrozenBindings, QueryContext]
_FrozenDictT = TypeVar("_FrozenDictT", bound=FrozenDict)


def _diff(
    a: Iterable[_FrozenDictT], b: Iterable[_FrozenDictT], expr
) -> Set[_FrozenDictT]:
    res = set()

    for x in a:
        if all(not x.compatible(y) or not _ebv(expr, x.merge(y)) for y in b):
            res.add(x)

    return res


def _minus(
    a: Iterable[_FrozenDictT], b: Iterable[_FrozenDictT]
) -> Generator[_FrozenDictT, None, None]:
    for x in a:
        if all((not x.compatible(y)) or x.disjointDomain(y) for y in b):
            yield x


@overload
def _join(
    a: Iterable[FrozenBindings], b: Iterable[Mapping[Identifier, Identifier]]
) -> Generator[FrozenBindings, None, None]: ...


@overload
def _join(
    a: Iterable[FrozenDict], b: Iterable[Mapping[Identifier, Identifier]]
) -> Generator[FrozenDict, None, None]: ...


def _join(
    a: Iterable[FrozenDict], b: Iterable[Mapping[Identifier, Identifier]]
) -> Generator[FrozenDict, None, None]:
    for x in a:
        for y in b:
            if x.compatible(y):
                yield x.merge(y)


def _ebv(expr: Union[Literal, Variable, Expr], ctx: FrozenDict) -> bool:
    """
    Return true/false for the given expr
    Either the expr is itself true/false
    or evaluates to something, with the given ctx

    an error is false
    """

    try:
        return EBV(expr)
    except SPARQLError:
        pass
    if isinstance(expr, Expr):
        try:
            return EBV(expr.eval(ctx))
        except SPARQLError:
            return False  # filter error == False
    # type error: Subclass of "Literal" and "CompValue" cannot exist: would have incompatible method signatures
    elif isinstance(expr, CompValue):  # type: ignore[unreachable]
        raise Exception("Weird - filter got a CompValue without evalfn! %r" % expr)
    elif isinstance(expr, Variable):
        try:
            return EBV(ctx[expr])
        except:  # noqa: E722
            return False
    return False


@overload
def _eval(
    expr: Union[Literal, URIRef],
    ctx: FrozenBindings,
    raise_not_bound_error: bool = ...,
) -> Union[Literal, URIRef]: ...


@overload
def _eval(
    expr: Union[Variable, Expr],
    ctx: FrozenBindings,
    raise_not_bound_error: bool = ...,
) -> Union[Any, SPARQLError]: ...


def _eval(
    expr: Union[Literal, URIRef, Variable, Expr],
    ctx: FrozenBindings,
    raise_not_bound_error: bool = True,
) -> Any:
    if isinstance(expr, (Literal, URIRef)):
        return expr
    if isinstance(expr, Expr):
        return expr.eval(ctx)
    elif isinstance(expr, Variable):
        try:
            return ctx[expr]
        except KeyError:
            if raise_not_bound_error:
                raise NotBoundError("Variable %s is not bound" % expr)
            else:
                return None
    elif isinstance(expr, CompValue):  # type: ignore[unreachable]
        raise Exception("Weird - _eval got a CompValue without evalfn! %r" % expr)
    else:
        raise Exception("Cannot eval thing: %s (%s)" % (expr, type(expr)))


def _filter(
    a: Iterable[FrozenDict], expr: Union[Literal, Variable, Expr]
) -> Generator[FrozenDict, None, None]:
    for c in a:
        if _ebv(expr, c):
            yield c


def _fillTemplate(
    template: Iterable[Tuple[Identifier, Identifier, Identifier]],
    solution: _ContextType,
) -> Generator[Tuple[Identifier, Identifier, Identifier], None, None]:
    """
    For construct/deleteWhere and friends

    Fill a triple template with instantiated variables
    """

    bnodeMap: DefaultDict[BNode, BNode] = collections.defaultdict(BNode)
    for t in template:
        s, p, o = t

        _s = solution.get(s)
        _p = solution.get(p)
        _o = solution.get(o)

        # instantiate new bnodes for each solution
        _s, _p, _o = [
            bnodeMap[x] if isinstance(x, BNode) else y for x, y in zip(t, (_s, _p, _o))
        ]

        if _s is not None and _p is not None and _o is not None:
            yield (_s, _p, _o)


_ValueT = TypeVar("_ValueT", Variable, BNode, URIRef, Literal)


def _val(v: _ValueT) -> Tuple[int, _ValueT]:
    """utilitity for ordering things"""
    if isinstance(v, Variable):
        return (0, v)
    elif isinstance(v, BNode):
        return (1, v)
    elif isinstance(v, URIRef):
        return (2, v)
    elif isinstance(v, Literal):
        return (3, v)
