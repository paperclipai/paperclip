"""Unit tests for touch_index.db — engine factory and health check.

All external I/O is mocked so tests run offline.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest


class TestGetEngine:
    def test_defaults_when_env_unset(self):
        """When no POSTGRES_* vars are set, sensible defaults are used."""
        with patch.dict("os.environ", {}, clear=True):
            from touch_index.db import get_engine

            engine = get_engine()
            assert engine.url.drivername == "postgresql"
            assert engine.url.host == "localhost"
            assert engine.url.port == 5432
            assert engine.url.database == "optimizer_v3"
            assert engine.url.username == "optimizer_admin"
            assert engine.url.password == ""

    def test_reads_env_vars(self):
        """Custom env vars are reflected in the engine URL."""
        env = {
            "POSTGRES_HOST": "pg.example.com",
            "POSTGRES_PORT": "6432",
            "POSTGRES_DB": "my_db",
            "POSTGRES_USER": "my_user",
            "POSTGRES_PASSWORD": "s3cret",
        }
        with patch.dict("os.environ", env, clear=True):
            from touch_index.db import get_engine

            engine = get_engine()
            assert engine.url.host == "pg.example.com"
            assert engine.url.port == 6432
            assert engine.url.database == "my_db"
            assert engine.url.username == "my_user"
            assert engine.url.password == "s3cret"

    def test_pool_size_default(self):
        with patch.dict("os.environ", {}, clear=True):
            from touch_index.db import get_engine

            engine = get_engine()
            assert engine.pool.size() == 2

    def test_pool_size_custom(self):
        with patch.dict("os.environ", {}, clear=True):
            from touch_index.db import get_engine

            engine = get_engine(pool_size=5)
            assert engine.pool.size() == 5

    def test_engine_pool_pre_ping_enabled(self):
        with patch.dict("os.environ", {}, clear=True):
            from touch_index.db import get_engine

            engine = get_engine()
            assert engine.pool._pre_ping is True


class TestHealthCheck:
    def test_returns_true_when_db_responds(self):
        engine = MagicMock()
        conn = MagicMock()
        ctx = MagicMock()
        ctx.__enter__ = MagicMock(return_value=conn)
        ctx.__exit__ = MagicMock(return_value=False)
        engine.connect = MagicMock(return_value=ctx)

        from touch_index.db import health_check

        assert health_check(engine) is True

    def test_returns_false_when_db_fails(self):
        engine = MagicMock()
        engine.connect.side_effect = RuntimeError("connection refused")

        from touch_index.db import health_check

        assert health_check(engine) is False

    def test_returns_false_on_execute_failure(self):
        conn = MagicMock()
        conn.execute.side_effect = RuntimeError("query timeout")
        ctx = MagicMock()
        ctx.__enter__ = MagicMock(return_value=conn)
        ctx.__exit__ = MagicMock(return_value=False)
        engine = MagicMock()
        engine.connect = MagicMock(return_value=ctx)

        from touch_index.db import health_check

        assert health_check(engine) is False
