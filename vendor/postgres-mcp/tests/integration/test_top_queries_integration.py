import logging

import pytest
import pytest_asyncio

from postgres_mcp.sql import SqlDriver
from postgres_mcp.top_queries import PG_STAT_STATEMENTS
from postgres_mcp.top_queries import TopQueriesCalc

logger = logging.getLogger(__name__)


@pytest_asyncio.fixture
async def local_sql_driver(test_postgres_connection_string):
    """Create a SQL driver connected to a real PostgreSQL database."""
    connection_string, version = test_postgres_connection_string
    logger.info(f"Using connection string: {connection_string}")
    logger.info(f"Using version: {version}")

    driver = SqlDriver(engine_url=connection_string)
    driver.connect()  # This is not an async method, no await needed
    try:
        yield driver
    finally:
        # Cleanup
        if hasattr(driver, "conn") and driver.conn is not None:
            await driver.conn.close()


async def setup_test_data(sql_driver):
    """Set up test data with sample queries to analyze."""
    # Ensure pg_stat_statements extension is available
    try:
        # Check if extension exists
        rows = await sql_driver.execute_query("SELECT 1 FROM pg_available_extensions WHERE name = 'pg_stat_statements'")

        if rows and len(rows) > 0:
            # Try to create extension if not already installed
            try:
                await sql_driver.execute_query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements")
                logger.info("pg_stat_statements extension created or already exists")
            except Exception as e:
                logger.warning(f"Unable to create pg_stat_statements extension: {e}")
                pytest.skip("pg_stat_statements extension not available or cannot be created")
        else:
            pytest.skip("pg_stat_statements extension not available")

        # Create test tables
        await sql_driver.execute_query("""
            DROP TABLE IF EXISTS test_items;
            CREATE TABLE test_items (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                value INTEGER NOT NULL
            )
        """)

        # Insert test data
        await sql_driver.execute_query("""
            INSERT INTO test_items (name, value)
            SELECT
                'Item ' || i,
                (random() * 1000)::INTEGER
            FROM generate_series(1, 1000) i
        """)

        # Reset pg_stat_statements to ensure clean data
        await sql_driver.execute_query("SELECT pg_stat_statements_reset()")

        # Run queries several times to ensure they're captured and have significant stats
        # Query 1: Simple select (should be fast)
        for _i in range(10):
            await sql_driver.execute_query("SELECT COUNT(*) FROM test_items")

        # Query 2: More complex query (should be slower)
        for _i in range(5):
            await sql_driver.execute_query("""
                SELECT name, value
                FROM test_items
                WHERE value > 500
                ORDER BY value DESC
            """)

        # Query 3: Very slow query - run more times to ensure it shows up
        for _i in range(10):
            await sql_driver.execute_query("""
                SELECT t1.name, t2.name
                FROM test_items t1
                CROSS JOIN test_items t2
                WHERE t1.value > t2.value
                LIMIT 100
            """)

    except Exception as e:
        logger.error(f"Error setting up test data: {e}")
        raise


async def cleanup_test_data(sql_driver):
    """Clean up test data."""
    try:
        await sql_driver.execute_query("DROP TABLE IF EXISTS test_items")
        await sql_driver.execute_query("SELECT pg_stat_statements_reset()")
    except Exception as e:
        logger.warning(f"Error cleaning up test data: {e}")


@pytest.mark.asyncio
async def test_get_top_queries_integration(local_sql_driver):
    """
    Integration test for get_top_queries with a real database.
    """
    try:
        await setup_test_data(local_sql_driver)

        # Verify pg_stat_statements has captured our queries
        pg_stats = await local_sql_driver.execute_query("SELECT query FROM pg_stat_statements WHERE query LIKE '%CROSS JOIN%' LIMIT 1")
        if not pg_stats or len(pg_stats) == 0:
            pytest.skip("pg_stat_statements did not capture the CROSS JOIN query")

        # Create the TopQueriesCalc instance
        calc = TopQueriesCalc(sql_driver=local_sql_driver)

        # Get top queries by total execution time
        total_result = await calc.get_top_queries_by_time(limit=10, sort_by="total")

        # Get top queries by mean execution time
        mean_result = await calc.get_top_queries_by_time(limit=10, sort_by="mean")

        # Basic verification
        assert "slowest queries by total execution time" in total_result
        assert "slowest queries by mean execution time" in mean_result

        # Log results for manual inspection
        logger.info(f"Top queries by total time: {total_result}")
        logger.info(f"Top queries by mean time: {mean_result}")

        # Check for our specific test queries - at least one should be found
        # since we run many different queries
        has_cross_join = "CROSS JOIN" in total_result
        has_value_gt_500 = "value > 500" in total_result
        has_count = "COUNT(*)" in total_result

        assert has_cross_join or has_value_gt_500 or has_count, "None of our test queries appeared in the results"

    finally:
        await cleanup_test_data(local_sql_driver)


@pytest.mark.asyncio
async def test_extension_not_available(local_sql_driver):
    """Test behavior when pg_stat_statements extension is not available."""
    # Create the TopQueriesCalc instance
    calc = TopQueriesCalc(sql_driver=local_sql_driver)

    # Need to patch at the module level for proper mocking
    with pytest.MonkeyPatch().context() as mp:
        # Import the module we'll be monkeypatching
        import postgres_mcp.sql.extension_utils
        from postgres_mcp.sql.extension_utils import ExtensionStatus

        # Define our mock function with the correct type signature
        async def mock_check(*args, **kwargs):
            return ExtensionStatus(
                is_installed=False,
                is_available=True,
                name=PG_STAT_STATEMENTS,
                message="Extension not installed",
                default_version=None,
            )

        # Replace the function with our mock
        # We need to patch the actual function imported by TopQueriesCalc
        mp.setattr(postgres_mcp.top_queries.top_queries_calc, "check_extension", mock_check)

        # Run the test
        result = await calc.get_top_queries_by_time()

        # Check that we get installation instructions
        assert "not currently installed" in result
        assert "CREATE EXTENSION" in result
