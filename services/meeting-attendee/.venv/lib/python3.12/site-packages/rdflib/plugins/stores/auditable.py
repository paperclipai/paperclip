"""

This wrapper intercepts calls through the store interface and implements
thread-safe logging of destructive operations (adds / removes) in reverse.
This is persisted on the store instance and the reverse operations are
executed In order to return the store to the state it was when the transaction
began Since the reverse operations are persisted on the store, the store
itself acts as a transaction.

Calls to commit or rollback, flush the list of reverse operations This
provides thread-safe atomicity and isolation (assuming concurrent operations
occur with different store instances), but no durability (transactions are
persisted in memory and won't be available to reverse operations after the
system fails): A and I out of ACID.

"""

from __future__ import annotations

import threading
from typing import TYPE_CHECKING, Any, Generator, Iterator, List, Optional, Tuple, Union

from rdflib.graph import ConjunctiveGraph, Graph
from rdflib.store import Store

if TYPE_CHECKING:
    from rdflib.graph import (
        _ContextIdentifierType,
        _ContextType,
        _ObjectType,
        _PredicateType,
        _SubjectType,
        _TriplePatternType,
        _TripleType,
    )
    from rdflib.query import Result
    from rdflib.term import URIRef


destructiveOpLocks = {  # noqa: N816
    "add": None,
    "remove": None,
}


class AuditableStore(Store):
    """A store that logs destructive operations (add/remove) in reverse order."""

    def __init__(self, store: Store):
        self.store = store
        self.context_aware = store.context_aware
        # NOTE: this store can't be formula_aware as it doesn't have enough
        # info to reverse the removal of a quoted statement
        self.formula_aware = False  # store.formula_aware
        self.transaction_aware = True  # This is only half true
        self.reverseOps: List[
            Tuple[
                Optional[_SubjectType],
                Optional[_PredicateType],
                Optional[_ObjectType],
                Optional[_ContextIdentifierType],
                str,
            ]
        ] = []
        self.rollbackLock = threading.RLock()

    def open(
        self, configuration: Union[str, tuple[str, str]], create: bool = True
    ) -> Optional[int]:
        return self.store.open(configuration, create)

    def close(self, commit_pending_transaction: bool = False) -> None:
        self.store.close()

    def destroy(self, configuration: str) -> None:
        self.store.destroy(configuration)

    def query(self, *args: Any, **kw: Any) -> Result:
        return self.store.query(*args, **kw)

    def add(
        self, triple: _TripleType, context: _ContextType, quoted: bool = False
    ) -> None:
        (s, p, o) = triple
        lock = destructiveOpLocks["add"]
        lock = lock if lock else threading.RLock()
        with lock:
            context = (
                context.__class__(self.store, context.identifier)
                if context is not None
                else None
            )
            ctxId = context.identifier if context is not None else None  # noqa: N806
            if list(self.store.triples(triple, context)):
                return  # triple already in store, do nothing
            self.reverseOps.append((s, p, o, ctxId, "remove"))
            try:
                self.reverseOps.remove((s, p, o, ctxId, "add"))
            except ValueError:
                pass
            self.store.add((s, p, o), context, quoted)

    def remove(
        self, spo: _TriplePatternType, context: Optional[_ContextType] = None
    ) -> None:
        subject, predicate, object_ = spo
        lock = destructiveOpLocks["remove"]
        lock = lock if lock else threading.RLock()
        with lock:
            # Need to determine which quads will be removed if any term is a
            # wildcard
            context = (
                context.__class__(self.store, context.identifier)
                if context is not None
                else None
            )
            ctxId = context.identifier if context is not None else None  # noqa: N806
            if None in [subject, predicate, object_, context]:
                if ctxId:
                    # type error: Item "None" of "Optional[Graph]" has no attribute "triples"
                    for s, p, o in context.triples((subject, predicate, object_)):  # type: ignore[union-attr]
                        try:
                            self.reverseOps.remove((s, p, o, ctxId, "remove"))
                        except ValueError:
                            self.reverseOps.append((s, p, o, ctxId, "add"))
                else:
                    for s, p, o, ctx in ConjunctiveGraph(self.store).quads(
                        (subject, predicate, object_)
                    ):
                        try:
                            # type error: Item "None" of "Optional[Graph]" has no attribute "identifier"
                            self.reverseOps.remove((s, p, o, ctx.identifier, "remove"))  # type: ignore[union-attr]
                        except ValueError:
                            # type error: Item "None" of "Optional[Graph]" has no attribute "identifier"
                            self.reverseOps.append((s, p, o, ctx.identifier, "add"))  # type: ignore[union-attr]
            else:
                if not list(self.triples((subject, predicate, object_), context)):
                    return  # triple not present in store, do nothing
                try:
                    self.reverseOps.remove(
                        (subject, predicate, object_, ctxId, "remove")
                    )
                except ValueError:
                    self.reverseOps.append((subject, predicate, object_, ctxId, "add"))
            self.store.remove((subject, predicate, object_), context)

    def triples(
        self, triple: _TriplePatternType, context: Optional[_ContextType] = None
    ) -> Iterator[Tuple[_TripleType, Iterator[Optional[_ContextType]]]]:
        (su, pr, ob) = triple
        context = (
            context.__class__(self.store, context.identifier)
            if context is not None
            else None
        )
        for (s, p, o), cg in self.store.triples((su, pr, ob), context):
            yield (s, p, o), cg

    def __len__(self, context: Optional[_ContextType] = None):
        context = (
            context.__class__(self.store, context.identifier)
            if context is not None
            else None
        )
        return self.store.__len__(context)

    def contexts(
        self, triple: Optional[_TripleType] = None
    ) -> Generator[_ContextType, None, None]:
        for ctx in self.store.contexts(triple):
            yield ctx

    def bind(self, prefix: str, namespace: URIRef, override: bool = True) -> None:
        self.store.bind(prefix, namespace, override=override)

    def prefix(self, namespace: URIRef) -> Optional[str]:
        return self.store.prefix(namespace)

    def namespace(self, prefix: str) -> Optional[URIRef]:
        return self.store.namespace(prefix)

    def namespaces(self) -> Iterator[Tuple[str, URIRef]]:
        return self.store.namespaces()

    def commit(self) -> None:
        self.reverseOps = []

    def rollback(self) -> None:
        # Acquire Rollback lock and apply reverse operations in the forward
        # order
        with self.rollbackLock:
            for subject, predicate, obj, context, op in self.reverseOps:
                if op == "add":
                    # type error: Argument 2 to "Graph" has incompatible type "Optional[Node]"; expected "Union[IdentifiedNode, str, None]"
                    self.store.add(
                        (subject, predicate, obj), Graph(self.store, context)  # type: ignore[arg-type]
                    )
                else:
                    self.store.remove(
                        (subject, predicate, obj), Graph(self.store, context)
                    )

            self.reverseOps = []
