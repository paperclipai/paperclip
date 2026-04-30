from __future__ import annotations

from textwrap import dedent
from typing import Any, Generator, Iterable, Iterator, Mapping, Optional, Tuple

from rdflib import Graph
from rdflib.contrib.rdf4j import has_httpx
from rdflib.contrib.rdf4j.exceptions import RepositoryNotFoundError
from rdflib.graph import (
    DATASET_DEFAULT_GRAPH_ID,
    Dataset,
    _ContextType,
    _QuadType,
    _TriplePatternType,
    _TripleType,
)
from rdflib.store import VALID_STORE, Store
from rdflib.term import BNode, Node, URIRef, Variable

if has_httpx:
    from rdflib.contrib.rdf4j import RDF4JClient


def _inject_prefixes(query: str, extra_bindings: Mapping[str, Any]) -> str:
    bindings = set(list(extra_bindings.items()))
    if not bindings:
        return query
    return "\n".join(
        [
            "\n".join(["PREFIX %s: <%s>" % (k, v) for k, v in bindings]),
            "",  # separate ns_bindings from query with an empty line
            query,
        ]
    )


def _node_to_sparql(node: Node) -> str:
    if isinstance(node, BNode):
        raise Exception(
            "SPARQL-based stores do not support BNodes"
            "See http://www.w3.org/TR/sparql11-query/#BGPsparqlBNodes"
        )
    return node.n3()


def _default_repo_config(repository_id: str) -> str:
    return dedent(
        f"""
        PREFIX config: <tag:rdf4j.org,2023:config/>

        []    a config:Repository ;
            config:rep.id "{repository_id}" ;
            config:rep.impl
                [
                    config:rep.type "openrdf:SailRepository" ;
                    config:sail.impl
                        [
                            config:native.tripleIndexers "spoc,posc" ;
                            config:sail.defaultQueryEvaluationMode "STANDARD" ;
                            config:sail.iterationCacheSyncThreshold "10000" ;
                            config:sail.type "openrdf:NativeStore" ;
                        ] ;
                ] ;
        .
    """
    )


class RDF4JStore(Store):
    """An RDF4J store."""

    context_aware = True
    formula_aware = False
    transaction_aware = False
    graph_aware = True

    def __init__(
        self,
        base_url: str,
        repository_id: str,
        configuration: str | None = None,
        auth: tuple[str, str] | None = None,
        timeout: float = 30.0,
        create: bool = False,
        **kwargs,
    ):
        if configuration is None:
            configuration = _default_repo_config(repository_id)
        self._client = RDF4JClient(base_url, auth, timeout, **kwargs)
        self._repository_id = repository_id
        self._repo = None
        self.open(configuration, create)
        super().__init__()

    @property
    def client(self):
        return self._client

    @property
    def repo(self):
        if self._repo is None:
            self._repo = self.client.repositories.get(self._repository_id)
        return self._repo

    def open(
        self, configuration: str | tuple[str, str] | None, create: bool = False
    ) -> int | None:
        try:
            # Try connecting to the repository.
            self.repo.health()
        except RepositoryNotFoundError:
            if create:
                self.client.repositories.create(self._repository_id, configuration)
                self.repo.health()
            else:
                raise Exception(f"Repository {self._repository_id} not found.")

        return VALID_STORE

    def close(self, commit_pending_transaction: bool = False) -> None:
        self.client.close()

    def add(
        self,
        triple: _TripleType,
        context: _ContextType | None = None,
        quoted: bool = False,
    ) -> None:
        s, p, o = triple
        graph_name = (
            ""
            if context is None or context.identifier == DATASET_DEFAULT_GRAPH_ID
            else context.identifier.n3()
        )
        statement = f"{s.n3()} {p.n3()} {o.n3()} {graph_name} ."
        self.repo.upload(statement)

    def addN(self, quads: Iterable[_QuadType]) -> None:  # noqa: N802
        statements = ""
        for s, p, o, c in quads:
            graph_name = (
                ""
                if c is None or c.identifier == DATASET_DEFAULT_GRAPH_ID
                else c.identifier.n3()
            )
            statement = f"{s.n3()} {p.n3()} {o.n3()} {graph_name} .\n"
            statements += statement
        self.repo.upload(statements)

    def remove(
        self,
        triple: _TriplePatternType,
        context: Optional[_ContextType] = None,
    ) -> None:
        s, p, o = triple
        g = context.identifier if context is not None else None
        self.repo.delete(s, p, o, g)

    def triples(
        self,
        triple_pattern: _TriplePatternType,
        context: Optional[_ContextType] = None,
    ) -> Iterator[Tuple[_TripleType, Iterator[Optional[_ContextType]]]]:
        s, p, o = triple_pattern
        graph_name = context.identifier if context is not None else None
        result_graph = self.repo.get(s, p, o, graph_name)
        if isinstance(result_graph, Dataset):
            for s, p, o, g in result_graph:
                yield (s, p, o), iter([Graph(self, identifier=g)])
        else:
            # It's a Graph object.
            for triple in result_graph:
                # Returning None for _ContextType as it's not used by the caller.
                yield triple, iter([None])

    def contexts(
        self, triple: Optional[_TripleType] = None
    ) -> Generator[_ContextType, None, None]:
        if triple is None:
            for graph_name in self.repo.graph_names():
                yield Graph(self, identifier=graph_name)
        else:
            s, p, o = triple
            params = (
                _node_to_sparql(s if s else Variable("s")),
                _node_to_sparql(p if p else Variable("p")),
                _node_to_sparql(o if o else Variable("o")),
            )
            query = (
                "SELECT DISTINCT ?graph WHERE { GRAPH ?graph { %s %s %s } }" % params
            )
            result = self.repo.query(query)
            for row in result:
                yield Graph(self, identifier=row["graph"])

    def bind(self, prefix: str, namespace: URIRef, override: bool = True) -> None:
        # Note: RDF4J namespaces always override.
        self.repo.namespaces.set(prefix, namespace)

    def prefix(self, namespace: URIRef) -> Optional[str]:
        namespace_prefixes = dict(
            [(x.namespace, x.prefix) for x in self.repo.namespaces.list()]
        )
        return namespace_prefixes.get(str(namespace))

    def namespace(self, prefix: str) -> Optional[URIRef]:
        result = self.repo.namespaces.get(prefix)
        return URIRef(result) if result is not None else None

    def namespaces(self) -> Iterator[Tuple[str, URIRef]]:
        for result in self.repo.namespaces.list():
            yield result.prefix, URIRef(result.namespace)

    def add_graph(self, graph: Graph) -> None:
        if graph.identifier != DATASET_DEFAULT_GRAPH_ID:
            # Note: this is a no-op since RDF4J doesn't support empty named graphs.
            self.repo.update(f"CREATE SILENT GRAPH {graph.identifier.n3()}")

    def remove_graph(self, graph: Graph) -> None:
        self.repo.graphs.clear(graph.identifier)

    def __len__(self, context: _ContextType | None = None) -> int:
        return self.repo.size(context if context is None else context.identifier)
