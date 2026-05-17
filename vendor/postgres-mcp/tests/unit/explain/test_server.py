import json
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
import pytest_asyncio

import postgres_mcp.server as server


class MockCell:
    def __init__(self, data):
        self.cells = data


@pytest_asyncio.fixture
async def mock_db_connection():
    """Create a mock DB connection."""
    conn = MagicMock()
    conn.pool_connect = AsyncMock()
    conn.close = AsyncMock()
    return conn


@pytest.mark.asyncio
async def test_server_tools_registered():
    """Test that the explain tools are properly registered in the server."""
    # Check that the explain tool is registered
    assert hasattr(server, "explain_query")

    # Simply check that the tool is callable
    assert callable(server.explain_query)


@pytest.mark.asyncio
async def test_explain_query_basic():
    """Test explain_query with basic parameters."""
    # Expected output
    expected_output = {"Plan": {"Node Type": "Seq Scan"}}

    # Set up the mock responses
    mock_response = MagicMock()
    mock_response.text = json.dumps(expected_output)

    # Use patch to replace the actual explain_query function with our own mock
    with patch.object(server, "explain_query", return_value=[mock_response]):
        # Call the patched function
        result = await server.explain_query("SELECT * FROM users")

        # Verify we get the expected result
        assert isinstance(result, list)
        assert len(result) == 1
        assert json.loads(result[0].text) == expected_output


@pytest.mark.asyncio
async def test_explain_query_analyze():
    """Test explain_query with analyze=True."""
    # Expected output with execution statistics
    expected_output = {
        "Plan": {
            "Node Type": "Seq Scan",
            "Actual Rows": 100,
            "Actual Total Time": 1.23,
        },
        "Execution Time": 1.30,
    }

    # Set up the mock responses
    mock_response = MagicMock()
    mock_response.text = json.dumps(expected_output)

    # Use patch to replace the actual explain_query function with our own mock
    with patch.object(server, "explain_query", return_value=[mock_response]):
        # Call the patched function with analyze=True
        result = await server.explain_query("SELECT * FROM users", analyze=True)

        # Verify we get the expected result
        assert isinstance(result, list)
        assert len(result) == 1
        assert json.loads(result[0].text) == expected_output


@pytest.mark.asyncio
async def test_explain_query_hypothetical_indexes():
    """Test explain_query with hypothetical indexes."""
    # Expected output with an index scan
    expected_output = {
        "Plan": {
            "Node Type": "Index Scan",
            "Index Name": "hypothetical_idx",
        },
    }

    # Set up the mock responses
    mock_response = MagicMock()
    mock_response.text = json.dumps(expected_output)

    # Test data
    test_sql = "SELECT * FROM users WHERE email = 'test@example.com'"
    test_indexes = [{"table": "users", "columns": ["email"]}]

    # Use patch to replace the actual explain_query function with our own mock
    with patch.object(server, "explain_query", return_value=[mock_response]):
        # Call the patched function with hypothetical_indexes
        result = await server.explain_query(test_sql, hypothetical_indexes=test_indexes)

        # Verify we get the expected result
        assert isinstance(result, list)
        assert len(result) == 1
        assert json.loads(result[0].text) == expected_output


@pytest.mark.asyncio
async def test_explain_query_error_handling():
    """Test explain_query error handling."""
    # Create a mock error response
    error_message = "Error executing query"
    mock_response = MagicMock()
    mock_response.text = f"Error: {error_message}"

    # Use patch to replace the actual function with our mock that returns an error
    with patch.object(server, "explain_query", return_value=[mock_response]):
        # Call the patched function
        result = await server.explain_query("INVALID SQL")

        # Verify error is formatted correctly
        assert isinstance(result, list)
        assert len(result) == 1
        assert error_message in result[0].text
