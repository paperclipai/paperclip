import json
from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest
import pytest_asyncio

from postgres_mcp.artifacts import ErrorResult
from postgres_mcp.artifacts import ExplainPlanArtifact
from postgres_mcp.explain import ExplainPlanTool


class MockCell:
    def __init__(self, data):
        self.cells = data


@pytest_asyncio.fixture
async def mock_sql_driver():
    """Create a mock SQL driver for testing."""
    driver = MagicMock()
    driver.execute_query = AsyncMock()
    return driver


@pytest.mark.asyncio
async def test_explain_plan_tool_initialization(mock_sql_driver):
    """Test initialization of ExplainPlanTool."""
    tool = ExplainPlanTool(sql_driver=mock_sql_driver)
    assert tool.sql_driver == mock_sql_driver


@pytest.mark.asyncio
async def test_has_bind_variables():
    """Test the _has_bind_variables method."""
    tool = ExplainPlanTool(sql_driver=MagicMock())

    # Test with bind variables
    assert tool._has_bind_variables("SELECT * FROM users WHERE id = $1") is True  # type: ignore
    assert tool._has_bind_variables("INSERT INTO users VALUES ($1, $2)") is True  # type: ignore

    # Test without bind variables
    assert tool._has_bind_variables("SELECT * FROM users WHERE id = 1") is False  # type: ignore
    assert tool._has_bind_variables("INSERT INTO users VALUES (1, 'test')") is False  # type: ignore


@pytest.mark.asyncio
async def test_has_like_expressions():
    """Test the _has_like_expressions method."""
    tool = ExplainPlanTool(sql_driver=MagicMock())

    # Test with LIKE expressions
    assert tool._has_like_expressions("SELECT * FROM users WHERE name LIKE '%John%'") is True  # type: ignore
    assert tool._has_like_expressions("SELECT * FROM users WHERE name like 'John%'") is True  # type: ignore
    assert tool._has_like_expressions("SELECT * FROM users WHERE UPPER(name) LIKE 'JOHN%'") is True  # type: ignore

    # Test without LIKE expressions
    assert tool._has_like_expressions("SELECT * FROM users WHERE name = 'John'") is False  # type: ignore
    assert tool._has_like_expressions("SELECT * FROM users WHERE id > 100") is False  # type: ignore


@pytest.mark.asyncio
async def test_explain_success(mock_sql_driver):
    """Test successful execution of explain."""
    # Prepare mock response
    plan_data = {
        "Plan": {
            "Node Type": "Seq Scan",
            "Relation Name": "users",
            "Startup Cost": 0.00,
            "Total Cost": 10.00,
            "Plan Rows": 100,
            "Plan Width": 20,
        }
    }

    mock_sql_driver.execute_query.return_value = [MockCell({"QUERY PLAN": [plan_data]})]

    tool = ExplainPlanTool(sql_driver=mock_sql_driver)
    result = await tool.explain("SELECT * FROM users")

    # Verify query was called with expected parameters
    mock_sql_driver.execute_query.assert_called_once()
    call_args = mock_sql_driver.execute_query.call_args[0][0]
    assert "EXPLAIN (FORMAT JSON) SELECT * FROM users" in call_args

    # Verify result is as expected
    assert isinstance(result, ExplainPlanArtifact)
    assert json.loads(result.value) == plan_data


@pytest.mark.asyncio
async def test_explain_with_bind_variables(mock_sql_driver):
    """Test explain with bind variables."""
    # Prepare mock response for PostgreSQL version check
    version_response = [MockCell({"server_version": "16.0"})]
    # Prepare mock response for explain query
    plan_data = {
        "Plan": {
            "Node Type": "Seq Scan",
            "Relation Name": "users",
            "Startup Cost": 0.00,
            "Total Cost": 10.00,
            "Plan Rows": 100,
            "Plan Width": 20,
        }
    }

    # Set up the mock to return different responses for different queries
    def side_effect(query):
        if query == "SHOW server_version":
            return version_response
        else:
            return [MockCell({"QUERY PLAN": [plan_data]})]

    mock_sql_driver.execute_query.side_effect = side_effect

    tool = ExplainPlanTool(sql_driver=mock_sql_driver)
    result = await tool.explain("SELECT * FROM users WHERE id = $1")

    # Verify result is as expected
    assert isinstance(result, ExplainPlanArtifact)

    # Find the EXPLAIN call in the call history
    explain_call = None
    for call in mock_sql_driver.execute_query.call_args_list:
        if "EXPLAIN" in call[0][0]:
            explain_call = call[0][0]
            break

    assert explain_call is not None
    assert "EXPLAIN (FORMAT JSON, GENERIC_PLAN) SELECT * FROM users WHERE id = $1" in explain_call


@pytest.mark.asyncio
async def test_explain_with_bind_variables_pg15(mock_sql_driver, monkeypatch):
    """Test explain with bind variables on PostgreSQL < 16."""
    # Prepare mock response for PostgreSQL version check
    version_response = [MockCell({"server_version": "15.4"})]

    # Prepare plan data for the replaced parameter query
    plan_data = {
        "Plan": {
            "Node Type": "Seq Scan",
            "Relation Name": "users",
            "Startup Cost": 0.00,
            "Total Cost": 10.00,
            "Plan Rows": 100,
            "Plan Width": 20,
        }
    }

    # Mock the SqlBindParams class
    class MockSqlBindParams:
        def __init__(self, sql_driver):
            self.sql_driver = sql_driver

        async def replace_parameters(self, query):
            return "SELECT * FROM users WHERE id = 42"  # Replaced query

    # The correct import path for monkeypatching
    monkeypatch.setattr("postgres_mcp.explain.explain_plan.SqlBindParams", MockSqlBindParams)

    # Set up the mock to return different responses for different queries
    def side_effect(query):
        if query == "SHOW server_version":
            return version_response
        elif "EXPLAIN" in query and "id = 42" in query:
            # For the parameter-replaced EXPLAIN query, return mock results
            return [MockCell({"QUERY PLAN": [plan_data]})]
        return None

    mock_sql_driver.execute_query.side_effect = side_effect

    tool = ExplainPlanTool(sql_driver=mock_sql_driver)
    result = await tool.explain("SELECT * FROM users WHERE id = $1")

    # We now expect a successful result with parameter replacement
    if isinstance(result, ErrorResult):
        print(f"Got error: {result.value}")
    assert isinstance(result, ExplainPlanArtifact)

    # Verify that the version check was called
    version_call = None
    explain_call = None

    for call in mock_sql_driver.execute_query.call_args_list:
        if "server_version" in call[0][0]:
            version_call = call
        elif "EXPLAIN" in call[0][0]:
            explain_call = call

    assert version_call is not None
    assert explain_call is not None

    # Make sure GENERIC_PLAN is NOT in the query - we should be using replaced values
    assert "GENERIC_PLAN" not in explain_call[0][0]
    # Verify the parameters were replaced
    assert "id = 42" in explain_call[0][0]


@pytest.mark.asyncio
async def test_explain_analyze_with_bind_variables(mock_sql_driver, monkeypatch):
    """Test explain analyze with bind variables uses parameter replacement."""
    # Prepare plan data for the replaced parameter query
    plan_data = {
        "Plan": {
            "Node Type": "Seq Scan",
            "Relation Name": "users",
            "Startup Cost": 0.00,
            "Total Cost": 10.00,
            "Plan Rows": 100,
            "Plan Width": 20,
            "Actual Startup Time": 0.01,
            "Actual Total Time": 1.23,
            "Actual Rows": 95,
            "Actual Loops": 1,
        },
        "Planning Time": 0.05,
        "Execution Time": 1.30,
    }

    # Mock the SqlBindParams class
    class MockSqlBindParams:
        def __init__(self, sql_driver):
            self.sql_driver = sql_driver

        async def replace_parameters(self, query):
            return "SELECT * FROM users WHERE id = 42"  # Replaced query

    # The correct import path for monkeypatching
    monkeypatch.setattr("postgres_mcp.explain.explain_plan.SqlBindParams", MockSqlBindParams)

    # Set up the mock to return mock plan for the modified query
    def side_effect(query):
        if "EXPLAIN" in query and "id = 42" in query:
            return [MockCell({"QUERY PLAN": [plan_data]})]
        return None

    mock_sql_driver.execute_query.side_effect = side_effect

    tool = ExplainPlanTool(sql_driver=mock_sql_driver)
    result = await tool.explain_analyze("SELECT * FROM users WHERE id = $1")

    # Should return successful result with replaced parameters
    if isinstance(result, ErrorResult):
        print(f"Got error: {result.value}")
    assert isinstance(result, ExplainPlanArtifact)

    # Verify that the query was executed with ANALYZE but not GENERIC_PLAN
    call_args = mock_sql_driver.execute_query.call_args[0][0]
    assert "ANALYZE" in call_args
    assert "GENERIC_PLAN" not in call_args
    assert "id = 42" in call_args


@pytest.mark.asyncio
async def test_explain_analyze_success(mock_sql_driver):
    """Test successful execution of explain analyze."""
    # Prepare mock response with execution statistics
    plan_data = {
        "Plan": {
            "Node Type": "Seq Scan",
            "Relation Name": "users",
            "Startup Cost": 0.00,
            "Total Cost": 10.00,
            "Plan Rows": 100,
            "Plan Width": 20,
            "Actual Startup Time": 0.01,
            "Actual Total Time": 1.23,
            "Actual Rows": 95,
            "Actual Loops": 1,
        },
        "Planning Time": 0.05,
        "Execution Time": 1.30,
    }

    mock_sql_driver.execute_query.return_value = [MockCell({"QUERY PLAN": [plan_data]})]

    tool = ExplainPlanTool(sql_driver=mock_sql_driver)
    result = await tool.explain_analyze("SELECT * FROM users")

    # Verify query was called with expected parameters
    call_args = mock_sql_driver.execute_query.call_args[0][0]
    assert "EXPLAIN (FORMAT JSON, ANALYZE) SELECT * FROM users" in call_args

    # Verify result is as expected
    assert isinstance(result, ExplainPlanArtifact)
    assert json.loads(result.value) == plan_data


@pytest.mark.asyncio
async def test_explain_with_error(mock_sql_driver):
    """Test handling of error in explain."""
    # Configure mock to raise exception
    mock_sql_driver.execute_query.side_effect = Exception("Database error")

    tool = ExplainPlanTool(sql_driver=mock_sql_driver)
    result = await tool.explain("SELECT * FROM users")

    # Verify error handling
    assert isinstance(result, ErrorResult)
    assert "Database error" in result.value


@pytest.mark.asyncio
async def test_explain_with_invalid_response(mock_sql_driver):
    """Test handling of invalid response format."""
    # Return invalid response format
    mock_sql_driver.execute_query.return_value = [
        MockCell({"QUERY PLAN": "invalid"})  # Not a list
    ]

    tool = ExplainPlanTool(sql_driver=mock_sql_driver)
    result = await tool.explain("SELECT * FROM users")

    # Verify error handling
    assert isinstance(result, ErrorResult)
    assert "Expected list" in result.value


@pytest.mark.asyncio
async def test_explain_with_empty_result(mock_sql_driver):
    """Test handling of empty result set."""
    # Return empty result
    mock_sql_driver.execute_query.return_value = None

    tool = ExplainPlanTool(sql_driver=mock_sql_driver)
    result = await tool.explain("SELECT * FROM users")

    # Verify error handling
    assert isinstance(result, ErrorResult)
    assert "No results" in result.value


@pytest.mark.asyncio
async def test_explain_with_empty_plan_data(mock_sql_driver):
    """Test handling of empty plan data."""
    # Return empty plan data list
    mock_sql_driver.execute_query.return_value = [MockCell({"QUERY PLAN": []})]

    tool = ExplainPlanTool(sql_driver=mock_sql_driver)
    result = await tool.explain("SELECT * FROM users")

    # Verify error handling
    assert isinstance(result, ErrorResult)
    assert "No results" in result.value


@pytest.mark.asyncio
async def test_explain_with_like_and_bind_variables_pg16(mock_sql_driver, monkeypatch):
    """Test explain with LIKE and bind variables on PostgreSQL 16."""
    # Prepare mock response for PostgreSQL version check
    version_response = [MockCell({"server_version": "16.0"})]

    # Prepare plan data for the replaced parameter query
    plan_data = {
        "Plan": {
            "Node Type": "Seq Scan",
            "Relation Name": "users",
            "Startup Cost": 0.00,
            "Total Cost": 10.00,
            "Plan Rows": 100,
            "Plan Width": 20,
        }
    }

    # Mock the SqlBindParams class
    class MockSqlBindParams:
        def __init__(self, sql_driver):
            self.sql_driver = sql_driver

        async def replace_parameters(self, query):
            return "SELECT * FROM users WHERE name LIKE '%John%'"  # Replaced query

    # The correct import path for monkeypatching
    monkeypatch.setattr("postgres_mcp.explain.explain_plan.SqlBindParams", MockSqlBindParams)

    # Set up the mock to return different responses for different queries
    def side_effect(query):
        if query == "SHOW server_version":
            return version_response
        elif "EXPLAIN" in query and "LIKE '%John%'" in query:
            # For the parameter-replaced EXPLAIN query, return mock results
            return [MockCell({"QUERY PLAN": [plan_data]})]
        return None

    mock_sql_driver.execute_query.side_effect = side_effect

    tool = ExplainPlanTool(sql_driver=mock_sql_driver)
    result = await tool.explain("SELECT * FROM users WHERE name LIKE $1")

    # We expect a successful result with parameter replacement despite PostgreSQL 16
    if isinstance(result, ErrorResult):
        print(f"Got error: {result.value}")
    assert isinstance(result, ExplainPlanArtifact)

    # Verify that the version check was called
    version_call = None
    explain_call = None

    for call in mock_sql_driver.execute_query.call_args_list:
        if "server_version" in call[0][0]:
            version_call = call
        elif "EXPLAIN" in call[0][0]:
            explain_call = call

    assert version_call is not None
    assert explain_call is not None

    # Make sure GENERIC_PLAN is NOT in the query - we should be using replaced values
    assert "GENERIC_PLAN" not in explain_call[0][0]
    # Verify the parameters were replaced
    assert "LIKE '%John%'" in explain_call[0][0]


@pytest.mark.asyncio
async def test_explain_with_functional_hypothetical_indexes(mock_sql_driver):
    """Test explain with functional expressions in hypothetical indexes."""
    # Prepare sample plan data with index scan - including all required fields
    plan_data = {
        "Plan": {
            "Node Type": "Index Scan",
            "Index Name": "hypothetical_idx",
            "Relation Name": "title_basics",
            "Startup Cost": 0.00,
            "Total Cost": 100.00,
            "Plan Rows": 100,
            "Plan Width": 20,
        }
    }

    # Mock the hypopg_reset and hypopg_create_index calls
    def side_effect(query):
        if "hypopg_" in query or "EXPLAIN" in query:
            return [MockCell({"QUERY PLAN": [plan_data]})]
        return None

    mock_sql_driver.execute_query.side_effect = side_effect

    # Sample query with ILIKE and functional indexes
    sql_query = """
    SELECT * FROM title_basics
    WHERE primary_title ILIKE '%star%' OR original_title ILIKE '%star%'
    ORDER BY start_year DESC
    LIMIT 20 OFFSET 0;
    """

    # Complex functional expressions in the hypothetical indexes
    hypothetical_indexes = [
        {"table": "title_basics", "columns": ["LOWER(primary_title)"]},
        {"table": "title_basics", "columns": ["LOWER(original_title)"]},
        {"table": "title_basics", "columns": ["start_year DESC"]},
    ]

    tool = ExplainPlanTool(sql_driver=mock_sql_driver)
    result = await tool.explain_with_hypothetical_indexes(sql_query, hypothetical_indexes)

    # Verify the result is successful
    assert not isinstance(result, ErrorResult), f"Got error: {result.value if isinstance(result, ErrorResult) else ''}"
    assert isinstance(result, ExplainPlanArtifact)

    # Check that explain query was called correctly
    # The important part is that the expression is properly included in the CREATE INDEX statement
    # We need to ensure "LOWER(primary_title)" isn't broken up or mishandled
    calls = [call[0][0] for call in mock_sql_driver.execute_query.call_args_list]
    explain_calls = [call for call in calls if "EXPLAIN" in call]

    assert len(explain_calls) == 1
    explain_call = explain_calls[0]

    # Verify the hypothetical indexes are created correctly with the expressions
    assert "SELECT hypopg_reset();" in explain_call
    assert "hypopg_create_index" in explain_call
    assert "LOWER(primary_title)" in explain_call
    assert "LOWER(original_title)" in explain_call
    assert "start_year DESC" in explain_call
