"""## Types of store

`Context-aware`: An RDF store capable of storing statements within contexts
is considered context-aware. Essentially, such a store is able to partition
the RDF model it represents into individual, named, and addressable
sub-graphs.

Relevant Notation3 reference regarding formulae, quoted statements, and such:
http://www.w3.org/DesignIssues/Notation3.html

`Formula-aware`: An RDF store capable of distinguishing between statements
that are asserted and statements that are quoted is considered formula-aware.

`Transaction-capable`: capable of providing transactional integrity to the
RDF operations performed on it.

`Graph-aware`: capable of keeping track of empty graphs.
"""

from __future__ import annotations

import pickle
from io import BytesIO
from typing import (
    TYPE_CHECKING,
    Any,
    Dict,
    Generator,
    Iterable,
    Iterator,
    Mapping,
    Optional,
    Tuple,
    Union,
)

from rdflib.events import Dispatcher, Event

if TYPE_CHECKING:
    from rdflib.graph import (
        Graph,
        _ContextType,
        _QuadType,
        _TripleChoiceType,
        _TriplePatternType,
        _TripleType,
    )
    from rdflib.plugins.sparql.sparql import Query, Update
    from rdflib.query import Result
    from rdflib.term import Identifier, Node, URIRef


# Constants representing the state of a Store (returned by the open method)
VALID_STORE = 1
CORRUPTED_STORE = 0
NO_STORE = -1
UNKNOWN: None = None


Pickler = pickle.Pickler
Unpickler = pickle.Unpickler
UnpicklingError = pickle.UnpicklingError

__all__ = [
    "StoreCreatedEvent",
    "TripleAddedEvent",
    "TripleRemovedEvent",
    "NodePickler",
    "Store",
]


class StoreCreatedEvent(Event):
    """This event is fired when the Store is created.

    Attributes:
        configuration: String used to create the store
    """


class TripleAddedEvent(Event):
    """This event is fired when a triple is added.

    Attributes:
        triple: The triple added to the graph.
        context: The context of the triple, if any.
        graph: The graph to which the triple was added.
    """


class TripleRemovedEvent(Event):
    """This event is fired when a triple is removed.

    Attributes:
        triple: The triple removed from the graph.
        context: The context of the triple, if any.
        graph: The graph from which the triple was removed.
    """


class NodePickler:
    def __init__(self) -> None:
        self._objects: Dict[str, Any] = {}
        self._ids: Dict[Any, str] = {}
        self._get_object = self._objects.__getitem__

    def _get_ids(self, key: Any) -> Optional[str]:
        try:
            return self._ids.get(key)
        except TypeError:
            return None

    def register(self, object: Any, id: str) -> None:
        self._objects[id] = object
        self._ids[object] = id

    def loads(self, s: bytes) -> Node:
        up = Unpickler(BytesIO(s))
        # NOTE on type error: https://github.com/python/mypy/issues/2427
        # type error: Cannot assign to a method
        up.persistent_load = self._get_object  # type: ignore[assignment]
        try:
            return up.load()
        except KeyError as e:
            raise UnpicklingError("Could not find Node class for %s" % e)

    def dumps(
        self, obj: Node, protocol: Optional[Any] = None, bin: Optional[Any] = None
    ):
        src = BytesIO()
        p = Pickler(src)
        # NOTE on type error: https://github.com/python/mypy/issues/2427
        # type error: Cannot assign to a method
        p.persistent_id = self._get_ids  # type: ignore[assignment]
        p.dump(obj)
        return src.getvalue()

    def __getstate__(self) -> Mapping[str, Any]:
        state = self.__dict__.copy()
        del state["_get_object"]
        state.update(
            {"_ids": tuple(self._ids.items()), "_objects": tuple(self._objects.items())}
        )
        return state

    def __setstate__(self, state: Mapping[str, Any]) -> None:
        self.__dict__.update(state)
        self._ids = dict(self._ids)
        self._objects = dict(self._objects)
        self._get_object = self._objects.__getitem__


class Store:
    # Properties
    context_aware: bool = False
    formula_aware: bool = False
    transaction_aware: bool = False
    graph_aware: bool = False

    def __init__(
        self,
        configuration: Optional[str] = None,
        identifier: Optional[Identifier] = None,
    ):
        """Initialize the Store.

        Args:
            identifier: URIRef of the Store. Defaults to CWD
            configuration: String containing information open can use to
                connect to datastore.
        """
        self.__node_pickler: Optional[NodePickler] = None
        self.dispatcher = Dispatcher()
        if configuration:
            self.open(configuration)

    @property
    def node_pickler(self) -> NodePickler:
        if self.__node_pickler is None:
            from rdflib.graph import Graph, QuotedGraph
            from rdflib.term import BNode, Literal, URIRef, Variable

            self.__node_pickler = np = NodePickler()
            np.register(self, "S")
            np.register(URIRef, "U")
            np.register(BNode, "B")
            np.register(Literal, "L")
            np.register(Graph, "G")
            np.register(QuotedGraph, "Q")
            np.register(Variable, "V")
        return self.__node_pickler

    # Database management methods
    # NOTE: Can't find any stores using this, we should consider deprecating it.
    def create(self, configuration: str) -> None:
        self.dispatcher.dispatch(StoreCreatedEvent(configuration=configuration))

    def open(
        self, configuration: Union[str, tuple[str, str]], create: bool = False
    ) -> Optional[int]:
        """Opens the store specified by the configuration string.

        Args:
            configuration: Store configuration string
            create: If True, a store will be created if it doesn't exist.
                If False and the store doesn't exist, an exception is raised.

        Returns:
            One of: VALID_STORE, CORRUPTED_STORE, or NO_STORE

        Raises:
            Exception: If there are insufficient permissions to open the store.
        """
        return UNKNOWN

    def close(self, commit_pending_transaction: bool = False) -> None:
        """Closes the database connection.

        Args:
            commit_pending_transaction: Whether to commit all pending
                transactions before closing (if the store is transactional).
        """

    def destroy(self, configuration: str) -> None:
        """Destroys the instance of the store.

        Args:
            configuration: The configuration string identifying the store instance.
        """

    def gc(self) -> None:
        """Allows the store to perform any needed garbage collection."""
        pass

    # RDF APIs
    def add(
        self,
        triple: _TripleType,
        context: _ContextType,
        quoted: bool = False,
    ) -> None:
        """Adds the given statement to a specific context or to the model.

        Args:
            triple: The triple to add
            context: The context to add the triple to
            quoted: If True, indicates this statement is quoted/hypothetical
                (for formula-aware stores)

        Note:
            It should be an error to not specify a context and have the quoted
            argument be True. It should also be an error for the quoted argument
            to be True when the store is not formula-aware.
        """
        self.dispatcher.dispatch(TripleAddedEvent(triple=triple, context=context))

    def addN(self, quads: Iterable[_QuadType]) -> None:  # noqa: N802
        """Adds each item in the list of statements to a specific context.

        The quoted argument is interpreted by formula-aware stores to indicate this
        statement is quoted/hypothetical.

        Note:
            The default implementation is a redirect to add.

        Args:
            quads: An iterable of quads to add
        """
        for s, p, o, c in quads:
            assert c is not None, "Context associated with %s %s %s is None!" % (
                s,
                p,
                o,
            )
            self.add((s, p, o), c)

    def remove(
        self,
        triple: _TriplePatternType,
        context: Optional[_ContextType] = None,
    ) -> None:
        """Remove the set of triples matching the pattern from the store"""
        self.dispatcher.dispatch(TripleRemovedEvent(triple=triple, context=context))

    def triples_choices(
        self,
        triple: _TripleChoiceType,
        context: Optional[_ContextType] = None,
    ) -> Generator[
        Tuple[
            _TripleType,
            Iterator[Optional[_ContextType]],
        ],
        None,
        None,
    ]:
        """
        A variant of triples that can take a list of terms instead of a single
        term in any slot.  Stores can implement this to optimize the response
        time from the default 'fallback' implementation, which will iterate
        over each term in the list and dispatch to triples
        """
        subject, predicate, object_ = triple
        if isinstance(object_, list):
            assert not isinstance(subject, list), "object_ / subject are both lists"
            assert not isinstance(predicate, list), "object_ / predicate are both lists"
            if object_:
                for obj in object_:
                    for (s1, p1, o1), cg in self.triples(
                        (subject, predicate, obj), context
                    ):
                        yield (s1, p1, o1), cg
            else:
                for (s1, p1, o1), cg in self.triples(
                    (subject, predicate, None), context
                ):
                    yield (s1, p1, o1), cg

        elif isinstance(subject, list):
            assert not isinstance(predicate, list), "subject / predicate are both lists"
            if subject:
                for subj in subject:
                    for (s1, p1, o1), cg in self.triples(
                        (subj, predicate, object_), context
                    ):
                        yield (s1, p1, o1), cg
            else:
                for (s1, p1, o1), cg in self.triples(
                    (None, predicate, object_), context
                ):
                    yield (s1, p1, o1), cg

        elif isinstance(predicate, list):
            assert not isinstance(subject, list), "predicate / subject are both lists"
            if predicate:
                for pred in predicate:
                    for (s1, p1, o1), cg in self.triples(
                        (subject, pred, object_), context
                    ):
                        yield (s1, p1, o1), cg
            else:
                for (s1, p1, o1), cg in self.triples((subject, None, object_), context):
                    yield (s1, p1, o1), cg

    # type error: Missing return statement
    def triples(  # type: ignore[return]
        self,
        triple_pattern: _TriplePatternType,
        context: Optional[_ContextType] = None,
    ) -> Iterator[Tuple[_TripleType, Iterator[Optional[_ContextType]]]]:
        """
        A generator over all the triples matching the pattern. Pattern can
        include any objects for used for comparing against nodes in the store,
        for example, REGEXTerm, URIRef, Literal, BNode, Variable, Graph,
        QuotedGraph, Date? DateRange?

        Args:
            context: A conjunctive query can be indicated by either
                providing a value of None, or a specific context can be
                queries by passing a Graph instance (if store is context aware).
        """
        subject, predicate, object = triple_pattern

    # variants of triples will be done if / when optimization is needed

    # type error: Missing return statement
    def __len__(self, context: Optional[_ContextType] = None) -> int:  # type: ignore[empty-body]
        """
        Number of statements in the store. This should only account for non-
        quoted (asserted) statements if the context is not specified,
        otherwise it should return the number of statements in the formula or
        context given.

        Args:
            context: a graph instance to query or None
        """

    # type error: Missing return statement
    def contexts(  # type: ignore[empty-body]
        self, triple: Optional[_TripleType] = None
    ) -> Generator[_ContextType, None, None]:
        """
        Generator over all contexts in the graph. If triple is specified,
        a generator over all contexts the triple is in.

        if store is graph_aware, may also return empty contexts

        :returns: a generator over Nodes
        """

    # TODO FIXME: the result of query is inconsistent.
    def query(
        self,
        query: Union[Query, str],
        initNs: Mapping[str, Any],  # noqa: N803
        initBindings: Mapping[str, Identifier],  # noqa: N803
        queryGraph: str,  # noqa: N803
        **kwargs: Any,
    ) -> Result:
        """If stores provide their own SPARQL implementation, override this.

        queryGraph is None, a URIRef or `__UNION__`
        If None the graph is specified in the query-string/object
        If URIRef it specifies the graph to query,
        If  `__UNION__` the union of all named graphs should be queried
        (This is used by ConjunctiveGraphs
        Values other than None obviously only makes sense for
        context-aware stores.)
        """

        raise NotImplementedError

    def update(
        self,
        update: Union[Update, str],
        initNs: Mapping[str, Any],  # noqa: N803
        initBindings: Mapping[str, Identifier],  # noqa: N803
        queryGraph: str,  # noqa: N803
        **kwargs: Any,
    ) -> None:
        """If stores provide their own (SPARQL) Update implementation, override this.

        queryGraph is None, a URIRef or `__UNION__`
        If None the graph is specified in the query-string/object
        If URIRef it specifies the graph to query,
        If  `__UNION__` the union of all named graphs should be queried
        (This is used by ConjunctiveGraphs
        Values other than None obviously only makes sense for
        context-aware stores.)
        """

        raise NotImplementedError

    # Optional Namespace methods

    def bind(self, prefix: str, namespace: URIRef, override: bool = True) -> None:
        """Bind a namespace to a prefix.

        Args:
            prefix: The prefix to bind the namespace to.
            namespace: The URIRef of the namespace to bind.
            override: If True, rebind even if the given namespace is already bound
                to another prefix
        """

    def prefix(self, namespace: URIRef) -> Optional[str]:
        """"""

    def namespace(self, prefix: str) -> Optional[URIRef]:
        """ """

    def namespaces(self) -> Iterator[Tuple[str, URIRef]]:
        """ """
        # This is here so that the function becomes an empty generator.
        # See https://stackoverflow.com/q/13243766 and
        # https://www.python.org/dev/peps/pep-0255/#why-a-new-keyword-for-yield-why-not-a-builtin-function-instead
        if False:
            yield None  # type: ignore[unreachable]

    # Optional Transactional methods

    def commit(self) -> None:
        """ """

    def rollback(self) -> None:
        """ """

    # Optional graph methods

    def add_graph(self, graph: Graph) -> None:
        """Add a graph to the store, no effect if the graph already
        exists.

        Args:
            graph: a Graph instance
        """
        raise Exception("Graph method called on non-graph_aware store")

    def remove_graph(self, graph: Graph) -> None:
        """Remove a graph from the store, this should also remove all
        triples in the graph

        Args:
            graphid: a Graph instance
        """
        raise Exception("Graph method called on non-graph_aware store")
