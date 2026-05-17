import re
from dataclasses import dataclass

from psycopg.sql import Identifier

from ..sql import SafeSqlDriver
from ..sql import SqlDriver


@dataclass
class SequenceMetrics:
    schema: str
    table: str
    column: str
    sequence: str
    column_type: str
    last_value: int
    max_value: int
    is_healthy: bool
    readable: bool = True

    @property
    def percent_used(self) -> float:
        """Calculate what percentage of the sequence has been used."""
        return (self.last_value / self.max_value) * 100 if self.max_value else 0


class SequenceHealthCalc:
    def __init__(self, sql_driver: SqlDriver, threshold: float = 0.9):
        """Initialize sequence health calculator.

        Args:
            sql_driver: SQL driver for database access
            threshold: Percentage (as decimal) of sequence usage that triggers warning
        """
        self.sql_driver = sql_driver
        self.threshold = threshold

    async def sequence_danger_check(self) -> str:
        """Check if any sequences are approaching their maximum values."""
        metrics = await self._get_sequence_metrics()

        if not metrics:
            return "No sequences found in the database."

        # Sort by remaining values ascending to show most critical first
        metrics.sort(key=lambda x: x.max_value - x.last_value)

        unhealthy = [m for m in metrics if not m.is_healthy]
        if not unhealthy:
            return "All sequences have healthy usage levels."

        result = ["Sequences approaching maximum value:"]
        for metric in unhealthy:
            remaining = metric.max_value - metric.last_value
            result.append(
                f"Sequence '{metric.schema}.{metric.sequence}' used for {metric.table}.{metric.column} "
                f"has used {metric.percent_used:.1f}% of available values "
                f"({metric.last_value:,} of {metric.max_value:,}, {remaining:,} remaining)"
            )
        return "\n".join(result)

    async def _get_sequence_metrics(self) -> list[SequenceMetrics]:
        """Get metrics for sequences in the database."""
        # First get all sequences used as default values
        sequences = await self.sql_driver.execute_query("""
            SELECT
                n.nspname AS table_schema,
                c.relname AS table,
                attname AS column,
                format_type(a.atttypid, a.atttypmod) AS column_type,
                pg_get_expr(d.adbin, d.adrelid) AS default_value
            FROM
                pg_catalog.pg_attribute a
            INNER JOIN
                pg_catalog.pg_class c ON c.oid = a.attrelid
            INNER JOIN
                pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            INNER JOIN
                pg_catalog.pg_attrdef d ON (a.attrelid, a.attnum) = (d.adrelid, d.adnum)
            WHERE
                NOT a.attisdropped
                AND a.attnum > 0
                AND pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval%'
                AND n.nspname NOT LIKE 'pg\\_temp\\_%'
        """)

        if not sequences:
            return []

        result_list = [dict(x.cells) for x in sequences]

        # Process each sequence
        sequence_metrics = []
        for seq in result_list:
            # Parse the sequence name from default value
            schema, sequence = self._parse_sequence_name(seq["default_value"])
            if not sequence:
                continue

            # Determine max value based on column type
            max_value = 2147483647 if seq["column_type"] == "integer" else 9223372036854775807

            # Get sequence attributes
            attrs = await SafeSqlDriver.execute_param_query(
                self.sql_driver,
                """
                SELECT
                    has_sequence_privilege('{}', 'SELECT') AS readable,
                    last_value
                FROM {}
                """,
                [Identifier(schema, sequence), Identifier(schema, sequence)],
            )

            if not attrs:
                continue

            result_list = [dict(x.cells) for x in attrs]

            attr = result_list[0]
            sequence_metrics.append(
                SequenceMetrics(
                    schema=schema,
                    table=seq["table"],
                    column=seq["column"],
                    sequence=sequence,
                    column_type=seq["column_type"],
                    last_value=attr["last_value"],
                    max_value=max_value,
                    readable=attr["readable"],
                    is_healthy=attr["last_value"] / max_value <= self.threshold,
                )
            )

        return sequence_metrics

    def _parse_sequence_name(self, default_value: str) -> tuple[str, str]:
        """Parse schema and sequence name from default value expression.

        Handles formats like:
        - nextval('id_seq'::regclass)
        - nextval(('id_seq'::text)::regclass)
        - nextval('"UpperCaseSeq"'::regclass)
        - nextval('"Schema"."Seq"'::regclass)

        Note: Sequence names containing literal dots (e.g., "my.seq") are not
        supported and will be incorrectly parsed as schema.name.
        """
        # Extract the sequence reference from inside the single quotes
        # Handles both nextval('...') and nextval(('...'::text)::regclass)
        match = re.search(r"nextval\(\(?'([^']+)'", default_value)
        if not match:
            return "public", ""

        clean_value = match.group(1)
        # Remove quotes so sql.Identifier can add them correctly
        clean_value = clean_value.replace('"', "")

        # Split into schema and sequence
        parts = clean_value.split(".")
        if len(parts) == 1:
            return "public", parts[0]  # Default to public schema
        return parts[0], parts[1]
