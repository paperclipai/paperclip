from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest

from postgres_mcp.server import AccessMode
from postgres_mcp.server import get_sql_driver
from postgres_mcp.sql import SafeSqlDriver
from postgres_mcp.sql import SqlDriver


@pytest.mark.asyncio
async def test_force_readonly_enforcement():
    """
    Test that force_readonly is properly enforced based on access mode:
    - In RESTRICTED mode: force_readonly is always True regardless of what's passed
    - In UNRESTRICTED mode: force_readonly respects the passed value (default False)
    """
    # Create mock for connection pool
    mock_conn_pool = MagicMock()
    mock_conn_pool._is_valid = True

    # Create a mock for the base SqlDriver._execute_with_connection
    mock_execute = AsyncMock()
    mock_execute.return_value = [SqlDriver.RowResult(cells={"test": "value"})]

    # Test UNRESTRICTED mode
    with (
        patch("postgres_mcp.server.current_access_mode", AccessMode.UNRESTRICTED),
        patch("postgres_mcp.server.db_connection", mock_conn_pool),
        patch.object(SqlDriver, "_execute_with_connection", mock_execute),
    ):
        driver = await get_sql_driver()
        assert isinstance(driver, SqlDriver)
        assert not isinstance(driver, SafeSqlDriver)

        # Test default behavior (should be False)
        mock_execute.reset_mock()
        await driver.execute_query("SELECT 1")
        assert mock_execute.call_count == 1
        # Check that force_readonly is False by default
        assert mock_execute.call_args[1]["force_readonly"] is False

        # Test explicit True
        mock_execute.reset_mock()
        await driver.execute_query("SELECT 1", force_readonly=True)
        assert mock_execute.call_count == 1
        # Check that force_readonly=True is respected
        assert mock_execute.call_args[1]["force_readonly"] is True

        # Test explicit False
        mock_execute.reset_mock()
        await driver.execute_query("SELECT 1", force_readonly=False)
        assert mock_execute.call_count == 1
        # Check that force_readonly=False is respected
        assert mock_execute.call_args[1]["force_readonly"] is False

    # Test RESTRICTED mode
    with (
        patch("postgres_mcp.server.current_access_mode", AccessMode.RESTRICTED),
        patch("postgres_mcp.server.db_connection", mock_conn_pool),
        patch.object(SqlDriver, "_execute_with_connection", mock_execute),
    ):
        driver = await get_sql_driver()
        assert isinstance(driver, SafeSqlDriver)

        # Test default behavior
        mock_execute.reset_mock()
        await driver.execute_query("SELECT 1")
        assert mock_execute.call_count == 1
        # Check that force_readonly is always True
        assert mock_execute.call_args[1]["force_readonly"] is True

        # Test explicit False (should still be True)
        mock_execute.reset_mock()
        await driver.execute_query("SELECT 1", force_readonly=False)
        assert mock_execute.call_count == 1
        # Check that force_readonly is True despite passing False
        assert mock_execute.call_args[1]["force_readonly"] is True

        # Test explicit True
        mock_execute.reset_mock()
        await driver.execute_query("SELECT 1", force_readonly=True)
        assert mock_execute.call_count == 1
        # Check that force_readonly remains True
        assert mock_execute.call_args[1]["force_readonly"] is True
