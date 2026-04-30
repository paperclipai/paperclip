"""
This wrapper intercepts calls through the store interface which make use of
the REGEXTerm class to represent matches by REGEX instead of literal
comparison.

Implemented for stores that don't support this and essentially
provides the support by replacing the REGEXTerms by wildcards (None) and
matching against the results from the store it's wrapping.
"""

import re

from rdflib.graph import Graph
from rdflib.store import Store

# Store is capable of doing its own REGEX matching
NATIVE_REGEX = 0
# Store uses Python's re module internally for REGEX matching
PYTHON_REGEX = 1


class REGEXTerm(str):
    """
    REGEXTerm can be used in any term slot and is interpreted as a request to
    perform a REGEX match (not a string comparison) using the value
    (pre-compiled) for checking rdf:type matches
    """

    def __init__(self, expr):
        self.compiledExpr = re.compile(expr)

    def __reduce__(self):
        return (REGEXTerm, ("",))


def regexCompareQuad(quad, regexQuad):  # noqa: N802, N803
    for index in range(4):
        if isinstance(regexQuad[index], REGEXTerm) and not regexQuad[
            index
        ].compiledExpr.match(quad[index]):
            return False
    return True


class REGEXMatching(Store):
    def __init__(self, storage):
        self.storage = storage
        self.context_aware = storage.context_aware
        # NOTE: this store can't be formula_aware as it doesn't have enough
        # info to reverse the removal of a quoted statement.
        self.formula_aware = storage.formula_aware
        self.transaction_aware = storage.transaction_aware

    def open(self, configuration, create=True):
        return self.storage.open(configuration, create)

    def close(self, commit_pending_transaction=False):
        self.storage.close()

    def destroy(self, configuration):
        self.storage.destroy(configuration)

    def add(self, triple, context, quoted=False):
        (subject, predicate, object_) = triple
        self.storage.add((subject, predicate, object_), context, quoted)

    def remove(self, triple, context=None):
        (subject, predicate, object_) = triple
        if (
            isinstance(subject, REGEXTerm)
            or isinstance(predicate, REGEXTerm)
            or isinstance(object_, REGEXTerm)
            or (context is not None and isinstance(context.identifier, REGEXTerm))
        ):
            # One or more of the terms is a REGEX expression, so we must
            # replace it / them with wildcard(s)and match after we query.
            s = not isinstance(subject, REGEXTerm) and subject or None
            p = not isinstance(predicate, REGEXTerm) and predicate or None
            o = not isinstance(object_, REGEXTerm) and object_ or None
            c = (
                (context is not None and not isinstance(context.identifier, REGEXTerm))
                and context
                or None
            )

            removeQuadList = []  # noqa: N806
            for (s1, p1, o1), cg in self.storage.triples((s, p, o), c):
                for ctx in cg:
                    ctx = ctx.identifier
                    if regexCompareQuad(
                        (s1, p1, o1, ctx),
                        (
                            subject,
                            predicate,
                            object_,
                            context is not None and context.identifier or context,
                        ),
                    ):
                        removeQuadList.append((s1, p1, o1, ctx))
            for s, p, o, c in removeQuadList:
                self.storage.remove((s, p, o), c and Graph(self, c) or c)
        else:
            self.storage.remove((subject, predicate, object_), context)

    def triples(self, triple, context=None):
        (subject, predicate, object_) = triple
        if (
            isinstance(subject, REGEXTerm)
            or isinstance(predicate, REGEXTerm)
            or isinstance(object_, REGEXTerm)
            or (context is not None and isinstance(context.identifier, REGEXTerm))
        ):
            # One or more of the terms is a REGEX expression, so we must
            # replace it / them with wildcard(s) and match after we query.
            s = not isinstance(subject, REGEXTerm) and subject or None
            p = not isinstance(predicate, REGEXTerm) and predicate or None
            o = not isinstance(object_, REGEXTerm) and object_ or None
            c = (
                (context is not None and not isinstance(context.identifier, REGEXTerm))
                and context
                or None
            )
            for (s1, p1, o1), cg in self.storage.triples((s, p, o), c):
                matchingCtxs = []  # noqa: N806
                for ctx in cg:
                    if c is None:
                        if context is None or context.identifier.compiledExpr.match(
                            ctx.identifier
                        ):
                            matchingCtxs.append(ctx)
                    else:
                        matchingCtxs.append(ctx)
                if matchingCtxs and regexCompareQuad(
                    (s1, p1, o1, None), (subject, predicate, object_, None)
                ):
                    yield (s1, p1, o1), (c for c in matchingCtxs)
        else:
            for (s1, p1, o1), cg in self.storage.triples(
                (subject, predicate, object_), context
            ):
                yield (s1, p1, o1), cg

    def __len__(self, context=None):
        # NOTE: If the context is a REGEX this could be an expensive
        # proposition
        return self.storage.__len__(context)

    def contexts(self, triple=None):
        # NOTE: There is no way to control REGEX matching for this method at
        # this level as it only returns the contexts, not the matching
        # triples.
        for ctx in self.storage.contexts(triple):
            yield ctx

    def remove_context(self, identifier):
        self.storage.remove((None, None, None), identifier)

    def bind(self, prefix, namespace, override=True):
        self.storage.bind(prefix, namespace, override=override)

    def prefix(self, namespace):
        return self.storage.prefix(namespace)

    def namespace(self, prefix):
        return self.storage.namespace(prefix)

    def namespaces(self):
        return self.storage.namespaces()

    def commit(self):
        self.storage.commit()

    def rollback(self):
        self.storage.rollback()
