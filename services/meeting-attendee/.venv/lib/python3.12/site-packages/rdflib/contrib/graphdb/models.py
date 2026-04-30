from __future__ import annotations

import typing as t
from dataclasses import asdict, dataclass, field
from enum import Enum

from rdflib import Literal, URIRef
from rdflib.util import from_n3


@dataclass(frozen=True)
class TopologyStatus:
    state: str
    primaryTags: dict[str, t.Any]  # noqa: N815

    def __post_init__(self) -> None:
        invalid: list[tuple[str, t.Any, type]] = []
        state = t.cast(t.Any, self.state)
        primary_tags = t.cast(t.Any, self.primaryTags)

        if not isinstance(state, str):
            invalid.append(("state", state, type(state)))
        if not isinstance(primary_tags, dict):
            invalid.append(("primaryTags", primary_tags, type(primary_tags)))
        else:
            for key, value in primary_tags.items():
                if not isinstance(key, str):
                    invalid.append((f"primaryTags key '{key}'", key, type(key)))

        if invalid:
            raise ValueError("Invalid TopologyStatus values: ", invalid)


@dataclass(frozen=True)
class RecoveryOperation:
    name: str
    message: str

    def __post_init__(self) -> None:
        invalid: list[tuple[str, t.Any, type]] = []
        name = t.cast(t.Any, self.name)
        message = t.cast(t.Any, self.message)

        if not isinstance(name, str):
            invalid.append(("name", name, type(name)))
        if not isinstance(message, str):
            invalid.append(("message", message, type(message)))

        if invalid:
            raise ValueError("Invalid RecoveryOperation values: ", invalid)


@dataclass(frozen=True)
class RecoveryStatus:
    state: RecoveryOperation | None = None
    message: str | None = None
    affectedNodes: list[str] = field(default_factory=list)  # noqa: N815

    def __post_init__(self) -> None:
        invalid: list[tuple[str, t.Any, type]] = []
        state = t.cast(t.Any, self.state)
        message = t.cast(t.Any, self.message)
        affected_nodes = t.cast(t.Any, self.affectedNodes)

        if state is not None and not isinstance(state, RecoveryOperation):
            invalid.append(("state", state, type(state)))
        if message is not None and not isinstance(message, str):
            invalid.append(("message", message, type(message)))
        if not isinstance(affected_nodes, list):
            invalid.append(("affectedNodes", affected_nodes, type(affected_nodes)))
        else:
            for index, value in enumerate(affected_nodes):
                if not isinstance(value, str):
                    invalid.append((f"affectedNodes[{index}]", value, type(value)))

        if invalid:
            raise ValueError("Invalid RecoveryStatus values: ", invalid)

    @classmethod
    def from_dict(cls, data: dict) -> RecoveryStatus:
        """Create a RecoveryStatus instance from a dict.

        This is useful for converting JSON response data into the dataclass structure.
        Handles empty dict {} by returning a RecoveryStatus with all None/default values.
        The nested 'state' dict (if present) is automatically converted to
        a RecoveryOperation instance.

        Parameters:
            data: A dict containing the recovery status data, typically
                parsed from a JSON response. Can be an empty dict.

        Returns:
            A RecoveryStatus instance with nested dataclass objects.

        Raises:
            KeyError: If required keys are missing from the input dict.
            TypeError: If nested 'state' cannot be unpacked into RecoveryOperation.
            ValueError: If field validation fails in RecoveryOperation or
                RecoveryStatus (e.g., invalid types).
        """
        # Handle empty dict case
        if not data:
            return cls()

        state = None
        if "state" in data and data["state"] is not None:
            state = RecoveryOperation(**data["state"])

        return cls(
            state=state,
            message=data.get("message"),
            affectedNodes=data.get("affectedNodes", []),
        )


@dataclass(frozen=True)
class NodeStatus:
    address: str
    nodeState: str  # noqa: N815
    term: int
    syncStatus: dict[str, str]  # noqa: N815
    lastLogTerm: int  # noqa: N815
    lastLogIndex: int  # noqa: N815
    endpoint: str
    recoveryStatus: RecoveryStatus | None  # noqa: N815
    topologyStatus: TopologyStatus | None  # noqa: N815
    clusterEnabled: bool | None  # noqa: N815

    def __post_init__(self) -> None:
        invalid: list[tuple[str, t.Any, type]] = []
        address = t.cast(t.Any, self.address)
        node_state = t.cast(t.Any, self.nodeState)
        term = t.cast(t.Any, self.term)
        sync_status = t.cast(t.Any, self.syncStatus)
        last_log_term = t.cast(t.Any, self.lastLogTerm)
        last_log_index = t.cast(t.Any, self.lastLogIndex)
        endpoint = t.cast(t.Any, self.endpoint)
        recovery_status = t.cast(t.Any, self.recoveryStatus)
        topology_status = t.cast(t.Any, self.topologyStatus)
        cluster_enabled = t.cast(t.Any, self.clusterEnabled)

        if not isinstance(address, str):
            invalid.append(("address", address, type(address)))
        if not isinstance(node_state, str):
            invalid.append(("nodeState", node_state, type(node_state)))
        if type(term) is not int:
            invalid.append(("term", term, type(term)))
        if not isinstance(sync_status, dict):
            invalid.append(("syncStatus", sync_status, type(sync_status)))
        else:
            for key, value in sync_status.items():
                if not isinstance(key, str):
                    invalid.append((f"syncStatus key '{key}'", key, type(key)))
                if not isinstance(value, str):
                    invalid.append((f"syncStatus['{key}']", value, type(value)))
        if type(last_log_term) is not int:
            invalid.append(("lastLogTerm", last_log_term, type(last_log_term)))
        if type(last_log_index) is not int:
            invalid.append(("lastLogIndex", last_log_index, type(last_log_index)))
        if not isinstance(endpoint, str):
            invalid.append(("endpoint", endpoint, type(endpoint)))
        if recovery_status is not None and not isinstance(
            recovery_status, RecoveryStatus
        ):
            invalid.append(("recoveryStatus", recovery_status, type(recovery_status)))
        if topology_status is not None and not isinstance(
            topology_status, TopologyStatus
        ):
            invalid.append(("topologyStatus", topology_status, type(topology_status)))
        if cluster_enabled is not None and type(cluster_enabled) is not bool:
            invalid.append(("clusterEnabled", cluster_enabled, type(cluster_enabled)))

        if invalid:
            raise ValueError("Invalid NodeStatus values: ", invalid)

    @classmethod
    def from_dict(cls, data: dict) -> NodeStatus:
        """Create a NodeStatus instance from a dict.

        This is useful for converting JSON response data into the dataclass structure.
        The nested 'recoveryStatus' and 'topologyStatus' dicts are automatically
        converted to their respective dataclass instances.

        Parameters:
            data: A dict containing the node status data, typically
                parsed from a JSON response.

        Returns:
            A NodeStatus instance with nested dataclass objects.

        Raises:
            KeyError: If required keys are missing from the input dict.
            TypeError: If nested dicts cannot be unpacked into their respective
                dataclass instances.
            ValueError: If field validation fails in TopologyStatus, RecoveryOperation,
                RecoveryStatus, or NodeStatus (e.g., invalid types).
        """
        # Handle recoveryStatus - can be empty dict or actual data
        recovery_status = None
        if "recoveryStatus" in data and data["recoveryStatus"]:
            recovery_status = RecoveryStatus.from_dict(data["recoveryStatus"])
        elif "recoveryStatus" in data:
            # Empty dict case
            recovery_status = RecoveryStatus.from_dict({})

        # Handle topologyStatus - optional field
        topology_status = None
        if "topologyStatus" in data and data["topologyStatus"]:
            topology_status = TopologyStatus(**data["topologyStatus"])

        return cls(
            address=data["address"],
            nodeState=data["nodeState"],
            term=data["term"],
            syncStatus=data["syncStatus"],
            lastLogTerm=data["lastLogTerm"],
            lastLogIndex=data["lastLogIndex"],
            endpoint=data["endpoint"],
            recoveryStatus=recovery_status,
            topologyStatus=topology_status,
            clusterEnabled=data.get("clusterEnabled"),
        )


@dataclass(frozen=True)
class ClusterRequest:
    electionMinTimeout: int  # noqa: N815
    electionRangeTimeout: int  # noqa: N815
    heartbeatInterval: int  # noqa: N815
    messageSizeKB: int  # noqa: N815
    verificationTimeout: int  # noqa: N815
    transactionLogMaximumSizeGB: int  # noqa: N815
    batchUpdateInterval: int  # noqa: N815
    nodes: list[str]

    def __post_init__(self) -> None:
        invalid: list[tuple[str, t.Any, type]] = []
        election_min_timeout = t.cast(t.Any, self.electionMinTimeout)
        election_range_timeout = t.cast(t.Any, self.electionRangeTimeout)
        heartbeat_interval = t.cast(t.Any, self.heartbeatInterval)
        message_size_kb = t.cast(t.Any, self.messageSizeKB)
        verification_timeout = t.cast(t.Any, self.verificationTimeout)
        transaction_log_maximum_size_gb = t.cast(
            t.Any, self.transactionLogMaximumSizeGB
        )
        batch_update_interval = t.cast(t.Any, self.batchUpdateInterval)
        nodes = t.cast(t.Any, self.nodes)

        if type(election_min_timeout) is not int:
            invalid.append(
                ("electionMinTimeout", election_min_timeout, type(election_min_timeout))
            )
        if type(election_range_timeout) is not int:
            invalid.append(
                (
                    "electionRangeTimeout",
                    election_range_timeout,
                    type(election_range_timeout),
                )
            )
        if type(heartbeat_interval) is not int:
            invalid.append(
                ("heartbeatInterval", heartbeat_interval, type(heartbeat_interval))
            )
        if type(message_size_kb) is not int:
            invalid.append(("messageSizeKB", message_size_kb, type(message_size_kb)))
        if type(verification_timeout) is not int:
            invalid.append(
                (
                    "verificationTimeout",
                    verification_timeout,
                    type(verification_timeout),
                )
            )
        if type(transaction_log_maximum_size_gb) is not int:
            invalid.append(
                (
                    "transactionLogMaximumSizeGB",
                    transaction_log_maximum_size_gb,
                    type(transaction_log_maximum_size_gb),
                )
            )
        if type(batch_update_interval) is not int:
            invalid.append(
                (
                    "batchUpdateInterval",
                    batch_update_interval,
                    type(batch_update_interval),
                )
            )

        if not isinstance(nodes, list):
            invalid.append(("nodes", nodes, type(nodes)))
        else:
            for index, value in enumerate(nodes):
                if not isinstance(value, str):
                    invalid.append((f"nodes[{index}]", value, type(value)))

        if invalid:
            raise ValueError("Invalid ClusterRequest values: ", invalid)

    @classmethod
    def from_dict(cls, data: dict) -> ClusterRequest:
        """Create a ClusterRequest instance from a dict.

        This is useful for converting JSON response data into the dataclass structure.

        Parameters:
            data: A dict containing the cluster request data, typically
                parsed from a JSON response.

        Returns:
            A ClusterRequest instance.

        Raises:
            KeyError: If required keys are missing from the input dict.
            TypeError: If the dict cannot be unpacked into ClusterRequest.
            ValueError: If field validation fails in ClusterRequest
                (e.g., invalid types for integer fields or nodes).
        """
        return cls(
            electionMinTimeout=data["electionMinTimeout"],
            electionRangeTimeout=data["electionRangeTimeout"],
            heartbeatInterval=data["heartbeatInterval"],
            messageSizeKB=data["messageSizeKB"],
            verificationTimeout=data["verificationTimeout"],
            transactionLogMaximumSizeGB=data["transactionLogMaximumSizeGB"],
            batchUpdateInterval=data["batchUpdateInterval"],
            nodes=data["nodes"],
        )


@dataclass(frozen=True)
class SnapshotOptionsBean:
    withRepositoryData: bool  # noqa: N815
    withSystemData: bool  # noqa: N815
    cleanDataDir: bool  # noqa: N815
    repositories: list[str] | None = None

    def __post_init__(self) -> None:
        invalid: list[tuple[str, t.Any, type]] = []
        with_repository_data = t.cast(t.Any, self.withRepositoryData)
        with_system_data = t.cast(t.Any, self.withSystemData)
        clean_data_dir = t.cast(t.Any, self.cleanDataDir)
        repositories = t.cast(t.Any, self.repositories)

        if type(with_repository_data) is not bool:
            invalid.append(
                ("withRepositoryData", with_repository_data, type(with_repository_data))
            )
        if type(with_system_data) is not bool:
            invalid.append(("withSystemData", with_system_data, type(with_system_data)))
        if type(clean_data_dir) is not bool:
            invalid.append(("cleanDataDir", clean_data_dir, type(clean_data_dir)))

        if repositories is not None:
            if not isinstance(repositories, list):
                invalid.append(("repositories", repositories, type(repositories)))
            else:
                for index, value in enumerate(repositories):
                    if not isinstance(value, str):
                        invalid.append((f"repositories[{index}]", value, type(value)))

        if invalid:
            raise ValueError("Invalid SnapshotOptionsBean values: ", invalid)


@dataclass(frozen=True)
class BackupOperationBean:
    id: str
    username: str
    operation: t.Literal[
        "CREATE_BACKUP_IN_PROGRESS",
        "RESTORE_BACKUP_IN_PROGRESS",
        "CREATE_CLOUD_BACKUP_IN_PROGRESS",
        "RESTORE_CLOUD_BACKUP_IN_PROGRESS",
    ]
    affectedRepositories: list[str]  # noqa: N815
    msSinceCreated: int  # noqa: N815
    snapshotOptions: SnapshotOptionsBean  # noqa: N815
    nodePerformingClusterBackup: str | None = None  # noqa: N815

    def __post_init__(self) -> None:
        _allowed_operations = {
            "CREATE_BACKUP_IN_PROGRESS",
            "RESTORE_BACKUP_IN_PROGRESS",
            "CREATE_CLOUD_BACKUP_IN_PROGRESS",
            "RESTORE_CLOUD_BACKUP_IN_PROGRESS",
        }
        invalid: list[tuple[str, t.Any, type]] = []
        id_ = t.cast(t.Any, self.id)
        username = t.cast(t.Any, self.username)
        operation = t.cast(t.Any, self.operation)
        affected_repositories = t.cast(t.Any, self.affectedRepositories)
        ms_since_created = t.cast(t.Any, self.msSinceCreated)
        snapshot_options = t.cast(t.Any, self.snapshotOptions)
        node_performing_cluster_backup = t.cast(t.Any, self.nodePerformingClusterBackup)

        if not isinstance(id_, str):
            invalid.append(("id", id_, type(id_)))
        if not isinstance(username, str):
            invalid.append(("username", username, type(username)))
        if not isinstance(operation, str) or operation not in _allowed_operations:
            invalid.append(("operation", operation, type(operation)))
        if not isinstance(affected_repositories, list):
            invalid.append(
                (
                    "affectedRepositories",
                    affected_repositories,
                    type(affected_repositories),
                )
            )
        else:
            for index, value in enumerate(affected_repositories):
                if not isinstance(value, str):
                    invalid.append(
                        (f"affectedRepositories[{index}]", value, type(value))
                    )
        if type(ms_since_created) is not int:
            invalid.append(("msSinceCreated", ms_since_created, type(ms_since_created)))
        if not isinstance(snapshot_options, SnapshotOptionsBean):
            invalid.append(
                ("snapshotOptions", snapshot_options, type(snapshot_options))
            )
        if node_performing_cluster_backup is not None and not isinstance(
            node_performing_cluster_backup, str
        ):
            invalid.append(
                (
                    "nodePerformingClusterBackup",
                    node_performing_cluster_backup,
                    type(node_performing_cluster_backup),
                )
            )

        if invalid:
            raise ValueError("Invalid BackupOperationBean values: ", invalid)

    @classmethod
    def from_dict(cls, data: dict) -> BackupOperationBean:
        """Create a BackupOperationBean instance from a dict.

        This is useful for converting JSON response data into the dataclass structure.
        The nested 'snapshotOptions' dict is automatically converted to
        a SnapshotOptionsBean instance.

        Parameters:
            data: A dict containing the backup operation data, typically
                parsed from a JSON response.

        Returns:
            A BackupOperationBean instance with nested dataclass objects.

        Raises:
            KeyError: If required keys are missing from the input dict.
            TypeError: If nested 'snapshotOptions' cannot be unpacked into
                SnapshotOptionsBean.
            ValueError: If field validation fails in SnapshotOptionsBean or
                BackupOperationBean (e.g., invalid types or operation values).
        """
        snapshot_options = SnapshotOptionsBean(**data["snapshotOptions"])
        return cls(
            id=data["id"],
            username=data["username"],
            operation=data["operation"],
            affectedRepositories=data["affectedRepositories"],
            msSinceCreated=data["msSinceCreated"],
            snapshotOptions=snapshot_options,
            nodePerformingClusterBackup=data.get("nodePerformingClusterBackup"),
        )


@dataclass(frozen=True)
class StructuresStatistics:
    cacheHit: int  # noqa: N815
    cacheMiss: int  # noqa: N815

    def __post_init__(self) -> None:
        invalid: list[tuple[str, t.Any, type]] = []
        cache_hit = t.cast(t.Any, self.cacheHit)
        cache_miss = t.cast(t.Any, self.cacheMiss)

        if type(cache_hit) is not int:
            invalid.append(("cacheHit", cache_hit, type(cache_hit)))
        if type(cache_miss) is not int:
            invalid.append(("cacheMiss", cache_miss, type(cache_miss)))

        if invalid:
            raise ValueError("Invalid StructuresStatistics values: ", invalid)


@dataclass(frozen=True)
class RepositoryStatisticsQueries:
    slow: int
    suboptimal: int

    def __post_init__(self) -> None:
        invalid: list[tuple[str, t.Any, type]] = []
        slow = t.cast(t.Any, self.slow)
        suboptimal = t.cast(t.Any, self.suboptimal)

        if type(slow) is not int:
            invalid.append(("slow", slow, type(slow)))
        if type(suboptimal) is not int:
            invalid.append(("suboptimal", suboptimal, type(suboptimal)))

        if invalid:
            raise ValueError("Invalid RepositoryStatisticsQueries values: ", invalid)


@dataclass(frozen=True)
class RepositoryStatisticsEntityPool:
    epoolReads: int  # noqa: N815
    epoolWrites: int  # noqa: N815
    epoolSize: int  # noqa: N815

    def __post_init__(self) -> None:
        invalid: list[tuple[str, t.Any, type]] = []
        epool_reads = t.cast(t.Any, self.epoolReads)
        epool_writes = t.cast(t.Any, self.epoolWrites)
        epool_size = t.cast(t.Any, self.epoolSize)

        if type(epool_reads) is not int:
            invalid.append(("epoolReads", epool_reads, type(epool_reads)))
        if type(epool_writes) is not int:
            invalid.append(("epoolWrites", epool_writes, type(epool_writes)))
        if type(epool_size) is not int:
            invalid.append(("epoolSize", epool_size, type(epool_size)))

        if invalid:
            raise ValueError("Invalid RepositoryStatisticsEntityPool values: ", invalid)


@dataclass(frozen=True)
class RepositoryStatistics:
    queries: RepositoryStatisticsQueries
    entityPool: RepositoryStatisticsEntityPool  # noqa: N815
    activeTransactions: int  # noqa: N815
    openConnections: int  # noqa: N815

    def __post_init__(self) -> None:
        invalid: list[tuple[str, t.Any, type]] = []
        queries = t.cast(t.Any, self.queries)
        entity_pool = t.cast(t.Any, self.entityPool)
        active_transactions = t.cast(t.Any, self.activeTransactions)
        open_connections = t.cast(t.Any, self.openConnections)

        if not isinstance(queries, RepositoryStatisticsQueries):
            invalid.append(("queries", queries, type(queries)))
        if not isinstance(entity_pool, RepositoryStatisticsEntityPool):
            invalid.append(("entityPool", entity_pool, type(entity_pool)))
        if type(active_transactions) is not int:
            invalid.append(
                ("activeTransactions", active_transactions, type(active_transactions))
            )
        if type(open_connections) is not int:
            invalid.append(
                ("openConnections", open_connections, type(open_connections))
            )

        if invalid:
            raise ValueError("Invalid RepositoryStatistics values: ", invalid)

    @classmethod
    def from_dict(cls, data: dict) -> RepositoryStatistics:
        """Create a RepositoryStatistics instance from a dict.

        This is useful for converting JSON response data into the dataclass structure.
        The nested 'queries' and 'entityPool' dicts are automatically converted to
        their respective dataclass instances.

        Parameters:
            data: A dict containing the repository statistics data, typically
                parsed from a JSON response.

        Returns:
            A RepositoryStatistics instance with nested dataclass objects.

        Raises:
            KeyError: If required keys are missing from the input dict.
            TypeError: If nested dicts cannot be unpacked into their respective
                dataclass instances.
            ValueError: If field validation fails in RepositoryStatisticsQueries,
                RepositoryStatisticsEntityPool, or RepositoryStatistics
                (e.g., invalid types).
        """
        queries = RepositoryStatisticsQueries(**data["queries"])
        entity_pool = RepositoryStatisticsEntityPool(**data["entityPool"])
        return cls(
            queries=queries,
            entityPool=entity_pool,
            activeTransactions=data["activeTransactions"],
            openConnections=data["openConnections"],
        )


@dataclass(frozen=True)
class InfrastructureMemoryUsage:
    max: int
    committed: int
    init: int
    used: int

    def __post_init__(self) -> None:
        invalid: list[tuple[str, t.Any, type]] = []
        max_val = t.cast(t.Any, self.max)
        committed = t.cast(t.Any, self.committed)
        init = t.cast(t.Any, self.init)
        used = t.cast(t.Any, self.used)

        if type(max_val) is not int:
            invalid.append(("max", max_val, type(max_val)))
        if type(committed) is not int:
            invalid.append(("committed", committed, type(committed)))
        if type(init) is not int:
            invalid.append(("init", init, type(init)))
        if type(used) is not int:
            invalid.append(("used", used, type(used)))

        if invalid:
            raise ValueError("Invalid InfrastructureMemoryUsage values: ", invalid)


@dataclass(frozen=True)
class InfrastructureStorageMemory:
    dataDirUsed: int  # noqa: N815
    workDirUsed: int  # noqa: N815
    logsDirUsed: int  # noqa: N815
    dataDirFree: int  # noqa: N815
    workDirFree: int  # noqa: N815
    logsDirFree: int  # noqa: N815

    def __post_init__(self) -> None:
        invalid: list[tuple[str, t.Any, type]] = []
        data_dir_used = t.cast(t.Any, self.dataDirUsed)
        work_dir_used = t.cast(t.Any, self.workDirUsed)
        logs_dir_used = t.cast(t.Any, self.logsDirUsed)
        data_dir_free = t.cast(t.Any, self.dataDirFree)
        work_dir_free = t.cast(t.Any, self.workDirFree)
        logs_dir_free = t.cast(t.Any, self.logsDirFree)

        if type(data_dir_used) is not int:
            invalid.append(("dataDirUsed", data_dir_used, type(data_dir_used)))
        if type(work_dir_used) is not int:
            invalid.append(("workDirUsed", work_dir_used, type(work_dir_used)))
        if type(logs_dir_used) is not int:
            invalid.append(("logsDirUsed", logs_dir_used, type(logs_dir_used)))
        if type(data_dir_free) is not int:
            invalid.append(("dataDirFree", data_dir_free, type(data_dir_free)))
        if type(work_dir_free) is not int:
            invalid.append(("workDirFree", work_dir_free, type(work_dir_free)))
        if type(logs_dir_free) is not int:
            invalid.append(("logsDirFree", logs_dir_free, type(logs_dir_free)))

        if invalid:
            raise ValueError("Invalid InfrastructureStorageMemory values: ", invalid)


@dataclass(frozen=True)
class InfrastructureStatistics:
    heapMemoryUsage: InfrastructureMemoryUsage  # noqa: N815
    nonHeapMemoryUsage: InfrastructureMemoryUsage  # noqa: N815
    storageMemory: InfrastructureStorageMemory  # noqa: N815
    threadCount: int  # noqa: N815
    cpuLoad: float  # noqa: N815
    classCount: int  # noqa: N815
    gcCount: int  # noqa: N815
    openFileDescriptors: int  # noqa: N815
    maxFileDescriptors: int  # noqa: N815

    def __post_init__(self) -> None:
        invalid: list[tuple[str, t.Any, type]] = []
        heap_memory_usage = t.cast(t.Any, self.heapMemoryUsage)
        non_heap_memory_usage = t.cast(t.Any, self.nonHeapMemoryUsage)
        storage_memory = t.cast(t.Any, self.storageMemory)
        thread_count = t.cast(t.Any, self.threadCount)
        cpu_load = t.cast(t.Any, self.cpuLoad)
        class_count = t.cast(t.Any, self.classCount)
        gc_count = t.cast(t.Any, self.gcCount)
        open_file_descriptors = t.cast(t.Any, self.openFileDescriptors)
        max_file_descriptors = t.cast(t.Any, self.maxFileDescriptors)

        if not isinstance(heap_memory_usage, InfrastructureMemoryUsage):
            invalid.append(
                ("heapMemoryUsage", heap_memory_usage, type(heap_memory_usage))
            )
        if not isinstance(non_heap_memory_usage, InfrastructureMemoryUsage):
            invalid.append(
                (
                    "nonHeapMemoryUsage",
                    non_heap_memory_usage,
                    type(non_heap_memory_usage),
                )
            )
        if not isinstance(storage_memory, InfrastructureStorageMemory):
            invalid.append(("storageMemory", storage_memory, type(storage_memory)))
        if type(thread_count) is not int:
            invalid.append(("threadCount", thread_count, type(thread_count)))
        if type(cpu_load) is not float and type(cpu_load) is not int:
            invalid.append(("cpuLoad", cpu_load, type(cpu_load)))
        if type(class_count) is not int:
            invalid.append(("classCount", class_count, type(class_count)))
        if type(gc_count) is not int:
            invalid.append(("gcCount", gc_count, type(gc_count)))
        if type(open_file_descriptors) is not int:
            invalid.append(
                (
                    "openFileDescriptors",
                    open_file_descriptors,
                    type(open_file_descriptors),
                )
            )
        if type(max_file_descriptors) is not int:
            invalid.append(
                ("maxFileDescriptors", max_file_descriptors, type(max_file_descriptors))
            )

        if invalid:
            raise ValueError("Invalid InfrastructureStatistics values: ", invalid)

    @classmethod
    def from_dict(cls, data: dict) -> InfrastructureStatistics:
        """Create an InfrastructureStatistics instance from a dict.

        This is useful for converting JSON response data into the dataclass structure.
        The nested memory and storage dicts are automatically converted to their
        respective dataclass instances.

        Parameters:
            data: A dict containing the infrastructure statistics data, typically
                parsed from a JSON response.

        Returns:
            An InfrastructureStatistics instance with nested dataclass objects.

        Raises:
            KeyError: If required keys are missing from the input dict.
            TypeError: If nested dicts cannot be unpacked into their respective
                dataclass instances.
            ValueError: If field validation fails in InfrastructureMemoryUsage,
                InfrastructureStorageMemory, or InfrastructureStatistics
                (e.g., invalid types).
        """
        heap_memory_usage = InfrastructureMemoryUsage(**data["heapMemoryUsage"])
        non_heap_memory_usage = InfrastructureMemoryUsage(**data["nonHeapMemoryUsage"])
        storage_memory = InfrastructureStorageMemory(**data["storageMemory"])
        return cls(
            heapMemoryUsage=heap_memory_usage,
            nonHeapMemoryUsage=non_heap_memory_usage,
            storageMemory=storage_memory,
            threadCount=data["threadCount"],
            cpuLoad=float(data["cpuLoad"]),
            classCount=data["classCount"],
            gcCount=data["gcCount"],
            openFileDescriptors=data["openFileDescriptors"],
            maxFileDescriptors=data["maxFileDescriptors"],
        )


@dataclass(frozen=True)
class ParserSettings:
    preserveBNodeIds: bool = False  # noqa: N815
    failOnUnknownDataTypes: bool = False  # noqa: N815
    verifyDataTypeValues: bool = False  # noqa: N815
    normalizeDataTypeValues: bool = False  # noqa: N815
    failOnUnknownLanguageTags: bool = False  # noqa: N815
    verifyLanguageTags: bool = True  # noqa: N815
    normalizeLanguageTags: bool = False  # noqa: N815
    stopOnError: bool = True  # noqa: N815
    contextLink: t.Any | None = None  # noqa: N815

    def __post_init__(self) -> None:
        invalid: list[tuple[str, t.Any, type]] = []
        preserve_bnode_ids = t.cast(t.Any, self.preserveBNodeIds)
        fail_on_unknown_data_types = t.cast(t.Any, self.failOnUnknownDataTypes)
        verify_data_type_values = t.cast(t.Any, self.verifyDataTypeValues)
        normalize_data_type_values = t.cast(t.Any, self.normalizeDataTypeValues)
        fail_on_unknown_language_tags = t.cast(t.Any, self.failOnUnknownLanguageTags)
        verify_language_tags = t.cast(t.Any, self.verifyLanguageTags)
        normalize_language_tags = t.cast(t.Any, self.normalizeLanguageTags)
        stop_on_error = t.cast(t.Any, self.stopOnError)

        if type(preserve_bnode_ids) is not bool:
            invalid.append(
                ("preserveBNodeIds", preserve_bnode_ids, type(preserve_bnode_ids))
            )
        if type(fail_on_unknown_data_types) is not bool:
            invalid.append(
                (
                    "failOnUnknownDataTypes",
                    fail_on_unknown_data_types,
                    type(fail_on_unknown_data_types),
                )
            )
        if type(verify_data_type_values) is not bool:
            invalid.append(
                (
                    "verifyDataTypeValues",
                    verify_data_type_values,
                    type(verify_data_type_values),
                )
            )
        if type(normalize_data_type_values) is not bool:
            invalid.append(
                (
                    "normalizeDataTypeValues",
                    normalize_data_type_values,
                    type(normalize_data_type_values),
                )
            )
        if type(fail_on_unknown_language_tags) is not bool:
            invalid.append(
                (
                    "failOnUnknownLanguageTags",
                    fail_on_unknown_language_tags,
                    type(fail_on_unknown_language_tags),
                )
            )
        if type(verify_language_tags) is not bool:
            invalid.append(
                ("verifyLanguageTags", verify_language_tags, type(verify_language_tags))
            )
        if type(normalize_language_tags) is not bool:
            invalid.append(
                (
                    "normalizeLanguageTags",
                    normalize_language_tags,
                    type(normalize_language_tags),
                )
            )
        if type(stop_on_error) is not bool:
            invalid.append(("stopOnError", stop_on_error, type(stop_on_error)))

        # Note: don't check contextLink here since it's of type t.Any.

        if invalid:
            raise ValueError("Invalid ParserSettings values: ", invalid)

    def as_dict(self) -> dict[str, t.Any]:
        return asdict(self)


@dataclass(frozen=True)
class ImportSettings:
    name: str
    status: t.Literal["PENDING", "IMPORTING", "DONE", "ERROR", "NONE", "INTERRUPTING"]
    size: str
    lastModified: int  # noqa: N815
    imported: int
    addedStatements: int  # noqa: N815
    removedStatements: int  # noqa: N815
    numReplacedGraphs: int  # noqa: N815
    message: str = ""
    context: t.Any | None = None
    replaceGraphs: t.List = field(default_factory=list)  # noqa: N815
    baseURI: t.Any | None = None  # noqa: N815
    forceSerial: bool = False  # noqa: N815
    type: str = "file"
    format: t.Any | None = None
    data: t.Any | None = None
    parserSettings: ParserSettings = field(default_factory=ParserSettings)  # noqa: N815

    def __post_init__(self) -> None:
        _allowed_status = {
            "PENDING",
            "IMPORTING",
            "DONE",
            "ERROR",
            "NONE",
            "INTERRUPTING",
        }
        invalid: list[tuple[str, t.Any, type]] = []

        name = t.cast(t.Any, self.name)
        status = t.cast(t.Any, self.status)
        message = t.cast(t.Any, self.message)
        replace_graphs = t.cast(t.Any, self.replaceGraphs)
        force_serial = t.cast(t.Any, self.forceSerial)
        type_ = t.cast(t.Any, self.type)
        parser_settings = t.cast(t.Any, self.parserSettings)
        size = t.cast(t.Any, self.size)
        last_modified = t.cast(t.Any, self.lastModified)
        imported = t.cast(t.Any, self.imported)
        added_statements = t.cast(t.Any, self.addedStatements)
        removed_statements = t.cast(t.Any, self.removedStatements)
        num_replaced_graphs = t.cast(t.Any, self.numReplacedGraphs)

        if not isinstance(name, str):
            invalid.append(("name", name, type(name)))
        if status not in _allowed_status:
            invalid.append(("status", status, type(status)))
        if not isinstance(message, str):
            invalid.append(("message", message, type(message)))
        if not isinstance(replace_graphs, list):
            invalid.append(("replaceGraphs", replace_graphs, type(replace_graphs)))
        if type(force_serial) is not bool:
            invalid.append(("forceSerial", force_serial, type(force_serial)))
        if not isinstance(type_, str):
            invalid.append(("type", type_, type(type_)))
        if not isinstance(parser_settings, ParserSettings):
            invalid.append(("parserSettings", parser_settings, type(parser_settings)))
        if not isinstance(size, str):
            invalid.append(("size", size, type(size)))
        if type(last_modified) is not int:
            invalid.append(("lastModified", last_modified, type(last_modified)))
        if type(imported) is not int:
            invalid.append(("imported", imported, type(imported)))
        if type(added_statements) is not int:
            invalid.append(
                ("addedStatements", added_statements, type(added_statements))
            )
        if type(removed_statements) is not int:
            invalid.append(
                ("removedStatements", removed_statements, type(removed_statements))
            )
        if type(num_replaced_graphs) is not int:
            invalid.append(
                ("numReplacedGraphs", num_replaced_graphs, type(num_replaced_graphs))
            )

        # Note: don't check context, baseURI, format, or data here since they are of type t.Any.

        if invalid:
            raise ValueError("Invalid ImportSettings values: ", invalid)

    def as_dict(self) -> dict[str, t.Any]:
        return asdict(self)


@dataclass(frozen=True)
class ServerImportBody:
    fileNames: list[str]  # noqa: N815
    importSettings: ImportSettings | None = None  # noqa: N815

    def __post_init__(self) -> None:
        invalid: list[tuple[str, t.Any, type]] = []
        import_settings = t.cast(t.Any, self.importSettings)
        file_names = t.cast(t.Any, self.fileNames)

        if import_settings is not None and not isinstance(
            import_settings, ImportSettings
        ):
            invalid.append(("importSettings", import_settings, type(import_settings)))
        if not isinstance(file_names, list):
            invalid.append(("fileNames", file_names, type(file_names)))
        else:
            for index, value in enumerate(file_names):
                if not isinstance(value, str):
                    invalid.append((f"fileNames[{index}]", value, type(value)))

        if invalid:
            raise ValueError("Invalid ServerImportBody values: ", invalid)

    def as_dict(self) -> dict[str, t.Any]:
        result = asdict(self)
        if self.importSettings is None:
            result.pop("importSettings", None)
        return result


@dataclass(frozen=True)
class UserUpdate:
    password: str = field(default="")
    appSettings: dict[str, t.Any] = field(default_factory=dict)  # noqa: N815
    gptThreads: list[t.Any] = field(default_factory=list)  # noqa: N815

    def as_dict(self) -> dict[str, t.Any]:
        return asdict(self)


@dataclass(frozen=True)
class UserCreate:
    """Dataclass for creating a new user in GraphDB.

    Unlike `User`, this class does not include `dateCreated` since
    GraphDB automatically assigns this value when the user is created.
    """

    username: str
    password: str
    grantedAuthorities: list[str] = field(default_factory=list)  # noqa: N815
    appSettings: dict[str, t.Any] = field(default_factory=dict)  # noqa: N815
    gptThreads: list[t.Any] = field(default_factory=list)  # noqa: N815

    def __post_init__(self) -> None:
        invalid: list[tuple[str, t.Any, type]] = []
        username = t.cast(t.Any, self.username)
        password = t.cast(t.Any, self.password)
        granted_authorities = t.cast(t.Any, self.grantedAuthorities)
        app_settings = t.cast(t.Any, self.appSettings)
        gpt_threads = t.cast(t.Any, self.gptThreads)

        if not isinstance(username, str):
            invalid.append(("username", username, type(username)))
        if not isinstance(password, str):
            invalid.append(("password", password, type(password)))

        if not isinstance(granted_authorities, list):
            invalid.append(
                ("grantedAuthorities", granted_authorities, type(granted_authorities))
            )
        else:
            for index, value in enumerate(granted_authorities):
                if not isinstance(value, str):
                    invalid.append((f"grantedAuthorities[{index}]", value, type(value)))

        if not isinstance(app_settings, dict):
            invalid.append(("appSettings", app_settings, type(app_settings)))
        else:
            for key in app_settings.keys():
                if not isinstance(key, str):
                    invalid.append(("appSettings key", key, type(key)))
                    break

        if not isinstance(gpt_threads, list):
            invalid.append(("gptThreads", gpt_threads, type(gpt_threads)))

        if invalid:
            raise ValueError("Invalid UserCreate values: ", invalid)

    def as_dict(self) -> dict[str, t.Any]:
        return asdict(self)


@dataclass(frozen=True)
class User:
    username: str
    password: str
    dateCreated: int  # noqa: N815
    grantedAuthorities: list[str] = field(default_factory=list)  # noqa: N815
    appSettings: dict[str, t.Any] = field(default_factory=dict)  # noqa: N815
    gptThreads: list[t.Any] = field(default_factory=list)  # noqa: N815

    def __post_init__(self) -> None:
        # Normalize None values from API responses to empty collections
        if self.grantedAuthorities is None:
            object.__setattr__(self, "grantedAuthorities", [])  # type: ignore[unreachable]
        if self.appSettings is None:
            object.__setattr__(self, "appSettings", {})  # type: ignore[unreachable]
        if self.gptThreads is None:
            object.__setattr__(self, "gptThreads", [])  # type: ignore[unreachable]

        invalid: list[tuple[str, t.Any, type]] = []
        username = t.cast(t.Any, self.username)
        password = t.cast(t.Any, self.password)
        date_created = t.cast(t.Any, self.dateCreated)
        granted_authorities = t.cast(t.Any, self.grantedAuthorities)
        app_settings = t.cast(t.Any, self.appSettings)
        gpt_threads = t.cast(t.Any, self.gptThreads)

        if not isinstance(username, str):
            invalid.append(("username", username, type(username)))
        if not isinstance(password, str):
            invalid.append(("password", password, type(password)))
        if not isinstance(date_created, int):
            invalid.append(("dateCreated", date_created, type(date_created)))

        if not isinstance(granted_authorities, list):
            invalid.append(
                ("grantedAuthorities", granted_authorities, type(granted_authorities))
            )
        else:
            for index, value in enumerate(granted_authorities):
                if not isinstance(value, str):
                    invalid.append((f"grantedAuthorities[{index}]", value, type(value)))

        if not isinstance(app_settings, dict):
            invalid.append(("appSettings", app_settings, type(app_settings)))
        else:
            for key in app_settings.keys():
                if not isinstance(key, str):
                    invalid.append(("appSettings key", key, type(key)))
                    break

        if not isinstance(gpt_threads, list):
            invalid.append(("gptThreads", gpt_threads, type(gpt_threads)))

        if invalid:
            raise ValueError("Invalid User values: ", invalid)

    def as_dict(self):
        return asdict(self)


@dataclass(frozen=True)
class AuthenticatedUser:
    """Represents an authenticated user returned from POST /rest/login.

    Attributes:
        username: The username of the authenticated user.
        authorities: List of granted authorities/roles (e.g., ["ROLE_USER", "ROLE_ADMIN"]).
        appSettings: Application settings for the user.
        external: Whether the user is external (e.g., from LDAP/OAuth).
        token: The full Authorization header value (e.g., "GDB <token>").
            Can be passed directly to GraphDBClient's auth parameter.
    """

    username: str
    authorities: list[str] = field(default_factory=list)
    appSettings: dict[str, t.Any] = field(default_factory=dict)  # noqa: N815
    external: bool = False
    token: str = ""

    def __post_init__(self) -> None:
        # Normalize None values from API responses to empty collections
        if self.authorities is None:
            object.__setattr__(self, "authorities", [])  # type: ignore[unreachable]
        if self.appSettings is None:
            object.__setattr__(self, "appSettings", {})  # type: ignore[unreachable]

        invalid: list[tuple[str, t.Any, type]] = []
        username = t.cast(t.Any, self.username)
        authorities = t.cast(t.Any, self.authorities)
        app_settings = t.cast(t.Any, self.appSettings)
        external = t.cast(t.Any, self.external)
        token = t.cast(t.Any, self.token)

        if not isinstance(username, str):
            invalid.append(("username", username, type(username)))
        if not isinstance(authorities, list):
            invalid.append(("authorities", authorities, type(authorities)))
        else:
            for index, value in enumerate(authorities):
                if not isinstance(value, str):
                    invalid.append((f"authorities[{index}]", value, type(value)))
        if not isinstance(app_settings, dict):
            invalid.append(("appSettings", app_settings, type(app_settings)))
        else:
            for key in app_settings.keys():
                if not isinstance(key, str):
                    invalid.append(("appSettings key", key, type(key)))
                    break
        if type(external) is not bool:
            invalid.append(("external", external, type(external)))
        if not isinstance(token, str):
            invalid.append(("token", token, type(token)))

        if invalid:
            raise ValueError("Invalid AuthenticatedUser values: ", invalid)

    @classmethod
    def from_response(cls, data: dict[str, t.Any], token: str) -> AuthenticatedUser:
        """Create an AuthenticatedUser from API response data and token.

        Parameters:
            data: The JSON response body from POST /rest/login.
            token: The GDB token extracted from the Authorization header.

        Returns:
            An AuthenticatedUser instance.

        Raises:
            ValueError: If required fields are missing or invalid.
            TypeError: If data is not a dict.
        """
        if not isinstance(data, dict):
            raise TypeError("Response data must be a dict")
        if "username" not in data:
            raise ValueError("Response data must contain 'username'")

        return cls(
            username=data["username"],
            authorities=data.get("authorities", []),
            appSettings=data.get("appSettings", {}),
            external=data.get("external", False),
            token=token,
        )


@dataclass(frozen=True)
class FreeAccessSettings:
    enabled: bool
    authorities: list[str] = field(default_factory=list)
    appSettings: dict[str, t.Any] = field(default_factory=dict)  # noqa: N815

    def __post_init__(self) -> None:
        invalid: list[tuple[str, t.Any, type]] = []
        enabled = t.cast(t.Any, self.enabled)
        authorities = t.cast(t.Any, self.authorities)
        app_settings = t.cast(t.Any, self.appSettings)
        if type(enabled) is not bool:
            invalid.append(("enabled", enabled, type(enabled)))
        if not isinstance(authorities, list):
            invalid.append(("authorities", authorities, type(authorities)))
        else:
            for index, value in enumerate(authorities):
                if not isinstance(value, str):
                    invalid.append((f"authorities[{index}]", value, type(value)))
        if not isinstance(app_settings, dict):
            invalid.append(("appSettings", app_settings, type(app_settings)))
        else:
            for key in app_settings.keys():
                if not isinstance(key, str):
                    invalid.append(("appSettings key", key, type(key)))
                    break

        if invalid:
            raise ValueError("Invalid FreeAccessSettings values: ", invalid)

    def as_dict(self):
        return asdict(self)


@dataclass(frozen=True)
class RepositorySizeInfo:
    inferred: int
    total: int
    explicit: int

    def __post_init__(self):
        invalid = []
        if type(self.inferred) is not int:
            invalid.append("inferred")
        if type(self.total) is not int:
            invalid.append("total")
        if type(self.explicit) is not int:
            invalid.append("explicit")

        if invalid:
            raise ValueError(
                "Invalid RepositorySizeInfo values: ",
                [(x, self.__dict__[x], type(self.__dict__[x])) for x in invalid],
            )


@dataclass(frozen=True)
class OWLimParameter:
    name: str
    label: str
    value: str


@dataclass(frozen=True)
class RepositoryConfigBean:
    id: str
    title: str
    type: str
    sesameType: str  # noqa: N815
    location: str
    params: dict[str, OWLimParameter] = field(default_factory=dict)


@dataclass(frozen=True)
class RepositoryConfigBeanCreate:
    id: str
    title: str
    type: str
    sesameType: str  # noqa: N815
    location: str
    params: dict[str, OWLimParameter] = field(default_factory=dict)
    missingDefaults: dict[str, OWLimParameter] = field(  # noqa: N815
        default_factory=dict
    )

    def as_dict(self) -> dict:
        """Serialize the dataclass to a Python dict.

        Returns:
            dict: A dictionary representation of the dataclass suitable for use
                with httpx POST requests (e.g., via the `json` parameter).

        Examples:
            >>> config = RepositoryConfigBeanCreate(
            ...     id="test-repo",
            ...     title="Test Repository",
            ...     type="graphdb:FreeSailRepository",
            ...     sesameType="graphdb:FreeSailRepository",
            ...     location="",
            ... )
            >>> config_dict = config.as_dict()
            >>> isinstance(config_dict, dict)
            True
        """
        return asdict(self)


class RepositoryState(str, Enum):
    """Enumeration for repository state values."""

    INACTIVE = "INACTIVE"
    STARTING = "STARTING"
    RUNNING = "RUNNING"
    RESTARTING = "RESTARTING"
    STOPPING = "STOPPING"


@dataclass
class GraphDBRepository:
    id: t.Optional[str] = None
    title: t.Optional[str] = None
    uri: t.Optional[str] = None
    externalUrl: t.Optional[str] = None  # noqa: N815
    local: t.Optional[bool] = None
    type: t.Optional[str] = None
    sesameType: t.Optional[str] = None  # noqa: N815
    location: t.Optional[str] = None
    readable: t.Optional[bool] = None
    writable: t.Optional[bool] = None
    unsupported: t.Optional[bool] = None
    state: t.Optional[RepositoryState] = None

    @classmethod
    def from_dict(cls, data: dict) -> GraphDBRepository:
        """Create a GraphDBRepository instance from a dict.

        Parameters:
            data: A dict containing the repository data, typically
                parsed from a JSON response.

        Returns:
            A GraphDBRepository instance.

        Raises:
            TypeError: If the dict contains keys that do not match
                GraphDBRepository fields.
            ValueError: If the 'state' value is not a valid RepositoryState.
        """
        data_copy = dict(data)
        if "state" in data_copy and data_copy["state"] is not None:
            data_copy["state"] = RepositoryState(data_copy["state"])
        return cls(**data_copy)


@dataclass
class AccessControlEntry:
    scope: t.Literal["statement", "clear_graph", "plugin", "system"]
    policy: t.Literal["allow", "deny", "abstain"]
    role: str

    def as_dict(self) -> dict[str, t.Any]:
        raise NotImplementedError("Use a concrete AccessControlEntry subclass.")

    @classmethod
    def from_dict(
        cls, data: dict
    ) -> (
        SystemAccessControlEntry
        | StatementAccessControlEntry
        | PluginAccessControlEntry
        | ClearGraphAccessControlEntry
    ):
        """Create an AccessControlEntry subclass instance from raw GraphDB data.

        Note: we perform parse validation essentially twice (here and in the
        subclass's __post_init__) to ensure mypy is satisfied with the value's type.

        Parameters:
            data: A dict containing the access control entry data, typically
                parsed from a JSON response.

        Returns:
            An AccessControlEntry subclass instance (SystemAccessControlEntry,
            StatementAccessControlEntry, PluginAccessControlEntry, or
            ClearGraphAccessControlEntry) depending on the 'scope' field.

        Raises:
            TypeError: If data is not a dict.
            ValueError: If 'scope' is not a supported value ('system', 'statement',
                'plugin', 'clear_graph'), or if any field fails validation
                (e.g., invalid policy, operation, role, plugin, subject,
                predicate, object, or graph values).
        """
        if not isinstance(data, dict):
            raise TypeError("ACL entry must be a mapping.")

        scope = data.get("scope")
        if scope == "system":
            policy = _parse_policy(data.get("policy"))
            role = _parse_role(data.get("role"))
            operation = _parse_operation(data.get("operation"))
            return SystemAccessControlEntry(
                scope="system",
                policy=policy,
                role=role,
                operation=operation,
            )
        if scope == "statement":
            policy = _parse_policy(data.get("policy"))
            role = _parse_role(data.get("role"))
            operation = _parse_operation(data.get("operation"))
            subject = _parse_subject(data.get("subject"))
            predicate = _parse_predicate(data.get("predicate"))
            obj = _parse_object(data.get("object"))
            graph = _parse_graph(data.get("context"))
            return StatementAccessControlEntry(
                scope="statement",
                policy=policy,
                role=role,
                operation=operation,
                subject=subject,
                predicate=predicate,
                object=obj,
                graph=graph,
            )
        if scope == "plugin":
            policy = _parse_policy(data.get("policy"))
            role = _parse_role(data.get("role"))
            operation = _parse_operation(data.get("operation"))
            plugin = _parse_plugin(data.get("plugin"))
            return PluginAccessControlEntry(
                scope="plugin",
                policy=policy,
                role=role,
                operation=operation,
                plugin=plugin,
            )
        if scope == "clear_graph":
            policy = _parse_policy(data.get("policy"))
            role = _parse_role(data.get("role"))
            graph = _parse_graph(data.get("context"))
            return ClearGraphAccessControlEntry(
                scope="clear_graph",
                policy=policy,
                role=role,
                graph=graph,
            )

        raise ValueError(f"Unsupported FGAC scope: {scope!r}")


@dataclass
class SystemAccessControlEntry(AccessControlEntry):
    scope: t.Literal["system"]
    policy: t.Literal["allow", "deny", "abstain"]
    role: str
    operation: t.Literal["read", "write", "*"]

    def __post_init__(self) -> None:
        self.policy = _parse_policy(self.policy)
        self.role = _parse_role(self.role)
        self.operation = _parse_operation(self.operation)

    def as_dict(self) -> dict[str, t.Any]:
        return {
            "scope": self.scope,
            "policy": self.policy,
            "role": self.role,
            "operation": self.operation,
        }


@dataclass
class StatementAccessControlEntry(AccessControlEntry):
    scope: t.Literal["statement"]
    policy: t.Literal["allow", "deny", "abstain"]
    role: str
    operation: t.Literal["read", "write", "*"]
    subject: t.Literal["*"] | URIRef
    predicate: t.Literal["*"] | URIRef
    object: t.Literal["*"] | URIRef | Literal
    graph: t.Literal["*", "named", "default"] | URIRef

    def __post_init__(self) -> None:
        self.policy = _parse_policy(self.policy)
        self.role = _parse_role(self.role)
        self.operation = _parse_operation(self.operation)
        self.subject = _parse_subject(self.subject)
        self.predicate = _parse_predicate(self.predicate)
        self.object = _parse_object(self.object)
        self.graph = _parse_graph(self.graph)

    def as_dict(self) -> dict[str, t.Any]:
        return {
            "scope": self.scope,
            "policy": self.policy,
            "role": self.role,
            "operation": self.operation,
            "subject": _format_term(self.subject),
            "predicate": _format_term(self.predicate),
            "object": _format_term(self.object),
            "context": _format_term(self.graph),
        }


@dataclass
class PluginAccessControlEntry(AccessControlEntry):
    scope: t.Literal["plugin"]
    policy: t.Literal["allow", "deny", "abstain"]
    role: str
    operation: t.Literal["read", "write", "*"]
    plugin: str

    def __post_init__(self) -> None:
        self.policy = _parse_policy(self.policy)
        self.role = _parse_role(self.role)
        self.operation = _parse_operation(self.operation)
        self.plugin = _parse_plugin(self.plugin)

    def as_dict(self) -> dict[str, t.Any]:
        return {
            "scope": self.scope,
            "policy": self.policy,
            "role": self.role,
            "operation": self.operation,
            "plugin": self.plugin,
        }


@dataclass
class ClearGraphAccessControlEntry(AccessControlEntry):
    scope: t.Literal["clear_graph"]
    policy: t.Literal["allow", "deny", "abstain"]
    role: str
    graph: t.Literal["*", "named", "default"] | URIRef

    def __post_init__(self) -> None:
        self.policy = _parse_policy(self.policy)
        self.role = _parse_role(self.role)
        self.graph = _parse_graph(self.graph)

    def as_dict(self) -> dict[str, t.Any]:
        return {
            "scope": self.scope,
            "policy": self.policy,
            "role": self.role,
            "context": _format_term(self.graph),
        }


_ALLOWED_POLICIES = {"allow", "deny", "abstain"}
_ALLOWED_OPERATIONS = {"read", "write", "*"}
_ALLOWED_GRAPHS = {"*", "named", "default"}


def _parse_policy(policy: t.Any) -> t.Literal["allow", "deny", "abstain"]:
    if policy not in _ALLOWED_POLICIES:
        raise ValueError(f"Invalid FGAC policy: {policy!r}")
    return t.cast(t.Literal["allow", "deny", "abstain"], policy)


def _parse_operation(operation: t.Any) -> t.Literal["read", "write", "*"]:
    if operation not in _ALLOWED_OPERATIONS:
        raise ValueError(f"Invalid FGAC operation: {operation!r}")
    return t.cast(t.Literal["read", "write", "*"], operation)


def _parse_role(role: t.Any) -> str:
    if not isinstance(role, str):
        raise ValueError(f"Invalid FGAC role: {role!r}")
    return role


def _parse_plugin(plugin: t.Any) -> str:
    if not isinstance(plugin, str):
        raise ValueError(f"Invalid FGAC plugin: {plugin!r}")
    return plugin


def _parse_subject(subject: t.Any) -> t.Literal["*"] | URIRef:
    if subject == "*":
        return "*"
    if isinstance(subject, URIRef):
        return subject
    if isinstance(subject, str):
        parsed = _parse_with_n3(subject)
        if isinstance(parsed, URIRef):
            return parsed
    raise ValueError(f"Invalid FGAC subject: {subject!r}")


def _parse_predicate(predicate: t.Any) -> t.Literal["*"] | URIRef:
    if predicate == "*":
        return "*"
    if isinstance(predicate, URIRef):
        return predicate
    if isinstance(predicate, str):
        parsed = _parse_with_n3(predicate)
        if isinstance(parsed, URIRef):
            return parsed
    raise ValueError(f"Invalid FGAC predicate: {predicate!r}")


def _parse_object(obj: t.Any) -> t.Literal["*"] | URIRef | Literal:
    if obj == "*":
        return "*"
    if isinstance(obj, (URIRef, Literal)):
        return obj
    if isinstance(obj, str):
        parsed = _parse_with_n3(obj)
        if isinstance(parsed, (URIRef, Literal)):
            return parsed
    raise ValueError(f"Invalid FGAC object: {obj!r}")


def _parse_graph(graph: t.Any) -> t.Literal["*", "named", "default"] | URIRef:
    if graph in _ALLOWED_GRAPHS:
        return t.cast(t.Literal["*", "named", "default"], graph)
    if isinstance(graph, URIRef):
        return graph
    if isinstance(graph, str):
        parsed = _parse_with_n3(graph)
        if isinstance(parsed, URIRef):
            return parsed
    raise ValueError(f"Invalid FGAC graph: {graph!r}")


def _parse_with_n3(value: str) -> URIRef | Literal:
    try:
        parsed = from_n3(value)
    except Exception:
        parsed = None
    if isinstance(parsed, (URIRef, Literal)):
        return parsed
    try:
        return URIRef(value)
    except Exception as err:  # pragma: no cover - defensive
        raise ValueError(f"Unable to parse value {value!r} into an RDF term.") from err


def _format_term(value: t.Any) -> str:
    if isinstance(value, (URIRef, Literal)):
        return value.n3()
    return t.cast(str, value)
