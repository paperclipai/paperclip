"""GraphDB client module."""

from __future__ import annotations

import json
import os
import pathlib
import typing as t

import httpx

import rdflib.contrib.rdf4j
from rdflib import Graph, Literal, URIRef
from rdflib.contrib.graphdb.exceptions import (
    BadRequestError,
    ConflictError,
    ForbiddenError,
    InternalServerError,
    NotFoundError,
    PreconditionFailedError,
    RepositoryNotFoundError,
    RepositoryNotHealthyError,
    ResponseFormatError,
    ServiceUnavailableError,
    UnauthorisedError,
)
from rdflib.contrib.graphdb.models import (
    AccessControlEntry,
    AuthenticatedUser,
    BackupOperationBean,
    ClearGraphAccessControlEntry,
    ClusterRequest,
    FreeAccessSettings,
    GraphDBRepository,
    ImportSettings,
    InfrastructureStatistics,
    NodeStatus,
    ParserSettings,
    PluginAccessControlEntry,
    RepositoryConfigBean,
    RepositoryConfigBeanCreate,
    RepositorySizeInfo,
    RepositoryStatistics,
    ServerImportBody,
    StatementAccessControlEntry,
    StructuresStatistics,
    SystemAccessControlEntry,
    User,
    UserCreate,
    UserUpdate,
    _parse_operation,
    _parse_plugin,
    _parse_policy,
    _parse_role,
)
from rdflib.contrib.graphdb.util import (
    extract_filename_from_content_disposition,
    infer_filename_from_fileobj,
)
from rdflib.contrib.rdf4j import RDF4JClient

FileContent = t.Union[
    bytes,
    str,
    t.IO[bytes],
    t.Tuple[t.Optional[str], t.Union[bytes, str, t.IO[bytes]]],
    t.Tuple[t.Optional[str], t.Union[bytes, str, t.IO[bytes]], t.Optional[str]],
]

FilesType = t.Union[
    t.Mapping[str, FileContent],
    t.Iterable[t.Tuple[str, FileContent]],
]

_ALLOWED_FGAC_SCOPES = {"statement", "clear_graph", "plugin", "system"}


class AccessControlListManagement:
    """Manage fine-grained access control lists for GraphDB repositories."""

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

    def list(
        self,
        scope: t.Literal["statement", "clear_graph", "plugin", "system"] | None = None,
        operation: t.Literal["read", "write", "*"] | None = None,
        subject: str | URIRef | None = None,
        predicate: str | URIRef | None = None,
        obj: str | URIRef | Literal | None = None,
        graph: t.Literal["*", "named", "default"] | URIRef | Graph | None = None,
        plugin: str | None = None,
        role: str | None = None,
        policy: t.Literal["allow", "deny", "abstain"] | None = None,
    ) -> t.List[
        SystemAccessControlEntry
        | StatementAccessControlEntry
        | PluginAccessControlEntry
        | ClearGraphAccessControlEntry
    ]:
        """
        List ACL rules for the repository.

        Parameters:
            scope: The scope of the FGAC rule (`statement`, `clear_graph`, `plugin`, `system`).
            operation: The operation of the FGAC rule (`read`, `write`, `*`).
            subject: The subject of the FGAC rule in Turtle format (for example, `<http://example.com/Mary>`).
            predicate: The predicate of the FGAC rule in Turtle format (for example, `<http://www.w3.org/2000/01/rdf-schema#label>`).
            obj: The object of the FGAC rule in Turtle format (for example, `"Mary"@en`).
            graph: The graph of the FGAC rule in Turtle format (for example, `<http://example.org/graphs/graph1>`).
            plugin: The plugin name for the FGAC rule with plugin scope (for example, `elasticsearch-connector`).
            role: The role associated with the FGAC rule.
            policy: The policy for the FGAC rule (`allow`, `deny`, `abstain`).

        Returns:
            A list of FGAC rules.

        Raises:
            ValueError: If the parameters are invalid.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            InternalServerError: If the server returns an internal error.
            ResponseFormatError: If the response cannot be parsed.
        """
        params: dict[str, str] = {}
        if scope is not None:
            if scope not in _ALLOWED_FGAC_SCOPES:
                raise ValueError(f"Invalid FGAC scope filter: {scope!r}")
            params["scope"] = scope
        if operation is not None:
            params["operation"] = _parse_operation(operation)
        if subject is not None:
            if isinstance(subject, URIRef):
                params["subject"] = subject.n3()
            elif isinstance(subject, str):
                params["subject"] = subject
            else:
                raise ValueError(f"Invalid FGAC subject filter: {subject!r}")
        if predicate is not None:
            if isinstance(predicate, URIRef):
                params["predicate"] = predicate.n3()
            elif isinstance(predicate, str):
                params["predicate"] = predicate
            else:
                raise ValueError(f"Invalid FGAC predicate filter: {predicate!r}")
        if obj is not None:
            if isinstance(obj, (URIRef, Literal)):
                params["object"] = obj.n3()
            elif isinstance(obj, str):
                params["object"] = obj
            else:
                raise ValueError(f"Invalid FGAC object filter: {obj!r}")
        if graph is not None:
            if isinstance(graph, URIRef):
                params["context"] = graph.n3()
            elif isinstance(graph, Graph):
                params["context"] = graph.identifier.n3()
            elif isinstance(graph, str):
                params["context"] = graph
            else:
                raise ValueError(f"Invalid FGAC graph filter: {graph!r}")
        if plugin is not None:
            params["plugin"] = _parse_plugin(plugin)
        if role is not None:
            params["role"] = _parse_role(role)
        if policy is not None:
            params["policy"] = _parse_policy(policy)

        try:
            response = self._http_client.get(
                f"/rest/repositories/{self.identifier}/acl", params=params
            )
            response.raise_for_status()
            try:
                payload = response.json()
            except (ValueError, TypeError) as err:
                raise ResponseFormatError(
                    f"Failed to parse GraphDB response: {err}"
                ) from err

            if not isinstance(payload, list):
                raise ResponseFormatError(
                    "Failed to parse GraphDB response: expected a list of ACL entries."
                )

            try:
                return [AccessControlEntry.from_dict(acl) for acl in payload]
            except (ValueError, TypeError) as err:
                raise ResponseFormatError(
                    f"Failed to parse GraphDB response: {err}"
                ) from err
        except httpx.HTTPStatusError as err:
            status = err.response.status_code
            if status == 401:
                raise UnauthorisedError(
                    f"Request is unauthorised: {err.response.text}"
                ) from err
            elif status == 403:
                raise ForbiddenError(
                    f"Request is forbidden: {err.response.text}"
                ) from err
            elif status == 500:
                raise InternalServerError(
                    f"Internal server error: {err.response.text}"
                ) from err
            raise

    def set(self, acl_rules: t.Sequence[AccessControlEntry]):
        """
        Set ACL rules for the repository.

        !!! Note
            This method overwrites existing ACL rules in the repository.
            If you want to add new rules without overwriting existing ones,
            use the [`add`][rdflib.contrib.graphdb.client.AccessControlListManagement.add] method.

        Parameters:
            acl_rules: The list of ACL rules to set.

        Raises:
            BadRequestError: If the request is invalid.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            InternalServerError: If the server returns an internal error.
            ValueError: If the ACL rules are not provided as a sequence or are not AccessControlEntry instances.
        """
        acl_rules_list = list(acl_rules)
        if any(not isinstance(rule, AccessControlEntry) for rule in acl_rules_list):
            raise ValueError("All ACL rules must be AccessControlEntry instances.")

        payload = [rule.as_dict() for rule in acl_rules_list]
        headers = {"Content-Type": "application/json"}
        try:
            response = self._http_client.put(
                f"/rest/repositories/{self.identifier}/acl",
                headers=headers,
                json=payload,
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as err:
            status = err.response.status_code
            if status == 400:
                raise BadRequestError(f"Invalid request: {err.response.text}") from err
            elif status == 401:
                raise UnauthorisedError(
                    f"Request is unauthorised: {err.response.text}"
                ) from err
            elif status == 403:
                raise ForbiddenError(
                    f"Request is forbidden: {err.response.text}"
                ) from err
            elif status == 500:
                raise InternalServerError(
                    f"Internal server error: {err.response.text}"
                ) from err
            raise

    def add(
        self, acl_rules: t.Sequence[AccessControlEntry], position: int | None = None
    ):
        """
        Add ACL rules to the repository.

        You can also provide an optional URL request parameter position that specifies the position of the rules to be added.
        The position is zero-based (0 is the first position). If the position parameter is not provided, the rules are added at
        the end of the list.

        Parameters:
            acl_rules: The list of ACL rules to add.
            position: The zero-based position to add the rules at.

        Raises:
            BadRequestError: If the request is invalid.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            InternalServerError: If the server returns an internal error.
            ValueError: If the position is not an integer or is a negative integer.
            ValueError: If the ACL rules are not provided as a sequence or are not AccessControlEntry instances.
        """
        acl_rules_list = list(acl_rules)
        if any(not isinstance(rule, AccessControlEntry) for rule in acl_rules_list):
            raise ValueError("All ACL rules must be AccessControlEntry instances.")

        payload = [rule.as_dict() for rule in acl_rules_list]
        headers = {"Content-Type": "application/json"}
        params = {}
        if position is not None:
            if not isinstance(position, int):
                raise ValueError("Position must be an integer.")
            if position < 0:
                raise ValueError("Position must be a positive integer.")
            params["position"] = str(position)
        try:
            response = self._http_client.post(
                f"/rest/repositories/{self.identifier}/acl",
                headers=headers,
                json=payload,
                params=params,
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as err:
            status = err.response.status_code
            if status == 400:
                raise BadRequestError(f"Invalid request: {err.response.text}") from err
            elif status == 401:
                raise UnauthorisedError(
                    f"Request is unauthorised: {err.response.text}"
                ) from err
            elif status == 403:
                raise ForbiddenError(
                    f"Request is forbidden: {err.response.text}"
                ) from err
            elif status == 500:
                raise InternalServerError(
                    f"Internal server error: {err.response.text}"
                ) from err
            raise

    def delete(self, acl_rules: t.Sequence[AccessControlEntry]):
        """
        Delete ACL rules from the repository.

        The provided FGAC rules are removed from the list regardless of their position.

        Parameters:
            acl_rules: The list of ACL rules to delete.

        Raises:
            BadRequestError: If the request is invalid.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            InternalServerError: If the server returns an internal error.
            ValueError: If the ACL rules are not provided as a sequence or are not AccessControlEntry instances.
        """
        acl_rules_list = list(acl_rules)
        if any(not isinstance(rule, AccessControlEntry) for rule in acl_rules_list):
            raise ValueError("All ACL rules must be AccessControlEntry instances.")

        payload = [rule.as_dict() for rule in acl_rules_list]
        headers = {"Content-Type": "application/json"}
        try:
            response = self._http_client.request(
                method="DELETE",
                url=f"/rest/repositories/{self.identifier}/acl",
                headers=headers,
                json=payload,
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as err:
            status = err.response.status_code
            if status == 400:
                raise BadRequestError(f"Invalid request: {err.response.text}") from err
            elif status == 401:
                raise UnauthorisedError(
                    f"Request is unauthorised: {err.response.text}"
                ) from err
            elif status == 403:
                raise ForbiddenError(
                    f"Request is forbidden: {err.response.text}"
                ) from err
            elif status == 500:
                raise InternalServerError(
                    f"Internal server error: {err.response.text}"
                ) from err
            raise


class ClusterGroupManagement:
    """Manage and monitor GraphDB cluster configurations."""

    def __init__(self, http_client: httpx.Client):
        self._http_client = http_client

    @property
    def http_client(self):
        return self._http_client

    def truncate_log(self) -> None:
        """Truncate the GraphDB cluster log.

        The truncate log operation is used to free up storage space on all cluster nodes by clearing the
        current transaction log and removing cached recovery snapshots.

        Raises:
            ResponseFormatError: If the response is not in the expected format.
            BadRequestError: If the request is invalid.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
        """
        try:
            response = self.http_client.post("/rest/cluster/truncate-log")
            response.raise_for_status()
        except httpx.HTTPStatusError as err:
            status = err.response.status_code
            if status == 400:
                raise BadRequestError(f"Invalid request: {err.response.text}") from err
            elif status == 401:
                raise UnauthorisedError(
                    f"Request is unauthorised: {err.response.text}"
                ) from err
            elif status == 403:
                raise ForbiddenError(
                    f"Request is forbidden: {err.response.text}"
                ) from err
            raise

    def get_config(self) -> ClusterRequest:
        """Get the GraphDB cluster configuration.

        Returns:
            Cluster configuration.

        Raises:
            ResponseFormatError: If the response is not in the expected format.
            UnauthorisedError: If the request is unauthorised.
            NotFoundError: If the cluster configuration is not found.
            InternalServerError: If the server returns an internal error.
        """
        try:
            headers = {"Accept": "application/json"}
            response = self.http_client.get("/rest/cluster/config", headers=headers)
            response.raise_for_status()
            try:
                return ClusterRequest.from_dict(response.json())
            except (KeyError, TypeError, ValueError) as err:
                raise ResponseFormatError(
                    f"Failed to parse cluster configuration: {err}"
                ) from err
        except httpx.HTTPStatusError as err:
            status = err.response.status_code
            if status == 401:
                raise UnauthorisedError(
                    f"Request is unauthorised: {err.response.text}"
                ) from err
            elif status == 404:
                raise NotFoundError(
                    f"Cluster configuration not found: {err.response.text}"
                ) from err
            elif status == 500:
                raise InternalServerError(
                    f"Internal server error: {err.response.text}"
                ) from err
            raise

    def create_config(
        self,
        nodes: list[str],
        election_min_timeout: int | None = None,
        election_range_timeout: int | None = None,
        heartbeat_interval: int | None = None,
        message_size_kb: int | None = None,
        verification_timeout: int | None = None,
        transaction_log_maximum_size_gb: int | None = None,
        batch_update_interval: int | None = None,
    ) -> None:
        """Create a GraphDB cluster.

        Parameters:
            nodes: List of node addresses.
            election_min_timeout: The minimum wait time in milliseconds for a heartbeat from a leader.
            election_range_timeout: The variable portion of each waiting period in milliseconds for a heartbeat.
            heartbeat_interval: The interval in milliseconds between each heartbeat that is sent to follower nodes by the leader.
            message_size_kb: The size of the data blocks, in kilobytes, transferred during data replication streaming through the RPC protocol.
            verification_timeout: The amount of time in milliseconds that a follower node would wait before attempting to verify the last committed
                entry when the first verification is unsuccessful.
            transaction_log_maximum_size_gb: Maximum size of the transaction log in GBs. The transaction log will be automatically truncated if it
                becomes bigger than this value. The minimum transaction log size is 1 GB. Setting it to a negative value will disable automatic transaction
                log truncation.
            batch_update_interval: The interval in milliseconds between requesting updates from the primary cluster. Used only when the cluster is in
                secondary mode.

        Raises:
            BadRequestError: If the request is invalid.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            ConflictError: If the cluster configuration already exists.
            PreconditionFailedError: If the cluster is not in a state to create a configuration.
        """
        try:
            if not isinstance(nodes, list) or any(
                not isinstance(node, str) for node in nodes
            ):
                raise TypeError("nodes must be a list[str].")

            _int_fields: list[tuple[str, int | None]] = [
                ("election_min_timeout", election_min_timeout),
                ("election_range_timeout", election_range_timeout),
                ("heartbeat_interval", heartbeat_interval),
                ("message_size_kb", message_size_kb),
                ("verification_timeout", verification_timeout),
                ("transaction_log_maximum_size_gb", transaction_log_maximum_size_gb),
                ("batch_update_interval", batch_update_interval),
            ]
            for field_name, value in _int_fields:
                if value is not None and type(value) is not int:
                    raise TypeError(f"{field_name} must be an int if provided.")

            payload: dict[str, t.Any] = {"nodes": nodes}
            if election_min_timeout is not None:
                payload["electionMinTimeout"] = election_min_timeout
            if election_range_timeout is not None:
                payload["electionRangeTimeout"] = election_range_timeout
            if heartbeat_interval is not None:
                payload["heartbeatInterval"] = heartbeat_interval
            if message_size_kb is not None:
                payload["messageSizeKB"] = message_size_kb
            if verification_timeout is not None:
                payload["verificationTimeout"] = verification_timeout
            if transaction_log_maximum_size_gb is not None:
                payload["transactionLogMaximumSizeGB"] = transaction_log_maximum_size_gb
            if batch_update_interval is not None:
                payload["batchUpdateInterval"] = batch_update_interval

            headers = {"Content-Type": "application/json"}
            response = self.http_client.post(
                "/rest/cluster/config", headers=headers, json=payload
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as err:
            status = err.response.status_code
            if status == 400:
                raise BadRequestError(f"Invalid request: {err.response.text}") from err
            elif status == 401:
                raise UnauthorisedError(
                    f"Request is unauthorised: {err.response.text}"
                ) from err
            elif status == 403:
                raise ForbiddenError(
                    f"Request is forbidden: {err.response.text}"
                ) from err
            elif status == 409:
                raise ConflictError(
                    f"Cluster configuration already exists: {err.response.text}"
                ) from err
            elif status == 412:
                raise PreconditionFailedError(
                    f"Precondition failed: {err.response.text}"
                ) from err
            raise

    def delete_config(self, force: bool | None = None) -> dict[str, str]:
        """Delete the GraphDB cluster.

        By default, the cluster group cannot be deleted if one or more nodes are unreachable.
        Reachable here means that the nodes are not in status `NO_CONNECTION`, therefore there is an
        RPC connection to them.

        Parameter:
            force: When set to `True`, the cluster configuration will be deleted only on the reachable nodes and
                the response will always succeed.

        Returns:
            A dictionary where the node address is the key and the deletion status message is the value.

        Raises:
            ResponseFormatError: If the response is not in the expected format.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            PreconditionFailedError: If one or more nodes in the group are not reachable and force is not set to `True`.
        """
        params: dict[str, str] | None = None
        if force is not None:
            params = {"force": str(force).lower()}
        try:
            headers = {"Accept": "application/json"}
            if params is None:
                response = self.http_client.delete(
                    "/rest/cluster/config", headers=headers
                )
            else:
                response = self.http_client.delete(
                    "/rest/cluster/config", headers=headers, params=params
                )
            response.raise_for_status()
            try:
                payload = response.json()
            except (ValueError, TypeError) as err:
                raise ResponseFormatError(
                    f"Failed to parse cluster deletion response: {err}"
                ) from err
            if not isinstance(payload, dict):
                raise ResponseFormatError(
                    "Failed to parse cluster deletion response: expected a JSON object."
                )
            if not all(
                isinstance(key, str) and isinstance(value, str)
                for key, value in payload.items()
            ):
                raise ResponseFormatError(
                    "Failed to parse cluster deletion response: expected string keys and values."
                )
            return t.cast(dict[str, str], payload)
        except httpx.HTTPStatusError as err:
            status = err.response.status_code
            if status == 401:
                raise UnauthorisedError(
                    f"Request is unauthorised: {err.response.text}"
                ) from err
            elif status == 403:
                raise ForbiddenError(
                    f"Request is forbidden: {err.response.text}"
                ) from err
            elif status == 412:
                raise PreconditionFailedError(
                    f"Precondition failed: {err.response.text}"
                ) from err
            raise

    def update_config(
        self,
        election_min_timeout: int | None = None,
        election_range_timeout: int | None = None,
        heartbeat_interval: int | None = None,
        message_size_kb: int | None = None,
        verification_timeout: int | None = None,
        transaction_log_maximum_size_gb: int | None = None,
        batch_update_interval: int | None = None,
    ) -> ClusterRequest:
        """Update the GraphDB cluster configuration.

        If one of the cluster nodes is down or was not able to accept the new configuration,
        the operation will not be successful. A total consensus between the nodes is required.
        In case one or more of them cannot append the new configuration, it will be rejected
        by all of the nodes.

        Parameters:
            election_min_timeout: The minimum wait time in milliseconds for a heartbeat from a leader.
            election_range_timeout: The variable portion of each waiting period in milliseconds for a heartbeat.
            heartbeat_interval: The interval in milliseconds between each heartbeat that is sent to follower nodes by the leader.
            message_size_kb: The size of the data blocks, in kilobytes, transferred during data replication streaming through the RPC protocol.
            verification_timeout: The amount of time in milliseconds that a follower node would wait before attempting to verify the last committed
                entry when the first verification is unsuccessful.
            transaction_log_maximum_size_gb: Maximum size of the transaction log in GBs. The transaction log will be automatically truncated if it
                becomes bigger than this value. The minimum transaction log size is 1 GB. Setting it to a negative value will disable automatic transaction
                log truncation.
            batch_update_interval: The interval in milliseconds between requesting updates from the primary cluster. Used only when the cluster is in
                secondary mode.

        Returns:
            The updated cluster configuration.

        Raises:
            BadRequestError: If the request is invalid.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            PreconditionFailedError: If one or more nodes in the group are not reachable.
        """
        _int_fields: list[tuple[str, int | None]] = [
            ("election_min_timeout", election_min_timeout),
            ("election_range_timeout", election_range_timeout),
            ("heartbeat_interval", heartbeat_interval),
            ("message_size_kb", message_size_kb),
            ("verification_timeout", verification_timeout),
            ("transaction_log_maximum_size_gb", transaction_log_maximum_size_gb),
            ("batch_update_interval", batch_update_interval),
        ]
        for field_name, value in _int_fields:
            if value is not None and type(value) is not int:
                raise TypeError(f"{field_name} must be an int if provided.")

        payload: dict[str, t.Any] = {}
        if election_min_timeout is not None:
            payload["electionMinTimeout"] = election_min_timeout
        if election_range_timeout is not None:
            payload["electionRangeTimeout"] = election_range_timeout
        if heartbeat_interval is not None:
            payload["heartbeatInterval"] = heartbeat_interval
        if message_size_kb is not None:
            payload["messageSizeKB"] = message_size_kb
        if verification_timeout is not None:
            payload["verificationTimeout"] = verification_timeout
        if transaction_log_maximum_size_gb is not None:
            payload["transactionLogMaximumSizeGB"] = transaction_log_maximum_size_gb
        if batch_update_interval is not None:
            payload["batchUpdateInterval"] = batch_update_interval

        headers = {"Accept": "application/json"}
        try:
            response = self.http_client.patch(
                "/rest/cluster/config", headers=headers, json=payload
            )
            response.raise_for_status()
            try:
                return ClusterRequest.from_dict(response.json())
            except (KeyError, TypeError, ValueError) as err:
                raise ResponseFormatError(
                    f"Failed to parse updated cluster configuration: {err}"
                ) from err
        except httpx.HTTPStatusError as err:
            status = err.response.status_code
            if status == 400:
                raise BadRequestError(f"Invalid request: {err.response.text}") from err
            elif status == 401:
                raise UnauthorisedError(
                    f"Request is unauthorised: {err.response.text}"
                ) from err
            elif status == 403:
                raise ForbiddenError(
                    f"Request is forbidden: {err.response.text}"
                ) from err
            elif status == 412:
                raise PreconditionFailedError(
                    f"Precondition failed: {err.response.text}"
                ) from err
            raise

    def add_tag(self, tag: str) -> None:
        """Add primary cluster tag.

        Parameters:
            tag: The identifier tag to add to the primary cluster.

        Raises:
            TypeError: If tag is not a string.
            ValueError: If tag is an empty string.
            BadRequestError: If the request is invalid.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            PreconditionFailedError: If the cluster is not in a state to add a tag.
        """
        if not isinstance(tag, str):
            raise TypeError("tag must be a string")
        if not tag:
            raise ValueError("tag must be a non-empty string")

        try:
            response = self.http_client.post(
                "/rest/cluster/config/tag", json={"tag": tag}
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as err:
            status = err.response.status_code
            if status == 400:
                raise BadRequestError(f"Invalid request: {err.response.text}") from err
            elif status == 401:
                raise UnauthorisedError(
                    f"Request is unauthorised: {err.response.text}"
                ) from err
            elif status == 403:
                raise ForbiddenError(
                    f"Request is forbidden: {err.response.text}"
                ) from err
            elif status == 412:
                raise PreconditionFailedError(
                    f"Precondition failed: {err.response.text}"
                ) from err
            raise

    def delete_tag(self, tag: str) -> None:
        """Remove primary cluster tag.

        Parameters:
            tag: The identifier tag to remove from the primary cluster.

        Raises:
            TypeError: If tag is not a string.
            ValueError: If tag is an empty string.
            BadRequestError: If the request is invalid.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            PreconditionFailedError: If the cluster is not in a state to delete a tag.
        """
        if not isinstance(tag, str):
            raise TypeError("tag must be a string")
        if not tag:
            raise ValueError("tag must be a non-empty string")

        headers = {"Content-Type": "application/json"}
        try:
            response = self.http_client.request(
                method="DELETE",
                url="/rest/cluster/config/tag",
                headers=headers,
                json={"tag": tag},
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as err:
            status = err.response.status_code
            if status == 400:
                raise BadRequestError(f"Invalid request: {err.response.text}") from err
            elif status == 401:
                raise UnauthorisedError(
                    f"Request is unauthorised: {err.response.text}"
                ) from err
            elif status == 403:
                raise ForbiddenError(
                    f"Request is forbidden: {err.response.text}"
                ) from err
            elif status == 412:
                raise PreconditionFailedError(
                    f"Precondition failed: {err.response.text}"
                ) from err
            raise

    def enable_secondary_mode(self, primary_node: str, tag: str) -> None:
        """Enable cluster secondary mode.

        You can switch any healthy primary cluster to secondary mode by providing the RPC address
        of the primary cluster node that it will replicate and then declaring the tag used to identify
        it. Once you have switched a cluster to secondary mode, all of its current repositories and
        data will be removed and replaced with the data and state of the primary cluster.

        !!! Note
            You can enable the secondary cluster mode from any of the nodes of a cluster, not just the
            leader node. You can also use any of the healthy nodes of the primary cluster to connect to
            that cluster.

        !!! Warning
            Enabling the secondary mode will delete all data on the secondary cluster and replicate
            the state of the primary cluster.

        Parameters:
            primary_node: The RPC address of one of the healthy nodes of the primary cluster.
            tag: The identifier tag of the primary cluster.

        Raises:
            TypeError: If primary_node or tag is not a string.
            ValueError: If primary_node or tag is an empty string.
            BadRequestError: If the request is invalid.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            PreconditionFailedError: If the cluster is not in a state to enable secondary mode.
        """
        if not isinstance(primary_node, str):
            raise TypeError("primary_node must be a string")
        if not primary_node:
            raise ValueError("primary_node must be a non-empty string")
        if not isinstance(tag, str):
            raise TypeError("tag must be a string")
        if not tag:
            raise ValueError("tag must be a non-empty string")

        payload = {"primaryNode": primary_node, "tag": tag}
        try:
            response = self.http_client.post(
                "/rest/cluster/config/secondary-mode", json=payload
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as err:
            status = err.response.status_code
            if status == 400:
                raise BadRequestError(f"Invalid request: {err.response.text}") from err
            elif status == 401:
                raise UnauthorisedError(
                    f"Request is unauthorised: {err.response.text}"
                ) from err
            elif status == 403:
                raise ForbiddenError(
                    f"Request is forbidden: {err.response.text}"
                ) from err
            elif status == 412:
                raise PreconditionFailedError(
                    f"Precondition failed: {err.response.text}"
                ) from err
            raise

    def disable_secondary_mode(self) -> None:
        """Disable cluster secondary mode.

        Once in secondary mode, you can disable secondary mode and then you will no longer be in
        that mode. Doing this will stop the pulling of updates from the primary cluster.

        Raises:
            BadRequestError: If the request is invalid.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            PreconditionFailedError: If the cluster is not in a state to disable secondary mode.
        """
        try:
            response = self.http_client.delete("/rest/cluster/config/secondary-mode")
            response.raise_for_status()
        except httpx.HTTPStatusError as err:
            status = err.response.status_code
            if status == 400:
                raise BadRequestError(f"Invalid request: {err.response.text}") from err
            elif status == 401:
                raise UnauthorisedError(
                    f"Request is unauthorised: {err.response.text}"
                ) from err
            elif status == 403:
                raise ForbiddenError(
                    f"Request is forbidden: {err.response.text}"
                ) from err
            elif status == 412:
                raise PreconditionFailedError(
                    f"Precondition failed: {err.response.text}"
                ) from err
            raise

    def add_nodes(self, nodes: list[str]) -> None:
        """Add nodes to the GraphDB cluster.

        Parameters:
            nodes: List of node addresses to add to the cluster.

        Raises:
            TypeError: If nodes is not a list of strings.
            BadRequestError: If the request is invalid.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            PreconditionFailedError: If one or more nodes in the group are not reachable.
        """
        if not isinstance(nodes, list) or any(
            not isinstance(node, str) for node in nodes
        ):
            raise TypeError("nodes must be a list[str].")

        payload = {"nodes": nodes}
        headers = {"Content-Type": "application/json"}
        try:
            response = self.http_client.post(
                "/rest/cluster/config/node", headers=headers, json=payload
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as err:
            status = err.response.status_code
            if status == 400:
                raise BadRequestError(f"Invalid request: {err.response.text}") from err
            elif status == 401:
                raise UnauthorisedError(
                    f"Request is unauthorised: {err.response.text}"
                ) from err
            elif status == 403:
                raise ForbiddenError(
                    f"Request is forbidden: {err.response.text}"
                ) from err
            elif status == 412:
                raise PreconditionFailedError(
                    f"Precondition failed: {err.response.text}"
                ) from err
            raise

    def remove_nodes(self, nodes: list[str]) -> None:
        """Remove nodes from the GraphDB cluster.

        Parameters:
            nodes: List of node addresses to remove from the cluster.

        Raises:
            TypeError: If nodes is not a list of strings.
            BadRequestError: If the request is invalid.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            PreconditionFailedError: If one or more nodes in the group are not reachable.
        """
        if not isinstance(nodes, list) or any(
            not isinstance(node, str) for node in nodes
        ):
            raise TypeError("nodes must be a list[str].")

        payload = {"nodes": nodes}
        try:
            response = self.http_client.request(
                method="DELETE",
                url="/rest/cluster/config/node",
                json=payload,
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as err:
            status = err.response.status_code
            if status == 400:
                raise BadRequestError(f"Invalid request: {err.response.text}") from err
            elif status == 401:
                raise UnauthorisedError(
                    f"Request is unauthorised: {err.response.text}"
                ) from err
            elif status == 403:
                raise ForbiddenError(
                    f"Request is forbidden: {err.response.text}"
                ) from err
            elif status == 412:
                raise PreconditionFailedError(
                    f"Precondition failed: {err.response.text}"
                ) from err
            raise

    def replace_nodes(self, add_nodes: list[str], remove_nodes: list[str]) -> None:
        """Replace nodes in the GraphDB cluster.

        Parameters:
            add_nodes: List of node addresses to add to the cluster.
            remove_nodes: List of node addresses to remove from the cluster.

        Raises:
            TypeError: If add_nodes or remove_nodes is not a list of strings.
            BadRequestError: If the request is invalid.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            PreconditionFailedError: If one or more nodes in the group are not reachable.
        """
        if not isinstance(add_nodes, list) or any(
            not isinstance(node, str) for node in add_nodes
        ):
            raise TypeError("add_nodes must be a list[str].")
        if not isinstance(remove_nodes, list) or any(
            not isinstance(node, str) for node in remove_nodes
        ):
            raise TypeError("remove_nodes must be a list[str].")

        payload = {"removeNodes": remove_nodes, "addNodes": add_nodes}
        try:
            response = self.http_client.patch("/rest/cluster/config/node", json=payload)
            response.raise_for_status()
        except httpx.HTTPStatusError as err:
            status = err.response.status_code
            if status == 400:
                raise BadRequestError(f"Invalid request: {err.response.text}") from err
            elif status == 401:
                raise UnauthorisedError(
                    f"Request is unauthorised: {err.response.text}"
                ) from err
            elif status == 403:
                raise ForbiddenError(
                    f"Request is forbidden: {err.response.text}"
                ) from err
            elif status == 412:
                raise PreconditionFailedError(
                    f"Precondition failed: {err.response.text}"
                ) from err
            raise

    def node_status(self) -> NodeStatus:
        """Get the status of this GraphDB cluster node.

        Returns:
            NodeStatus: The status of this GraphDB cluster node.

        Raises:
            ResponseFormatError: If the response cannot be parsed.
            BadRequestError: If the request is invalid.
            NotFoundError: If the node status is not found.
            InternalServerError: If the internal server error.
        """
        try:
            headers = {"Accept": "application/json"}
            response = self.http_client.get(
                "/rest/cluster/node/status", headers=headers
            )
            response.raise_for_status()
            try:
                return NodeStatus.from_dict(response.json())
            except (KeyError, TypeError, ValueError) as err:
                raise ResponseFormatError(
                    f"Failed to parse node status: {err}"
                ) from err
        except httpx.HTTPStatusError as err:
            status = err.response.status_code
            if status == 400:
                raise BadRequestError(f"Invalid request: {err.response.text}") from err
            elif status == 404:
                raise NotFoundError(
                    f"Node status not found: {err.response.text}"
                ) from err
            elif status == 500:
                raise InternalServerError(
                    f"Internal server error: {err.response.text}"
                ) from err
            raise

    def group_status(self) -> list[NodeStatus]:
        """Get the status of the GraphDB cluster.

        Returns:
            A list of node statuses for the cluster group.

        Raises:
            ResponseFormatError: If the response cannot be parsed.
            BadRequestError: If the request is invalid.
            NotFoundError: If the group status is not found.
            InternalServerError: If the internal server error.
        """
        try:
            headers = {"Accept": "application/json"}
            response = self.http_client.get(
                "/rest/cluster/group/status", headers=headers
            )
            response.raise_for_status()
            try:
                data = response.json()
                return [NodeStatus.from_dict(item) for item in data]
            except (KeyError, TypeError, ValueError) as err:
                raise ResponseFormatError(
                    f"Failed to parse group status: {err}"
                ) from err
        except httpx.HTTPStatusError as err:
            status = err.response.status_code
            if status == 400:
                raise BadRequestError(f"Invalid request: {err.response.text}") from err
            elif status == 404:
                raise NotFoundError(
                    f"Group status not found: {err.response.text}"
                ) from err
            elif status == 500:
                raise InternalServerError(
                    f"Internal server error: {err.response.text}"
                ) from err
            raise


class Repository(rdflib.contrib.rdf4j.client.Repository):
    """GraphDB Repository client.

    Overrides specific methods of the RDF4J Repository class and also provides GraphDB-only functionality
    (such as FGAC ACL management) made available through the GraphDB REST API.

    Parameters:
        identifier: The identifier of the repository.
        http_client: The httpx.Client instance.
    """

    def __init__(self, identifier: str, http_client: httpx.Client):
        super().__init__(identifier, http_client)
        self._access_control_list_management = AccessControlListManagement(
            self.identifier, self.http_client
        )

    @property
    def acl(self) -> AccessControlListManagement:
        return self._access_control_list_management

    def health(self, timeout: int = 5) -> bool:
        """Repository health check.

        Parameters:
            timeout: A timeout parameter in seconds. If provided, the endpoint attempts
                to retrieve the repository within this timeout. If not, the passive
                check is performed.

        Returns:
            bool: True if the repository is healthy, otherwise an error is raised.

        Raises:
            RepositoryNotFoundError: If the repository is not found.
            RepositoryNotHealthyError: If the repository is not healthy.
        """
        try:
            params = {"passive": str(timeout)}
            response = self.http_client.get(
                f"/repositories/{self.identifier}/health", params=params
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

    def get_server_import_files(self) -> list[ImportSettings]:
        """Get server files available for import.

        Returns:
            A list of files available for import.

        Raises:
            ResponseFormatError: If the response format is invalid.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            InternalServerError: If the server returns an internal error.
        """
        try:
            headers = {"Accept": "application/json"}
            response = self.http_client.get(
                f"/rest/repositories/{self.identifier}/import/server",
                headers=headers,
            )
            response.raise_for_status()
            try:
                result = []
                for item in response.json():
                    # Convert nested parserSettings dict to ParserSettings instance
                    if "parserSettings" in item and isinstance(
                        item["parserSettings"], dict
                    ):
                        item["parserSettings"] = ParserSettings(
                            **item["parserSettings"]
                        )
                    result.append(ImportSettings(**item))
                return result
            except (ValueError, TypeError) as err:
                raise ResponseFormatError(f"Failed to parse response: {err}") from err
        except httpx.HTTPStatusError as err:
            if err.response.status_code == 401:
                raise UnauthorisedError(
                    f"Request is unauthorised: {err.response.text}"
                ) from err
            elif err.response.status_code == 403:
                raise ForbiddenError(
                    f"Request is forbidden: {err.response.text}"
                ) from err
            elif err.response.status_code == 500:
                raise InternalServerError(
                    f"Internal server error: {err.response.text}"
                ) from err
            raise

    def import_server_import_file(self, server_import_body: ServerImportBody) -> None:
        """Import a server file into the repository.

        Parameters:
            server_import_body: The server import body.

        Raises:
            BadRequestError: If the request is bad.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            NotFoundError: If the request is not found.
        """
        try:
            headers = {"Content-Type": "application/json"}
            response = self.http_client.post(
                f"/rest/repositories/{self.identifier}/import/server",
                headers=headers,
                json=server_import_body.as_dict(),
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as err:
            status = err.response.status_code
            if status == 400:
                raise BadRequestError(f"Bad request: {err.response.text}") from err
            elif status == 401:
                raise UnauthorisedError(
                    f"Request is unauthorised: {err.response.text}"
                ) from err
            elif status == 403:
                raise ForbiddenError(
                    f"Request is forbidden: {err.response.text}"
                ) from err
            elif status == 404:
                raise NotFoundError(
                    f"Request is not found: {err.response.text}"
                ) from err
            raise

    def cancel_server_import_file(self, name: str) -> None:
        """Cancel server file import operation.

        Parameters:
            name: The name of the file import to interrupt.

        Raises:
            BadRequestError: If the request is bad.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
        """
        try:
            params = {"name": name}
            response = self.http_client.delete(
                f"/rest/repositories/{self.identifier}/import/server",
                params=params,
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as err:
            status = err.response.status_code
            if status == 400:
                raise BadRequestError(f"Bad request: {err.response.text}") from err
            elif status == 401:
                raise UnauthorisedError(
                    f"Request is unauthorised: {err.response.text}"
                ) from err
            elif status == 403:
                raise ForbiddenError(
                    f"Request is forbidden: {err.response.text}"
                ) from err
            raise


class RepositoryManager(rdflib.contrib.rdf4j.client.RepositoryManager):
    """GraphDB Repository Manager.

    This manager client overrides specific RDF4J RepositoryManager class methods to provide GraphDB-specific implementations.
    """

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
        _repo = super().get(repository_id)
        return Repository(_repo.identifier, _repo.http_client)


class MonitoringManagement:
    """
    Monitor different GraphDB processes.
    """

    def __init__(self, http_client: httpx.Client):
        self._http_client = http_client

    @property
    def http_client(self):
        return self._http_client

    @property
    def structures(self) -> StructuresStatistics:
        """Get structures statistics.

        Returns:
            The structures statistics.

        Raises:
            ResponseFormatError: If the response format is invalid.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            InternalServerError: If the server returns an internal error.
            ServiceUnavailableError: If the server is unavailable.
        """
        try:
            headers = {"Accept": "application/json"}
            response = self.http_client.get("/rest/monitor/structures", headers=headers)
            response.raise_for_status()
            try:
                return StructuresStatistics(**response.json())
            except (ValueError, TypeError) as err:
                raise ResponseFormatError(f"Failed to parse response: {err}") from err
        except httpx.HTTPStatusError as err:
            status = err.response.status_code
            if status == 401:
                raise UnauthorisedError(
                    f"Request is unauthorised: {err.response.text}"
                ) from err
            elif status == 403:
                raise ForbiddenError(
                    f"Request is forbidden: {err.response.text}"
                ) from err
            elif status == 500:
                raise InternalServerError(
                    f"Internal server error: {err.response.text}"
                ) from err
            elif status == 503:
                raise ServiceUnavailableError(
                    f"Service is unavailable: {err.response.text}"
                ) from err
            raise

    def get_repo_stats(self, repository_id: str):
        """Get repository statistics.

        Parameters:
            repository_id: The identifier of the repository.

        Returns:
            RepositoryStatistics: The repository statistics.

        Raises:
            ResponseFormatError: If the response cannot be parsed.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            InternalServerError: If the server returns an internal error.
        """
        try:
            headers = {"Accept": "application/json"}
            response = self.http_client.get(
                f"/rest/monitor/repository/{repository_id}", headers=headers
            )
            response.raise_for_status()
            try:
                return RepositoryStatistics.from_dict(response.json())
            except (ValueError, TypeError, KeyError) as err:
                raise ResponseFormatError(f"Failed to parse response: {err}") from err
        except httpx.HTTPStatusError as err:
            status = err.response.status_code
            if status == 401:
                raise UnauthorisedError(
                    f"Request is unauthorised: {err.response.text}"
                ) from err
            elif status == 403:
                raise ForbiddenError(
                    f"Request is forbidden: {err.response.text}"
                ) from err
            elif status == 500:
                raise InternalServerError(
                    f"Internal server error: {err.response.text}"
                ) from err
            raise

    @property
    def infrastructure(self) -> InfrastructureStatistics:
        """Get all infrastructure statistics.

        Returns:
            InfrastructureStatistics: The infrastructure statistics.

        Raises:
            ResponseFormatError: If the response cannot be parsed.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            InternalServerError: If the server returns an internal error.
        """
        try:
            headers = {"Accept": "application/json"}
            response = self.http_client.get(
                "/rest/monitor/infrastructure", headers=headers
            )
            response.raise_for_status()
            try:
                return InfrastructureStatistics.from_dict(response.json())
            except (ValueError, TypeError, KeyError) as err:
                raise ResponseFormatError(f"Failed to parse response: {err}") from err
        except httpx.HTTPStatusError as err:
            status = err.response.status_code
            if status == 401:
                raise UnauthorisedError(
                    f"Request is unauthorised: {err.response.text}"
                ) from err
            elif status == 403:
                raise ForbiddenError(
                    f"Request is forbidden: {err.response.text}"
                ) from err
            elif status == 500:
                raise InternalServerError(
                    f"Internal server error: {err.response.text}"
                ) from err
            raise

    def cluster(self) -> str:
        """Get cluster statistics.

        !!! Note
            This endpoint is only available in GraphDB EE.

        Returns:
            Prometheus-style metrics.

        Raises:
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            InternalServerError: If the server returns an internal error.
            ServiceUnavailableError: If the server is unavailable.
        """
        try:
            headers = {"Accept": "text/plain"}
            response = self.http_client.get("/rest/monitor/cluster", headers=headers)
            response.raise_for_status()
            return response.text
        except httpx.HTTPStatusError as err:
            status = err.response.status_code
            if status == 401:
                raise UnauthorisedError(
                    f"Request is unauthorised: {err.response.text}"
                ) from err
            elif status == 403:
                raise ForbiddenError(
                    f"Request is forbidden: {err.response.text}"
                ) from err
            elif status == 500:
                raise InternalServerError(
                    f"Internal server error: {err.response.text}"
                ) from err
            elif status == 503:
                raise ServiceUnavailableError(
                    f"Service is unavailable: {err.response.text}"
                ) from err
            raise

    def backup(self) -> BackupOperationBean | None:
        """Track backup operations.

        Returns:
            On-going backup operations or `None` if no backup is in progress.

        Raises:
            ResponseFormatError: If the response cannot be parsed.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            InternalServerError: If the server returns an internal error.
            ServiceUnavailableError: If the server is unavailable.
        """
        try:
            headers = {"Accept": "application/json"}
            response = self.http_client.get("/rest/monitor/backup", headers=headers)
            response.raise_for_status()
            try:
                data = response.json()
                if not data:
                    return None
                return BackupOperationBean.from_dict(data)
            except (ValueError, TypeError, KeyError) as err:
                raise ResponseFormatError(f"Failed to parse response: {err}") from err
        except httpx.HTTPStatusError as err:
            status = err.response.status_code
            if status == 401:
                raise UnauthorisedError(
                    f"Request is unauthorised: {err.response.text}"
                ) from err
            elif status == 403:
                raise ForbiddenError(
                    f"Request is forbidden: {err.response.text}"
                ) from err
            elif status == 500:
                raise InternalServerError(
                    f"Internal server error: {err.response.text}"
                ) from err
            elif status == 503:
                raise ServiceUnavailableError(
                    f"Service is unavailable: {err.response.text}"
                ) from err
            raise


class RecoveryManagement:
    """
    GraphDB Recovery Management client.
    """

    def __init__(self, http_client: httpx.Client):
        self._http_client = http_client

    @property
    def http_client(self):
        return self._http_client

    def restore(
        self,
        backup: bytes | bytearray | memoryview | t.IO[bytes] | str | os.PathLike[str],
        repositories: list[str] | None = None,
        restore_system_data: bool | None = None,
        remove_stale_repositories: bool | None = None,
    ) -> None:
        """Restore GraphDB instance from a backup archive.

        Parameters:
            backup: Backup archive content as bytes/bytes-like, a binary file-like
                object, or a filesystem path to a `.tar` produced by
                [`backup`][rdflib.contrib.graphdb.client.RecoveryManagement.backup].
            repositories: List of repositories to restore. If `None` (default), the
                parameter is omitted and all repositories found in the backup are
                restored. If an empty list (`[]`) is provided, no repositories from
                the backup are restored.
            restore_system_data: Whether to restore system data (users, saved queries,
                visual graphs, etc.). If omitted, GraphDB defaults to `false`. If
                `true` and no system data exists in the backup, GraphDB returns an
                error.
            remove_stale_repositories: Whether to remove repositories on the target
                instance that are not restored from the backup. If omitted, GraphDB
                defaults to `false`.

        Raises:
            ValueError: If parameters are invalid, or if backup is not a supported type.
            BadRequestError: If the request is bad.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
        """
        if repositories is not None:
            if not isinstance(repositories, list):
                raise ValueError("repositories must be a list or None")
            if not all(isinstance(r, str) for r in repositories):
                raise ValueError("repositories must be a list of strings")
        if (
            not isinstance(restore_system_data, bool)
            and restore_system_data is not None
        ):
            raise ValueError("restore_system_data must be a bool or None")
        if (
            not isinstance(remove_stale_repositories, bool)
            and remove_stale_repositories is not None
        ):
            raise ValueError("remove_stale_repositories must be a bool or None")

        payload: dict[str, t.Any] = {}
        if repositories is not None:
            payload["repositories"] = repositories
        if restore_system_data is not None:
            payload["restoreSystemData"] = restore_system_data
        if remove_stale_repositories is not None:
            payload["removeStaleRepositories"] = remove_stale_repositories

        params_part: FileContent = (None, json.dumps(payload), "application/json")

        def _post(file_part: FileContent) -> None:
            try:
                response = self.http_client.post(
                    "/rest/recovery/restore",
                    files=[("params", params_part), ("file", file_part)],
                )
                response.raise_for_status()
            except httpx.HTTPStatusError as err:
                status = err.response.status_code
                if status == 400:
                    raise BadRequestError(f"Bad request: {err.response.text}") from err
                elif status == 401:
                    raise UnauthorisedError(
                        f"Request is unauthorised: {err.response.text}"
                    ) from err
                elif status == 403:
                    raise ForbiddenError(
                        f"Request is forbidden: {err.response.text}"
                    ) from err
                raise err

        if isinstance(backup, (bytes, bytearray, memoryview)):
            content = bytes(backup)
            _post(("graphdb-backup.tar", content, "application/x-tar"))
            return

        if hasattr(backup, "read") and not isinstance(backup, (str, os.PathLike)):
            file_obj = t.cast(t.IO[bytes], backup)
            filename = infer_filename_from_fileobj(file_obj, "graphdb-backup.tar")
            _post((filename, file_obj, "application/x-tar"))
            return

        if isinstance(backup, (str, os.PathLike)):
            backup_path = pathlib.Path(backup).expanduser()
            with open(backup_path, "rb") as f:
                filename = backup_path.name or infer_filename_from_fileobj(
                    f, "graphdb-backup.tar"
                )
                _post((filename, f, "application/x-tar"))
            return

        raise ValueError(
            "backup must be bytes/bytes-like, a binary file-like object, or a filesystem path"
        )

    def cloud_restore(
        self,
        bucket_uri: str,
        repositories: list[str] | None = None,
        restore_system_data: bool | None = None,
        remove_stale_repositories: bool | None = None,
        authentication_file: (
            bytes | bytearray | memoryview | t.IO[bytes] | str | os.PathLike[str] | None
        ) = None,
    ) -> None:
        """Restore GraphDB instance from a cloud backup archive.

        Parameters:
            bucket_uri: Cloud bucket URI including provider-specific parameters (required).
            repositories: List of repositories to restore. If `None` (default), the
                parameter is omitted and all repositories found in the backup are
                restored. If an empty list (`[]`) is provided, no repositories from
                the backup are restored.
            restore_system_data: Whether to restore system data (users, saved queries,
                visual graphs, etc.). If omitted, GraphDB defaults to `false`. If
                `true` and no system data exists in the backup, GraphDB returns an
                error.
            remove_stale_repositories: Whether to remove repositories on the target
                instance that are not restored from the backup. If omitted, GraphDB
                defaults to `false`.
            authentication_file: Optional credential file content as bytes/bytes-like, a
                binary file-like object, or a filesystem path.

        Raises:
            ValueError: If parameters are invalid, or authentication_file is not a supported type.
            BadRequestError: If the request is bad.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
        """
        if not isinstance(bucket_uri, str) or not bucket_uri:
            raise ValueError("bucket_uri must be a non-empty string")

        if repositories is not None:
            if not isinstance(repositories, list):
                raise ValueError("repositories must be a list or None")
            if not all(isinstance(r, str) for r in repositories):
                raise ValueError("repositories must be a list of strings")
        if (
            not isinstance(restore_system_data, bool)
            and restore_system_data is not None
        ):
            raise ValueError("restore_system_data must be a bool or None")
        if (
            not isinstance(remove_stale_repositories, bool)
            and remove_stale_repositories is not None
        ):
            raise ValueError("remove_stale_repositories must be a bool or None")

        payload: dict[str, t.Any] = {}
        if repositories is not None:
            payload["repositories"] = repositories
        if restore_system_data is not None:
            payload["restoreSystemData"] = restore_system_data
        if remove_stale_repositories is not None:
            payload["removeStaleRepositories"] = remove_stale_repositories
        payload["bucketUri"] = bucket_uri

        params_part: FileContent = (None, json.dumps(payload), "application/json")

        def _post(authentication_part: FileContent | None) -> None:
            files: list[tuple[str, FileContent]] = [("params", params_part)]
            if authentication_part is not None:
                files.append(("authenticationFile", authentication_part))
            try:
                response = self.http_client.post(
                    "/rest/recovery/cloud-restore",
                    headers={"Accept": "application/json"},
                    files=files,
                )
                response.raise_for_status()
            except httpx.HTTPStatusError as err:
                status = err.response.status_code
                if status == 400:
                    raise BadRequestError(f"Bad request: {err.response.text}") from err
                elif status == 401:
                    raise UnauthorisedError(
                        f"Request is unauthorised: {err.response.text}"
                    ) from err
                elif status == 403:
                    raise ForbiddenError(
                        f"Request is forbidden: {err.response.text}"
                    ) from err
                raise err

        if authentication_file is None:
            _post(None)
            return

        if isinstance(authentication_file, (bytes, bytearray, memoryview)):
            content = bytes(authentication_file)
            _post(("authentication-file", content, "application/octet-stream"))
            return

        if hasattr(authentication_file, "read") and not isinstance(
            authentication_file, (str, os.PathLike)
        ):
            file_obj = t.cast(t.IO[bytes], authentication_file)
            filename = infer_filename_from_fileobj(file_obj, "authentication-file")
            _post((filename, file_obj, "application/octet-stream"))
            return

        if isinstance(authentication_file, (str, os.PathLike)):
            auth_path = pathlib.Path(authentication_file).expanduser()
            with open(auth_path, "rb") as f:
                filename = auth_path.name or infer_filename_from_fileobj(
                    f, "authentication-file"
                )
                _post((filename, f, "application/octet-stream"))
            return

        raise ValueError(
            "authentication_file must be bytes/bytes-like, a binary file-like object, or a filesystem path"
        )

    @t.overload
    def backup(
        self,
        repositories: list[str] | None = None,
        backup_system_data: bool | None = None,
        *,
        dest: None = None,
    ) -> bytes: ...

    @t.overload
    def backup(
        self,
        repositories: list[str] | None = None,
        backup_system_data: bool | None = None,
        *,
        dest: str | os.PathLike[str],
    ) -> pathlib.Path: ...

    def backup(
        self,
        repositories: list[str] | None = None,
        backup_system_data: bool | None = None,
        *,
        dest: str | os.PathLike[str] | None = None,
    ) -> bytes | pathlib.Path:
        """Create a new backup of GraphDB instance.

        The backup is returned as a tar archive containing repository data and
        optionally system data (user accounts, saved queries, visual graphs, etc.).

        Parameters:
            repositories: List of repositories to be backed up, specified by their repository identifiers.
                If `None`, all repositories will be included in the backup.
            backup_system_data: Determines whether user account data such as user accounts, saved queries,
                or visual graphs, among others, should be included in the backup.
            dest: Destination path to save the backup archive. If `None`, the backup
                content is returned as bytes (suitable for small backups). If a directory
                path is provided, the filename from the response Content-Disposition header
                is used (e.g., backup-2026-01-16-10-30-00.tar). If a file path is provided,
                that exact path is used. The response is streamed directly to disk
                (recommended for large backups).

        Returns:
            bytes: If `dest` is `None`, returns the backup archive as bytes.
            Path: If `dest` is provided, returns the resolved `pathlib.Path` where the backup was saved.

        Raises:
            ValueError: If repositories is not a list or None, or if backup_system_data is not a bool or None.
            BadRequestError: If the request is bad.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            OSError: If the destination path cannot be written to.
        """
        if repositories is not None:
            if not isinstance(repositories, list):
                raise ValueError("repositories must be a list or None")
            if not all(isinstance(r, str) for r in repositories):
                raise ValueError("repositories must be a list of strings")
        if not isinstance(backup_system_data, bool) and backup_system_data is not None:
            raise ValueError("backup_system_data must be a bool")

        payload: dict[str, t.Any] = {}
        if repositories is not None:
            payload["repositories"] = repositories
        if backup_system_data is not None:
            payload["backupSystemData"] = backup_system_data

        def _handle_http_error(err: httpx.HTTPStatusError) -> t.NoReturn:
            status = err.response.status_code
            if status == 400:
                raise BadRequestError(f"Bad request: {err.response.text}") from err
            elif status == 401:
                raise UnauthorisedError(
                    f"Request is unauthorised: {err.response.text}"
                ) from err
            elif status == 403:
                raise ForbiddenError(
                    f"Request is forbidden: {err.response.text}"
                ) from err
            raise err

        if dest is None:
            # Return bytes directly (suitable for small backups)
            try:
                response = self.http_client.post("/rest/recovery/backup", json=payload)
                response.raise_for_status()
                return response.content
            except httpx.HTTPStatusError as err:
                _handle_http_error(err)
        else:
            # Stream to disk (recommended for large backups)
            dest_path = pathlib.Path(dest).expanduser().resolve()

            try:
                with self.http_client.stream(
                    "POST", "/rest/recovery/backup", json=payload
                ) as response:
                    response.raise_for_status()

                    # If dest is a directory, extract filename from Content-Disposition
                    if dest_path.is_dir():
                        content_disposition = response.headers.get(
                            "Content-Disposition", ""
                        )
                        filename = extract_filename_from_content_disposition(
                            content_disposition
                        )
                        if filename:
                            dest_path = dest_path / filename
                        else:
                            # Fallback to a default name if header parsing fails
                            dest_path = dest_path / "graphdb-backup.tar"

                    # Use a temporary file during download, then rename atomically
                    tmp_path = dest_path.with_suffix(dest_path.suffix + ".partial")

                    with open(tmp_path, "wb") as f:
                        for chunk in response.iter_bytes():
                            f.write(chunk)
                    tmp_path.replace(dest_path)
                return dest_path
            except httpx.HTTPStatusError as err:
                _handle_http_error(err)

    def cloud_backup(
        self,
        bucket_uri: str,
        repositories: list[str] | None = None,
        backup_system_data: bool | None = None,
        authentication_file: (
            bytes | bytearray | memoryview | t.IO[bytes] | str | os.PathLike[str] | None
        ) = None,
    ) -> None:
        """Create a new backup of GraphDB instance uploaded to a cloud bucket.

        GraphDB uploads the resulting `.tar` archive directly to the configured
        cloud bucket. This uses the GraphDB endpoint `/rest/recovery/cloud-backup`.

        Parameters:
            bucket_uri: Cloud bucket URI including provider-specific parameters (required).
            repositories: Optional list of repositories to be backed up.
            backup_system_data: Optional flag to include system data (users, saved queries, etc.).
            authentication_file: Optional credential file content as bytes/bytes-like, a
                binary file-like object, or a filesystem path.

        Raises:
            ValueError: If parameters are invalid, or authentication_file is not a supported type.
            BadRequestError: If the request is bad.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
        """
        if not isinstance(bucket_uri, str) or not bucket_uri:
            raise ValueError("bucket_uri must be a non-empty string")

        if repositories is not None:
            if not isinstance(repositories, list):
                raise ValueError("repositories must be a list or None")
            if not all(isinstance(r, str) for r in repositories):
                raise ValueError("repositories must be a list of strings")

        if not isinstance(backup_system_data, bool) and backup_system_data is not None:
            raise ValueError("backup_system_data must be a bool")

        payload: dict[str, t.Any] = {}
        if repositories is not None:
            payload["repositories"] = repositories
        if backup_system_data is not None:
            payload["backupSystemData"] = backup_system_data
        payload["bucketUri"] = bucket_uri

        params_part: FileContent = (None, json.dumps(payload), "application/json")

        def _post(authentication_part: FileContent | None) -> None:
            files: list[tuple[str, FileContent]] = [("params", params_part)]
            if authentication_part is not None:
                files.append(("authenticationFile", authentication_part))
            try:
                response = self.http_client.post(
                    "/rest/recovery/cloud-backup",
                    headers={"Accept": "application/json"},
                    files=files,
                )
                response.raise_for_status()
            except httpx.HTTPStatusError as err:
                status = err.response.status_code
                if status == 400:
                    raise BadRequestError(f"Bad request: {err.response.text}") from err
                elif status == 401:
                    raise UnauthorisedError(
                        f"Request is unauthorised: {err.response.text}"
                    ) from err
                elif status == 403:
                    raise ForbiddenError(
                        f"Request is forbidden: {err.response.text}"
                    ) from err
                raise err

        if authentication_file is None:
            _post(None)
            return

        if isinstance(authentication_file, (bytes, bytearray, memoryview)):
            content = bytes(authentication_file)
            _post(("authentication-file", content, "application/octet-stream"))
            return

        if hasattr(authentication_file, "read") and not isinstance(
            authentication_file, (str, os.PathLike)
        ):
            file_obj = t.cast(t.IO[bytes], authentication_file)
            filename = infer_filename_from_fileobj(file_obj, "authentication-file")
            _post((filename, file_obj, "application/octet-stream"))
            return

        if isinstance(authentication_file, (str, os.PathLike)):
            auth_path = pathlib.Path(authentication_file).expanduser()
            with open(auth_path, "rb") as f:
                filename = auth_path.name or infer_filename_from_fileobj(
                    f, "authentication-file"
                )
                _post((filename, f, "application/octet-stream"))
            return

        raise ValueError(
            "authentication_file must be bytes/bytes-like, a binary file-like object, or a filesystem path"
        )


class RepositoryManagement:
    """GraphDB Repository Management client.

    The functionality provided by this management client accepts an optional location parameter to operate on external
    GraphDB locations.
    """

    def __init__(self, http_client: httpx.Client):
        self._http_client = http_client

    def list(self, location: str | None = None) -> list[GraphDBRepository]:
        """List all repositories.

        Parameters:
            location: The location of the repositories.

        Returns:
            list[GraphDBRepository]: List of GraphDB repositories.

        Raises:
            InternalServerError: If the server returns an internal error.
            ResponseFormatError: If the response cannot be parsed.
        """
        params = {}
        if location is not None:
            params["location"] = location
        try:
            response = self.http_client.get("/rest/repositories", params=params)
            response.raise_for_status()
            try:
                return [GraphDBRepository.from_dict(repo) for repo in response.json()]
            except (ValueError, TypeError) as err:
                raise ResponseFormatError(
                    f"Failed to parse GraphDB response: {err}"
                ) from err
        except httpx.HTTPStatusError as err:
            if err.response.status_code == 500:
                raise InternalServerError(
                    f"Internal server error: {err.response.text}"
                ) from err
            raise

    def create(
        self,
        config: RepositoryConfigBeanCreate | str,
        location: str | None = None,
        files: FilesType | None = None,
    ):
        """Create a new repository.

        Parameters:
            config: Repository configuration. When a `RepositoryConfigBeanCreate` is
                provided, the request is sent as JSON. When a string is provided, it
                is treated as Turtle content and sent as multipart/form-data part
                `config` (required by GraphDB) with the content type `text/turtle`.
            location: Optional repository location (query param `location`).
            files: Optional extra multipart parts for GraphDB-specific files (e.g.
                `obdaFile`, `owlFile`, `propertiesFile`, `constraintFile`,
                `dbMetadataFile`, `lensesFile`). Keys must be the form part names;
                values may be file content or httpx-style file tuples. Ignored when
                `config` is a dataclass (JSON payload).

        Raises:
            BadRequestError: If the request is invalid.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            InternalServerError: If the server returns an internal error.
        """
        params = {}
        if location is not None:
            params["location"] = location

        def _normalize_file_content(field: str, value: FileContent) -> FileContent:
            if isinstance(value, tuple):
                # fill in the missing filename with the field name
                if len(value) == 2:
                    filename, content = value
                    return (filename or field, content)
                filename, content, content_type = value
                return (filename or field, content, content_type)
            return (field, value)

        try:
            if isinstance(config, str):
                extra_parts: list[tuple[str, FileContent]] = []
                if files is not None:
                    if isinstance(files, t.Mapping):
                        extra_parts = list(files.items())
                    else:
                        extra_parts = list(files)

                    if any(field == "config" for field, _ in extra_parts):
                        raise ValueError(
                            "Do not pass a 'config' multipart part via files; use the config argument instead."
                        )

                multipart_files: list[tuple[str, FileContent]] = [
                    ("config", ("config.ttl", config, "text/turtle"))
                ]
                for field, content in extra_parts:
                    multipart_files.append(
                        (field, _normalize_file_content(field, content))
                    )

                response = self.http_client.post(
                    "/rest/repositories",
                    params=params,
                    files=multipart_files,
                )
            else:
                if files is not None:
                    raise ValueError(
                        "Additional files can only be provided when config is a Turtle string."
                    )
                response = self.http_client.post(
                    "/rest/repositories",
                    headers={"Content-Type": "application/json"},
                    json=config.as_dict(),
                    params=params,
                )
            response.raise_for_status()
        except httpx.HTTPStatusError as err:
            status = err.response.status_code
            if status == 400:
                raise BadRequestError(f"Invalid request: {err.response.text}") from err
            elif status == 401:
                raise UnauthorisedError(
                    f"Request is unauthorised: {err.response.text}"
                ) from err
            elif status == 403:
                raise ForbiddenError(
                    f"Request is forbidden: {err.response.text}"
                ) from err
            elif status == 500:
                raise InternalServerError(
                    f"Internal server error: {err.response.text}"
                ) from err
            raise

    @property
    def http_client(self):
        return self._http_client

    @t.overload
    def get(
        self,
        repository_id: str,
        content_type: t.Literal["application/json"],
        location: str | None = None,
    ) -> RepositoryConfigBean: ...

    @t.overload
    def get(
        self,
        repository_id: str,
        content_type: None = None,
        location: str | None = None,
    ) -> RepositoryConfigBean: ...

    @t.overload
    def get(
        self,
        repository_id: str,
        content_type: t.Literal["text/turtle"],
        location: str | None = None,
    ) -> Graph: ...

    @t.overload
    def get(
        self,
        repository_id: str,
        content_type: str,
        location: str | None = None,
    ) -> RepositoryConfigBean | Graph: ...

    def get(
        self,
        repository_id: str,
        content_type: str | None = None,
        location: str | None = None,
    ) -> RepositoryConfigBean | Graph:
        """Get a repository's configuration.

        Parameters:
            repository_id: The identifier of the repository.
            content_type: The content type of the response. Can be `application/json` or
                `text/turtle`. Defaults to `application/json`.
            location: The location of the repository.

        Returns:
            RepositoryConfigBean: The repository configuration.
            Graph: The repository configuration in RDF.

        Raises:
            BadRequestError: If the content type is not supported.
            ResponseFormatError: If the response cannot be parsed.
            RepositoryNotFoundError: If the repository is not found.
            InternalServerError: If the server returns an internal error.
        """
        if content_type is None:
            content_type = "application/json"
        if content_type not in ("application/json", "text/turtle"):
            raise ValueError(f"Unsupported content type: {content_type}.")
        headers = {"Accept": content_type}
        params = {}
        if location is not None:
            params["location"] = location
        try:
            response = self.http_client.get(
                f"/rest/repositories/{repository_id}", headers=headers, params=params
            )
            response.raise_for_status()

            if content_type == "application/json":
                try:
                    return RepositoryConfigBean(**response.json())
                except (ValueError, TypeError) as err:
                    raise ResponseFormatError(
                        "Failed to parse GraphDB response."
                    ) from err
            elif content_type == "text/turtle":
                try:
                    return Graph().parse(data=response.text, format="turtle")
                except Exception as err:
                    raise ResponseFormatError(f"Error parsing RDF: {err}") from err
            else:
                raise ValueError(f"Unhandled content type: {content_type}.")
        except httpx.HTTPStatusError as err:
            if err.response.status_code == 404:
                raise RepositoryNotFoundError(
                    f"Repository {repository_id} not found."
                ) from err
            elif err.response.status_code == 500:
                raise InternalServerError("Internal server error.") from err
            raise

    def edit(self, repository_id: str, config: RepositoryConfigBeanCreate) -> None:
        """Edit a repository's configuration.

        Parameters:
            repository_id: The identifier of the repository.
            config: The repository configuration.

        Raises:
            BadRequestError: If the request is invalid.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            InternalServerError: If the server returns an internal error.
        """
        headers = {
            "Content-Type": "application/json",
        }
        try:
            response = self.http_client.put(
                f"/rest/repositories/{repository_id}",
                headers=headers,
                json=config.as_dict(),
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as err:
            if err.response.status_code == 400:
                raise BadRequestError(f"Invalid request: {err.response.text}") from err
            elif err.response.status_code == 401:
                raise UnauthorisedError(
                    f"Request is unauthorised: {err.response.text}"
                ) from err
            elif err.response.status_code == 403:
                raise ForbiddenError(
                    f"Request is forbidden: {err.response.text}"
                ) from err
            elif err.response.status_code == 500:
                raise InternalServerError(
                    f"Internal server error: {err.response.text}"
                ) from err
            raise

    def delete(self, repository_id: str, location: str | None = None) -> None:
        """Delete a repository.

        Parameters:
            repository_id: The identifier of the repository.
            location: The location of the repository.

        Raises:
            BadRequestError: If the request is invalid.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            InternalServerError: If the server returns an internal error.
        """
        params = {}
        if location is not None:
            params["location"] = location
        try:
            response = self.http_client.delete(
                f"/rest/repositories/{repository_id}", params=params
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as err:
            if err.response.status_code == 400:
                raise BadRequestError(f"Invalid request: {err.response.text}") from err
            elif err.response.status_code == 401:
                raise UnauthorisedError(
                    f"Request is unauthorised: {err.response.text}"
                ) from err
            elif err.response.status_code == 403:
                raise ForbiddenError(
                    f"Request is forbidden: {err.response.text}"
                ) from err
            elif err.response.status_code == 500:
                raise InternalServerError(
                    f"Internal server error: {err.response.text}"
                ) from err
            raise

    def restart(
        self, repository_id: str, sync: bool | None = None, location: str | None = None
    ) -> str:
        """Restart a repository.

        Parameters:
            repository_id: The identifier of the repository.
            sync: Whether to sync the repository.
            location: The location of the repository.

        Returns:
            str: The response text.

        Raises:
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            RepositoryNotFoundError: If the repository is not found.
        """
        params = {}
        if sync is not None:
            params["sync"] = str(sync).lower()
        if location is not None:
            params["location"] = location
        try:
            response = self.http_client.post(
                f"/rest/repositories/{repository_id}/restart", params=params
            )
            response.raise_for_status()
            return response.text
        except httpx.HTTPStatusError as err:
            if err.response.status_code == 401:
                raise UnauthorisedError("Request is unauthorised.") from err
            elif err.response.status_code == 403:
                raise ForbiddenError("Request is forbidden.") from err
            elif err.response.status_code == 404:
                raise RepositoryNotFoundError(
                    f"Repository {repository_id} not found."
                ) from err
            raise

    def size(
        self, repository_id: str, location: str | None = None
    ) -> RepositorySizeInfo:
        """Get repository size.

        Parameters:
            repository_id: The identifier of the repository.
            location: The location of the repository.

        Raises:
            ResponseFormatError: If the response cannot be parsed.
            InternalServerError: If the server returns an internal error.
        """
        params = {}
        if location:
            params["location"] = location
        try:
            response = self.http_client.get(
                f"/rest/repositories/{repository_id}/size", params=params
            )
            response.raise_for_status()
            try:
                return RepositorySizeInfo(**response.json())
            except (ValueError, TypeError) as err:
                raise ResponseFormatError("Failed to parse GraphDB response.") from err
        except httpx.HTTPStatusError as err:
            if err.response.status_code == 500:
                raise InternalServerError(
                    f"Internal server error: {err.response.text}"
                ) from err
            raise

    @t.overload
    def validate(
        self,
        repository_id: str,
        *,
        content_type: str,
        content: str,
        location: str | None = None,
        shapes_repository_id: None = None,
    ) -> str: ...

    @t.overload
    def validate(
        self,
        repository_id: str,
        *,
        content: t.IO[bytes],
        content_type: str | None = None,
        location: str | None = None,
        shapes_repository_id: None = None,
    ) -> str: ...

    @t.overload
    def validate(
        self,
        repository_id: str,
        *,
        shapes_repository_id: str,
        location: str | None = None,
    ) -> str: ...

    def validate(
        self,
        repository_id: str,
        *,
        content_type: str | None = None,
        content: str | t.IO[bytes] | None = None,
        location: str | None = None,
        shapes_repository_id: str | None = None,
    ) -> str:
        """Validate repository data using SHACL shapes.

        Parameters:
            repository_id: The identifier of the repository.
            content_type: Content type of the request body (required for text payloads).
            content: SHACL shapes payload; string for text-based validation or file-like
                (binary) object for multipart validation.
            location: Optional repository location.
            shapes_repository_id: ID of repository containing SHACL shapes; when
                provided, no content is sent and shapes are fetched from that
                repository.

        Returns:
            str: Validation report as RDF Turtle.

        Raises:
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            InternalServerError: If the server returns an internal error.
        """
        params = {}
        if location is not None:
            params["location"] = location

        if shapes_repository_id is not None:
            if content is not None:
                raise ValueError(
                    "content must not be provided when shapes_repository_id is set."
                )
            if content_type is not None:
                raise ValueError(
                    "content_type must not be provided when shapes_repository_id is set."
                )
            headers = {"Accept": "text/turtle"}
            try:
                response = self.http_client.post(
                    url=f"/rest/repositories/{repository_id}/validate/repository/{shapes_repository_id}",
                    params=params,
                    headers=headers,
                )
                response.raise_for_status()
                return response.text
            except httpx.HTTPStatusError as err:
                status = err.response.status_code
                if status == 401:
                    raise UnauthorisedError("Request is unauthorised.") from err
                elif status == 403:
                    raise ForbiddenError("Request is forbidden.") from err
                elif status == 500:
                    raise InternalServerError(
                        f"Internal server error: {err.response.text}"
                    ) from err
                raise

        if content is None:
            raise ValueError("content must be provided.")

        is_file_like = hasattr(content, "read") and not isinstance(content, str)

        if is_file_like:
            headers = {"Accept": "text/turtle"}
            file_part = (
                "shapes.ttl",
                t.cast(t.IO[bytes], content),
                content_type or "text/turtle",
            )
            files: FilesType = {"file": file_part}
            try:
                response = self.http_client.post(
                    url=f"/rest/repositories/{repository_id}/validate/file",
                    params=params,
                    headers=headers,
                    files=files,
                )
                response.raise_for_status()
                return response.text
            except httpx.HTTPStatusError as err:
                status = err.response.status_code
                if status == 401:
                    raise UnauthorisedError("Request is unauthorised.") from err
                elif status == 403:
                    raise ForbiddenError("Request is forbidden.") from err
                elif status == 500:
                    raise InternalServerError(
                        f"Internal server error: {err.response.text}"
                    ) from err
                raise
        else:
            if not content_type:
                raise ValueError("content_type must be provided for text validation.")

            headers = {"Content-Type": content_type, "Accept": "text/turtle"}
            try:
                response = self.http_client.post(
                    url=f"/rest/repositories/{repository_id}/validate/text",
                    params=params,
                    headers=headers,
                    content=content,
                )
                response.raise_for_status()
                return response.text
            except httpx.HTTPStatusError as err:
                status = err.response.status_code
                if status == 401:
                    raise UnauthorisedError("Request is unauthorised.") from err
                elif status == 403:
                    raise ForbiddenError("Request is forbidden.") from err
                elif status == 500:
                    raise InternalServerError(
                        f"Internal server error: {err.response.text}"
                    ) from err
                raise


class SecurityManagement:
    """GraphDB Security Management client."""

    def __init__(self, http_client: httpx.Client):
        self._http_client = http_client

    @property
    def http_client(self):
        return self._http_client

    @property
    def enabled(self) -> bool:
        """Check if security is enabled.

        Returns:
            bool: True if security is enabled, False otherwise.

        Raises:
            ResponseFormatError: If the response format is invalid.
            InternalServerError: If the server returns an internal error.
        """
        try:
            headers = {"Accept": "application/json"}
            response = self.http_client.get("/rest/security", headers=headers)
            response.raise_for_status()
            try:
                value = response.json()
                if not isinstance(value, bool):
                    raise ResponseFormatError("Response is not a boolean.")
                return value
            except (ValueError, TypeError) as err:
                raise ResponseFormatError(
                    f"Failed to parse GraphDB response: {err}"
                ) from err
        except httpx.HTTPStatusError as err:
            if err.response.status_code == 500:
                raise InternalServerError(
                    f"Internal server error: {err.response.text}"
                ) from err
            raise

    @enabled.setter
    def enabled(self, value: bool):
        """Enable or disable security.

        Parameters:
            value: The value to set.

        Raises:
            TypeError: If the value is not a boolean.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            PreconditionFailedError: If the precondition is failed.
        """
        if not isinstance(value, bool):
            raise TypeError("Value must be a boolean.")
        try:
            headers = {"Content-Type": "application/json", "Accept": "application/json"}
            response = self.http_client.post(
                "/rest/security", headers=headers, json=value
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as err:
            if err.response.status_code == 401:
                raise UnauthorisedError("Request is unauthorised.") from err
            elif err.response.status_code == 403:
                raise ForbiddenError("Request is forbidden.") from err
            elif err.response.status_code == 412:
                raise PreconditionFailedError("Precondition failed.") from err
            raise

    def get_free_access_details(self):
        """
        Check if free access is enabled.

        Returns:
            FreeAccessSettings: The free access settings.

        Raises:
            ResponseFormatError: If the response format is invalid.
            InternalServerError: If the server returns an internal error.
        """
        try:
            headers = {"Accept": "application/json"}
            response = self.http_client.get(
                "/rest/security/free-access", headers=headers
            )
            response.raise_for_status()
            try:
                return FreeAccessSettings(**response.json())
            except (ValueError, TypeError) as err:
                raise ResponseFormatError(
                    f"Failed to parse GraphDB response: {err}"
                ) from err
        except httpx.HTTPStatusError as err:
            if err.response.status_code == 500:
                raise InternalServerError(
                    f"Internal server error: {err.response.text}"
                ) from err
            raise

    def set_free_access_details(self, free_access_settings: FreeAccessSettings):
        """
        Enable or disable free access.

        Parameters:
            free_access_settings: The free access settings.

        Raises:
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            PreconditionFailedError: If the precondition is failed.
        """
        try:
            headers = {"Content-Type": "application/json", "Accept": "application/json"}
            response = self.http_client.post(
                "/rest/security/free-access",
                headers=headers,
                json=free_access_settings.as_dict(),
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as err:
            if err.response.status_code == 401:
                raise UnauthorisedError("Request is unauthorised.") from err
            elif err.response.status_code == 403:
                raise ForbiddenError("Request is forbidden.") from err
            elif err.response.status_code == 412:
                raise PreconditionFailedError("Precondition failed.") from err
            raise


class UserManagement:
    """GraphDB User Management client."""

    def __init__(self, http_client: httpx.Client):
        self._http_client = http_client

    @property
    def http_client(self):
        return self._http_client

    def list(self) -> list[User]:
        """
        Get all users.

        Returns:
            A list of users.

        Raises:
            ResponseFormatError: If the response format is invalid.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            PreconditionFailedError: If the precondition is failed.
            InternalServerError: If the server returns an internal error.
        """
        headers = {"Accept": "application/json"}
        try:
            response = self.http_client.get("/rest/security/users", headers=headers)
            response.raise_for_status()
            try:
                return [User(**user) for user in response.json()]
            except (ValueError, TypeError) as err:
                raise ResponseFormatError(
                    f"Failed to parse GraphDB response: {err}"
                ) from err
        except httpx.HTTPStatusError as err:
            if err.response.status_code == 401:
                raise UnauthorisedError("Request is unauthorised.") from err
            elif err.response.status_code == 403:
                raise ForbiddenError("Request is forbidden.") from err
            elif err.response.status_code == 412:
                raise PreconditionFailedError("Precondition failed.") from err
            elif err.response.status_code == 500:
                raise InternalServerError(
                    f"Internal server error: {err.response.text}"
                ) from err
            raise

    def get(self, username: str) -> User:
        """
        Get a user.

        Parameters:
            username: The username of the user.

        Returns:
            User: The user.

        Raises:
            ResponseFormatError: If the response format is invalid.
            ForbiddenError: If the request is forbidden.
            NotFoundError: If the user is not found.
            InternalServerError: If the server returns an internal error.
        """
        try:
            headers = {"Accept": "application/json"}
            response = self.http_client.get(
                f"/rest/security/users/{username}", headers=headers
            )
            response.raise_for_status()
            try:
                return User(**response.json())
            except (ValueError, TypeError) as err:
                raise ResponseFormatError(
                    f"Failed to parse GraphDB response: {err}"
                ) from err
        except httpx.HTTPStatusError as err:
            if err.response.status_code == 403:
                raise ForbiddenError("Request is forbidden.") from err
            elif err.response.status_code == 404:
                raise NotFoundError("User not found.") from err
            elif err.response.status_code == 500:
                raise InternalServerError(
                    f"Internal server error: {err.response.text}"
                ) from err
            raise

    def overwrite(self, username: str, user: User) -> None:
        """
        Overwrite a user.

        Parameters:
            username: The username of the user.
            user: The user to overwrite.

        Raises:
            TypeError: if username is not a string or user is not an instance of User.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            NotFoundError: If the user is not found.
        """
        if not isinstance(username, str):
            raise TypeError("Username must be a string.")
        if not isinstance(user, User):
            raise TypeError("User must be an instance of User.")

        try:
            headers = {"Content-Type": "application/json"}
            response = self.http_client.put(
                f"/rest/security/users/{username}", headers=headers, json=user.as_dict()
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as err:
            if err.response.status_code == 401:
                raise UnauthorisedError("Request is unauthorised.") from err
            elif err.response.status_code == 403:
                raise ForbiddenError("Request is forbidden.") from err
            elif err.response.status_code == 404:
                raise NotFoundError("User not found.") from err
            raise

    def create(self, username: str, user: UserCreate) -> None:
        """
        Create a user.

        Parameters:
            username: The username of the user.
            user: The user to create.

        Raises:
            TypeError: if username is not a string or user is not an instance of UserCreate.
            BadRequestError: If the request is bad.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
        """
        if not isinstance(username, str):
            raise TypeError("Username must be a string.")
        if not isinstance(user, UserCreate):
            raise TypeError("User must be an instance of UserCreate.")

        try:
            headers = {"Content-Type": "application/json"}
            response = self.http_client.post(
                f"/rest/security/users/{username}", headers=headers, json=user.as_dict()
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as err:
            if err.response.status_code == 400:
                raise BadRequestError(f"Bad request. {err.response.text}") from err
            elif err.response.status_code == 401:
                raise UnauthorisedError("Request is unauthorised.") from err
            elif err.response.status_code == 403:
                raise ForbiddenError("Request is forbidden.") from err
            raise

    def delete(self, username: str) -> None:
        """
        Delete a user.

        Parameters:
            username: The username of the user.

        Raises:
            TypeError: if username is not a string.
            BadRequestError: If the request is bad.
            UnauthorisedError: If the request is unauthorised.
            ForbiddenError: If the request is forbidden.
            NotFoundError: If the user is not found.
        """
        if not isinstance(username, str):
            raise TypeError("Username must be a string.")

        try:
            response = self.http_client.delete(f"/rest/security/users/{username}")
            response.raise_for_status()
        except httpx.HTTPStatusError as err:
            if err.response.status_code == 400:
                raise BadRequestError(f"Bad request. {err.response.text}") from err
            elif err.response.status_code == 401:
                raise UnauthorisedError("Request is unauthorised.") from err
            elif err.response.status_code == 403:
                raise ForbiddenError("Request is forbidden.") from err
            elif err.response.status_code == 404:
                raise NotFoundError("User not found.") from err
            raise

    def update(self, username: str, user: UserUpdate | dict[str, t.Any]) -> None:
        """
        Update a user.

        !!! Note
            Certain user fields are not updatable using PATCH. For example, at the
            time of writing, `grantedAuthorities` are not updatable, but `appSettings` are.

        Parameters:
            username: The username of the user.
            user: The user data to update, either as a UserUpdate instance or a dict.

        Raises:
            TypeError: if username is not a string or user is not an instance of UserUpdate or dict.
            ForbiddenError: If the request is forbidden.
            PreconditionFailedError: If the precondition is failed.
        """
        if not isinstance(username, str):
            raise TypeError("Username must be a string.")
        if not isinstance(user, (UserUpdate, dict)):
            raise TypeError("User must be an instance of UserUpdate or dict.")

        if isinstance(user, UserUpdate):
            user_data = user.as_dict()
        else:
            user_data = user

        try:
            headers = {"Content-Type": "application/json"}
            response = self.http_client.patch(
                f"/rest/security/users/{username}", headers=headers, json=user_data
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as err:
            if err.response.status_code == 403:
                raise ForbiddenError("Request is forbidden.") from err
            elif err.response.status_code == 412:
                raise PreconditionFailedError("Precondition failed.") from err
            raise

    def custom_roles(self, username: str) -> t.List[str]:
        """
        Retrieve custom roles associated with the user.

        Parameters:
            username: The username of the user.

        Returns:
            list[str]: The custom roles for the user.

        Raises:
            TypeError: if username is not a string.
            ForbiddenError: If the request is forbidden.
            NotFoundError: If the user is not found.
            InternalServerError: If the request fails.
        """
        if not isinstance(username, str):
            raise TypeError("Username must be a string.")

        try:
            response = self.http_client.get(
                f"/rest/security/users/{username}/custom-roles"
            )
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as err:
            if err.response.status_code == 403:
                raise ForbiddenError("Request is forbidden.") from err
            elif err.response.status_code == 404:
                raise NotFoundError("User not found.") from err
            elif err.response.status_code == 500:
                raise InternalServerError("Internal server error.") from err
            raise


class GraphDBClient(RDF4JClient):
    """GraphDB Client

    This client and its inner management objects perform HTTP requests via
    httpx and may raise httpx-specific exceptions. Errors documented by GraphDB
    in its OpenAPI specification are mapped to specific exceptions in this
    library where applicable. Error mappings are documented on each management
    method. The underlying httpx client is reused across
    requests, and connection pooling is handled automatically by httpx.

    Parameters:
        base_url: The base URL of the GraphDB server.
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
        **kwargs: t.Any,
    ):
        super().__init__(base_url, auth, timeout, **kwargs)
        self._cluster_group = ClusterGroupManagement(self.http_client)
        self._monitoring = MonitoringManagement(self.http_client)
        self._recovery = RecoveryManagement(self.http_client)
        self._graphdb_repository_manager = RepositoryManager(self.http_client)
        self._graphdb_repositories = RepositoryManagement(self.http_client)
        self._security = SecurityManagement(self.http_client)
        self._users = UserManagement(self.http_client)

    @property
    def cluster(self) -> ClusterGroupManagement:
        return self._cluster_group

    @property
    def monitoring(self) -> MonitoringManagement:
        return self._monitoring

    @property
    def recovery(self) -> RecoveryManagement:
        return self._recovery

    @property
    def repositories(self) -> RepositoryManager:
        """Server-level repository management operations (GraphDB-specific)."""
        return self._graphdb_repository_manager

    @property
    def graphdb_repositories(self) -> RepositoryManagement:
        return self._graphdb_repositories

    @property
    def security(self) -> SecurityManagement:
        return self._security

    @property
    def users(self) -> UserManagement:
        return self._users

    def login(self, username: str, password: str) -> AuthenticatedUser:
        """Authenticate with GraphDB and obtain a GDB token.

        Parameters:
            username: The username to authenticate with.
            password: The password to authenticate with.

        Returns:
            An AuthenticatedUser instance containing user details and the GDB token.

        Raises:
            UnauthorisedError: If the credentials are invalid.
            BadRequestError: If the request body is invalid.
            ResponseFormatError: If the response cannot be parsed.
        """
        try:
            response = self.http_client.post(
                "/rest/login",
                json={"username": username, "password": password},
            )
            response.raise_for_status()

            auth_header = response.headers.get("Authorization", "")
            if not auth_header.startswith("GDB "):
                raise ResponseFormatError(
                    "Authorization header missing or invalid format"
                )

            try:
                data = response.json()
            except (ValueError, TypeError) as err:
                raise ResponseFormatError(
                    f"Failed to parse login response: {err}"
                ) from err

            try:
                return AuthenticatedUser.from_response(data, auth_header)
            except (ValueError, TypeError) as err:
                raise ResponseFormatError(
                    f"Failed to parse authenticated user: {err}"
                ) from err

        except httpx.HTTPStatusError as err:
            status = err.response.status_code
            if status == 400:
                raise BadRequestError(f"Invalid request: {err.response.text}") from err
            elif status == 401:
                raise UnauthorisedError(
                    f"Invalid credentials: {err.response.text}"
                ) from err
            raise
