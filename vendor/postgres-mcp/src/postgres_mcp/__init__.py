import asyncio
import sys

from . import server
from . import top_queries


def main():
    """Main entry point for the package."""
    # As of version 3.3.0 Psycopg on Windows is not compatible with the default
    # ProactorEventLoop.
    # See: https://www.psycopg.org/psycopg3/docs/advanced/async.html#async
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    asyncio.run(server.main())


# Optionally expose other important items at package level
__all__ = [
    "main",
    "server",
    "top_queries",
]
