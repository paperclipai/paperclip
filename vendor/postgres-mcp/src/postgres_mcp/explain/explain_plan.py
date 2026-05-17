# ruff: noqa: E501

from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING
from typing import Any

from ..artifacts import ErrorResult
from ..artifacts import ExplainPlanArtifact
from ..sql import IndexDefinition
from ..sql import SafeSqlDriver
from ..sql import SqlBindParams
from ..sql import check_postgres_version_requirement

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from ..sql.sql_driver import SqlDriver


class ExplainPlanTool:
    """Tool for generating and analyzing PostgreSQL explain plans."""

    def __init__(self, sql_driver: SqlDriver):
        self.sql_driver = sql_driver

    async def replace_query_parameters_if_needed(self, sql_query: str) -> tuple[str, bool]:
        """Replace bind variables with sample values in a query."""
        use_generic_plan = False
        has_bind_variables = self._has_bind_variables(sql_query)

        # If query has bind variables, check PostgreSQL version for generic plan support
        if has_bind_variables:
            has_like = self._has_like_expressions(sql_query)

            meets_pg_version_requirement, _message = await check_postgres_version_requirement(
                self.sql_driver, min_version=16, feature_name="Generic plan with bind variables ($1, $2, etc.)"
            )

            # If PostgreSQL < 16 or the query has LIKE expressions (which don't work with GENERIC_PLAN)
            if not meets_pg_version_requirement or has_like:
                # Replace bind variables with sample values
                logger.debug("Replacing bind variables with sample values in query")
                if meets_pg_version_requirement and has_like:
                    logger.debug("LIKE expressions detected, using parameter replacement instead of GENERIC_PLAN")
                bind_params = SqlBindParams(self.sql_driver)
                modified_query = await bind_params.replace_parameters(sql_query)
                logger.debug(f"Original query: {sql_query}")
                logger.debug(f"Modified query: {modified_query}")
                sql_query = modified_query
            else:
                use_generic_plan = True

        return sql_query, use_generic_plan

    async def explain(self, sql_query: str, do_analyze: bool = False) -> ExplainPlanArtifact | ErrorResult:
        """
        Generate an EXPLAIN plan for a SQL query.

        Args:
            sql_query: The SQL query to explain

        Returns:
            ExplainPlanArtifact or ErrorResult
        """
        modified_sql_query, use_generic_plan = await self.replace_query_parameters_if_needed(sql_query)
        return await self._run_explain_query(modified_sql_query, analyze=do_analyze, generic_plan=use_generic_plan)

    async def explain_analyze(self, sql_query: str) -> ExplainPlanArtifact | ErrorResult:
        """
        Generate an EXPLAIN ANALYZE plan for a SQL query.

        Args:
            sql_query: The SQL query to explain and analyze

        Returns:
            ExplainPlanArtifact or ErrorResult
        """
        return await self.explain(sql_query, do_analyze=True)

    async def explain_with_hypothetical_indexes(
        self, sql_query: str, hypothetical_indexes: list[dict[str, Any]]
    ) -> ExplainPlanArtifact | ErrorResult:
        """
        Generate an explain plan for a query as if certain indexes existed.

        Args:
            sql_query: The SQL query to explain
            hypothetical_indexes: List of index definitions as dictionaries

        Returns:
            ExplainPlanArtifact or ErrorResult
        """
        try:
            # Validate index definitions format
            if not isinstance(hypothetical_indexes, list):
                return ErrorResult(f"Expected list of index definitions, got {type(hypothetical_indexes)}")

            for idx in hypothetical_indexes:
                if not isinstance(idx, dict):
                    return ErrorResult(f"Expected dictionary for index definition, got {type(idx)}")
                if "table" not in idx:
                    return ErrorResult("Missing 'table' in index definition")
                if "columns" not in idx:
                    return ErrorResult("Missing 'columns' in index definition")
                if not isinstance(idx["columns"], list):
                    # Try to convert to list if it's not already
                    try:
                        idx["columns"] = list(idx["columns"]) if hasattr(idx["columns"], "__iter__") else [idx["columns"]]
                    except Exception as e:
                        return ErrorResult(f"Expected list for 'columns', got {type(idx['columns'])}: {e}")

            # Convert the index definitions to IndexConfig objects
            indexes = frozenset(
                IndexDefinition(
                    table=idx["table"],
                    columns=tuple(idx["columns"]),
                    using=idx.get("using", "btree"),
                )
                for idx in hypothetical_indexes
            )

            # Check if the query contains bind variables
            modified_sql_query, use_generic_plan = await self.replace_query_parameters_if_needed(sql_query)

            # Generate the explain plan using the static method
            plan_data = await self.generate_explain_plan_with_hypothetical_indexes(modified_sql_query, indexes, use_generic_plan)

            # Check if we got a valid plan
            if not plan_data or not isinstance(plan_data, dict) or "Plan" not in plan_data:
                return ErrorResult("Failed to generate a valid explain plan with the hypothetical indexes")

            try:
                # Convert the plan data to an ExplainPlanArtifact
                return ExplainPlanArtifact.from_json_data(plan_data)
            except Exception as e:
                return ErrorResult(f"Error converting explain plan: {e}")

        except Exception as e:
            logger.error(f"Error in explain_with_hypothetical_indexes: {e}", exc_info=True)
            return ErrorResult(f"Error generating explain plan with hypothetical indexes: {e}")

    def _has_bind_variables(self, query: str) -> bool:
        """Check if a query contains bind variables ($1, $2, etc)."""
        return bool(re.search(r"\$\d+", query))

    def _has_like_expressions(self, query: str) -> bool:
        """Check if a query contains LIKE expressions, which don't work with GENERIC_PLAN."""
        return bool(re.search(r"\bLIKE\b", query, re.IGNORECASE))

    async def _run_explain_query(self, query: str, analyze: bool = False, generic_plan: bool = False) -> ExplainPlanArtifact | ErrorResult:
        try:
            explain_options = ["FORMAT JSON"]
            if analyze:
                explain_options.append("ANALYZE")
            if generic_plan:
                explain_options.append("GENERIC_PLAN")

            explain_q = f"EXPLAIN ({', '.join(explain_options)}) {query}"
            logger.debug(f"RUNNING EXPLAIN QUERY: {explain_q}")
            rows = await self.sql_driver.execute_query(explain_q)  # type: ignore
            if rows is None:
                return ErrorResult("No results returned from EXPLAIN")

            query_plan_data = rows[0].cells["QUERY PLAN"]

            if not isinstance(query_plan_data, list):
                return ErrorResult(f"Expected list from EXPLAIN, got {type(query_plan_data)}")
            if len(query_plan_data) == 0:
                return ErrorResult("No results returned from EXPLAIN")

            plan_dict = query_plan_data[0]
            if not isinstance(plan_dict, dict):
                return ErrorResult(f"Expected dict in EXPLAIN result list, got {type(plan_dict)} with value {plan_dict}")

            try:
                return ExplainPlanArtifact.from_json_data(plan_dict)
            except Exception as e:
                return ErrorResult(f"Internal error converting explain plan - do not retry: {e}")
        except Exception as e:
            return ErrorResult(f"Error executing explain plan: {e}")

    async def generate_explain_plan_with_hypothetical_indexes(
        self,
        query_text: str,
        indexes: frozenset[IndexDefinition],
        use_generic_plan: bool = False,
        dta=None,
    ) -> dict[str, Any]:
        """
        Generate an explain plan for a query with specified indexes.

        Args:
            sql_driver: SQL driver to execute the query
            query_text: The SQL query to explain
            indexes: A frozenset of IndexConfig objects representing the indexes to enable

        Returns:
            The explain plan as a dictionary
        """
        try:
            # Create the indexes query
            create_indexes_query = "SELECT hypopg_reset();"
            if len(indexes) > 0:
                create_indexes_query += SafeSqlDriver.param_sql_to_query(
                    "SELECT hypopg_create_index({});" * len(indexes),
                    [idx.definition for idx in indexes],
                )

            # Execute explain with the indexes
            explain_options = ["FORMAT JSON"]
            if use_generic_plan:
                explain_options.append("GENERIC_PLAN")
            if indexes:
                explain_options.append("COSTS TRUE")

            explain_plan_query = f"{create_indexes_query}EXPLAIN ({', '.join(explain_options)}) {query_text}"
            plan_result = await self.sql_driver.execute_query(explain_plan_query)  # type: ignore

            # Extract the plan
            if plan_result and plan_result[0].cells.get("QUERY PLAN"):
                plan_data = plan_result[0].cells.get("QUERY PLAN")
                if isinstance(plan_data, list) and len(plan_data) > 0:
                    return plan_data[0]
                else:
                    dta.dta_trace(  # type: ignore
                        f"      - plan_data is an empty list with plan_data type: {type(plan_data)}"
                    )  # type: ignore

            dta.dta_trace("      - returning empty plan")  # type: ignore
            # Return empty plan if no result
            return {"Plan": {"Total Cost": float("inf")}}

        except Exception as e:
            logger.error(
                f"Error getting explain plan for query: {query_text} with error: {e}",
                exc_info=True,
            )
            raise e
