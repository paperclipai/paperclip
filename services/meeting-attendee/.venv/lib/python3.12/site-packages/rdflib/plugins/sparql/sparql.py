from __future__ import annotations

import collections
import datetime
import itertools
import typing as t
from collections.abc import Mapping, MutableMapping
from typing import (
    TYPE_CHECKING,
    Any,
    Container,
    Dict,
    Generator,
    Iterable,
    List,
    Optional,
    Tuple,
    TypeVar,
    Union,
)

import rdflib.plugins.sparql
from rdflib.graph import ConjunctiveGraph, Dataset, Graph
from rdflib.namespace import NamespaceManager
from rdflib.plugins.sparql.parserutils import CompValue
from rdflib.term import BNode, Identifier, Literal, Node, URIRef, Variable

if TYPE_CHECKING:
    from rdflib.paths import Path


_AnyT = TypeVar("_AnyT")


class SPARQLError(Exception):
    def __init__(self, msg: Optional[str] = None):
        Exception.__init__(self, msg)


class NotBoundError(SPARQLError):
    def __init__(self, msg: Optional[str] = None):
        SPARQLError.__init__(self, msg)


class AlreadyBound(SPARQLError):  # noqa: N818
    """Raised when trying to bind a variable that is already bound!"""

    def __init__(self):
        SPARQLError.__init__(self)


class SPARQLTypeError(SPARQLError):
    def __init__(self, msg: Optional[str]):
        SPARQLError.__init__(self, msg)


class Bindings(MutableMapping):
    """

    A single level of a stack of variable-value bindings.
    Each dict keeps a reference to the dict below it,
    any failed lookup is propegated back

    In python 3.3 this could be a collections.ChainMap
    """

    def __init__(self, outer: Optional[Bindings] = None, d=[]):
        self._d: Dict[str, str] = dict(d)
        self.outer = outer

    def __getitem__(self, key: str) -> str:
        if key in self._d:
            return self._d[key]

        if not self.outer:
            raise KeyError()
        return self.outer[key]

    def __contains__(self, key: Any) -> bool:
        try:
            self[key]
            return True
        except KeyError:
            return False

    def __setitem__(self, key: str, value: Any) -> None:
        self._d[key] = value

    def __delitem__(self, key: str) -> None:
        raise Exception("DelItem is not implemented!")

    def __len__(self) -> int:
        i = 0
        d: Optional[Bindings] = self
        while d is not None:
            i += len(d._d)
            d = d.outer
        return i

    def __iter__(self) -> Generator[str, None, None]:
        d: Optional[Bindings] = self
        while d is not None:
            yield from d._d
            d = d.outer

    def __str__(self) -> str:
        # type error: Generator has incompatible item type "Tuple[Any, str]"; expected "str"
        return "Bindings({" + ", ".join((k, self[k]) for k in self) + "})"  # type: ignore[misc]

    def __repr__(self) -> str:
        return str(self)


class FrozenDict(Mapping):
    """
    An immutable hashable dict

    Taken from http://stackoverflow.com/a/2704866/81121

    """

    def __init__(self, *args: Any, **kwargs: Any):
        self._d: Dict[Identifier, Identifier] = dict(*args, **kwargs)
        self._hash: Optional[int] = None

    def __iter__(self):
        return iter(self._d)

    def __len__(self) -> int:
        return len(self._d)

    def __getitem__(self, key: Identifier) -> Identifier:
        return self._d[key]

    def __hash__(self) -> int:
        # It would have been simpler and maybe more obvious to
        # use hash(tuple(sorted(self._d.items()))) from this discussion
        # so far, but this solution is O(n). I don't know what kind of
        # n we are going to run into, but sometimes it's hard to resist the
        # urge to optimize when it will gain improved algorithmic performance.
        if self._hash is None:
            self._hash = 0
            for key, value in self.items():
                self._hash ^= hash(key)
                self._hash ^= hash(value)
        return self._hash

    def project(self, vars: Container[Variable]) -> FrozenDict:
        return FrozenDict(x for x in self.items() if x[0] in vars)

    def disjointDomain(self, other: t.Mapping[Identifier, Identifier]) -> bool:
        return not bool(set(self).intersection(other))

    def compatible(self, other: t.Mapping[Identifier, Identifier]) -> bool:
        for k in self:
            try:
                if self[k] != other[k]:
                    return False
            except KeyError:
                pass

        return True

    def merge(self, other: t.Mapping[Identifier, Identifier]) -> FrozenDict:
        res = FrozenDict(itertools.chain(self.items(), other.items()))

        return res

    def __str__(self) -> str:
        return str(self._d)

    def __repr__(self) -> str:
        return repr(self._d)


class FrozenBindings(FrozenDict):
    def __init__(self, ctx: QueryContext, *args, **kwargs):
        FrozenDict.__init__(self, *args, **kwargs)
        self.ctx = ctx

    def __getitem__(self, key: Union[Identifier, str]) -> Identifier:
        if not isinstance(key, Node):
            key = Variable(key)

        if not isinstance(key, (BNode, Variable)):
            return key

        if key not in self._d:
            # type error: Value of type "Optional[Dict[Variable, Identifier]]" is not indexable
            # type error: Invalid index type "Union[BNode, Variable]" for "Optional[Dict[Variable, Identifier]]"; expected type "Variable"
            return self.ctx.initBindings[key]  # type: ignore[index]
        else:
            return self._d[key]

    def project(self, vars: Container[Variable]) -> FrozenBindings:
        return FrozenBindings(self.ctx, (x for x in self.items() if x[0] in vars))

    def merge(self, other: t.Mapping[Identifier, Identifier]) -> FrozenBindings:
        res = FrozenBindings(self.ctx, itertools.chain(self.items(), other.items()))
        return res

    @property
    def now(self) -> datetime.datetime:
        return self.ctx.now

    @property
    def bnodes(self) -> t.Mapping[Identifier, BNode]:
        return self.ctx.bnodes

    @property
    def prologue(self) -> Optional[Prologue]:
        return self.ctx.prologue

    def forget(
        self, before: QueryContext, _except: Optional[Container[Variable]] = None
    ) -> FrozenBindings:
        """
        return a frozen dict only of bindings made in self
        since before
        """
        if not _except:
            _except = []

        # bindings from initBindings are newer forgotten
        return FrozenBindings(
            self.ctx,
            (
                x
                for x in self.items()
                if (
                    x[0] in _except
                    # type error: Unsupported right operand type for in ("Optional[Dict[Variable, Identifier]]")
                    or x[0] in self.ctx.initBindings  # type: ignore[operator]
                    or before[x[0]] is None
                )
            ),
        )

    def remember(self, these) -> FrozenBindings:
        """
        return a frozen dict only of bindings in these
        """
        return FrozenBindings(self.ctx, (x for x in self.items() if x[0] in these))


class QueryContext:
    """
    Query context - passed along when evaluating the query
    """

    def __init__(
        self,
        graph: Optional[Graph] = None,
        bindings: Optional[Union[Bindings, FrozenBindings, List[Any]]] = None,
        initBindings: Optional[Mapping[str, Identifier]] = None,
        datasetClause=None,
    ):
        self.initBindings = initBindings
        self.bindings = Bindings(d=bindings or [])
        if initBindings:
            self.bindings.update(initBindings)

        self.graph: Optional[Graph]
        self._dataset: Optional[Union[Dataset, ConjunctiveGraph]]
        if isinstance(graph, (Dataset, ConjunctiveGraph)):
            if datasetClause:
                self._dataset = Dataset()
                self.graph = Graph()
                for d in datasetClause:
                    if d.default:
                        from_graph = graph.get_context(d.default)
                        self.graph += from_graph
                        if not from_graph:
                            self.load(d.default, default=True)
                    elif d.named:
                        namedGraphs = Graph(
                            store=self.dataset.store, identifier=d.named
                        )
                        from_named_graphs = graph.get_context(d.named)
                        namedGraphs += from_named_graphs
                        if not from_named_graphs:
                            self.load(d.named, default=False)
            else:
                self._dataset = graph
                if rdflib.plugins.sparql.SPARQL_DEFAULT_GRAPH_UNION:
                    self.graph = self.dataset
                else:
                    self.graph = self.dataset.default_context
        else:
            self._dataset = None
            self.graph = graph

        self.prologue: Optional[Prologue] = None
        self._now: Optional[datetime.datetime] = None

        self.bnodes: t.MutableMapping[Identifier, BNode] = collections.defaultdict(
            BNode
        )

    @property
    def now(self) -> datetime.datetime:
        if self._now is None:
            self._now = datetime.datetime.now(datetime.timezone.utc)
        return self._now

    def clone(
        self, bindings: Optional[Union[FrozenBindings, Bindings, List[Any]]] = None
    ) -> QueryContext:
        r = QueryContext(
            self._dataset if self._dataset is not None else self.graph,
            bindings or self.bindings,
            initBindings=self.initBindings,
        )
        r.prologue = self.prologue
        r.graph = self.graph
        r.bnodes = self.bnodes
        return r

    @property
    def dataset(self) -> ConjunctiveGraph:
        """ "current dataset"""
        if self._dataset is None:
            raise Exception(
                "You performed a query operation requiring "
                + "a dataset (i.e. ConjunctiveGraph), but "
                + "operating currently on a single graph."
            )
        return self._dataset

    def load(
        self,
        source: URIRef,
        default: bool = False,
        into: Optional[Identifier] = None,
        **kwargs: Any,
    ) -> None:
        """
        Load data from the source into the query context's.

        Args:
            source: The source to load from.
            default: If `True`, triples from the source will be added
                to the default graph, otherwise it will be loaded into a
                graph with `source` URI as its name.
            into: The name of the graph to load the data into. If
                `None`, the source URI will be used as as the name of the
                graph.
            **kwargs: Keyword arguments to pass to
                [`parse`][rdflib.graph.Graph.parse].
        """

        def _load(graph, source):
            try:
                return graph.parse(source, format="turtle", **kwargs)
            except Exception:
                pass
            try:
                return graph.parse(source, format="xml", **kwargs)
            except Exception:
                pass
            try:
                return graph.parse(source, format="n3", **kwargs)
            except Exception:
                pass
            try:
                return graph.parse(source, format="nt", **kwargs)
            except Exception:
                raise Exception(
                    "Could not load %s as either RDF/XML, N3 or NTriples" % source
                )

        if not rdflib.plugins.sparql.SPARQL_LOAD_GRAPHS:
            # we are not loading - if we already know the graph
            # being "loaded", just add it to the default-graph
            if default:
                # Unsupported left operand type for + ("None")
                self.graph += self.dataset.get_context(source)  # type: ignore[operator]
        else:
            if default:
                _load(self.graph, source)
            else:
                if into is None:
                    into = source
                _load(self.dataset.get_context(into), source)

    def __getitem__(self, key: Union[str, Path]) -> Optional[Union[str, Path]]:
        # in SPARQL BNodes are just labels
        if not isinstance(key, (BNode, Variable)):
            return key
        try:
            return self.bindings[key]
        except KeyError:
            return None

    def get(self, key: str, default: Optional[Any] = None) -> Any:
        try:
            return self[key]
        except KeyError:
            return default

    def solution(self, vars: Optional[Iterable[Variable]] = None) -> FrozenBindings:
        """
        Return a static copy of the current variable bindings as dict
        """
        if vars:
            return FrozenBindings(
                self, ((k, v) for k, v in self.bindings.items() if k in vars)
            )
        else:
            return FrozenBindings(self, self.bindings.items())

    def __setitem__(self, key: str, value: str) -> None:
        if key in self.bindings and self.bindings[key] != value:
            raise AlreadyBound()

        self.bindings[key] = value

    def pushGraph(self, graph: Optional[Graph]) -> QueryContext:
        r = self.clone()
        r.graph = graph
        return r

    def push(self) -> QueryContext:
        r = self.clone(Bindings(self.bindings))
        return r

    def clean(self) -> QueryContext:
        return self.clone([])

    def thaw(self, frozenbindings: FrozenBindings) -> QueryContext:
        """
        Create a new read/write query context from the given solution
        """
        c = self.clone(frozenbindings)

        return c


class Prologue:
    """
    A class for holding prefixing bindings and base URI information
    """

    def __init__(self) -> None:
        self.base: Optional[str] = None
        self.namespace_manager = NamespaceManager(Graph())  # ns man needs a store

    def resolvePName(self, prefix: Optional[str], localname: Optional[str]) -> URIRef:
        ns = self.namespace_manager.store.namespace(prefix or "")
        if ns is None:
            raise Exception("Unknown namespace prefix : %s" % prefix)
        return URIRef(ns + (localname or ""))

    def bind(self, prefix: Optional[str], uri: Any) -> None:
        self.namespace_manager.bind(prefix, uri, replace=True)

    def absolutize(
        self, iri: Optional[Union[CompValue, str]]
    ) -> Optional[Union[CompValue, str]]:
        """
        Apply BASE / PREFIXes to URIs
        (and to datatypes in Literals)

        TODO: Move resolving URIs to pre-processing
        """

        if isinstance(iri, CompValue):
            if iri.name == "pname":
                return self.resolvePName(iri.prefix, iri.localname)
            if iri.name == "literal":
                # type error: Argument "datatype" to "Literal" has incompatible type "Union[CompValue, Identifier, None]"; expected "Optional[str]"
                return Literal(
                    iri.string, lang=iri.lang, datatype=self.absolutize(iri.datatype)  # type: ignore[arg-type]
                )
        elif isinstance(iri, URIRef) and not ":" in iri:  # noqa: E713
            return URIRef(iri, base=self.base)

        return iri


class Query:
    """
    A parsed and translated query
    """

    def __init__(self, prologue: Prologue, algebra: CompValue):
        self.prologue = prologue
        self.algebra = algebra
        self._original_args: Tuple[str, Mapping[str, str], Optional[str]]


class Update:
    """
    A parsed and translated update
    """

    def __init__(self, prologue: Prologue, algebra: List[CompValue]):
        self.prologue = prologue
        self.algebra = algebra
        self._original_args: Tuple[str, Mapping[str, str], Optional[str]]
