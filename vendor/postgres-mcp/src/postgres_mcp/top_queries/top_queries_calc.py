import logging
from dataclasses import dataclass
from typing import Literal
from typing import LiteralString
from typing import Union
from typing import cast

from ..sql import SafeSqlDriver
from ..sql import SqlDriver
from ..sql.extension_utils import check_extension
from ..sql.extension_utils import get_postgres_version

logger = logging.getLogger(__name__)

PG_STAT_STATEMENTS = "pg_stat_statements"

install_pg_stat_statements_message = (
    "The pg_stat_statements extension is required to "
    "report slow queries, but it is not currently "
    "installed.\n\n"
    "You can install it by running: "
    "`CREATE EXTENSION pg_stat_statements;`\n\n"
    "**What does it do?** It records statistics (like "
    "execution time, number of calls, rows returned) for "
    "every query executed against the database.\n\n"
    "**Is it safe?** Installing 'pg_stat_statements' is "
    "generally safe and a standard practice for performance "
    "monitoring. It adds overhead by tracking statistics, "
    "but this is usually negligible unless under extreme load."
)


@dataclass
class PgStatStatementsColumns:
    """Column names for pg_stat_statements view, which vary by PostgreSQL version."""

    total_time: str
    mean_time: str
    stddev_time: str
    wal_bytes_select: str  # Full SELECT expression (handles missing column in PG12)
    wal_bytes_frac: str  # Full fraction expression


def _get_pg_stat_statements_columns(pg_version: int) -> PgStatStatementsColumns:
    """Get pg_stat_statements column names based on PostgreSQL version.

    PostgreSQL 13 introduced pg_stat_statements v2.0 with breaking changes:
    - Renamed timing columns: *_time → *_exec_time (total_time → total_exec_time, etc.)
    - Added wal_bytes column for write-ahead log tracking

    This function provides version-appropriate column names to ensure compatibility
    with both old (PG ≤ 12) and new (PG ≥ 13) versions.

    See: https://www.postgresql.org/docs/13/release-13.html#id-1.11.6.11.4

    Args:
        pg_version: PostgreSQL major version number

    Returns:
        PgStatStatementsColumns with version-appropriate column names
    """
    if pg_version >= 13:
        # PostgreSQL 13+ with pg_stat_statements v2.0
        return PgStatStatementsColumns(
            total_time="total_exec_time",
            mean_time="mean_exec_time",
            stddev_time="stddev_exec_time",
            wal_bytes_select="wal_bytes",
            wal_bytes_frac="wal_bytes / NULLIF(SUM(wal_bytes) OVER (), 0) AS total_wal_bytes_frac",
        )

    # PostgreSQL 12 and older with pg_stat_statements v1.x
    return PgStatStatementsColumns(
        total_time="total_time",
        mean_time="mean_time",
        stddev_time="stddev_time",
        wal_bytes_select="0 AS wal_bytes",  # Column doesn't exist in PG12
        wal_bytes_frac="0 AS total_wal_bytes_frac",
    )


class TopQueriesCalc:
    """Tool for retrieving the slowest SQL queries."""

    def __init__(self, sql_driver: Union[SqlDriver, SafeSqlDriver]):
        self.sql_driver = sql_driver

    async def get_top_queries_by_time(self, limit: int = 10, sort_by: Literal["total", "mean"] = "mean") -> str:
        """Reports the slowest SQL queries based on execution time.

        Args:
            limit: Number of slow queries to return
            sort_by: Sort criteria - 'total' for total execution time or
                'mean' for mean execution time per call (default)

        Returns:
            A string with the top queries or installation instructions
        """
        try:
            logger.debug(f"Getting top queries by time. limit={limit}, sort_by={sort_by}")
            extension_status = await check_extension(
                self.sql_driver,
                PG_STAT_STATEMENTS,
                include_messages=False,
            )

            if not extension_status.is_installed:
                logger.warning(f"Extension {PG_STAT_STATEMENTS} is not installed")
                # Return installation instructions if the extension is not installed
                return install_pg_stat_statements_message

            # Get version-appropriate column names
            pg_version = await get_postgres_version(self.sql_driver)
            logger.debug(f"PostgreSQL version: {pg_version}")
            cols = _get_pg_stat_statements_columns(pg_version)

            # Determine which column to sort by based on sort_by parameter
            order_by_column = cols.total_time if sort_by == "total" else cols.mean_time

            query = cast(
                LiteralString,
                f"""
                SELECT
                    query,
                    calls,
                    {cols.total_time},
                    {cols.mean_time},
                    rows
                FROM pg_stat_statements
                ORDER BY {order_by_column} DESC
                LIMIT {{}};
            """,
            )
            logger.debug(f"Executing query: {query}")
            slow_query_rows = await SafeSqlDriver.execute_param_query(
                self.sql_driver,
                query,
                [limit],
            )
            slow_queries = [row.cells for row in slow_query_rows] if slow_query_rows else []
            logger.info(f"Found {len(slow_queries)} slow queries")

            # Create result description based on sort criteria
            if sort_by == "total":
                criteria = "total execution time"
            else:
                criteria = "mean execution time per call"

            result = f"Top {len(slow_queries)} slowest queries by {criteria}:\n"
            result += str(slow_queries)
            return result
        except Exception as e:
            logger.error(f"Error getting slow queries: {e}", exc_info=True)
            return f"Error getting slow queries: {e}"

    async def get_top_resource_queries(self, frac_threshold: float = 0.05) -> str:
        """Reports the most time consuming queries based on a resource blend.

        Args:
            frac_threshold: Fraction threshold for filtering queries (default: 0.05)

        Returns:
            A string with the resource-heavy queries or error message
        """

        try:
            logger.debug(f"Getting top resource queries with threshold {frac_threshold}")
            extension_status = await check_extension(
                self.sql_driver,
                PG_STAT_STATEMENTS,
                include_messages=False,
            )

            if not extension_status.is_installed:
                logger.warning(f"Extension {PG_STAT_STATEMENTS} is not installed")
                # Return installation instructions if the extension is not installed
                return install_pg_stat_statements_message

            # Get version-appropriate column names
            pg_version = await get_postgres_version(self.sql_driver)
            logger.debug(f"PostgreSQL version: {pg_version}")
            cols = _get_pg_stat_statements_columns(pg_version)

            query = cast(
                LiteralString,
                f"""
                WITH resource_fractions AS (
                    SELECT
                        query,
                        calls,
                        rows,
                        {cols.total_time} AS total_exec_time,
                        {cols.mean_time} AS mean_exec_time,
                        {cols.stddev_time} AS stddev_exec_time,
                        shared_blks_hit,
                        shared_blks_read,
                        shared_blks_dirtied,
                        {cols.wal_bytes_select},
                        {cols.total_time} / NULLIF(SUM({cols.total_time}) OVER (), 0)
                            AS total_exec_time_frac,
                        (shared_blks_hit + shared_blks_read)
                            / NULLIF(SUM(shared_blks_hit + shared_blks_read) OVER (), 0)
                            AS shared_blks_accessed_frac,
                        shared_blks_read / NULLIF(SUM(shared_blks_read) OVER (), 0)
                            AS shared_blks_read_frac,
                        shared_blks_dirtied / NULLIF(SUM(shared_blks_dirtied) OVER (), 0)
                            AS shared_blks_dirtied_frac,
                        {cols.wal_bytes_frac}
                    FROM pg_stat_statements
                )
                SELECT
                    query,
                    calls,
                    rows,
                    total_exec_time,
                    mean_exec_time,
                    stddev_exec_time,
                    total_exec_time_frac,
                    shared_blks_accessed_frac,
                    shared_blks_read_frac,
                    shared_blks_dirtied_frac,
                    total_wal_bytes_frac,
                    shared_blks_hit,
                    shared_blks_read,
                    shared_blks_dirtied,
                    wal_bytes
                FROM resource_fractions
                WHERE
                    total_exec_time_frac > {frac_threshold}
                    OR shared_blks_accessed_frac > {frac_threshold}
                    OR shared_blks_read_frac > {frac_threshold}
                    OR shared_blks_dirtied_frac > {frac_threshold}
                    OR total_wal_bytes_frac > {frac_threshold}
                ORDER BY total_exec_time DESC
            """,
            )

            logger.debug(f"Executing query: {query}")
            slow_query_rows = await SafeSqlDriver.execute_param_query(
                self.sql_driver,
                query,
            )
            resource_queries = [row.cells for row in slow_query_rows] if slow_query_rows else []
            logger.info(f"Found {len(resource_queries)} resource-intensive queries")

            return str(resource_queries)
        except Exception as e:
            logger.error(f"Error getting resource-intensive queries: {e}", exc_info=True)
            return f"Error resource-intensive queries: {e}"
