from typing import Any

from ..sql import SafeSqlDriver
from ..sql import SqlDriver


class IndexHealthCalc:
    _cached_indexes: list[dict[str, Any]] | None = None

    def __init__(self, sql_driver: SqlDriver):
        self.sql_driver = sql_driver

    async def invalid_index_check(self) -> str:
        indexes = await self._indexes()
        # Check for invalid indexes being created
        invalid_indexes = [idx for idx in indexes if not idx["valid"]]
        if not invalid_indexes:
            return "No invalid indexes found."

        return "Invalid indexes found: " + "\n".join([f"{idx['name']} on {idx['table']} is invalid." for idx in invalid_indexes])

    async def duplicate_index_check(self) -> str:
        indexes = await self._indexes()
        dup_indexes = []

        # Group indexes by schema and table
        indexes_by_table = {}
        for idx in indexes:
            key = (idx["schema"], idx["table"])
            if key not in indexes_by_table:
                indexes_by_table[key] = []
            indexes_by_table[key].append(idx)

        # Check each valid non-primary/unique index for duplicates
        for index in [i for i in indexes if i["valid"] and not i["primary"] and not i["unique"]]:
            table_indexes = indexes_by_table[(index["schema"], index["table"])]

            # Find covering indexes
            for covering_idx in table_indexes:
                if (
                    covering_idx["valid"]
                    and covering_idx["name"] != index["name"]
                    and self._index_covers(covering_idx["columns"], index["columns"])
                    and covering_idx["using"] == index["using"]
                    and covering_idx["indexprs"] == index["indexprs"]
                    and covering_idx["indpred"] == index["indpred"]
                ):
                    # Add to duplicates if conditions are met
                    if (
                        covering_idx["columns"] != index["columns"]
                        or index["name"] > covering_idx["name"]
                        or covering_idx["primary"]
                        or covering_idx["unique"]
                    ):
                        dup_indexes.append({"unneeded_index": index, "covering_index": covering_idx})
                        break

        if not dup_indexes:
            return "No duplicate indexes found."

        # Sort by table and columns and format the output
        sorted_dups = sorted(
            dup_indexes,
            key=lambda x: (
                x["unneeded_index"]["table"],
                x["unneeded_index"]["columns"],
            ),
        )

        result = ["Duplicate indexes found:"]
        for dup in sorted_dups:
            result.append(
                f"Index '{dup['unneeded_index']['name']}' on table '{dup['unneeded_index']['table']}' "
                f"is covered by index '{dup['covering_index']['name']}'"
            )

        return "\n".join(result)

    async def index_bloat(self, min_size: int = 104857600) -> str:
        """Check for bloated indexes that are larger than min_size bytes.

        Args:
            min_size: Minimum size in bytes to consider an index as bloated (default 100MB)

        Returns:
            String describing any bloated indexes found
        """
        bloated_indexes = await SafeSqlDriver.execute_param_query(
            self.sql_driver,
            """
            WITH btree_index_atts AS (
                SELECT
                    nspname, relname, reltuples, relpages, indrelid, relam,
                    regexp_split_to_table(indkey::text, ' ')::smallint AS attnum,
                    indexrelid as index_oid
                FROM
                    pg_index
                JOIN
                    pg_class ON pg_class.oid = pg_index.indexrelid
                JOIN
                    pg_namespace ON pg_namespace.oid = pg_class.relnamespace
                JOIN
                    pg_am ON pg_class.relam = pg_am.oid
                WHERE
                    pg_am.amname = 'btree'
            ),
            index_item_sizes AS (
                SELECT
                    i.nspname,
                    i.relname,
                    i.reltuples,
                    i.relpages,
                    i.relam,
                    (quote_ident(s.schemaname) || '.' || quote_ident(s.tablename))::regclass AS starelid,
                    a.attrelid AS table_oid, index_oid,
                    current_setting('block_size')::numeric AS bs,
                    CASE
                        WHEN version() ~ 'mingw32' OR version() ~ '64-bit' THEN 8
                        ELSE 4
                    END AS maxalign,
                    24 AS pagehdr,
                    CASE WHEN max(coalesce(s.null_frac,0)) = 0
                        THEN 2
                        ELSE 6
                    END AS index_tuple_hdr,
                    sum( (1-coalesce(s.null_frac, 0)) * coalesce(s.avg_width, 2048) ) AS nulldatawidth
                FROM
                    pg_attribute AS a
                JOIN
                    pg_stats AS s ON (quote_ident(s.schemaname) || '.' || quote_ident(s.tablename))::regclass=a.attrelid AND s.attname = a.attname
                JOIN
                    btree_index_atts AS i ON i.indrelid = a.attrelid AND a.attnum = i.attnum
                WHERE
                    a.attnum > 0
                GROUP BY
                    1, 2, 3, 4, 5, 6, 7, 8, 9
            ),
            index_aligned AS (
                SELECT
                    maxalign,
                    bs,
                    nspname,
                    relname AS index_name,
                    reltuples,
                    relpages,
                    relam,
                    table_oid,
                    index_oid,
                    ( 2 +
                        maxalign - CASE
                            WHEN index_tuple_hdr%maxalign = 0 THEN maxalign
                            ELSE index_tuple_hdr%maxalign
                        END
                    + nulldatawidth + maxalign - CASE
                            WHEN nulldatawidth::integer%maxalign = 0 THEN maxalign
                            ELSE nulldatawidth::integer%maxalign
                        END
                    )::numeric AS nulldatahdrwidth, pagehdr
                FROM
                    index_item_sizes AS s1
            ),
            otta_calc AS (
                SELECT
                    bs,
                    nspname,
                    table_oid,
                    index_oid,
                    index_name,
                    relpages,
                    coalesce(
                        ceil((reltuples*(4+nulldatahdrwidth))/(bs-pagehdr::float)) +
                        CASE WHEN am.amname IN ('hash','btree') THEN 1 ELSE 0 END , 0
                    ) AS otta
                FROM
                    index_aligned AS s2
                LEFT JOIN
                    pg_am am ON s2.relam = am.oid
            ),
            raw_bloat AS (
                SELECT
                    nspname,
                    c.relname AS table_name,
                    index_name,
                    bs*(sub.relpages)::bigint AS totalbytes,
                    CASE
                        WHEN sub.relpages <= otta THEN 0
                        ELSE bs*(sub.relpages-otta)::bigint END
                        AS wastedbytes,
                    CASE
                        WHEN sub.relpages <= otta
                        THEN 0 ELSE bs*(sub.relpages-otta)::bigint * 100 / (bs*(sub.relpages)::bigint) END
                        AS realbloat,
                    pg_relation_size(sub.table_oid) as table_bytes,
                    stat.idx_scan as index_scans,
                    stat.indexrelid
                FROM
                    otta_calc AS sub
                JOIN
                    pg_class AS c ON c.oid=sub.table_oid
                JOIN
                    pg_stat_user_indexes AS stat ON sub.index_oid = stat.indexrelid
            )
            SELECT
                nspname AS schema,
                table_name AS table,
                index_name AS index,
                wastedbytes AS bloat_bytes,
                totalbytes AS index_bytes,
                pg_get_indexdef(rb.indexrelid) AS definition,
                indisprimary AS primary
            FROM
                raw_bloat rb
            INNER JOIN
                pg_index i ON i.indexrelid = rb.indexrelid
            WHERE
                wastedbytes >= {}
            ORDER BY
                wastedbytes DESC,
                index_name
        """,
            [min_size],
        )

        if not bloated_indexes:
            return "No bloated indexes found."

        result = ["Bloated indexes found:"]
        # Convert RowResults to dicts first
        bloated_indexes_dicts = [dict(idx.cells) for idx in bloated_indexes]
        for idx in bloated_indexes_dicts:
            bloat_mb = int(idx["bloat_bytes"]) / (1024 * 1024)
            total_mb = int(idx["index_bytes"]) / (1024 * 1024)
            result.append(f"Index '{idx['index']}' on table '{idx['table']}' has {bloat_mb:.1f}MB bloat out of {total_mb:.1f}MB total size")

        return "\n".join(result)

    async def _indexes(self) -> list[dict[str, Any]]:
        if self._cached_indexes:
            return self._cached_indexes

        # Get index information
        results = await self.sql_driver.execute_query("""
            SELECT
                schemaname AS schema,
                t.relname AS table,
                ix.relname AS name,
                regexp_replace(pg_get_indexdef(i.indexrelid), '^[^\\(]*\\((.*)\\)$', '\\1') AS columns,
                regexp_replace(pg_get_indexdef(i.indexrelid), '.* USING ([^ ]*) \\(.*', '\\1') AS using,
                indisunique AS unique,
                indisprimary AS primary,
                indisvalid AS valid,
                indexprs::text,
                indpred::text,
                pg_get_indexdef(i.indexrelid) AS definition
            FROM
                pg_index i
            INNER JOIN
                pg_class t ON t.oid = i.indrelid
            INNER JOIN
                pg_class ix ON ix.oid = i.indexrelid
            LEFT JOIN
                pg_stat_user_indexes ui ON ui.indexrelid = i.indexrelid
            WHERE
                schemaname IS NOT NULL
            ORDER BY
                1, 2
        """)

        if results is None:
            return []

        # Convert RowResults to dicts
        indexes = [dict(idx.cells) for idx in results]

        # Process columns
        for idx in indexes:
            cols = idx["columns"]
            cols = cols.replace(") WHERE (", " WHERE ").split(", ")
            # Unquote column names
            idx["columns"] = [col.strip('"') for col in cols]

        self._cached_indexes = indexes
        return indexes

    def _index_covers(self, indexed_columns: list[str], columns: list[str]) -> bool:
        """Check if indexed_columns cover the columns by comparing their prefixes.

        Args:
            indexed_columns: The columns of the potentially covering index
            columns: The columns being checked for coverage

        Returns:
            True if indexed_columns cover columns, False otherwise
        """
        return indexed_columns[: len(columns)] == columns

    async def unused_indexes(self, max_scans: int = 50) -> str:
        """Check for unused or rarely used indexes.

        Args:
            max_scans: Maximum number of scans to consider an index as unused (default 50)

        Returns:
            String describing any unused indexes found
        """
        unused = await SafeSqlDriver.execute_param_query(
            self.sql_driver,
            """
            SELECT
                schemaname AS schema,
                relname AS table,
                indexrelname AS index,
                pg_relation_size(i.indexrelid) AS size_bytes,
                idx_scan as index_scans,
                pg_get_indexdef(i.indexrelid) AS definition,
                indisprimary AS primary
            FROM
                pg_stat_user_indexes ui
            INNER JOIN
                pg_index i ON ui.indexrelid = i.indexrelid
            WHERE
                NOT indisunique
                AND idx_scan <= {}
            ORDER BY
                pg_relation_size(i.indexrelid) DESC,
                relname ASC
        """,
            [max_scans],
        )

        if not unused:
            return "No unused indexes found."

        indexes = [dict(idx.cells) for idx in unused]

        result = ["Rarely used indexes found:"]
        for idx in indexes:
            if idx["primary"]:
                continue
            size_mb = int(idx["size_bytes"]) / (1024 * 1024)
            result.append(
                f"Index '{idx['index']}' on table '{idx['table']}' has only been scanned {idx['index_scans']} times and uses {size_mb:.1f}MB of space"
            )

        return "\n".join(result)
