from unittest.mock import AsyncMock
from unittest.mock import Mock
from unittest.mock import call

import pytest
import pytest_asyncio
from psycopg.sql import SQL
from psycopg.sql import Literal

from postgres_mcp.sql import SafeSqlDriver
from postgres_mcp.sql import SqlDriver


@pytest_asyncio.fixture
async def mock_sql_driver():
    driver = Mock(spec=SqlDriver)
    driver.execute_query = AsyncMock(return_value=[])
    return driver


@pytest_asyncio.fixture
async def safe_driver(mock_sql_driver):
    return SafeSqlDriver(mock_sql_driver)


@pytest.mark.asyncio
async def test_select_statement(safe_driver, mock_sql_driver):
    """Test that simple SELECT statements are allowed"""
    query = "SELECT * FROM users WHERE age > 18"
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_update_statement(safe_driver):
    """Test that UPDATE statements are blocked"""
    query = "UPDATE users SET status = 'active' WHERE id = 1"
    with pytest.raises(
        ValueError,
        match="Error validating query",
    ):
        await safe_driver.execute_query(query)


@pytest.mark.asyncio
async def test_select_with_join(safe_driver, mock_sql_driver):
    """Test that SELECT with JOIN is allowed"""
    query = """
    SELECT users.name, orders.order_date
    FROM users
    INNER JOIN orders ON users.id = orders.user_id
    WHERE orders.status = 'pending'
    """
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_show_variable(safe_driver, mock_sql_driver):
    """Test that SHOW statements are allowed"""
    query = "SHOW search_path"
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_set_variable(safe_driver):
    """Test that SET statements are blocked"""
    query = "SET search_path TO public"
    with pytest.raises(
        ValueError,
        match="Error validating query",
    ):
        await safe_driver.execute_query(query)


@pytest.mark.asyncio
async def test_select_with_arithmetic(safe_driver, mock_sql_driver):
    """Test that SELECT with arithmetic expressions is allowed"""
    query = "SELECT id, price * quantity as total FROM orders"
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_select_current_user(safe_driver, mock_sql_driver):
    """Test that SELECT current_user is allowed"""
    query = "SELECT current_user"
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_drop_table(safe_driver):
    """Test that DROP TABLE statements are blocked"""
    query = "DROP TABLE users"
    with pytest.raises(
        ValueError,
        match="Error validating query",
    ):
        await safe_driver.execute_query(query)


@pytest.mark.asyncio
async def test_delete_from_table(safe_driver):
    """Test that DELETE FROM statements are blocked"""
    query = "DELETE FROM users WHERE status = 'inactive'"
    with pytest.raises(
        ValueError,
        match="Error validating query",
    ):
        await safe_driver.execute_query(query)


@pytest.mark.asyncio
async def test_select_with_subquery(safe_driver, mock_sql_driver):
    """Test that SELECT with subqueries is allowed"""
    query = """
    SELECT name FROM users
    WHERE id IN (SELECT user_id FROM orders WHERE total > 1000)
    """
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_select_with_malicious_comment(safe_driver):
    """Test that SQL injection via comments is blocked"""
    query = """
    SELECT * FROM users; DROP TABLE users;
    """
    with pytest.raises(
        ValueError,
        match="Error validating query",
    ):
        await safe_driver.execute_query(query)


@pytest.mark.asyncio
async def test_select_with_union(safe_driver, mock_sql_driver):
    """Test that UNION queries are allowed"""
    query = """
    SELECT id, name FROM users
    UNION
    SELECT NULL, concat(table_name) FROM information_schema.tables
    """
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_select_into(safe_driver):
    """Test that SELECT INTO statements are blocked"""
    query = """
    SELECT id, name
    INTO new_table
    FROM users
    """
    with pytest.raises(ValueError, match="Error validating query"):
        await safe_driver.execute_query(query)


@pytest.mark.asyncio
async def test_select_for_update(safe_driver):
    """Test that SELECT FOR UPDATE statements are blocked"""
    query = """
    SELECT id, name
    FROM users
    FOR UPDATE
    """
    with pytest.raises(ValueError, match="Error validating query"):
        await safe_driver.execute_query(query)


@pytest.mark.asyncio
async def test_select_with_locking_clause(safe_driver):
    """Test that SELECT with explicit locking clauses is blocked"""
    query = """
    SELECT id, name
    FROM users
    FOR SHARE NOWAIT
    """
    with pytest.raises(ValueError, match="Error validating query"):
        await safe_driver.execute_query(query)


@pytest.mark.asyncio
async def test_select_with_commit(safe_driver):
    """Test that statements containing COMMIT are blocked"""
    query = """
    SELECT id FROM users;
    COMMIT;
    SELECT name FROM users;
    """
    with pytest.raises(
        ValueError,
        match="Error validating query",
    ):
        await safe_driver.execute_query(query)


@pytest.mark.asyncio
async def test_explain_plan(safe_driver, mock_sql_driver):
    """Test that EXPLAIN (without ANALYZE) works with bind variables"""
    query = """
    EXPLAIN (FORMAT JSON)
    SELECT id, name
    FROM users
    WHERE age > $1 AND status = $2
    """
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_explain_analyze_blocked(safe_driver):
    """Test that EXPLAIN ANALYZE is blocked"""
    query = """
    EXPLAIN ANALYZE
    SELECT id, name FROM users
    """
    with pytest.raises(ValueError, match="Error validating query"):
        await safe_driver.execute_query(query)


@pytest.mark.asyncio
async def test_begin_transaction_blocked(safe_driver):
    """Test that transaction blocks are blocked"""
    query = """
    BEGIN;
    SELECT id, name FROM users;
    """
    with pytest.raises(
        ValueError,
        match="Error validating query",
    ):
        await safe_driver.execute_query(query)


@pytest.mark.asyncio
async def test_invalid_sql_syntax(safe_driver):
    """Test that queries with invalid SQL syntax are blocked"""
    query1 = "SELECT * FRMO users;"
    with pytest.raises(ValueError, match="Failed to parse SQL statement"):
        await safe_driver.execute_query(query1)

    query2 = "SELECT * FROM users INNER JOON posts ON users.id = posts.user_id;"
    with pytest.raises(ValueError, match="Failed to parse SQL statement"):
        await safe_driver.execute_query(query2)

    query3 = "SELECT * FROM users WHERE (age > 21 AND active = true;"
    with pytest.raises(ValueError, match="Failed to parse SQL statement"):
        await safe_driver.execute_query(query3)


@pytest.mark.asyncio
async def test_create_index_blocked(safe_driver):
    """Test that CREATE INDEX statements are blocked"""
    query = """
    CREATE INDEX idx_user_email ON users(email);
    """
    with pytest.raises(
        ValueError,
        match="Error validating query",
    ):
        await safe_driver.execute_query(query)


@pytest.mark.asyncio
async def test_drop_index_blocked(safe_driver):
    """Test that DROP INDEX statements are blocked"""
    query = """
    DROP INDEX idx_user_email;
    """
    with pytest.raises(
        ValueError,
        match="Error validating query",
    ):
        await safe_driver.execute_query(query)


@pytest.mark.asyncio
async def test_create_table_blocked(safe_driver):
    """Test that CREATE TABLE statements are blocked"""
    query = """
    CREATE TABLE test_table (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """
    with pytest.raises(
        ValueError,
        match="Error validating query",
    ):
        await safe_driver.execute_query(query)


@pytest.mark.asyncio
async def test_create_table_as_blocked(safe_driver):
    """Test that CREATE TABLE AS statements are blocked"""
    query = """
    CREATE TABLE user_backup AS
    SELECT * FROM users;
    """
    with pytest.raises(
        ValueError,
        match="Error validating query",
    ):
        await safe_driver.execute_query(query)


@pytest.mark.asyncio
async def test_create_extension_blocked(safe_driver):
    """Test that CREATE EXTENSION statements are blocked"""
    query = """
    CREATE EXTENSION pg_hack;
    """
    with pytest.raises(ValueError, match="Error validating query"):
        await safe_driver.execute_query(query)


@pytest.mark.asyncio
async def test_drop_extension_blocked(safe_driver):
    """Test that DROP EXTENSION statements are blocked"""
    query = """
    DROP EXTENSION pg_stat_statements;
    """
    with pytest.raises(
        ValueError,
        match="Error validating query",
    ):
        await safe_driver.execute_query(query)


@pytest.mark.asyncio
async def test_complex_index_metadata_select(safe_driver, mock_sql_driver):
    """Test that complex SELECT queries for index metadata are allowed"""
    query = """SELECT indexrelid::regclass AS index_name, array_agg(attname) AS columns,
    indisunique, indisprimary
    FROM pg_index i
    JOIN pg_attribute a ON a.attnum = ANY(i.indkey)
    WHERE i.indrelid IN (SELECT oid FROM pg_class WHERE relnamespace =
        (SELECT oid FROM pg_namespace WHERE nspname = 'public'))
    GROUP BY indexrelid, indisunique, indisprimary
    HAVING COUNT(array_agg(attname)) > 1"""
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_allowed_functions(safe_driver):
    """Tests that allow functions (especially the ones that are newly added)"""
    query = """
    SELECT pg_relation_filenode('foo');
    """
    await safe_driver.execute_query(query)


@pytest.mark.asyncio
async def test_disallowed_functions(safe_driver):
    """Test that disallowed functions are blocked"""
    queries = [
        "SELECT pg_sleep(1);",
        "SELECT pg_read_file('/etc/passwd');",
        "SELECT lo_import('/etc/passwd');",
    ]

    for query in queries:
        with pytest.raises(ValueError, match="Error validating query"):
            await safe_driver.execute_query(query)


@pytest.mark.asyncio
async def test_session_info_functions(safe_driver, mock_sql_driver):
    """Test that session info functions are allowed"""
    query = "SELECT current_user, current_database(), version()"
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_blocking_pids_functions(safe_driver, mock_sql_driver):
    """Test that blocking pids functions are allowed"""
    query = "SELECT pg_blocking_pids(1234)"
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_logfile_functions(safe_driver, mock_sql_driver):
    """Test that logfile functions are allowed"""
    query = "SELECT pg_current_logfile()"
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_complex_session_info_queries(safe_driver, mock_sql_driver):
    """Test that complex session info queries are allowed"""
    query = """
    SELECT current_user, current_database(), version(),
           pg_backend_pid(), pg_blocking_pids(pg_backend_pid())
    """
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_security_privilege_functions(safe_driver, mock_sql_driver):
    """Test that security privilege functions are allowed"""
    query = "SELECT has_table_privilege('user', 'table', 'SELECT')"
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_complex_security_privilege_queries(safe_driver, mock_sql_driver):
    """Test more complex queries using security privilege functions"""
    queries = [
        """
        SELECT tablename, has_table_privilege(current_user, tablename, 'SELECT') as can_select,
               has_table_privilege(current_user, tablename, 'UPDATE') as can_update
        FROM pg_tables
        WHERE schemaname = 'public'
        ORDER BY tablename
        """,
        """
        SELECT proname, has_function_privilege(current_user, p.oid, 'EXECUTE') as can_execute
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public'
        """,
        """
        SELECT c.relname, a.attname,
               has_column_privilege(current_user, c.oid, a.attnum, 'SELECT') as can_select,
               has_column_privilege(current_user, c.oid, a.attnum, 'UPDATE') as can_update
        FROM pg_class c
        JOIN pg_attribute a ON c.oid = a.attrelid
        WHERE c.relname = 'mytable'
        AND a.attnum > 0
        AND NOT a.attisdropped
        ORDER BY a.attnum
        """,
    ]

    for query in queries:
        await safe_driver.execute_query(query)
        mock_sql_driver.execute_query.assert_awaited_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_security_privilege_functions_with_subqueries(safe_driver, mock_sql_driver):
    """Test security privilege functions used within subqueries"""
    queries = [
        """
        SELECT nspname
        FROM pg_namespace
        WHERE has_schema_privilege(current_user, oid, 'USAGE')
        AND nspname NOT LIKE 'pg_%'
        ORDER BY nspname
        """,
        """
        SELECT t.tablename
        FROM pg_tables t
        WHERE EXISTS (
            SELECT 1
            FROM information_schema.columns c
            WHERE c.table_name = t.tablename
            AND has_column_privilege(current_user, t.tablename, c.column_name, 'SELECT')
        )
        AND t.schemaname = 'public'
        """,
    ]

    for query in queries:
        await safe_driver.execute_query(query)
        mock_sql_driver.execute_query.assert_awaited_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.parametrize("operator", ["LIKE", "ILIKE"])
@pytest.mark.asyncio
async def test_like_patterns(safe_driver, mock_sql_driver, operator):
    """Test that LIKE/ILIKE patterns are only allowed if they start or end with %, but not both or in middle"""
    queries = [
        f"SELECT name FROM users WHERE name {operator} '%smith'",
        f"SELECT name FROM users WHERE name {operator} 'john%'",
        f"SELECT name FROM users WHERE name {operator} 'jo%hn'",
        f"SELECT name FROM users WHERE name {operator} '%jo%hn%'",
        f"SELECT name FROM users WHERE name {operator} '%john%'",
    ]

    for query in queries:
        await safe_driver.execute_query(query)
        mock_sql_driver.execute_query.assert_awaited_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_datetime_functions(safe_driver, mock_sql_driver):
    """Test that date/time functions are allowed"""
    queries = [
        "SELECT age(timestamp '2001-04-10', timestamp '1957-06-13')",
        "SELECT clock_timestamp()",
        "SELECT current_date",
        "SELECT current_time",
        "SELECT current_timestamp",
        "SELECT date_part('year', timestamp '2001-02-16')",
        "SELECT date_trunc('hour', timestamp '2001-02-16 20:38:40')",
        "SELECT extract(year from timestamp '2001-02-16 20:38:40')",
        "SELECT isfinite(timestamp '2001-02-16')",
        "SELECT justify_days(interval '35 days')",
        "SELECT justify_hours(interval '27 hours')",
        "SELECT justify_interval(interval '1 year -1 hour')",
        "SELECT localtime",
        "SELECT localtimestamp",
        "SELECT make_date(2013, 7, 15)",
        "SELECT make_interval(years := 1)",
        "SELECT make_time(8, 15, 23.5)",
        "SELECT make_timestamp(2013, 7, 15, 8, 15, 23.5)",
        "SELECT make_timestamptz(2013, 7, 15, 8, 15, 23.5)",
        "SELECT now()",
        "SELECT statement_timestamp()",
        "SELECT timeofday()",
        "SELECT transaction_timestamp()",
    ]

    for query in queries:
        await safe_driver.execute_query(query)
        mock_sql_driver.execute_query.assert_awaited_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_type_conversion_functions(safe_driver, mock_sql_driver):
    """Test that type conversion functions are allowed"""
    queries = [
        "SELECT CAST('100' AS integer)",
        "SELECT '100'::integer",
        "SELECT text '100'",
        "SELECT bool 'true'",
        "SELECT int2 '100'",
        "SELECT int4 '100'",
        "SELECT int8 '100'",
        "SELECT float4 '100.0'",
        "SELECT float8 '100.0'",
        "SELECT numeric '100.0'",
        "SELECT date '2001-10-05'",
        "SELECT time '04:05:06.789'",
        "SELECT timetz '04:05:06.789-08'",
        "SELECT timestamp '2001-10-05 04:05:06.789'",
        "SELECT timestamptz '2001-10-05 04:05:06.789-08'",
        "SELECT interval '1 year 2 months 3 days'",
    ]

    for query in queries:
        await safe_driver.execute_query(query)
        mock_sql_driver.execute_query.assert_awaited_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_regexp_functions(safe_driver, mock_sql_driver):
    """Test that regexp functions are allowed"""
    query = "SELECT regexp_replace('Hello World', 'World', 'PostgreSQL')"
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_complex_type_conversion_queries(safe_driver, mock_sql_driver):
    """Test that complex type conversion queries are allowed"""
    query = """
    SELECT to_char(current_timestamp, 'YYYY-MM-DD'),
           to_date('2023-01-01'),
           to_timestamp('2023-01-01 12:00:00'),
           to_number('123.45', '999.99')
    """
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_network_functions(safe_driver, mock_sql_driver):
    """Test that network functions are allowed"""
    query = "SELECT inet_client_addr(), inet_client_port()"
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_network_functions_in_complex_queries(safe_driver, mock_sql_driver):
    """Test that network functions in complex queries are allowed"""
    query = """
    SELECT inet_client_addr() as client_ip,
           inet_client_port() as client_port,
           inet_server_addr() as server_ip,
           inet_server_port() as server_port
    """
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_notification_and_server_functions(safe_driver, mock_sql_driver):
    """Test that notification and server functions are allowed"""
    query = "SELECT pg_listening_channels(), pg_postmaster_start_time()"
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_minmax_expressions(safe_driver, mock_sql_driver):
    """Test that minmax expressions are allowed"""
    query = "SELECT GREATEST(1, 2, 3), LEAST(1, 2, 3)"
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_row_expressions(safe_driver, mock_sql_driver):
    """Test that row expressions are allowed"""
    query = "SELECT ROW(1, 2, 3) = ROW(1, 2, 3)"
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_extension_check_query(safe_driver, mock_sql_driver):
    """Test that extension check queries are allowed"""
    query = "SELECT extname, extversion FROM pg_extension WHERE extname = 'hypopg'"
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_create_extension_query(safe_driver, mock_sql_driver):
    """Test that CREATE EXTENSION queries are allowed"""
    query = "CREATE EXTENSION IF NOT EXISTS hypopg"
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_hypopg_create_index_query(safe_driver, mock_sql_driver):
    """Test that hypopg create index queries are allowed"""
    query = "SELECT * FROM hypopg_create_index('CREATE INDEX idx ON users(id)')"
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_hypopg_reset_query(safe_driver, mock_sql_driver):
    """Test that hypopg reset queries are allowed"""
    query = "SELECT * FROM hypopg_reset()"
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_hypopg_list_indexes_query(safe_driver, mock_sql_driver):
    """Test that hypopg list indexes queries are allowed"""
    query = "SELECT * FROM hypopg_list_indexes()"
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_pg_stat_statements_query(safe_driver, mock_sql_driver):
    """Test that pg_stat_statements queries are allowed"""
    query = "SELECT * FROM pg_stat_statements ORDER BY calls DESC LIMIT 10"
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_pg_indexes_query(safe_driver, mock_sql_driver):
    """Test that pg_indexes queries are allowed"""
    query = "SELECT * FROM pg_indexes WHERE schemaname = 'public'"
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_pg_stats_query(safe_driver, mock_sql_driver):
    """Test that pg_stats queries are allowed"""
    query = "SELECT * FROM pg_stats WHERE schemaname = 'public'"
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_explain_query(safe_driver, mock_sql_driver):
    """Test that explain queries are allowed"""
    query = "EXPLAIN SELECT * FROM users"
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_sql_driver_parameter_format(safe_driver, mock_sql_driver):
    """Test query with SQL parameters through the DatabaseTuningAdvisor."""
    query_template = """
    SELECT queryid, query, calls, total_exec_time/calls as avg_exec_time
    FROM pg_stat_statements
    WHERE calls >= {}
    AND total_exec_time/calls >= {}
    ORDER BY total_exec_time DESC
    LIMIT {}
    """

    min_calls = 50
    min_avg_time = 5.0
    limit = 100

    formatted_query = SQL(query_template).format(Literal(min_calls), Literal(min_avg_time), Literal(limit)).as_string()

    await safe_driver.execute_query(formatted_query)
    mock_sql_driver.execute_query.assert_awaited_with("/* crystaldba */ " + formatted_query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_multiple_queries(safe_driver, mock_sql_driver):
    """Test that multiple queries are handled correctly"""
    query1 = "SELECT * FROM users"
    query2 = "SELECT * FROM orders"
    await safe_driver.execute_query(query1)
    await safe_driver.execute_query(query2)
    mock_sql_driver.execute_query.assert_has_awaits(
        [
            call("/* crystaldba */ " + query1, params=None, force_readonly=True),
            call("/* crystaldba */ " + query2, params=None, force_readonly=True),
        ]
    )


@pytest.mark.asyncio
async def test_query_with_comments(safe_driver, mock_sql_driver):
    """Test that queries with comments are handled correctly"""
    query = """
    -- Get user information
    SELECT id, name, email
    FROM users
    WHERE status = 'active'
    -- Only get active users
    """
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)


@pytest.mark.asyncio
async def test_query_with_whitespace(safe_driver, mock_sql_driver):
    """Test that queries with whitespace are handled correctly"""
    query = """
    SELECT    id,
              name,
              email
    FROM      users
    WHERE     status = 'active'
    ORDER BY  name
    """
    await safe_driver.execute_query(query)
    mock_sql_driver.execute_query.assert_awaited_once_with("/* crystaldba */ " + query, params=None, force_readonly=True)
