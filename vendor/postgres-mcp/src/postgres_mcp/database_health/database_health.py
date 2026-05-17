from __future__ import annotations

import logging
from enum import Enum
from typing import List

import mcp.types as types

from .buffer_health_calc import BufferHealthCalc
from .connection_health_calc import ConnectionHealthCalc
from .constraint_health_calc import ConstraintHealthCalc
from .index_health_calc import IndexHealthCalc
from .replication_calc import ReplicationCalc
from .sequence_health_calc import SequenceHealthCalc
from .vacuum_health_calc import VacuumHealthCalc

ResponseType = List[types.TextContent | types.ImageContent | types.EmbeddedResource]

logger = logging.getLogger(__name__)


class HealthType(str, Enum):
    INDEX = "index"
    CONNECTION = "connection"
    VACUUM = "vacuum"
    SEQUENCE = "sequence"
    REPLICATION = "replication"
    BUFFER = "buffer"
    CONSTRAINT = "constraint"
    ALL = "all"


class DatabaseHealthTool:
    """Tool for analyzing database health metrics."""

    def __init__(self, sql_driver):
        self.sql_driver = sql_driver

    async def health(self, health_type: str) -> str:
        """Run database health checks for the specified components.

        Args:
            health_type: Comma-separated list of health check types to perform
                         Valid values: index, connection, vacuum, sequence, replication, buffer, constraint, all

        Returns:
            A string with the health check results
        """
        try:
            result = ""
            try:
                health_types = {HealthType(x.strip()) for x in health_type.split(",")}
            except ValueError:
                return (
                    f"Invalid health types provided: '{health_type}'. "
                    + f"Valid values are: {', '.join(sorted([t.value for t in HealthType]))}. "
                    + "Please try again with a comma-separated list of valid health types."
                )

            if HealthType.ALL in health_types:
                health_types = [t.value for t in HealthType if t != HealthType.ALL]

            if HealthType.INDEX in health_types:
                index_health = IndexHealthCalc(self.sql_driver)
                result += "Invalid index check: " + await index_health.invalid_index_check() + "\n"
                result += "Duplicate index check: " + await index_health.duplicate_index_check() + "\n"
                result += "Index bloat: " + await index_health.index_bloat() + "\n"
                result += "Unused index check: " + await index_health.unused_indexes() + "\n"

            if HealthType.CONNECTION in health_types:
                connection_health = ConnectionHealthCalc(self.sql_driver)
                result += "Connection health: " + await connection_health.connection_health_check() + "\n"

            if HealthType.VACUUM in health_types:
                vacuum_health = VacuumHealthCalc(self.sql_driver)
                result += "Vacuum health: " + await vacuum_health.transaction_id_danger_check() + "\n"

            if HealthType.SEQUENCE in health_types:
                sequence_health = SequenceHealthCalc(self.sql_driver)
                result += "Sequence health: " + await sequence_health.sequence_danger_check() + "\n"

            if HealthType.REPLICATION in health_types:
                replication_health = ReplicationCalc(self.sql_driver)
                result += "Replication health: " + await replication_health.replication_health_check() + "\n"

            if HealthType.BUFFER in health_types:
                buffer_health = BufferHealthCalc(self.sql_driver)
                result += "Buffer health for indexes: " + await buffer_health.index_hit_rate() + "\n"
                result += "Buffer health for tables: " + await buffer_health.table_hit_rate() + "\n"

            if HealthType.CONSTRAINT in health_types:
                constraint_health = ConstraintHealthCalc(self.sql_driver)
                result += "Constraint health: " + await constraint_health.invalid_constraints_check() + "\n"

            return result if result else "No health checks were performed."
        except Exception as e:
            logger.error(f"Error calculating database health: {e}", exc_info=True)
            return f"Error calculating database health: {e}"
