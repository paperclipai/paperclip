"""SQL driver adapter for PostgreSQL connections."""

import logging
import re
from dataclasses import dataclass
from typing import Any
from typing import Dict
from typing import List
from typing import Optional
from urllib.parse import urlparse
from urllib.parse import urlunparse

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool
from typing_extensions import LiteralString

logger = logging.getLogger(__name__)


def obfuscate_password(text: str | None) -> str | None:
    """
    Obfuscate password in any text containing connection information.
    Works on connection URLs, error messages, and other strings.
    """
    if text is None:
        return None

    if not text:
        return text

    # Try first as a proper URL
    try:
        parsed = urlparse(text)
        if parsed.scheme and parsed.netloc and parsed.password:
            # Replace password with asterisks in proper URL
            netloc = parsed.netloc.replace(parsed.password, "****")
            return urlunparse(parsed._replace(netloc=netloc))
    except Exception:
        pass

    # Handle strings that contain connection strings but aren't proper URLs
    # Match postgres://user:password@host:port/dbname pattern
    url_pattern = re.compile(r"(postgres(?:ql)?:\/\/[^:]+:)([^@]+)(@[^\/\s]+)")
    text = re.sub(url_pattern, r"\1****\3", text)

    # Match connection string parameters (password=xxx)
    # This simpler pattern captures password without quotes
    param_pattern = re.compile(r'(password=)([^\s&;"\']+)', re.IGNORECASE)
    text = re.sub(param_pattern, r"\1****", text)

    # Match password in DSN format with single quotes
    dsn_single_quote = re.compile(r"(password\s*=\s*')([^']+)(')", re.IGNORECASE)
    text = re.sub(dsn_single_quote, r"\1****\3", text)

    # Match password in DSN format with double quotes
    dsn_double_quote = re.compile(r'(password\s*=\s*")([^"]+)(")', re.IGNORECASE)
    text = re.sub(dsn_double_quote, r"\1****\3", text)

    return text


class DbConnPool:
    """Database connection manager using psycopg's connection pool."""

    def __init__(self, connection_url: Optional[str] = None):
        self.connection_url = connection_url
        self.pool: AsyncConnectionPool | None = None
        self._is_valid = False
        self._last_error = None

    async def pool_connect(self, connection_url: Optional[str] = None) -> AsyncConnectionPool:
        """Initialize connection pool with retry logic."""
        # If we already have a valid pool, return it
        if self.pool and self._is_valid:
            return self.pool

        url = connection_url or self.connection_url
        self.connection_url = url
        if not url:
            self._is_valid = False
            self._last_error = "Database connection URL not provided"
            raise ValueError(self._last_error)

        # Close any existing pool before creating a new one
        await self.close()

        try:
            # Configure connection pool with appropriate settings
            self.pool = AsyncConnectionPool(
                conninfo=url,
                min_size=1,
                max_size=5,
                open=False,  # Don't connect immediately, let's do it explicitly
            )

            # Open the pool explicitly
            await self.pool.open()

            # Test the connection pool by executing a simple query
            async with self.pool.connection() as conn:
                async with conn.cursor() as cursor:
                    await cursor.execute("SELECT 1")

            self._is_valid = True
            self._last_error = None
            return self.pool
        except Exception as e:
            self._is_valid = False
            self._last_error = str(e)

            # Clean up failed pool
            await self.close()

            raise ValueError(f"Connection attempt failed: {obfuscate_password(str(e))}") from e

    async def close(self) -> None:
        """Close the connection pool."""
        if self.pool:
            try:
                # Close the pool
                await self.pool.close()
            except Exception as e:
                logger.warning(f"Error closing connection pool: {e}")
            finally:
                self.pool = None
                self._is_valid = False

    @property
    def is_valid(self) -> bool:
        """Check if the connection pool is valid."""
        return self._is_valid

    @property
    def last_error(self) -> Optional[str]:
        """Get the last error message."""
        return self._last_error


class SqlDriver:
    """Adapter class that wraps a PostgreSQL connection with the interface expected by DTA."""

    @dataclass
    class RowResult:
        """Simple class to match the Griptape RowResult interface."""

        cells: Dict[str, Any]

    def __init__(
        self,
        conn: Any = None,
        engine_url: str | None = None,
    ):
        """
        Initialize with a PostgreSQL connection or pool.

        Args:
            conn: PostgreSQL connection object or pool
            engine_url: Connection URL string as an alternative to providing a connection
        """
        if conn:
            self.conn = conn
            # Check if this is a connection pool
            self.is_pool = isinstance(conn, DbConnPool)
        elif engine_url:
            # Don't connect here since we need async connection
            self.engine_url = engine_url
            self.conn = None
            self.is_pool = False
        else:
            raise ValueError("Either conn or engine_url must be provided")

    def connect(self):
        if self.conn is not None:
            return self.conn
        if self.engine_url:
            self.conn = DbConnPool(self.engine_url)
            self.is_pool = True
            return self.conn
        else:
            raise ValueError("Connection not established. Either conn or engine_url must be provided")

    async def execute_query(
        self,
        query: LiteralString,
        params: list[Any] | None = None,
        force_readonly: bool = False,
    ) -> Optional[List[RowResult]]:
        """
        Execute a query and return results.

        Args:
            query: SQL query to execute
            params: Query parameters
            force_readonly: Whether to enforce read-only mode

        Returns:
            List of RowResult objects or None on error
        """
        try:
            if self.conn is None:
                self.connect()
                if self.conn is None:
                    raise ValueError("Connection not established")

            # Handle connection pool vs direct connection
            if self.is_pool:
                # For pools, get a connection from the pool
                pool = await self.conn.pool_connect()
                async with pool.connection() as connection:
                    return await self._execute_with_connection(connection, query, params, force_readonly=force_readonly)
            else:
                # Direct connection approach
                return await self._execute_with_connection(self.conn, query, params, force_readonly=force_readonly)
        except Exception as e:
            # Mark pool as invalid if there was a connection issue
            if self.conn and self.is_pool:
                self.conn._is_valid = False  # type: ignore
                self.conn._last_error = str(e)  # type: ignore
            elif self.conn and not self.is_pool:
                self.conn = None

            raise e

    async def _execute_with_connection(self, connection, query, params, force_readonly) -> Optional[List[RowResult]]:
        """Execute query with the given connection."""
        transaction_started = False
        try:
            async with connection.cursor(row_factory=dict_row) as cursor:
                # Start read-only transaction
                if force_readonly:
                    await cursor.execute("BEGIN TRANSACTION READ ONLY")
                    transaction_started = True

                if params:
                    await cursor.execute(query, params)
                else:
                    await cursor.execute(query)

                # For multiple statements, move to the last statement's results
                while cursor.nextset():
                    pass

                if cursor.description is None:  # No results (like DDL statements)
                    if not force_readonly:
                        await cursor.execute("COMMIT")
                    elif transaction_started:
                        await cursor.execute("ROLLBACK")
                        transaction_started = False
                    return None

                # Get results from the last statement only
                rows = await cursor.fetchall()

                # End the transaction appropriately
                if not force_readonly:
                    await cursor.execute("COMMIT")
                elif transaction_started:
                    await cursor.execute("ROLLBACK")
                    transaction_started = False

                return [SqlDriver.RowResult(cells=dict(row)) for row in rows]

        except Exception as e:
            # Try to roll back the transaction if it's still active
            if transaction_started:
                try:
                    await connection.rollback()
                except Exception as rollback_error:
                    logger.error(f"Error rolling back transaction: {rollback_error}")

            logger.error(f"Error executing query ({query}): {e}")
            raise e
