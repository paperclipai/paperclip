import json
import logging

import pytest

from postgres_mcp.artifacts import ErrorResult
from postgres_mcp.artifacts import ExplainPlanArtifact
from postgres_mcp.explain import ExplainPlanTool
from postgres_mcp.sql import SqlDriver

logger = logging.getLogger(__name__)


@pytest.fixture
def local_sql_driver(test_postgres_connection_string):
    connection_string, version = test_postgres_connection_string
    logger.info(f"Using connection string: {connection_string}")
    logger.info(f"Using version: {version}")
    return SqlDriver(engine_url=connection_string)


async def setup_test_tables(sql_driver):
    pool_wrapper = sql_driver.connect()
    conn_pool = await pool_wrapper.pool_connect()
    async with conn_pool.connection() as conn:
        # Drop existing tables if they exist
        await conn.execute("DROP TABLE IF EXISTS test_orders")
        await conn.execute("DROP TABLE IF EXISTS test_customers")

        # Create tables with various features for testing explain plan
        await conn.execute(
            """
            CREATE TABLE test_customers (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT UNIQUE,
                created_at TIMESTAMP DEFAULT NOW()
            )
        """
        )

        await conn.execute(
            """
            CREATE TABLE test_orders (
                id SERIAL PRIMARY KEY,
                customer_id INTEGER REFERENCES test_customers(id),
                total DECIMAL NOT NULL,
                status TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )
        """
        )

        # Create some indexes to test explain plans
        await conn.execute(
            """
            CREATE INDEX idx_orders_customer ON test_orders(customer_id)
            """
        )
        await conn.execute(
            """
            CREATE INDEX idx_orders_status ON test_orders(status)
            """
        )

        # Insert some test data
        await conn.execute(
            """
            INSERT INTO test_customers (name, email)
            SELECT
                'Customer ' || i,
                'customer' || i || '@example.com'
            FROM generate_series(1, 100) i
        """
        )

        await conn.execute(
            """
            INSERT INTO test_orders (customer_id, total, status)
            SELECT
                (random() * 99)::int + 1,
                (random() * 1000)::decimal,
                CASE (random() * 2)::int
                    WHEN 0 THEN 'pending'
                    WHEN 1 THEN 'completed'
                    ELSE 'cancelled'
                END
            FROM generate_series(1, 1000) i
        """
        )

        # Run ANALYZE to update statistics
        await conn.execute("ANALYZE test_customers")
        await conn.execute("ANALYZE test_orders")


async def cleanup_test_tables(sql_driver):
    pool_wrapper = sql_driver.connect()
    conn_pool = await pool_wrapper.pool_connect()
    try:
        async with conn_pool.connection() as conn:
            await conn.execute("DROP TABLE IF EXISTS test_orders")
            await conn.execute("DROP TABLE IF EXISTS test_customers")
    finally:
        await conn_pool.close()


@pytest.mark.asyncio
async def test_explain_with_real_db(local_sql_driver):
    """Test explain with a real database connection."""
    await setup_test_tables(local_sql_driver)
    try:
        # Create explain plan tool with real db connection
        tool = ExplainPlanTool(sql_driver=local_sql_driver)

        # Test basic explain
        query = "SELECT * FROM test_customers WHERE id = 1"
        result = await tool.explain(query)

        # Verify the result
        assert isinstance(result, ExplainPlanArtifact)
        plan_data = json.loads(result.value)
        assert isinstance(plan_data, dict)
        assert "Plan" in plan_data
        assert "Node Type" in plan_data["Plan"]

        # PostgreSQL may choose different scan types depending on statistics
        # For small tables, sequential scan may be chosen over index scan
        node_type = plan_data["Plan"]["Node Type"]
        assert node_type in ["Index Scan", "Index Only Scan", "Seq Scan"]
    finally:
        await cleanup_test_tables(local_sql_driver)


@pytest.mark.asyncio
async def test_explain_analyze_with_real_db(local_sql_driver):
    """Test explain analyze with a real database connection."""
    await setup_test_tables(local_sql_driver)
    try:
        # Create explain plan tool with real db connection
        tool = ExplainPlanTool(sql_driver=local_sql_driver)

        # Test explain analyze
        query = "SELECT * FROM test_customers WHERE id = 1"
        result = await tool.explain_analyze(query)

        # Verify the result
        assert isinstance(result, ExplainPlanArtifact)
        plan_data = json.loads(result.value)
        assert isinstance(plan_data, dict)
        assert "Plan" in plan_data

        # Check for analyze-specific fields
        assert "Execution Time" in plan_data
        assert "Actual Rows" in plan_data["Plan"]
        assert "Actual Total Time" in plan_data["Plan"]
    finally:
        await cleanup_test_tables(local_sql_driver)


@pytest.mark.asyncio
async def test_explain_join_query_with_real_db(local_sql_driver):
    """Test explain with a join query."""
    await setup_test_tables(local_sql_driver)
    try:
        tool = ExplainPlanTool(sql_driver=local_sql_driver)

        # Test join query explain
        query = """
        SELECT c.name, o.total, o.status
        FROM test_customers c
        JOIN test_orders o ON c.id = o.customer_id
        WHERE o.status = 'completed'
        """
        result = await tool.explain(query)

        # Verify the result
        assert isinstance(result, ExplainPlanArtifact)
        plan_data = json.loads(result.value)
        assert isinstance(plan_data, dict)
        assert "Plan" in plan_data

        # Verify this is a join plan
        assert "Plans" in plan_data["Plan"]
    finally:
        await cleanup_test_tables(local_sql_driver)


@pytest.mark.asyncio
async def test_explain_with_bind_variables_real_db(local_sql_driver):
    """Test explain with bind variables on a real database."""
    await setup_test_tables(local_sql_driver)
    try:
        tool = ExplainPlanTool(sql_driver=local_sql_driver)

        # Test query with bind variables
        query = "SELECT * FROM test_customers WHERE id = $1"
        result = await tool.explain(query)

        # Verify the result
        assert isinstance(result, ExplainPlanArtifact)
        plan_data = json.loads(result.value)
        assert isinstance(plan_data, dict)
    finally:
        await cleanup_test_tables(local_sql_driver)


@pytest.mark.asyncio
async def test_explain_with_like_expressions_real_db(local_sql_driver):
    """Test explain with LIKE expressions on a real database."""
    await setup_test_tables(local_sql_driver)
    try:
        tool = ExplainPlanTool(sql_driver=local_sql_driver)

        # Test query with LIKE expression
        query = "SELECT * FROM test_customers WHERE name LIKE 'Customer%'"
        result = await tool.explain(query)

        # Verify the result
        assert isinstance(result, ExplainPlanArtifact)
        plan_data = json.loads(result.value)
        assert isinstance(plan_data, dict)
        assert "Plan" in plan_data
        # This should be a sequential scan since there's no index on name
        assert plan_data["Plan"]["Node Type"] == "Seq Scan"
    finally:
        await cleanup_test_tables(local_sql_driver)


@pytest.mark.asyncio
async def test_explain_with_like_and_bind_variables_real_db(local_sql_driver):
    """Test explain with both LIKE and bind variables on a real database."""
    await setup_test_tables(local_sql_driver)
    try:
        tool = ExplainPlanTool(sql_driver=local_sql_driver)

        # Test query with both LIKE and bind variables
        query = "SELECT * FROM test_customers WHERE name LIKE $1"
        result = await tool.explain(query)

        # Verify the result
        assert isinstance(result, ExplainPlanArtifact)
        plan_data = json.loads(result.value)
        assert isinstance(plan_data, dict)
    finally:
        await cleanup_test_tables(local_sql_driver)


@pytest.mark.asyncio
async def test_explain_invalid_query_with_real_db(local_sql_driver):
    """Test explain with an invalid query."""
    await setup_test_tables(local_sql_driver)
    try:
        tool = ExplainPlanTool(sql_driver=local_sql_driver)

        # Test invalid query
        query = "SELECT * FROM nonexistent_table"
        result = await tool.explain(query)

        # Verify error handling
        assert isinstance(result, ErrorResult)
        error_msg = result.value.lower()
        assert "relation" in error_msg and "not exist" in error_msg
    finally:
        await cleanup_test_tables(local_sql_driver)
