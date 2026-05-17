import sys
from unittest.mock import AsyncMock
from unittest.mock import patch

import pytest


@pytest.mark.asyncio
@pytest.mark.parametrize("transport", ["stdio", "sse", "streamable-http"])
async def test_transport_argument_parsing(transport):
    """Test that all transport options are parsed correctly."""
    from postgres_mcp.server import main

    original_argv = sys.argv
    try:
        sys.argv = [
            "postgres_mcp",
            "postgresql://user:password@localhost/db",
            f"--transport={transport}",
        ]

        with (
            patch("postgres_mcp.server.db_connection.pool_connect", AsyncMock()),
            patch("postgres_mcp.server.mcp.run_stdio_async", AsyncMock()) as mock_stdio,
            patch("postgres_mcp.server.mcp.run_sse_async", AsyncMock()) as mock_sse,
            patch("postgres_mcp.server.mcp.run_streamable_http_async", AsyncMock()) as mock_http,
        ):
            await main()

            # Verify the correct transport method was called
            if transport == "stdio":
                mock_stdio.assert_called_once()
                mock_sse.assert_not_called()
                mock_http.assert_not_called()
            elif transport == "sse":
                mock_stdio.assert_not_called()
                mock_sse.assert_called_once()
                mock_http.assert_not_called()
            elif transport == "streamable-http":
                mock_stdio.assert_not_called()
                mock_sse.assert_not_called()
                mock_http.assert_called_once()
    finally:
        sys.argv = original_argv


@pytest.mark.asyncio
async def test_streamable_http_host_port_arguments():
    """Test that streamable-http host and port arguments are applied correctly."""
    from postgres_mcp.server import main
    from postgres_mcp.server import mcp

    original_argv = sys.argv
    try:
        sys.argv = [
            "postgres_mcp",
            "postgresql://user:password@localhost/db",
            "--transport=streamable-http",
            "--streamable-http-host=0.0.0.0",
            "--streamable-http-port=9000",
        ]

        with (
            patch("postgres_mcp.server.db_connection.pool_connect", AsyncMock()),
            patch("postgres_mcp.server.mcp.run_streamable_http_async", AsyncMock()),
        ):
            await main()

            # Verify the host and port were set correctly
            assert mcp.settings.host == "0.0.0.0"
            assert mcp.settings.port == 9000
    finally:
        sys.argv = original_argv


@pytest.mark.asyncio
async def test_sse_host_port_arguments():
    """Test that SSE host and port arguments are applied correctly."""
    from postgres_mcp.server import main
    from postgres_mcp.server import mcp

    original_argv = sys.argv
    try:
        sys.argv = [
            "postgres_mcp",
            "postgresql://user:password@localhost/db",
            "--transport=sse",
            "--sse-host=0.0.0.0",
            "--sse-port=8080",
        ]

        with (
            patch("postgres_mcp.server.db_connection.pool_connect", AsyncMock()),
            patch("postgres_mcp.server.mcp.run_sse_async", AsyncMock()),
        ):
            await main()

            # Verify the host and port were set correctly
            assert mcp.settings.host == "0.0.0.0"
            assert mcp.settings.port == 8080
    finally:
        sys.argv = original_argv


@pytest.mark.asyncio
async def test_default_transport_is_stdio():
    """Test that the default transport is stdio when not specified."""
    from postgres_mcp.server import main

    original_argv = sys.argv
    try:
        sys.argv = [
            "postgres_mcp",
            "postgresql://user:password@localhost/db",
        ]

        with (
            patch("postgres_mcp.server.db_connection.pool_connect", AsyncMock()),
            patch("postgres_mcp.server.mcp.run_stdio_async", AsyncMock()) as mock_stdio,
            patch("postgres_mcp.server.mcp.run_sse_async", AsyncMock()) as mock_sse,
            patch("postgres_mcp.server.mcp.run_streamable_http_async", AsyncMock()) as mock_http,
        ):
            await main()

            mock_stdio.assert_called_once()
            mock_sse.assert_not_called()
            mock_http.assert_not_called()
    finally:
        sys.argv = original_argv
