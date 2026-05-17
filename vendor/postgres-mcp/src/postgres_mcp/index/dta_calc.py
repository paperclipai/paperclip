import logging
import time
from itertools import combinations
from typing import Any
from typing import override

import humanize
from pglast.ast import ColumnRef
from pglast.ast import JoinExpr
from pglast.ast import Node
from pglast.ast import SelectStmt

from ..sql import ColumnCollector
from ..sql import SafeSqlDriver
from ..sql import SqlDriver
from ..sql import TableAliasVisitor
from .index_opt_base import IndexRecommendation
from .index_opt_base import IndexTuningBase
from .index_opt_base import candidate_str
from .index_opt_base import pp_list

logger = logging.getLogger(__name__)

# --- Data Classes ---

logger = logging.getLogger(__name__)


class DatabaseTuningAdvisor(IndexTuningBase):
    def __init__(
        self,
        sql_driver: SqlDriver,
        budget_mb: int = -1,  # no limit by default
        max_runtime_seconds: int = 30,  # 30 seconds
        max_index_width: int = 3,
        min_column_usage: int = 1,  # skip columns used in fewer than this many queries
        seed_columns_count: int = 3,  # how many single-col seeds to pick
        pareto_alpha: float = 2.0,
        min_time_improvement: float = 0.1,
    ):
        """
        :param sql_driver: Database access
        :param budget_mb: Storage budget
        :param max_runtime_seconds: Time limit for entire analysis (anytime approach)
        :param max_index_width: Maximum columns in an index
        :param min_column_usage: skip columns that appear in fewer than X queries
        :param seed_columns_count: how many top single-column indexes to pick as seeds
        :param pareto_alpha: stop when relative improvement falls below this threshold
        :param min_time_improvement: stop when relative improvement falls below this threshold
        """
        super().__init__(sql_driver)
        self.budget_mb = budget_mb
        self.max_runtime_seconds = max_runtime_seconds
        self.max_index_width = max_index_width
        self.min_column_usage = min_column_usage
        self.seed_columns_count = seed_columns_count
        self._analysis_start_time = 0.0
        self.pareto_alpha = pareto_alpha
        self.min_time_improvement = min_time_improvement

    def _check_time(self) -> bool:
        """Return True if we have exceeded max_runtime_seconds."""
        if self.max_runtime_seconds <= 0:
            return False
        elapsed = time.time() - self._analysis_start_time
        return elapsed > self.max_runtime_seconds

    @override
    async def _generate_recommendations(self, query_weights: list[tuple[str, SelectStmt, float]]) -> tuple[set[IndexRecommendation], float]:
        """Generate index recommendations using a hybrid 'seed + greedy' approach with a time cutoff."""

        # Get existing indexes
        existing_index_defs: set[str] = {idx["definition"] for idx in await self._get_existing_indexes()}

        logger.debug(f"Existing indexes ({len(existing_index_defs)}): {pp_list(list(existing_index_defs))}")

        # generate initial candidates
        all_candidates = await self.generate_candidates(query_weights, existing_index_defs)

        self.dta_trace(f"All candidates ({len(all_candidates)}): {candidate_str(all_candidates)}")

        # TODO: Remove this once we have a better way to generate seeds
        # # produce seeds if desired
        # seeds = set()
        # if self.seed_columns_count > 0 and not self._check_time():
        #     seeds = self._quick_pass_seeds(query_weights, all_candidates)

        # unify seeds with an empty set
        #   we treat seeds as "starting points"
        #   in the real DTA approach, they'd enumerate many seeds,
        #   but let's just do: [seeds, empty]
        # Because we do a small scale approach, we only do these 2 seeds
        seeds_list = [
            # seeds,
            set(),
        ]

        best_config: tuple[set[IndexRecommendation], float] = (set(), float("inf"))

        # Evaluate each seed
        for seed in seeds_list:
            if self._check_time():
                break

            self.dta_trace("Evaluating seed:")
            current_cost = await self._evaluate_configuration_cost(query_weights, frozenset(seed))
            candidate_indexes = set(
                {
                    IndexRecommendation(
                        c.table,
                        tuple(c.columns),
                        c.using,
                    )
                    for c in all_candidates
                }
            )
            final_indexes, final_cost = await self._enumerate_greedy(query_weights, seed.copy(), current_cost, candidate_indexes - seed)

            if final_cost < best_config[1]:
                best_config = (final_indexes, final_cost)

        # Sort recs by benefit desc
        return best_config

    async def generate_candidates(self, workload: list[tuple[str, SelectStmt, float]], existing_defs: set[str]) -> list[IndexRecommendation]:
        """Generates index candidates from queries, with batch creation."""
        table_columns_usage = {}  # table -> {col -> usage_count}
        # Extract columns from all queries
        for _q, stmt, _ in workload:
            columns_per_table = self._sql_bind_params.extract_stmt_columns(stmt)
            for tbl, cols in columns_per_table.items():
                if tbl not in table_columns_usage:
                    table_columns_usage[tbl] = {}
                for c in cols:
                    table_columns_usage[tbl][c] = table_columns_usage[tbl].get(c, 0) + 1

        # Filter out rarely used columns
        # e.g. skip columns that appear in fewer than self.min_column_usage queries
        table_columns: dict[str, set[str]] = {}
        for tbl, usage_map in table_columns_usage.items():
            kept_cols = {c for c, usage in usage_map.items() if usage >= self.min_column_usage}
            if kept_cols:
                table_columns[tbl] = kept_cols

        candidates = []
        for table, cols in table_columns.items():
            # TODO: Optimize by prioritizing columns from filters/joins; current approach generates all combinations
            col_list = list(cols)
            for width in range(1, min(self.max_index_width, len(cols)) + 1):
                for combo in combinations(col_list, width):
                    candidates.append(IndexRecommendation(table=table, columns=tuple(combo)))

        # filter out duplicates with existing indexes
        filtered_candidates = [c for c in candidates if not self._index_exists(c, existing_defs)]

        # filter out candidates with columns not used in query conditions
        condition_filtered1 = self._filter_candidates_by_query_conditions(workload, filtered_candidates)

        # filter out long text columns
        condition_filtered = await self._filter_long_text_columns(condition_filtered1)

        self.dta_trace(f"Generated {len(candidates)} total candidates")
        self.dta_trace(f"Filtered to {len(filtered_candidates)} after removing existing indexes.")
        self.dta_trace(f"Filtered to {len(condition_filtered1)} after removing unused columns.")
        self.dta_trace(f"Filtered to {len(condition_filtered)} after removing long text columns.")
        # Batch create all hypothetical indexes and store their size estimates
        if len(condition_filtered) > 0:
            query = "SELECT hypopg_create_index({});" * len(condition_filtered)
            await SafeSqlDriver.execute_param_query(
                self.sql_driver,
                query,
                [idx.definition for idx in condition_filtered],
            )

            # Get estimated sizes without resetting indexes yet
            result = await self.sql_driver.execute_query(
                "SELECT index_name, hypopg_relation_size(indexrelid) as index_size FROM hypopg_list_indexes;"
            )
            if result is not None:
                index_map = {r.cells["index_name"]: r.cells["index_size"] for r in result}
                for idx in condition_filtered:
                    if idx.name in index_map:
                        idx.estimated_size_bytes = index_map[idx.name]

            await self.sql_driver.execute_query("SELECT hypopg_reset();")
        return condition_filtered

    async def _enumerate_greedy(
        self,
        queries: list[tuple[str, SelectStmt, float]],
        current_indexes: set[IndexRecommendation],
        current_cost: float,
        candidate_indexes: set[IndexRecommendation],
    ) -> tuple[set[IndexRecommendation], float]:
        """
        Pareto optimal greedy approach using cost/benefit analysis:
        - Cost: Size of base relation plus size of indexes (in bytes)
        - Benefit: Inverse of query execution time (1/time)
        - Objective function: log(time) + alpha * log(space)
        - We want to minimize this function, with alpha=2 for 2x emphasis on performance
        - Primary stopping criterion: minimum relative time improvement threshold
        """
        import math

        # Parameters
        alpha = self.pareto_alpha
        min_time_improvement = self.min_time_improvement  # 5% default

        self.dta_trace("\n[GREEDY SEARCH] Starting enumeration")
        self.dta_trace(f"  - Parameters: alpha={alpha}, min_time_improvement={min_time_improvement}")
        self.dta_trace(f"  - Initial indexes: {len(current_indexes)}, Candidates: {len(candidate_indexes)}")

        # Get the tables involved in this analysis
        tables = set()
        for idx in candidate_indexes:
            tables.add(idx.table)

        # Estimate base relation size for each table
        base_relation_size = sum([await self._get_table_size(table) for table in tables])

        self.dta_trace(f"  - Base relation size: {humanize.naturalsize(base_relation_size)}")

        # Calculate current indexes size
        indexes_size = sum([await self._estimate_index_size(idx.table, list(idx.columns)) for idx in current_indexes])

        # Total space is base relation plus indexes
        current_space = base_relation_size + indexes_size
        current_time = current_cost
        current_objective = math.log(current_time) + alpha * math.log(current_space) if current_cost > 0 and current_space > 0 else float("inf")

        self.dta_trace(
            f"  - Initial configuration: Time={current_time:.2f}, "
            f"Space={humanize.naturalsize(current_space)} (Base: {humanize.naturalsize(base_relation_size)}, "
            f"Indexes: {humanize.naturalsize(indexes_size)}), "
            f"Objective={current_objective:.4f}"
        )

        added_indexes = []  # Keep track of added indexes in order
        iteration = 1

        while True:
            self.dta_trace(f"\n[ITERATION {iteration}] Evaluating candidates")
            best_index = None
            best_time = current_time
            best_space = current_space
            best_objective = current_objective
            best_time_improvement = 0

            for candidate in candidate_indexes:
                self.dta_trace(f"Evaluating candidate: {candidate_str([candidate])}")
                # Calculate additional size from this index
                index_size = await self._estimate_index_size(candidate.table, list(candidate.columns))
                self.dta_trace(f"    + Index size: {humanize.naturalsize(index_size)}")
                # Total space with this index = current space + new index size
                test_space = current_space + index_size
                self.dta_trace(f"    + Total space: {humanize.naturalsize(test_space)}")

                # Check budget constraint
                if self.budget_mb > 0 and (test_space - base_relation_size) > self.budget_mb * 1024 * 1024:
                    self.dta_trace(
                        f"  - Skipping candidate: {candidate_str([candidate])} because total "
                        f"index size ({humanize.naturalsize(test_space - base_relation_size)}) exceeds "
                        f"budget ({humanize.naturalsize(self.budget_mb * 1024 * 1024)})"
                    )
                    continue

                # Calculate new time (cost) with this index
                test_time = await self._evaluate_configuration_cost(queries, frozenset(idx.index_definition for idx in current_indexes | {candidate}))
                self.dta_trace(f"    + Eval cost (time): {test_time}")

                # Calculate relative time improvement
                time_improvement = (current_time - test_time) / current_time

                # Skip if time improvement is below threshold
                if time_improvement < min_time_improvement:
                    self.dta_trace(f"  - Skipping candidate: {candidate_str([candidate])} because time improvement is below threshold")
                    continue

                # Calculate objective for this configuration
                test_objective = math.log(test_time) + alpha * math.log(test_space)

                # Select the index with the best time improvement that meets our threshold
                if test_objective < best_objective and time_improvement > best_time_improvement:
                    self.dta_trace(f"  - Updating best candidate: {candidate_str([candidate])}")
                    best_index = candidate
                    best_time = test_time
                    best_space = test_space
                    best_objective = test_objective
                    best_time_improvement = time_improvement
                else:
                    self.dta_trace(f"  - Skipping candidate: {candidate_str([candidate])} because it doesn't have the best objective improvement")

            # If no improvement or no valid candidates, stop
            if best_index is None:
                self.dta_trace(f"STOPPED SEARCH: No indexes found with time improvement >= {min_time_improvement:.2%}")
                break

            # Calculate improvements/changes
            time_improvement = (current_time - best_time) / current_time
            space_increase = (best_space - current_space) / current_space
            objective_improvement = current_objective - best_objective

            # Log this step
            self.dta_trace(
                f"  - Selected index: {candidate_str([best_index])}"
                f"\n    + Time improvement: {time_improvement:.2%}"
                f"\n    + Space increase: {space_increase:.2%}"
                f"\n    + New objective: {best_objective:.4f} (improvement: {objective_improvement:.4f})"
            )

            # Add the best index and update metrics
            current_indexes.add(best_index)
            candidate_indexes.remove(best_index)
            added_indexes.append(best_index)

            # Update current metrics
            current_time = best_time
            current_space = best_space
            current_objective = best_objective

            iteration += 1

            # Check if we've exceeded the time limit after doing at least one iteration
            if self._check_time():
                self.dta_trace("STOPPED SEARCH: Time limit reached")
                break

        # Log final configuration
        self.dta_trace("\n[SEARCH COMPLETE]")
        if added_indexes:
            indexes_size = sum([await self._estimate_index_size(idx.table, list(idx.columns)) for idx in current_indexes])
            self.dta_trace(
                f"  - Final configuration: {len(added_indexes)} indexes added"
                f"\n    + Final time: {current_time:.2f}"
                f"\n    + Final space: {humanize.naturalsize(current_space)} (Base: {humanize.naturalsize(base_relation_size)}, "
                f"Indexes: {humanize.naturalsize(indexes_size)})"
                f"\n    + Final objective: {current_objective:.4f}"
            )
        else:
            self.dta_trace("No indexes added - baseline configuration is optimal")

        return current_indexes, current_time

    def _filter_candidates_by_query_conditions(
        self, workload: list[tuple[str, SelectStmt, float]], candidates: list[IndexRecommendation]
    ) -> list[IndexRecommendation]:
        """Filter out index candidates that contain columns not used in query conditions."""
        if not workload or not candidates:
            return candidates

        # Extract all columns used in conditions across all queries
        condition_columns = {}  # Dictionary of table -> set of columns

        for _, stmt, _ in workload:
            try:
                # Use our enhanced collector to extract condition columns
                collector = ConditionColumnCollector()
                collector(stmt)
                query_condition_columns = collector.condition_columns

                # Merge with overall condition columns
                for table, cols in query_condition_columns.items():
                    if table not in condition_columns:
                        condition_columns[table] = set()
                    condition_columns[table].update(cols)

            except Exception as e:
                raise ValueError("Error extracting condition columns from query") from e

        # Filter candidates - keep only those where all columns are in condition_columns
        filtered_candidates = []
        for candidate in candidates:
            table = candidate.table
            if table not in condition_columns:
                continue

            # Check if all columns in the index are used in conditions
            all_columns_used = all(col in condition_columns[table] for col in candidate.columns)
            if all_columns_used:
                filtered_candidates.append(candidate)

        return filtered_candidates

    async def _filter_long_text_columns(self, candidates: list[IndexRecommendation], max_text_length: int = 100) -> list[IndexRecommendation]:
        """Filter out indexes that contain long text columns based on catalog information.

        Args:
            candidates: List of candidate indexes
            max_text_length: Maximum allowed text length (default: 100)

        Returns:
            Filtered list of indexes
        """
        if not candidates:
            return []

        # First, get all unique table.column combinations
        table_columns = set()
        for candidate in candidates:
            for column in candidate.columns:
                table_columns.add((candidate.table, column))

        # Create a list of table names for the query
        tables_array = ",".join(f"'{table}'" for table, _ in table_columns)
        columns_array = ",".join(f"'{col}'" for _, col in table_columns)

        # Query to get column types and their length limits from catalog
        type_query = f"""
            SELECT
                c.table_name,
                c.column_name,
                c.data_type,
                c.character_maximum_length,
                pg_stats.avg_width,
                CASE
                    WHEN c.data_type = 'text' THEN true
                    WHEN (c.data_type = 'character varying' OR c.data_type = 'varchar' OR
                         c.data_type = 'character' OR c.data_type = 'char') AND
                         (c.character_maximum_length IS NULL OR c.character_maximum_length > {max_text_length})
                    THEN true
                    ELSE false
                END as potential_long_text
            FROM information_schema.columns c
            LEFT JOIN pg_stats ON
                pg_stats.tablename = c.table_name AND
                pg_stats.attname = c.column_name
            WHERE c.table_name IN ({tables_array})
            AND c.column_name IN ({columns_array})
        """

        result = await self.sql_driver.execute_query(type_query)  # type: ignore

        logger.debug(f"Column types and length limits: {result}")

        if not result:
            logger.debug("No column types and length limits found")
            return []

        # Process results and identify problematic columns
        problematic_columns = set()
        potential_problematic_columns = set()

        for row in result:
            table = row.cells["table_name"]
            column = row.cells["column_name"]
            potential_long = row.cells["potential_long_text"]
            avg_width = row.cells.get("avg_width")

            # Use avg_width from pg_stats as a heuristic - if it's high, likely contains long text
            if potential_long and (avg_width is None or avg_width > max_text_length * 0.4):
                problematic_columns.add((table, column))
                logger.debug(f"Identified potentially long text column: {table}.{column} (avg_width: {avg_width})")
            elif potential_long:
                potential_problematic_columns.add((table, column))

        # Filter candidates based on column information
        filtered_candidates = []
        for candidate in candidates:
            valid = True
            for column in candidate.columns:
                if (candidate.table, column) in problematic_columns:
                    valid = False
                    logger.debug(f"Skipping index candidate with long text column: {candidate.table}.{column}")
                    break
                elif (candidate.table, column) in potential_problematic_columns:
                    candidate.potential_problematic_reason = "long_text_column"

            if valid:
                filtered_candidates.append(candidate)

        return filtered_candidates

    async def _get_existing_indexes(self) -> list[dict[str, Any]]:
        """Get all existing indexes"""
        # TODO: we should get the indexes that are relevant to the query
        query = """
        SELECT schemaname as schema,
               tablename as table,
               indexname as name,
               indexdef as definition
        FROM pg_indexes
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY schemaname, tablename, indexname
        """
        result = await self.sql_driver.execute_query(query)
        if result is not None:
            return [dict(row.cells) for row in result]
        return []

    def _index_exists(self, index: IndexRecommendation, existing_defs: set[str]) -> bool:
        """Check if an index with the same table, columns, and type already exists in the database.

        Uses pglast to parse index definitions and compare their structure rather than
        doing simple string matching.
        """
        from pglast import parser

        try:
            # Parse the candidate index
            candidate_stmt = parser.parse_sql(index.definition)[0]
            candidate_node = candidate_stmt.stmt

            # Extract key information from candidate index
            candidate_info = self._extract_index_info(candidate_node)

            # If we couldn't parse the candidate index, fall back to string comparison
            if not candidate_info:
                return index.definition in existing_defs

            # Check each existing index
            for existing_def in existing_defs:
                try:
                    # Skip if it's obviously not an index
                    if not ("CREATE INDEX" in existing_def.upper() or "CREATE UNIQUE INDEX" in existing_def.upper()):
                        continue

                    # Parse the existing index
                    existing_stmt = parser.parse_sql(existing_def)[0]
                    existing_node = existing_stmt.stmt

                    # Extract key information
                    existing_info = self._extract_index_info(existing_node)

                    # Compare the key components
                    if existing_info and self._is_same_index(candidate_info, existing_info):
                        return True
                except Exception as e:
                    raise ValueError("Error parsing existing index") from e

            return False
        except Exception as e:
            raise ValueError("Error in robust index comparison") from e

    def _extract_index_info(self, node) -> dict[str, Any] | None:
        """Extract key information from a parsed index node."""
        try:
            # Handle differences in node structure between pglast versions
            if hasattr(node, "IndexStmt"):
                index_stmt = node.IndexStmt
            else:
                index_stmt = node

            # Extract table name
            if hasattr(index_stmt.relation, "relname"):
                table_name = index_stmt.relation.relname
            else:
                # Extract from RangeVar
                table_name = index_stmt.relation.RangeVar.relname

            # Extract columns
            columns = []
            for idx_elem in index_stmt.indexParams:
                if hasattr(idx_elem, "name") and idx_elem.name:
                    columns.append(idx_elem.name)
                elif hasattr(idx_elem, "IndexElem") and idx_elem.IndexElem:
                    columns.append(idx_elem.IndexElem.name)
                elif hasattr(idx_elem, "expr") and idx_elem.expr:
                    # Convert the expression to a proper string representation
                    expr_str = self._ast_expr_to_string(idx_elem.expr)
                    columns.append(expr_str)
            # Extract index type
            index_type = "btree"  # default
            if hasattr(index_stmt, "accessMethod") and index_stmt.accessMethod:
                index_type = index_stmt.accessMethod

            # Check if unique
            is_unique = False
            if hasattr(index_stmt, "unique"):
                is_unique = index_stmt.unique

            return {
                "table": table_name.lower(),
                "columns": [col.lower() for col in columns],
                "type": index_type.lower(),
                "unique": is_unique,
            }
        except Exception as e:
            self.dta_trace(f"Error extracting index info: {e}")
            raise ValueError("Error extracting index info") from e

    def _ast_expr_to_string(self, expr) -> str:
        """Convert an AST expression (like FuncCall) to a proper string representation.

        For example, converts a FuncCall node representing lower(name) to "lower(name)"
        """
        try:
            # Import FuncCall and ColumnRef for type checking
            from pglast.ast import ColumnRef
            from pglast.ast import FuncCall

            # Check for FuncCall type directly
            if isinstance(expr, FuncCall):
                # Extract function name
                if hasattr(expr, "funcname") and expr.funcname:
                    func_name = ".".join([name.sval for name in expr.funcname if hasattr(name, "sval")])
                else:
                    func_name = "unknown_func"

                # Extract arguments
                args = []
                if hasattr(expr, "args") and expr.args:
                    for arg in expr.args:
                        args.append(self._ast_expr_to_string(arg))

                # Format as function call
                return f"{func_name}({','.join(args)})"

            # Check for ColumnRef type directly
            elif isinstance(expr, ColumnRef):
                if hasattr(expr, "fields") and expr.fields:
                    return ".".join([field.sval for field in expr.fields if hasattr(field, "sval")])
                return "unknown_column"

            # Try to handle direct values
            elif hasattr(expr, "sval"):  # String value
                return expr.sval
            elif hasattr(expr, "ival"):  # Integer value
                return str(expr.ival)
            elif hasattr(expr, "fval"):  # Float value
                return expr.fval

            # Fallback for other expression types
            return str(expr)
        except Exception as e:
            raise ValueError("Error converting expression to string") from e

    def _is_same_index(self, index1: dict[str, Any], index2: dict[str, Any]) -> bool:
        """Check if two indexes are functionally equivalent."""
        if not index1 or not index2:
            return False

        # Same table?
        if index1["table"] != index2["table"]:
            return False

        # Same index type?
        if index1["type"] != index2["type"]:
            return False

        # Same columns (order matters for most index types)?
        if index1["columns"] != index2["columns"]:
            # For hash indexes, order doesn't matter
            if index1["type"] == "hash" and set(index1["columns"]) == set(index2["columns"]):
                return True
            return False

        # If one is unique and the other is not, they're different
        # Except when a primary key (which is unique) exists and we're considering a non-unique index on same column
        if index1["unique"] and not index2["unique"]:
            return False

        # Same core definition
        return True


class ConditionColumnCollector(ColumnCollector):
    """
    A specialized version of ColumnCollector that only collects columns used in
    WHERE, JOIN, HAVING conditions, and properly resolves column aliases.
    """

    def __init__(self) -> None:
        super().__init__()
        self.condition_columns = {}  # Specifically for columns in conditions
        self.in_condition = False  # Flag to track if we're inside a condition

    def __call__(self, node):
        super().__call__(node)
        return self.condition_columns

    def visit_SelectStmt(self, ancestors: list[Node], node: Node) -> None:  # noqa: N802
        """
        Visit a SelectStmt node but focus on condition-related clauses,
        while still collecting column aliases.
        """
        if isinstance(node, SelectStmt):
            self.inside_select = True
            self.current_query_level += 1
            query_level = self.current_query_level

            # Get table aliases first
            alias_visitor = TableAliasVisitor()
            if hasattr(node, "fromClause") and node.fromClause:
                for from_item in node.fromClause:
                    alias_visitor(from_item)
            tables = alias_visitor.tables
            aliases = alias_visitor.aliases

            # Store the context for this query
            self.context_stack.append((tables, aliases))

            # First pass: collect column aliases from targetList
            if hasattr(node, "targetList") and node.targetList:
                self.target_list = node.targetList
                for target_entry in self.target_list:
                    if hasattr(target_entry, "name") and target_entry.name:
                        # This is a column alias
                        col_alias = target_entry.name
                        # Store the expression node for this alias
                        if hasattr(target_entry, "val"):
                            self.column_aliases[col_alias] = {
                                "node": target_entry.val,
                                "level": query_level,
                            }

            # Process WHERE clause
            if node.whereClause:
                in_condition_cache = self.in_condition
                self.in_condition = True
                self(node.whereClause)
                self.in_condition = in_condition_cache

            # Process JOIN conditions in fromClause
            if node.fromClause:
                for item in node.fromClause:
                    if isinstance(item, JoinExpr) and item.quals:
                        in_condition_cache = self.in_condition
                        self.in_condition = True
                        self(item.quals)
                        self.in_condition = in_condition_cache

            # Process HAVING clause - may reference aliases
            if node.havingClause:
                in_condition_cache = self.in_condition
                self.in_condition = True
                self._process_having_with_aliases(node.havingClause)
                self.in_condition = in_condition_cache

            # Process ORDER BY clause - also important for indexes
            if hasattr(node, "sortClause") and node.sortClause:
                in_condition_cache = self.in_condition
                self.in_condition = True
                for sort_item in node.sortClause:
                    self._process_node_with_aliases(sort_item.node)
                self.in_condition = in_condition_cache

            # # Process GROUP BY clause - can also benefit from indexes
            # if hasattr(node, "groupClause") and node.groupClause:
            #     in_condition_cache = self.in_condition
            #     self.in_condition = True
            #     for group_item in node.groupClause:
            #         self._process_node_with_aliases(group_item)
            #     self.in_condition = in_condition_cache

            # Clean up the context stack
            self.context_stack.pop()
            self.inside_select = False
            self.current_query_level -= 1

    def _process_having_with_aliases(self, having_clause):
        """Process HAVING clause with special handling for column aliases."""
        self._process_node_with_aliases(having_clause)

    def _process_node_with_aliases(self, node):
        """Process a node, resolving any column aliases it contains."""
        if node is None:
            return

        # If node is a column reference, it might be an alias
        if isinstance(node, ColumnRef) and hasattr(node, "fields") and node.fields:
            fields = [f.sval for f in node.fields if hasattr(f, "sval")] if node.fields else []
            if len(fields) == 1:
                col_name = fields[0]
                # Check if this is a known alias
                if col_name in self.column_aliases:
                    # Process the original expression instead
                    alias_info = self.column_aliases[col_name]
                    if alias_info["level"] == self.current_query_level:
                        self(alias_info["node"])
                        return

        # For non-alias nodes, process normally
        self(node)

    def visit_ColumnRef(self, ancestors: list[Node], node: Node) -> None:  # noqa: N802
        """
        Process column references, but only if we're in a condition context.
        Skip known column aliases but process their underlying expressions.
        """
        if not self.in_condition:
            return  # Skip if not in a condition context

        if not isinstance(node, ColumnRef) or not self.context_stack:
            return

        # Get the current query context
        tables, aliases = self.context_stack[-1]

        # Extract table and column names
        fields = [f.sval for f in node.fields if hasattr(f, "sval")] if node.fields else []

        # Check if this is a reference to a column alias
        if len(fields) == 1 and fields[0] in self.column_aliases:
            # Process the original expression node instead
            alias_info = self.column_aliases[fields[0]]
            if alias_info["level"] == self.current_query_level:
                self.in_condition = True  # Ensure we collect from the aliased expression
                self(alias_info["node"])
            return

        if len(fields) == 2:  # Table.column format
            table_or_alias, column = fields
            # Resolve alias to actual table
            table = aliases.get(table_or_alias, table_or_alias)

            # Add to condition columns
            if table not in self.condition_columns:
                self.condition_columns[table] = set()
            self.condition_columns[table].add(column)

        elif len(fields) == 1:  # Unqualified column
            column = fields[0]

            # For unqualified columns, check all tables in context
            found_match = False
            for table in tables:
                # Skip schema qualification if present
                if "." in table:
                    _, table = table.split(".", 1)

                # Add column to all tables that have it
                if self._column_exists(table, column):
                    if table not in self.condition_columns:
                        self.condition_columns[table] = set()
                    self.condition_columns[table].add(column)
                    found_match = True

            if not found_match:
                logger.debug(f"Could not resolve unqualified column '{column}' to any table")

    def _column_exists(self, table: str, column: str) -> bool:
        """Check if column exists in table."""
        # TODO
        # This would normally query the database
        # For now, we'll return True to collect all possible matches
        # The actual filtering will happen later
        return True
