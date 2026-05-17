from typing import Any

from ..sql import SqlDriver


class BufferHealthCalc:
    _cached_indexes: list[dict[str, Any]] | None = None

    def __init__(self, sql_driver: SqlDriver):
        self.sql_driver = sql_driver

    async def index_hit_rate(self, threshold: float = 0.95) -> str:
        """Calculate the index cache hit rate.

        Returns:
            String describing the index cache hit rate as a percentage and comparison to threshold
        """
        result = await self.sql_driver.execute_query("""
            SELECT
                (sum(idx_blks_hit)) / nullif(sum(idx_blks_hit + idx_blks_read), 0) AS rate
            FROM
                pg_statio_user_indexes
        """)

        result_list = [dict(x.cells) for x in result] if result else []

        if not result_list or result_list[0]["rate"] is None:
            return "No index cache statistics available."

        hit_rate = float(result_list[0]["rate"]) * 100
        threshold_pct = threshold * 100

        if hit_rate >= threshold_pct:
            return f"Index cache hit rate: {hit_rate:.1f}% (above {threshold_pct:.1f}% threshold)"
        else:
            return f"Index cache hit rate: {hit_rate:.1f}% (below {threshold_pct:.1f}% threshold)"

    async def table_hit_rate(self, threshold: float = 0.95) -> str:
        """Calculate the table cache hit rate.

        Returns:
            String describing the table cache hit rate as a percentage and comparison to threshold
        """
        result = await self.sql_driver.execute_query("""
            SELECT
                sum(heap_blks_hit) / nullif(sum(heap_blks_hit + heap_blks_read), 0) AS rate
            FROM
                pg_statio_user_tables
        """)

        result_list = [dict(x.cells) for x in result] if result else []

        if not result_list or result_list[0]["rate"] is None:
            return "No table cache statistics available."

        hit_rate = float(result_list[0]["rate"]) * 100
        threshold_pct = threshold * 100

        if hit_rate >= threshold_pct:
            return f"Table cache hit rate: {hit_rate:.1f}% (above {threshold_pct:.1f}% threshold)"
        else:
            return f"Table cache hit rate: {hit_rate:.1f}% (below {threshold_pct:.1f}% threshold)"
