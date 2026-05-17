import asyncio
import json
from logging import getLogger
from typing import Any
from typing import Dict
from typing import Set
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
import pytest_asyncio
from pglast import parse_sql

from postgres_mcp.artifacts import ExplainPlanArtifact
from postgres_mcp.index.dta_calc import ColumnCollector
from postgres_mcp.index.dta_calc import ConditionColumnCollector
from postgres_mcp.index.dta_calc import DatabaseTuningAdvisor
from postgres_mcp.index.dta_calc import IndexRecommendation

logger = getLogger(__name__)


class MockCell:
    def __init__(self, data: Dict[str, Any]):
        self.cells = data


# Using pytest-asyncio's fixture to run async tests
@pytest_asyncio.fixture
async def async_sql_driver():
    driver = MagicMock()
    driver.execute_query = AsyncMock(return_value=[])
    return driver


@pytest_asyncio.fixture
async def create_dta(async_sql_driver):
    return DatabaseTuningAdvisor(sql_driver=async_sql_driver, budget_mb=10, max_runtime_seconds=60)


# Convert the unittest.TestCase class to use pytest
@pytest.mark.asyncio
async def test_extract_columns_empty_query(create_dta):
    dta = create_dta
    query = "SELECT 1"
    columns = dta._sql_bind_params.extract_columns(query)
    assert columns == {}


@pytest.mark.asyncio
async def test_extract_columns_invalid_sql(create_dta):
    dta = create_dta
    query = "INVALID SQL"
    columns = dta._sql_bind_params.extract_columns(query)
    assert columns == {}


@pytest.mark.asyncio
async def test_extract_columns_subquery(create_dta):
    dta = create_dta
    query = "SELECT * FROM users WHERE id IN (SELECT user_id FROM orders WHERE status = 'pending')"
    columns = dta._sql_bind_params.extract_columns(query)
    assert columns == {"users": {"id"}, "orders": {"user_id", "status"}}


@pytest.mark.asyncio
async def test_index_initialization():
    """Test Index class initialization and properties."""
    idx = IndexRecommendation(
        table="users",
        columns=(
            "name",
            "email",
        ),
    )
    assert idx.table == "users"
    assert idx.columns == ("name", "email")
    assert idx.definition == "CREATE INDEX crystaldba_idx_users_name_email_2 ON users USING btree (name, email)"


@pytest.mark.asyncio
async def test_index_equality():
    """Test Index equality comparison."""
    idx1 = IndexRecommendation(table="users", columns=("name",))
    idx2 = IndexRecommendation(table="users", columns=("name",))
    idx3 = IndexRecommendation(table="users", columns=("email",))

    assert idx1.index_definition == idx2.index_definition
    assert idx1.index_definition != idx3.index_definition


@pytest.mark.asyncio
async def test_extract_columns_from_simple_query(create_dta):
    """Test column extraction from a simple SELECT query."""
    dta = create_dta
    query = "SELECT * FROM users WHERE name = 'Alice' ORDER BY age"
    columns = dta._sql_bind_params.extract_columns(query)
    assert columns == {"users": {"name", "age"}}


@pytest.mark.asyncio
async def test_extract_columns_from_join_query(create_dta):
    """Test column extraction from a query with JOINs."""
    dta = create_dta
    query = """
    SELECT u.name, o.order_date
    FROM users u
    JOIN orders o ON u.id = o.user_id
    WHERE o.status = 'pending'
    """
    columns = dta._sql_bind_params.extract_columns(query)
    assert columns == {
        "users": {"id", "name"},
        "orders": {"user_id", "status", "order_date"},
    }


@pytest.mark.asyncio
async def test_generate_candidates(async_sql_driver, create_dta):
    """Test index candidate generation."""
    global responses
    responses = [
        # information_schema.columns
        [
            MockCell(
                {
                    "table_name": "users",
                    "column_name": "name",
                    "data_type": "character varying",
                    "character_maximum_length": 150,
                    "avg_width": 30,
                    "potential_long_text": True,
                }
            )
        ],
        # create index users.name
        [MockCell({"indexrelid": 123})],
        # pg_stat_statements
        [MockCell({"index_name": "crystaldba_idx_users_name_1", "index_size": 81920})],
        # hypopg_reset
        [],
    ]
    global responses_index
    responses_index = 0

    async def mock_execute_query(query):
        global responses_index
        responses_index += 1
        logger.info(
            f"Query: {query}\n    Response: {
                list(json.dumps(x.cells) for x in responses[responses_index - 1]) if responses_index <= len(responses) else None
            }\n--------------------------------------------------------"
        )
        return responses[responses_index - 1] if responses_index <= len(responses) else None

    async_sql_driver.execute_query = AsyncMock(side_effect=mock_execute_query)

    dta = create_dta

    q1 = "SELECT * FROM users WHERE name = 'Alice'"
    queries = [(q1, parse_sql(q1)[0].stmt, 1.0)]
    candidates = await dta.generate_candidates(queries, set())

    assert any(c.table == "users" and c.columns == ("name",) for c in candidates)
    assert candidates[0].estimated_size_bytes == 10 * 8192


@pytest.mark.asyncio
async def test_analyze_workload(async_sql_driver, create_dta):
    async def mock_execute_query(query):
        logger.info(f"Query: {query}")
        if "pg_stat_statements" in query:
            return [
                MockCell(
                    {
                        "queryid": 1,
                        "query": "SELECT * FROM users WHERE id IN (SELECT user_id FROM orders)",
                        "calls": 100,
                        "avg_exec_time": 10.0,
                    }
                )
            ]
        elif "EXPLAIN" in query:
            if "COSTS TRUE" in query:
                return [MockCell({"QUERY PLAN": [{"Plan": {"Total Cost": 80.0}}]})]  # Cost with hypothetical index
            else:
                return [MockCell({"QUERY PLAN": [{"Plan": {"Total Cost": 100.0}}]})]  # Current cost
        elif "hypopg_reset" in query:
            return None
        elif "FROM information_schema.columns c" in query:
            return [
                MockCell(
                    {
                        "table_name": "users",
                        "column_name": "id",
                        "data_type": "integer",
                        "character_maximum_length": None,
                        "avg_width": 4,
                        "potential_long_text": False,
                    }
                ),
            ]
        elif "pg_stats" in query:
            return [MockCell({"total_width": 10, "total_distinct": 100})]  # For index size estimation
        elif "pg_extension" in query:
            return [MockCell({"exists": 1})]
        elif "hypopg_disable_index" in query:
            return None
        elif "hypopg_enable_index" in query:
            return None
        elif "pg_total_relation_size" in query:
            return [MockCell({"rel_size": 100000})]
        elif "pg_stat_user_tables" in query:
            return [MockCell({"last_analyze": "2023-01-01"})]
        return None  # Default response for unrecognized queries

    async_sql_driver.execute_query = AsyncMock(side_effect=mock_execute_query)

    dta = create_dta

    session = await dta.analyze_workload(min_calls=50, min_avg_time_ms=5.0)

    logger.debug(f"Recommendations: {session.recommendations}")
    assert any(r.table in {"users", "orders"} for r in session.recommendations)


@pytest.mark.asyncio
async def test_error_handling(async_sql_driver, create_dta):
    """Test error handling in critical methods."""
    # Test HypoPG setup failure
    async_sql_driver.execute_query = AsyncMock(side_effect=RuntimeError("HypoPG not available"))
    dta = create_dta
    session = await dta.analyze_workload(min_calls=50, min_avg_time_ms=5.0)
    assert "HypoPG not available" in session.error

    # Test invalid query handling
    async_sql_driver.execute_query = AsyncMock(return_value=None)
    dta = create_dta

    invalid_query = "INVALID SQL"
    columns = dta._sql_bind_params.extract_columns(invalid_query)
    assert columns == {}


@pytest.mark.asyncio
async def test_index_exists(create_dta):
    """Test the robust index comparison functionality."""
    dta = create_dta

    # Create test cases with various index definition patterns
    test_cases = [
        # Basic case - exact match
        {
            "candidate": IndexRecommendation("users", ("name",)),
            "existing_defs": {"CREATE INDEX crystaldba_idx_users_name_1 ON users USING btree (name)"},
            "expected": True,
            "description": "Exact match",
        },
        # Different name but same structure
        {
            "candidate": IndexRecommendation("users", ("id",)),
            "existing_defs": {"CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)"},
            "expected": True,
            "description": "Primary key detection",
        },
        # Different schema but same table and columns
        {
            "candidate": IndexRecommendation("users", ("email",)),
            "existing_defs": {"CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email)"},
            "expected": True,
            "description": "Schema-qualified match",
        },
        # Multi-column index with different order
        {
            "candidate": IndexRecommendation("orders", ("customer_id", "product_id"), "hash"),
            "existing_defs": {"CREATE INDEX orders_idx ON orders USING hash (product_id, customer_id)"},
            "expected": True,
            "description": "Hash index with different column order",
        },
        # Partial match - not enough
        {
            "candidate": IndexRecommendation("products", ("category", "name", "price")),
            "existing_defs": {"CREATE INDEX products_category_idx ON products USING btree (category)"},
            "expected": False,
            "description": "Partial coverage - not enough",
        },
        # Complete match but different type
        {
            "candidate": IndexRecommendation("payments", ("method", "status"), "hash"),
            "existing_defs": {"CREATE INDEX payments_method_status_idx ON payments USING btree (method, status)"},
            "expected": False,
            "description": "Different index type",
        },
        # Different table
        {
            "candidate": IndexRecommendation("customers", ("id",)),
            "existing_defs": {"CREATE INDEX users_id_idx ON users USING btree (id)"},
            "expected": False,
            "description": "Different table",
        },
        # Complex case with expression index
        {
            "candidate": IndexRecommendation("users", ("name",)),
            "existing_defs": {"CREATE INDEX users_name_idx ON users USING btree (lower(name))"},
            "expected": False,
            "description": "Expression index vs regular column",
        },
    ]

    # Run all test cases
    for tc in test_cases:
        result = dta._index_exists(tc["candidate"], tc["existing_defs"])
        assert result == tc["expected"], (
            f"Failed: {tc['description']}\nCandidate: {tc['candidate']}\nExisting: {tc['existing_defs']}\nExpected: {tc['expected']}"
        )

    # Test fallback mechanism when parsing fails
    with patch("pglast.parser.parse_sql", side_effect=Exception("Parsing error")):
        # Should use fallback and return True based on substring matching
        index = IndexRecommendation("users", ("name", "email"))
        with pytest.raises(Exception, match="Error in robust index comparison"):
            dta._index_exists(
                index,
                {"CREATE INDEX users_name_email_idx ON users USING btree (name, email)"},
            )

        # Should return False when no match even with fallback
        index = IndexRecommendation("users", ("address",))
        with pytest.raises(Exception, match="Error in robust index comparison"):
            dta._index_exists(
                index,
                {"CREATE INDEX users_name_email_idx ON users USING btree (name, email)"},
            )


@pytest.mark.asyncio
async def test_ndistinct_handling(create_dta):
    """Test handling of ndistinct values in row estimation calculations."""
    dta = create_dta

    # Test cases with different ndistinct values
    test_cases = [
        {
            "stats": {
                "total_width": 10.0,
                "total_distinct": 5,
            },  # Positive ndistinct
            "expected": 180,  # 18.0 * 5.0 * 2.0
        },
        {
            "stats": {
                "total_width": 10.0,
                "total_distinct": -0.5,
            },  # Negative ndistinct
            "expected": 36,  # 18.0 * 1.0 * 2.0
        },
        {
            "stats": {"total_width": 10.0, "total_distinct": 0},  # Zero ndistinct
            "expected": 36,  # 18.0 * 1.0 * 2.0
        },
    ]

    for case in test_cases:
        result = dta._estimate_index_size_internal(stats=case["stats"])
        assert result == case["expected"], f"Failed for n_distinct={case['stats']['total_distinct']}. Expected: {case['expected']}, Got: {result}"


@pytest.mark.asyncio
async def test_filter_long_text_columns(async_sql_driver, create_dta):
    """Test filtering of long text columns from index candidates."""
    dta = create_dta

    # Mock the column type query results
    type_query_results = [
        MockCell(
            {
                "table_name": "users",
                "column_name": "name",
                "data_type": "character varying",
                "character_maximum_length": 50,  # Short varchar - should keep
                "avg_width": 4,
                "potential_long_text": False,
            }
        ),
        MockCell(
            {
                "table_name": "users",
                "column_name": "bio",
                "data_type": "text",  # Text type - needs length check
                "character_maximum_length": None,
                "avg_width": 105,
                "potential_long_text": True,
            }
        ),
        MockCell(
            {
                "table_name": "users",
                "column_name": "description",
                "data_type": "character varying",
                "character_maximum_length": 200,  # Long varchar - should filter out
                "avg_width": 70,
                "potential_long_text": True,
            }
        ),
        MockCell(
            {
                "table_name": "users",
                "column_name": "status",
                "data_type": "character varying",
                "character_maximum_length": None,  # Unlimited varchar - needs length check
                "avg_width": 10,
                "potential_long_text": True,
            }
        ),
    ]

    async def mock_execute_query(query):
        if "information_schema.columns" in query:
            return type_query_results
        return None

    async_sql_driver.execute_query = AsyncMock(side_effect=mock_execute_query)

    # Create test candidates
    candidates = [
        IndexRecommendation("users", ("name",)),  # Should keep (short varchar)
        IndexRecommendation("users", ("bio",)),  # Should filter out (long text)
        IndexRecommendation("users", ("description",)),  # Should filter out (long varchar)
        IndexRecommendation("users", ("status",)),  # Should keep (unlimited varchar but short actual length)
        IndexRecommendation("users", ("name", "status")),  # Should keep (both columns ok)
        IndexRecommendation("users", ("name", "bio")),  # Should filter out (contains long text)
        IndexRecommendation("users", ("description", "status")),  # Should filter out (contains long varchar)
    ]

    # Execute the filter with max_text_length = 100
    filtered = await dta._filter_long_text_columns(candidates, max_text_length=100)

    logger.info(f"Filtered: {filtered}")

    # Check results
    filtered_indexes = [(c.table, c.columns) for c in filtered]

    logger.info(f"Filtered indexes: {filtered_indexes}")

    # These should be kept
    assert ("users", ("name",)) in filtered_indexes
    assert ("users", ("status",)) in filtered_indexes
    assert ("users", ("name", "status")) in filtered_indexes

    # These should be filtered out
    assert ("users", ("bio",)) not in filtered_indexes
    assert ("users", ("description",)) not in filtered_indexes
    assert ("users", ("name", "bio")) not in filtered_indexes
    assert ("users", ("description", "status")) not in filtered_indexes

    # Verify the number of filtered results
    assert len(filtered) == 3


@pytest.mark.asyncio
async def test_basic_workload_analysis(async_sql_driver):
    """Test basic workload analysis functionality."""
    dta = DatabaseTuningAdvisor(
        sql_driver=async_sql_driver,
        budget_mb=50,  # 50 MB budget
        max_runtime_seconds=300,  # 300 seconds limit
        max_index_width=2,  # Up to 2-column indexes
        seed_columns_count=2,  # Top 2 single-column seeds
    )

    workload = [
        {"query": "SELECT * FROM users WHERE name = 'Alice'", "calls": 100},
        {"query": "SELECT * FROM orders WHERE user_id = 123", "calls": 50},
    ]
    global responses
    responses = [
        # check if hypopg is enabled
        [MockCell({"hypopg_enabled_result": 1})],
        # check last analyze
        [MockCell({"last_analyze": "2024-01-01 00:00:00"})],
        # pg_stat_statements
        [
            MockCell(
                {
                    "queryid": 1,
                    "query": workload[0]["query"],
                    "calls": 100,
                    "avg_exec_time": 10.0,
                }
            ),
            MockCell(
                {
                    "queryid": 2,
                    "query": workload[1]["query"],
                    "calls": 50,
                    "avg_exec_time": 5.0,
                }
            ),
        ],
        # pg_indexes
        [],
        # information_schema.columns
        [
            MockCell(
                {
                    "table_name": "users",
                    "column_name": "name",
                    "data_type": "character varying",
                    "character_maximum_length": 150,
                    "avg_width": 30,
                    "potential_long_text": True,
                }
            ),
            MockCell(
                {
                    "table_name": "orders",
                    "column_name": "user_id",
                    "data_type": "integer",
                    "character_maximum_length": None,
                    "avg_width": 4,
                    "potential_long_text": False,
                }
            ),
        ],
        # hypopg_create_index (for users.name, orders.user_id)
        [MockCell({"indexrelid": 1554}), MockCell({"indexrelid": 1555})],
        # hypopg_list_indexes
        [
            MockCell({"index_name": "crystaldba_idx_users_name_1", "index_size": 8000}),
            MockCell(
                {
                    "index_name": "crystaldba_idx_orders_user_id_1",
                    "index_size": 4000,
                }
            ),
        ],
        # hypopg_reset
        [],
        # EXPLAIN without indexes
        [MockCell({"QUERY PLAN": [{"Plan": {"Total Cost": 100.0}}]})],  # users.name
        [MockCell({"QUERY PLAN": [{"Plan": {"Total Cost": 150.0}}]})],  # orders.user_id
        [MockCell({"rel_size": 10000})],  # users table size
        [MockCell({"rel_size": 10000})],  # orders table size
        # pg_stats for size (users.name, orders.user_id)
        [MockCell({"total_width": 10, "total_distinct": 100})],
        # EXPLAIN with users.name index
        [MockCell({"QUERY PLAN": [{"Plan": {"Total Cost": 50.0}}]})],  # users.name
        [MockCell({"QUERY PLAN": [{"Plan": {"Total Cost": 150.0}}]})],  # orders.user_id
        [MockCell({"total_width": 8, "total_distinct": 50})],
        # EXPLAIN without orders.user_id index
        [MockCell({"QUERY PLAN": [{"Plan": {"Total Cost": 100.0}}]})],  # users.name
        [MockCell({"QUERY PLAN": [{"Plan": {"Total Cost": 75.0}}]})],  # orders.user_id
        # EXPLAIN with users.name and orders.user_id indexes
        [MockCell({"QUERY PLAN": [{"Plan": {"Total Cost": 50.0}}]})],  # users.name
        [MockCell({"QUERY PLAN": [{"Plan": {"Total Cost": 75.0}}]})],  # orders.user_id
        # hypopg_reset (final cleanup)
        [],
    ]
    global responses_index
    responses_index = 0

    async def mock_execute_query(query, *args, **kwargs):
        global responses_index
        responses_index += 1
        logger.info(
            f"Query: {query}\n    Response: {
                list(json.dumps(x.cells) for x in responses[responses_index - 1]) if responses_index <= len(responses) else None
            }\n--------------------------------------------------------"
        )
        return responses[responses_index - 1] if responses_index <= len(responses) else None

    async_sql_driver.execute_query = AsyncMock(side_effect=mock_execute_query)

    session = await dta.analyze_workload(min_calls=50, min_avg_time_ms=5.0)

    # Verify recommendations
    assert len(session.recommendations) > 0
    assert any(r.table == "users" and "name" in r.columns for r in session.recommendations)
    assert any(r.table == "orders" and "user_id" in r.columns for r in session.recommendations)


@pytest.mark.asyncio
async def test_replace_parameters_basic(create_dta):
    """Test basic parameter replacement functionality."""
    dta = create_dta

    dta._sql_bind_params._column_stats_cache = {}
    dta._sql_bind_params.extract_columns = MagicMock(return_value={"users": ["name", "id", "status"]})
    dta._sql_bind_params._identify_parameter_column = MagicMock(return_value=("users", "name"))
    dta._sql_bind_params._get_column_statistics = AsyncMock(
        return_value={
            "data_type": "character varying",
            "common_vals": ["John", "Alice"],
            "histogram_bounds": None,
        }
    )

    query = "SELECT * FROM users WHERE name = $1"
    result = await dta._sql_bind_params.replace_parameters(query.lower())
    assert result == "select * from users where name = 'John'"

    # Verify the column was identified correctly
    dta._sql_bind_params._identify_parameter_column.assert_called_once()


@pytest.mark.asyncio
async def test_replace_parameters_numeric(create_dta):
    """Test parameter replacement for numeric columns."""
    dta = create_dta

    dta._sql_bind_params._column_stats_cache = {}
    dta._sql_bind_params.extract_columns = MagicMock(return_value={"orders": ["id", "amount", "user_id"]})
    dta._sql_bind_params._identify_parameter_column = MagicMock(return_value=("orders", "amount"))
    dta._sql_bind_params._get_column_statistics = AsyncMock(
        return_value={
            "data_type": "numeric",
            "common_vals": [99.99, 49.99],
            "histogram_bounds": [10.0, 50.0, 100.0, 500.0],
        }
    )

    # Range query
    query = "SELECT * FROM orders WHERE amount > $1"
    result = await dta._sql_bind_params.replace_parameters(query.lower())
    assert result == "select * from orders where amount > 100.0"

    # Equality query
    dta._identify_parameter_column = MagicMock(return_value=("orders", "amount"))
    query = "SELECT * FROM orders WHERE amount = $1"
    result = await dta._sql_bind_params.replace_parameters(query.lower())
    assert result == "select * from orders where amount = 99.99"


@pytest.mark.asyncio
async def test_replace_parameters_date(create_dta):
    """Test parameter replacement for date columns."""
    dta = create_dta

    dta._sql_bind_params._column_stats_cache = {}
    dta._sql_bind_params.extract_columns = MagicMock(return_value={"orders": ["id", "order_date", "user_id"]})
    dta._sql_bind_params._identify_parameter_column = MagicMock(return_value=("orders", "order_date"))
    dta._sql_bind_params._get_column_statistics = AsyncMock(
        return_value={
            "data_type": "timestamp without time zone",
            "common_vals": None,
            "histogram_bounds": None,
        }
    )

    query = "SELECT * FROM orders WHERE order_date > $1"
    result = await dta._sql_bind_params.replace_parameters(query.lower())
    assert result == "select * from orders where order_date > '2023-01-15'"


@pytest.mark.asyncio
async def test_replace_parameters_like(create_dta):
    """Test parameter replacement for LIKE patterns."""
    dta = create_dta

    dta._sql_bind_params._column_stats_cache = {}
    dta._sql_bind_params.extract_columns = MagicMock(return_value={"users": ["name", "email"]})
    dta._sql_bind_params._identify_parameter_column = MagicMock(return_value=("users", "name"))
    dta._sql_bind_params._get_column_statistics = AsyncMock(
        return_value={
            "data_type": "character varying",
            "common_vals": ["John", "Alice"],
            "histogram_bounds": None,
        }
    )

    query = "SELECT * FROM users WHERE name LIKE $1"
    result = await dta._sql_bind_params.replace_parameters(query.lower())
    assert result == "select * from users where name like '%test%'"


@pytest.mark.asyncio
async def test_replace_parameters_multiple(create_dta):
    """Test replacement of multiple parameters in a complex query."""
    dta = create_dta

    dta._sql_bind_params._column_stats_cache = {}
    dta._sql_bind_params.extract_columns = MagicMock(
        return_value={
            "users": ["id", "name", "status"],
            "orders": ["id", "user_id", "amount", "order_date"],
        }
    )

    # We'll need to return different values based on the context
    def identify_column_side_effect(context, table_columns: Dict[str, Set[str]]):
        if "status =" in context:
            return ("users", "status")
        elif "amount BETWEEN" in context:
            return ("orders", "amount")
        elif "order_date >" in context:
            return ("orders", "order_date")
        return None

    dta._sql_bind_params._identify_parameter_column = MagicMock(side_effect=identify_column_side_effect)

    def get_stats_side_effect(table, column):
        if table == "users" and column == "status":
            return {
                "data_type": "character varying",
                "common_vals": ["active", "inactive"],
            }
        elif table == "orders" and column == "amount":
            return {
                "data_type": "numeric",
                "common_vals": [99.99],
                "histogram_bounds": [10.0, 50.0, 100.0],
            }
        elif table == "orders" and column == "order_date":
            return {"data_type": "timestamp without time zone"}
        return None

    dta._sql_bind_params._get_column_statistics = AsyncMock(side_effect=get_stats_side_effect)

    query = """
    SELECT u.name, o.amount
    FROM users u
    JOIN orders o ON u.id = o.user_id
    WHERE u.status = $1
    AND o.amount BETWEEN $2 AND $3
    AND o.order_date > $4
    """

    result = await dta._sql_bind_params.replace_parameters(query.lower())
    assert "u.status = 'active'" in result
    assert "o.amount between 10.0 and 100.0" in result
    assert "o.order_date > '2023-01-15'" in result


@pytest.mark.asyncio
async def test_replace_parameters_fallback(create_dta):
    """Test fallback behavior when column information is not available."""
    dta = create_dta

    dta._sql_bind_params.extract_columns = MagicMock(return_value={})

    # Simple query with numeric parameter
    query = "SELECT * FROM users WHERE id = $1"
    result = await dta._sql_bind_params.replace_parameters(query.lower())
    assert "id = 46" in result or "id = '46'" in result

    # Complex query with various parameters
    query = """
    SELECT * FROM users
    WHERE status = $1
    AND created_at > $2
    AND name LIKE $3
    AND age BETWEEN $4 AND $5
    """
    result = await dta._sql_bind_params.replace_parameters(query.lower())
    assert "status = 'active'" in result or "status = 'sample_value'" in result
    assert "created_at > '2023-01-01'" in result
    assert "name like '%sample%'" in result or "name like '%" in result
    assert "between 10 and 100" in result or "between 42 and 42" in result


@pytest.mark.asyncio
async def test_extract_columns(create_dta):
    """Test extracting table and column information from queries."""
    dta = create_dta

    dta._sql_bind_params.extract_columns = MagicMock(return_value={"users": {"id", "name", "status"}})

    query = "SELECT * FROM users WHERE name = $1 AND status = $2"
    result = dta._sql_bind_params.extract_columns(query)
    assert result == {"users": {"id", "name", "status"}}


@pytest.mark.asyncio
async def test_identify_parameter_column(create_dta):
    """Test identifying which column a parameter belongs to."""
    dta = create_dta
    table_columns = {
        "users": ["id", "name", "status", "email"],
        "orders": ["id", "user_id", "amount", "order_date"],
    }

    # Test equality pattern
    context = "SELECT * FROM users WHERE name = $1"
    result = dta._sql_bind_params._identify_parameter_column(context, table_columns)
    assert result == ("users", "name")

    # Test LIKE pattern
    context = "SELECT * FROM users WHERE email LIKE $1"
    result = dta._sql_bind_params._identify_parameter_column(context, table_columns)
    assert result == ("users", "email")

    # Test range pattern
    context = "SELECT * FROM orders WHERE amount > $1"
    result = dta._sql_bind_params._identify_parameter_column(context, table_columns)
    assert result == ("orders", "amount")

    # Test BETWEEN pattern
    context = "SELECT * FROM orders WHERE order_date BETWEEN $1 AND $2"
    result = dta._sql_bind_params._identify_parameter_column(context, table_columns)
    assert result == ("orders", "order_date")

    # Test no match
    context = "SELECT * FROM users WHERE $1"  # Invalid but should handle gracefully
    result = dta._sql_bind_params._identify_parameter_column(context, table_columns)
    assert result is None


@pytest.mark.asyncio
async def test_get_replacement_value(create_dta):
    """Test generating replacement values based on statistics."""
    dta = create_dta

    # String type with common values for equality
    stats = {
        "data_type": "character varying",
        "common_vals": ["active", "pending", "completed"],
        "histogram_bounds": None,
    }
    result = dta._sql_bind_params._get_replacement_value(stats, "status = $1")
    assert result == "'active'"

    # Numeric type with histogram bounds for range
    stats = {
        "data_type": "numeric",
        "common_vals": [10.0, 20.0],
        "histogram_bounds": [5.0, 15.0, 25.0, 50.0, 100.0],
    }
    result = dta._sql_bind_params._get_replacement_value(stats, "amount > $1")
    assert result == "25.0"

    # Date type
    stats = {"data_type": "date", "common_vals": None, "histogram_bounds": None}
    result = dta._sql_bind_params._get_replacement_value(stats, "created_at < $1")
    assert result == "'2023-01-15'"

    # Boolean type
    stats = {
        "data_type": "boolean",
        "common_vals": [True, False],
        "histogram_bounds": None,
    }
    result = dta._sql_bind_params._get_replacement_value(stats, "is_active = $1")
    assert result == "true"


@pytest.mark.asyncio
async def test_condition_column_collector_simple(async_sql_driver):
    """Test basic functionality of ConditionColumnCollector."""
    query = "SELECT hobby FROM users WHERE name = 'Alice' AND age > 25"
    parsed = parse_sql(query)[0].stmt

    collector = ColumnCollector()
    collector(parsed)

    assert collector.columns == {"users": {"hobby", "name", "age"}}

    collector = ConditionColumnCollector()
    collector(parsed)

    assert collector.condition_columns == {"users": {"name", "age"}}


@pytest.mark.asyncio
async def test_condition_column_collector_join(async_sql_driver):
    """Test condition column collection with JOIN conditions."""
    query = """
    SELECT u.name, o.order_date
    FROM users u
    JOIN orders o ON u.id = o.user_id
    WHERE o.status = 'pending' AND u.active = true
    """
    parsed = parse_sql(query)[0].stmt

    collector = ColumnCollector()
    collector(parsed)

    assert collector.columns == {
        "users": {"id", "active", "name"},
        "orders": {"user_id", "status", "order_date"},
    }

    collector = ConditionColumnCollector()
    collector(parsed)

    assert collector.condition_columns == {
        "users": {"id", "active"},
        "orders": {"user_id", "status"},
    }


@pytest.mark.asyncio
async def test_condition_column_collector_with_alias(async_sql_driver):
    """Test condition column collection with column aliases in conditions."""
    query = """
    SELECT u.name, u.age, COUNT(o.id) as order_count , o.order_date as begin_order_date, o.status as order_status
    FROM users u
    LEFT JOIN orders o ON u.id = o.user_id
    WHERE u.status = 'active'
    GROUP BY u.name
    HAVING order_count > 5
    ORDER BY order_count DESC
    """
    parsed = parse_sql(query)[0].stmt

    cond_collector = ConditionColumnCollector()
    cond_collector(parsed)

    # Should extract o.id from HAVING COUNT(o.id) > 5
    # But should NOT include order_count as a table column
    assert cond_collector.condition_columns == {
        "users": {"id", "status"},
        "orders": {"user_id", "id"},
    }

    # Verify order_count is recognized as an alias
    assert "order_count" in cond_collector.column_aliases

    collector = ColumnCollector()
    collector(parsed)

    assert collector.columns == {
        "users": {"id", "status", "name", "age"},
        "orders": {"user_id", "id", "status", "order_date"},
    }


@pytest.mark.asyncio
async def test_complex_query_with_alias_in_conditions(async_sql_driver):
    """Test complex query with aliases used in multiple conditions."""
    query = """
    SELECT
        u.name,
        u.email,
        EXTRACT(YEAR FROM u.created_at) as join_year,
        COUNT(o.id) as order_count,
        SUM(o.total) as revenue
    FROM users u
    LEFT JOIN orders o ON u.id = o.user_id
    WHERE u.status = 'active' AND join_year > 2020
    GROUP BY u.name, u.email, join_year
    HAVING order_count > 10 AND revenue > 1000
    ORDER BY revenue DESC
    """
    parsed = parse_sql(query)[0].stmt

    collector = ColumnCollector()
    collector(parsed)

    # Should extract the underlying columns from aliases used in conditions
    assert collector.columns == {
        "users": {"id", "status", "created_at", "name", "email"},
        "orders": {"user_id", "id", "total"},
    }

    collector = ConditionColumnCollector()
    collector(parsed)

    # Should extract the underlying columns from aliases used in conditions
    assert collector.condition_columns == {
        "users": {"id", "status", "created_at"},
        "orders": {"user_id", "id", "total"},
    }

    # Verify aliases are recognized
    assert "join_year" in collector.column_aliases
    assert "order_count" in collector.column_aliases
    assert "revenue" in collector.column_aliases


@pytest.mark.asyncio
async def test_filter_candidates_by_query_conditions(async_sql_driver, create_dta):
    """Test filtering index candidates based on query conditions."""
    dta = create_dta

    # Mock the sql_driver for _column_exists
    async_sql_driver.execute_query.return_value = [MockCell({"1": 1})]

    # Create test queries
    q1 = "SELECT * FROM users WHERE name = 'Alice' AND age > 25"
    q2 = "SELECT * FROM orders WHERE status = 'pending' AND total > 100"
    queries = [(q1, parse_sql(q1)[0].stmt, 1.0), (q2, parse_sql(q2)[0].stmt, 1.0)]

    # Create test candidates (some with columns not in conditions)
    candidates = [
        IndexRecommendation("users", ("name",)),
        IndexRecommendation("users", ("name", "email")),  # email not in conditions
        IndexRecommendation("users", ("age",)),
        IndexRecommendation("orders", ("status", "total")),
        IndexRecommendation("orders", ("order_date",)),  # order_date not in conditions
    ]

    # Execute the filter
    filtered = dta._filter_candidates_by_query_conditions(queries, candidates)

    # Check results
    filtered_tables_columns = [(c.table, c.columns) for c in filtered]
    assert ("users", ("name",)) in filtered_tables_columns
    assert ("users", ("age",)) in filtered_tables_columns
    assert ("orders", ("status", "total")) in filtered_tables_columns

    # These shouldn't be in the filtered list
    assert ("users", ("name", "email")) not in filtered_tables_columns
    assert ("orders", ("order_date",)) not in filtered_tables_columns


@pytest.mark.asyncio
async def test_extract_condition_columns(async_sql_driver):
    """Test the _extract_condition_columns method directly."""
    query = """
    SELECT u.name, o.order_date
    FROM users u, orders o
    WHERE o.status = 'pending' AND u.active = true
    """
    parsed = parse_sql(query)[0].stmt

    collector = ConditionColumnCollector()
    collector(parsed)

    # Check results
    assert collector.condition_columns == {"users": {"active"}, "orders": {"status"}}


@pytest.mark.asyncio
async def test_condition_collector_with_order_by(async_sql_driver):
    """Test that columns used in ORDER BY are collected for indexing."""
    query = """
    SELECT u.name, o.order_date, o.amount
    FROM orders o
    JOIN users u ON o.user_id = u.id
    WHERE o.status = 'completed'
    ORDER BY o.order_date DESC
    """
    parsed = parse_sql(query)[0].stmt

    collector = ConditionColumnCollector()
    collector(parsed)

    # Should include o.order_date from ORDER BY clause
    assert collector.condition_columns == {
        "users": {"id"},
        "orders": {"user_id", "status", "order_date"},
    }


@pytest.mark.asyncio
async def test_condition_collector_with_order_by_alias(async_sql_driver):
    """Test that columns in aliased expressions in ORDER BY are collected."""
    query = """
    SELECT u.name, COUNT(o.id) as order_count
    FROM users u
    LEFT JOIN orders o ON u.id = o.user_id
    WHERE u.status = 'active'
    GROUP BY u.name
    ORDER BY order_count DESC
    """
    parsed = parse_sql(query)[0].stmt

    collector = ConditionColumnCollector()
    collector(parsed)

    # Should extract o.id from ORDER BY order_count DESC
    # where order_count is COUNT(o.id)
    assert collector.condition_columns == {
        "users": {"id", "status"},
        "orders": {"user_id", "id"},
    }


@pytest.mark.asyncio
async def test_enumerate_greedy_pareto_cost_benefit(async_sql_driver):
    """Test the Pareto optimal implementation with the specified cost/benefit analysis."""
    dta = DatabaseTuningAdvisor(sql_driver=async_sql_driver, budget_mb=1000, max_runtime_seconds=120)

    # Mock the _check_time method to always return False (no time limit reached)
    dta._check_time = MagicMock(return_value=False)  # type: ignore

    # Mock the _estimate_index_size method to return a fixed size
    dta._estimate_index_size = AsyncMock(return_value=1024 * 1024)  # type: ignore  # 1MB per index

    # Create test queries
    q1 = "SELECT * FROM test_table WHERE col1 = 1"
    queries = [(q1, parse_sql(q1)[0].stmt, 1.0)]

    # Create candidate indexes
    candidate_indexes = set()
    for i in range(10):
        candidate_indexes.add(IndexRecommendation(table="test_table", columns=(f"col{i}",)))

    # Base query cost
    base_cost = 1000.0

    # Define costs for different configurations
    config_costs = {
        0: 1000,  # No indexes
        1: 700,  # With index 0: 30% improvement
        2: 560,  # With indexes 0,1: 20% improvement
        3: 504,  # With indexes 0,1,2: 10% improvement
        4: 479,  # With indexes 0,1,2,3: 5% improvement
        5: 474,  # With indexes 0,1,2,3,4: 1% improvement
        6: 469,  # ~1% improvements each
        7: 464,
        8: 459,
        9: 454,
        10: 449,
    }

    # Define index sizes
    index_sizes = {
        0: 1 * 1024 * 1024,  # 1MB - very efficient
        1: 2 * 1024 * 1024,  # 2MB - efficient
        2: 2 * 1024 * 1024,  # 2MB - less efficient
        3: 8 * 1024 * 1024,  # 8MB - inefficient
        4: 16 * 1024 * 1024,  # 16MB - very inefficient
        5: 32 * 1024 * 1024,  # 32MB
        6: 32 * 1024 * 1024,
        7: 32 * 1024 * 1024,
        8: 32 * 1024 * 1024,
        9: 32 * 1024 * 1024,
    }

    # Base relation size
    base_relation_size = 50 * 1024 * 1024  # 50MB for test_table

    # Mock the cost evaluation
    async def mock_evaluate_cost(queries, config):
        return config_costs[len(config)]

    # Mock the index size calculation
    async def mock_index_size(table, columns):
        if len(columns) == 1 and columns[0].startswith("col"):
            index_num = int(columns[0][3:])
            return index_sizes.get(index_num, 1024 * 1024)
        return 1024 * 1024

    # Mock the estimate_table_size method
    async def mock_estimate_table_size(table):
        return base_relation_size

    # Mock SQL driver execute_query method to simulate getting table size
    async def mock_execute_query(query):
        logger.info(f"mock_execute_query: {query}")
        if "pg_total_relation_size" in query:
            return [MockCell({"rel_size": base_relation_size})]
        return []

    dta._evaluate_configuration_cost = AsyncMock(side_effect=mock_evaluate_cost)  # type: ignore
    dta._estimate_index_size = AsyncMock(side_effect=mock_index_size)  # type: ignore
    dta._estimate_table_size = AsyncMock(side_effect=mock_estimate_table_size)  # type: ignore

    # Set alpha parameter for cost/benefit analysis
    dta.pareto_alpha = 2.0

    # Set minimum time improvement threshold to stop after 3 indexes
    dta.min_time_improvement = 0.05  # 5% threshold

    # Call _enumerate_greedy with cost/benefit analysis
    current_indexes = set()
    current_cost = base_cost
    final_indexes, final_cost = await dta._enumerate_greedy(  # type: ignore
        queries, current_indexes, current_cost, candidate_indexes.copy()
    )

    # We expect exactly 3 indexes to be selected with 5% threshold
    assert len(final_indexes) == 3
    assert final_cost == 504  # Cost after adding 3 indexes

    # Test with a lower threshold - should include more indexes
    dta.min_time_improvement = 0.015  # 1.5% threshold

    current_indexes = set()
    current_cost = base_cost
    final_indexes_lower_threshold, final_cost_lower_threshold = await dta._enumerate_greedy(  # type: ignore
        queries, current_indexes, current_cost, candidate_indexes.copy()
    )

    # With 1% threshold, should include at least 3 indexes
    assert len(final_indexes_lower_threshold) >= 3

    # Test with a higher threshold - should include fewer indexes
    dta.min_time_improvement = 0.25  # 25% threshold

    current_indexes = set()
    current_cost = base_cost
    final_indexes_higher_threshold, final_cost_higher_threshold = await dta._enumerate_greedy(  # type: ignore
        queries, current_indexes, current_cost, candidate_indexes.copy()
    )

    # With 25% threshold, should include only the first 1 index
    assert len(final_indexes_higher_threshold) == 1


def test_explain_plan_diff():
    """Test the explain plan diff functionality."""
    # Create a before plan with sequential scan
    before_plan = {
        "Plan": {
            "Node Type": "Aggregate",
            "Strategy": "Plain",
            "Startup Cost": 300329.67,
            "Total Cost": 300329.68,
            "Plan Rows": 1,
            "Plan Width": 32,
            "Plans": [
                {
                    "Node Type": "Seq Scan",
                    "Relation Name": "users",
                    "Alias": "users",
                    "Startup Cost": 0.00,
                    "Total Cost": 286022.64,
                    "Plan Rows": 1280,
                    "Plan Width": 32,
                    "Filter": "email LIKE '%example.com'",
                }
            ],
        }
    }

    # Create an after plan with index scan instead
    after_plan = {
        "Plan": {
            "Node Type": "Aggregate",
            "Strategy": "Plain",
            "Startup Cost": 17212.28,
            "Total Cost": 17212.29,
            "Plan Rows": 1,
            "Plan Width": 32,
            "Plans": [
                {
                    "Node Type": "Index Scan",
                    "Relation Name": "users",
                    "Alias": "users",
                    "Index Name": "users_email_idx",
                    "Startup Cost": 0.43,
                    "Total Cost": 17212.00,
                    "Plan Rows": 1280,
                    "Plan Width": 32,
                    "Filter": "email LIKE '%example.com'",
                }
            ],
        }
    }

    # Generate the diff
    diff_output = ExplainPlanArtifact.create_plan_diff(before_plan, after_plan)

    # Verify the diff contains key expected elements
    assert "PLAN CHANGES:" in diff_output
    assert "Cost:" in diff_output
    assert "improvement" in diff_output

    # Verify it detected the change from Seq Scan to Index Scan
    assert "Seq Scan" in diff_output
    assert "Index Scan" in diff_output

    # Verify it includes some form of diff notation
    assert "→" in diff_output

    # Verify the cost values are shown in the diff
    assert "300329" in diff_output
    assert "17212" in diff_output

    # Verify it mentions the structural change
    assert "sequential scans replaced" in diff_output or "new index scans" in diff_output

    # Test with invalid plan data
    empty_diff = ExplainPlanArtifact.create_plan_diff({}, {})
    assert "Cannot generate diff" in empty_diff

    # Test with missing Plan field
    invalid_diff = ExplainPlanArtifact.create_plan_diff({"NotAPlan": {}}, {"NotAPlan": {}})
    assert "Cannot generate diff" in invalid_diff


@pytest_asyncio.fixture(autouse=True)
async def cleanup_pools():
    """Fixture to ensure all connection pools are properly closed after each test."""
    # Setup - nothing to do here
    yield

    # Find and close any active connection pools
    tasks = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
    if tasks:
        logger.debug(f"Waiting for {len(tasks)} tasks to complete...")
        await asyncio.gather(*tasks, return_exceptions=True)


if __name__ == "__main__":
    pytest.main()
