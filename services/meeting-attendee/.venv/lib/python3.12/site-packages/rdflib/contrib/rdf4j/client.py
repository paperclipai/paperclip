"""RDF4J client module."""

from __future__ import annotations

import contextlib
import io
import typing as t
from dataclasses import dataclass
from typing import Any, BinaryIO, Iterable

import httpx

from rdflib import BNode
from rdflib.contrib.rdf4j.exceptions import (
    RDF4JUnsupportedProtocolError,
    RDFLibParserError,
    RepositoryAlreadyExistsError,
    RepositoryError,
    RepositoryNotFoundError,
    RepositoryNotHealthyError,
    RepositoryResponseFormatError,
    TransactionClosedError,
    TransactionCommitError,
    TransactionPingError,
    TransactionRollbackError,
)
from rdflib.contrib.rdf4j.util import (
    build_context_param,
    build_infer_param,
    build_sparql_query_accept_header,
    build_spo_param,
    rdf_payload_to_stream,
    validate_graph_name,
    validate_no_bnodes,
)
from rdflib.graph import DATASET_DEFAULT_GRAPH_ID, Dataset, Graph
from rdflib.query import Result
from rdflib.term import IdentifiedNode, Literal, URIRef

SubjectType = t.Union[URIRef, None]
PredicateType = t.Union[URIRef, None]
ObjectType = t.Union[URIRef, Literal, None]


@dataclass(frozen=True)
class NamespaceListingResult:
    """RDF4J namespace and prefix name result."""

    prefix: str
    namespace: str


class RDF4JNamespaceManager:
    """A namespace manager for RDF4J repositories.

    Parameters:
        identifier: The identifier of the repository.
        http_client: The httpx.Client instance.
    """

    def __init__(self, identifier: str, http_client: httpx.Client):
        self._identifier = identifier
        self._http_client = http_client

    @property
    def http_client(self):
        return self._http_client

    @property
    def identifier(self):
        """Repository identifier."""
        return self._identifier

    def list(self) -> list[NamespaceListingResult]:
        """List all namespace declarations in the repository.

        Returns:
            list[NamespaceListingResult]: List of namespace and prefix name results.

        Raises:
            RepositoryResponseFormatError: If the response format is unrecognized.
        """
        headers = {
            "Accept": "application/sparql-results+json",
        }
        response = self.http_client.get(
            f"/repositories/{self.identifier}/namespaces", headers=headers
        )
        response.raise_for_status()

        try:
            data = response.json()
            results = data["results"]["bindings"]
            return [
                NamespaceListingResult(
                    prefix=row["prefix"]["value"],
                    namespace=row["namespace"]["value"],
                )
                for row in results
            ]
        except (KeyError, ValueError) as err:
            raise RepositoryResponseFormatError(f"Unrecognised response format: {err}")

    def clear(self):
        """Clear all namespace declarations in the repository."""
        headers = {
            "Accept": "application/sparql-results+json",
        }
        response = self.http_client.delete(
            f"/repositories/{self.identifier}/namespaces", headers=headers
        )
        response.raise_for_status()

    def get(self, prefix: str) -> str | None:
        """Get the namespace URI for a given prefix.

        Parameters:
            prefix: The prefix to lookup.

        Returns:
            The namespace URI or `None` if not found.
        """
        if not prefix:
            raise ValueError("Prefix cannot be empty.")
        headers = {
            "Accept": "text/plain",
        }
        try:
            response = self.http_client.get(
                f"/repositories/{self.identifier}/namespaces/{prefix}", headers=headers
            )
            response.raise_for_status()
            return response.text
        except httpx.HTTPStatusError as err:
            if err.response.status_code == 404:
                return None
            raise

    def set(self, prefix: str, namespace: str):
        """Set the namespace URI for a given prefix.

        !!! note
            If the prefix was previously mapped to a different namespace, this will be
            overwritten.

        Parameters:
            prefix: The prefix to set.
            namespace: The namespace URI to set.
        """
        if not prefix:
            raise ValueError("Prefix cannot be empty.")
        if not namespace:
            raise ValueError("Namespace cannot be empty.")
        headers = {
            "Content-Type": "text/plain",
        }
        response = self.http_client.put(
            f"/repositories/{self.identifier}/namespaces/{prefix}",
            headers=headers,
            content=namespace,
        )
        response.raise_for_status()

    def remove(self, prefix: str):
        """Remove the namespace declaration for a given prefix.

        Parameters:
            prefix: The prefix to remove.
        """
        if not prefix:
            raise ValueError("Prefix cannot be empty.")
        response = self.http_client.delete(
            f"/repositories/{self.identifier}/namespaces/{prefix}"
        )
        response.raise_for_status()


class GraphStoreManager:
    """An RDF4J Graph Store Protocol Client.

    Parameters:
        identifier: The identifier of the repository.
        http_client: The httpx.Client instance.
    """

    def __init__(self, identifier: str, http_client: httpx.Client):
        self._identifier = identifier
        self._http_client = http_client
        self._content_type = "application/n-triples"

    @property
    def http_client(self):
        return self._http_client

    @property
    def identifier(self):
        """Repository identifier."""
        return self._identifier

    @staticmethod
    def _build_graph_name_params(graph_name: URIRef | str):
        params = {}
        if (
            isinstance(graph_name, URIRef)
            and graph_name == DATASET_DEFAULT_GRAPH_ID
            or isinstance(graph_name, str)
            and graph_name == str(DATASET_DEFAULT_GRAPH_ID)
        ):
            # Do nothing; GraphDB does not work with `?default=`
            # (note the trailing equal character), which is the default
            # behavior of httpx when setting the param value to an empty string.
            # httpx completely omits query parameters whose values are `None`, so that's
            # not an option either.
            # The workaround is to construct our own query parameter URL when we target
            # the default graph.
            pass
        else:
            params["graph"] = str(graph_name)
        return params

    def _build_url(self, graph_name: URIRef | str):
        url = f"/repositories/{self.identifier}/rdf-graphs/service"
        if isinstance(graph_name, URIRef) and graph_name == DATASET_DEFAULT_GRAPH_ID:
            url += "?default"
        return url

    def get(self, graph_name: URIRef | str) -> Graph:
        """Fetch all statements in the specified graph.

        Parameters:
            graph_name: The graph name of the graph.

                For the default graph, use
                [`DATASET_DEFAULT_GRAPH_ID`][rdflib.graph.DATASET_DEFAULT_GRAPH_ID].

        Returns:
            A [`Graph`][rdflib.graph.Graph] object containing all statements in the
                graph.
        """
        if not graph_name:
            raise ValueError("Graph name must be provided.")
        validate_graph_name(graph_name)
        headers = {
            "Accept": self._content_type,
        }
        params = self._build_graph_name_params(graph_name) or None

        response = self.http_client.get(
            self._build_url(graph_name),
            headers=headers,
            params=params,
        )
        response.raise_for_status()

        return Graph(identifier=graph_name).parse(
            data=response.text, format=self._content_type
        )

    def add(self, graph_name: URIRef | str, data: str | bytes | BinaryIO | Graph):
        """Add statements to the specified graph.

        Parameters:
            graph_name: The graph name of the graph.

                For the default graph, use
                [`DATASET_DEFAULT_GRAPH_ID`][rdflib.graph.DATASET_DEFAULT_GRAPH_ID].

            data: The RDF data to add.
        """
        if not graph_name:
            raise ValueError("Graph name must be provided.")
        validate_graph_name(graph_name)
        stream, should_close = rdf_payload_to_stream(data)
        headers = {
            "Content-Type": self._content_type,
        }
        params = self._build_graph_name_params(graph_name) or None
        try:
            response = self.http_client.post(
                self._build_url(graph_name),
                headers=headers,
                params=params,
                content=stream,
            )
            response.raise_for_status()
        finally:
            if should_close:
                stream.close()

    def overwrite(self, graph_name: URIRef | str, data: str | bytes | BinaryIO | Graph):
        """Overwrite statements in the specified graph.

        Parameters:
            graph_name: The graph name of the graph.

                For the default graph, use
                [`DATASET_DEFAULT_GRAPH_ID`][rdflib.graph.DATASET_DEFAULT_GRAPH_ID].

            data: The RDF data to overwrite with.
        """
        if not graph_name:
            raise ValueError("Graph name must be provided.")
        validate_graph_name(graph_name)
        stream, should_close = rdf_payload_to_stream(data)
        headers = {
            "Content-Type": self._content_type,
        }
        params = self._build_graph_name_params(graph_name) or None
        try:
            response = self.http_client.put(
                self._build_url(graph_name),
                headers=headers,
                params=params,
                content=stream,
            )
            response.raise_for_status()
        finally:
            if should_close:
                stream.close()

    def clear(self, graph_name: URIRef | str):
        """Clear all statements in the specified graph.

        Parameters:
            graph_name: The graph name of the graph.

                For the default graph, use
                [`DATASET_DEFAULT_GRAPH_ID`][rdflib.graph.DATASET_DEFAULT_GRAPH_ID].
        """
        if not graph_name:
            raise ValueError("Graph name must be provided.")
        validate_graph_name(graph_name)
        params = self._build_graph_name_params(graph_name) or None
        response = self.http_client.delete(self._build_url(graph_name), params=params)
        response.raise_for_status()


@dataclass(frozen=True)
class RepositoryListingResult:
    """RDF4J repository listing result.

    Parameters:
        identifier: Repository identifier.
        uri: Repository URI.
        readable: Whether the repository is readable by the client.
        writable: Whether the repository is writable by the client.
        title: Repository title.
    """

    identifier: str
    uri: str
    readable: bool
    writable: bool
    title: str | None = None


class Repository:
    """RDF4J repository client.

    Parameters:
        identifier: The identifier of the repository.
        http_client: The httpx.Client instance.
    """

    def __init__(self, identifier: str, http_client: httpx.Client):
        self._identifier = identifier
        self._http_client = http_client
        self._namespace_manager: RDF4JNamespaceManager | None = None
        self._graph_store_manager: GraphStoreManager | None = None

    @property
    def http_client(self):
        return self._http_client

    @property
    def identifier(self):
        """Repository identifier."""
        return self._identifier

    @property
    def namespaces(self) -> RDF4JNamespaceManager:
        """Namespace manager for the repository."""
        if self._namespace_manager is None:
            self._namespace_manager = RDF4JNamespaceManager(
                self.identifier, self.http_client
            )
        return self._namespace_manager

    @property
    def graphs(self) -> GraphStoreManager:
        """Graph store manager for the repository."""
        if self._graph_store_manager is None:
            self._graph_store_manager = GraphStoreManager(
                self.identifier, self.http_client
            )
        return self._graph_store_manager

    def health(self) -> bool:
        """Repository health check.

        Returns:
            bool: True if the repository is healthy, otherwise an error is raised.

        Raises:
            RepositoryNotFoundError: If the repository is not found.
            RepositoryNotHealthyError: If the repository is not healthy.
        """
        headers = {
            "Content-Type": "application/sparql-query",
            "Accept": "application/sparql-results+json",
        }
        try:
            response = self.http_client.post(
                f"/repositories/{self._identifier}", headers=headers, content="ASK {}"
            )
            response.raise_for_status()
            return True
        except httpx.HTTPStatusError as err:
            if err.response.status_code == 404:
                raise RepositoryNotFoundError(
                    f"Repository {self._identifier} not found."
                )
            raise RepositoryNotHealthyError(
                f"Repository {self._identifier} is not healthy. {err.response.status_code} - {err.response.text}"
            )

    def size(self, graph_name: URIRef | Iterable[URIRef] | str | None = None) -> int:
        """The number of statements in the repository or in the specified graph name.

        Parameters:
            graph_name: Graph name(s) to restrict to.

                The default value `None` queries all graphs.

                To query just the default graph, use
                [`DATASET_DEFAULT_GRAPH_ID`][rdflib.graph.DATASET_DEFAULT_GRAPH_ID].

        Returns:
            The number of statements.

        Raises:
            RepositoryResponseFormatError: Fails to parse the repository size.
        """
        validate_graph_name(graph_name)
        params: dict[str, str] = {}
        build_context_param(params, graph_name)
        response = self.http_client.get(
            f"/repositories/{self.identifier}/size", params=params
        )
        response.raise_for_status()
        return self._to_size(response.text)

    @staticmethod
    def _to_size(size: str):
        try:
            value = int(size)
            if value >= 0:
                return value
            raise ValueError(f"Invalid repository size: {value}")
        except ValueError as err:
            raise RepositoryResponseFormatError(
                f"Failed to parse repository size: {err}"
            ) from err

    def query(self, query: str, **kwargs):
        """Execute a SPARQL query against the repository.

        !!! note
            A POST request is used by default. If any keyword arguments are provided,
            a GET request is used instead, and the arguments are passed as query parameters.

        Parameters:
            query: The SPARQL query to execute.
            **kwargs: Additional keyword arguments to include as query parameters
                in the request. See
                [RDF4J REST API - Execute SPARQL query](https://rdf4j.org/documentation/reference/rest-api/#tag/SPARQL/paths/~1repositories~1%7BrepositoryID%7D/get)
                for the list of supported query parameters.
        """
        headers = {"Content-Type": "application/sparql-query"}
        build_sparql_query_accept_header(query, headers)

        if not kwargs:
            response = self.http_client.post(
                f"/repositories/{self.identifier}", headers=headers, content=query
            )
        else:
            response = self.http_client.get(
                f"/repositories/{self.identifier}",
                headers=headers,
                params={"query": query, **kwargs},
            )
        response.raise_for_status()
        try:
            return Result.parse(
                io.BytesIO(response.content),
                content_type=response.headers["Content-Type"].split(";")[0],
            )
        except KeyError as err:
            raise RDFLibParserError(
                f"Failed to parse SPARQL query result {response.headers.get('Content-Type')}: {err}"
            ) from err

    def update(self, query: str):
        """Execute a SPARQL update operation on the repository.

        Parameters:
            query: The SPARQL update query to execute.
        """
        headers = {"Content-Type": "application/sparql-update"}
        response = self.http_client.post(
            f"/repositories/{self.identifier}/statements",
            headers=headers,
            content=query,
        )
        response.raise_for_status()

    def graph_names(self) -> list[IdentifiedNode]:
        """Get a list of all graph names in the repository.

        Returns:
            A list of graph names.

        Raises:
            RepositoryResponseFormatError: Fails to parse the repository graph names.
        """
        headers = {
            "Accept": "application/sparql-results+json",
        }
        response = self.http_client.get(
            f"/repositories/{self.identifier}/contexts", headers=headers
        )
        response.raise_for_status()
        try:
            values: list[IdentifiedNode] = []
            for row in response.json()["results"]["bindings"]:
                value = row["contextID"]["value"]
                value_type = row["contextID"]["type"]
                if value_type == "uri":
                    values.append(URIRef(value))
                elif value_type == "bnode":
                    values.append(BNode(value))
                else:
                    raise ValueError(f"Invalid graph name type: {value_type}")
            return values
        except Exception as err:
            raise RepositoryResponseFormatError(
                f"Failed to parse repository graph names: {err}"
            ) from err

    def get(
        self,
        subj: SubjectType = None,
        pred: PredicateType = None,
        obj: ObjectType = None,
        graph_name: URIRef | Iterable[URIRef] | str | None = None,
        infer: bool = True,
        content_type: str | None = None,
    ) -> Graph | Dataset:
        """Get RDF statements from the repository matching the filtering parameters.

        !!! Note
            The terms for `subj`, `pred`, `obj` or `graph_name` cannot be
            [`BNodes`][rdflib.term.BNode].

        Parameters:
            subj: Subject of the statement to filter by, or `None` to match all.
            pred: Predicate of the statement to filter by, or `None` to match all.
            obj: Object of the statement to filter by, or `None` to match all.
            graph_name: Graph name(s) to restrict to.

                The default value `None` queries all graphs.

                To query just the default graph, use
                [`DATASET_DEFAULT_GRAPH_ID`][rdflib.graph.DATASET_DEFAULT_GRAPH_ID].

            infer: Specifies whether inferred statements should be included in the
                result.
            content_type: The content type of the response.
                A triple-based format returns a [Graph][rdflib.graph.Graph], while a
                quad-based format returns a [`Dataset`][rdflib.graph.Dataset].

        Returns:
            A [`Graph`][rdflib.graph.Graph] or [`Dataset`][rdflib.graph.Dataset] object
                with the repository namespace prefixes bound to it.
        """
        validate_no_bnodes(subj, pred, obj, graph_name)
        if content_type is None:
            content_type = "application/n-quads"
        headers = {"Accept": content_type}
        params: dict[str, str] = {}
        build_context_param(params, graph_name)
        build_spo_param(params, subj, pred, obj)
        build_infer_param(params, infer=infer)

        response = self.http_client.get(
            f"/repositories/{self.identifier}/statements",
            headers=headers,
            params=params,
        )
        response.raise_for_status()
        triple_formats = [
            "application/n-triples",
            "text/turtle",
            "application/rdf+xml",
        ]
        try:
            if content_type in triple_formats:
                retval = Graph().parse(data=response.text, format=content_type)
            else:
                retval = Dataset().parse(data=response.text, format=content_type)
            for result in self.namespaces.list():
                retval.bind(result.prefix, result.namespace, replace=True)
            return retval
        except Exception as err:
            raise RDFLibParserError(f"Error parsing RDF: {err}") from err

    def upload(
        self,
        data: str | bytes | BinaryIO | Graph | Dataset,
        base_uri: str | None = None,
        content_type: str | None = None,
    ):
        """Upload and append statements to the repository.

        Parameters:
            data: The RDF data to upload.
            base_uri: The base URI to resolve against for any relative URIs in the data.
            content_type: The content type of the data. Defaults to
                `application/n-quads` when the value is `None`.
        """
        stream, should_close = rdf_payload_to_stream(data)
        try:
            headers = {"Content-Type": content_type or "application/n-quads"}
            params = {}
            if base_uri is not None:
                params["baseURI"] = base_uri
            response = self.http_client.post(
                f"/repositories/{self.identifier}/statements",
                headers=headers,
                params=params,
                content=stream,
            )
            response.raise_for_status()
        finally:
            if should_close:
                stream.close()

    def overwrite(
        self,
        data: str | bytes | BinaryIO | Graph | Dataset,
        graph_name: URIRef | Iterable[URIRef] | str | None = None,
        base_uri: str | None = None,
        content_type: str | None = None,
    ):
        """Upload and overwrite statements in the repository.

        Parameters:
            data: The RDF data to upload.
            graph_name: Graph name(s) to restrict to.

                The default value `None` applies to all graphs.

                To apply to just the default graph, use
                [`DATASET_DEFAULT_GRAPH_ID`][rdflib.graph.DATASET_DEFAULT_GRAPH_ID].

            base_uri: The base URI to resolve against for any relative URIs in the data.
            content_type: The content type of the data. Defaults to
                `application/n-quads` when the value is `None`.
        """
        stream, should_close = rdf_payload_to_stream(data)
        validate_graph_name(graph_name)
        try:
            headers = {"Content-Type": content_type or "application/n-quads"}
            params: dict[str, str] = {}
            build_context_param(params, graph_name)
            if base_uri is not None:
                params["baseURI"] = base_uri
            response = self.http_client.put(
                f"/repositories/{self.identifier}/statements",
                headers=headers,
                params=params,
                content=stream,
            )
            response.raise_for_status()
        finally:
            if should_close:
                stream.close()

    def delete(
        self,
        subj: SubjectType = None,
        pred: PredicateType = None,
        obj: ObjectType = None,
        graph_name: URIRef | Iterable[URIRef] | str | None = None,
    ) -> None:
        """Deletes statements from the repository matching the filtering parameters.

        !!! Note
            The terms for `subj`, `pred`, `obj` or `graph_name` cannot be
            [`BNodes`][rdflib.term.BNode].

        Parameters:
            subj: Subject of the statement to filter by, or `None` to match all.
            pred: Predicate of the statement to filter by, or `None` to match all.
            obj: Object of the statement to filter by, or `None` to match all.
            graph_name: Graph name(s) to restrict to.

                The default value `None` queries all graphs.

                To query just the default graph, use
                [`DATASET_DEFAULT_GRAPH_ID`][rdflib.graph.DATASET_DEFAULT_GRAPH_ID].
        """
        validate_no_bnodes(subj, pred, obj, graph_name)
        params: dict[str, str] = {}
        build_context_param(params, graph_name)
        build_spo_param(params, subj, pred, obj)

        response = self.http_client.delete(
            f"/repositories/{self.identifier}/statements",
            params=params,
        )
        response.raise_for_status()

    @contextlib.contextmanager
    def transaction(self):
        """Create a new transaction for the repository.

        !!! warning

        Transaction instances are not thread-safe. Do not share a single
        Transaction instance across multiple threads. Each thread should create
        its own transaction, or use appropriate synchronization if sharing is
        required.
        """
        with Transaction.create(self) as txn:
            yield txn


class Transaction:
    """An RDF4J transaction.

    !!! warning

        Transaction instances are not thread-safe. Do not share a single
        Transaction instance across multiple threads. Each thread should create
        its own transaction, or use appropriate synchronization if sharing is
        required.

    Parameters:
        repo: The repository instance.
    """

    def __init__(self, repo: Repository, url: str):
        self._repo = repo
        self._url: str = url
        self._closed: bool = False

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if not self.is_closed:
            if exc_type is None:
                self.commit()
            else:
                try:
                    self.rollback()
                except Exception:
                    pass

        # Propagate errors.
        return False

    @property
    def repo(self):
        """The repository instance."""
        return self._repo

    @property
    def url(self):
        """The transaction URL."""
        return self._url

    @property
    def is_closed(self) -> bool:
        """Whether the transaction is closed."""
        return self._closed

    def _raise_for_closed(self):
        if self.is_closed:
            raise TransactionClosedError("The transaction has been closed.")

    @classmethod
    def create(cls, repo: Repository) -> Transaction:
        """Create a new transaction for the repository.

        Parameters:
            repo: The repository instance.

        Returns:
            A new Transaction instance.
        """
        response = repo.http_client.post(
            f"/repositories/{repo.identifier}/transactions"
        )
        response.raise_for_status()
        url = response.headers["Location"]
        return cls(repo, url)

    def commit(self):
        """Commit the transaction.

        Raises:
            TransactionCommitError: If the transaction commit fails.
            TransactionClosedError: If the transaction is closed.
        """
        self._raise_for_closed()
        params = {"action": "COMMIT"}
        response = self.repo.http_client.put(self.url, params=params)
        if response.status_code != 200:
            raise TransactionCommitError(
                f"Transaction commit failed: {response.status_code} - {response.text}"
            )
        self._closed = True

    def rollback(self):
        """Roll back the transaction.

        Raises:
            TransactionRollbackError: If the transaction rollback fails.
            TransactionClosedError: If the transaction is closed.
        """
        self._raise_for_closed()
        response = self.repo.http_client.delete(self.url)
        if response.status_code != 204:
            raise TransactionRollbackError(
                f"Transaction rollback failed: {response.status_code} - {response.text}"
            )
        self._closed = True

    def ping(self):
        """Ping the transaction.

        Raises:
            RepositoryTransactionPingError: If the transaction ping fails.
            TransactionClosedError: If the transaction is closed.
        """
        self._raise_for_closed()
        params = {"action": "PING"}
        response = self.repo.http_client.put(self.url, params=params)
        if response.status_code != 200:
            raise TransactionPingError(
                f"Transaction ping failed: {response.status_code} - {response.text}"
            )

    def size(self, graph_name: URIRef | Iterable[URIRef] | str | None = None):
        """The number of statements in the repository or in the specified graph name.

        Parameters:
            graph_name: Graph name(s) to restrict to.

                The default value `None` queries all graphs.

                To query just the default graph, use
                [`DATASET_DEFAULT_GRAPH_ID`][rdflib.graph.DATASET_DEFAULT_GRAPH_ID].

        Returns:
            The number of statements.

        Raises:
            RepositoryResponseFormatError: Fails to parse the repository size.
        """
        self._raise_for_closed()
        validate_graph_name(graph_name)
        params = {"action": "SIZE"}
        build_context_param(params, graph_name)
        response = self.repo.http_client.put(self.url, params=params)
        response.raise_for_status()
        return self.repo._to_size(response.text)

    def query(self, query: str, **kwargs):
        """Execute a SPARQL query against the repository.

        Parameters:
            query: The SPARQL query to execute.
            **kwargs: Additional keyword arguments to include as query parameters
                in the request. See
                [RDF4J REST API - Execute SPARQL query](https://rdf4j.org/documentation/reference/rest-api/#tag/SPARQL/paths/~1repositories~1%7BrepositoryID%7D/get)
                for the list of supported query parameters.
        """
        self._raise_for_closed()
        headers: dict[str, str] = {}
        build_sparql_query_accept_header(query, headers)
        params = {"action": "QUERY", "query": query}
        response = self.repo.http_client.put(
            self.url, headers=headers, params={**params, **kwargs}
        )
        response.raise_for_status()
        try:
            return Result.parse(
                io.BytesIO(response.content),
                content_type=response.headers["Content-Type"].split(";")[0],
            )
        except KeyError as err:
            raise RDFLibParserError(
                f"Failed to parse SPARQL query result {response.headers.get('Content-Type')}: {err}"
            ) from err

    def update(self, query: str, **kwargs):
        """Execute a SPARQL update operation on the repository.

        Parameters:
            query: The SPARQL update query to execute.
            **kwargs: Additional keyword arguments to include as query parameters
                See [RDF4J REST API - Execute a transaction action](https://rdf4j.org/documentation/reference/rest-api/#tag/Transactions/paths/~1repositories~1%7BrepositoryID%7D~1transactions~1%7BtransactionID%7D/put)
                for the list of supported query parameters.
        """
        self._raise_for_closed()
        params = {"action": "UPDATE", "update": query}
        response = self.repo.http_client.put(
            self.url,
            params={**params, **kwargs},
        )
        response.raise_for_status()

    def upload(
        self,
        data: str | bytes | BinaryIO | Graph | Dataset,
        base_uri: str | None = None,
        content_type: str | None = None,
    ):
        """Upload and append statements to the repository.

        Parameters:
            data: The RDF data to upload.
            base_uri: The base URI to resolve against for any relative URIs in the data.
            content_type: The content type of the data. Defaults to
                `application/n-quads` when the value is `None`.
        """
        self._raise_for_closed()
        stream, should_close = rdf_payload_to_stream(data)
        headers = {"Content-Type": content_type or "application/n-quads"}
        params = {"action": "ADD"}
        if base_uri is not None:
            params["baseURI"] = base_uri
        try:
            response = self.repo.http_client.put(
                self.url,
                headers=headers,
                params=params,
                content=stream,
            )
            response.raise_for_status()
        finally:
            if should_close:
                stream.close()

    def get(
        self,
        subj: SubjectType = None,
        pred: PredicateType = None,
        obj: ObjectType = None,
        graph_name: URIRef | Iterable[URIRef] | str | None = None,
        infer: bool = True,
        content_type: str | None = None,
    ) -> Graph | Dataset:
        """Get RDF statements from the repository matching the filtering parameters.

        !!! Note
            The terms for `subj`, `pred`, `obj` or `graph_name` cannot be
            [`BNodes`][rdflib.term.BNode].

        Parameters:
            subj: Subject of the statement to filter by, or `None` to match all.
            pred: Predicate of the statement to filter by, or `None` to match all.
            obj: Object of the statement to filter by, or `None` to match all.
            graph_name: Graph name(s) to restrict to.

                The default value `None` queries all graphs.

                To query just the default graph, use
                [`DATASET_DEFAULT_GRAPH_ID`][rdflib.graph.DATASET_DEFAULT_GRAPH_ID].

            infer: Specifies whether inferred statements should be included in the
                result.
            content_type: The content type of the response.
                A triple-based format returns a [Graph][rdflib.graph.Graph], while a
                quad-based format returns a [`Dataset`][rdflib.graph.Dataset].

        Returns:
            A [`Graph`][rdflib.graph.Graph] or [`Dataset`][rdflib.graph.Dataset] object
                with the repository namespace prefixes bound to it.
        """
        self._raise_for_closed()
        validate_no_bnodes(subj, pred, obj, graph_name)
        if content_type is None:
            content_type = "application/n-quads"
        headers = {"Accept": content_type}
        params: dict[str, str] = {"action": "GET"}
        build_context_param(params, graph_name)
        build_spo_param(params, subj, pred, obj)
        build_infer_param(params, infer=infer)

        response = self.repo.http_client.put(
            self.url,
            headers=headers,
            params=params,
        )
        response.raise_for_status()
        triple_formats = [
            "application/n-triples",
            "text/turtle",
            "application/rdf+xml",
        ]
        try:
            if content_type in triple_formats:
                retval = Graph().parse(data=response.text, format=content_type)
            else:
                retval = Dataset().parse(data=response.text, format=content_type)
            for result in self.repo.namespaces.list():
                retval.bind(result.prefix, result.namespace, replace=True)
            return retval
        except Exception as err:
            raise RDFLibParserError(f"Error parsing RDF: {err}") from err

    def delete(
        self,
        data: str | bytes | BinaryIO | Graph | Dataset,
        base_uri: str | None = None,
        content_type: str | None = None,
    ) -> None:
        """Delete statements from the repository.

        !!! Note
            This function operates differently to
            [`Repository.delete`][rdflib.contrib.rdf4j.client.Repository.delete]
            as it does not use filter parameters. Instead, it expects a data payload.
            See the notes from
            [graphdb.js#Deleting](https://github.com/Ontotext-AD/graphdb.js?tab=readme-ov-file#deleting-1)
            for more information.

        Parameters:
            data: The RDF data to upload.
            base_uri: The base URI to resolve against for any relative URIs in the data.
            content_type: The content type of the data. Defaults to
                `application/n-quads` when the value is `None`.
        """
        self._raise_for_closed()
        params: dict[str, str] = {"action": "DELETE"}
        stream, should_close = rdf_payload_to_stream(data)
        headers = {"Content-Type": content_type or "application/n-quads"}
        if base_uri is not None:
            params["baseURI"] = base_uri
        try:
            response = self.repo.http_client.put(
                self.url,
                headers=headers,
                params=params,
                content=stream,
            )
            response.raise_for_status()
        finally:
            if should_close:
                stream.close()


class RepositoryManager:
    """A client to manage server-level repository operations.

    Parameters:
        http_client: The httpx.Client instance.
    """

    def __init__(self, http_client: httpx.Client):
        self._http_client = http_client

    @property
    def http_client(self):
        return self._http_client

    def list(self) -> list[RepositoryListingResult]:
        """List all available repositories.

        Returns:
            list[RepositoryListingResult]: List of repository results.

        Raises:
            RepositoryResponseFormatError: If the response format is unrecognized.
        """
        headers = {
            "Accept": "application/sparql-results+json",
        }
        response = self.http_client.get("/repositories", headers=headers)
        response.raise_for_status()

        try:
            data = response.json()
            results = data["results"]["bindings"]
            return [
                RepositoryListingResult(
                    identifier=repo["id"]["value"],
                    uri=repo["uri"]["value"],
                    readable=repo["readable"]["value"],
                    writable=repo["writable"]["value"],
                    title=repo.get("title", {}).get("value"),
                )
                for repo in results
            ]
        except (KeyError, ValueError) as err:
            raise RepositoryResponseFormatError(f"Unrecognised response format: {err}")

    def get(self, repository_id: str) -> Repository:
        """Get a repository by ID.

        !!! Note
            This performs a health check before returning the repository object.

        Parameters:
            repository_id: The identifier of the repository.

        Returns:
            Repository: The repository instance.

        Raises:
            RepositoryNotFoundError: If the repository is not found.
            RepositoryNotHealthyError: If the repository is not healthy.
        """
        repo = Repository(repository_id, self.http_client)
        repo.health()
        return repo

    def create(
        self, repository_id: str, data: str, content_type: str = "text/turtle"
    ) -> Repository:
        """Create a new repository.

        Parameters:
            repository_id: The identifier of the repository.
            data: The repository configuration in RDF.
            content_type: The repository configuration content type.

        Raises:
            RepositoryAlreadyExistsError: If the repository already exists.
            RepositoryNotHealthyError: If the repository is not healthy.
        """
        try:
            headers = {"Content-Type": content_type}
            response = self.http_client.put(
                f"/repositories/{repository_id}", headers=headers, content=data
            )
            response.raise_for_status()
            return self.get(repository_id)
        except httpx.HTTPStatusError as err:
            if err.response.status_code == 409:
                raise RepositoryAlreadyExistsError(
                    f"Repository {repository_id} already exists."
                )
            raise

    def delete(self, repository_id: str) -> None:
        """Delete a repository.

        Parameters:
            repository_id: The identifier of the repository.

        Raises:
            RepositoryNotFoundError: If the repository is not found.
            RepositoryError: If the repository is not deleted successfully.
        """
        try:
            response = self.http_client.delete(f"/repositories/{repository_id}")
            response.raise_for_status()
            if response.status_code != 204:
                raise RepositoryError(
                    f"Unexpected response status code when deleting repository {repository_id}: {response.status_code} - {response.text.strip()}"
                )
        except httpx.HTTPStatusError as err:
            if err.response.status_code == 404:
                raise RepositoryNotFoundError(f"Repository {repository_id} not found.")
            raise


class RDF4JClient:
    """RDF4J client.

    This client and its inner management objects perform HTTP requests via
    httpx and may raise httpx-specific exceptions. Errors documented by RDF4J
    in its protocol specification are mapped to specific exceptions in this
    library where applicable. Error mappings are documented on each management
    method. The underlying httpx client is reused across requests, and
    connection pooling is handled automatically by httpx.

    Parameters:
        base_url: The base URL of the RDF4J server.
        auth: Authentication credentials. Can be a tuple (username, password) for
            basic auth, or a string for token-based auth (e.g., "GDB <token>")
            which is added as the Authorization header.
        timeout: Request timeout in seconds or an httpx.Timeout for fine-grained control (default: 30.0).
        kwargs: Additional keyword arguments to pass to the httpx.Client.
    """

    def __init__(
        self,
        base_url: str,
        auth: tuple[str, str] | str | None = None,
        timeout: float | httpx.Timeout = 30.0,
        **kwargs: Any,
    ):
        if not base_url.endswith("/"):
            base_url += "/"

        httpx_auth: tuple[str, str] | None = None
        if isinstance(auth, tuple):
            httpx_auth = auth
        elif isinstance(auth, str):
            headers = kwargs.get("headers", {})
            headers["Authorization"] = auth
            kwargs["headers"] = headers

        self._http_client = httpx.Client(
            base_url=base_url, auth=httpx_auth, timeout=timeout, **kwargs
        )
        self._repository_manager = RepositoryManager(self.http_client)
        try:
            protocol_version = self.protocol
        except httpx.RequestError as err:
            self.close()
            raise RDF4JUnsupportedProtocolError(
                f"Failed to check protocol version: {err}"
            ) from err
        if protocol_version < 12:
            self.close()
            raise RDF4JUnsupportedProtocolError(
                f"RDF4J server protocol version {protocol_version} is not supported. Minimum required version is 12."
            )

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

    @property
    def http_client(self):
        return self._http_client

    @property
    def repositories(self) -> RepositoryManager:
        """Server-level repository management operations."""
        return self._repository_manager

    @property
    def protocol(self) -> float:
        """The RDF4J REST API protocol version.

        Returns:
            The protocol version number.
        """
        response = self.http_client.get("/protocol", headers={"Accept": "text/plain"})
        response.raise_for_status()
        return float(response.text.strip())

    def close(self):
        """Close the underlying httpx.Client."""
        self.http_client.close()
