from dataclasses import dataclass

from ..sql import SqlDriver


@dataclass
class ConstraintMetrics:
    schema: str
    table: str
    name: str
    referenced_schema: str | None
    referenced_table: str | None


class ConstraintHealthCalc:
    def __init__(self, sql_driver: SqlDriver):
        self.sql_driver = sql_driver

    async def invalid_constraints_check(self) -> str:
        """Check for any invalid constraints in the database.

        Returns:
            String describing any invalid constraints found
        """
        metrics = await self._get_invalid_constraints()

        if not metrics:
            return "No invalid constraints found."

        result = ["Invalid constraints found:"]
        for metric in metrics:
            if metric.referenced_table:
                result.append(
                    f"Constraint '{metric.name}' on table '{metric.schema}.{metric.table}' "
                    f"referencing '{metric.referenced_schema}.{metric.referenced_table}' is invalid"
                )
            else:
                result.append(f"Constraint '{metric.name}' on table '{metric.schema}.{metric.table}' is invalid")
        return "\n".join(result)

    async def _get_invalid_constraints(self) -> list[ConstraintMetrics]:
        """Get all invalid constraints in the database."""
        results = await self.sql_driver.execute_query("""
            SELECT
                nsp.nspname AS schema,
                rel.relname AS table,
                con.conname AS name,
                fnsp.nspname AS referenced_schema,
                frel.relname AS referenced_table
            FROM
                pg_catalog.pg_constraint con
            INNER JOIN
                pg_catalog.pg_class rel ON rel.oid = con.conrelid
            LEFT JOIN
                pg_catalog.pg_class frel ON frel.oid = con.confrelid
            LEFT JOIN
                pg_catalog.pg_namespace nsp ON nsp.oid = con.connamespace
            LEFT JOIN
                pg_catalog.pg_namespace fnsp ON fnsp.oid = frel.relnamespace
            WHERE
                con.convalidated = 'f'
        """)

        if not results:
            return []

        result_list = [dict(x.cells) for x in results]

        return [
            ConstraintMetrics(
                schema=row["schema"],
                table=row["table"],
                name=row["name"],
                referenced_schema=row["referenced_schema"],
                referenced_table=row["referenced_table"],
            )
            for row in result_list
        ]

    async def _get_total_constraints(self) -> int:
        """Get the total number of constraints."""
        result = await self.sql_driver.execute_query("""
            SELECT COUNT(*) as count
            FROM information_schema.table_constraints
        """)
        if not result:
            return 0
        result_list = [dict(x.cells) for x in result]
        return result_list[0]["count"] if result_list else 0

    async def _get_active_constraints(self) -> int:
        """Get the number of active constraints."""
        result = await self.sql_driver.execute_query("""
            SELECT COUNT(*) as count
            FROM information_schema.table_constraints
            WHERE is_deferrable = 'NO'
        """)
        if not result:
            return 0
        result_list = [dict(x.cells) for x in result]
        return result_list[0]["count"] if result_list else 0
