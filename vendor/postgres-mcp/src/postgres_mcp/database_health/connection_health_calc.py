from dataclasses import dataclass

from ..sql import SqlDriver


@dataclass
class ConnectionHealthMetrics:
    total_connections: int
    idle_connections: int
    max_total_connections: int
    max_idle_connections: int
    is_total_connections_healthy: bool
    is_idle_connections_healthy: bool

    @property
    def is_healthy(self) -> bool:
        return self.is_total_connections_healthy and self.is_idle_connections_healthy


class ConnectionHealthCalc:
    def __init__(
        self,
        sql_driver: SqlDriver,
        max_total_connections: int = 500,
        max_idle_connections: int = 100,
    ):
        self.sql_driver = sql_driver
        self.max_total_connections = max_total_connections
        self.max_idle_connections = max_idle_connections

    async def total_connections_check(self) -> str:
        """Check if total number of connections is within healthy limits."""
        total = await self._get_total_connections()

        if total <= self.max_total_connections:
            return f"Total connections healthy: {total}"
        return f"High number of connections: {total} (max: {self.max_total_connections})"

    async def idle_connections_check(self) -> str:
        """Check if number of idle connections is within healthy limits."""
        idle = await self._get_idle_connections()

        if idle <= self.max_idle_connections:
            return f"Idle connections healthy: {idle}"
        return f"High number of idle connections: {idle} (max: {self.max_idle_connections})"

    async def connection_health_check(self) -> str:
        """Run all connection health checks and return combined results."""
        total = await self._get_total_connections()
        idle = await self._get_idle_connections()

        if total > self.max_total_connections:
            return f"High number of connections: {total}"
        elif idle > self.max_idle_connections:
            return f"High number of connections idle in transaction: {idle}"
        else:
            return f"Connections healthy: {total} total, {idle} idle"

    async def _get_total_connections(self) -> int:
        """Get the total number of database connections."""
        result = await self.sql_driver.execute_query("""
            SELECT COUNT(*) as count
            FROM pg_stat_activity
        """)
        result_list = [dict(x.cells) for x in result] if result else []
        return result_list[0]["count"] if result_list else 0

    async def _get_idle_connections(self) -> int:
        """Get the number of connections that are idle in transaction."""
        result = await self.sql_driver.execute_query("""
            SELECT COUNT(*) as count
            FROM pg_stat_activity
            WHERE state = 'idle in transaction'
        """)
        result_list = [dict(x.cells) for x in result] if result else []
        return result_list[0]["count"] if result_list else 0
