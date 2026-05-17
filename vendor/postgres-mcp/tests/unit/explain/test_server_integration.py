import json
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
import pytest_asyncio

from postgres_mcp.server import explain_query


@pytest_asyncio.fixture
async def mock_safe_sql_driver():
    """Create a mock SafeSqlDriver for testing."""
    driver = MagicMock()
    return driver


@pytest.fixture
def mock_explain_plan_tool():
    """Create a mock ExplainPlanTool."""
    tool = MagicMock()
    tool.explain = AsyncMock()
    tool.explain_analyze = AsyncMock()
    tool.explain_with_hypothetical_indexes = AsyncMock()
    return tool


class MockCell:
    def __init__(self, data):
        self.cells = data


@pytest.mark.asyncio
async def test_explain_query_integration():
    """Test the entire explain_query tool end-to-end."""
    # Mock response with format_text_response
    result_text = json.dumps({"Plan": {"Node Type": "Seq Scan"}})
    mock_text_result = MagicMock()
    mock_text_result.text = result_text

    # Patch the format_text_response function
    with patch("postgres_mcp.server.format_text_response", return_value=[mock_text_result]):
        # Patch the get_sql_driver
        with patch("postgres_mcp.server.get_sql_driver"):
            # Patch the ExplainPlanTool
            with patch("postgres_mcp.server.ExplainPlanTool"):
                result = await explain_query("SELECT * FROM users", hypothetical_indexes=None)

                # Verify result matches our expected plan data
                assert isinstance(result, list)
                assert len(result) == 1
                assert result[0].text == result_text


@pytest.mark.asyncio
async def test_explain_query_with_analyze_integration():
    """Test the explain_query tool with analyze=True."""
    # Mock response with format_text_response
    result_text = json.dumps({"Plan": {"Node Type": "Seq Scan"}, "Execution Time": 1.23})
    mock_text_result = MagicMock()
    mock_text_result.text = result_text

    # Patch the format_text_response function
    with patch("postgres_mcp.server.format_text_response", return_value=[mock_text_result]):
        # Patch the get_sql_driver
        with patch("postgres_mcp.server.get_sql_driver"):
            # Patch the ExplainPlanTool
            with patch("postgres_mcp.server.ExplainPlanTool"):
                result = await explain_query("SELECT * FROM users", analyze=True, hypothetical_indexes=None)

                # Verify result matches our expected plan data
                assert isinstance(result, list)
                assert len(result) == 1
                assert result[0].text == result_text


@pytest.mark.asyncio
async def test_explain_query_with_hypothetical_indexes_integration():
    """Test the explain_query tool with hypothetical indexes."""
    # Mock response with format_text_response
    result_text = json.dumps({"Plan": {"Node Type": "Index Scan"}})
    mock_text_result = MagicMock()
    mock_text_result.text = result_text

    # Test data
    test_sql = "SELECT * FROM users WHERE email = 'test@example.com'"
    test_indexes = [{"table": "users", "columns": ["email"]}]

    # Patch the format_text_response function
    with patch("postgres_mcp.server.format_text_response", return_value=[mock_text_result]):
        # Create mock SafeSqlDriver that returns extension exists
        mock_safe_driver = MagicMock()
        mock_execute_query = AsyncMock(return_value=[MockCell({"exists": 1})])
        mock_safe_driver.execute_query = mock_execute_query

        # Patch the get_sql_driver
        with patch("postgres_mcp.server.get_sql_driver", return_value=mock_safe_driver):
            # Patch the ExplainPlanTool
            with patch("postgres_mcp.server.ExplainPlanTool"):
                result = await explain_query(test_sql, hypothetical_indexes=test_indexes)

                # Verify result matches our expected plan data
                assert isinstance(result, list)
                assert len(result) == 1
                assert result[0].text == result_text


@pytest.mark.asyncio
async def test_explain_query_missing_hypopg_integration():
    """Test the explain_query tool when hypopg extension is missing."""
    # Mock message about missing extension
    missing_ext_message = "extension is required"
    mock_text_result = MagicMock()
    mock_text_result.text = missing_ext_message

    # Test data
    test_sql = "SELECT * FROM users WHERE email = 'test@example.com'"
    test_indexes = [{"table": "users", "columns": ["email"]}]

    # Create mock SafeSqlDriver that returns empty result (extension not exists)
    mock_safe_driver = MagicMock()
    mock_execute_query = AsyncMock(return_value=[])
    mock_safe_driver.execute_query = mock_execute_query

    # Patch the format_text_response function
    with patch("postgres_mcp.server.format_text_response", return_value=[mock_text_result]):
        # Patch the get_sql_driver
        with patch("postgres_mcp.server.get_sql_driver", return_value=mock_safe_driver):
            # Patch the ExplainPlanTool
            with patch("postgres_mcp.server.ExplainPlanTool"):
                result = await explain_query(test_sql, hypothetical_indexes=test_indexes)

                # Verify result
                assert isinstance(result, list)
                assert len(result) == 1
                assert missing_ext_message in result[0].text


@pytest.mark.asyncio
async def test_explain_query_error_handling_integration():
    """Test the explain_query tool's error handling."""
    # Mock error response
    error_message = "Error executing query"
    mock_text_result = MagicMock()
    mock_text_result.text = f"Error: {error_message}"

    # Patch the format_error_response function
    with patch("postgres_mcp.server.format_error_response", return_value=[mock_text_result]):
        # Patch the get_sql_driver to throw an exception
        with patch(
            "postgres_mcp.server.get_sql_driver",
            side_effect=Exception(error_message),
        ):
            result = await explain_query("INVALID SQL")

            # Verify error is correctly formatted
            assert isinstance(result, list)
            assert len(result) == 1
            assert error_message in result[0].text
