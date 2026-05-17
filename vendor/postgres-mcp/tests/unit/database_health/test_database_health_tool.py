import logging

import pytest

from postgres_mcp.database_health import DatabaseHealthTool
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
        await conn.execute('DROP TABLE IF EXISTS "UpperCaseOrders"')
        await conn.execute("DROP TABLE IF EXISTS test_customers")
        await conn.execute("DROP SEQUENCE IF EXISTS test_seq")

        # Create test sequence
        await conn.execute("CREATE SEQUENCE test_seq")

        # Create tables with various features to test health checks
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

        # Lowercase table name (original test case)
        await conn.execute(
            """
            CREATE TABLE test_orders (
                id SERIAL PRIMARY KEY,
                customer_id INTEGER REFERENCES test_customers(id),
                total DECIMAL NOT NULL CHECK (total >= 0),
                status TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )
        """
        )

        # Uppercase table name to test quoted identifier handling (PR #94 fix)
        await conn.execute(
            """
            CREATE TABLE "UpperCaseOrders" (
                id SERIAL PRIMARY KEY,
                customer_id INTEGER REFERENCES test_customers(id),
                amount DECIMAL NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )
        """
        )

        # Create some indexes to test index health
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
        await conn.execute(
            """
            CREATE INDEX idx_orders_created ON test_orders(created_at)
            """
        )
        # Create a duplicate index to test duplicate index detection
        await conn.execute(
            """
            CREATE INDEX idx_orders_customer_dup ON test_orders(customer_id)
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
                (random() * 99)::int + 1,  -- Changed to ensure IDs are between 1 and 100
                (random() * 1000)::decimal,
                CASE (random() * 2)::int
                    WHEN 0 THEN 'pending'
                    WHEN 1 THEN 'completed'
                    ELSE 'cancelled'
                END
            FROM generate_series(1, 1000) i
        """
        )

        # Insert data into uppercase table to test sequence handling
        await conn.execute(
            """
            INSERT INTO "UpperCaseOrders" (customer_id, amount)
            SELECT
                (random() * 99)::int + 1,
                (random() * 500)::decimal
            FROM generate_series(1, 100) i
        """
        )

        # Run ANALYZE to update statistics
        await conn.execute("ANALYZE test_customers")
        await conn.execute("ANALYZE test_orders")
        await conn.execute('ANALYZE "UpperCaseOrders"')


async def cleanup_test_tables(sql_driver):
    pool_wrapper = sql_driver.connect()
    conn_pool = await pool_wrapper.pool_connect()
    try:
        async with conn_pool.connection() as conn:
            await conn.execute("DROP TABLE IF EXISTS test_orders")
            await conn.execute('DROP TABLE IF EXISTS "UpperCaseOrders"')
            await conn.execute("DROP TABLE IF EXISTS test_customers")
            await conn.execute("DROP SEQUENCE IF EXISTS test_seq")
    finally:
        await conn_pool.close()


@pytest.mark.asyncio
async def test_database_health_all(local_sql_driver):
    """Test that the database health tool runs without errors when performing all health checks.
    This test only verifies that the tool executes successfully and returns results in the expected format.
    It does not validate whether the health check results are correct."""
    await setup_test_tables(local_sql_driver)
    try:
        local_sql_driver.connect()
        health_tool = DatabaseHealthTool(sql_driver=local_sql_driver)

        # Run health check with type "all"
        result = await health_tool.health(health_type="all")

        # Verify the result
        assert isinstance(result, str)
        health_report = result

        # Check that all health components are present
        assert "Invalid index check:" in health_report
        assert "Duplicate index check:" in health_report
        assert "Index bloat:" in health_report
        assert "Unused index check:" in health_report
        assert "Connection health:" in health_report
        assert "Vacuum health:" in health_report
        assert "Sequence health:" in health_report
        assert "Replication health:" in health_report
        assert "Buffer health for indexes:" in health_report
        assert "Buffer health for tables:" in health_report
        assert "Constraint health:" in health_report

        # Verify specific health issues we know should be detected
        assert "idx_orders_customer_dup" in health_report  # Should detect duplicate index

    finally:
        await cleanup_test_tables(local_sql_driver)
